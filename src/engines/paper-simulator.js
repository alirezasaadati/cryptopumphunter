const finite = Number.isFinite;

const adversePrice = (price, side, action, bps) => {
  const slip = bps / 10_000;
  const direction = side === "LONG" ? 1 : -1;
  return action === "entry"
    ? price * (1 + direction * slip)
    : price * (1 - direction * slip);
};

const validBar = c => c && [c.time,c.open,c.high,c.low,c.close].every(finite) &&
  c.open > 0 && c.low > 0 && c.high >= Math.max(c.open,c.close) &&
  c.low <= Math.min(c.open,c.close);

const isStopTouched = (bar, side, stop) =>
  side === "LONG" ? bar.low <= stop : bar.high >= stop;
const isTargetTouched = (bar, side, target) =>
  side === "LONG" ? bar.high >= target : bar.low <= target;
const isEntry2Touched = (bar, side, entry2) =>
  side === "LONG" ? bar.low <= entry2 : bar.high >= entry2;

/**
 * Conservative OHLC paper simulator.
 * Entry 1 is a market-style fill at the next candle open. Entry 2 is a
 * conditional limit fill. If OHLC cannot establish event order, the result
 * records ambiguity and applies the conservative policy documented below.
 *
 * fundingRate is applied only when fundingSettlement=true; it must represent
 * a historical settlement event, not a per-candle estimate.
 */
export function simulatePaperTrade({
  signal, candles, entryNotional, targetWeights,
  feeRate = 0.0005, slippageBps = 2, maxEntryDriftPct = 0.35, quantityPrecision = 8,
  moveStopToBreakevenAfterTarget1 = false, maxBars = 500
}) {
  if (!signal || !["LONG","SHORT"].includes(signal.side) ||
    !finite(signal.entry) || signal.entry <= 0 ||
    !finite(signal.stop) || signal.stop <= 0 ||
    !finite(signal.candleTime) ||
    !Array.isArray(signal.targets) || !signal.targets.length ||
    signal.targets.some((p,i) => !finite(p) || p <= 0 ||
      (i > 0 && (signal.side === "LONG" ? p <= signal.targets[i-1] : p >= signal.targets[i-1]))) ||
    !Array.isArray(targetWeights) || targetWeights.length !== signal.targets.length ||
    targetWeights.some(w => !finite(w) || w <= 0) ||
    Math.abs(targetWeights.reduce((a,b)=>a+b,0)-1) > 1e-9 ||
    !finite(entryNotional) || entryNotional <= 0 ||
    !finite(feeRate) || feeRate < 0 ||
    !finite(slippageBps) || slippageBps < 0 ||
    !finite(maxEntryDriftPct) || maxEntryDriftPct < 0 ||
    !Number.isInteger(quantityPrecision) || quantityPrecision < 0 || quantityPrecision > 12 ||
    typeof moveStopToBreakevenAfterTarget1 !== "boolean" ||
    !Number.isInteger(maxBars) || maxBars < 1 ||
    !Array.isArray(candles)) return {status:"invalid_input"};

  const side = signal.side;
  const sign = side === "LONG" ? 1 : -1;
  if ((side === "LONG" && !(signal.stop < signal.entry && signal.targets[0] > signal.entry)) ||
      (side === "SHORT" && !(signal.stop > signal.entry && signal.targets[0] < signal.entry))) {
    return {status:"invalid_input"};
  }
  const entry2 = signal.entry2 ?? signal.context?.entry2 ?? null;
  if (entry2 !== null && (!finite(entry2) || entry2 <= 0 ||
      (side === "LONG" ? entry2 >= signal.entry || entry2 <= signal.stop :
        entry2 <= signal.entry || entry2 >= signal.stop))) return {status:"invalid_input"};

  const allLater = candles.filter(c => c && finite(c.time) && c.time > signal.candleTime)
    .sort((a,b)=>a.time-b.time);
  const later = allLater.slice(0,maxBars);
  if (!later.length) return {status:"no_future_candles"};

  const quantityScale = 10 ** quantityPrecision;
  const quantizeQty = value => Math.floor((value + 1e-12) * quantityScale) / quantityScale;
  let qty = 0, initialQty = 0, deployed = 0, fees = 0;
  let funding = 0, realized = 0, entry1Filled = false;
  let entry2Filled = false, entry2Cancelled = false, nextTarget = 0;
  let activeStop = signal.stop, stopMovedToBreakeven = false;
  const fills = [], exits = [], events = [], ambiguousEvents = [];
  let barsProcessed = 0;

  const averageEntry = () => fills.reduce((s,f)=>s+f.price*f.quantity,0) /
    (fills.reduce((s,f)=>s+f.quantity,0) || 1);
  const closeQty = (amount, rawPrice, reason, time) => {
    const q = Math.min(qty, amount >= qty-1e-12 ? qty : quantizeQty(amount));
    if (q <= 1e-12) return;
    const px = adversePrice(rawPrice,side,"exit",slippageBps);
    const pnl = (px-averageEntry())*q*sign;
    const fee = Math.abs(px*q)*feeRate;
    realized += pnl; fees += fee; qty -= q;
    exits.push({reason,time,price:px,quantity:q,grossPnl:pnl,fee});
    events.push({type:"exit",reason,time,price:px,quantity:q});
  };

  for (const bar of later) {
    barsProcessed++;
    if (!validBar(bar)) return {status:"invalid_data",fills,exits,events,ambiguousEvents};
    // Settlement is timestamped at the candle boundary: charge only size carried
    // into this bar, before any new fills or exits at this timestamp.
    if (qty > 1e-12 && bar.fundingSettlement === true && finite(bar.fundingRate)) {
      const payment = sign * bar.open * qty * bar.fundingRate;
      funding += payment;
      events.push({type:"funding",time:bar.time,rate:bar.fundingRate,payment});
    }

    if (!entry1Filled) {
      // A signal is known only after its candle closes; no same-candle fill.
      const driftPct = Math.abs(bar.open-signal.entry)/signal.entry*100;
      if (driftPct > maxEntryDriftPct) {
        return {status:"not_filled",reason:"entry_drift_exceeded",driftPct,barsObserved:barsProcessed,
          fills,exits,events,ambiguousEvents};
      }
      const price = adversePrice(bar.open,side,"entry",slippageBps);
      const quantity = quantizeQty(entryNotional / price);
      if (quantity <= 0) return {status:"not_filled",reason:"below_minimum_quantity_precision",barsObserved:barsProcessed,
        fills,exits,events,ambiguousEvents};
      const notional = quantity * price;
      fills.push({leg:1,time:bar.time,price,quantity,notional});
      qty += quantity; initialQty += quantity; deployed += notional;
      fees += notional*feeRate; entry1Filled = true;
      events.push({type:"entry",leg:1,time:bar.time,price,quantity});
    }

    if (qty <= 1e-12) break;

    // Stop has priority over every other event in an OHLC bar.
    if (isStopTouched(bar,side,activeStop)) {
      if (entry2 !== null && !entry2Filled && !entry2Cancelled &&
          isEntry2Touched(bar,side,entry2)) {
        ambiguousEvents.push({time:bar.time,events:["entry2","stop"],resolution:"stop_first"});
      }
      const rawStop = side === "LONG" && bar.open < activeStop ? bar.open :
        side === "SHORT" && bar.open > activeStop ? bar.open : activeStop;
      closeQty(qty,rawStop,stopMovedToBreakeven?"breakeven_stop":"stop",bar.time);
      break;
    }

    const target1Touched = nextTarget === 0 && isTargetTouched(bar,side,signal.targets[0]);
    const entry2Touched = entry2 !== null && !entry2Filled && !entry2Cancelled &&
      isEntry2Touched(bar,side,entry2);

    // The candle cannot reveal whether the resting limit or TP1 happened first.
    // Choose TP1 first, cancel Entry 2, and retain the ambiguity in the ledger.
    if (target1Touched && entry2Touched) {
      ambiguousEvents.push({time:bar.time,events:["entry2","target_1"],resolution:"target_1_first_cancel_entry2"});
      entry2Cancelled = true;
    } else if (entry2Touched) {
      const price = entry2;
      const quantity = quantizeQty(entryNotional / price);
      if (quantity > 0) {
        const notional = quantity * price;
        fills.push({leg:2,time:bar.time,price,quantity,notional});
        qty += quantity; initialQty += quantity; deployed += notional;
        fees += notional*feeRate; entry2Filled = true;
      }
      events.push({type:"entry",leg:2,time:bar.time,price,quantity});
    } else if (target1Touched && entry2 !== null && !entry2Filled) {
      entry2Cancelled = true;
    }

    while (nextTarget < signal.targets.length && qty > 1e-12 &&
      isTargetTouched(bar,side,signal.targets[nextTarget])) {
      const weight = targetWeights[nextTarget];
      const amount = nextTarget === signal.targets.length-1
        ? qty : Math.min(qty,initialQty*weight);
      const target = signal.targets[nextTarget];
      const rawPrice = side === "LONG" && bar.open > target ? bar.open :
        side === "SHORT" && bar.open < target ? bar.open : target;
      closeQty(amount,rawPrice,`target_${nextTarget+1}`,bar.time);
      if (nextTarget === 0 && moveStopToBreakevenAfterTarget1 && qty > 1e-12) {
        activeStop = averageEntry();
        stopMovedToBreakeven = true;
        events.push({type:"stop_update",time:bar.time,reason:"target_1",stop:activeStop});
      }
      nextTarget++;
    }

    if (qty <= 1e-12) break;
  }

  if (qty > 1e-12 && allLater.length > later.length && barsProcessed === maxBars) {
    closeQty(qty,later.at(-1).close,"time_exit",later.at(-1).time);
  }
  const status = qty <= 1e-12 ? "closed" : "open";
  const mark = later.at(-1).close;
  const unrealized = status === "open" ? (mark-averageEntry())*qty*sign : 0;
  const grossPnl = realized+unrealized;
  const netPnl = grossPnl-fees-funding;
  return {
    status,side,entry1Filled,entry2Filled,entry2Cancelled,stopMovedToBreakeven,activeStop,fills,exits,events,ambiguousEvents,
    averageEntry:averageEntry(),remainingQuantity:qty,deployedNotional:deployed,
    grossPnl,fees,funding,unrealized,netPnl,
    returnPct:deployed ? netPnl/deployed*100 : 0,
    barsObserved:barsProcessed,nextTargetIndex:nextTarget,
    fundingIncluded:events.some(e=>e.type==="funding"),
    unresolvedAtEnd:status==="open"
  };
}

const FEE_RATE = 0.0005;
const SLIPPAGE_RATE = 0.0003;

export function aggregateCandles(candles, bucketMs) {
  const out = [];
  let current = null;
  for (const c of candles) {
    const bucket = Math.floor(c.openTime / bucketMs) * bucketMs;
    if (!current || current.openTime !== bucket) {
      if (current) out.push(current);
      current = { openTime: bucket, closeTime: bucket + bucketMs - 1, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume };
    } else {
      current.high = Math.max(current.high, c.high);
      current.low = Math.min(current.low, c.low);
      current.close = c.close;
      current.volume += c.volume;
    }
  }
  if (current) out.push(current);
  return out;
}

function ema(values, period) {
  const out = Array(values.length).fill(null);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let prev = values.slice(0, period).reduce((a,b) => a+b, 0) / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1-k);
    out[i] = prev;
  }
  return out;
}

function average(values, end, length) {
  if (end - length + 1 < 0) return null;
  let sum = 0;
  for (let i=end-length+1; i<=end; i++) sum += values[i];
  return sum / length;
}

function closedIndex(candles, time) {
  let lo=0, hi=candles.length-1, ans=-1;
  while (lo<=hi) {
    const mid=(lo+hi)>>1;
    if (candles[mid].closeTime < time) { ans=mid; lo=mid+1; }
    else hi=mid-1;
  }
  return ans;
}

function fibZone(candles, end, direction) {
  const start = Math.max(0, end-11);
  let high=-Infinity, low=Infinity;
  for (let i=start;i<=end;i++) { high=Math.max(high,candles[i].high); low=Math.min(low,candles[i].low); }
  const range=high-low;
  if (!(range>0)) return null;
  return direction === "long"
    ? { low: high-range*0.618, high: high-range*0.5, swingLow: low }
    : { low: low+range*0.5, high: low+range*0.618, swingHigh: high };
}

function scoreSignal({ candles, volumes, i, h1, h4, h1e20, h1e50, h4e20, h4e50, profile }) {
  const c=candles[i], prev=candles[i-1];
  const h4i=closedIndex(h4,c.openTime), h1i=closedIndex(h1,c.openTime);
  if (h4i<50 || h1i<50) return null;
  const bullish4=h4e20[h4i]!==null && h4e20[h4i]>h4e50[h4i];
  const bearish4=h4e20[h4i]!==null && h4e20[h4i]<h4e50[h4i];
  const bullish1=h1e20[h1i]!==null && h1e20[h1i]>h1e50[h1i];
  const bearish1=h1e20[h1i]!==null && h1e20[h1i]<h1e50[h1i];
  const volAvg=average(volumes,i-1,20);
  if (!volAvg || c.volume < volAvg*profile.relativeVolume) return null;
  for (const direction of ["long","short"]) {
    if (direction==="long" && !(bullish4 && (profile.require1h ? bullish1 : true))) continue;
    if (direction==="short" && !(bearish4 && (profile.require1h ? bearish1 : true))) continue;
    const zone=fibZone(h4,h4i,direction);
    if (!zone || c.close<zone.low || c.close>zone.high) continue;
    const trigger=direction==="long" ? c.close>prev.high && c.close>c.open : c.close<prev.low && c.close<c.open;
    if (!trigger) continue;
    const recent=candles.slice(Math.max(0,i-12),i+1);
    const stop=direction==="long" ? Math.min(...recent.map(x=>x.low)) : Math.max(...recent.map(x=>x.high));
    const entry=c.close*(direction==="long" ? 1+SLIPPAGE_RATE : 1-SLIPPAGE_RATE);
    const risk=direction==="long" ? entry-stop : stop-entry;
    if (!(risk>0) || risk/entry>0.025) continue;
    return { direction, entry, stop, target: direction==="long" ? entry+risk*profile.rewardR : entry-risk*profile.rewardR, risk };
  }
  return null;
}

function runProfile(symbol, candles, profile) {
  const h1=aggregateCandles(candles,3600000), h4=aggregateCandles(candles,14400000);
  const h1c=h1.map(x=>x.close), h4c=h4.map(x=>x.close), volumes=candles.map(x=>x.volume);
  const h1e20=ema(h1c,20), h1e50=ema(h1c,50), h4e20=ema(h4c,20), h4e50=ema(h4c,50);
  const trades=[];
  let active=null;
  for (let i=1;i<candles.length;i++) {
    const c=candles[i];
    if (active) {
      const stopHit=active.direction==="long" ? c.low<=active.stop : c.high>=active.stop;
      const targetHit=active.direction==="long" ? c.high>=active.target : c.low<=active.target;
      if (stopHit || targetHit || i-active.entryIndex>=48) {
        // Conservative ordering: if stop and target occur in the same candle, assume stop first.
        const exitRaw=stopHit ? active.stop : targetHit ? active.target : c.close;
        const exit=exitRaw*(active.direction==="long" ? 1-SLIPPAGE_RATE : 1+SLIPPAGE_RATE);
        const gross=active.direction==="long" ? (exit-active.entry)/active.entry : (active.entry-exit)/active.entry;
        const fees=FEE_RATE*2;
        const net=gross-fees;
        trades.push({ symbol, model:profile.id, direction:active.direction, entryTime:active.entryTime, exitTime:c.closeTime, entry:active.entry, exit, stop:active.stop, target:active.target, netReturnPct:net*100, rMultiple:net/(active.risk/active.entry), outcome:net>0?"win":"loss", exitReason:stopHit?"stop":targetHit?"target":"time" });
        active=null;
      }
      continue;
    }
    const signal=scoreSignal({ candles,volumes,i,h1,h4,h1e20,h1e50,h4e20,h4e50,profile });
    if (signal) active={...signal,entryIndex:i,entryTime:c.closeTime};
  }
  return trades;
}

function summarize(model, trades) {
  const wins=trades.filter(t=>t.netReturnPct>0), losses=trades.filter(t=>t.netReturnPct<=0);
  const grossWin=wins.reduce((s,t)=>s+t.netReturnPct,0);
  const grossLoss=Math.abs(losses.reduce((s,t)=>s+t.netReturnPct,0));
  let equity=1, peak=1, maxDrawdown=0;
  for (const t of trades.sort((a,b)=>a.exitTime-b.exitTime)) {
    equity*=1+(t.rMultiple*0.01);
    peak=Math.max(peak,equity);
    maxDrawdown=Math.max(maxDrawdown,(peak-equity)/peak);
  }
  const netPct=(equity-1)*100;
  return { model, trades:trades.length, wins:wins.length, losses:losses.length, winRatePct:trades.length?wins.length/trades.length*100:null, netReturnPct:netPct, assumedRiskPerTradePct:1, profitFactor:grossLoss?grossWin/grossLoss:(grossWin?null:0), maxDrawdownPct:maxDrawdown*100, expectancyPct:trades.length?trades.reduce((s,t)=>s+t.netReturnPct,0)/trades.length:null, averageR:trades.length?trades.reduce((s,t)=>s+t.rMultiple,0)/trades.length:null, longTrades:trades.filter(t=>t.direction==="long").length, shortTrades:trades.filter(t=>t.direction==="short").length };
}

export function runHistoricalComparison(dataset) {
  const profiles=[
    { id:"A", relativeVolume:1.5, require1h:true, rewardR:2 },
    { id:"B", relativeVolume:1.1, require1h:false, rewardR:1.8 }
  ];
  const all=[];
  for (const [symbol,candles] of Object.entries(dataset)) {
    const sorted=candles.slice().sort((a,b)=>a.openTime-b.openTime);
    for (const profile of profiles) all.push(...runProfile(symbol,sorted,profile));
  }
  return { generatedAt:new Date().toISOString(), candleInterval:"5m", feeRate:FEE_RATE, slippageRate:SLIPPAGE_RATE, assumptions:{ stopWinsWhenStopAndTargetTouchSameCandle:true, portfolioRiskPerTradePct:1, maxHoldingCandles:48, overlappingTradesPerSymbolAndModel:false, riskPerTradeNotional:"not compounded position sizing; returns are per-trade percentage" }, models:[summarize("A",all.filter(t=>t.model==="A")),summarize("B",all.filter(t=>t.model==="B"))], trades:all };
}

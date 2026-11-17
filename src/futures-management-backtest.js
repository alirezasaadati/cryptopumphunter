// Candle-based comparison of the current exit plan vs staged protective stops.
// Conservative rule: an existing stop is checked before any new stage is activated.
// If a newly activated stop is also crossed within that candle, count the stop as hit.
const STAGES = [
  { id: "protect_075R", triggerR: 0.75, lockR: 0.10 },
  { id: "lock_125R", triggerR: 1.25, lockR: 0.50 },
  { id: "lock_175R", triggerR: 1.75, lockR: 1.00 },
  { id: "lock_250R", triggerR: 2.50, lockR: 1.75 }
];

function closeR(position, rawPrice, reason, time, fee, slippage) {
  const dir = position.direction;
  const fill = rawPrice * (1 - dir * slippage);
  const grossR = dir * (fill - position.entry) / position.risk;
  const feeR = fee * (position.entry + fill) / position.risk;
  position.netR += position.remaining * (grossR - feeR);
  position.remaining = 0;
  position.exitReason = reason;
  position.exitTime = time;
}

export function simulateManagedTrade({
  side, entry, stop, targets, candles, startIndex = 0,
  fee = 0.0005, slippage = 0.0003, maxHoldHours = 72,
  stages = STAGES
}) {
  const direction = side === "LONG" ? 1 : side === "SHORT" ? -1 : 0;
  const risk = direction === 1 ? entry - stop : stop - entry;
  if (!direction || !(risk > 0) || !Number.isFinite(risk)) throw new Error("Invalid trade setup");
  const position = {
    side, entry, initialStop: stop, currentStop: stop, risk, direction,
    remaining: 1, netR: 0, targetHits: 0, stagesHit: [],
    exitTime: null, exitReason: null
  };
  const endIndex = Math.min(candles.length - 1, startIndex + maxHoldHours);
  const targetLevels = [...targets];

  for (let i = startIndex; i <= endIndex && position.remaining > 1e-9; i++) {
    const bar = candles[i];
    const gap = direction === 1 ? bar.open <= position.currentStop : bar.open >= position.currentStop;
    const stopHit = direction === 1 ? bar.low <= position.currentStop : bar.high >= position.currentStop;
    if (gap || stopHit) {
      closeR(position, gap ? bar.open : position.currentStop, "STOP", bar.time, fee, slippage);
      break;
    }

    // Activate a protective stage from the candle's favorable extreme.
    // If both the new stop and a target are touched in the same OHLC candle,
    // resolve the ambiguity against the strategy: stop first, no target credit.
    const favorableExtreme = direction === 1 ? bar.high : bar.low;
    const favorableR = direction * (favorableExtreme - entry) / risk;
    const reached = stages.filter(s => favorableR >= s.triggerR && !position.stagesHit.includes(s.id))
      .sort((a,b) => b.triggerR - a.triggerR);
    if (reached.length) {
      const stage = reached[0];
      const proposed = entry + direction * stage.lockR * risk;
      const improves = direction === 1 ? proposed > position.currentStop : proposed < position.currentStop;
      position.stagesHit.push(stage.id);
      if (improves) {
        position.currentStop = proposed;
        const newStopHit = direction === 1 ? bar.low <= proposed : bar.high >= proposed;
        if (newStopHit) {
          closeR(position, proposed, "MANAGEMENT_STOP", bar.time, fee, slippage);
          break;
        }
      }
    }

    // Preserve the baseline 40/35/25 partial take-profit plan.
    for (let t = 0; t < targetLevels.length && position.remaining > 1e-9; t++) {
      const target = targetLevels[t];
      if (target == null) continue;
      const touched = direction === 1 ? bar.high >= target : bar.low <= target;
      if (!touched) continue;
      const weight = [0.40, 0.35, 0.25][t];
      const fill = target * (1 - direction * slippage);
      const grossR = direction * (fill - entry) / risk;
      const feeR = fee * (entry + fill) / risk;
      position.netR += weight * (grossR - feeR);
      position.remaining -= weight;
      position.targetHits++;
      targetLevels[t] = null;
    }
    if (position.remaining <= 1e-9) {
      position.remaining = 0; position.exitReason = "TARGETS"; position.exitTime = bar.time;
      break;
    }

    if (i === endIndex) closeR(position, bar.close, "TIME_EXIT", bar.time, fee, slippage);
  }

  if (position.remaining > 1e-9) closeR(position, candles[endIndex].close, "TIME_EXIT", candles[endIndex].time, fee, slippage);
  return {
    side, entry, stop, risk, netR: position.netR, targetHits: position.targetHits,
    stagesHit: position.stagesHit, finalStop: position.currentStop,
    exitReason: position.exitReason, entryTime: candles[startIndex].time, exitTime: position.exitTime
  };
}

export function summarizeManagementComparison(rows) {
  const wins = rows.filter(x => x.netR > 0), losses = rows.filter(x => x.netR < 0);
  const grossWins = wins.reduce((s,x)=>s+x.netR,0);
  const grossLosses = Math.abs(losses.reduce((s,x)=>s+x.netR,0));
  let equity=0, peak=0, maxDrawdownR=0;
  for (const row of rows) {
    equity += row.netR;
    peak = Math.max(peak,equity);
    maxDrawdownR = Math.max(maxDrawdownR,peak-equity);
  }
  return {
    trades: rows.length,
    wins: wins.length,
    losses: losses.length,
    winRatePct: rows.length ? wins.length/rows.length*100 : 0,
    netR: equity,
    expectancyR: rows.length ? equity/rows.length : 0,
    profitFactor: grossLosses ? grossWins/grossLosses : grossWins ? null : 0,
    maxDrawdownR,
    averageTargetHits: rows.length ? rows.reduce((s,x)=>s+x.targetHits,0)/rows.length : 0,
    managementStopExits: rows.filter(x=>x.exitReason==="MANAGEMENT_STOP").length
  };
}

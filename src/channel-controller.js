// Channel-style trade manager for the experimental MTF engine.
// Two equal-size entries; second entry is adverse by 2.8% from entry one.
// Five price targets are measured from the blended average entry.
// Stop is supplied by the MTF engine (structure + ATR); no guessed fixed stop.
export const CHANNEL_TARGET_PCTS = [0.01, 0.03, 0.06, 0.10, 0.14];
export const CHANNEL_ENTRY2_PCT = 0.028;

export const EXIT_ALLOCATIONS = {
  front_loaded: [0.40, 0.25, 0.15, 0.10, 0.10],
  equal: [0.20, 0.20, 0.20, 0.20, 0.20],
  back_loaded: [0.10, 0.15, 0.20, 0.25, 0.30],
};

function direction(side) {
  if (side === "LONG") return 1;
  if (side === "SHORT") return -1;
  throw new Error("side must be LONG or SHORT");
}

export function createChannelPosition(signal, allocation = "front_loaded", options = {}) {
  const dir = direction(signal.side);
  const entry = Number(signal.entry);
  const stop = Number(signal.stop);
  const weights = Array.isArray(allocation) ? allocation : EXIT_ALLOCATIONS[allocation];
  const targetPcts = options.targetPcts || CHANNEL_TARGET_PCTS;
  if (!(entry > 0) || !(stop > 0) || (dir === 1 ? stop >= entry : stop <= entry)) {
    throw new Error("invalid entry/stop levels");
  }
  if (!weights || weights.length !== 5 || Math.abs(weights.reduce((a,b)=>a+b,0)-1) > 1e-8) {
    throw new Error("five exit weights must sum to 1");
  }
  return {
    symbol: signal.symbol, side: signal.side, dir, entry1: entry, entry2: null,
    entry2Trigger: entry * (1 - dir * (options.entry2Pct ?? CHANNEL_ENTRY2_PCT)),
    averageEntry: entry, stop, initialStop: stop, targetPcts: [...targetPcts],
    targets: targetPcts.map(p => entry * (1 + dir * p)),
    weights: [...weights], remaining: 1, realizedPnl: 0, realizedQty: 0,
    targetHits: [], entry2Cancelled: false, status: "OPEN",
    entryTime: signal.entryTime ?? null, exitReason: null, exitTime: null,\n    fills: [{ kind: "ENTRY", price: entry, qty: 1 }],
    moveStopToBreakeven: options.moveStopToBreakeven === true,
  };
}

// Processes one closed OHLC candle. Stop wins any same-candle ambiguity.
export function processChannelCandle(position, candle) {
  if (position.status !== "OPEN") return position;
  const p = position, dir = p.dir, high = Number(candle.high), low = Number(candle.low);
  const stopHit = dir === 1 ? low <= p.stop : high >= p.stop;
  const entry2Hit = p.entry2 === null && !p.entry2Cancelled &&
    (dir === 1 ? low <= p.entry2Trigger : high >= p.entry2Trigger);
  if (stopHit) {
    p.realizedPnl += p.remaining * dir * (p.stop - p.averageEntry);\n    p.fills.push({ kind: "EXIT", price: p.stop, qty: p.remaining, reason: "STOP" });
    p.realizedQty += p.remaining;
    p.remaining = 0; p.status = "CLOSED"; p.exitReason = "STOP"; p.exitTime = candle.time;
    return p;
  }
  const firstTargetTouched = dir === 1 ? high >= p.targets[0] : low <= p.targets[0];\n  // If TP1 and the second-entry trigger occur in the same OHLC candle,\n  // resolve conservatively in favor of TP1: do not assume the add filled first.\n  if (entry2Hit && firstTargetTouched) p.entry2Cancelled = true;\n  if (entry2Hit && !p.entry2Cancelled) {
    p.entry2 = p.entry2Trigger;
    p.averageEntry = (p.entry1 + p.entry2) / 2;
    p.remaining = 2;
    p.targets = p.targetPcts.map(x => p.averageEntry * (1 + dir * x));
  }
  // If TP1 is reached before entry two, cancel the pending second entry.
  for (let i = 0; i < 5 && p.remaining > 1e-9; i++) {
    if (p.targetHits.includes(i + 1)) continue;
    const hit = dir === 1 ? high >= p.targets[i] : low <= p.targets[i];
    if (!hit) break;
    const qty = Math.min(p.remaining, (p.entry2 === null ? 1 : 2) * p.weights[i]);
    p.realizedPnl += qty * dir * (p.targets[i] - p.averageEntry);\n    p.fills.push({ kind: "EXIT", price: p.targets[i], qty, reason: "TP" + (i + 1) });
    p.realizedQty += qty; p.remaining -= qty; p.targetHits.push(i + 1);
    if (i === 0 && p.entry2 === null) p.entry2Cancelled = true;
    if (i === 0 && p.moveStopToBreakeven) p.stop = p.averageEntry;
  }
  if (p.remaining <= 1e-9) {
    p.remaining = 0; p.status = "CLOSED"; p.exitReason = "ALL_TARGETS"; p.exitTime = candle.time;
  }
  return p;
}

export function closeChannelPosition(position, price, time, reason = "TIME_EXIT") {
  if (position.status !== "OPEN") return position;
  const px = Number(price);
  position.realizedPnl += position.remaining * position.dir * (px - position.averageEntry);\n  position.fills.push({ kind: "EXIT", price: px, qty: position.remaining, reason });
  position.realizedQty += position.remaining; position.remaining = 0;
  position.status = "CLOSED"; position.exitReason = reason; position.exitTime = time;
  return position;
}

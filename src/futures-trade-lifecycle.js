// Experimental futures trade lifecycle. This module evaluates signal-level candles only;
// it does not place orders or claim exchange execution.
//
// A signal is considered profitable at its own TP1 level. TP2/TP3 remain
// informational levels; the bot never places or closes exchange orders.
export function tradeDir(side) {
  return side === "LONG" ? 1 : side === "SHORT" ? -1 : 0;
}

export function priceChangePercent(side, entry, exit) {
  const direction = tradeDir(side);
  const e = Number(entry);
  const x = Number(exit);
  if (!direction || !Number.isFinite(e) || e <= 0 || !Number.isFinite(x)) return null;
  return direction * ((x - e) / e) * 100;
}

function validCandle(candle) {
  return candle && [candle.open, candle.high, candle.low].every(value => Number.isFinite(Number(value))) &&
    Number(candle.high) >= Number(candle.low);
}

// Stop is deliberately evaluated before TP1. If one candle spans both levels,
// OHLC data cannot prove which was touched first, so the result is conservative.
export function evaluateTradeCandle(trade, candle) {
  if (!trade || trade.status !== "OPEN" || !["LONG", "SHORT"].includes(trade.side)) {
    return { changed: false, trade };
  }
  if (!validCandle(candle)) return { changed: false, trade, error: "INVALID_CANDLE" };

  const entry = Number(trade.actualEntry ?? trade.entry);
  const stop = Number(trade.currentStop ?? trade.initialStop ?? trade.stop);
  const target1 = Number(trade.target1);
  if (!Number.isFinite(entry) || entry <= 0 || !Number.isFinite(stop) || stop <= 0 ||
      !Number.isFinite(target1) || target1 <= 0) {
    return { changed: false, trade, error: "INVALID_TRADE_LEVELS" };
  }

  const open = Number(candle.open);
  const high = Number(candle.high);
  const low = Number(candle.low);
  const stopHit = trade.side === "LONG" ? low <= stop : high >= stop;
  const tp1Hit = trade.side === "LONG" ? high >= target1 : low <= target1;
  if (!stopHit && !tp1Hit) return { changed: false, trade };

  const stopAtOpen = trade.side === "LONG" ? open <= stop : open >= stop;
  const tp1AtOpen = trade.side === "LONG" ? open >= target1 : open <= target1;
  const closeAtStop = stopAtOpen || (!tp1AtOpen && stopHit);
  const reason = closeAtStop ? "CLOSED_STOP" : "CLOSED_PROFIT";
  const exitPrice = closeAtStop
    ? (stopAtOpen ? open : stop)
    : (tp1AtOpen ? open : target1);
  const closedAt = candle.time ?? new Date().toISOString();

  const updatedTrade = {
    ...trade,
    status: reason,
    closeReason: reason,
    exitPrice,
    closePriceChangePercent: priceChangePercent(trade.side, entry, exitPrice),
    // Retained as a null legacy field for compatibility; no leverage/margin
    // assumptions are used by signal evaluation or closure.
    marginReturnPercent: null,
    closedAt,
    lockReleaseEligible: true
  };
  return { changed: true, reason, trade: updatedTrade };
}

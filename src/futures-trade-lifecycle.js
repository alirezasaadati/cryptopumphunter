// Experimental futures trade lifecycle. This module evaluates signal-level candles only;
// it does not place orders or claim exchange execution.
export const FUTURES_TRADE_LEVERAGE = 10;
export const FUTURES_MARGIN_PROFIT_TARGET_PERCENT = 30;
export const FUTURES_PRICE_MOVE_TARGET_PERCENT =
  FUTURES_MARGIN_PROFIT_TARGET_PERCENT / FUTURES_TRADE_LEVERAGE;

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

export function marginReturnPercent(side, entry, exit, leverage = FUTURES_TRADE_LEVERAGE) {
  const move = priceChangePercent(side, entry, exit);
  const multiplier = Number(leverage);
  if (move === null || !Number.isFinite(multiplier) || multiplier <= 0) return null;
  return move * multiplier;
}

export function profitTargetPrice(side, entry, leverage = FUTURES_TRADE_LEVERAGE, targetMarginPercent = FUTURES_MARGIN_PROFIT_TARGET_PERCENT) {
  const direction = tradeDir(side);
  const e = Number(entry);
  const lev = Number(leverage);
  const target = Number(targetMarginPercent);
  if (!direction || !Number.isFinite(e) || e <= 0 || !Number.isFinite(lev) || lev <= 0 || !Number.isFinite(target) || target <= 0) return null;
  const move = target / lev / 100;
  return e * (1 + direction * move);
}

function validCandle(candle) {
  return candle && [candle.open, candle.high, candle.low].every(value => Number.isFinite(Number(value))) &&
    Number(candle.high) >= Number(candle.low);
}

// Stop is deliberately evaluated before profit. If one candle spans both levels,
// candle OHLC data cannot prove which was touched first, so the result is conservative.
export function evaluateTradeCandle(trade, candle, options = {}) {
  if (!trade || trade.status !== "OPEN" || !["LONG", "SHORT"].includes(trade.side)) {
    return { changed: false, trade };
  }
  if (!validCandle(candle)) return { changed: false, trade, error: "INVALID_CANDLE" };

  const entry = Number(trade.actualEntry ?? trade.entry);
  const stop = Number(trade.currentStop ?? trade.initialStop ?? trade.stop);
  const target = profitTargetPrice(
    trade.side,
    entry,
    options.leverage ?? FUTURES_TRADE_LEVERAGE,
    options.targetMarginPercent ?? FUTURES_MARGIN_PROFIT_TARGET_PERCENT
  );
  if (!Number.isFinite(entry) || entry <= 0 || !Number.isFinite(stop) || stop <= 0 || target === null) {
    return { changed: false, trade, error: "INVALID_TRADE_LEVELS" };
  }

  const open = Number(candle.open);
  const high = Number(candle.high);
  const low = Number(candle.low);
  const stopHit = trade.side === "LONG" ? low <= stop : high >= stop;
  const profitHit = trade.side === "LONG" ? high >= target : low <= target;

  if (!stopHit && !profitHit) return { changed: false, trade };

  const stopExit = trade.side === "LONG"
    ? (open <= stop ? open : stop)
    : (open >= stop ? open : stop);
  const profitExit = trade.side === "LONG"
    ? (open >= target ? open : target)
    : (open <= target ? open : target);
  const reason = stopHit ? "CLOSED_STOP" : "CLOSED_PROFIT";
  const exitPrice = stopHit ? stopExit : profitExit;
  const closedAt = candle.time ?? new Date().toISOString();
  const updatedTrade = {
    ...trade,
    status: reason,
    closeReason: reason,
    exitPrice,
    closePriceChangePercent: priceChangePercent(trade.side, entry, exitPrice),
    marginReturnPercent: marginReturnPercent(trade.side, entry, exitPrice, options.leverage ?? FUTURES_TRADE_LEVERAGE),
    closedAt,
    lockReleased: true
  };
  return { changed: true, reason, trade: updatedTrade };
}

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
  const stopAtOpen = trade.side === "LONG" ? open <= stop : open >= stop;
  const profitAtOpen = trade.side === "LONG" ? open >= target : open <= target;
  // A gap through one level at the candle open establishes that level first.
  // If both are touched later within the candle, stop remains the conservative choice.
  const closeAtStop = stopAtOpen || (!profitAtOpen && stopHit);
  const reason = closeAtStop ? "CLOSED_STOP" : "CLOSED_PROFIT";
  const exitPrice = closeAtStop ? stopExit : profitExit;
  const closedAt = candle.time ?? new Date().toISOString();
  const updatedTrade = {
    ...trade,
    status: reason,
    closeReason: reason,
    exitPrice,
    closePriceChangePercent: priceChangePercent(trade.side, entry, exitPrice),
    marginReturnPercent: marginReturnPercent(trade.side, entry, exitPrice, options.leverage ?? FUTURES_TRADE_LEVERAGE),
    closedAt,
    lockReleaseEligible: true
  };
  return { changed: true, reason, trade: updatedTrade };
}

// V4.8 experimental R-based scaled exits: 40% at 1.5R, 35% at 2.2R, 25% at 3R.
export const TP_WEIGHTS = Object.freeze([0.40, 0.35, 0.25]);

export function evaluateTradeCandleR(trade, candle, options = {}) {
  if (!trade || trade.status !== "OPEN" || !["LONG", "SHORT"].includes(trade.side)) {
    return { changed: false, closed: false, trade };
  }
  if (!validCandle(candle)) return { changed: false, closed: false, trade, error: "INVALID_CANDLE" };

  const dir = tradeDir(trade.side);
  const entry = Number(trade.actualEntry ?? trade.entry);
  const initialStop = Number(trade.initialStop ?? trade.stop);
  const risk = dir * (entry - initialStop);
  const targets = [trade.target1, trade.target2, trade.target3].map(Number);
  const ordered = targets.every((target, index) =>
    Number.isFinite(target) && target > 0 && dir * (target - entry) > 0 &&
    (index === 0 || dir * (target - targets[index - 1]) > 0)
  );
  if (!Number.isFinite(entry) || entry <= 0 || !Number.isFinite(risk) || risk <= 0 || !ordered) {
    return { changed: false, closed: false, trade, error: "INVALID_TRADE_LEVELS" };
  }

  const weights = options.weights ?? TP_WEIGHTS;
  if (!Array.isArray(weights) || weights.length !== 3 ||
      weights.some(weight => !Number.isFinite(Number(weight)) || Number(weight) <= 0) ||
      Math.abs(weights.reduce((sum, weight) => sum + Number(weight), 0) - 1) > 1e-9) {
    return { changed: false, closed: false, trade, error: "INVALID_TP_WEIGHTS" };
  }
  const breakevenAfterTp1 = options.breakevenAfterTp1 ?? true;
  const leverage = Number(options.leverage ?? FUTURES_TRADE_LEVERAGE);
  if (!Number.isFinite(leverage) || leverage <= 0) {
    return { changed: false, closed: false, trade, error: "INVALID_LEVERAGE" };
  }

  const open = Number(candle.open), high = Number(candle.high), low = Number(candle.low);
  const hits = [...new Set(Array.isArray(trade.tpHits) ? trade.tpHits : [])]
    .filter(tag => ["TP1", "TP2", "TP3"].includes(tag));
  let stop = Number(trade.currentStop ?? initialStop);
  let realizedR = Number.isFinite(Number(trade.realizedR)) ? Number(trade.realizedR) : 0;
  let remaining = Number.isFinite(Number(trade.remainingFraction))
    ? Number(trade.remainingFraction)
    : 1 - weights.reduce((sum, weight, index) => sum + (hits.includes("TP" + (index + 1)) ? Number(weight) : 0), 0);
  if (!Number.isFinite(stop) || stop <= 0 || !Number.isFinite(remaining) || remaining < -1e-9 || remaining > 1 + 1e-9) {
    return { changed: false, closed: false, trade, error: "INVALID_TRADE_STATE" };
  }
  remaining = Math.max(0, Math.min(1, remaining));

  const stopHit = dir > 0 ? low <= stop : high >= stop;
  if (stopHit) {
    const stopExit = dir > 0 ? (open <= stop ? open : stop) : (open >= stop ? open : stop);
    const totalR = realizedR + remaining * dir * (stopExit - entry) / risk;
    return finish(totalR, stopExit, hits.length ? "STOP_AFTER_TP" : "STOP");
  }

  let changed = false;
  for (let index = 0; index < 3; index++) {
    const tag = "TP" + (index + 1);
    if (hits.includes(tag)) continue;
    const reached = dir > 0 ? high >= targets[index] : low <= targets[index];
    if (!reached) break;
    realizedR += Number(weights[index]) * dir * (targets[index] - entry) / risk;
    remaining = Math.max(0, remaining - Number(weights[index]));
    hits.push(tag);
    changed = true;
    if (index === 0 && breakevenAfterTp1) {
      stop = dir > 0 ? Math.max(stop, entry) : Math.min(stop, entry);
    }
  }

  if (hits.includes("TP3") || remaining <= 1e-9) return finish(realizedR, targets[2], "TP3");
  if (!changed) return { changed: false, closed: false, trade };
  return {
    changed: true,
    closed: false,
    reason: hits.at(-1),
    trade: { ...trade, tpHits: hits, currentStop: stop, realizedR, remainingFraction: remaining, outcomeR: realizedR }
  };

  function finish(totalR, exitPrice, why) {
    const status = totalR > 1e-9 ? "CLOSED_PROFIT" : "CLOSED_STOP";
    const pricePct = totalR * risk / entry * 100;
    return {
      changed: true,
      closed: true,
      reason: status,
      trade: {
        ...trade, status, closeReason: why, tpHits: hits, currentStop: stop,
        realizedR: totalR, remainingFraction: 0, outcomeR: totalR, exitPrice,
        closePriceChangePercent: pricePct, marginReturnPercent: pricePct * leverage,
        closedAt: candle.time ?? new Date().toISOString(), lockReleaseEligible: true
      }
    };
  }
}

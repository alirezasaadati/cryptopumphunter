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

// The current production TP/SL lifecycle is intentionally retained for this experiment.


export function evaluateStagedTradeCandle(trade, candle, options = {}) {
  if (!trade || trade.status !== "OPEN" || !["LONG", "SHORT"].includes(trade.side)) {
    return { changed: false, trade };
  }
  if (!validCandle(candle) || !Number.isFinite(Number(candle.close))) {
    return { changed: false, trade, error: "INVALID_CANDLE" };
  }

  const entry = Number(trade.actualEntry ?? trade.entry);
  const initialStop = Number(trade.initialStop ?? trade.stop);
  const targets = [1.5, 2.5, 3.5].map(r => {
    const risk = Math.abs(entry - initialStop);
    return entry + tradeDir(trade.side) * risk * r;
  });
  const dir = tradeDir(trade.side);
  const open = Number(candle.open), high = Number(candle.high), low = Number(candle.low);
  const stop = Number(trade.currentStop ?? initialStop);
  if (![entry, initialStop, ...targets, open, high, low].every(Number.isFinite) ||
      entry <= 0 || initialStop <= 0 || stop <= 0 || targets.some(x => x <= 0)) {
    return { changed: false, trade, error: "INVALID_TRADE_LEVELS" };
  }

  const stopHit = trade.side === "LONG" ? low <= stop : high >= stop;
  const stopAtOpen = trade.side === "LONG" ? open <= stop : open >= stop;
  const risk = Math.abs(entry - initialStop);
  let realized = Number(trade.realizedMarginReturnPct || 0);
  let remaining = Number(trade.remainingFraction ?? 1);
  const tpHits = Array.isArray(trade.tpHits) ? [...trade.tpHits] : [];
  const leverage = Number(options.leverage ?? FUTURES_TRADE_LEVERAGE);
  const pricePct = exit => dir * ((exit - entry) / entry) * 100 * leverage;

  const closeStop = () => {
    const exit = stopAtOpen ? open : stop;
    realized += remaining * pricePct(exit);
    return { changed: true, closed: true, reason: "CLOSED_STOP", trade: {
      ...trade, status: "CLOSED_STOP", closeReason: "CLOSED_STOP", exitPrice: exit,
      closePriceChangePercent: priceChangePercent(trade.side, entry, exit),
      tpHits, remainingFraction: 0, realizedMarginReturnPct: realized,
      marginReturnPercent: realized, closedAt: candle.time ?? new Date().toISOString(),
      currentStop: stop, lockReleaseEligible: true
    }};
  };

  // Same conservative intrabar policy as the staged-exit backtest: active stop first.
  if (stopHit) return closeStop();

  // Never move the tracked stop automatically: the Worker cannot modify the
  // exchange order. currentStop changes only after the owner confirms an
  // already-completed manual stop update with /confirm_stop.
  const currentStop = stop;
  const breakEvenActivated = trade.breakEvenActivated === true;

  for (let i = 0; i < 3; i++) {
    const name = "TP" + (i + 1);
    if (tpHits.includes(name)) continue;
    const target = targets[i];
    const hit = trade.side === "LONG" ? high >= target : low <= target;
    if (!hit) break;
    const favorableGap = trade.side === "LONG" ? open >= target : open <= target;
    const exit = favorableGap ? open : target;
    const fraction = i < 2 ? 1 / 3 : remaining;
    realized += fraction * pricePct(exit);
    remaining = Math.max(0, remaining - fraction);
    tpHits.push(name);
  }

  const updatedAt = candle.time ?? new Date().toISOString();
  if (remaining <= 1e-9) {
    return { changed: true, closed: true, reason: "CLOSED_PROFIT", trade: {
      ...trade, status: "CLOSED_PROFIT", closeReason: "CLOSED_PROFIT",
      exitPrice: targets[2], closePriceChangePercent: priceChangePercent(trade.side, entry, targets[2]),
      tpHits, remainingFraction: 0, realizedMarginReturnPct: realized,
      marginReturnPercent: realized, closedAt: updatedAt, currentStop,
      breakEvenActivated, lockReleaseEligible: true
    }};
  }

  const changed = tpHits.length !== (trade.tpHits || []).length ||
    currentStop !== stop || breakEvenActivated !== (trade.breakEvenActivated === true);
  return { changed, stopMoved: currentStop !== stop, closed: false, trade: {
    ...trade, tpHits, remainingFraction: remaining, realizedMarginReturnPct: realized,
    currentStop, breakEvenActivated
  }};
}

const HOUR = 3600000;
const FEE = 0.0005;
const SLIPPAGE = 0.0003;

function signedMove(side, from, to) {
  return side === "LONG" ? to - from : from - to;
}

function exitLeg(side, entry, rawPrice, weight, initialRisk) {
  const price = side === "LONG" ? rawPrice * (1 - SLIPPAGE) : rawPrice * (1 + SLIPPAGE);
  return {
    price,
    grossR: weight * signedMove(side, entry, price) / initialRisk,
    feeR: FEE * price * weight / initialRisk
  };
}

/**
 * Conservative 5m OHLC exit model.
 * Breakouts: 50% TP1 at 1.5R, remaining 50% trails by 1R after TP1.
 * Reversals: move stop to break-even after +1R; update is effective next bar.
 * When stop and target are both touched in one bar, stop is evaluated first.
 */
export function simulateChannelExit({ side, setup, entry, stop, target, bars, startIndex, maxHoldHours = 72 }) {
  const initialRisk = Math.abs(entry - stop);
  if (!(initialRisk > 0) || !Array.isArray(bars) || !bars[startIndex]) {
    throw new Error("Invalid exit simulation inputs");
  }

  const isBreakout = String(setup).includes("BREAKOUT");
  const maxIndex = Math.min(bars.length - 1, startIndex + maxHoldHours * 12);
  let activeStop = stop;
  let remaining = 1;
  let grossR = 0;
  let exitFeeR = 0;
  let partialTaken = false;
  let breakEvenActivated = false;
  let trailingActivated = false;
  let bestFavorable = entry;
  let finalReason = "TIME";
  let finalTime = bars[maxIndex]?.time;
  let finalPrice = Number(bars[maxIndex]?.close);

  const recordExit = (rawPrice, weight) => {
    const leg = exitLeg(side, entry, rawPrice, weight, initialRisk);
    grossR += leg.grossR;
    exitFeeR += leg.feeR;
    return leg.price;
  };

  for (let i = startIndex; i <= maxIndex; i++) {
    const c = bars[i];
    if (!c) break;

    const open = Number(c.open);
    const high = Number(c.high);
    const low = Number(c.low);
    const stopHit = side === "LONG" ? low <= activeStop : high >= activeStop;
    const stopAtOpen = side === "LONG" ? open <= activeStop : open >= activeStop;

    if (stopHit) {
      const rawStop = stopAtOpen
        ? open
        : activeStop;
      recordExit(rawStop, remaining);
      remaining = 0;
      finalReason = partialTaken
        ? "PARTIAL_TP1+TRAILING_STOP"
        : breakEvenActivated
          ? "BREAK_EVEN"
          : trailingActivated
            ? "TRAILING_STOP"
            : "STOP";
      finalTime = c.time;
      finalPrice = side === "LONG" ? rawStop * (1 - SLIPPAGE) : rawStop * (1 + SLIPPAGE);
      break;
    }

    if (isBreakout) {
      const tp1 = side === "LONG" ? entry + initialRisk * 1.5 : entry - initialRisk * 1.5;
      const tp1Hit = side === "LONG" ? high >= tp1 : low <= tp1;

      if (!partialTaken && tp1Hit) {
        recordExit(tp1, 0.5);
        remaining = 0.5;
        partialTaken = true;
        trailingActivated = true;
        // Lock +0.5R on the remaining half; applies from the next 5m candle.
        activeStop = side === "LONG"
          ? entry + initialRisk * 0.5
          : entry - initialRisk * 0.5;
        bestFavorable = tp1;
        continue;
      }

      if (partialTaken) {
        if (side === "LONG") {
          bestFavorable = Math.max(bestFavorable, high);
          activeStop = Math.max(activeStop, bestFavorable - initialRisk);
        } else {
          bestFavorable = Math.min(bestFavorable, low);
          activeStop = Math.min(activeStop, bestFavorable + initialRisk);
        }
      }
    } else {
      const targetHit = side === "LONG" ? high >= target : low <= target;
      const targetAtOpen = side === "LONG" ? open >= target : open <= target;
      if (targetHit) {
        const rawTarget = targetAtOpen ? open : target;
        recordExit(rawTarget, remaining);
        remaining = 0;
        finalReason = "TARGET";
        finalTime = c.time;
        finalPrice = side === "LONG" ? rawTarget * (1 - SLIPPAGE) : rawTarget * (1 + SLIPPAGE);
        break;
      }

      if (!breakEvenActivated) {
        const reachedOneR = side === "LONG"
          ? high >= entry + initialRisk
          : low <= entry - initialRisk;
        if (reachedOneR) {
          breakEvenActivated = true;
          activeStop = entry;
        }
      }
    }

    finalTime = c.time;
    finalPrice = Number(c.close);
  }

  if (remaining > 0) {
    const raw = Number(finalPrice);
    recordExit(raw, remaining);
  }

  const entryFeeR = FEE * entry / initialRisk;
  const netR = grossR - entryFeeR - exitFeeR;
  return {
    exitPrice: finalPrice,
    exitTime: finalTime,
    exitReason: finalReason,
    netR,
    holdHours: (finalTime - bars[startIndex].time) / HOUR,
    partialTaken,
    breakEvenActivated,
    trailingActivated
  };
}

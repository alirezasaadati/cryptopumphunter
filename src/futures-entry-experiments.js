export function entryDriftPercent(referencePrice, livePrice) {
  const reference = Number(referencePrice);
  const live = Number(livePrice);
  if (!(reference > 0) || !(live > 0) || !Number.isFinite(reference) || !Number.isFinite(live)) return null;
  return Math.abs(live - reference) / reference * 100;
}

export function passesEntryFreshness(referencePrice, livePrice, maxDriftPct = 0.20) {
  const drift = entryDriftPercent(referencePrice, livePrice);
  const max = Number(maxDriftPct);
  return drift !== null && Number.isFinite(max) && max >= 0 && drift <= max;
}

export function passesVolumeThreshold(volumeRatio, minRatio) {
  const ratio = Number(volumeRatio);
  const min = Number(minRatio);
  return Number.isFinite(ratio) && Number.isFinite(min) && ratio >= min;
}

export function isLateEntry({ side, entry, ema20, atr, maxExtensionAtr = 1.5 }) {
  const values = [Number(entry), Number(ema20), Number(atr), Number(maxExtensionAtr)];
  if (!values.every(Number.isFinite) || values[2] <= 0 || values[3] < 0) return true;
  if (side === "LONG") return values[0] - values[1] > values[2] * values[3];
  if (side === "SHORT") return values[1] - values[0] > values[2] * values[3];
  return true;
}

export function hasPullbackOrBreakout({ side, candles, ema20, atr, lookback = 20 }) {
  if (!Array.isArray(candles) || candles.length < lookback + 1) return false;
  const last = candles[candles.length - 1];
  const previous = candles.slice(-(lookback + 1), -1);
  const e20 = Number(ema20);
  const range = Number(atr);
  if (![last.open, last.high, last.low, last.close, e20, range].every(Number.isFinite) || range <= 0) return false;

  const candleRange = last.high - last.low;
  if (!(candleRange > 0)) return false;
  const bodyRatio = Math.abs(last.close - last.open) / candleRange;
  const closeLocation = (last.close - last.low) / candleRange;
  const priorHigh = Math.max(...previous.map(c => Number(c.high)));
  const priorLow = Math.min(...previous.map(c => Number(c.low)));
  if (side === "LONG") {
    const breakout = last.close > priorHigh && last.close > last.open && bodyRatio >= 0.50 && closeLocation >= 0.70;
    const pullback = last.low <= e20 + range * 0.20 && last.close > e20 && last.close > last.open;
    return breakout || pullback;
  }
  if (side === "SHORT") {
    const breakout = last.close < priorLow && last.close < last.open && bodyRatio >= 0.50 && closeLocation <= 0.30;
    const pullback = last.high >= e20 - range * 0.20 && last.close < e20 && last.close < last.open;
    return breakout || pullback;
  }
  return false;
}

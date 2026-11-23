// Independent channel-structure strategy. Research-only; not imported by the production Worker.
export const CHANNEL_CONFIG = Object.freeze({
  pivotLeft: 3,
  pivotRight: 3,
  lookback: 100,
  minTouchesPerSide: 2,
  maxSlopeDisagreementWidth: 0.35,
  minWidthAtr: 1.5,
  maxWidthAtr: 15,
  touchToleranceAtr: 0.3,
  boundaryZoneWidth: 0.2,
  breakoutBufferAtr: 0.15,
  stopBufferAtr: 0.35,
  targetR: 1.5
});

function finitePositive(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0;
}

export function calculateAtr(candles, period = 14) {
  if (!Array.isArray(candles) || candles.length < period + 1) return null;
  const ranges = [];
  for (let i = candles.length - period; i < candles.length; i++) {
    const c = candles[i], prev = candles[i - 1];
    if (!c || !prev) return null;
    const high = Number(c.high), low = Number(c.low), prevClose = Number(prev.close);
    if (![high, low, prevClose].every(Number.isFinite) || high < low) return null;
    ranges.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
  }
  return ranges.reduce((sum, n) => sum + n, 0) / ranges.length;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function pivots(candles, type, left, right) {
  const out = [];
  const key = type === "high" ? "high" : "low";
  for (let i = left; i < candles.length - right; i++) {
    const value = Number(candles[i][key]);
    if (!finitePositive(value)) continue;
    let valid = true;
    for (let j = i - left; j <= i + right; j++) {
      if (j === i) continue;
      const other = Number(candles[j][key]);
      if (type === "high" ? other > value : other < value) { valid = false; break; }
    }
    if (valid) out.push({ index: i, value });
  }
  return out;
}

function robustSlope(points) {
  const slopes = [];
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      const dx = points[j].index - points[i].index;
      if (dx) slopes.push((points[j].value - points[i].value) / dx);
    }
  }
  return median(slopes);
}

export function detectPriceChannel(candles, options = {}) {
  const cfg = { ...CHANNEL_CONFIG, ...options };
  if (!Array.isArray(candles) || candles.length < Math.max(35, cfg.pivotLeft + cfg.pivotRight + 20)) return null;
  const window = candles.slice(-cfg.lookback);
  const highPivots = pivots(window, "high", cfg.pivotLeft, cfg.pivotRight);
  const lowPivots = pivots(window, "low", cfg.pivotLeft, cfg.pivotRight);
  if (highPivots.length < cfg.minTouchesPerSide || lowPivots.length < cfg.minTouchesPerSide) return null;

  const highSlope = robustSlope(highPivots);
  const lowSlope = robustSlope(lowPivots);
  if (!Number.isFinite(highSlope) || !Number.isFinite(lowSlope)) return null;
  const slope = (highSlope + lowSlope) / 2;
  const upperIntercept = median(highPivots.map(p => p.value - slope * p.index));
  const lowerIntercept = median(lowPivots.map(p => p.value - slope * p.index));
  if (!(upperIntercept > lowerIntercept)) return null;

  const lastIndex = window.length - 1;
  const upper = upperIntercept + slope * lastIndex;
  const lower = lowerIntercept + slope * lastIndex;
  const width = upper - lower;
  const atr = calculateAtr(window, Math.min(14, window.length - 1));
  const close = Number(window.at(-1)?.close);
  if (![upper, lower, width, atr, close].every(Number.isFinite) || width <= 0 || !atr || close <= 0) return null;
  if (width / atr < cfg.minWidthAtr || width / atr > cfg.maxWidthAtr) return null;
  if (Math.abs(highSlope - lowSlope) * window.length > width * cfg.maxSlopeDisagreementWidth) return null;

  const tolerance = Math.max(atr * cfg.touchToleranceAtr, width * 0.025);
  const upperTouches = highPivots.filter(p => Math.abs(p.value - (upperIntercept + slope * p.index)) <= tolerance).length;
  const lowerTouches = lowPivots.filter(p => Math.abs(p.value - (lowerIntercept + slope * p.index)) <= tolerance).length;
  if (upperTouches < cfg.minTouchesPerSide || lowerTouches < cfg.minTouchesPerSide) return null;

  const slopePct = slope * window.length / close * 100;
  const type = slopePct > 1.5 ? "ASCENDING" : slopePct < -1.5 ? "DESCENDING" : "HORIZONTAL";
  return {
    type, slopePerBar: slope, slopePct, upper, lower, mid: (upper + lower) / 2,
    width, atr, widthAtr: width / atr, upperTouches, lowerTouches,
    startTime: window[0]?.time ?? null, endTime: window.at(-1)?.time ?? null,
    candleCount: window.length
  };
}

export function generateChannelSignal({ candles4h, candles1h, candles15m, options = {} }) {
  const cfg = { ...CHANNEL_CONFIG, ...options };
  if (!Array.isArray(candles1h) || candles1h.length < 2 || !Array.isArray(candles15m) || candles15m.length < 2) {
    return null;
  }
  const channel = detectPriceChannel(candles4h, cfg);
  if (!channel) return null;
  const h = candles1h.at(-1), prevH = candles1h.at(-2);
  const m = candles15m.at(-1), prevM = candles15m.at(-2);
  const close = Number(h.close), high = Number(h.high), low = Number(h.low);
  const mClose = Number(m.close), mOpen = Number(m.open), pmClose = Number(prevM.close);
  if (![close, high, low, mClose, mOpen, pmClose].every(Number.isFinite)) return null;

  const zone = channel.width * cfg.boundaryZoneWidth;
  const breakoutBuffer = channel.atr * cfg.breakoutBufferAtr;
  let side = null, setup = null, trigger = null, boundary = null;

  const bullishConfirm = mClose > mOpen && mClose > pmClose;
  const bearishConfirm = mClose < mOpen && mClose < pmClose;
  const priorClose = Number(prevH.close);

  if (close >= channel.lower && close <= channel.lower + zone && bullishConfirm) {
    side = "LONG"; setup = "CHANNEL_FLOOR_REVERSAL"; trigger = "15M_BULLISH_REACTION"; boundary = channel.lower;
  } else if (close <= channel.upper && close >= channel.upper - zone && bearishConfirm) {
    side = "SHORT"; setup = "CHANNEL_CEILING_REVERSAL"; trigger = "15M_BEARISH_REACTION"; boundary = channel.upper;
  } else if (close > channel.upper + breakoutBuffer && priorClose <= channel.upper + breakoutBuffer && mClose > channel.upper) {
    side = "LONG"; setup = "UPPER_CHANNEL_BREAKOUT"; trigger = "1H_CLOSE_OUTSIDE_AND_15M_CONFIRM"; boundary = channel.upper;
  } else if (close < channel.lower - breakoutBuffer && priorClose >= channel.lower - breakoutBuffer && mClose < channel.lower) {
    side = "SHORT"; setup = "LOWER_CHANNEL_BREAKOUT"; trigger = "1H_CLOSE_OUTSIDE_AND_15M_CONFIRM"; boundary = channel.lower;
  }
  if (!side) return null;

  const entryReference = close;
  const stop = side === "LONG"
    ? (setup.endsWith("REVERSAL") ? channel.lower - channel.atr * cfg.stopBufferAtr : channel.upper - channel.atr * cfg.stopBufferAtr)
    : (setup.endsWith("REVERSAL") ? channel.upper + channel.atr * cfg.stopBufferAtr : channel.lower + channel.atr * cfg.stopBufferAtr);
  const risk = side === "LONG" ? entryReference - stop : stop - entryReference;
  if (!(risk > 0) || risk / entryReference > 0.08) return null;
  const target = side === "LONG" ? entryReference + risk * cfg.targetR : entryReference - risk * cfg.targetR;
  const boundaryTarget = side === "LONG" ? channel.upper : channel.lower;
  const target1 = side === "LONG" ? Math.min(target, boundaryTarget) : Math.max(target, boundaryTarget);
  const targetR = Math.abs(target1 - entryReference) / risk;
  return {
    side, setup, trigger, channelType: channel.type, channel,
    referenceEntry: entryReference, stop, target1, risk, targetR,
    signalTime: h.time ?? null
  };
}

export function scoreChannelSignal(signal) {
  if (!signal) return 0;
  const c = signal.channel;
  let score = 0;
  score += Math.min(20, (c.upperTouches + c.lowerTouches) * 3);
  score += Math.max(0, 20 * (1 - Math.min(1, Math.min(
    Math.abs(signal.referenceEntry - c.lower), Math.abs(c.upper - signal.referenceEntry)
  ) / c.width)));
  score += signal.setup.includes("BREAKOUT") ? 12 : 15;
  score += Math.min(15, Math.max(0, (signal.targetR / 1.5) * 15));
  score += Math.min(15, c.widthAtr >= 2 && c.widthAtr <= 8 ? 15 : 8);
  return Math.max(0, Math.min(100, score));
}

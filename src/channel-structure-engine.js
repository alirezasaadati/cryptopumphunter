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
  stopBufferAtr: 0.15,
  reversalStopBufferAtr: 0.15,
  reversalTargetR: 1.5,
  breakoutTargetR: 1.5,
  volumeMultiplier: 1.5,
  volumeLookback: 20,
  rsiPeriod: 14,
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


function calculateRsiSeries(candles, period = 14) {
  if (!Array.isArray(candles) || candles.length < period + 2) return [];
  const out = Array(candles.length).fill(null);
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const change = Number(candles[i].close) - Number(candles[i - 1].close);
    gains += Math.max(0, change); losses += Math.max(0, -change);
  }
  let avgGain = gains / period, avgLoss = losses / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < candles.length; i++) {
    const change = Number(candles[i].close) - Number(candles[i - 1].close);
    avgGain = (avgGain * (period - 1) + Math.max(0, change)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(0, -change)) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

function hasRsiDivergence(candles, side, period = 14) {
  if (!Array.isArray(candles) || candles.length < 2 * (period + 4)) return false;
  const start = Math.max(0, candles.length - 50);
  const window = candles.slice(start);
  const rsi = calculateRsiSeries(window, period);
  const kind = side === "SHORT" ? "high" : "low";
  const points = pivots(window, kind, 2, 2).filter(p => Number.isFinite(rsi[p.index]));
  if (points.length < 2) return false;
  const a = points.at(-2), b = points.at(-1);
  const priceA = Number(window[a.index][kind]), priceB = Number(window[b.index][kind]);
  const rsiA = rsi[a.index], rsiB = rsi[b.index];
  return side === "SHORT"
    ? priceB > priceA && rsiB < rsiA
    : priceB < priceA && rsiB > rsiA;
}

function hasVolumeConfirmation(candles, multiplier = 1.5, lookback = 20) {
  if (!Array.isArray(candles) || candles.length < lookback + 1) return false;
  const current = Number(candles.at(-1)?.volume);
  const prior = candles.slice(-(lookback + 1), -1).map(c => Number(c.volume));
  if (!Number.isFinite(current) || prior.some(v => !Number.isFinite(v) || v < 0)) return false;
  const average = prior.reduce((sum, v) => sum + v, 0) / prior.length;
  return average > 0 && current >= average * multiplier;
}

export function generateChannelSignal({ candles4h, candles1h, candles15m, candles1d = [], mode = "BASELINE", options = {} }) {
  const cfg = { ...CHANNEL_CONFIG, ...options };
  if (!Array.isArray(candles1h) || candles1h.length < 2 || !Array.isArray(candles15m) || candles15m.length < 2) {
    return null;
  }
  const detectedChannel = detectPriceChannel(candles4h, cfg);
  if (!detectedChannel) return null;
  const h = candles1h.at(-1), prevH = candles1h.at(-2);
  const latest4h = candles4h.at(-1);
  const signalCloseTime = Number(h.time) + 60 * 60 * 1000;
  const channelAnchorTime = Number(latest4h.time) + 4 * 60 * 60 * 1000;
  const projectionBars = Math.max(0, (signalCloseTime - channelAnchorTime) / (4 * 60 * 60 * 1000));
  const upper = detectedChannel.upper + detectedChannel.slopePerBar * projectionBars;
  const lower = detectedChannel.lower + detectedChannel.slopePerBar * projectionBars;
  const channel = { ...detectedChannel, upper, lower, mid: (upper + lower) / 2 };
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
  const latest4hClosed = candles4h.at(-1);
  const fourHourAligned = side => side === "LONG"
    ? Number(latest4hClosed?.close) > Number(latest4hClosed?.open)
    : Number(latest4hClosed?.close) < Number(latest4hClosed?.open);

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
  const isBreakoutSetup = setup.includes("BREAKOUT");
  const fourHourConfirmed = fourHourAligned(side);
  if (mode === "A" && isBreakoutSetup && !fourHourConfirmed) return null;

  const entryReference = close;
  const isReversal = setup.endsWith("REVERSAL");
  const stopBuffer = channel.atr * (isReversal ? cfg.reversalStopBufferAtr : cfg.stopBufferAtr);
  const stop = side === "LONG"
    ? (isReversal ? channel.lower - stopBuffer : channel.upper - stopBuffer)
    : (isReversal ? channel.upper + stopBuffer : channel.lower + stopBuffer);
  const risk = side === "LONG" ? entryReference - stop : stop - entryReference;
  if (!(risk > 0)) return null;
  const desiredTargetR = isReversal ? cfg.reversalTargetR : cfg.breakoutTargetR;
  const target = side === "LONG" ? entryReference + risk * desiredTargetR : entryReference - risk * desiredTargetR;
  const target1 = isReversal
    ? (side === "LONG" ? Math.min(target, channel.upper) : Math.max(target, channel.lower))
    : target;
  const targetR = Math.abs(target1 - entryReference) / risk;
  const dailyChannel = Array.isArray(candles1d) && candles1d.length >= 35
    ? detectPriceChannel(candles1d, cfg) : null;
  const oneHourTrendUp = candles1h.length >= 21 &&
    Number(candles1h.at(-1).close) > Number(candles1h.at(-21).close);
  const oneHourTrendDown = candles1h.length >= 21 &&
    Number(candles1h.at(-1).close) < Number(candles1h.at(-21).close);
  const fifteenAligned = side === "LONG" ? bullishConfirm : bearishConfirm;
  const channelAligned = side === "LONG" ? channel.type === "ASCENDING" : channel.type === "DESCENDING";
  const trendAligned = side === "LONG" ? oneHourTrendUp : oneHourTrendDown;
  const multiTimeframeAligned = channelAligned && trendAligned && fifteenAligned;
  let dailyPositionMultiplier = 1;
  let dailyContext = "NEUTRAL";
  if (dailyChannel) {
    const nearDailySupport = close <= dailyChannel.lower + dailyChannel.width * 0.2;
    const nearDailyResistance = close >= dailyChannel.upper - dailyChannel.width * 0.2;
    const dailyTrendAligned = side === "LONG" ? dailyChannel.type === "ASCENDING" : dailyChannel.type === "DESCENDING";
    if ((side === "SHORT" && nearDailySupport) || (side === "LONG" && nearDailyResistance)) {
      dailyPositionMultiplier = 0.5;
      dailyContext = side === "SHORT" ? "SHORT_NEAR_DAILY_SUPPORT" : "LONG_NEAR_DAILY_RESISTANCE";
    } else if (dailyTrendAligned) {
      dailyPositionMultiplier = 1.5;
      dailyContext = "DAILY_CHANNEL_ALIGNED";
    }
  }
  return {
    side, setup, trigger, channelType: channel.type, channel,
    referenceEntry: entryReference, stop, target1, risk, targetR,
    volumeConfirmed: hasVolumeConfirmation(candles1h, cfg.volumeMultiplier, cfg.volumeLookback),
    rsiDivergence: isReversal && hasRsiDivergence(candles1h, side, cfg.rsiPeriod),
    mode, fourHourConfirmed, multiTimeframeAligned, dailyChannel, dailyPositionMultiplier, dailyContext,
    riskPct: risk / entryReference,
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
  if (signal.volumeConfirmed) score += 15;
  if (signal.rsiDivergence) score += 10;
  if (signal.mode === "B" && signal.fourHourConfirmed) score += 20;
  if (signal.mode === "B" && signal.multiTimeframeAligned) score += 25;
  return Math.max(0, Math.min(150, score));
}

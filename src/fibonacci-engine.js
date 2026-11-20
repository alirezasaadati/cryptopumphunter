// Fibonacci 0.618 pullback engine — isolated prototype.
// Inputs must contain CLOSED candles in chronological order.
// 4H: trend filter (EMA 50/200); 1H: swing/Fibonacci and hidden divergence;
// 15m: touch -> reaction -> pullback confirmation and entry.
export const FIB_CONFIG = Object.freeze({
  TREND_FAST_EMA: 50,
  TREND_SLOW_EMA: 200,
  PIVOT_LEFT: 3,
  PIVOT_RIGHT: 3,
  MIN_4H_CANDLES: 205,
  MIN_1H_CANDLES: 80,
  MIN_15M_CANDLES: 30,
  MIN_IMPULSE_PCT: 0.01,
  LEVEL_TOLERANCE_PCT: 0.0015,
  REACTION_DISTANCE_PCT: 0.001,
  SETUP_EXPIRY_15M: 24,
  ATR_PERIOD: 14,
  STOP_ATR_BUFFER: 0.2,
  TARGET_R_MULTIPLES: Object.freeze([1.5, 2.2, 3])
});

function validCandles(candles, minLength) {
  return Array.isArray(candles) && candles.length >= minLength &&
    candles.every((c, i) => Number.isFinite(c.open) && Number.isFinite(c.high) &&
      Number.isFinite(c.low) && Number.isFinite(c.close) && c.low > 0 &&
      c.high >= c.low && c.high >= Math.max(c.open, c.close) &&
      c.low <= Math.min(c.open, c.close) &&
      (i === 0 || c.time > candles[i - 1].time));
}

export function ema(values, period) {
  if (!Array.isArray(values) || values.length < period) return null;
  const alpha = 2 / (period + 1);
  let value = values.slice(0, period).reduce((sum, x) => sum + x, 0) / period;
  for (let i = period; i < values.length; i++) value = values[i] * alpha + value * (1 - alpha);
  return value;
}

function emaSeries(values, period) {
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;
  const alpha = 2 / (period + 1);
  let value = values.slice(0, period).reduce((sum, x) => sum + x, 0) / period;
  out[period - 1] = value;
  for (let i = period; i < values.length; i++) {
    value = values[i] * alpha + value * (1 - alpha);
    out[i] = value;
  }
  return out;
}

export function calculateRsiSeries(closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  if (closes.length <= period) return out;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const change = closes[i] - closes[i - 1];
    gain += Math.max(change, 0);
    loss += Math.max(-change, 0);
  }
  let avgGain = gain / period, avgLoss = loss / period;
  const value = () => avgLoss === 0 ? 100 : avgGain === 0 ? 0 : 100 - 100 / (1 + avgGain / avgLoss);
  out[period] = value();
  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(change, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-change, 0)) / period;
    out[i] = value();
  }
  return out;
}

export function calculateMacdHistogramSeries(closes) {
  const fast = emaSeries(closes, 12);
  const slow = emaSeries(closes, 26);
  const macd = closes.map((_, i) => fast[i] === null || slow[i] === null ? null : fast[i] - slow[i]);
  const validMacd = macd.filter(Number.isFinite);
  const signalValid = emaSeries(validMacd, 9);
  let j = 0;
  return macd.map(value => {
    if (value === null) return null;
    const signal = signalValid[j++];
    return signal === null ? null : value - signal;
  });
}

export function calculateAwesomeOscillator(candles) {
  const median = candles.map(c => (c.high + c.low) / 2);
  const out = new Array(candles.length).fill(null);
  for (let i = 33; i < candles.length; i++) {
    const sma5 = median.slice(i - 4, i + 1).reduce((a, b) => a + b, 0) / 5;
    const sma34 = median.slice(i - 33, i + 1).reduce((a, b) => a + b, 0) / 34;
    out[i] = sma5 - sma34;
  }
  return out;
}

export function findConfirmedPivots(candles, type, left = FIB_CONFIG.PIVOT_LEFT, right = FIB_CONFIG.PIVOT_RIGHT) {
  const pivots = [];
  for (let i = left; i < candles.length - right; i++) {
    const value = type === "low" ? candles[i].low : candles[i].high;
    let confirmed = true;
    for (let k = i - left; k <= i + right; k++) {
      if (k === i) continue;
      if (type === "low" ? candles[k].low <= value : candles[k].high >= value) {
        confirmed = false;
        break;
      }
    }
    if (confirmed) pivots.push({ index: i, time: candles[i].time, price: value });
  }
  return pivots;
}

function getTrend(candles4h) {
  const closes = candles4h.map(c => c.close);
  const fast = ema(closes, FIB_CONFIG.TREND_FAST_EMA);
  const slow = ema(closes, FIB_CONFIG.TREND_SLOW_EMA);
  if (fast === null || slow === null) return { direction: "NEUTRAL", fast, slow };
  if (fast > slow && closes.at(-1) > fast) return { direction: "BULLISH", fast, slow };
  if (fast < slow && closes.at(-1) < fast) return { direction: "BEARISH", fast, slow };
  return { direction: "NEUTRAL", fast, slow };
}

function selectImpulse(candles, direction, ao) {
  const highs = findConfirmedPivots(candles, "high");
  const lows = findConfirmedPivots(candles, "low");
  if (direction === "BULLISH") {
    for (let h = highs.length - 1; h >= 0; h--) {
      const high = highs[h];
      const low = [...lows].reverse().find(p => p.index < high.index);
      if (!low || high.price <= low.price) continue;
      const impulsePct = (high.price - low.price) / low.price;
      if (impulsePct < FIB_CONFIG.MIN_IMPULSE_PCT || !(ao[high.index] > 0)) continue;
      return { low, high, impulsePct };
    }
  } else if (direction === "BEARISH") {
    for (let l = lows.length - 1; l >= 0; l--) {
      const low = lows[l];
      const high = [...highs].reverse().find(p => p.index < low.index);
      if (!high || high.price <= low.price) continue;
      const impulsePct = (high.price - low.price) / high.price;
      if (impulsePct < FIB_CONFIG.MIN_IMPULSE_PCT || !(ao[low.index] < 0)) continue;
      return { low, high, impulsePct };
    }
  }
  return null;
}

function detectHiddenDivergence(candles, direction) {
  const closes = candles.map(c => c.close);
  const rsi = calculateRsiSeries(closes);
  const macd = calculateMacdHistogramSeries(closes);
  const type = direction === "BULLISH" ? "low" : "high";
  const pivots = findConfirmedPivots(candles, type);
  if (pivots.length < 2) return { confirmed: false, reason: "برای مقایسه واگرایی دو پیوت تأییدشده کافی نیست." };
  const [previous, latest] = pivots.slice(-2);
  const values = [rsi[previous.index], rsi[latest.index], macd[previous.index], macd[latest.index]];
  if (values.some(v => !Number.isFinite(v))) return { confirmed: false, reason: "داده اندیکاتورها برای واگرایی کافی نیست." };
  const confirmed = direction === "BULLISH"
    ? latest.price > previous.price && rsi[latest.index] < rsi[previous.index] && macd[latest.index] < macd[previous.index]
    : latest.price < previous.price && rsi[latest.index] > rsi[previous.index] && macd[latest.index] > macd[previous.index];
  return {
    confirmed, type: direction === "BULLISH" ? "HIDDEN_BULLISH" : "HIDDEN_BEARISH",
    previousPivot: previous, latestPivot: latest,
    rsiPrevious: rsi[previous.index], rsiLatest: rsi[latest.index],
    macdPrevious: macd[previous.index], macdLatest: macd[latest.index],
    reason: confirmed ? "واگرایی مخفی هم‌جهت با روند در MACD و RSI تأیید شد." : "واگرایی مخفی هم‌زمان MACD و RSI تأیید نشد."
  };
}

function findPullbackEntry(candles15m, direction, level) {
  const cfg = FIB_CONFIG;
  const start = Math.max(1, candles15m.length - cfg.SETUP_EXPIRY_15M - 2);
  let phase = "WAIT_TOUCH";
  let touchIndex = -1, reactionIndex = -1;
  const tolerance = level * cfg.LEVEL_TOLERANCE_PCT;
  for (let i = start; i < candles15m.length; i++) {
    const c = candles15m[i], prev = candles15m[i - 1];
    const touches = c.low <= level + tolerance && c.high >= level - tolerance;
    if (phase === "WAIT_TOUCH") {
      const approached = direction === "BULLISH" ? prev.close > level : prev.close < level;
      if (touches && approached) { phase = "WAIT_REACTION"; touchIndex = i; }
      continue;
    }
    if (phase === "WAIT_REACTION") {
      const reacted = direction === "BULLISH"
        ? c.close > level * (1 + cfg.REACTION_DISTANCE_PCT) && c.close > c.open
        : c.close < level * (1 - cfg.REACTION_DISTANCE_PCT) && c.close < c.open;
      if (reacted) { phase = "WAIT_PULLBACK"; reactionIndex = i; }
      else if (direction === "BULLISH" ? c.close < level - tolerance : c.close > level + tolerance) {
        phase = "WAIT_TOUCH"; touchIndex = -1;
      }
      continue;
    }
    if (phase === "WAIT_PULLBACK") {
      if (i <= reactionIndex) continue;
      const retest = c.low <= level + tolerance && c.high >= level - tolerance;
      const confirmed = direction === "BULLISH"
        ? retest && c.close > level && c.close > c.open
        : retest && c.close < level && c.close < c.open;
      if (confirmed && i === candles15m.length - 1) {
        return { confirmed: true, entry: c.close, candle: c, touchIndex, reactionIndex, entryIndex: i, phase: "ENTRY_CONFIRMED" };
      }
      if (direction === "BULLISH" ? c.close < level - tolerance : c.close > level + tolerance) {
        phase = "WAIT_TOUCH"; touchIndex = -1; reactionIndex = -1;
      }
    }
  }
  return { confirmed: false, phase, touchIndex, reactionIndex, reason: phase === "WAIT_PULLBACK" ? "واکنش دیده شده؛ هنوز پولبک و کندل تأییدی کامل نشده است." : phase === "WAIT_REACTION" ? "سطح لمس شده؛ منتظر واکنش قیمت هستیم." : "هنوز برخورد معتبر به سطح 0.618 ثبت نشده است." };
}

function calculateAtr(candles, period = FIB_CONFIG.ATR_PERIOD) {
  if (candles.length <= period) return null;
  const ranges = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], prev = candles[i - 1];
    ranges.push(Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close)));
  }
  const tail = ranges.slice(-period);
  return tail.reduce((a, b) => a + b, 0) / tail.length;
}

function buildTrade(direction, entry, entryCandle, atr) {
  const buffer = atr * FIB_CONFIG.STOP_ATR_BUFFER;
  const stop = direction === "BULLISH" ? entryCandle.low - buffer : entryCandle.high + buffer;
  const risk = direction === "BULLISH" ? entry - stop : stop - entry;
  if (!Number.isFinite(risk) || risk <= 0) return { valid: false, reason: "حد ضرر معتبر محاسبه نشد." };
  const targets = FIB_CONFIG.TARGET_R_MULTIPLES.map(r => ({
    r, price: direction === "BULLISH" ? entry + risk * r : entry - risk * r
  }));
  return { valid: true, side: direction === "BULLISH" ? "LONG" : "SHORT", entry, stop, risk, targets };
}

export function analyzeFibonacciSetup({ fourHour, oneHour, fifteenMin }) {
  if (!validCandles(fourHour, FIB_CONFIG.MIN_4H_CANDLES) ||
      !validCandles(oneHour, FIB_CONFIG.MIN_1H_CANDLES) ||
      !validCandles(fifteenMin, FIB_CONFIG.MIN_15M_CANDLES)) {
    return { status: "INVALID_DATA", signal: null, reason: "تعداد، ترتیب یا ساختار کندل‌های بسته‌شده کافی/معتبر نیست." };
  }
  const trend = getTrend(fourHour);
  if (trend.direction === "NEUTRAL") return { status: "NO_TREND", signal: null, trend, reason: "فیلتر روند 4H جهت مشخصی ندارد." };

  const ao = calculateAwesomeOscillator(oneHour);
  const impulse = selectImpulse(oneHour, trend.direction, ao);
  if (!impulse) return { status: "NO_FIB_SWING", signal: null, trend, reason: "موج معتبر هم‌جهت با روند با تأیید Awesome Oscillator پیدا نشد." };

  const divergence = detectHiddenDivergence(oneHour, trend.direction);
  if (!divergence.confirmed) return { status: "NO_DIVERGENCE", signal: null, trend, impulse, divergence, reason: divergence.reason };

  // The displayed anchor order follows the requested convention:
  // LONG: high -> low; SHORT: low -> high. The 0.618 retracement is
  // calculated from the end of the impulse back toward its start.
  const range = impulse.high.price - impulse.low.price;
  const level = trend.direction === "BULLISH"
    ? impulse.high.price - range * 0.618
    : impulse.low.price + range * 0.618;

  const entryCheck = findPullbackEntry(fifteenMin, trend.direction, level);
  if (!entryCheck.confirmed) {
    return { status: "WAITING_FOR_ENTRY", signal: null, trend, impulse, divergence, fibonacci: {
      level, ratio: 0.618,
      anchors: trend.direction === "BULLISH"
        ? [{ type: "HIGH", price: impulse.high.price }, { type: "LOW", price: impulse.low.price }]
        : [{ type: "LOW", price: impulse.low.price }, { type: "HIGH", price: impulse.high.price }]
    }, entryCheck, reason: entryCheck.reason };
  }

  const atr = calculateAtr(fifteenMin);
  if (!Number.isFinite(atr) || atr <= 0) return { status: "INVALID_ATR", signal: null, reason: "ATR برای محاسبه حاشیه حد ضرر معتبر نیست." };
  const trade = buildTrade(trend.direction, entryCheck.entry, entryCheck.candle, atr);
  if (!trade.valid) return { status: "INVALID_STOP", signal: null, reason: trade.reason };
  return {
    status: "SIGNAL", signal: {
      ...trade, trend: trend.direction, fibonacciLevel: level,
      fibonacciRatio: 0.618, divergence: divergence.type,
      touchTime: fifteenMin[entryCheck.touchIndex].time,
      reactionTime: fifteenMin[entryCheck.reactionIndex].time,
      entryTime: fifteenMin[entryCheck.entryIndex].time
    },
    trend, impulse, divergence, entryCheck,
    fibonacci: { level, ratio: 0.618 }
  };
}

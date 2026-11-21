// Isolated copy of the LONG-relevant strategy logic supplied by the user as v6.0.0.
// No strategy thresholds, indicators, conditions, entry, stop or targets are modified.

const FUTURES_CONFIG = {
  MIN_CANDLES: 60,
  MIN_SCORE: 70,
  MIN_SCORE_LONG: 70,
  MAX_ENTRY_DRIFT_PCT: 0.5,
  STOP_ATR_BUFFER: 0.5,
  TARGET_1_R: 1.5,
  TARGET_2_R: 2.5,
  TARGET_3_R: 4.0
};

function ema(values, period) {
  if (values.length < period) return null;
  const multiplier = 2 / (period + 1);
  let value = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) {
    value = values[i] * multiplier + value * (1 - multiplier);
  }
  return value;
}

function rsi(values, period = 14) {
  if (values.length <= period) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const change = values[i] - values[i - 1];
    gains += Math.max(change, 0);
    losses += Math.max(-change, 0);
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  for (let i = period + 1; i < values.length; i++) {
    const change = values[i] - values[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(change, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-change, 0)) / period;
  }
  if (avgLoss === 0) return 100;
  if (avgGain === 0) return 0;
  return 100 - 100 / (1 + (avgGain / avgLoss));
}

function average(values) {
  if (!values.length) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function calculateAtr(candles, period = 14) {
  if (candles.length <= period) return null;
  const ranges = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const prevClose = candles[i - 1].close;
    ranges.push(Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose)));
  }
  const recent = ranges.slice(-period);
  return recent.length === period ? average(recent) : null;
}

function findPivots(candles, left = 2, right = 2) {
  const highs = [];
  const lows = [];
  for (let i = left; i < candles.length - right; i++) {
    let isHigh = true;
    let isLow = true;
    for (let j = i - left; j <= i + right; j++) {
      if (i === j) continue;
      if (candles[j].high >= candles[i].high) isHigh = false;
      if (candles[j].low <= candles[i].low) isLow = false;
    }
    if (isHigh) highs.push({ index: i, price: candles[i].high, time: candles[i].time });
    if (isLow) lows.push({ index: i, price: candles[i].low, time: candles[i].time });
  }
  return { highs, lows };
}

function detectTrendStructure(candles4h) {
  const { highs, lows } = findPivots(candles4h, 3, 3);
  if (highs.length < 2 || lows.length < 2) return { uptrend: false, downtrend: false };
  const lastHigh = highs[highs.length - 1].price;
  const prevHigh = highs[highs.length - 2].price;
  const lastLow = lows[lows.length - 1].price;
  const prevLow = lows[lows.length - 2].price;
  const uptrend = (lastHigh > prevHigh) && (lastLow > prevLow);
  const downtrend = (lastHigh < prevHigh) && (lastLow < prevLow);
  return { uptrend, downtrend, lastHigh, prevHigh, lastLow, prevLow };
}

function detectMSS15m(candles15m) {
  const { highs } = findPivots(candles15m, 1, 1);
  if (highs.length < 1) return false;
  const lastHigh = highs[highs.length - 1];
  const currentClose = candles15m[candles15m.length - 1].close;
  return currentClose > lastHigh.price;
}

function evaluateEntryFilters({ ticker, candles15m, side, referencePrice, ema20, atr }) {
  const marketPrice = Number(ticker?.last);
  if (!Number.isFinite(marketPrice) || marketPrice <= 0) return { ok: false, rejected: "قیمت لحظه‌ای نامعتبر" };
  const driftPct = Math.abs(marketPrice - referencePrice) / referencePrice * 100;
  if (driftPct > FUTURES_CONFIG.MAX_ENTRY_DRIFT_PCT) {
    return { ok: false, rejected: "فاصله قیمت لحظه‌ای تا تحلیلی زیاد است", driftPct };
  }
  if (candles15m.length < 30) return { ok: false, rejected: "کندل‌های ۱۵ دقیقه کافی نیست" };
  const closes15m = candles15m.map(c => c.close);
  const ema9 = ema(closes15m, 9);
  const ema21 = ema(closes15m, 21);
  const last15m = candles15m[candles15m.length - 1];
  const aligned = side === "LONG"
    ? (last15m.close > ema9 && ema9 > ema21)
    : (last15m.close < ema9 && ema9 < ema21);
  if (!aligned) return { ok: false, rejected: "مومنتوم ۱۵ دقیقه هم‌راستا نیست" };
  const mss = side === "LONG" ? detectMSS15m(candles15m) : false;
  if (!mss) return { ok: false, rejected: "شکست ساختار خرد (MSS) در ۱۵ دقیقه رخ نداده است" };
  const body = Math.abs(last15m.close - last15m.open);
  const candleRange = last15m.high - last15m.low;
  const isStrongCandle = candleRange > 0 && (body / candleRange > 0.6);
  const isCorrectColor = side === "LONG" ? (last15m.close > last15m.open) : (last15m.close < last15m.open);
  if (!isStrongCandle || !isCorrectColor) return { ok: false, rejected: "کندل تأییدی ۱۵ دقیقه ضعیف است" };
  return { ok: true, driftPct };
}

function analyzeFuturesSymbol(ticker, candles1h, candles4h, candles15m, options = {}) {
  if (candles1h.length < FUTURES_CONFIG.MIN_CANDLES || candles4h.length < FUTURES_CONFIG.MIN_CANDLES) {
    throw new Error("کندل‌های کافی نیست.");
  }
  const closes1h = candles1h.map(c => c.close);
  const last1h = candles1h[candles1h.length - 1];
  const referencePrice = last1h.close;
  const e20 = ema(closes1h, 20);
  const e50 = ema(closes1h, 50);
  const rsiValue = rsi(closes1h, 14);
  const atr = calculateAtr(candles1h, 14);
  if ([e20, e50, rsiValue, atr].some(v => !Number.isFinite(v)) || atr <= 0) {
    throw new Error("اندیکاتورها معتبر نیستند.");
  }
  const structure4h = detectTrendStructure(candles4h);
  const up1h = e20 > e50 && referencePrice > e20;
  const down1h = e20 < e50 && referencePrice < e20;
  const strictLong = structure4h.uptrend && up1h && rsiValue >= 40 && rsiValue <= 75;
  const strictShort = structure4h.downtrend && down1h && rsiValue >= 25 && rsiValue <= 60;
  let side = null;
  if (strictLong) side = "LONG";
  else if (strictShort) side = "SHORT";
  if (!side) return { symbol: ticker.symbol, rejected: "ساختار روند ۴ ساعته تأیید نشد" };
  let score = 50;
  if (rsiValue > 50 && rsiValue < 70) score += 15;
  if (last1h.volume > average(candles1h.slice(-20).map(c => c.volume))) score += 15;
  if (score < (side === "LONG" ? FUTURES_CONFIG.MIN_SCORE_LONG : FUTURES_CONFIG.MIN_SCORE)) {
    return { symbol: ticker.symbol, side, rejected: "امتیاز کافی نیست" };
  }
  const entryFilters = options.skipEntryFilters ? { ok: true } : evaluateEntryFilters({
    ticker, candles15m, side, referencePrice, ema20: e20, atr
  });
  if (!entryFilters.ok) {
    return { symbol: ticker.symbol, side, score, rejected: entryFilters.rejected };
  }
  const entry = options.skipEntryFilters ? referencePrice : Number(ticker.last);
  const { lows: lows1h } = findPivots(candles1h, 3, 3);
  const lastStructuralLow = lows1h.length > 0 ? lows1h[lows1h.length - 1].price : entry - (atr * 1.5);
  let stop = side === "LONG"
    ? Math.max(lastStructuralLow - (atr * FUTURES_CONFIG.STOP_ATR_BUFFER), entry - (atr * 2.0))
    : entry + (atr * 1.5);
  const risk = side === "LONG" ? entry - stop : stop - entry;
  if (risk <= 0) return { symbol: ticker.symbol, side, rejected: "استاپ نامعتبر" };
  const direction = side === "LONG" ? 1 : -1;
  const target1 = entry + direction * risk * FUTURES_CONFIG.TARGET_1_R;
  const target2 = entry + direction * risk * FUTURES_CONFIG.TARGET_2_R;
  const target3 = entry + direction * risk * FUTURES_CONFIG.TARGET_3_R;
  return {
    symbol: ticker.symbol, side, score, entry, stop, target1, target2, target3, risk, atr,
    rsi: rsiValue, eligible: true,
    management: { moveToBreakevenAt: target1, trailingActivateAt: target2, trailingAtrMultiplier: 1.5 }
  };
}

export { analyzeFuturesSymbol };

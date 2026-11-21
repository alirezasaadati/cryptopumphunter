// Isolated LONG-only extraction of the user-supplied v6.3.0 logic.
// No strategy rules or thresholds changed. Test harness supplies only closed historical candles.

const FUTURES_CONFIG = {
  MIN_CANDLES: 60,
  MIN_SCORE: 65,
  TARGET_1_R: 1.5,
  TARGET_2_R: 2.5,
  TARGET_3_R: 4.0,
  STOP_BUFFER_ATR: 0.2,
  MAX_RISK_PCT: 2.5,
  MAX_ENTRY_DRIFT_PCT: 0.5
};

function ema(values, period) {
  if (values.length < period) return null;
  const multiplier = 2 / (period + 1);
  let value = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) value = values[i] * multiplier + value * (1 - multiplier);
  return value;
}
function average(values) {
  if (!values.length) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}
function calculateAtr(candles, period = 14) {
  if (candles.length <= period) return null;
  const ranges = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], prevClose = candles[i - 1].close;
    ranges.push(Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose)));
  }
  const recent = ranges.slice(-period);
  return recent.length === period ? average(recent) : null;
}
function findPivots(candles, left = 2, right = 2) {
  const highs = [], lows = [];
  for (let i = left; i < candles.length - right; i++) {
    let isHigh = true, isLow = true;
    for (let j = i - left; j <= i + right; j++) {
      if (i === j) continue;
      if (candles[j].high >= candles[i].high) isHigh = false;
      if (candles[j].low <= candles[i].low) isLow = false;
    }
    if (isHigh) highs.push({ index: i, price: candles[i].high });
    if (isLow) lows.push({ index: i, price: candles[i].low });
  }
  return { highs, lows };
}
function detectTrendStructure(candles4h) {
  const { highs, lows } = findPivots(candles4h, 3, 3);
  if (highs.length < 2 || lows.length < 2) return false;
  const lastHigh = highs[highs.length - 1].price, prevHigh = highs[highs.length - 2].price;
  const lastLow = lows[lows.length - 1].price, prevLow = lows[lows.length - 2].price;
  return lastHigh > prevHigh && lastLow > prevLow;
}
function isBtcMacroBullish(btcCandles4h) {
  if (!btcCandles4h || btcCandles4h.length < 60) return false;
  const closes = btcCandles4h.map(c => c.close);
  const currentClose = closes[closes.length - 1];
  const ema50 = ema(closes, 50);
  const ema50_past = ema(closes.slice(0, -10), 50);
  if (!ema50 || !ema50_past) return false;
  return currentClose > ema50 && ema50 > ema50_past;
}
function evaluateEntryFilters({ ticker, referencePrice }) {
  const marketPrice = Number(ticker?.last);
  if (!Number.isFinite(marketPrice) || marketPrice <= 0) return { ok: false, rejected: "قیمت نامعتبر" };
  const driftPct = Math.abs(marketPrice - referencePrice) / referencePrice * 100;
  if (driftPct > FUTURES_CONFIG.MAX_ENTRY_DRIFT_PCT) {
    return { ok: false, rejected: `فاصله قیمت (${driftPct.toFixed(2)}%) از قیمت تحلیلی زیاد است` };
  }
  return { ok: true };
}
function analyzeFuturesSymbol(ticker, candles1h, candles4h, btcCandles4h, options = {}) {
  if (candles1h.length < 60 || candles4h.length < 60) throw new Error("کندل کافی نیست.");
  if (!options.skipBtcFilter && !isBtcMacroBullish(btcCandles4h)) {
    return { symbol: ticker.symbol, rejected: "فیلتر BTC: بازار ماکرو در حالت صعودی نیست" };
  }
  const closes1h = candles1h.map(c => c.close);
  const last1h = candles1h[candles1h.length - 1], referencePrice = last1h.close;
  const e20 = ema(closes1h, 20), e50 = ema(closes1h, 50), atr = calculateAtr(candles1h, 14);
  if ([e20, e50, atr].some(v => !Number.isFinite(v)) || atr <= 0) throw new Error("اندیکاتورها نامعتبرند.");
  const isUptrend4h = detectTrendStructure(candles4h);
  const isUptrend1h = e20 > e50 && referencePrice > e20;
  if (!isUptrend4h || !isUptrend1h) {
    return { symbol: ticker.symbol, rejected: "ساختار روند ۴ ساعته یا ۱ ساعته برای لانگ تایید نشد." };
  }
  let score = 60;
  if (last1h.volume > average(candles1h.slice(-20).map(c => c.volume))) score += 15;
  if (referencePrice > e20 && e20 > e50) score += 10;
  if (score < FUTURES_CONFIG.MIN_SCORE) return { symbol: ticker.symbol, side: "LONG", rejected: "امتیاز کافی نیست." };
  const entryFilters = options.skipEntryFilters ? { ok: true } : evaluateEntryFilters({
    ticker, candles1h, side: "LONG", referencePrice
  });
  if (!entryFilters.ok) return { symbol: ticker.symbol, side: "LONG", rejected: entryFilters.rejected };
  const entry = options.skipEntryFilters ? referencePrice : Number(ticker.last);
  const { lows: lows1h } = findPivots(candles1h, 3, 3);
  const validLows = lows1h.filter(l => l.price < entry).sort((a, b) => b.price - a.price);
  const structuralLow = validLows.length > 0 ? validLows[0].price : entry - atr;
  const stop = structuralLow - atr * FUTURES_CONFIG.STOP_BUFFER_ATR;
  const risk = entry - stop, riskPct = risk / entry * 100;
  if (risk <= 0 || riskPct > FUTURES_CONFIG.MAX_RISK_PCT) {
    return { symbol: ticker.symbol, side: "LONG", rejected: `ریسک استاپ (${riskPct.toFixed(2)}%) بیش از حد مجاز است.` };
  }
  return {
    symbol: ticker.symbol, side: "LONG", score, entry, stop,
    target1: entry + risk * FUTURES_CONFIG.TARGET_1_R,
    target2: entry + risk * FUTURES_CONFIG.TARGET_2_R,
    target3: entry + risk * FUTURES_CONFIG.TARGET_3_R,
    risk, riskPct, eligible: true,
    management: { moveToBreakevenAt: entry + risk * FUTURES_CONFIG.TARGET_1_R,
      trailingActivateAt: entry + risk * FUTURES_CONFIG.TARGET_2_R }
  };
}
export { analyzeFuturesSymbol, isBtcMacroBullish };

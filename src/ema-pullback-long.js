// Experimental LONG engine: faithful JS port of the user's optimized long_engine.py.
// This file is isolated on experimental/ema-pullback-long-balanced-v3.
// No production or SHORT engine code is changed.
export const EMA_PULLBACK_LONG_VERSION = "3.0.0-balanced-pullback";

const finite = v => Number.isFinite(Number(v));
const num = v => finite(v) ? Number(v) : null;

function ema(values, length) {
  const out = Array(values.length).fill(null);
  if (values.length < length) return out;
  let value = values.slice(0, length).reduce((a, b) => a + b, 0) / length;
  out[length - 1] = value;
  const alpha = 2 / (length + 1);
  for (let i = length; i < values.length; i++) {
    value = values[i] * alpha + value * (1 - alpha);
    out[i] = value;
  }
  return out;
}
function rma(values, length) {
  const out = Array(values.length).fill(null);
  let seed = [], value = null;
  for (let i = 0; i < values.length; i++) {
    const x = values[i];
    if (x === null || !Number.isFinite(x)) { seed = []; value = null; continue; }
    if (value === null) {
      seed.push(x);
      if (seed.length === length) {
        value = seed.reduce((a, b) => a + b, 0) / length;
        out[i] = value;
      }
    } else {
      value = (value * (length - 1) + x) / length;
      out[i] = value;
    }
  }
  return out;
}
function rsi(values, length) {
  const gains = Array(values.length).fill(null), losses = Array(values.length).fill(null);
  for (let i = 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    gains[i] = Math.max(d, 0); losses[i] = Math.max(-d, 0);
  }
  const avgGain = rma(gains, length), avgLoss = rma(losses, length);
  return values.map((_, i) => avgGain[i] === null || avgLoss[i] === null
    ? null : avgLoss[i] === 0 ? 100 : 100 - 100 / (1 + avgGain[i] / avgLoss[i]));
}
function rollingMean(values, length) {
  const out = Array(values.length).fill(null);
  for (let i = length - 1; i < values.length; i++) {
    const window = values.slice(i - length + 1, i + 1);
    if (window.every(Number.isFinite)) out[i] = window.reduce((a, b) => a + b, 0) / length;
  }
  return out;
}
function computeIndicators(candles, cfg) {
  const close = candles.map(x => num(x.close));
  const high = candles.map(x => num(x.high));
  const low = candles.map(x => num(x.low));
  const volume = candles.map(x => num(x.volume));
  const emaFast = ema(close, cfg.emaFast);
  const emaMid = ema(close, cfg.emaMid);
  const emaSlow = ema(close, cfg.emaSlow);
  const emaTrend = ema(close, cfg.emaTrend);

  const tr = Array(close.length).fill(null);
  const plusDm = Array(close.length).fill(null);
  const minusDm = Array(close.length).fill(null);
  for (let i = 1; i < close.length; i++) {
    tr[i] = Math.max(high[i] - low[i], Math.abs(high[i] - close[i - 1]), Math.abs(low[i] - close[i - 1]));
    const up = high[i] - high[i - 1], down = low[i - 1] - low[i];
    plusDm[i] = up > down && up > 0 ? up : 0;
    minusDm[i] = down > up && down > 0 ? down : 0;
  }
  // pandas_ta ADX: Wilder/RMA smoothed directional movement and true range.
  const adxTr = rma(tr, cfg.adxLen);
  const plusSmoothed = rma(plusDm, cfg.adxLen);
  const minusSmoothed = rma(minusDm, cfg.adxLen);
  const dmp = adxTr.map((x, i) => x && plusSmoothed[i] !== null ? plusSmoothed[i] / x * 100 : null);
  const dmn = adxTr.map((x, i) => x && minusSmoothed[i] !== null ? minusSmoothed[i] / x * 100 : null);
  const dx = dmp.map((x, i) => x === null || dmn[i] === null || x + dmn[i] === 0
    ? null : Math.abs(x - dmn[i]) / (x + dmn[i]) * 100);
  const adx = rma(dx, cfg.adxLen);

  const atrTr = Array(close.length).fill(null);
  for (let i = 1; i < close.length; i++) {
    atrTr[i] = Math.max(high[i] - low[i], Math.abs(high[i] - close[i - 1]), Math.abs(low[i] - close[i - 1]));
  }
  const atr = rma(atrTr, cfg.atrLen);
  const rsiValues = rsi(close, cfg.rsiLen);
  const volMa = rollingMean(volume, cfg.volMaLen);
  const emaMidPrev5 = Array(close.length).fill(null);
  for (let i = 5; i < close.length; i++) emaMidPrev5[i] = emaMid[i - 5];

  return candles.map((_, i) => ({
    emaFast: emaFast[i], emaMid: emaMid[i], emaSlow: emaSlow[i], emaTrend: emaTrend[i],
    adx: adx[i], dmp: dmp[i], dmn: dmn[i], rsi: rsiValues[i],
    atr: atr[i], volMa: volMa[i], emaMidPrev5: emaMidPrev5[i]
  }));
}
const DEFAULTS = {
  emaFast: 21, emaMid: 50, emaSlow: 100, emaTrend: 200,
  adxLen: 14, adxMinStrong: 25, adxMinWeak: 20,
  rsiLen: 14, rsiMin: 50, rsiMax: 72,
  atrLen: 14, atrSlMult: 1.5, rrTp1: 1.2, rrTp2: 2.5,
  volMaLen: 20, minBars: 210, minConfidence: 60
};
function detectRegime(row, cfg) {
  const slope = row.emaMidPrev5 ? (row.emaMid - row.emaMidPrev5) / row.emaMidPrev5 : 0;
  const buyersDominant = row.dmp - row.dmn >= 3;
  if (row.close < row.emaTrend) return "DOWNTREND";
  const strongStack = row.close > row.emaFast && row.emaFast > row.emaMid && row.emaMid > row.emaSlow;
  if (strongStack && row.adx >= cfg.adxMinStrong && row.rsi >= 55 && slope > 0 && buyersDominant) return "STRONG_UPTREND";
  if (row.close > row.emaTrend && row.close > row.emaSlow && row.adx >= cfg.adxMinWeak &&
      row.rsi >= cfg.rsiMin && slope >= 0 && buyersDominant) return "WEAK_UPTREND";
  return "NEUTRAL";
}
function confirmEntry(candles, row) {
  const last = candles[candles.length - 1];
  const recent = candles.slice(-2);
  const touchedFast = recent.some(x => num(x.low) <= row.emaFast * 1.01);
  const touchedMid = recent.some(x => num(x.low) <= row.emaMid * 1.01);
  if (!touchedFast && !touchedMid) return [false, "قیمت به حمایت EMA نزدیک نشده است"];
  const body = Math.abs(num(last.close) - num(last.open));
  const range = num(last.high) - num(last.low);
  if (range <= 0) return [false, "کندل بدون دامنه"];
  const upperWick = num(last.high) - Math.max(num(last.close), num(last.open));
  if (upperWick > range * 0.40) return [false, "سایه بالایی کندل بیش از حد بزرگ است"];
    if (!(num(last.volume) >= row.volMa * 0.7)) return [false, "حجم بسیار پایین است"];
  return [true, "تاییدیه ورود در پولبک"];
}
function calcLevels(row, cfg) {
  const entry = row.close;
  const slAtr = entry - row.atr * cfg.atrSlMult;
  const slEma = row.emaFast * 0.995;
  let stop = Math.max(slAtr, slEma);
  let risk = entry - stop;
  if (risk <= 0) { risk = entry * 0.01; stop = entry - risk; }
  return { entry, stop, tp1: entry + risk * cfg.rrTp1, tp2: entry + risk * cfg.rrTp2 };
}
function confidence(row, regime, cfg) {
  let score = 0;
  if (regime === "STRONG_UPTREND") score += 40;
  else if (regime === "WEAK_UPTREND") score += 25;
  if (row.adx >= cfg.adxMinStrong) score += 20;
  else if (row.adx >= cfg.adxMinWeak) score += 10;
  if (row.rsi >= 50 && row.rsi <= 65) score += 20;
  else if (row.rsi > 65 && row.rsi <= 72) score += 5;
  if (row.dmp > row.dmn) score += 20;
  return Math.min(score, 100);
}

/** Closed OHLCV candles, oldest first; faithful port of the supplied Python signal rules. */
export function analyzeEmaPullbackLong({ symbol, candles, options = {} }) {
  const cfg = { ...DEFAULTS, ...options };
  const reject = (reason, regime = "UNKNOWN", extra = {}) => ({ symbol, side: "LONG", eligible: false, reason, regime, ...extra });
  if (!Array.isArray(candles) || candles.length < cfg.minBars) return reject("insufficient_history");
  if (!candles.every(x => [x.open, x.high, x.low, x.close, x.volume].every(finite) &&
    num(x.open) > 0 && num(x.low) > 0 && num(x.high) >= Math.max(num(x.open), num(x.close), num(x.low)) && num(x.volume) >= 0)) {
    return reject("invalid_ohlcv");
  }
  const computed = computeIndicators(candles, cfg);
  const i = candles.length - 1, raw = candles[i], ind = computed[i];
  const required = [ind.emaFast, ind.emaMid, ind.emaSlow, ind.emaTrend, ind.adx, ind.dmp, ind.dmn, ind.rsi, ind.atr, ind.volMa, ind.emaMidPrev5];
  if (required.some(x => x === null || !Number.isFinite(x))) return reject("indicator_nan");
  const row = { ...ind, open: num(raw.open), high: num(raw.high), low: num(raw.low),
    close: num(raw.close), volume: num(raw.volume) };
  const regime = detectRegime(row, cfg);
  if (regime === "DOWNTREND" || regime === "NEUTRAL") return reject("unfavorable_market_regime", regime);
  const [entryOk, entryMessage] = confirmEntry(candles, row);
  if (!entryOk) return reject("entry_confirmation_failed", regime, { detail: entryMessage });
  const levels = calcLevels(row, cfg);
  const score = confidence(row, regime, cfg);
  if (score < cfg.minConfidence) return reject("confidence_below_minimum", regime, { confidence: score });
  return {
    symbol, side: "LONG", eligible: true, version: EMA_PULLBACK_LONG_VERSION, regime,
    entry: levels.entry, stop: levels.stop, tp1: levels.tp1, tp2: levels.tp2,
    riskReward: (levels.tp1 - levels.entry) / (levels.entry - levels.stop),
    confidence: score,
    reasons: [`رژیم: ${regime}`, `ADX=${row.adx.toFixed(1)} | RSI=${row.rsi.toFixed(1)}`, entryMessage],
    indicators: { ...row }
  };
}

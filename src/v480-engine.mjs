// Isolated test-only copy of the user's supplied v4.8.0 strategy functions.
// No production source file is changed.
export function ema(values, period) {
  if (values.length < period) return null;
  const multiplier = 2 / (period + 1);
  let value = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) value = values[i] * multiplier + value * (1 - multiplier);
  return value;
}
export function rsi(values, period = 14) {
  if (values.length <= period) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const change = values[i] - values[i - 1];
    gains += Math.max(change, 0); losses += Math.max(-change, 0);
  }
  let avgGain = gains / period, avgLoss = losses / period;
  for (let i = period + 1; i < values.length; i++) {
    const change = values[i] - values[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(change, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-change, 0)) / period;
  }
  if (avgLoss === 0) return 100;
  if (avgGain === 0) return 0;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}
export function average(values) {
  if (!values.length) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}
export const FUTURES_CONFIG = {
  BASE_URL: "https://futures.kraken.com/derivatives/api/v3",
  CHARTS_URL: "https://futures.kraken.com/api/charts/v1",
  CONCURRENCY: 3,
  MAX_SCAN_DURATION_MS: 180000,
  SCAN_FINALIZATION_RESERVE_MS: 45000,
  REQUEST_TIMEOUT_MS: 12000,
  MAX_SIGNALS_PER_SCAN: 20,
  MIN_QUOTE_VOLUME: 5000000,
  KLINE_LIMIT: 120,
  MIN_CANDLES: 60,
  MIN_SCORE: 72,
  MIN_SCORE_LONG: 65,
  MIN_LONG_VOLUME_RATIO: 0.65,
  MIN_DISTANCE_FROM_EXTREME: 0.003,
  INTERVAL: "1h",
  CONFIRM_INTERVAL: "4h",
  ENTRY_CONFIRM_INTERVAL: "15m",
  SIGNAL_TTL_MINUTES: 60,
  MAX_ENTRY_DRIFT_PCT: 0.35,
  MAX_ENTRY_EMA_DISTANCE_ATR: 3.0,
  MAX_PULLBACK_DISTANCE_ATR: 0.35,
  MAX_RECLAIM_EXTENSION_ATR: 3.0,
  MAX_BREAKOUT_DISTANCE_PCT_LONG: 0.5,
  MAX_BREAKOUT_DISTANCE_PCT_SHORT: 0.5,
  FUNDING_EXTREME_THRESHOLD: 0.001,
  FUNDING_PENALTY_POINTS: 5
};
export function calculateAtr(candles, period = 14) {
  if (candles.length <= period) return null;
  const ranges = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], prevClose = candles[i - 1].close;
    ranges.push(Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose)));
  }
  const recent = ranges.slice(-period);
  return recent.length === period ? average(recent) : null;
}
export function evaluateFuturesEntryFilters({ ticker, candles1h, candles15m, side, referencePrice, ema20, atr }) {
  const marketPrice = Number(ticker?.last);
  if (!Number.isFinite(marketPrice) || marketPrice <= 0) return { ok: false, rejected: "قیمت لحظه‌ای بازار معتبر نیست" };
  const driftPct = Math.abs(marketPrice - referencePrice) / referencePrice * 100;
  if (driftPct > FUTURES_CONFIG.MAX_ENTRY_DRIFT_PCT) return { ok: false, rejected: "فاصله قیمت لحظه‌ای تا قیمت تحلیلی بیش از حد مجاز است", driftPct };
  const emaDistanceAtr = Math.abs(marketPrice - ema20) / atr;
  if (emaDistanceAtr > FUTURES_CONFIG.MAX_ENTRY_EMA_DISTANCE_ATR) return { ok: false, rejected: "ورود دیرهنگام است؛ قیمت بیش از حد از EMA20 فاصله دارد", driftPct, emaDistanceAtr };
  const has15mData = Array.isArray(candles15m) && candles15m.length >= 30;
  if (!has15mData) return { ok: true, driftPct, emaDistanceAtr, momentumConfirmed: false, pullbackConfirmed: false, confirmationUnavailable: true };
  const closes15m = candles15m.map(c => c.close);
  const ema9_15m = ema(closes15m, 9), ema21_15m = ema(closes15m, 21), atr15m = calculateAtr(candles15m, 14);
  const last15m = candles15m[candles15m.length - 1], recentPullback = candles15m.slice(-9, -1);
  if (![ema9_15m, ema21_15m, atr15m].every(Number.isFinite) || atr15m <= 0 || !recentPullback.length) {
    return { ok: true, driftPct, emaDistanceAtr, momentumConfirmed: false, pullbackConfirmed: false, confirmationUnavailable: true };
  }
  const aligned = side === "LONG"
    ? (ema9_15m > ema21_15m && last15m.close > ema9_15m && last15m.close > last15m.open)
    : (ema9_15m < ema21_15m && last15m.close < ema9_15m && last15m.close < last15m.open);
  const touchedPullbackZone = side === "LONG"
    ? recentPullback.some(c => c.low <= ema21_15m + atr15m * FUTURES_CONFIG.MAX_PULLBACK_DISTANCE_ATR)
    : recentPullback.some(c => c.high >= ema21_15m - atr15m * FUTURES_CONFIG.MAX_PULLBACK_DISTANCE_ATR);
  const reclaimExtensionAtr = side === "LONG" ? (last15m.close - ema9_15m) / atr15m : (ema9_15m - last15m.close) / atr15m;
  if (reclaimExtensionAtr > FUTURES_CONFIG.MAX_RECLAIM_EXTENSION_ATR) {
    return { ok: false, rejected: "قیمت پس از حرکت تأییدی بیش از حد از محدوده ورود فاصله گرفته است", driftPct, emaDistanceAtr, reclaimExtensionAtr };
  }
  return { ok: true, driftPct, emaDistanceAtr, reclaimExtensionAtr, ema9_15m, ema21_15m, atr15m, momentumConfirmed: aligned, pullbackConfirmed: touchedPullbackZone };
}
export function findLatestConfirmed15mPivot(candles, side, left = 3, right = 3) {
  if (!Array.isArray(candles) || candles.length < left + right + 1) return null;
  const field = side === "LONG" ? "high" : "low";
  for (let i = candles.length - right - 1; i >= left; i--) {
    const value = Number(candles[i]?.[field]);
    if (!Number.isFinite(value)) continue;
    let pivot = true;
    for (let j = i - left; j <= i + right; j++) {
      if (j === i) continue;
      const neighbor = Number(candles[j]?.[field]);
      if (!Number.isFinite(neighbor) || (side === "LONG" ? neighbor >= value : neighbor <= value)) { pivot = false; break; }
    }
    if (pivot) return { index: i, time: candles[i].time, price: value, type: side === "LONG" ? "swing_high" : "swing_low" };
  }
  return null;
}
export function passesDistanceThreshold(side, candles1h, threshold = FUTURES_CONFIG.MIN_DISTANCE_FROM_EXTREME) {
  if (!Array.isArray(candles1h) || candles1h.length < 3) return false;
  const last3 = candles1h.slice(-3), referencePrice = Number(last3[2]?.close);
  if (!Number.isFinite(referencePrice) || referencePrice <= 0) return false;
  if (side === "LONG") {
    const maxHigh = Math.max(...last3.map(c => Number(c?.high)));
    if (!Number.isFinite(maxHigh) || maxHigh <= 0) return false;
    const distance = Math.abs(referencePrice - maxHigh) / maxHigh;
    return Number.isFinite(distance) && distance >= threshold;
  }
  const minLow = Math.min(...last3.map(c => Number(c?.low)));
  if (!Number.isFinite(minLow) || minLow <= 0) return false;
  const distance = Math.abs(referencePrice - minLow) / minLow;
  return Number.isFinite(distance) && distance >= threshold;
}
export function analyzeFuturesSymbol(ticker, candles1h, candles4h, candles15m, options = {}) {
  if (candles1h.length < FUTURES_CONFIG.MIN_CANDLES || candles4h.length < FUTURES_CONFIG.MIN_CANDLES) throw new Error("تعداد کندل بسته‌شده برای تحلیل ۱ساعته/۴ساعته کافی نیست.");
  const closes1h = candles1h.map(c => c.close), closes4h = candles4h.map(c => c.close);
  const last = candles1h[candles1h.length - 1], referencePrice = last.close;
  const e20 = ema(closes1h, 20), e50 = ema(closes1h, 50), e20_4h = ema(closes4h, 20), e50_4h = ema(closes4h, 50);
  const rsiValue = rsi(closes1h, 14), atr = calculateAtr(candles1h, 14);
  if ([e20, e50, e20_4h, e50_4h, rsiValue, atr].some(v => !Number.isFinite(v)) || atr <= 0) throw new Error("محاسبه اندیکاتورها معتبر نیست.");
  const avgVol = average(candles1h.slice(-21, -1).map(c => c.volume));
  const volumeRatio = avgVol > 0 ? last.volume / avgVol : 0;
  const up1h = e20 > e50 && referencePrice > e20, down1h = e20 < e50 && referencePrice < e20;
  const up4h = e20_4h > e50_4h, down4h = e20_4h < e50_4h;
  const strictLong = up1h && up4h && rsiValue >= 48 && rsiValue <= 69;
  const strictShort = down1h && down4h && rsiValue >= 31 && rsiValue <= 52;
  const relaxedLong = up1h && e20_4h >= e50_4h && rsiValue >= 42 && rsiValue <= 68;
  const relaxedShort = down1h && e20_4h <= e50_4h && rsiValue >= 32 && rsiValue <= 55;
  const strictSetup = strictLong || strictShort;
  if (strictLong && strictShort) return { symbol: ticker.symbol, rejected: "تناقض روند: شرایط Strict LONG و Strict SHORT هم‌زمان برقرار است؛ سیگنال صادر نشد" };
  let side = null, score = 0;
  const reasons = [];
  if (strictLong || (!strictSetup && relaxedLong)) {
    side = "LONG"; score = strictSetup ? 45 : 40;
    reasons.push(strictSetup ? "روند ۱ساعته و ۴ساعته صعودی است" : "ستاپ آزمایشی: روند ۱ساعته صعودی و روند ۴ساعته صعودی/خنثی است", "قیمت بالای EMA20 قرار دارد");
    score += rsiValue >= 52 && rsiValue <= 65 ? 15 : 9;
  } else if (strictShort || (!strictSetup && relaxedShort)) {
    side = "SHORT"; score = strictSetup ? 45 : 40;
    reasons.push(strictSetup ? "روند ۱ساعته و ۴ساعته نزولی است" : "ستاپ آزمایشی: روند ۱ساعته نزولی و روند ۴ساعته نزولی/خنثی است", "قیمت زیر EMA20 قرار دارد");
    score += rsiValue >= 35 && rsiValue <= 48 ? 15 : 9;
  } else return { symbol: ticker.symbol, rejected: "حتی شرایط منعطف آزمایشی روند و RSI نیز تأیید نشد" };
  if (volumeRatio >= 1.5) { score += 18; reasons.push("حجم بالاتر از میانگین است"); }
  else if (volumeRatio >= 1.0) { score += 12; reasons.push("حجم نزدیک یا بالاتر از میانگین است"); }
  else { score += 4; reasons.push("حجم کمتر از میانگین است"); }
  const change = Number(ticker.priceChangePercent) || 0;
  if ((side === "LONG" && change > 0) || (side === "SHORT" && change < 0)) score += 8;
  else score += 3;
  const funding = Number(ticker.premium?.lastFundingRate);
  if (Number.isFinite(funding)) {
    if (Math.abs(funding) > FUTURES_CONFIG.FUNDING_EXTREME_THRESHOLD) {
      score -= FUTURES_CONFIG.FUNDING_PENALTY_POINTS;
      reasons.push(side === "LONG" ? "فاندینگ در محدوده افراطی؛ ریسک ازدحام لانگ" : "فاندینگ در محدوده افراطی؛ ریسک ازدحام شورت");
    } else reasons.push("فاندینگ در محدوده افراطی نیست");
  } else reasons.push("داده فاندینگ در دسترس نبود");
  const entryFilters = options.skipEntryFilters ? { ok: true, skippedForBaseline: true } : evaluateFuturesEntryFilters({ ticker, candles1h, candles15m, side, referencePrice, ema20: e20, atr });
  if (!entryFilters.ok) return { symbol: ticker.symbol, side, score: Math.max(0, Math.min(100, Math.round(score))), rejected: entryFilters.rejected, entryDiagnostics: entryFilters };
  if (!options.skipEntryFilters && !entryFilters.confirmationUnavailable && (!entryFilters.momentumConfirmed || !entryFilters.pullbackConfirmed)) {
    return { symbol: ticker.symbol, side, score: Math.max(0, Math.min(100, Math.round(score))), rejected: "تأیید مومنتوم/پولبک ۱۵دقیقه‌ای کامل نیست؛ سیگنال صادر نشد", entryDiagnostics: entryFilters };
  }
  if (!options.skipBreakoutFilter) {
    const breakoutPivot = findLatestConfirmed15mPivot(candles15m, side, 3, 3);
    if (!breakoutPivot) return { symbol: ticker.symbol, side, rejected: "پیوت شکست معتبر ۱۵دقیقه‌ای در دسترس نیست" };
    const breakoutEntryPrice = Number(ticker.last);
    const breakoutDistancePct = side === "LONG"
      ? ((breakoutEntryPrice - breakoutPivot.price) / breakoutPivot.price) * 100
      : ((breakoutPivot.price - breakoutEntryPrice) / breakoutPivot.price) * 100;
    const maxBreakoutDistancePct = side === "LONG" ? FUTURES_CONFIG.MAX_BREAKOUT_DISTANCE_PCT_LONG : FUTURES_CONFIG.MAX_BREAKOUT_DISTANCE_PCT_SHORT;
    if (!Number.isFinite(breakoutDistancePct) || breakoutDistancePct < 0 || breakoutDistancePct > maxBreakoutDistancePct) {
      return { symbol: ticker.symbol, side, rejected: "فاصله ورود تا سطح شکست خارج از محدوده مجاز است", breakoutDiagnostics: { pivot: breakoutPivot, signedDistancePct: breakoutDistancePct, maxDistancePct: maxBreakoutDistancePct } };
    }
    reasons.push(side === "LONG" ? "فاصله قیمت از پیوت شکست ۱۵دقیقه‌ای حداکثر ۰٫۵٪ است" : "فاصله قیمت از پیوت شکست ۱۵دقیقه‌ای حداکثر ۰٫۵٪ است");
  }
  reasons.push("قیمت لحظه‌ای در محدوده مجاز قیمت تحلیلی است", "فاصله قیمت از EMA20 برای ورود قابل‌قبول است");
  if (entryFilters.momentumConfirmed && entryFilters.pullbackConfirmed) reasons.push("مومنتوم و پولبک ۱۵دقیقه‌ای تأیید شدند");
  else if (entryFilters.confirmationUnavailable) reasons.push("داده ۱۵دقیقه‌ای کافی نبود؛ تأیید مومنتوم اعمال نشد");
  const entry = options.skipEntryFilters ? referencePrice : Number(ticker.last);
  const swing = candles1h.slice(-8, -1), swingLow = Math.min(...swing.map(c => c.low)), swingHigh = Math.max(...swing.map(c => c.high));
  const stop = side === "LONG" ? Math.max(swingLow, entry - atr * 1.5) : Math.min(swingHigh, entry + atr * 1.5);
  const risk = side === "LONG" ? entry - stop : stop - entry, riskPct = risk / entry;
  if (!Number.isFinite(risk) || risk <= 0 || riskPct < 0.002 || riskPct > 0.08) return { symbol: ticker.symbol, rejected: "فاصله حد ضرر غیرمنطقی است؛ سیگنال صادر نشد" };
  const direction = side === "LONG" ? 1 : -1;
  const target1 = entry + direction * risk * 1.5, target2 = entry + direction * risk * 2.2, target3 = entry + direction * risk * 3;
  score = Math.max(0, Math.min(100, Math.round(score)));
  const eligible = side === "LONG"
    ? ((strictLong || (!strictSetup && relaxedLong)) && score >= FUTURES_CONFIG.MIN_SCORE_LONG && volumeRatio >= FUTURES_CONFIG.MIN_LONG_VOLUME_RATIO)
    : (strictSetup && score >= FUTURES_CONFIG.MIN_SCORE && volumeRatio >= 0.75);
  if (eligible && !passesDistanceThreshold(side, candles1h, FUTURES_CONFIG.MIN_DISTANCE_FROM_EXTREME)) {
    const last3 = candles1h.slice(-3), maxHighLast3 = Math.max(...last3.map(c => Number(c.high))), minLowLast3 = Math.min(...last3.map(c => Number(c.low)));
    return {
      symbol: ticker.symbol, side, score,
      rejected: side === "LONG" ? "فاصله قیمت بسته‌شدن کندل ۱ساعته تا بیشترین High سه کندل تکمیل‌شده کمتر از حد مجاز ۰٫۳٪ است" : "فاصله قیمت بسته‌شدن کندل ۱ساعته تا کمترین Low سه کندل تکمیل‌شده کمتر از حد مجاز ۰٫۳٪ است",
      distanceThreshold: { thresholdPct: FUTURES_CONFIG.MIN_DISTANCE_FROM_EXTREME * 100, referencePrice, maxHighLast3, minLowLast3, eligible: false },
      eligible: false
    };
  }
  return {
    symbol: ticker.symbol, side, score, price: entry, entry, stop, target1, target2, target3, rewardRisk: 1.5,
    rsi: rsiValue, ema20: e20, ema50: e50, atr, volumeRatio,
    funding: Number.isFinite(funding) ? funding : null,
    quoteVolume: Number(ticker.quoteVolume) || 0, change24h: change, candleTime: last.time, reasons,
    entryDiagnostics: entryFilters, eligible
  };
}

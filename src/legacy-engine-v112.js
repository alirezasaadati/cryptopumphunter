// Exact signal-analysis implementation copied from src/index.js at commit 4ac838a34e26ee0b96eaf5d793e649e017e4a610.
// Isolated backtest module only; it is never imported by the production Worker entrypoint.
function ema(values, period) {
  if (values.length < period) return null;

  const multiplier = 2 / (period + 1);
  let value =
    values.slice(0, period).reduce((a, b) => a + b, 0) / period;

  for (let i = period; i < values.length; i++) {
    value = values[i] * multiplier + value * (1 - multiplier);
  }

  return value;
}

function rsi(values, period = 14) {
  if (!Array.isArray(values) || !Number.isInteger(period) || period <= 0 ||
      values.length <= period || !values.every(Number.isFinite)) return null;

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
  if (avgGain === 0 && avgLoss === 0) return 50;
  if (avgLoss === 0) return 100;
  if (avgGain === 0) return 0;
  const result = 100 - 100 / (1 + avgGain / avgLoss);
  return Number.isFinite(result) ? result : null;
}

function average(values) {
  if (!values.length) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

const FUTURES_CONFIG = {
  BASE_URL: "https://futures.kraken.com/derivatives/api/v3",
  CHARTS_URL: "https://futures.kraken.com/api/charts/v1",
  CONCURRENCY: 5, MAX_SCAN_DURATION_MS: 180000, SCAN_FINALIZATION_RESERVE_MS: 45000,
  REQUEST_TIMEOUT_MS: 12000, MAX_SIGNALS_PER_SCAN: 6,
  MIN_QUOTE_VOLUME: 5_000_000, HIGH_RISK_MIN_QUOTE_VOLUME: 2_500_000,
  KLINE_LIMIT: 120, MIN_CANDLES: 60, MIN_SCORE: 70,
  INTERVAL: "1h", CONFIRM_INTERVAL: "4h", ENTRY_CONFIRM_INTERVAL: "15m",
  SIGNAL_TTL_MINUTES: 60, MAX_ENTRY_DRIFT_PCT: 0.45,
  MAX_ENTRY_EMA_DISTANCE_ATR: 2.0, MAX_PULLBACK_DISTANCE_ATR: 0.45,
  MAX_RECLAIM_EXTENSION_ATR: 1.5, HIGH_RISK_MIN_SCORE: 62,
  HIGH_RISK_MIN_VOLUME_RATIO: 0.65, VOLUME_PRIORITY_TIER_1: 0.8,
  VOLUME_PRIORITY_TIER_2: 1.3, VOLUME_PRIORITY_BONUS_TIER_1: 5,
  VOLUME_PRIORITY_BONUS_TIER_2: 10, CONFIRMATION_PRIORITY_BONUS_ONE: 7,
  CONFIRMATION_PRIORITY_BONUS_BOTH: 15, HIGH_RISK_LONG_RSI_MIN: 45,
  HIGH_RISK_LONG_RSI_MAX: 68, HIGH_RISK_SHORT_RSI_MIN: 32,
  HIGH_RISK_SHORT_RSI_MAX: 55, HIGH_RISK_MAX_ENTRY_DRIFT_PCT: 0.6,
  HIGH_RISK_MAX_ENTRY_EMA_DISTANCE_ATR: 2.4, HIGH_RISK_MAX_RECLAIM_EXTENSION_ATR: 1.8
};

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

function evaluateFuturesEntryFilters({ ticker, candles1h, candles15m, side, referencePrice, ema20, atr, isHighRisk = false }) {
  const marketPrice = Number(ticker?.last);
  if (!Number.isFinite(marketPrice) || marketPrice <= 0) return { ok: false, rejected: "قیمت لحظه‌ای بازار معتبر نیست" };
  const maxDrift = isHighRisk ? FUTURES_CONFIG.HIGH_RISK_MAX_ENTRY_DRIFT_PCT : FUTURES_CONFIG.MAX_ENTRY_DRIFT_PCT;
  const driftPct = Math.abs(marketPrice - referencePrice) / referencePrice * 100;
  if (driftPct > maxDrift) return { ok: false, rejected: "فاصله قیمت لحظه‌ای تا قیمت تحلیلی بیش از حد مجاز است", driftPct };
  const maxEmaDist = isHighRisk ? FUTURES_CONFIG.HIGH_RISK_MAX_ENTRY_EMA_DISTANCE_ATR : FUTURES_CONFIG.MAX_ENTRY_EMA_DISTANCE_ATR;
  const emaDistanceAtr = Math.abs(marketPrice - ema20) / atr;
  if (emaDistanceAtr > maxEmaDist) return { ok: false, rejected: "ورود دیرهنگام است؛ قیمت بیش از حد از EMA20 فاصله دارد", driftPct, emaDistanceAtr };
  if (!Array.isArray(candles15m) || candles15m.length < 30) return { ok: false, rejected: "داده ۱۵ دقیقه‌ای برای تأیید نقطه ورود کافی نیست" };
  const closes15m = candles15m.map(c => c.close), ema9_15m = ema(closes15m, 9), ema21_15m = ema(closes15m, 21);
  const atr15m = calculateAtr(candles15m, 14), last15m = candles15m[candles15m.length - 1], prev15m = candles15m[candles15m.length - 2];
  const recentPullback = candles15m.slice(-10, -1);
  if (![ema9_15m, ema21_15m, atr15m].every(Number.isFinite) || atr15m <= 0 || !recentPullback.length) return { ok: false, rejected: "محاسبه اندیکاتورهای ۱۵ دقیقه‌ای نامعتبر است" };
  const momentumConfirmed = side === "LONG"
    ? ema9_15m > ema21_15m && last15m.close > ema9_15m && last15m.close > last15m.open && last15m.close > prev15m.high
    : ema9_15m < ema21_15m && last15m.close < ema9_15m && last15m.close < last15m.open && last15m.close < prev15m.low;
  const pullbackConfirmed = side === "LONG"
    ? recentPullback.some(c => c.low <= ema21_15m + atr15m * FUTURES_CONFIG.MAX_PULLBACK_DISTANCE_ATR)
    : recentPullback.some(c => c.high >= ema21_15m - atr15m * FUTURES_CONFIG.MAX_PULLBACK_DISTANCE_ATR);
  if (!momentumConfirmed) return { ok: false, rejected: "ماشه مومنتوم ۱۵ دقیقه‌ای هنوز صادر نشده است", driftPct, emaDistanceAtr };
  if (!pullbackConfirmed) return { ok: false, rejected: "هنوز پولبک به محدوده EMA21 در ۱۵ دقیقه انجام نشده است", driftPct, emaDistanceAtr };
  const maxReclaim = isHighRisk ? FUTURES_CONFIG.HIGH_RISK_MAX_RECLAIM_EXTENSION_ATR : FUTURES_CONFIG.MAX_RECLAIM_EXTENSION_ATR;
  const reclaimExtensionAtr = side === "LONG" ? (last15m.close - ema9_15m) / atr15m : (ema9_15m - last15m.close) / atr15m;
  if (reclaimExtensionAtr > maxReclaim) return { ok: false, rejected: "کندل تأیید ۱۵ دقیقه‌ای بیش از حد کشیده شده است", driftPct, emaDistanceAtr, reclaimExtensionAtr };
  return { ok: true, driftPct, emaDistanceAtr, reclaimExtensionAtr, ema9_15m, ema21_15m, atr15m, momentumConfirmed: true, pullbackConfirmed: true };
}

function analyzeFuturesSymbol(ticker, candles1h, candles4h, candles15m, options = {}) {
  if (candles1h.length < FUTURES_CONFIG.MIN_CANDLES || candles4h.length < FUTURES_CONFIG.MIN_CANDLES) throw new Error("تعداد کندل بسته‌شده برای تحلیل ۱ساعته/۴ساعته کافی نیست.");
  const closes1h = candles1h.map(c => c.close), closes4h = candles4h.map(c => c.close);
  const last = candles1h[candles1h.length - 1], prev = candles1h[candles1h.length - 2], referencePrice = last.close;
  const e20 = ema(closes1h, 20), prevE20 = ema(closes1h.slice(0, -1), 20), e50 = ema(closes1h, 50);
  const e20_4h = ema(closes4h, 20), e50_4h = ema(closes4h, 50), rsiValue = rsi(closes1h, 14), atr = calculateAtr(candles1h, 14);
  if ([e20, prevE20, e50, e20_4h, e50_4h, rsiValue, atr].some(v => !Number.isFinite(v)) || atr <= 0) throw new Error("محاسبه اندیکاتورها معتبر نیست.");
  const avgVol = average(candles1h.slice(-21, -1).map(c => c.volume)), volumeRatio = avgVol > 0 ? last.volume / avgVol : 0;
  const up1h = e20 > e50 && e20 > prevE20 && referencePrice > e20 && last.close >= prev.low;
  const down1h = e20 < e50 && e20 < prevE20 && referencePrice < e20 && last.close <= prev.high;
  const up4h = e20_4h > e50_4h && candles4h.at(-1).close > e20_4h, down4h = e20_4h < e50_4h && candles4h.at(-1).close < e20_4h;
  const fourHourTrend = up4h ? "BULLISH" : down4h ? "BEARISH" : "NEUTRAL";
  let side = null, score = 0; const reasons = [];
  const strictLong = up1h && rsiValue >= 48 && rsiValue <= 66, strictShort = down1h && rsiValue >= 34 && rsiValue <= 52;
  const relaxedLong = up1h && rsiValue >= FUTURES_CONFIG.HIGH_RISK_LONG_RSI_MIN && rsiValue <= FUTURES_CONFIG.HIGH_RISK_LONG_RSI_MAX;
  const relaxedShort = down1h && rsiValue >= FUTURES_CONFIG.HIGH_RISK_SHORT_RSI_MIN && rsiValue <= FUTURES_CONFIG.HIGH_RISK_SHORT_RSI_MAX;
  const strictSetup = strictLong || strictShort;
  if (strictLong || (!strictSetup && relaxedLong)) { side = "LONG"; score = strictSetup ? 48 : 42; reasons.push(strictSetup ? "روند ۱ساعته صعودی با شیب مثبت EMA20" : "ستاپ پرریسک صعودی ۱ساعته"); score += rsiValue >= 52 && rsiValue <= 62 ? 15 : 8; }
  else if (strictShort || (!strictSetup && relaxedShort)) { side = "SHORT"; score = strictSetup ? 48 : 42; reasons.push(strictSetup ? "روند ۱ساعته نزولی با شیب منفی EMA20" : "ستاپ پرریسک نزولی ۱ساعته"); score += rsiValue >= 38 && rsiValue <= 48 ? 15 : 8; }
  else return { symbol: ticker.symbol, fourHourTrend, rejected: "روند ۱ساعته و محدوده بهینه RSI هم‌زمان تأیید نشد", entryDiagnostics: { stage: "trend_rsi", rsi: rsiValue, up1h, down1h, fourHourTrend } };
  const expectedTrend = side === "LONG" ? "BULLISH" : "BEARISH";
  if (fourHourTrend !== expectedTrend) return { symbol: ticker.symbol, fourHourTrend, side, rejected: "روند ۴ساعته نماد هم‌جهت با سیگنال نیست" };
  if (options.requireBtcFourHourAlignment === true && options.btcFourHourTrend !== expectedTrend) return { symbol: ticker.symbol, fourHourTrend, btcFourHourTrend: options.btcFourHourTrend || null, side, rejected: "روند ۴ساعته بیت‌کوین هم‌جهت با سیگنال نیست" };
  score += 10; reasons.push("روند ۴ساعته نماد و بیت‌کوین کاملاً هم‌جهت است");
  const change = Number(ticker.priceChangePercent) || 0;
  if (side === "LONG") { if (change < -1.5) return { symbol: ticker.symbol, fourHourTrend, side, rejected: "تغییر ۲۴ساعته نماد منفی است؛ ریسک تله گاوی برای لانگ" }; if (volumeRatio < 0.7) return { symbol: ticker.symbol, fourHourTrend, side, rejected: "حجم نسبی برای تأیید لانگ کافی نیست" }; }
  score += ((side === "LONG" && change > 0) || (side === "SHORT" && change < 0)) ? 8 : 2;
  const volumePriorityBonus = volumeRatio >= FUTURES_CONFIG.VOLUME_PRIORITY_TIER_2 ? FUTURES_CONFIG.VOLUME_PRIORITY_BONUS_TIER_2 : volumeRatio >= FUTURES_CONFIG.VOLUME_PRIORITY_TIER_1 ? FUTURES_CONFIG.VOLUME_PRIORITY_BONUS_TIER_1 : 0;
  const funding = Number(ticker.premium?.lastFundingRate);
  if (Number.isFinite(funding)) { if (side === "LONG" && funding > 0.0008) { score -= 6; reasons.push("فاندینگ مثبت بالا؛ ریسک ازدحام لانگ"); } else if (side === "SHORT" && funding < -0.0008) { score -= 6; reasons.push("فاندینگ منفی بالا؛ ریسک ازدحام شورت"); } }
  const priorityBaseScore = score, quoteVolume = Number(ticker.quoteVolume) || 0;
  const standardThresholdMet = strictSetup && quoteVolume >= FUTURES_CONFIG.MIN_QUOTE_VOLUME && score >= FUTURES_CONFIG.MIN_SCORE && volumeRatio >= 0.85;
  let standardEntryPassed = false, entryFilters;
  if (options.skipEntryFilters) { entryFilters = { ok: true, skippedForBaseline: true, momentumConfirmed: true, pullbackConfirmed: true }; standardEntryPassed = standardThresholdMet; }
  else if (standardThresholdMet) { const strictEntry = evaluateFuturesEntryFilters({ ticker, candles1h, candles15m, side, referencePrice, ema20: e20, atr, isHighRisk: false }); if (strictEntry.ok) { entryFilters = strictEntry; standardEntryPassed = true; } else entryFilters = evaluateFuturesEntryFilters({ ticker, candles1h, candles15m, side, referencePrice, ema20: e20, atr, isHighRisk: true }); }
  else entryFilters = evaluateFuturesEntryFilters({ ticker, candles1h, candles15m, side, referencePrice, ema20: e20, atr, isHighRisk: true });
  if (!entryFilters.ok) return { symbol: ticker.symbol, fourHourTrend, side, score: Math.max(0, Math.min(100, Math.round(score))), rejected: entryFilters.rejected, entryDiagnostics: entryFilters };
  if (!standardEntryPassed && quoteVolume < FUTURES_CONFIG.HIGH_RISK_MIN_QUOTE_VOLUME) return { symbol: ticker.symbol, fourHourTrend, side, rejected: "حجم ۲۴ساعته کمتر از کف ایمنی است" };
  if (!standardEntryPassed && volumeRatio < FUTURES_CONFIG.HIGH_RISK_MIN_VOLUME_RATIO) return { symbol: ticker.symbol, fourHourTrend, side, rejected: "حجم نسبی کندل آخر کافی نیست" };
  const entry = options.skipEntryFilters ? referencePrice : Number(ticker.last);
  const swing = candles1h.slice(-13, -1), swingLow = Math.min(...swing.map(c => c.low)), swingHigh = Math.max(...swing.map(c => c.high)), liquidityBuffer = atr * 0.25;
  const stop = side === "LONG" ? Math.min(swingLow - liquidityBuffer, entry - atr * 1.6) : Math.max(swingHigh + liquidityBuffer, entry + atr * 1.6);
  const risk = side === "LONG" ? entry - stop : stop - entry, riskPct = risk / entry;
  if (!Number.isFinite(risk) || risk <= 0 || riskPct < 0.004 || riskPct > 0.035) return { symbol: ticker.symbol, fourHourTrend, rejected: "فاصله حد ضرر خارج از محدوده استاندارد (0.4% تا 3.5%) است" };
  const direction = side === "LONG" ? 1 : -1, target1 = entry + direction * risk * 1.5, target2 = entry + direction * risk * 2.5, target3 = entry + direction * risk * 3.5;
  score = Math.max(0, Math.min(100, Math.round(score)));
  const eligible = standardEntryPassed, highRiskEligible = !standardEntryPassed && score >= FUTURES_CONFIG.HIGH_RISK_MIN_SCORE;
  if (!eligible && !highRiskEligible) return { symbol: ticker.symbol, fourHourTrend, side, score, rejected: "امتیاز نهایی به حداقل مجاز نرسید" };
  const confirmationPriorityBonus = FUTURES_CONFIG.CONFIRMATION_PRIORITY_BONUS_BOTH, priorityScore = Math.min(125, priorityBaseScore + volumePriorityBonus + confirmationPriorityBonus);
  reasons.push("پولبک به EMA21 و ماشه مومنتوم ۱۵ دقیقه‌ای تأیید شد");
  if (highRiskEligible) reasons.push("سیگنال از مسیر منعطف (پرریسک) با تأیید کامل ۱۵ دقیقه عبور کرد");
  return { symbol: ticker.symbol, fourHourTrend, btcFourHourTrend: options.btcFourHourTrend || null, side,
    momentumConfirmed: true, pullbackConfirmed: true, score, baseScore: Math.max(0, Math.min(100, Math.round(priorityBaseScore))),
    priorityScore: Math.max(0, Math.min(125, Math.round(priorityScore))), volumePriorityBonus, fourHourScoreAdjustment: 10,
    confirmationPriorityBonus, confirmationCount: 2, riskLevel: highRiskEligible ? "HIGH_RISK" : "STANDARD",
    price: entry, entry, stop, target1, target2, target3, rewardRisk: 1.5, rsi: rsiValue,
    ema20: e20, ema50: e50, atr, volumeRatio, funding: Number.isFinite(funding) ? funding : null,
    quoteVolume, change24h: change, candleTime: last.time, reasons, entryDiagnostics: entryFilters, eligible: true, highRiskEligible };
}

export { FUTURES_CONFIG, evaluateFuturesEntryFilters, analyzeFuturesSymbol };

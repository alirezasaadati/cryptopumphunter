// BTC Swing & Oscillation Futures Signal Engine
// Transcribed from the user-supplied implementation. Strategy rules/config are preserved.
export const BTC_ENGINE_CONFIG = {
  symbol: "PF_XBTUSD",
  displaySymbol: "BTC",
  leverage: 10,
  dailyTargetSignals: 2,
  maxSignalsPerScan: 3,
  minCooldownMinutes: 180,
  minEntryAccuracyScore: 72,
  fallbackMinAccuracyScore: 64,
  tp1R: 1.5,
  tp2R: 2.8,
  minRiskPct: 0.0035,
  maxRiskPct: 0.022
};

function sma(values, period) {
  if (!Array.isArray(values) || values.length < period) return null;
  const slice = values.slice(-period);
  return slice.reduce((acc, v) => acc + v, 0) / period;
}
function ema(values, period) {
  if (!Array.isArray(values) || values.length < period) return null;
  const k = 2 / (period + 1);
  let val = values.slice(0, period).reduce((acc, v) => acc + v, 0) / period;
  for (let i = period; i < values.length; i++) val = values[i] * k + val * (1 - k);
  return val;
}
function rsi(values, period = 14) {
  if (!Array.isArray(values) || values.length <= period) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = values[i] - values[i - 1];
    gains += Math.max(diff, 0); losses += Math.max(-diff, 0);
  }
  let avgGain = gains / period, avgLoss = losses / period;
  for (let i = period + 1; i < values.length; i++) {
    const diff = values[i] - values[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(diff, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-diff, 0)) / period;
  }
  if (avgGain === 0 && avgLoss === 0) return 50;
  if (avgLoss === 0) return 100;
  if (avgGain === 0) return 0;
  return 100 - 100 / (1 + avgGain / avgLoss);
}
function atr(candles, period = 14) {
  if (!Array.isArray(candles) || candles.length <= period) return null;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const cur = candles[i], prev = candles[i - 1];
    trs.push(Math.max(cur.high - cur.low, Math.abs(cur.high - prev.close), Math.abs(cur.low - prev.close)));
  }
  const recent = trs.slice(-period);
  return recent.length === period ? recent.reduce((a, b) => a + b, 0) / period : null;
}
function detect1hContext(candles1h) {
  if (!Array.isArray(candles1h) || candles1h.length < 50) return { regime: "UNKNOWN", ema20: null, ema50: null, atr1h: null };
  const closes = candles1h.map(c => Number(c.close));
  const ema20 = ema(closes, 20), ema50 = ema(closes, 50), atr1h = atr(candles1h, 14);
  if (![ema20, ema50, atr1h].every(Number.isFinite) || atr1h <= 0) return { regime: "UNKNOWN", ema20, ema50, atr1h };
  const lastClose = closes[closes.length - 1], spreadAtr = Math.abs(ema20 - ema50) / atr1h;
  let regime = "RANGE_OSCILLATION";
  if (spreadAtr >= 0.6 && ema20 > ema50 && lastClose >= ema50) regime = "BULL_SWING";
  else if (spreadAtr >= 0.6 && ema20 < ema50 && lastClose <= ema50) regime = "BEAR_SWING";
  return { regime, ema20, ema50, atr1h };
}
export function evaluateBtcSwingSetup(candles15m, candles1h, config = BTC_ENGINE_CONFIG) {
  if (!Array.isArray(candles15m) || candles15m.length < 45) return { ok: false, reason: "داده ۱۵ دقیقه‌ای کافی نیست" };
  const context1h = detect1hContext(candles1h);
  const closes = candles15m.map(c => Number(c.close));
  const last = candles15m[candles15m.length - 1], prev = candles15m[candles15m.length - 2];
  const ema21 = ema(closes, 21), sma50 = sma(closes, 50);
  const rsiCur = rsi(closes, 14), rsiPrev = rsi(closes.slice(0, -1), 14), atr15 = atr(candles15m, 14);
  const volAvg = sma(candles15m.slice(-21, -1).map(c => Number(c.volume || 0)), 20);
  if (![ema21, rsiCur, rsiPrev, atr15].every(Number.isFinite) || atr15 <= 0) return { ok: false, reason: "اندیکاتورهای ۱۵ دقیقه‌ای نامعتبر هستند" };
  const entry = Number(last.close), volRatio = volAvg && volAvg > 0 ? Number(last.volume || 0) / volAvg : 1;
  const recentWindow = candles15m.slice(-12, -1);
  const swingLow = Math.min(...recentWindow.map(c => Number(c.low))), swingHigh = Math.max(...recentWindow.map(c => Number(c.high)));
  const bullReversalCandle = last.close > last.open && last.close > prev.high && (last.low <= swingLow + atr15 * 0.25 || last.low <= ema21 - atr15 * 0.5);
  const bullRsiTurn = rsiCur <= 42 && rsiCur > rsiPrev;
  const touchedBullZone = recentWindow.some(c => Number(c.low) <= ema21 + atr15 * 0.35);
  const bullPullbackGo = context1h.regime !== "BEAR_SWING" && touchedBullZone && entry > ema21 && last.close > last.open && last.close > prev.high && rsiCur >= 45 && rsiCur <= 66;
  const bearReversalCandle = last.close < last.open && last.close < prev.low && (last.high >= swingHigh - atr15 * 0.25 || last.high >= ema21 + atr15 * 0.5);
  const bearRsiTurn = rsiCur >= 58 && rsiCur < rsiPrev;
  const touchedBearZone = recentWindow.some(c => Number(c.high) >= ema21 - atr15 * 0.35);
  const bearPullbackGo = context1h.regime !== "BULL_SWING" && touchedBearZone && entry < ema21 && last.close < last.open && last.close < prev.low && rsiCur >= 34 && rsiCur <= 55;
  let side = null, setupType = null, score = 50;
  const reasons = [];
  if ((bullReversalCandle && bullRsiTurn) || bullPullbackGo) {
    side = "LONG";
    if (bullReversalCandle && bullRsiTurn) { setupType = "OSCILLATION_BOTTOM_REVERSAL"; score += 18; reasons.push("بازگشت کندلی از کف نوسانی همراه با چرخش صعودی RSI"); }
    else { setupType = "SWING_PULLBACK_LONG"; score += 15; reasons.push("پولبک به محدوده EMA21 و شکست سقف کندل قبلی در جهت صعود"); }
    if (context1h.regime === "BULL_SWING") { score += 10; reasons.push("هم‌راستایی با روند صعودی ۱ ساعته"); }
    else if (context1h.regime === "RANGE_OSCILLATION") { score += 6; reasons.push("مناسب نوسان‌گیری در محدوده رنج ۱ ساعته"); }
  } else if ((bearReversalCandle && bearRsiTurn) || bearPullbackGo) {
    side = "SHORT";
    if (bearReversalCandle && bearRsiTurn) { setupType = "OSCILLATION_TOP_REVERSAL"; score += 18; reasons.push("بازگشت کندلی از سقف نوسانی همراه با چرخش نزولی RSI"); }
    else { setupType = "SWING_PULLBACK_SHORT"; score += 15; reasons.push("پولبک به محدوده EMA21 و شکست کف کندل قبلی در جهت نزول"); }
    if (context1h.regime === "BEAR_SWING") { score += 10; reasons.push("هم‌راستایی با روند نزولی ۱ ساعته"); }
    else if (context1h.regime === "RANGE_OSCILLATION") { score += 6; reasons.push("مناسب نوسان‌گیری در محدوده رنج ۱ ساعته"); }
  } else return { ok: false, reason: "ستاپ نوسانی دقیق با کندل تأییدی تشکیل نشد" };
  const bodyRatio = last.high - last.low > 0 ? Math.abs(last.close - last.open) / (last.high - last.low) : 0;
  if (bodyRatio >= 0.55) { score += 7; reasons.push("کندل تأییدی دارای بدنه مومنتومی مناسب است"); }
  if (volRatio >= 1 && volRatio <= 2.8) { score += 6; reasons.push("حجم کندل تأییدی در محدوده سالم و معتبر است"); }
  else if (volRatio > 3.5) { score -= 6; reasons.push("جهش حجم بیش‌ازحد؛ احتمال واکنش هیجانی/اسپایک"); }
  const distToEmaAtr = Math.abs(entry - ema21) / atr15;
  if (distToEmaAtr <= 1.2) { score += 5; reasons.push("نقطه ورود نزدیک به محدوده تعادل EMA21 است"); }
  else if (distToEmaAtr > 2.2) { score -= 8; reasons.push("فاصله ورود تا EMA21 زیاد است؛ ریسک تعقیب قیمت"); }
  const buffer = atr15 * 0.25;
  const rawStop = side === "LONG" ? Math.min(swingLow - buffer, entry - atr15 * 1.25) : Math.max(swingHigh + buffer, entry + atr15 * 1.25);
  const risk = side === "LONG" ? entry - rawStop : rawStop - entry, riskPct = risk / entry;
  if (!Number.isFinite(risk) || risk <= 0 || riskPct < config.minRiskPct || riskPct > config.maxRiskPct) return { ok: false, reason: "فاصله حد ضرر خارج از بازه ایمن نوسان‌گیری (۰.۳۵٪ تا ۲.۲٪) است" };
  const dir = side === "LONG" ? 1 : -1;
  const target1 = entry + dir * risk * config.tp1R, target2 = entry + dir * risk * config.tp2R;
  const finalScore = Math.max(0, Math.min(100, Math.round(score)));
  return { ok: true, symbol: config.symbol, asset: config.displaySymbol, side, setupType, regime1h: context1h.regime, entryAccuracyScore: finalScore, entry, stop: rawStop, target1, target2, riskPct: Number((riskPct * 100).toFixed(2)), rsi: Number(rsiCur.toFixed(1)), volumeRatio: Number(volRatio.toFixed(2)), candleTime: last.time, reasons };
}
export function selectDailyBtcSignals(candidates, issuedToday = [], config = BTC_ENGINE_CONFIG) {
  const cooldownMs = config.minCooldownMinutes * 60 * 1000;
  const sorted = [...(Array.isArray(candidates) ? candidates : [])].filter(c => c && c.ok).sort((a,b) => b.entryAccuracyScore - a.entryAccuracyScore);
  const selected = [...issuedToday];
  const canAccept = item => {
    if (selected.length >= config.dailyTargetSignals) return false;
    const t = Number(item.candleTime || Date.now());
    return !selected.some(prev => Math.abs(t - Number(prev.candleTime || 0)) < cooldownMs);
  };
  for (const item of sorted) if (item.entryAccuracyScore >= config.minEntryAccuracyScore && canAccept(item)) selected.push(item);
  if (selected.length < config.dailyTargetSignals) {
    for (const item of sorted) if (item.entryAccuracyScore >= config.fallbackMinAccuracyScore && !selected.includes(item) && canAccept(item)) selected.push(item);
  }
  return selected.slice(0, config.dailyTargetSignals);
}

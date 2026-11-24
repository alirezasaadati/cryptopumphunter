// BTC Swing & Oscillation Futures Signal Engine v2
// Optimized for net profitability after fees:
// 1. Strict 1H regime guard (no counter-trend bottom/top catching in strong trends)
// 2. Wider minimum stop buffer (0.55%) to avoid 5m wick stop-outs
// 3. Realistic swing targets (TP1 = 1.2R [60%], TP2 = 2.2R [40%]) + BE at 0.9R

export const BTC_ENGINE_CONFIG = {
  symbol: "PF_XBTUSD",
  displaySymbol: "BTC",
  leverage: 10,
  dailyTargetSignals: 2,
  minCooldownMinutes: 150,
  minEntryAccuracyScore: 74,
  fallbackMinAccuracyScore: 68,
  tp1R: 1.2,
  tp1Fraction: 0.6,
  tp2R: 2.2,
  tp2Fraction: 0.4,
  beTriggerR: 0.9,
  tp1StopLockR: 0.4,
  minRiskPct: 0.0055,
  maxRiskPct: 0.020
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
  const ema20 = ema(closes, 20);
  const prevEma20 = ema(closes.slice(0, -1), 20);
  const ema50 = ema(closes, 50);
  const atr1h = atr(candles1h, 14);
  if (![ema20, prevEma20, ema50, atr1h].every(Number.isFinite) || atr1h <= 0) return { regime: "UNKNOWN", ema20, ema50, atr1h };
  const lastClose = closes[closes.length - 1];
  const spreadAtr = Math.abs(ema20 - ema50) / atr1h;
  let regime = "RANGE_OSCILLATION";
  if (spreadAtr >= 0.45 && ema20 > ema50 && ema20 >= prevEma20 && lastClose > ema50) regime = "BULL_SWING";
  else if (spreadAtr >= 0.45 && ema20 < ema50 && ema20 <= prevEma20 && lastClose < ema50) regime = "BEAR_SWING";
  return { regime, ema20, ema50, atr1h };
}

export function evaluateBtcSwingSetup(candles15m, candles1h, config = BTC_ENGINE_CONFIG) {
  if (!Array.isArray(candles15m) || candles15m.length < 45) return { ok: false, reason: "داده ۱۵ دقیقه‌ای کافی نیست" };
  const context1h = detect1hContext(candles1h);
  if (context1h.regime === "UNKNOWN") return { ok: false, reason: "روند زمینه ۱ ساعته نامشخص است" };
  const closes = candles15m.map(c => Number(c.close));
  const last = candles15m[candles15m.length - 1], prev = candles15m[candles15m.length - 2];
  const ema21 = ema(closes, 21);
  const rsiCur = rsi(closes, 14);
  const rsiPrev = rsi(closes.slice(0, -1), 14);
  const atr15 = atr(candles15m, 14);
  const volAvg = sma(candles15m.slice(-21, -1).map(c => Number(c.volume || 0)), 20);
  if (![ema21, rsiCur, rsiPrev, atr15].every(Number.isFinite) || atr15 <= 0) return { ok: false, reason: "اندیکاتورهای ۱۵ دقیقه‌ای نامعتبر هستند" };
  const entry = Number(last.close);
  const range = Math.max(0, Number(last.high) - Number(last.low));
  if (range <= 0) return { ok: false, reason: "کندل بدون دامنه نوسان است" };
  const bullClosePos = (entry - Number(last.low)) / range;
  const bearClosePos = (Number(last.high) - entry) / range;
  const volRatio = volAvg && volAvg > 0 ? Number(last.volume || 0) / volAvg : 1;
  const recentWindow = candles15m.slice(-14, -1);
  const swingLow = Math.min(...recentWindow.map(c => Number(c.low)));
  const swingHigh = Math.max(...recentWindow.map(c => Number(c.high)));
  const allowLong = context1h.regime !== "BEAR_SWING";
  const bullReversalCandle = allowLong && bullClosePos >= 0.65 && last.close > last.open && last.close > prev.high &&
    (last.low <= swingLow + atr15 * 0.2 || last.low <= ema21 - atr15 * 0.65);
  const bullRsiTurn = rsiCur <= 40 && rsiCur > rsiPrev + 1.5;
  const touchedBullZone = recentWindow.some(c => Number(c.low) <= ema21 + atr15 * 0.3);
  const bullPullbackGo = allowLong && bullClosePos >= 0.65 && touchedBullZone && entry > ema21 &&
    last.close > last.open && last.close > prev.high && rsiCur >= 46 && rsiCur <= 64;
  const allowShort = context1h.regime !== "BULL_SWING";
  const bearReversalCandle = allowShort && bearClosePos >= 0.65 && last.close < last.open && last.close < prev.low &&
    (last.high >= swingHigh - atr15 * 0.2 || last.high >= ema21 + atr15 * 0.65);
  const bearRsiTurn = rsiCur >= 60 && rsiCur < rsiPrev - 1.5;
  const touchedBearZone = recentWindow.some(c => Number(c.high) >= ema21 - atr15 * 0.3);
  const bearPullbackGo = allowShort && bearClosePos >= 0.65 && touchedBearZone && entry < ema21 &&
    last.close < last.open && last.close < prev.low && rsiCur >= 36 && rsiCur <= 54;
  let side = null, setupType = null, score = 50;
  const reasons = [];
  if ((bullReversalCandle && bullRsiTurn) || bullPullbackGo) {
    side = "LONG";
    if (bullReversalCandle && bullRsiTurn) { setupType = "OSCILLATION_BOTTOM_REVERSAL"; score += 18; reasons.push("بازگشت قوی از کف نوسانی با بسته شدن در یک‌سوم بالایی و چرخش RSI"); }
    else { setupType = "SWING_PULLBACK_LONG"; score += 16; reasons.push("پولبک معتبر به EMA21 و شکست سقف کندل قبلی در جهت صعود"); }
    score += context1h.regime === "BULL_SWING" ? 12 : 6;
  } else if ((bearReversalCandle && bearRsiTurn) || bearPullbackGo) {
    side = "SHORT";
    if (bearReversalCandle && bearRsiTurn) { setupType = "OSCILLATION_TOP_REVERSAL"; score += 18; reasons.push("بازگشت قوی از سقف نوسانی با بسته شدن در یک‌سوم پایینی و چرخش RSI"); }
    else { setupType = "SWING_PULLBACK_SHORT"; score += 16; reasons.push("پولبک معتبر به EMA21 و شکست کف کندل قبلی در جهت نزول"); }
    score += context1h.regime === "BEAR_SWING" ? 12 : 6;
  } else return { ok: false, reason: "ستاپ نوسانی هم‌جهت با فیلتر ۱ ساعته تشکیل نشد" };
  if (volRatio >= 0.95 && volRatio <= 2.6) { score += 7; reasons.push("حجم کندل تأیید در محدوده سالم است"); }
  else if (volRatio < 0.7 || volRatio > 3.5) { score -= 7; reasons.push("حجم کندل تأیید غیرعادی است"); }
  const distToEmaAtr = Math.abs(entry - ema21) / atr15;
  if (distToEmaAtr <= 1.1) score += 6;
  else if (distToEmaAtr > 1.9) score -= 8;
  const buffer = atr15 * 0.4;
  const rawStop = side === "LONG" ? Math.min(swingLow - buffer, entry - atr15 * 1.45) : Math.max(swingHigh + buffer, entry + atr15 * 1.45);
  const risk = side === "LONG" ? entry - rawStop : rawStop - entry;
  const riskPct = risk / entry;
  if (!Number.isFinite(risk) || risk <= 0 || riskPct < config.minRiskPct || riskPct > config.maxRiskPct) return { ok: false, reason: "فاصله حد ضرر خارج از بازه بهینه ۰.۵۵٪ تا ۲.۰٪ است" };
  const dir = side === "LONG" ? 1 : -1;
  const target1 = entry + dir * risk * config.tp1R, target2 = entry + dir * risk * config.tp2R;
  return {
    ok: true, symbol: config.symbol, asset: config.displaySymbol, side, setupType, regime1h: context1h.regime,
    entryAccuracyScore: Math.max(0, Math.min(100, Math.round(score))), entry, stop: rawStop, target1, target2,
    exitPlan: { tp1R: config.tp1R, tp1Fraction: config.tp1Fraction, tp2R: config.tp2R, tp2Fraction: config.tp2Fraction, beTriggerR: config.beTriggerR, tp1StopLockR: config.tp1StopLockR },
    riskPct: Number((riskPct * 100).toFixed(2)), rsi: Number(rsiCur.toFixed(1)), volumeRatio: Number(volRatio.toFixed(2)),
    candleTime: last.time, reasons
  };
}

export function selectDailyBtcSignals(candidates, issuedToday = [], config = BTC_ENGINE_CONFIG) {
  const cooldownMs = config.minCooldownMinutes * 60 * 1000;
  const sorted = [...(Array.isArray(candidates) ? candidates : [])].filter(c => c && c.ok).sort((a, b) => b.entryAccuracyScore - a.entryAccuracyScore);
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
// Rabbit v2: experimental counter-trend SHORT engine for corrections after bullish impulses.
// Pure analysis only. No exchange calls, order execution, or changes to Kraken/V4.8.
const DEFAULTS = Object.freeze({
  minBullTrendBars: 60,
  surgeLookback: 8,
  minSurgePct: 1.5,
  minSurgeAtr: 1.8,
  minExtensionAtr: 1.2,
  minRsiPeak15m: 65,
  minVolumeRatio: 0.7,
  stopBufferAtr: 0.2,
  minRiskPct: 0.2,
  maxRiskPct: 7.0,
  maxEntryDriftPct: 1.5,
  maxCorrectionDelayBars: 4,
  minScore: 65,
  requirePriorLowBreakdown: true
});

function finitePositive(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0;
}
function ema(values, period) {
  if (!Array.isArray(values) || values.length < period) return null;
  const k = 2 / (period + 1);
  let value = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) value = values[i] * k + value * (1 - k);
  return value;
}
function rsi(values, period = 14) {
  if (!Array.isArray(values) || values.length <= period) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1];
    gains += Math.max(d, 0);
    losses += Math.max(-d, 0);
  }
  let avgGain = gains / period, avgLoss = losses / period;
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
  }
  if (avgGain === 0 && avgLoss === 0) return 50;
  if (avgLoss === 0) return 100;
  if (avgGain === 0) return 0;
  return 100 - 100 / (1 + avgGain / avgLoss);
}
function atr(candles, period = 14) {
  if (!Array.isArray(candles) || candles.length <= period) return null;
  const ranges = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], previousClose = Number(candles[i - 1].close);
    ranges.push(Math.max(
      Number(c.high) - Number(c.low),
      Math.abs(Number(c.high) - previousClose),
      Math.abs(Number(c.low) - previousClose)
    ));
  }
  const recent = ranges.slice(-period);
  return recent.length === period ? recent.reduce((a, b) => a + b, 0) / period : null;
}
function candleTimeMs(candle) {
  const raw = Number(candle?.time ?? candle?.timestamp ?? candle?.openTime);
  if (!Number.isFinite(raw) || raw <= 0) return null;
  return raw < 1e12 ? raw * 1000 : raw;
}
function validCandles(candles) {
  return Array.isArray(candles) && candles.every(c => {
    const o = Number(c?.open), h = Number(c?.high), l = Number(c?.low);
    const close = Number(c?.close), volume = Number(c?.volume ?? 0);
    return [o, h, l, close, volume].every(Number.isFinite) &&
      o > 0 && h > 0 && l > 0 && close > 0 && volume >= 0 &&
      h >= l && h >= o && h >= close && l <= o && l <= close;
  });
}
function reject(reason, diagnostics = {}, nextState) {
  const result = { eligible: false, engine: "Rabbit", side: "SHORT", rejected: reason, diagnostics };
  if (nextState !== undefined) result.nextState = nextState;
  return result;
}

// Finds a completed impulse whose highest high occurred within the allowed correction delay.
// The impulse is exactly surgeLookback candles ending at the peak; pre-surge EMA excludes
// the first impulse candle. All measurements use data available no later than the peak.
function findRecentSurge(candles, currentIndex, cfg) {
  const firstPeak = Math.max(cfg.surgeLookback - 1, currentIndex - cfg.maxCorrectionDelayBars);
  for (let peakIndex = currentIndex - 1; peakIndex >= firstPeak; peakIndex--) {
    const startIndex = peakIndex - cfg.surgeLookback + 1;
    const impulse = candles.slice(startIndex, peakIndex + 1);
    if (impulse.length !== cfg.surgeLookback) continue;
    const peakHigh = Math.max(...impulse.map(c => Number(c.high)));
    const peakCandle = impulse[impulse.length - 1];
    if (Number(peakCandle.high) < peakHigh) continue;

    // A later higher high means this was not the latest completed impulse peak.
    const laterHigh = Math.max(...candles.slice(peakIndex + 1, currentIndex).map(c => Number(c.high)), -Infinity);
    if (laterHigh > peakHigh) continue;

    const atrAtPeak = atr(candles.slice(0, peakIndex + 1), 14);
    const preSurgeCloses = candles.slice(0, startIndex).map(c => Number(c.close));
    const preSurgeEma20 = ema(preSurgeCloses, 20);
    const rsiAtPeak = rsi(candles.slice(0, peakIndex + 1).map(c => Number(c.close)), 14);
    const surgeStart = Number(candles[startIndex].open);
    if (![atrAtPeak, preSurgeEma20, rsiAtPeak, surgeStart].every(Number.isFinite) ||
        atrAtPeak <= 0 || surgeStart <= 0) continue;

    const surgePct = (peakHigh / surgeStart - 1) * 100;
    const surgeAtr = (peakHigh - surgeStart) / atrAtPeak;
    const extensionAtr = (peakHigh - preSurgeEma20) / atrAtPeak;
    if (surgePct < cfg.minSurgePct || surgeAtr < cfg.minSurgeAtr ||
        extensionAtr < cfg.minExtensionAtr || rsiAtPeak < cfg.minRsiPeak15m) continue;

    const peakTime = candleTimeMs(candles[peakIndex]);
    const startTime = candleTimeMs(candles[startIndex]);
    if (peakTime == null || startTime == null) continue;
    return {
      surgeStart, surgeHigh: peakHigh, surgePct, surgeAtr, extensionAtr,
      rsiPeak: rsiAtPeak, atrAtPeak, preSurgeEma20, peakTime, startTime,
      peakIndex, startIndex
    };
  }
  return null;
}

export function analyzeRabbitCorrection(input = {}, overrides = {}) {
  const cfg = { ...DEFAULTS, ...overrides };
  const one = input.candles1h, four = input.candles4h, fifteen = input.candles15m;
  const symbol = String(input.symbol || "UNKNOWN");
  const nextState = input.state && typeof input.state === "object" && !Array.isArray(input.state)
    ? { ...input.state } : {};

  const configValid = Number.isInteger(cfg.surgeLookback) && cfg.surgeLookback >= 2 &&
    Number.isInteger(cfg.maxCorrectionDelayBars) && cfg.maxCorrectionDelayBars >= 1 &&
    Number.isFinite(cfg.minScore) && Number.isFinite(cfg.maxRiskPct);
  if (!configValid) return reject("تنظیمات Rabbit معتبر نیستند", {}, nextState);
  if (!Array.isArray(one) || !Array.isArray(four) || !Array.isArray(fifteen) ||
      one.length < cfg.minBullTrendBars || four.length < cfg.minBullTrendBars || fifteen.length < 40) {
    return reject("داده بسته‌شده ۱ساعته، ۴ساعته یا ۱۵دقیقه‌ای کافی نیست", {}, nextState);
  }
  if (!validCandles(one) || !validCandles(four) || !validCandles(fifteen)) {
    return reject("داده OHLCV نامعتبر است", {}, nextState);
  }
  const btcRegime = input.btcRegime;
  if (!btcRegime || btcRegime.ok !== true || btcRegime.longAllowed !== true) {
    return reject("رژیم کلی BTC صعودیِ تأییدشده نیست؛ Rabbit غیرفعال است",
      { btcRegime: btcRegime || null }, nextState);
  }

  const c1 = one.map(c => Number(c.close)), c4 = four.map(c => Number(c.close));
  const c15 = fifteen.map(c => Number(c.close));
  const last1 = one[one.length - 1], last4 = four[four.length - 1], last15 = fifteen[fifteen.length - 1];
  const e20_1 = ema(c1, 20), e50_1 = ema(c1, 50);
  const e20_4 = ema(c4, 20), e50_4 = ema(c4, 50);
  if (![e20_1, e50_1, e20_4, e50_4].every(Number.isFinite)) {
    return reject("محاسبه روند بالادستی معتبر نیست", {}, nextState);
  }
  const bullish1h = e20_1 > e50_1 && Number(last1.close) > e20_1;
  const bullish4h = e20_4 > e50_4 && Number(last4.close) > e20_4;
  if (!bullish1h || !bullish4h) {
    return reject("Rabbit فقط در روند صعودی هم‌جهت ۱ساعته و ۴ساعته فعال می‌شود",
      { bullish1h, bullish4h, e20_1h: e20_1, e50_1h: e50_1, e20_4h: e20_4, e50_4h: e50_4 }, nextState);
  }

  const currentIndex = fifteen.length - 1;
  const currentTime = candleTimeMs(last15);
  if (currentTime == null) return reject("timestamp کندل ۱۵دقیقه‌ای موجود نیست", {}, nextState);
  const e9 = ema(c15, 9), e20 = ema(c15, 20);
  if (![e9, e20].every(Number.isFinite)) return reject("EMAهای ۱۵دقیقه‌ای معتبر نیستند", {}, nextState);

  const workingState = nextState[symbol] && typeof nextState[symbol] === "object"
    ? { ...nextState[symbol] } : null;
  let activeState = workingState;
  const candidate = findRecentSurge(fifteen, currentIndex, cfg);

  if (activeState) {
    const ageMs = currentTime - Number(activeState.peakTime);
    const ageBars = ageMs >= 0 ? Math.floor(ageMs / 900000) : Infinity;
    if (!Number.isFinite(ageMs) || ageMs < 0 || ageBars > cfg.maxCorrectionDelayBars) {
      activeState = null;
    }
  }
  // A genuinely newer valid impulse replaces the old setup even when its absolute high is lower.
  if (candidate && (!activeState || candidate.peakTime > Number(activeState.peakTime))) {
    activeState = {
      ...candidate,
      consumed: false,
      registeredAt: currentTime
    };
  }
  nextState[symbol] = activeState;

  if (!activeState) {
    return reject("جهش معتبر و فعال برای اصلاح شناسایی نشد",
      { candidateFound: Boolean(candidate), maxCorrectionDelayBars: cfg.maxCorrectionDelayBars }, nextState);
  }
  const barsSincePeak = Math.floor((currentTime - Number(activeState.peakTime)) / 900000);
  if (activeState.consumed) {
    return reject("سیگنال این جهش قبلاً مصرف شده است", { barsSincePeak, peakTime: activeState.peakTime }, nextState);
  }

  const atr15 = Number(activeState.atrAtPeak);
  const bearish = Number(last15.close) < Number(last15.open);
  const breakdown = Number(last15.close) < e9;
  const previousCandles = fifteen.slice(-3, -1);
  const priorLow = previousCandles.length === 2
    ? Math.min(...previousCandles.map(c => Number(c.low))) : Infinity;
  const priorLowBroken = Number(last15.close) < priorLow;
  const breakdownOk = bearish && breakdown &&
    (!cfg.requirePriorLowBreakdown || priorLowBroken);
  if (!breakdownOk) {
    return reject("شروع اصلاح هنوز تأیید نشده است",
      { bearishCandle: bearish, belowEma9: breakdown, priorLowBroken, priorLow,
        requirePriorLowBreakdown: cfg.requirePriorLowBreakdown, barsSincePeak }, nextState);
  }

  const priorVolumes = fifteen.slice(-21, -1).map(c => Number(c.volume || 0));
  const avgVolume = priorVolumes.length ? priorVolumes.reduce((a, b) => a + b, 0) / priorVolumes.length : 0;
  const volumeRatio = avgVolume > 0 ? Number(last15.volume || 0) / avgVolume : 0;
  if (volumeRatio < cfg.minVolumeRatio) {
    return reject("حجم کندل تأیید اصلاح پایین‌تر از حداقل است",
      { volumeRatio, requiredVolumeRatio: cfg.minVolumeRatio }, nextState);
  }

  const entry = Number(input.price ?? input.ticker?.last ?? last15.close);
  if (!finitePositive(entry)) return reject("قیمت ورود معتبر نیست", {}, nextState);
  const driftPct = Math.abs(entry - Number(last15.close)) / Number(last15.close) * 100;
  if (driftPct > cfg.maxEntryDriftPct) {
    return reject("قیمت از کندل تأیید بیش از حد فاصله گرفته است", { driftPct }, nextState);
  }

  const stop = Number(activeState.surgeHigh) + atr15 * cfg.stopBufferAtr;
  const risk = stop - entry;
  const riskPct = risk / entry * 100;
  if (!(risk > 0) || riskPct < cfg.minRiskPct || riskPct > cfg.maxRiskPct) {
    return reject("فاصله حد ضرر برای Rabbit خارج از محدوده ایمنی است",
      { riskPct, stop, entry, maxRiskPct: cfg.maxRiskPct }, nextState);
  }

  const surgePct = Number(activeState.surgePct);
  const extensionAtr = Number(activeState.extensionAtr);
  const rsiPeak = Number(activeState.rsiPeak);
  const score = Math.min(100, Math.round(
    40 +
    Math.min(25, (surgePct / cfg.minSurgePct) * 10) +
    Math.min(15, (extensionAtr / cfg.minExtensionAtr) * 8) +
    Math.min(10, Math.max(0, rsiPeak - 60)) +
    Math.min(10, volumeRatio * 4)
  ));
  if (score < cfg.minScore) {
    return reject("امتیاز ستاپ Rabbit به حداقل لازم نرسید", { score, minScore: cfg.minScore }, nextState);
  }

  activeState = { ...activeState, consumed: true, consumedAt: currentTime };
  nextState[symbol] = activeState;
  return {
    eligible: true,
    engine: "Rabbit",
    side: "SHORT",
    strategy: "BULL_RALLY_CORRECTION",
    score,
    riskLevel: "EXPERIMENTAL",
    entry,
    price: entry,
    stop,
    target1: entry - risk,
    target2: entry - risk * 1.5,
    target3: entry - risk * 2,
    rewardRisk: 1,
    riskPct,
    rsiPeak15m: rsiPeak,
    atr15m: atr15,
    surgePct,
    surgeAtr: Number(activeState.surgeAtr),
    extensionAtr,
    volumeRatio,
    ema9_15m: e9,
    ema20PreSurge: Number(activeState.preSurgeEma20 ?? NaN),
    barsSincePeak,
    surgePeakTime: activeState.peakTime,
    reasons: [
      "روند ۱ساعته و ۴ساعته هر دو صعودی است",
      "جهش صعودی ۸ کندلی و فاصله غیرعادی از EMA20 پیش از جهش شناسایی شد",
      "کندل ۱۵دقیقه‌ای نزولی زیر EMA9 بسته شد" +
        (cfg.requirePriorLowBreakdown ? " و کف دو کندل قبلی را شکست" : ""),
      "RSI در سقف جهش و حجم کندل اصلاح، ستاپ را تأیید کردند"
    ],
    nextState
  };
}

export const RABBIT_DEFAULTS = DEFAULTS;
export { ema as rabbitEma, rsi as rabbitRsi, atr as rabbitAtr };

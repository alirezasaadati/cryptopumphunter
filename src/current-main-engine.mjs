// Isolated exact copy of the production main-branch signal analysis code.
// Extracted verbatim from src/index.js; no strategy logic edits.
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
  if (values.length <= period) return null;

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const change = values[i] - values[i - 1];
    gains += Math.max(change, 0);
    losses += Math.max(-change, 0);
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (let i = period + 1; i < values.length; i++) {
    const change = values[i] - values[i - 1];

    avgGain =
      (avgGain * (period - 1) + Math.max(change, 0)) / period;

    avgLoss =
      (avgLoss * (period - 1) + Math.max(-change, 0)) / period;
  }

  if (avgLoss === 0) return 100;
  if (avgGain === 0) return 0;

  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function average(values) {
  if (!values.length) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

// ---------------- MULTI-EXCHANGE USDT-M PERPETUAL FUTURES DATA ----------------
// Public market data only. No private credentials and no order endpoints are used.
const FUTURES_CONFIG = {
  BASE_URL: "https://futures.kraken.com/derivatives/api/v3",
  CHARTS_URL: "https://futures.kraken.com/api/charts/v1",
  // Scan all liquid perpetuals, stopping only when the safe execution budget is reached.
  CONCURRENCY: 3,
  MAX_SCAN_DURATION_MS: 180000,
  SCAN_FINALIZATION_RESERVE_MS: 45000,
  REQUEST_TIMEOUT_MS: 12000,
  MAX_SIGNALS_PER_SCAN: 20,
  MIN_QUOTE_VOLUME: 5_000_000,
  KLINE_LIMIT: 120,
  MIN_CANDLES: 60,
  MIN_SCORE: 72,
  // Experimental LONG-only relaxation for demo validation.
  MIN_SCORE_LONG: 65,
  MIN_LONG_VOLUME_RATIO: 0.65,
  MIN_LONG_DISTANCE_FROM_HIGH: 0.003,
  INTERVAL: "1h",
  CONFIRM_INTERVAL: "4h",
  ENTRY_CONFIRM_INTERVAL: "15m",
  SIGNAL_TTL_MINUTES: 60,
  MAX_ENTRY_DRIFT_PCT: 0.35,
  MAX_ENTRY_EMA_DISTANCE_ATR: 3.0,
  MAX_PULLBACK_DISTANCE_ATR: 0.35,
  MAX_RECLAIM_EXTENSION_ATR: 3.0,
  // Separate breakout distance limits: relax LONG only; preserve SHORT at 0.3%.
  MAX_BREAKOUT_DISTANCE_PCT_LONG: 0.5,
  MAX_BREAKOUT_DISTANCE_PCT_SHORT: 0.3
};

const FUTURES_PROVIDER_ORDER = ["Kraken"];

async function krakenFuturesJson(path, label, baseUrl = FUTURES_CONFIG.BASE_URL) {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(FUTURES_CONFIG.REQUEST_TIMEOUT_MS)
  });
  const body = await response.text();
  let data;
  try {
    data = JSON.parse(body);
  } catch {
    throw new Error(`${label}: پاسخ JSON معتبر نیست؛ HTTP ${response.status}`);
  }
  if (!response.ok) {
    throw new Error(`${label}: HTTP ${response.status}`);
  }
  if (data?.result === "error" || (Array.isArray(data?.errors) && data.errors.length)) {
    throw new Error(`${label}: ${(data.errors || []).join(", ") || data.error || "خطای Kraken"}`);
  }
  return data;
}

function isKrakenPerpetualTicker(item) {
  if (!item || item.tag !== "perpetual" || item.suspended === true) return false;
  const symbol = String(item.symbol || "").toUpperCase();
  // Kraken perpetual contracts use PI_ (inverse) or PF_ (multi-collateral) symbols.
  if (!/^(PI|PF)_[A-Z0-9]+USD$/.test(symbol)) return false;
  const quoteVolume = Number(item.volumeQuote);
  const last = Number(item.last);
  return Number.isFinite(quoteVolume) && quoteVolume >= FUTURES_CONFIG.MIN_QUOTE_VOLUME &&
    Number.isFinite(last) && last > 0;
}

async function getKrakenFuturesUniverse() {
  const data = await krakenFuturesJson("/tickers", "Kraken Futures tickers");
  if (!Array.isArray(data?.tickers)) {
    throw new Error("فهرست نمادهای Kraken Futures معتبر نیست.");
  }
  return data.tickers
    .filter(isKrakenPerpetualTicker)
    .sort((a, b) => Number(b.volumeQuote) - Number(a.volumeQuote))
    .map(t => ({
      ...t,
      priceChangePercent: Number(t.change24h) || 0,
      quoteVolume: Number(t.volumeQuote) || 0,
      premium: { lastFundingRate: Number(t.fundingRate) }
    }));
}

async function getKrakenFuturesCandles(symbol, interval) {
  const url = `${FUTURES_CONFIG.CHARTS_URL}/trade/${encodeURIComponent(symbol)}/${encodeURIComponent(interval)}`;
  const data = await krakenFuturesJson(url.replace(FUTURES_CONFIG.CHARTS_URL, ""),
    `Kraken ${symbol} ${interval}`, FUTURES_CONFIG.CHARTS_URL);
  if (!Array.isArray(data?.candles)) {
    throw new Error(`ساختار کندل‌های Kraken برای ${symbol} معتبر نیست.`);
  }
  const candles = data.candles.map(row => ({
    time: Number(row.time) < 1e12 ? Number(row.time) * 1000 : Number(row.time),
    open: Number(row.open),
    high: Number(row.high),
    low: Number(row.low),
    close: Number(row.close),
    volume: Number(row.volume)
  })).filter(c =>
    Number.isFinite(c.time) && Number.isFinite(c.close) && c.close > 0 &&
    Number.isFinite(c.high) && Number.isFinite(c.low) && c.high >= c.low && c.low > 0 &&
    Number.isFinite(c.volume) && c.volume >= 0
  ).sort((a, b) => a.time - b.time);

  // Exclude the currently forming candle. Kraken chart responses may include it.
  const intervalMsMap={"1m":60000,"5m":300000,"15m":900000,"30m":1800000,"1h":3600000,"4h":14400000,"12h":43200000,"1d":86400000,"1w":604800000};
  const intervalMs=intervalMsMap[interval]||3600000;
  const now = Date.now();
  return candles.filter(c => c.time + intervalMs <= now);
}


function normalizeKrakenFuturesUnderlying(symbol) {
  const raw = String(symbol || "").toUpperCase().replace(/^(PI|PF)_/, "").replace(/USD$/, "");
  return raw === "XBT" ? "BTC" : raw;
}

async function getFuturesUniverse() {
  return { exchange: "Kraken", tickers: await getKrakenFuturesUniverse(), fallbackReason: null };
}

async function getFuturesCandles(exchange, symbol, interval) {
  if (exchange !== "Kraken") throw new Error(`منبع داده ناشناخته: ${exchange}`);
  return getKrakenFuturesCandles(symbol, interval);
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

function evaluateFuturesEntryFilters({ ticker, candles1h, candles15m, side, referencePrice, ema20, atr }) {
  const marketPrice = Number(ticker?.last);
  if (!Number.isFinite(marketPrice) || marketPrice <= 0) {
    return { ok: false, rejected: "قیمت لحظه‌ای بازار معتبر نیست" };
  }
  const driftPct = Math.abs(marketPrice - referencePrice) / referencePrice * 100;
  if (driftPct > FUTURES_CONFIG.MAX_ENTRY_DRIFT_PCT) {
    return { ok: false, rejected: "فاصله قیمت لحظه‌ای تا قیمت تحلیلی بیش از حد مجاز است", driftPct };
  }

  const emaDistanceAtr = Math.abs(marketPrice - ema20) / atr;
  if (emaDistanceAtr > FUTURES_CONFIG.MAX_ENTRY_EMA_DISTANCE_ATR) {
    return { ok: false, rejected: "ورود دیرهنگام است؛ قیمت بیش از حد از EMA20 فاصله دارد", driftPct, emaDistanceAtr };
  }

  const has15mData = Array.isArray(candles15m) && candles15m.length >= 30;
  if (!has15mData) {
    return { ok: true, driftPct, emaDistanceAtr, momentumConfirmed: false, pullbackConfirmed: false, confirmationUnavailable: true };
  }
  const closes15m = candles15m.map(c => c.close);
  const ema9_15m = ema(closes15m, 9);
  const ema21_15m = ema(closes15m, 21);
  const atr15m = calculateAtr(candles15m, 14);
  const last15m = candles15m[candles15m.length - 1];
  const recentPullback = candles15m.slice(-9, -1);
  if (![ema9_15m, ema21_15m, atr15m].every(Number.isFinite) || atr15m <= 0 || !recentPullback.length) {
    return { ok: true, driftPct, emaDistanceAtr, momentumConfirmed: false, pullbackConfirmed: false, confirmationUnavailable: true };
  }

  const aligned = side === "LONG"
    ? ema9_15m > ema21_15m && last15m.close > ema9_15m && last15m.close > last15m.open
    : ema9_15m < ema21_15m && last15m.close < ema9_15m && last15m.close < last15m.open;
  const touchedPullbackZone = side === "LONG"
    ? recentPullback.some(c => c.low <= ema21_15m + atr15m * FUTURES_CONFIG.MAX_PULLBACK_DISTANCE_ATR)
    : recentPullback.some(c => c.high >= ema21_15m - atr15m * FUTURES_CONFIG.MAX_PULLBACK_DISTANCE_ATR);

  const reclaimExtensionAtr = side === "LONG"
    ? (last15m.close - ema9_15m) / atr15m
    : (ema9_15m - last15m.close) / atr15m;
  if (reclaimExtensionAtr > FUTURES_CONFIG.MAX_RECLAIM_EXTENSION_ATR) {
    return { ok: false, rejected: "قیمت پس از حرکت تأییدی بیش از حد از محدوده ورود فاصله گرفته است", driftPct, emaDistanceAtr, reclaimExtensionAtr };
  }

  return { ok: true, driftPct, emaDistanceAtr, reclaimExtensionAtr, ema9_15m, ema21_15m, atr15m,
    momentumConfirmed: aligned, pullbackConfirmed: touchedPullbackZone };
}

function findLatestConfirmed15mPivot(candles, side, left = 3, right = 3) {
  if (!Array.isArray(candles) || candles.length < left + right + 1) return null;
  const field = side === "LONG" ? "high" : "low";
  for (let i = candles.length - right - 1; i >= left; i--) {
    const value = Number(candles[i]?.[field]);
    if (!Number.isFinite(value)) continue;
    let pivot = true;
    for (let j = i - left; j <= i + right; j++) {
      if (j === i) continue;
      const neighbor = Number(candles[j]?.[field]);
      if (!Number.isFinite(neighbor) || (side === "LONG" ? neighbor >= value : neighbor <= value)) {
        pivot = false;
        break;
      }
    }
    if (pivot) return { index: i, time: candles[i].time, price: value, type: side === "LONG" ? "swing_high" : "swing_low" };
  }
  return null;
}

function passesLongDistanceThreshold(side, candles1h, threshold = 0.005) {
  // Keep SHORT behavior unchanged. LONG uses the signal candle close versus
  // the maximum High of the last three completed 1h candles, matching backtests.
  if (side !== "LONG") return true;
  if (!Array.isArray(candles1h) || candles1h.length < 3) return false;
  const last3 = candles1h.slice(-3);
  const referencePrice = Number(last3[2]?.close);
  const maxHigh = Math.max(...last3.map(c => Number(c?.high)));
  if (!Number.isFinite(referencePrice) || !Number.isFinite(maxHigh) || maxHigh <= 0) return false;
  const distance = Math.abs(referencePrice - maxHigh) / maxHigh;
  return Number.isFinite(distance) && distance >= threshold;
}

function analyzeFuturesSymbol(ticker, candles1h, candles4h, candles15m, options = {}) {
  if (candles1h.length < FUTURES_CONFIG.MIN_CANDLES || candles4h.length < FUTURES_CONFIG.MIN_CANDLES) {
    throw new Error("تعداد کندل بسته‌شده برای تحلیل ۱ساعته/۴ساعته کافی نیست.");
  }
  const closes1h = candles1h.map(c => c.close);
  const closes4h = candles4h.map(c => c.close);
  const last = candles1h[candles1h.length - 1];
  const referencePrice = last.close;
  const e20 = ema(closes1h, 20);
  const e50 = ema(closes1h, 50);
  const e20_4h = ema(closes4h, 20);
  const e50_4h = ema(closes4h, 50);
  const rsiValue = rsi(closes1h, 14);
  const atr = calculateAtr(candles1h, 14);
  if ([e20, e50, e20_4h, e50_4h, rsiValue, atr].some(v => !Number.isFinite(v)) || atr <= 0) {
    throw new Error("محاسبه اندیکاتورها معتبر نیست.");
  }

  const avgVol = average(candles1h.slice(-21, -1).map(c => c.volume));
  const volumeRatio = avgVol > 0 ? last.volume / avgVol : 0;
  const up1h = e20 > e50 && referencePrice > e20;
  const down1h = e20 < e50 && referencePrice < e20;
  const up4h = e20_4h > e50_4h;
  const down4h = e20_4h < e50_4h;
  let side = null;
  let score = 0;
  const reasons = [];

  const strictLong = up1h && up4h && rsiValue >= 48 && rsiValue <= 69;
  const strictShort = down1h && down4h && rsiValue >= 31 && rsiValue <= 52;
  const relaxedLong = up1h && !down4h && rsiValue >= 42 && rsiValue <= 72;
  const relaxedShort = down1h && !up4h && rsiValue >= 25 && rsiValue <= 60;
  const strictSetup = strictLong || strictShort;

  if (strictLong || (!strictSetup && relaxedLong)) {
    side = "LONG";
    score = strictSetup ? 45 : 40;
    reasons.push(strictSetup
      ? "روند ۱ساعته و ۴ساعته صعودی است"
      : "ستاپ آزمایشی: روند ۱ساعته صعودی و روند ۴ساعته مخالف نیست",
      "قیمت بالای EMA20 قرار دارد");
    score += rsiValue >= 52 && rsiValue <= 65 ? 15 : 9;
  } else if (strictShort || (!strictSetup && relaxedShort)) {
    side = "SHORT";
    score = strictSetup ? 45 : 40;
    reasons.push(strictSetup
      ? "روند ۱ساعته و ۴ساعته نزولی است"
      : "ستاپ آزمایشی: روند ۱ساعته نزولی و روند ۴ساعته مخالف نیست",
      "قیمت زیر EMA20 قرار دارد");
    score += rsiValue >= 35 && rsiValue <= 48 ? 15 : 9;
  } else {
    return { symbol: ticker.symbol, rejected: "حتی شرایط منعطف آزمایشی روند و RSI نیز تأیید نشد" };
  }

  if (volumeRatio >= 1.5) { score += 18; reasons.push("حجم بالاتر از میانگین است"); }
  else if (volumeRatio >= 1.0) { score += 12; reasons.push("حجم نزدیک یا بالاتر از میانگین است"); }
  else { score += 4; reasons.push("حجم کمتر از میانگین است"); }

  const change = Number(ticker.priceChangePercent) || 0;
  if ((side === "LONG" && change > 0) || (side === "SHORT" && change < 0)) score += 8;
  else score += 3;

  const funding = Number(ticker.premium?.lastFundingRate);
  if (Number.isFinite(funding)) {
    if (side === "LONG" && funding > 0.001) { score -= 5; reasons.push("فاندینگ مثبت و نسبتاً بالا؛ ریسک ازدحام لانگ"); }
    else if (side === "SHORT" && funding < -0.001) { score -= 5; reasons.push("فاندینگ منفی و نسبتاً پایین؛ ریسک ازدحام شورت"); }
    else reasons.push("فاندینگ در محدوده افراطی نیست");
  } else {
    reasons.push("داده فاندینگ در دسترس نبود");
  }

  const entryFilters = options.skipEntryFilters
    ? { ok: true, skippedForBaseline: true }
    : evaluateFuturesEntryFilters({ ticker, candles1h, candles15m, side, referencePrice, ema20: e20, atr });
  if (!entryFilters.ok) {
    return { symbol: ticker.symbol, side, score: Math.max(0, Math.min(100, Math.round(score))), rejected: entryFilters.rejected, entryDiagnostics: entryFilters };
  }

  if (!options.skipBreakoutFilter) {
    const breakoutPivot = findLatestConfirmed15mPivot(candles15m, side, 3, 3);
    if (!breakoutPivot) {
      return { symbol: ticker.symbol, side, rejected: "پیوت شکست معتبر ۱۵دقیقه‌ای در دسترس نیست" };
    }
    const breakoutEntryPrice = Number(ticker.last);
    const breakoutDistancePct = side === "LONG"
      ? (breakoutEntryPrice - breakoutPivot.price) / breakoutPivot.price * 100
      : (breakoutPivot.price - breakoutEntryPrice) / breakoutPivot.price * 100;
    const maxBreakoutDistancePct = side === "LONG"
      ? FUTURES_CONFIG.MAX_BREAKOUT_DISTANCE_PCT_LONG
      : FUTURES_CONFIG.MAX_BREAKOUT_DISTANCE_PCT_SHORT;
    if (!Number.isFinite(breakoutDistancePct) || breakoutDistancePct < 0 ||
        breakoutDistancePct > maxBreakoutDistancePct) {
      return {
        symbol: ticker.symbol,
        side,
        rejected: "فاصله ورود تا سطح شکست خارج از محدوده مجاز است",
        breakoutDiagnostics: {
          pivot: breakoutPivot,
          signedDistancePct: breakoutDistancePct,
          maxDistancePct: maxBreakoutDistancePct
        }
      };
    }
    reasons.push(side === "LONG"
      ? "فاصله قیمت از پیوت شکست ۱۵دقیقه‌ای حداکثر ۰٫۵٪ است"
      : "فاصله قیمت از پیوت شکست ۱۵دقیقه‌ای حداکثر ۰٫۳٪ است");
  }
  reasons.push("قیمت لحظه‌ای در محدوده مجاز قیمت تحلیلی است");
  reasons.push("فاصله قیمت از EMA20 برای ورود قابل‌قبول است");
  if (entryFilters.momentumConfirmed && entryFilters.pullbackConfirmed) {
    reasons.push("مومنتوم و پولبک ۱۵دقیقه‌ای تأیید شدند");
  } else {
    reasons.push("تأیید ۱۵دقیقه‌ای کامل نبود؛ سیگنال به‌دلیل آن حذف نشد");
  }

  const entry = options.skipEntryFilters ? referencePrice : Number(ticker.last);
  const swing = candles1h.slice(-8, -1);
  const swingLow = Math.min(...swing.map(c => c.low));
  const swingHigh = Math.max(...swing.map(c => c.high));
  let stop = side === "LONG"
    ? Math.min(swingLow, entry - atr * 1.5)
    : Math.max(swingHigh, entry + atr * 1.5);
  const risk = side === "LONG" ? entry - stop : stop - entry;
  const riskPct = risk / entry;
  if (!Number.isFinite(risk) || risk <= 0 || riskPct < 0.002 || riskPct > 0.08) {
    return { symbol: ticker.symbol, rejected: "فاصله حد ضرر غیرمنطقی است؛ سیگنال صادر نشد" };
  }

  const direction = side === "LONG" ? 1 : -1;
  const target1 = entry + direction * risk * 1.5;
  const target2 = entry + direction * risk * 2.2;
  const target3 = entry + direction * risk * 3;
  score = Math.max(0, Math.min(100, Math.round(score)));
  // LONG uses the relaxed demo gate; SHORT keeps its original strict gate unchanged.
  const eligible = side === "LONG"
    ? (strictLong || (!strictSetup && relaxedLong)) &&
      score >= FUTURES_CONFIG.MIN_SCORE_LONG &&
      volumeRatio >= FUTURES_CONFIG.MIN_LONG_VOLUME_RATIO
    : strictSetup && score >= FUTURES_CONFIG.MIN_SCORE && volumeRatio >= 0.75;
  const longDistanceThreshold = side === "LONG"
    ? FUTURES_CONFIG.MIN_LONG_DISTANCE_FROM_HIGH
    : 0.005;
  if (eligible && !passesLongDistanceThreshold(side, candles1h, longDistanceThreshold)) {
    return {
      symbol: ticker.symbol,
      side,
      score,
      rejected: "فاصله قیمت بسته‌شدن کندل ۱ساعته تا بیشترین High سه کندل تکمیل‌شده کمتر از حد مجاز ۰٫۳٪ است",
      longDistanceThreshold: {
        thresholdPct: longDistanceThreshold * 100,
        referencePrice,
        maxHighLast3: Math.max(...candles1h.slice(-3).map(c => Number(c.high))),
        eligible: false
      },
      eligible: false
    };
  }
  return {
    symbol: ticker.symbol,
    side,
    score,
    price: entry,
    entry,
    stop,
    target1,
    target2,
    target3,
    rewardRisk: 1.5,
    rsi: rsiValue,
    ema20: e20,
    ema50: e50,
    atr,
    volumeRatio,
    funding: Number.isFinite(funding) ? funding : null,
    quoteVolume: Number(ticker.quoteVolume) || 0,
    change24h: change,
    candleTime: last.time,
    reasons,
    entryDiagnostics: entryFilters,
    eligible
  };
}

export { analyzeFuturesSymbol };

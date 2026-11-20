// Pure Price Action engine v2.2 (corrected, short-side hardened).
// No indicators are used for signal decisions. ATR is used ONLY for stop sizing.
export const PA_CONFIG = Object.freeze({
  MIN_CANDLES_4H: 30,
  MIN_CANDLES_1H: 40,
  MIN_CANDLES_15M: 40,
  PIVOT_LEFT: 3,
  PIVOT_RIGHT: 3,
  MAX_SWING_AGE_BARS: 80,
  LEVEL_TOLERANCE_PCT: 0.0018,
  MIN_RISK_PCT: 0.0015,
  MAX_RISK_PCT: 0.06,
  MIN_REWARD_RISK: 1.5,
  TARGET_R_MULTIPLES: [1.5, 2.2, 3],
  MIN_SCORE: 78,
  MIN_SCORE_SHORT: 85,
  VOLUME_LOOKBACK: 20,
  MIN_BREAKOUT_VOLUME_RATIO: 1.1,
  MIN_BREAKOUT_VOLUME_RATIO_SHORT: 1.4,
  MIN_REVERSAL_VOLUME_RATIO: 0.9,
  ATR_PERIOD: 14,
  MIN_STOP_ATR: 1.0,
  MAX_STOP_ATR: 2.5,
  TARGET_LEVEL_BUFFER_PCT: 0.0015,
  TARGET_LEVEL_BUFFER_PCT_SHORT: 0.003,
  MIN_TP1_DISTANCE_R: 1.2,
  REQUIRE_4H_ALIGNMENT: false,
  ALLOW_4H_NEUTRAL: true,
  NEUTRAL_4H_MIN_SCORE: 85,
  MAX_ENTRY_DRIFT_PCT: 0.35
});

const finite = n => Number.isFinite(Number(n));
const median = values => {
  if (!values.length) return 0;
  const a = [...values].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};

export function validateCandles(candles, min = 1) {
  if (!Array.isArray(candles) || candles.length < min) return false;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    if (!c || ![c.open, c.high, c.low, c.close, c.time].every(finite) ||
        Number(c.open) <= 0 || Number(c.low) <= 0 ||
        Number(c.high) < Math.max(Number(c.open), Number(c.close)) ||
        Number(c.low) > Math.min(Number(c.open), Number(c.close))) return false;
    if (i > 0 && Number(c.time) <= Number(candles[i - 1].time)) return false;
  }
  return true;
}

export function calculateAtr(candles, period = PA_CONFIG.ATR_PERIOD) {
  if (!Array.isArray(candles) || candles.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const prev = candles[i - 1], cur = candles[i];
    const tr = Math.max(Number(cur.high) - Number(cur.low),
      Math.abs(Number(cur.high) - Number(prev.close)),
      Math.abs(Number(cur.low) - Number(prev.close)));
    if (Number.isFinite(tr) && tr > 0) trs.push(tr);
  }
  if (trs.length < period) return null;
  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trs.length; i++) atr = (atr * (period - 1) + trs[i]) / period;
  return atr > 0 ? atr : null;
}

export function findSwings(candles, left = PA_CONFIG.PIVOT_LEFT, right = PA_CONFIG.PIVOT_RIGHT) {
  if (!validateCandles(candles, left + right + 3)) return { highs: [], lows: [] };
  const highs = [], lows = [];
  for (let i = left; i < candles.length - right; i++) {
    const c = candles[i];
    const before = candles.slice(i - left, i);
    const after = candles.slice(i + 1, i + right + 1);
    if (before.every(x => c.high > x.high) && after.every(x => c.high >= x.high))
      highs.push({ index: i, time: c.time, price: c.high });
    if (before.every(x => c.low < x.low) && after.every(x => c.low <= x.low))
      lows.push({ index: i, time: c.time, price: c.low });
  }
  return { highs, lows };
}

export function describeStructure(candles) {
  const swings = findSwings(candles);
  const h = swings.highs.slice(-4), l = swings.lows.slice(-4);
  if (h.length < 2 || l.length < 2) return { direction: "UNKNOWN", swings };
  const higherHigh = h.at(-1).price > h.at(-2).price;
  const higherLow = l.at(-1).price > l.at(-2).price;
  const lowerHigh = h.at(-1).price < h.at(-2).price;
  const lowerLow = l.at(-1).price < l.at(-2).price;
  let highMajorityUp = null, lowMajorityUp = null;
  if (h.length >= 3) {
    let up = 0, down = 0;
    for (let i = 1; i < h.length; i++) h[i].price > h[i - 1].price ? up++ : down++;
    highMajorityUp = up >= down;
  }
  if (l.length >= 3) {
    let up = 0, down = 0;
    for (let i = 1; i < l.length; i++) l[i].price > l[i - 1].price ? up++ : down++;
    lowMajorityUp = up >= down;
  }
  const bullish = higherHigh && higherLow && (highMajorityUp !== false && lowMajorityUp !== false);
  const bearish = lowerHigh && lowerLow && (highMajorityUp !== true && lowMajorityUp !== true);
  const direction = bullish ? "BULLISH" : bearish ? "BEARISH" : "RANGE";
  return { direction, higherHigh, higherLow, lowerHigh, lowerLow, swings };
}

function candleDirection(c) { return c.close > c.open ? "LONG" : c.close < c.open ? "SHORT" : null; }
function body(c) { return Math.abs(c.close - c.open); }
function range(c) { return c.high - c.low; }
function lowerWick(c) { return Math.min(c.open, c.close) - c.low; }
function upperWick(c) { return c.high - Math.max(c.open, c.close); }
function near(price, level) { return Math.abs(price - level) / level <= PA_CONFIG.LEVEL_TOLERANCE_PCT; }
function recentMedianRange(candles) { return median(candles.slice(-20).map(range).filter(x => x > 0)); }
function levelBuffer(candles, entry) { return Math.max(recentMedianRange(candles) * 0.18, entry * 0.0005); }

function volumeRatio(candles, lookback = PA_CONFIG.VOLUME_LOOKBACK) {
  if (!Array.isArray(candles) || candles.length < lookback + 1) return null;
  const last = candles.at(-1);
  const prior = candles.slice(-(lookback + 1), -1).map(c => Number(c.volume) || 0);
  const avg = prior.reduce((a, b) => a + b, 0) / prior.length;
  if (!(avg > 0)) return null;
  return Number(last.volume) / avg;
}

function minBreakoutVolume(side) {
  return side === "SHORT" ? PA_CONFIG.MIN_BREAKOUT_VOLUME_RATIO_SHORT : PA_CONFIG.MIN_BREAKOUT_VOLUME_RATIO;
}

function minScoreFor(side) {
  return side === "SHORT" ? PA_CONFIG.MIN_SCORE_SHORT : PA_CONFIG.MIN_SCORE;
}

function nearestBlockingLevel(swings, side, entry, target) {
  const isLong = side === "LONG";
  const levels = isLong
    ? swings.highs.map(x => x.price).filter(p => p > entry && p < target)
    : swings.lows.map(x => x.price).filter(p => p < entry && p > target);
  if (!levels.length) return null;
  return isLong ? Math.min(...levels) : Math.max(...levels);
}

function computeScore({ volumeRatio: vr, structureAligned1H, structureAligned4H, candleQuality, levelProximity }) {
  let score = 0;
  if (vr == null) score += 8;
  else if (vr >= 1.5) score += 20;
  else if (vr >= 1.2) score += 15;
  else if (vr >= 1.0) score += 10;
  else score += 4;
  if (structureAligned1H) score += 25;
  else if (structureAligned1H === null) score += 10;
  if (structureAligned4H) score += 25;
  else if (structureAligned4H === null) score += 12;
  score += Math.max(0, Math.min(15, Math.round(candleQuality * 15)));
  score += Math.max(0, Math.min(15, Math.round(levelProximity * 15)));
  return Math.min(100, Math.max(0, score));
}

function makePlan({ symbol, side, strategyId, strategyName, score, reason, entry, invalidation, atr, candles1h, context }) {
  if (![entry, invalidation].every(finite) || entry <= 0) return null;
  const rawRisk = side === "LONG" ? entry - invalidation : invalidation - entry;
  if (!(rawRisk > 0)) return null;
  let risk = rawRisk;
  if (atr) {
    const minRisk = atr * PA_CONFIG.MIN_STOP_ATR;
    const maxRisk = atr * PA_CONFIG.MAX_STOP_ATR;
    risk = Math.max(minRisk, Math.min(maxRisk, rawRisk));
  }
  const riskPct = risk / entry;
  if (!(risk > 0) || riskPct < PA_CONFIG.MIN_RISK_PCT || riskPct > PA_CONFIG.MAX_RISK_PCT) return null;
  const direction = side === "LONG" ? 1 : -1;
  const rTargets = PA_CONFIG.TARGET_R_MULTIPLES.map(r => entry + direction * risk * r);
  const swings1h = findSwings(candles1h);
  const blocking = nearestBlockingLevel(swings1h, side, entry, rTargets[0]);
  let tp1 = rTargets[0];
  if (blocking != null) {
    const bufferPct = side === "SHORT" ? PA_CONFIG.TARGET_LEVEL_BUFFER_PCT_SHORT : PA_CONFIG.TARGET_LEVEL_BUFFER_PCT;
    const buffered = blocking * (1 - direction * bufferPct);
    const bufferedR = direction * (buffered - entry) / risk;
    if (bufferedR >= PA_CONFIG.MIN_TP1_DISTANCE_R) tp1 = buffered;
  }
  const tp2 = rTargets[1], tp3 = rTargets[2];
  const realRR = Math.abs(tp1 - entry) / risk;
  if (realRR < PA_CONFIG.MIN_REWARD_RISK) return null;
  const stop = side === "LONG" ? entry - risk : entry + risk;
  return {
    symbol, side, strategyId, strategyName, score,
    entry, stop, target1: tp1, target2: tp2, target3: tp3,
    rewardRisk: Number(realRR.toFixed(2)), reason, context,
    timeframes: ["4h", "1h", "15m"], setupTime: context.triggerTime, atr: atr ?? null
  };
}

function bestFreshSwing(swings, side, beforeIndex, maxAge = PA_CONFIG.MAX_SWING_AGE_BARS) {
  const list = side === "LONG" ? swings.lows : swings.highs;
  const minIndex = Math.max(0, beforeIndex - maxAge);
  return [...list].reverse().find(x => x.index < beforeIndex && x.index >= minIndex) || null;
}
function lastClosed(candles) { return candles[candles.length - 1]; }

function aligned1H(structures, side) {
  return side === "LONG"
    ? structures.oneHour === "BULLISH" ? true : structures.oneHour === "RANGE" ? null : false
    : structures.oneHour === "BEARISH" ? true : structures.oneHour === "RANGE" ? null : false;
}
function aligned4H(structures, side) {
  return side === "LONG"
    ? structures.fourHour === "BULLISH" ? true : structures.fourHour === "RANGE" ? null : false
    : structures.fourHour === "BEARISH" ? true : structures.fourHour === "RANGE" ? null : false;
}

function structureStrategy({ symbol, oneHour, fifteenMin, atr, structures }) {
  const swings = findSwings(oneHour);
  const prev = oneHour.at(-2), last = lastClosed(oneHour), trigger = lastClosed(fifteenMin);
  const high = swings.highs.at(-1), low = swings.lows.at(-1);
  let side = null, evidence = "";
  if (high && last.close > high.price && prev.close <= high.price && candleDirection(trigger) === "LONG") {
    side = "LONG"; evidence = "شکست صعودی سقف نوسانی در 1H و تأیید کندل 15M";
  } else if (low && last.close < low.price && prev.close >= low.price && candleDirection(trigger) === "SHORT") {
    side = "SHORT"; evidence = "شکست نزولی کف نوسانی در 1H و تأیید کندل 15M";
  }
  if (!side) return null;
  const vr = volumeRatio(fifteenMin);
  if (vr != null && vr < minBreakoutVolume(side)) return null;
  const swing = bestFreshSwing(swings, side, oneHour.length - 1);
  if (!swing) return null;
  const pad = levelBuffer(fifteenMin, trigger.close);
  const invalidation = side === "LONG" ? swing.price - pad : swing.price + pad;
  const s1H = aligned1H(structures, side), s4H = aligned4H(structures, side);
  const candleQuality = range(trigger) > 0 ? Math.min(1, body(trigger) / range(trigger)) : 0;
  const levelProximity = high && side === "LONG"
    ? 1 - Math.min(1, Math.abs(trigger.close - high.price) / (high.price * 0.01))
    : low && side === "SHORT"
      ? 1 - Math.min(1, Math.abs(trigger.close - low.price) / (low.price * 0.01)) : 0.5;
  const score = computeScore({ volumeRatio: vr, structureAligned1H: s1H, structureAligned4H: s4H, candleQuality, levelProximity });
  return makePlan({ symbol, side, strategyId: "market_structure", strategyName: "ساختار بازار",
    score, reason: evidence, entry: trigger.close, invalidation, atr, candles1h: oneHour,
    context: { oneHourStructure: structures.oneHour, fourHourStructure: structures.fourHour, triggerTime: trigger.time, volumeRatio: vr } });
}

function rejectionStrategy({ symbol, oneHour, fifteenMin, atr, structures }) {
  const swings = findSwings(oneHour);
  const c = lastClosed(fifteenMin);
  const candidates = [
    ...swings.lows.map(x => ({ side: "LONG", level: x.price, index: x.index })),
    ...swings.highs.map(x => ({ side: "SHORT", level: x.price, index: x.index }))
  ].filter(x => x.index < oneHour.length - 2 && oneHour.length - 1 - x.index <= PA_CONFIG.MAX_SWING_AGE_BARS);
  const touched = candidates.filter(x => x.side === "LONG"
    ? c.low <= x.level * (1 + PA_CONFIG.LEVEL_TOLERANCE_PCT) && c.close > x.level
    : c.high >= x.level * (1 - PA_CONFIG.LEVEL_TOLERANCE_PCT) && c.close < x.level);
  const hit = touched.sort((a, b) => Math.abs((a.side === "LONG" ? c.low : c.high) - a.level) -
    Math.abs((b.side === "LONG" ? c.low : c.high) - b.level))[0];
  if (!hit) return null;
  const bullish = hit.side === "LONG" && lowerWick(c) > body(c) * 1.5 && c.close > c.open;
  const bearish = hit.side === "SHORT" && upperWick(c) > body(c) * 1.5 && c.close < c.open;
  if (!(bullish || bearish)) return null;
  const vr = volumeRatio(fifteenMin);
  if (vr != null && vr < PA_CONFIG.MIN_REVERSAL_VOLUME_RATIO) return null;
  const pad = levelBuffer(fifteenMin, c.close);
  const invalidation = hit.side === "LONG" ? Math.min(c.low, hit.level) - pad : Math.max(c.high, hit.level) + pad;
  const s1H = aligned1H(structures, hit.side), s4H = aligned4H(structures, hit.side);
  const candleQuality = range(c) > 0 ? Math.min(1, (hit.side === "LONG" ? lowerWick(c) : upperWick(c)) / range(c)) : 0;
  const levelProximity = 1 - Math.min(1, Math.abs(c.close - hit.level) / (hit.level * 0.01));
  const score = computeScore({ volumeRatio: vr, structureAligned1H: s1H, structureAligned4H: s4H, candleQuality, levelProximity });
  return makePlan({ symbol, side: hit.side, strategyId: "sr_rejection", strategyName: "برگشت از حمایت/مقاومت",
    score, reason: "واکنش و سایه رد قیمت در سطح ساختاری 1H همراه با بسته‌شدن تأییدی 15M",
    entry: c.close, invalidation, atr, candles1h: oneHour,
    context: { level: hit.level, triggerTime: c.time, oneHourStructure: structures.oneHour, fourHourStructure: structures.fourHour, volumeRatio: vr } });
}

function breakoutRetestStrategy({ symbol, oneHour, fifteenMin, atr, structures }) {
  const swings = findSwings(oneHour);
  const c = lastClosed(fifteenMin);
  const h = swings.highs.at(-1), l = swings.lows.at(-1);
  if (!h || !l || oneHour.length < 3) return null;
  const last = lastClosed(oneHour), prev = oneHour.at(-2);
  let side = null, level = null;
  if (prev.close <= h.price && last.close > h.price &&
      c.low <= h.price * (1 + PA_CONFIG.LEVEL_TOLERANCE_PCT) &&
      c.close > h.price && candleDirection(c) === "LONG") { side = "LONG"; level = h.price; }
  else if (prev.close >= l.price && last.close < l.price &&
      c.high >= l.price * (1 - PA_CONFIG.LEVEL_TOLERANCE_PCT) &&
      c.close < l.price && candleDirection(c) === "SHORT") { side = "SHORT"; level = l.price; }
  if (!side) return null;
  const vr = volumeRatio(fifteenMin);
  if (vr != null && vr < PA_CONFIG.MIN_BREAKOUT_VOLUME_RATIO) return null;
  const pad = levelBuffer(fifteenMin, c.close);
  const invalidation = side === "LONG" ? Math.min(c.low, level) - pad : Math.max(c.high, level) + pad;
  const s1H = aligned1H(structures, side), s4H = aligned4H(structures, side);
  const candleQuality = range(c) > 0 ? Math.min(1, body(c) / range(c)) : 0;
  const levelProximity = 1 - Math.min(1, Math.abs(c.close - level) / (level * 0.01));
  const score = computeScore({ volumeRatio: vr, structureAligned1H: s1H, structureAligned4H: s4H, candleQuality, levelProximity });
  return makePlan({ symbol, side, strategyId: "breakout_retest", strategyName: "شکست و پولبک",
    score, reason: "شکست تثبیت‌شده سطح 1H، بازآزمایی سطح و بسته‌شدن 15M در جهت شکست",
    entry: c.close, invalidation, atr, candles1h: oneHour,
    context: { level, triggerTime: c.time, oneHourStructure: structures.oneHour, fourHourStructure: structures.fourHour, volumeRatio: vr } });
}

function candlestickStrategy({ symbol, oneHour, fifteenMin, atr, structures }) {
  const swings = findSwings(oneHour);
  const c = lastClosed(fifteenMin), p = fifteenMin.at(-2);
  const support = swings.lows.at(-1), resistance = swings.highs.at(-1);
  const bullEngulf = c.close > c.open && p.close < p.open && c.open <= p.close && c.close >= p.open;
  const bearEngulf = c.close < c.open && p.close > p.open && c.open >= p.close && c.close <= p.open;
  const bullPin = lowerWick(c) > body(c) * 2 && upperWick(c) <= body(c) && c.close > c.open;
  const bearPin = upperWick(c) > body(c) * 2 && lowerWick(c) <= body(c) && c.close < c.open;
  let side = null, anchor = null, pattern = "";
  if ((bullEngulf || bullPin) && support && near(c.low, support.price)) { side = "LONG"; anchor = support.price; pattern = bullEngulf ? "Bullish Engulfing" : "Bullish Pin Bar"; }
  if ((bearEngulf || bearPin) && resistance && near(c.high, resistance.price)) { side = "SHORT"; anchor = resistance.price; pattern = bearEngulf ? "Bearish Engulfing" : "Bearish Pin Bar"; }
  if (!side) return null;
  const vr = volumeRatio(fifteenMin);
  if (vr != null && vr < PA_CONFIG.MIN_REVERSAL_VOLUME_RATIO) return null;
  const pad = levelBuffer(fifteenMin, c.close);
  const invalidation = side === "LONG" ? Math.min(c.low, anchor) - pad : Math.max(c.high, anchor) + pad;
  const s1H = aligned1H(structures, side), s4H = aligned4H(structures, side);
  const candleQuality = range(c) > 0 ? Math.min(1, (side === "LONG" ? lowerWick(c) : upperWick(c)) / range(c)) : 0;
  const levelProximity = 1 - Math.min(1, Math.abs(c.close - anchor) / (anchor * 0.01));
  const score = computeScore({ volumeRatio: vr, structureAligned1H: s1H, structureAligned4H: s4H, candleQuality, levelProximity });
  return makePlan({ symbol, side, strategyId: "candlestick", strategyName: "الگوهای کندلی",
    score, reason: pattern + " در مجاورت سطح ساختاری 1H",
    entry: c.close, invalidation, atr, candles1h: oneHour,
    context: { pattern, level: anchor, triggerTime: c.time, oneHourStructure: structures.oneHour, fourHourStructure: structures.fourHour, volumeRatio: vr } });
}

const STRATEGIES = [
  { id: "market_structure", name: "ساختار بازار", fn: structureStrategy },
  { id: "sr_rejection", name: "برگشت از حمایت/مقاومت", fn: rejectionStrategy },
  { id: "breakout_retest", name: "شکست و پولبک", fn: breakoutRetestStrategy },
  { id: "candlestick", name: "الگوهای کندلی", fn: candlestickStrategy }
];

const STRATEGY_STATUS_LABELS = Object.freeze({
  no_setup: "ستاپی پیدا نشد",
  candidate: "ستاپ اولیه پیدا شد",
  below_score: "رد به‌دلیل امتیاز ناکافی",
  late_entry: "رد به‌دلیل فاصله قیمت از ورود",
  conflict: "رد به‌دلیل تعارض جهت",
  accepted: "تأیید نهایی",
  direction_conflict: "رد به‌دلیل تعارض روند تایم‌فریم‌ها",
  strategy_error: "خطای داخلی استراتژی",
  invalid_data: "داده کندلی نامعتبر/ناکافی"
});

function sideMatchesStructure(direction, side) {
  return (side === "LONG" && direction === "BULLISH") || (side === "SHORT" && direction === "BEARISH");
}

function directionalRejection(candidate, oneHourStructure, fourHourStructure) {
  const oneHourAligned = sideMatchesStructure(oneHourStructure, candidate.side);
  const fourHourAligned = sideMatchesStructure(fourHourStructure, candidate.side);
  const fourHourNeutral = fourHourStructure === "RANGE" || fourHourStructure === "UNKNOWN";
  const fourHourOpposes = sideMatchesStructure(fourHourStructure, candidate.side === "LONG" ? "SHORT" : "LONG");
  // Shorts require BOTH 1H and 4H bearish (hardened).
  if (candidate.side === "SHORT" && (oneHourStructure !== "BEARISH" || fourHourStructure !== "BEARISH"))
    return "شورت فقط با تأیید هم‌زمان ساختار نزولی 1H و 4H پذیرفته می‌شود.";
  if (PA_CONFIG.REQUIRE_4H_ALIGNMENT && !fourHourAligned) {
    if (fourHourNeutral && PA_CONFIG.ALLOW_4H_NEUTRAL) {
      if (candidate.score < PA_CONFIG.NEUTRAL_4H_MIN_SCORE)
        return `روند 4H خنثی است؛ برای عبور از فیلتر 4H امتیاز حداقل ${PA_CONFIG.NEUTRAL_4H_MIN_SCORE} لازم است.`;
    } else if (fourHourOpposes) {
      const reversalSetup = ["sr_rejection", "candlestick"].includes(candidate.strategyId);
      if (!oneHourAligned || !reversalSetup || candidate.score < PA_CONFIG.NEUTRAL_4H_MIN_SCORE)
        return `روند 4H مخالف است؛ فقط برگشت قوی با تأیید ساختار 1H و امتیاز حداقل ${PA_CONFIG.NEUTRAL_4H_MIN_SCORE} پذیرفته می‌شود.`;
    } else return "روند 4H جهت این معامله را تأیید نمی‌کند.";
  }
  if (sideMatchesStructure(oneHourStructure, candidate.side === "LONG" ? "SHORT" : "LONG"))
    return "جهت سیگنال با ساختار تأییدشده 1H مخالف است.";
  if (fourHourOpposes) {
    const reversalSetup = ["sr_rejection", "candlestick"].includes(candidate.strategyId);
    if (!oneHourAligned || !reversalSetup || candidate.score < PA_CONFIG.NEUTRAL_4H_MIN_SCORE)
      return `روند 4H مخالف است؛ فقط برگشت قوی با تأیید ساختار 1H و امتیاز حداقل ${PA_CONFIG.NEUTRAL_4H_MIN_SCORE} پذیرفته می‌شود.`;
  }
  return null;
}
export function resolvePriceActionSignals(results, livePrice) {
  const price = Number(livePrice);
  const qualified = (Array.isArray(results) ? results : []).filter(x => x && x.score >= minScoreFor(x.side) && finite(x.entry) && x.entry > 0);
  const valid = qualified.filter(x => finite(price) && price > 0 && Math.abs(price - x.entry) / x.entry * 100 <= PA_CONFIG.MAX_ENTRY_DRIFT_PCT);
  if (!valid.length && qualified.length && finite(price) && price > 0) return {
    signals: [], conflict: false,
    rejected: `ورود دیرهنگام: قیمت لحظه‌ای بیش از ${PA_CONFIG.MAX_ENTRY_DRIFT_PCT}٪ از نقطه ورود ستاپ فاصله گرفته است.`
  };
  const sides = new Set(valid.map(x => x.side));
  if (sides.size > 1) return {
    signals: [], conflict: true,
    rejected: "دو استراتژی مستقل جهت‌های متضاد صادر کرده‌اند؛ برای این نماد سیگنال صادر نشد.",
    candidates: valid
  };
  const bestBySide = new Map();
  for (const s of valid) {
    const existing = bestBySide.get(s.side);
    if (!existing || s.score > existing.score) bestBySide.set(s.side, s);
  }
  return { signals: [...bestBySide.values()].sort((a, b) => b.score - a.score), conflict: false };
}

export function analyzePriceAction({ symbol, oneHour, fourHour, fifteenMin, livePrice }) {
  if (!validateCandles(oneHour, PA_CONFIG.MIN_CANDLES_1H) ||
      !validateCandles(fourHour, PA_CONFIG.MIN_CANDLES_4H) ||
      !validateCandles(fifteenMin, PA_CONFIG.MIN_CANDLES_15M)) {
    return {
      signals: [],
      rejected: "تعداد یا ساختار کندل‌های بسته‌شده کافی/معتبر نیست.",
      diagnostics: STRATEGIES.map(s => ({
        strategyId: s.id, strategyName: s.name, status: "invalid_data",
        statusLabel: STRATEGY_STATUS_LABELS.invalid_data,
        reason: "داده ورودی برای اجرای معتبر استراتژی کافی نیست."
      }))
    };
  }
  const atr = calculateAtr(oneHour, PA_CONFIG.ATR_PERIOD);
  const oneHourStructure = describeStructure(oneHour).direction;
  const fourHourStructure = describeStructure(fourHour).direction;
  const structures = { oneHour: oneHourStructure, fourHour: fourHourStructure };
  const evaluated = STRATEGIES.map(strategy => {
    try {
      const candidate = strategy.fn({ symbol, oneHour, fourHour, fifteenMin, atr, structures });
      if (candidate) candidate.context = { ...(candidate.context || {}), oneHourStructure, fourHourStructure };
      return { strategy, candidate, error: null };
    } catch (error) {
      return { strategy, candidate: null, error: String(error?.message || error || "خطای ناشناخته") };
    }
  });
  const candidates = evaluated.filter(x => x.candidate).map(x => x.candidate);
  const qualified = candidates.filter(x => x.score >= minScoreFor(x.side));
  const directionalChecks = new Map(qualified.map(candidate => [candidate, directionalRejection(candidate, oneHourStructure, fourHourStructure)]));
  const directionallyValid = qualified.filter(candidate => !directionalChecks.get(candidate));
  const resolution = resolvePriceActionSignals(directionallyValid, livePrice);
  const diagnostics = evaluated.map(({ strategy, candidate, error }) => {
    let status = "no_setup", reason = "شرایط لازم این استراتژی در کندل‌های بررسی‌شده هم‌زمان برقرار نبود.";
    if (error) { status = "strategy_error"; reason = error; }
    else if (candidate) {
      reason = candidate.reason || "ستاپ اولیه شناسایی شد.";
      if (candidate.score < PA_CONFIG.MIN_SCORE) {
        status = "below_score";
        reason += ` | امتیاز ${candidate.score} کمتر از حداقل ${PA_CONFIG.MIN_SCORE}`;
      } else if (directionalChecks.has(candidate) && directionalChecks.get(candidate)) {
        status = "direction_conflict"; reason = directionalChecks.get(candidate);
      } else if (resolution.conflict && (resolution.candidates || []).includes(candidate)) {
        status = "conflict"; reason = resolution.rejected;
      } else if (resolution.rejected?.startsWith("ورود دیرهنگام")) {
        status = "late_entry"; reason = resolution.rejected;
      } else if (resolution.signals?.includes(candidate)) {
        status = "accepted";
      } else status = "candidate";
    }
    return { strategyId: strategy.id, strategyName: strategy.name, status,
      statusLabel: STRATEGY_STATUS_LABELS[status], score: candidate?.score ?? null,
      side: candidate?.side ?? null, reason };
  });
  const rejectedDirection = diagnostics.find(x => x.status === "direction_conflict");
  return { ...resolution, rejected: resolution.rejected || (rejectedDirection ? rejectedDirection.reason : undefined), diagnostics };
}
import { mkdir, writeFile } from "node:fs/promises";
import { analyzeFuturesSymbol, getKrakenFuturesUniverse } from "../src/index.js";

const DAYS = Number(process.env.BACKTEST_DAYS || 90);
const LEVERAGE = 10;
const TARGET_MARGIN_ROI = 0.25;
const VOLUME_THRESHOLD = Number(process.env.VOLUME_THRESHOLD ?? 0.75);
const FEE = 0.0005;       // assumed taker fee per side
const SLIPPAGE = 0.0003;  // assumed adverse slippage per side
const H1 = 60 * 60 * 1000;
const H4 = 4 * H1;
const BASE = "https://futures.kraken.com";
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function fetchJson(url) {
  let lastError;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const response = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(30000) });
      const body = await response.text();
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${body.slice(0, 160)}`);
      return JSON.parse(body);
    } catch (error) {
      lastError = error;
      await sleep(500 * (attempt + 1));
    }
  }
  throw lastError;
}

function normalize(rows, intervalMs, end) {
  const unique = new Map();
  for (const row of rows || []) {
    const candle = {
      time: Number(row.time) < 1e12 ? Number(row.time) * 1000 : Number(row.time),
      open: Number(row.open), high: Number(row.high), low: Number(row.low),
      close: Number(row.close), volume: Number(row.volume)
    };
    if ([candle.time, candle.open, candle.high, candle.low, candle.close, candle.volume].every(Number.isFinite) &&
        candle.open > 0 && candle.low > 0 && candle.high >= candle.low && candle.close > 0 &&
        candle.volume >= 0 && candle.time + intervalMs <= end) unique.set(candle.time, candle);
  }
  return [...unique.values()].sort((a, b) => a.time - b.time);
}

async function loadCandles(symbol, resolution, from, to, intervalMs) {
  const rows = [];
  const chunkMs = 1750 * intervalMs;
  for (let cursor = from; cursor < to; cursor += chunkMs) {
    const finish = Math.min(to, cursor + chunkMs);
    const url = new URL(`${BASE}/api/charts/v1/trade/${encodeURIComponent(symbol)}/${resolution}`);
    url.searchParams.set("from", String(Math.floor(cursor / 1000)));
    url.searchParams.set("to", String(Math.floor(finish / 1000)));
    url.searchParams.set("count", "2000");
    const data = await fetchJson(url);
    if (!Array.isArray(data.candles)) throw new Error(`Invalid candles for ${symbol} ${resolution}`);
    rows.push(...data.candles);
    await sleep(100);
  }
  return normalize(rows, intervalMs, to);
}

function closedCount(candles, closeTime, intervalMs) {
  let lo = 0, hi = candles.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (candles[mid].time + intervalMs <= closeTime) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function ema(values, period) {
  if (values.length < period) return NaN;
  const k = 2 / (period + 1);
  let value = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) value = values[i] * k + value * (1 - k);
  return value;
}


function adx14(candles, period = 14) {
  if (candles.length < period * 2 + 1) return null;
  const tr = [], plusDm = [], minusDm = [];
  for (let i = 1; i < candles.length; i++) {
    const cur = candles[i], prev = candles[i - 1];
    tr.push(Math.max(cur.high - cur.low, Math.abs(cur.high - prev.close), Math.abs(cur.low - prev.close)));
    const up = cur.high - prev.high, down = prev.low - cur.low;
    plusDm.push(up > down && up > 0 ? up : 0);
    minusDm.push(down > up && down > 0 ? down : 0);
  }
  let trSmooth = tr.slice(0, period).reduce((x, y) => x + y, 0);
  let plusSmooth = plusDm.slice(0, period).reduce((x, y) => x + y, 0);
  let minusSmooth = minusDm.slice(0, period).reduce((x, y) => x + y, 0);
  const dx = [];
  for (let i = period - 1; i < tr.length; i++) {
    if (i >= period) {
      trSmooth = trSmooth - trSmooth / period + tr[i];
      plusSmooth = plusSmooth - plusSmooth / period + plusDm[i];
      minusSmooth = minusSmooth - minusSmooth / period + minusDm[i];
    }
    const plusDi = trSmooth > 0 ? 100 * plusSmooth / trSmooth : 0;
    const minusDi = trSmooth > 0 ? 100 * minusSmooth / trSmooth : 0;
    dx.push(plusDi + minusDi > 0 ? 100 * Math.abs(plusDi - minusDi) / (plusDi + minusDi) : 0);
  }
  if (dx.length < period) return null;
  let adx = dx.slice(0, period).reduce((x, y) => x + y, 0) / period;
  for (let i = period; i < dx.length; i++) adx = (adx * (period - 1) + dx[i]) / period;
  return adx;
}

function marketContextAt(series, time) {
  let bullish = 0, bearish = 0, total = 0, btcTrend = "UNKNOWN";
  for (const [symbol, data] of series.entries()) {
    if (symbol.includes("NVDA")) continue;
    const n = closedCount(data.h4, time, H4);
    if (n < 55) continue;
    const h4 = data.h4.slice(0, n);
    const closes = h4.map(c => c.close);
    const fast = ema(closes, 20), slow = ema(closes, 50);
    if (!Number.isFinite(fast) || !Number.isFinite(slow)) continue;
    const trend = fast > slow ? "BULL" : fast < slow ? "BEAR" : "FLAT";
    if (trend === "BULL") bullish++;
    if (trend === "BEAR") bearish++;
    total++;
    if (symbol.includes("XBT")) btcTrend = trend;
  }
  return {
    btc4hTrend: btcTrend,
    marketBullishBreadthPct: total ? bullish / total * 100 : null,
    marketBearishBreadthPct: total ? bearish / total * 100 : null,
    marketTrendCoverage: total
  };
}

function signalFeatures(signal, h1, h4, marketContext) {
  const last = h1.at(-1);
  const previous20 = h1.slice(-21, -1);
  const recent5 = h1.slice(-5), prior5 = h1.slice(-10, -5);
  const rangeHigh20 = previous20.length ? Math.max(...previous20.map(c => c.high)) : last.high;
  const rangeLow20 = previous20.length ? Math.min(...previous20.map(c => c.low)) : last.low;
  const recentHigh = recent5.length ? Math.max(...recent5.map(c => c.high)) : last.high;
  const priorHigh = prior5.length ? Math.max(...prior5.map(c => c.high)) : last.high;
  const recentLow = recent5.length ? Math.min(...recent5.map(c => c.low)) : last.low;
  const priorLow = prior5.length ? Math.min(...prior5.map(c => c.low)) : last.low;
  const ema20_4h = ema(h4.map(c => c.close), 20);
  const ema50_4h = ema(h4.map(c => c.close), 50);
  const atr4h = h4.length > 15 ? (() => {
    const recent = h4.slice(-14);
    const ranges = recent.map((c, i) => {
      const prev = h4[h4.length - recent.length + i - 1];
      return Math.max(c.high - c.low, prev ? Math.abs(c.high - prev.close) : 0, prev ? Math.abs(c.low - prev.close) : 0);
    });
    return ranges.reduce((a, b) => a + b, 0) / ranges.length;
  })() : null;
  const candleRange = Math.max(0, last.high - last.low);
  const directionalExtensionAtr = signal.side === "LONG"
    ? (last.close - signal.ema20) / signal.atr
    : (signal.ema20 - last.close) / signal.atr;
  const closeLocation = candleRange > 0 ? (last.close - last.low) / candleRange : 0.5;
  const rangePosition20 = rangeHigh20 > rangeLow20
    ? (last.close - rangeLow20) / (rangeHigh20 - rangeLow20) : 0.5;
  const directionStructure = signal.side === "LONG"
    ? recentHigh > priorHigh && recentLow > priorLow
    : recentHigh < priorHigh && recentLow < priorLow;
  const closes = h1.map(c => c.close);
  const return6hPct = closes.length > 6 ? (last.close / closes.at(-7) - 1) * 100 : null;
  const return24hPct = closes.length > 24 ? (last.close / closes.at(-25) - 1) * 100 : null;
  return {
    rsi: signal.rsi,
    score: signal.score,
    volumeRatio: signal.volumeRatio,
    atrPct: signal.atr / signal.entry * 100,
    adx14: adx14(h1),
    emaGapAtr: (signal.ema20 - signal.ema50) / signal.atr,
    directionalExtensionAtr,
    h4EmaGapPct: Number.isFinite(ema20_4h) && Number.isFinite(ema50_4h) ? (ema20_4h - ema50_4h) / last.close * 100 : null,
    h4PriceVsEma20Atr: Number.isFinite(ema20_4h) && atr4h > 0 ? (last.close - ema20_4h) / atr4h : null,
    rangePosition20,
    breakout20: signal.side === "LONG" ? last.close > rangeHigh20 : last.close < rangeLow20,
    directionStructure,
    closeLocation,
    return6hPct,
    return24hPct,
    ...marketContext
  };
}

function temporalBreakdown(trades, start, split, end) {
  const first = trades.filter(t => t.signalTime < split);
  const last = trades.filter(t => t.signalTime >= split && t.signalTime < end);
  const byMonth = {};
  for (const trade of trades) {
    const month = new Date(trade.signalTime).toISOString().slice(0, 7);
    (byMonth[month] ||= []).push(trade);
  }
  return {
    first60Days: summarize(first),
    last30Days: summarize(last),
    byMonth: Object.entries(byMonth).sort(([a], [b]) => a.localeCompare(b)).map(([month, group]) => ({
      month, ...summarize(group)
    }))
  };
}

function bucketBreakdown(trades, field, cuts) {
  const rows = [];
  const bounds = [-Infinity, ...cuts, Infinity];
  for (let i = 0; i < bounds.length - 1; i++) {
    const group = trades.filter(t => {
      const value = Number(t.features?.[field]);
      return Number.isFinite(value) && value >= bounds[i] && value < bounds[i + 1];
    });
    rows.push({
      range: `${bounds[i] === -Infinity ? "-inf" : bounds[i]} to ${bounds[i + 1] === Infinity ? "+inf" : bounds[i + 1]}`,
      ...summarize(group)
    });
  }
  return rows;
}

function targetTrigger(entryFill, side) {
  const q = TARGET_MARGIN_ROI / LEVERAGE;
  if (side === "LONG") {
    const requiredExitFill = entryFill * (1 + q + 2 * FEE);
    return requiredExitFill / (1 - SLIPPAGE);
  }
  const requiredExitFill = entryFill * (1 - q - 2 * FEE);
  return requiredExitFill / (1 + SLIPPAGE);
}

function settle(trade, triggerPrice, reason, gap = false) {
  const d = trade.side === "LONG" ? 1 : -1;
  const exitFill = triggerPrice * (1 - d * SLIPPAGE);
  const grossPct = d * (exitFill - trade.entryFill) / trade.entryFill;
  const netUnderlyingPct = grossPct - 2 * FEE;
  const marginRoiPct = LEVERAGE * netUnderlyingPct * 100;
  const riskPct = Math.abs(trade.signal.entry - trade.signal.stop) / trade.signal.entry;
  const riskMarginPct = riskPct * LEVERAGE * 100;
  return {
    ...trade,
    exitPrice: triggerPrice,
    exitReason: reason,
    gapExit: gap,
    grossPriceMovePct: d * (triggerPrice - trade.signal.entry) / trade.signal.entry * 100,
    marginRoiPct,
    netR: riskMarginPct > 0 ? marginRoiPct / riskMarginPct : 0
  };
}

function settleActiveMap(activeMap, closedTrades, series, time) {
  let ambiguous = 0;
  for (const [key, trade] of [...activeMap.entries()]) {
    const data = series.get(trade.symbol);
    const bar = data.h1.find(c => c.time + H1 === time);
    if (!bar) continue;
    const d = trade.side === "LONG" ? 1 : -1;
    const stopGap = d === 1 ? bar.open <= trade.signal.stop : bar.open >= trade.signal.stop;
    const targetGap = d === 1 ? bar.open >= trade.targetTrigger : bar.open <= trade.targetTrigger;
    const stopHit = stopGap || (d === 1 ? bar.low <= trade.signal.stop : bar.high >= trade.signal.stop);
    const targetHit = targetGap || (d === 1 ? bar.high >= trade.targetTrigger : bar.low <= trade.targetTrigger);
    if (stopHit && targetHit) ambiguous++;
    if (stopHit) {
      closedTrades.push(settle({ ...trade, exitTime: time }, stopGap ? bar.open : trade.signal.stop, "STOP", stopGap));
      activeMap.delete(key);
    } else if (targetHit) {
      closedTrades.push(settle({ ...trade, exitTime: time }, targetGap ? bar.open : trade.targetTrigger, "TARGET_25_MARGIN", false));
      activeMap.delete(key);
    }
  }
  return ambiguous;
}

function summarize(trades) {
  const wins = trades.filter(t => t.marginRoiPct > 0);
  const losses = trades.filter(t => t.marginRoiPct < 0);
  const grossWin = wins.reduce((sum, t) => sum + t.marginRoiPct, 0);
  const grossLoss = -losses.reduce((sum, t) => sum + t.marginRoiPct, 0);
  let equity = 0, peak = 0, maxDrawdown = 0;
  for (const trade of [...trades].sort((a, b) => a.exitTime - b.exitTime)) {
    equity += trade.marginRoiPct;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
  }
  const total = trades.reduce((sum, t) => sum + t.marginRoiPct, 0);
  return {
    closedTrades: trades.length,
    targetHits: trades.filter(t => t.exitReason === "TARGET_25_MARGIN").length,
    stopHits: trades.filter(t => t.exitReason === "STOP").length,
    winRatePct: trades.length ? wins.length / trades.length * 100 : 0,
    netMarginRoiPctSum: total,
    averageMarginRoiPct: trades.length ? total / trades.length : 0,
    profitFactor: grossLoss ? grossWin / grossLoss : grossWin ? null : 0,
    netR: trades.reduce((sum, t) => sum + t.netR, 0),
    expectancyR: trades.length ? trades.reduce((sum, t) => sum + t.netR, 0) / trades.length : 0,
    maxDrawdownMarginPct: maxDrawdown
  };
}

async function main() {
  const end = Math.floor(Date.now() / H1) * H1;
  const start = end - DAYS * 24 * H1;
  const warmStart = start - 20 * 24 * H1;
  const tickers = await getKrakenFuturesUniverse();
  if (!tickers.length) throw new Error("Kraken returned no eligible perpetual contracts.");

  const market = tickers.slice(0, 24);
  console.log("Universe:", market.map(t => t.symbol).join(", "));
  const series = new Map();
  for (const ticker of market) {
    try {
      const [h1, h4] = await Promise.all([
        loadCandles(ticker.symbol, "1h", warmStart, end, H1),
        loadCandles(ticker.symbol, "4h", warmStart, end, H4)
      ]);
      if (h1.length >= 60 && h4.length >= 60) {
        series.set(ticker.symbol, { h1, h4, ticker });
        console.log("Loaded", ticker.symbol, h1.length, h4.length);
      } else console.log("Insufficient history", ticker.symbol, h1.length, h4.length);
    } catch (error) {
      console.log("Data unavailable", ticker.symbol, String(error.message || error));
    }
  }
  if (series.size < 5) throw new Error(`Only ${series.size} symbols have sufficient history.`);

  const times = new Set();
  for (const { h1 } of series.values()) for (const candle of h1) {
    const closeTime = candle.time + H1;
    if (closeTime >= start && closeTime <= end) times.add(closeTime);
  }
  const timeline = [...times].sort((a, b) => a - b);
  const active = new Map();
  const qualityActive = new Map();
  const breakoutActive = new Map();
  const qualityClosed = [];
  const breakoutClosed = [];
  let qualityIssued = 0, qualitySkippedDuplicate = 0;
  let breakoutIssued = 0, breakoutSkippedDuplicate = 0;
  const experimentalActive = new Map();
  const tier2Active = new Map();
  const noVolumeActive = new Map();
  const noVolumeClosed = [];
  const closed = [];
  let issued = 0, skippedDuplicate = 0, skippedByEightLimit = 0, ambiguousBars = 0;
  let experimentalIssued = 0, experimentalSkippedDuplicate = 0, experimentalSkippedByEightLimit = 0;
  let tier2Issued = 0, tier2SkippedDuplicate = 0, tier2SkippedByEightLimit = 0;
  let noVolumeIssued = 0, noVolumeSkippedDuplicate = 0, noVolumeSkippedByEightLimit = 0;

  for (const time of timeline) {
    // First settle positions using the just-closed hourly candle. Stop wins
    // whenever stop and target are both inside the same OHLC candle.
    for (const [key, trade] of [...active.entries()]) {
      const data = series.get(trade.symbol);
      const bar = data.h1.find(c => c.time + H1 === time);
      if (!bar) continue;
      const d = trade.side === "LONG" ? 1 : -1;
      const stopGap = d === 1 ? bar.open <= trade.signal.stop : bar.open >= trade.signal.stop;
      const targetGap = d === 1 ? bar.open >= trade.targetTrigger : bar.open <= trade.targetTrigger;
      const stopHit = stopGap || (d === 1 ? bar.low <= trade.signal.stop : bar.high >= trade.signal.stop);
      const targetHit = targetGap || (d === 1 ? bar.high >= trade.targetTrigger : bar.low <= trade.targetTrigger);
      if (stopHit && targetHit) ambiguousBars++;
      if (stopHit) {
        const px = stopGap ? bar.open : trade.signal.stop;
        closed.push(settle({ ...trade, exitTime: time }, px, "STOP", stopGap));
        active.delete(key);
      } else if (targetHit) {
        const px = targetGap ? bar.open : trade.targetTrigger;
        closed.push(settle({ ...trade, exitTime: time }, px, "TARGET_25_MARGIN", false));
        active.delete(key);
      }
    }

    // Settle independent candidate strategies with exactly the same stop/target execution model.
    ambiguousBars += settleActiveMap(qualityActive, qualityClosed, series, time);
    ambiguousBars += settleActiveMap(breakoutActive, breakoutClosed, series, time);

    // Independently release experimental positions using the same stop and +25% margin target.
    for (const [key, trade] of [...experimentalActive.entries()]) {
      const data = series.get(trade.symbol);
      const bar = data.h1.find(c => c.time + H1 === time);
      if (!bar) continue;
      const d = trade.side === "LONG" ? 1 : -1;
      const stopGap = d === 1 ? bar.open <= trade.signal.stop : bar.open >= trade.signal.stop;
      const targetGap = d === 1 ? bar.open >= trade.targetTrigger : bar.open <= trade.targetTrigger;
      const stopHit = stopGap || (d === 1 ? bar.low <= trade.signal.stop : bar.high >= trade.signal.stop);
      const targetHit = targetGap || (d === 1 ? bar.high >= trade.targetTrigger : bar.low <= trade.targetTrigger);
      if (stopHit || targetHit) experimentalActive.delete(key);
    }

    // Settle the no-volume-threshold comparison independently.
    for (const [key, trade] of [...noVolumeActive.entries()]) {
      const data = series.get(trade.symbol);
      const bar = data.h1.find(c => c.time + H1 === time);
      if (!bar) continue;
      const d = trade.side === "LONG" ? 1 : -1;
      const stopGap = d === 1 ? bar.open <= trade.signal.stop : bar.open >= trade.signal.stop;
      const targetGap = d === 1 ? bar.open >= trade.targetTrigger : bar.open <= trade.targetTrigger;
      const stopHit = stopGap || (d === 1 ? bar.low <= trade.signal.stop : bar.high >= trade.signal.stop);
      const targetHit = targetGap || (d === 1 ? bar.high >= trade.targetTrigger : bar.low <= trade.targetTrigger);
      if (stopHit && targetHit) ambiguousBars++;
      if (stopHit) {
        const px = stopGap ? bar.open : trade.signal.stop;
        noVolumeClosed.push(settle({ ...trade, exitTime: time }, px, "STOP", stopGap));
        noVolumeActive.delete(key);
      } else if (targetHit) {
        const px = targetGap ? bar.open : trade.targetTrigger;
        noVolumeClosed.push(settle({ ...trade, exitTime: time }, px, "TARGET_25_MARGIN", false));
        noVolumeActive.delete(key);
      }
    }

    // Release tier-2 positions using the same stop and target assumptions.
    for (const [key, trade] of [...tier2Active.entries()]) {
      const data = series.get(trade.symbol);
      const bar = data.h1.find(c => c.time + H1 === time);
      if (!bar) continue;
      const d = trade.side === "LONG" ? 1 : -1;
      const stopGap = d === 1 ? bar.open <= trade.signal.stop : bar.open >= trade.signal.stop;
      const targetGap = d === 1 ? bar.open >= trade.targetTrigger : bar.open <= trade.targetTrigger;
      const stopHit = stopGap || (d === 1 ? bar.low <= trade.signal.stop : bar.high >= trade.signal.stop);
      const targetHit = targetGap || (d === 1 ? bar.high >= trade.targetTrigger : bar.low <= trade.targetTrigger);
      if (stopHit || targetHit) tier2Active.delete(key);
    }

    // Run the same analyzer once, then independently count standard and relaxed eligibility.
    const candidates = [];
    const experimentalCandidates = [];
    const tier2Candidates = [];
    const noVolumeCandidates = [];
    for (const [symbol, data] of series.entries()) {
      const n1 = closedCount(data.h1, time, H1);
      const n4 = closedCount(data.h4, time, H4);
      if (n1 < 60 || n4 < 60) continue;
      const h1 = data.h1.slice(0, n1);
      const h4 = data.h4.slice(0, n4);
      const last = h1[h1.length - 1];
      const prior = h1.find(c => c.time <= last.time - 24 * H1);
      if (!prior || prior.close <= 0) continue;
      const ticker = {
        ...data.ticker,
        symbol,
        priceChangePercent: (last.close / prior.close - 1) * 100,
        premium: undefined
      };
      const signal = analyzeFuturesSymbol(ticker, h1, h4);
      if (signal?.side) signal.features = signalFeatures(signal, h1, h4, marketContextAt(series, time));
      if (signal?.eligible) candidates.push(signal);
      const closes1h = h1.map(c => c.close);
      const closes4h = h4.map(c => c.close);
      const e20_1h = ema(closes1h, 20), e50_1h = ema(closes1h, 50);
      const e20_4h = ema(closes4h, 20), e50_4h = ema(closes4h, 50);
      const strictLong = e20_1h > e50_1h && last.close > e20_1h && e20_4h > e50_4h && signal?.side === "LONG" && signal.rsi >= 48 && signal.rsi <= 69;
      const strictShort = e20_1h < e50_1h && last.close < e20_1h && e20_4h < e50_4h && signal?.side === "SHORT" && signal.rsi >= 31 && signal.rsi <= 52;
      if ((strictLong || strictShort) && signal.score >= 72 && signal.volumeRatio >= VOLUME_THRESHOLD) noVolumeCandidates.push(signal);
      const relaxedEligible = signal?.eligible ||
        (signal?.experimentalEligible && signal.score >= 60 && signal.volumeRatio >= 0.5);
      if (relaxedEligible) experimentalCandidates.push(signal);
      const tier2Eligible = signal?.eligible ||
        (signal?.experimentalEligible && signal.score >= 55 && signal.volumeRatio >= 0.35);
      if (tier2Eligible) tier2Candidates.push(signal);
    }
    candidates.sort((a, b) => b.score - a.score);
    experimentalCandidates.sort((a, b) => b.score - a.score);
    tier2Candidates.sort((a, b) => b.score - a.score);
    noVolumeCandidates.sort((a, b) => b.score - a.score);

    let selected = 0;
    for (const signal of candidates) {
      const key = `${signal.symbol}|${signal.side}`;
      if (active.has(key)) { skippedDuplicate++; continue; }
      if (selected >= 8) { skippedByEightLimit++; continue; }
      const entry = signal.entry;
      const d = signal.side === "LONG" ? 1 : -1;
      const entryFill = entry * (1 + d * SLIPPAGE);
      const trade = {
        symbol: signal.symbol, side: signal.side, score: signal.score,
        signalTime: time, signal, features: signal.features || {}, entryFill,
        targetTrigger: targetTrigger(entryFill, signal.side)
      };
      active.set(key, trade);
      issued++;
      selected++;
    }

    // Candidate A: asymmetric direction quality filter. LONG requires a 20-bar breakout
    // plus aligned 5-bar swing structure; SHORT requires RSI <= 45.
    for (const signal of candidates) {
      const passes = signal.side === "LONG"
        ? Boolean(signal.features?.breakout20 && signal.features?.directionStructure)
        : signal.rsi <= 45;
      if (!passes) continue;
      const key = `${signal.symbol}|${signal.side}`;
      if (qualityActive.has(key)) { qualitySkippedDuplicate++; continue; }
      const d = signal.side === "LONG" ? 1 : -1;
      const entryFill = signal.entry * (1 + d * SLIPPAGE);
      qualityActive.set(key, {
        symbol: signal.symbol, side: signal.side, score: signal.score,
        signalTime: time, signal, features: signal.features || {}, entryFill,
        targetTrigger: targetTrigger(entryFill, signal.side)
      });
      qualityIssued++;
    }

    // Candidate B: symmetric high-conviction filter; both breakout and swing structure required.
    for (const signal of candidates) {
      if (!(signal.features?.breakout20 && signal.features?.directionStructure)) continue;
      const key = `${signal.symbol}|${signal.side}`;
      if (breakoutActive.has(key)) { breakoutSkippedDuplicate++; continue; }
      const d = signal.side === "LONG" ? 1 : -1;
      const entryFill = signal.entry * (1 + d * SLIPPAGE);
      breakoutActive.set(key, {
        symbol: signal.symbol, side: signal.side, score: signal.score,
        signalTime: time, signal, features: signal.features || {}, entryFill,
        targetTrigger: targetTrigger(entryFill, signal.side)
      });
      breakoutIssued++;
    }

    let experimentalSelected = 0;
    for (const signal of experimentalCandidates) {
      const key = `${signal.symbol}|${signal.side}`;
      if (experimentalActive.has(key)) { experimentalSkippedDuplicate++; continue; }
      if (experimentalSelected >= 8) { experimentalSkippedByEightLimit++; continue; }
      const entry = signal.entry;
      const d = signal.side === "LONG" ? 1 : -1;
      const entryFill = entry * (1 + d * SLIPPAGE);
      experimentalActive.set(key, {
        symbol: signal.symbol, side: signal.side, score: signal.score,
        signalTime: time, signal, entryFill,
        targetTrigger: targetTrigger(entryFill, signal.side)
      });
      experimentalIssued++;
      experimentalSelected++;
    }

    let noVolumeSelected = 0;
    for (const signal of noVolumeCandidates) {
      const key = `${signal.symbol}|${signal.side}`;
      if (noVolumeActive.has(key)) { noVolumeSkippedDuplicate++; continue; }
      if (noVolumeSelected >= 8) { noVolumeSkippedByEightLimit++; continue; }
      const d = signal.side === "LONG" ? 1 : -1;
      const entryFill = signal.entry * (1 + d * SLIPPAGE);
      noVolumeActive.set(key, {
        symbol: signal.symbol, side: signal.side, score: signal.score,
        signalTime: time, signal, entryFill,
        targetTrigger: targetTrigger(entryFill, signal.side)
      });
      noVolumeIssued++;
      noVolumeSelected++;
    }

    let tier2Selected = 0;
    for (const signal of tier2Candidates) {
      const key = `${signal.symbol}|${signal.side}`;
      if (tier2Active.has(key)) { tier2SkippedDuplicate++; continue; }
      if (tier2Selected >= 8) { tier2SkippedByEightLimit++; continue; }
      const entry = signal.entry;
      const d = signal.side === "LONG" ? 1 : -1;
      const entryFill = entry * (1 + d * SLIPPAGE);
      tier2Active.set(key, {
        symbol: signal.symbol, side: signal.side, score: signal.score,
        signalTime: time, signal, entryFill,
        targetTrigger: targetTrigger(entryFill, signal.side)
      });
      tier2Issued++;
      tier2Selected++;
    }
  }

  const openAtEnd = [...active.values()].map(t => {
    const h1 = series.get(t.symbol).h1;
    const last = h1.at(-1);
    const d = t.side === "LONG" ? 1 : -1;
    const mark = last.close * (1 - d * SLIPPAGE);
    const grossPct = d * (mark - t.entryFill) / t.entryFill;
    const netUnderlyingPct = grossPct - 2 * FEE;
    return {
      symbol: t.symbol, side: t.side, score: t.score,
      signalTime: new Date(t.signalTime).toISOString(),
      entry: t.signal.entry, stop: t.signal.stop,
      markPrice: last.close, unrealizedMarginRoiPct: LEVERAGE * netUnderlyingPct * 100
    };
  });

  const summary = {
    engine: "Production main branch analyzeFuturesSymbol (v3.8.2)",
    period: { start: new Date(start).toISOString(), end: new Date(end).toISOString(), days: DAYS },
    assumptions: {
      exchange: "Kraken Futures",
      universe: "current top 24 eligible perpetual contracts by quote volume, applied to full historical window",
      signalRules: "unchanged production analyzer; standard eligible signals only; strictSetup + score >= 72 + volumeRatio >= 0.75",
      timeframe: "1H signal with 4H trend confirmation",
      leverage: LEVERAGE,
      target: "+25% net margin ROI; full position closed",
      stop: "unchanged production stop: 7 prior closed 1H candles vs 1.5 * 1H ATR(14), fixed",
      entry: "signal candle close; adverse slippage applied",
      fees: FEE,
      slippage: SLIPPAGE,
      funding: "excluded (historical funding series not supplied)",
      candleAmbiguity: "stop-first if stop and target both fall inside one hourly candle",
      maxOpenTrades: "one per symbol and direction; up to 8 newly issued per scan, matching production scan cap",
      liquidation: "not separately simulated; all accepted stops are at or inside 8% price distance"
    },
    signalCount: issued,
    averageSignalsPerDay: issued / DAYS,
    withoutVolumeThreshold: {
      rules: `same strict production setup and score >= 72; hard volumeRatio threshold >= ${VOLUME_THRESHOLD}; volume still contributes its existing score points`,
      volumeThreshold: VOLUME_THRESHOLD,
      signalCount: noVolumeIssued,
      averageSignalsPerDay: noVolumeIssued / DAYS,
      additionalSignals: noVolumeIssued - issued,
      increasePct: issued ? (noVolumeIssued / issued - 1) * 100 : null,
      openAtEndCount: noVolumeActive.size,
      skippedDuplicate: noVolumeSkippedDuplicate,
      skippedByEightLimit: noVolumeSkippedByEightLimit,
      closed: summarize(noVolumeClosed),
      perSymbol: [...new Set(noVolumeClosed.map(t => t.symbol))].map(symbol => ({
        symbol, ...summarize(noVolumeClosed.filter(t => t.symbol === symbol))
      }))
    },
    tier1Experimental: {
      rules: "standard signals plus relaxed signals where the 1H trend is valid, 4H is not opposing, RSI is within the relaxed band, score >= 60, and volumeRatio >= 0.50",
      signalCount: experimentalIssued,
      averageSignalsPerDay: experimentalIssued / DAYS,
      additionalSignals: experimentalIssued - issued,
      increasePct: issued ? (experimentalIssued / issued - 1) * 100 : null,
      openAtEndCount: experimentalActive.size,
      skippedDuplicate: experimentalSkippedDuplicate,
      skippedByEightLimit: experimentalSkippedByEightLimit
    },
    tier2Experimental: {
      rules: "standard signals plus experimentalEligible signals with score >= 55 and volumeRatio >= 0.35; 1H trend valid and 4H not opposing",
      signalCount: tier2Issued,
      averageSignalsPerDay: tier2Issued / DAYS,
      additionalSignals: tier2Issued - issued,
      increasePct: issued ? (tier2Issued / issued - 1) * 100 : null,
      openAtEndCount: tier2Active.size,
      skippedDuplicate: tier2SkippedDuplicate,
      skippedByEightLimit: tier2SkippedByEightLimit
    },
    skippedDuplicate,
    skippedByEightLimit,
    validSymbols: [...series.keys()],
    closed: summarize(closed),
    openAtEndCount: openAtEnd.length,
    openAtEnd,
    sameBarAmbiguousCount: ambiguousBars,
    perSymbol: [...new Set(closed.map(t => t.symbol))].map(symbol => ({
      symbol, ...summarize(closed.filter(t => t.symbol === symbol))
    })),
    temporalBreakdown: {
      splitAt: new Date(start + 60 * 24 * H1).toISOString(),
      baseline: temporalBreakdown(closed, start, start + 60 * 24 * H1, end),
      asymmetricCandidate: temporalBreakdown(qualityClosed, start, start + 60 * 24 * H1, end),
      breakoutStructureCandidate: temporalBreakdown(breakoutClosed, start, start + 60 * 24 * H1, end)
    },
    qualityFilter: {
      rule: "LONG: 20-candle breakout AND aligned 5-candle swing structure; SHORT: RSI <= 45",
      signalCount: qualityIssued,
      averageSignalsPerDay: qualityIssued / DAYS,
      skippedDuplicate: qualitySkippedDuplicate,
      openAtEndCount: qualityActive.size,
      closed: summarize(qualityClosed),
      directionBreakdown: ["LONG", "SHORT"].map(side => ({
        side, ...summarize(qualityClosed.filter(t => t.side === side))
      }))
    },
    breakoutStructureFilter: {
      rule: "Both LONG and SHORT require 20-candle breakout AND aligned 5-candle swing structure",
      signalCount: breakoutIssued,
      averageSignalsPerDay: breakoutIssued / DAYS,
      skippedDuplicate: breakoutSkippedDuplicate,
      openAtEndCount: breakoutActive.size,
      closed: summarize(breakoutClosed),
      directionBreakdown: ["LONG", "SHORT"].map(side => ({
        side, ...summarize(breakoutClosed.filter(t => t.side === side))
      }))
    },
    directionBreakdown: ["LONG", "SHORT"].map(side => ({
      side, ...summarize(closed.filter(t => t.side === side))
    })),
    diagnosticBreakdowns: {
      adx14: bucketBreakdown(closed, "adx14", [15, 20, 25]),
      directionalExtensionAtr: bucketBreakdown(closed, "directionalExtensionAtr", [0.25, 0.75, 1.25]),
      volumeRatio: bucketBreakdown(closed, "volumeRatio", [0.75, 1, 1.5]),
      rsi: bucketBreakdown(closed, "rsi", [35, 45, 55, 65]),
      score: bucketBreakdown(closed, "score", [80, 90]),
      rangePosition20: bucketBreakdown(closed, "rangePosition20", [0.25, 0.5, 0.75])
    },
    postStopContinuation: (() => {
      const stopped = closed.filter(t => t.exitReason === "STOP");
      const reached24 = stopped.filter(t => {
        const bars = series.get(t.symbol).h1.filter(c => c.time >= t.exitTime && c.time < t.exitTime + 24 * H1);
        return t.side === "LONG" ? bars.some(c => c.high >= t.targetTrigger) : bars.some(c => c.low <= t.targetTrigger);
      }).length;
      const reached48 = stopped.filter(t => {
        const bars = series.get(t.symbol).h1.filter(c => c.time >= t.exitTime && c.time < t.exitTime + 48 * H1);
        return t.side === "LONG" ? bars.some(c => c.high >= t.targetTrigger) : bars.some(c => c.low <= t.targetTrigger);
      }).length;
      return {
        stoppedTrades: stopped.length,
        targetReachedAgainWithin24h: reached24,
        targetReachedAgainWithin24hPct: stopped.length ? reached24 / stopped.length * 100 : 0,
        targetReachedAgainWithin48h: reached48,
        targetReachedAgainWithin48hPct: stopped.length ? reached48 / stopped.length * 100 : 0
      };
    })(),
    trades: closed.map(t => {
      const h1Series = series.get(t.symbol).h1;
      const bars = h1Series.filter(c => c.time >= t.signalTime && c.time + H1 <= t.exitTime);
      const entry = t.signal.entry;
      const favorable = t.side === "LONG"
        ? (bars.length ? (Math.max(...bars.map(c => c.high)) / entry - 1) * 100 : 0)
        : (bars.length ? (1 - Math.min(...bars.map(c => c.low)) / entry) * 100 : 0);
      const adverse = t.side === "LONG"
        ? (bars.length ? (1 - Math.min(...bars.map(c => c.low)) / entry) * 100 : 0)
        : (bars.length ? (Math.max(...bars.map(c => c.high)) / entry - 1) * 100 : 0);
      const forwardReturn = hours => {
        const targetClose = t.signalTime + hours * H1;
        const bar = h1Series.find(c => c.time + H1 >= targetClose);
        if (!bar) return null;
        return (t.side === "LONG" ? 1 : -1) * (bar.close / entry - 1) * 100;
      };
      return {
        symbol: t.symbol, side: t.side, score: t.score,
        signalTime: new Date(t.signalTime).toISOString(),
        exitTime: new Date(t.exitTime).toISOString(),
        entry, stop: t.signal.stop, targetTrigger: t.targetTrigger,
        exitPrice: t.exitPrice, exitReason: t.exitReason, marginRoiPct: t.marginRoiPct,
        netR: t.netR, gapExit: t.gapExit,
        mfePricePct: favorable, maePricePct: adverse,
        forwardReturn4hPct: forwardReturn(4),
        forwardReturn12hPct: forwardReturn(12),
        forwardReturn24hPct: forwardReturn(24),
        features: t.features
      };
    })
  };
  await mkdir("artifacts", { recursive: true });
  await writeFile("artifacts/current-engine-25-margin-backtest.json", JSON.stringify(summary, null, 2));
  await writeFile("artifacts/current-engine-25-margin-backtest.md", [
    `# Production engine — 25% margin ROI backtest (volume threshold ${VOLUME_THRESHOLD})`,
    "",
    "```json",
    JSON.stringify({ ...summary, trades: undefined }, null, 2),
    "```"
  ].join("\n"));
  console.log("BACKTEST_SUMMARY", JSON.stringify({ ...summary, trades: undefined }));
}

main().catch(error => { console.error(error); process.exitCode = 1; });

import { analyzeFuturesSymbol, FUTURES_CONFIG } from "../src/index.js";
import { mkdir, writeFile } from "node:fs/promises";

const BASE = "https://futures.kraken.com";
const HOUR = 3600000;
const FOUR_HOURS = 4 * HOUR;
const DAYS = Math.max(15, Math.min(90, Number(process.env.BACKTEST_DAYS || 60)));
const SYMBOL_LIMIT = Math.max(1, Math.min(24, Number(process.env.BACKTEST_SYMBOLS || 24)));
const FEE = Math.max(0, Number(process.env.BACKTEST_FEE || 0.0005));
const SLIPPAGE = Math.max(0, Number(process.env.BACKTEST_SLIPPAGE || 0.0003));
const MAX_HOLD = 72;
const WEIGHTS = [0.40, 0.35, 0.25];

async function getJson(url) {
  const response = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(25000) });
  const body = await response.text();
  if (!response.ok) throw new Error("HTTP " + response.status + " for " + url + ": " + body.slice(0, 180));
  const data = JSON.parse(body);
  if (data?.result === "error") throw new Error("Kraken API error: " + JSON.stringify(data.errors || data.error));
  return data;
}

export function emaSeries(values, period) {
  if (!Array.isArray(values) || values.length < period || !(period > 0)) return [];
  const alpha = 2 / (period + 1);
  const out = new Array(values.length).fill(null);
  let value = values[0];
  out[0] = value;
  for (let i = 1; i < values.length; i++) {
    value = Number(values[i]) * alpha + value * (1 - alpha);
    out[i] = value;
  }
  return out;
}

export function rsiSeries(closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  if (closes.length <= period) return out;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const change = closes[i] - closes[i - 1];
    gain += Math.max(change, 0);
    loss += Math.max(-change, 0);
  }
  let avgGain = gain / period, avgLoss = loss / period;
  out[period] = avgLoss === 0 ? 100 : avgGain === 0 ? 0 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(change, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-change, 0)) / period;
    out[i] = avgLoss === 0 ? 100 : avgGain === 0 ? 0 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

export function atrSeries(candles, period = 14) {
  const out = new Array(candles.length).fill(null);
  if (candles.length <= period) return out;
  const tr = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], prev = candles[i - 1];
    tr.push(Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close)));
  }
  let value = tr.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period] = value;
  for (let i = period + 1; i < candles.length; i++) {
    value = (value * (period - 1) + tr[i - 1]) / period;
    out[i] = value;
  }
  return out;
}

export function candidateSignal(candles, index = candles.length - 1) {
  if (!Array.isArray(candles) || index < 199 || index >= candles.length) return null;
  const window = candles.slice(0, index + 1);
  const closes = window.map(c => c.close);
  const e50 = emaSeries(closes, 50);
  const e200 = emaSeries(closes, 200);
  const fast = emaSeries(closes, 12);
  const slow = emaSeries(closes, 26);
  const macdLine = fast.map((v, i) => v - slow[i]);
  const macdSignal = emaSeries(macdLine, 9);
  const rsi = rsiSeries(closes, 14);
  const atr = atrSeries(window, 14);
  const last = index;
  const price = closes[last];
  const hist = macdLine[last] - macdSignal[last];
  if (![price, e50[last], e200[last], hist, rsi[last], atr[last]].every(Number.isFinite) || atr[last] <= 0) return null;
  if (price > e200[last] && rsi[last] > 50 && hist > 0 && e50[last] > e200[last]) {
    return { side: "LONG", atr: atr[last], rsi: rsi[last], ema50: e50[last], ema200: e200[last], macdHistogram: hist };
  }
  if (price < e200[last] && rsi[last] < 50 && hist < 0 && e50[last] < e200[last]) {
    return { side: "SHORT", atr: atr[last], rsi: rsi[last], ema50: e50[last], ema200: e200[last], macdHistogram: hist };
  }
  return null;
}

function normalizeCandles(rows, intervalMs) {
  if (!Array.isArray(rows)) throw new Error("Kraken candles array missing");
  const seen = new Set();
  return rows.map(row => ({
    time: Number(row.time) < 1e12 ? Number(row.time) * 1000 : Number(row.time),
    open: Number(row.open), high: Number(row.high), low: Number(row.low),
    close: Number(row.close), volume: Number(row.volume)
  })).filter(c =>
    Number.isFinite(c.time) && [c.open,c.high,c.low,c.close,c.volume].every(Number.isFinite) &&
    c.open > 0 && c.close > 0 && c.low > 0 && c.high >= c.low && c.volume >= 0
  ).sort((a,b)=>a.time-b.time).filter(c => {
    if (seen.has(c.time) || c.time + intervalMs > Date.now()) return false;
    seen.add(c.time); return true;
  });
}

async function fetchCandles(symbol, resolution, fromMs, toMs, intervalMs) {
  const url = new URL(BASE + "/api/charts/v1/trade/" + encodeURIComponent(symbol) + "/" + resolution);
  url.searchParams.set("from", String(Math.floor(fromMs / 1000)));
  url.searchParams.set("to", String(Math.floor(toMs / 1000)));
  url.searchParams.set("count", "2000");
  const data = await getJson(url);
  if (data.more_candles === true) throw new Error(symbol + " " + resolution + ": historical candle limit exceeded");
  return normalizeCandles(data.candles, intervalMs);
}

function historicalChange(candles, index) {
  const old = candles[index - 24], now = candles[index];
  return old?.close > 0 ? (now.close / old.close - 1) * 100 : 0;
}

function fillPrice(raw, side, isEntry) {
  const direction = side === "LONG" ? 1 : -1;
  return raw * (1 + (isEntry ? direction : -direction) * SLIPPAGE);
}

export function simulatePosition({ side, entry, stop, targets, weights, candles, fee = FEE, maxHold = MAX_HOLD }) {
  const direction = side === "LONG" ? 1 : -1;
  const risk = direction === 1 ? entry - stop : stop - entry;
  if (!(risk > 0) || !Number.isFinite(risk)) throw new Error("Invalid risk");
  let remaining = 1, netR = -(fee * entry / risk), targetHits = 0, exitReason = "TIME_EXIT";
  let exitTime = candles.at(-1)?.time ?? null;
  const lastIndex = Math.min(candles.length - 1, maxHold);
  for (let i = 0; i <= lastIndex && remaining > 1e-9; i++) {
    const bar = candles[i];
    const stopGap = direction === 1 ? bar.open <= stop : bar.open >= stop;
    const stopTouched = direction === 1 ? bar.low <= stop : bar.high >= stop;
    if (stopGap || stopTouched) {
      const rawExit = stopGap ? bar.open : stop;
      const exit = fillPrice(rawExit, side, false);
      netR += remaining * (direction * (exit - entry) / risk - fee * exit / risk);
      remaining = 0; exitReason = "STOP"; exitTime = bar.time;
      break;
    }
    for (let j = 0; j < targets.length && remaining > 1e-9; j++) {
      if (targets[j] == null) continue;
      const touched = direction === 1 ? bar.high >= targets[j] : bar.low <= targets[j];
      if (!touched) continue;
      const weight = Math.min(remaining, weights[j]);
      const exit = fillPrice(targets[j], side, false);
      netR += weight * (direction * (exit - entry) / risk - fee * exit / risk);
      remaining -= weight; targetHits++;
    }
    if (remaining <= 1e-9) { remaining = 0; exitReason = "TARGETS"; exitTime = bar.time; break; }
    if (i === lastIndex) {
      const exit = fillPrice(bar.close, side, false);
      netR += remaining * (direction * (exit - entry) / risk - fee * exit / risk);
      remaining = 0; exitReason = "TIME_EXIT"; exitTime = bar.time;
    }
  }
  return { side, entry, stop, risk, netR, targetHits, exitReason, entryTime: candles[0]?.time ?? null, exitTime };
}

function metrics(trades) {
  const wins = trades.filter(t => t.netR > 0), losses = trades.filter(t => t.netR < 0);
  const grossWin = wins.reduce((s,t)=>s+t.netR,0);
  const grossLoss = Math.abs(losses.reduce((s,t)=>s+t.netR,0));
  let equity = 0, peak = 0, maxDrawdownR = 0;
  for (const t of [...trades].sort((a,b)=>a.entryTime-b.entryTime)) {
    equity += t.netR; peak = Math.max(peak,equity); maxDrawdownR = Math.max(maxDrawdownR,peak-equity);
  }
  const durations = trades.map(t => (t.exitTime - t.entryTime) / HOUR).filter(Number.isFinite);
  return {
    trades: trades.length, wins: wins.length, losses: losses.length,
    winRatePct: trades.length ? wins.length / trades.length * 100 : 0,
    netR: trades.reduce((s,t)=>s+t.netR,0),
    expectancyR: trades.length ? trades.reduce((s,t)=>s+t.netR,0) / trades.length : 0,
    profitFactor: grossLoss ? grossWin / grossLoss : grossWin ? null : 0,
    maxDrawdownR, avgHoldHours: durations.length ? durations.reduce((a,b)=>a+b,0)/durations.length : 0
  };
}

function summarize(trades) {
  return {
    overall: metrics(trades),
    LONG: metrics(trades.filter(t=>t.side==="LONG")),
    SHORT: metrics(trades.filter(t=>t.side==="SHORT"))
  };
}

async function testSymbol(ticker, fromMs, toMs) {
  const [oneHour,fourHour] = await Promise.all([
    fetchCandles(ticker.symbol,"1h",fromMs,toMs,HOUR),
    fetchCandles(ticker.symbol,"4h",fromMs,toMs,FOUR_HOURS)
  ]);
  if (oneHour.length < 220 || fourHour.length < FUTURES_CONFIG.MIN_CANDLES) {
    throw new Error("Insufficient candles: 1h=" + oneHour.length + ", 4h=" + fourHour.length);
  }
  const baseline = [], candidate = [];
  let baselineFree = 220, candidateFree = 220;
  for (let i = 200; i < oneHour.length - 1; i++) {
    const signalBar = oneHour[i], entryBar = oneHour[i + 1];
    const closedAt = signalBar.time + HOUR;
    if (i >= baselineFree) {
      const closed4h = fourHour.filter(c => c.time + FOUR_HOURS <= closedAt);
      if (closed4h.length >= FUTURES_CONFIG.MIN_CANDLES) {
        const tickerAtSignal = {
          symbol: ticker.symbol, last: signalBar.close, quoteVolume: Number(ticker.volumeQuote) || 0,
          priceChangePercent: historicalChange(oneHour, i), premium: { lastFundingRate: null }
        };
        const plan = analyzeFuturesSymbol(tickerAtSignal, oneHour.slice(0, i + 1), closed4h);
        if (plan?.eligible) {
          const side = plan.side;
          const direction = side === "LONG" ? 1 : -1;
          const rawEntry = entryBar.open;
          const entry = fillPrice(rawEntry, side, true);
          const riskDistance = side === "LONG" ? plan.entry - plan.stop : plan.stop - plan.entry;
          const stop = entry - direction * riskDistance;
          const targets = [1.5, 2.5, 3.5].map(r => entry + direction * riskDistance * r);
          const trade = simulatePosition({
            side, entry, stop, targets, weights: WEIGHTS,
            candles: oneHour.slice(i + 1, i + 1 + MAX_HOLD + 1)
          });
          trade.symbol = ticker.symbol; trade.signalTime = signalBar.time;
          baseline.push(trade);
          baselineFree = i + 1 + Math.max(1, Math.ceil((trade.exitTime - trade.entryTime) / HOUR));
        }
      }
    }
    if (i >= candidateFree) {
      const setup = candidateSignal(oneHour, i);
      if (setup) {
        const side = setup.side, direction = side === "LONG" ? 1 : -1;
        const rawEntry = entryBar.open;
        const entry = fillPrice(rawEntry, side, true);
        const riskDistance = setup.atr * 1.5;
        const stop = entry - direction * riskDistance;
        const target = entry + direction * riskDistance * 2;
        const trade = simulatePosition({
          side, entry, stop, targets: [target], weights: [1],
          candles: oneHour.slice(i + 1, i + 1 + MAX_HOLD + 1)
        });
        trade.symbol = ticker.symbol; trade.signalTime = signalBar.time;
        trade.rsi = setup.rsi; trade.atr = setup.atr;
        candidate.push(trade);
        candidateFree = i + 1 + Math.max(1, Math.ceil((trade.exitTime - trade.entryTime) / HOUR));
      }
    }
  }
  return {
    symbol: ticker.symbol, candles1h: oneHour.length, candles4h: fourHour.length,
    baseline, candidate,
    baselineMetrics: summarize(baseline), candidateMetrics: summarize(candidate)
  };
}

function aggregate(results, key) {
  return summarize(results.flatMap(r => r[key] || []).sort((a,b)=>a.entryTime-b.entryTime));
}

async function main() {
  const end = Date.now(), start = end - DAYS * 24 * HOUR, from = start - 15 * 24 * HOUR;
  const tickerData = await getJson(BASE + "/derivatives/api/v3/tickers");
  const universe = (tickerData.tickers || []).filter(t =>
    t?.tag === "perpetual" && t.suspended !== true &&
    /^(PI|PF)_[A-Z0-9]+USD$/.test(String(t.symbol || "")) &&
    Number(t.volumeQuote) >= FUTURES_CONFIG.MIN_QUOTE_VOLUME && Number(t.last) > 0
  ).sort((a,b)=>Number(b.volumeQuote)-Number(a.volumeQuote)).slice(0,SYMBOL_LIMIT);
  if (!universe.length) throw new Error("No eligible Kraken perpetual contracts found");
  const results = [];
  for (const ticker of universe) {
    try { results.push(await testSymbol(ticker, from, end)); }
    catch (error) { results.push({ symbol:ticker.symbol, error:error.message, baseline:[], candidate:[] }); }
  }
  const baseline = aggregate(results,"baseline"), candidate = aggregate(results,"candidate");
  const report = {
    generatedAt: new Date().toISOString(),
    venue: "Kraken Derivatives public historical OHLCV",
    period: { from:new Date(start).toISOString(), to:new Date(end).toISOString(), days:DAYS },
    settings: {
      symbolsRequested: SYMBOL_LIMIT, symbolsTested: results.filter(r=>!r.error).length,
      feePerSidePct: FEE*100, slippagePerSidePct: SLIPPAGE*100,
      maxHoldHours: MAX_HOLD, currentEngineTargets: "40/35/25 at 1.5R/2.5R/3.5R",
      submittedModel: "EMA50>EMA200, close>EMA200, RSI>50, MACD histogram>0; inverse for SHORT; stop 1.5 ATR; full exit at 2R",
      entry: "next 1h candle open after signal candle closes; adverse entry and exit slippage",
      intrabarAmbiguity: "stop is evaluated before targets when both are touched in the same candle",
      funding: "excluded; historical funding series not included",
      universeBias: "current top-volume eligible perpetual contracts, not historical point-in-time universe",
      indicatorWarmup: "200 completed 1h candles; no forming candle used",
      currentEngine: "analyzeFuturesSymbol strict eligible signals only; same historical closed 1h/4h data"
    },
    baseline, candidate,
    delta: {
      profitFactor: (candidate.overall.profitFactor ?? 0) - (baseline.overall.profitFactor ?? 0),
      expectancyR: candidate.overall.expectancyR - baseline.overall.expectancyR,
      netR: candidate.overall.netR - baseline.overall.netR,
      winRatePct: candidate.overall.winRatePct - baseline.overall.winRatePct
    },
    symbols: results.map(({baseline,candidate,...r})=>({
      ...r, baseline: summarize(baseline), candidate: summarize(candidate)
    }))
  };
  await mkdir("artifacts",{recursive:true});
  await writeFile("artifacts/ema-macd-vs-current.json",JSON.stringify(report,null,2));
  const fmt = x => x == null ? "n/a" : Number(x).toFixed(2);
  const lines = [
    "# Submitted EMA/MACD/RSI model vs current engine","",
    "Period: " + report.period.from + " to " + report.period.to + " (" + DAYS + " days)",
    "Successfully tested symbols: " + report.settings.symbolsTested + "/" + SYMBOL_LIMIT,
    "",
    "| Metric | Current engine | Submitted model |",
    "|---|---:|---:|",
    "| Trades | " + baseline.overall.trades + " | " + candidate.overall.trades + " |",
    "| Win rate | " + fmt(baseline.overall.winRatePct) + "% | " + fmt(candidate.overall.winRatePct) + "% |",
    "| Net R | " + fmt(baseline.overall.netR) + " | " + fmt(candidate.overall.netR) + " |",
    "| Expectancy | " + fmt(baseline.overall.expectancyR) + "R | " + fmt(candidate.overall.expectancyR) + "R |",
    "| Profit factor | " + fmt(baseline.overall.profitFactor) + " | " + fmt(candidate.overall.profitFactor) + " |",
    "| Max drawdown | " + fmt(baseline.overall.maxDrawdownR) + "R | " + fmt(candidate.overall.maxDrawdownR) + "R |",
    "| Average hold | " + fmt(baseline.overall.avgHoldHours) + "h | " + fmt(candidate.overall.avgHoldHours) + "h |",
    "",
    "## Direction breakdown",
    "| Model / side | Trades | Win rate | Net R | Expectancy | PF | Max DD |",
    "|---|---:|---:|---:|---:|---:|---:|",
    ...["baseline","candidate"].flatMap(k => ["LONG","SHORT"].map(side => {
      const m = report[k][side];
      return "| " + (k==="baseline"?"Current":"Submitted") + " " + side + " | " + m.trades + " | " + fmt(m.winRatePct) + "% | " + fmt(m.netR) + "R | " + fmt(m.expectancyR) + "R | " + fmt(m.profitFactor) + " | " + fmt(m.maxDrawdownR) + "R |";
    })),
    "",
    "## Method and limitations",
    "- Same Kraken perpetual universe and same historical 1h candles for both models; current model also uses only fully closed 4h candles.",
    "- Signals use a completed candle; entry is the next 1h candle open, with adverse slippage applied.",
    "- Both models include assumed taker fee and slippage on entry and exits. Current engine keeps its partial 40/35/25 targets; submitted model exits 100% at 2R.",
    "- If stop and target are both touched in one candle, stop is assumed first.",
    "- Historical funding is excluded. Universe selection uses today's liquidity and may introduce survivorship bias.",
    "- This is a price-based simulation, not a guarantee of live fills or profitability.",
    "",
    "| Symbol | Trades current | PF current | Trades submitted | PF submitted | Error |",
    "|---|---:|---:|---:|---:|---|",
    ...report.symbols.map(r => "| " + r.symbol + " | " + (r.baseline?.overall?.trades ?? 0) + " | " + fmt(r.baseline?.overall?.profitFactor) + " | " + (r.candidate?.overall?.trades ?? 0) + " | " + fmt(r.candidate?.overall?.profitFactor) + " | " + (r.error || "").replaceAll("|","/") + " |")
  ];
  await writeFile("artifacts/ema-macd-vs-current.md",lines.join("\n"));
  console.log(JSON.stringify({
    ok:true, period:report.period, tested:report.settings.symbolsTested,
    baseline:report.baseline, candidate:report.candidate, delta:report.delta,
    errors:report.symbols.filter(x=>x.error).map(x=>({symbol:x.symbol,error:x.error}))
  },null,2));
}

if (process.argv[1] && process.argv[1].endsWith("compare-ema-macd-backtest.mjs")) {
  main().catch(error=>{console.error(error);process.exitCode=1;});
}

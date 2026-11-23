import { analyzeAurum, AURUM_CONFIG } from "../experimental/aurum/aurum_fixed/aurum-engine.js";
import { mkdir, writeFile } from "node:fs/promises";

const BASE = "https://api.kraken.com/0/public/Trades";
const BAR15 = 15 * 60;
const BAR4H = 4 * 60 * 60;
const DAY = 86400;
const END = Math.floor(Date.now() / 1000);
const START = END - 365 * DAY;
const WARMUP = START - 30 * DAY;
const FEE = Number(process.env.AURUM_TAKER_FEE ?? 0.002); // Bitfinex base-tier taker assumption, per side
const SLIPPAGE = Number(process.env.AURUM_SLIPPAGE ?? 0.0005); // 5 bps per side
const MAX_HOLD_BARS = 96; // 24h on 15m candles
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function getJson(url) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const response = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(30000) });
    const body = await response.text();
    if (!response.ok) {
      if (response.status === 429 || response.status >= 500) { await sleep(1500 * (attempt + 1)); continue; }
      throw new Error(`Kraken HTTP ${response.status}: ${body.slice(0, 300)}`);
    }
    const data = JSON.parse(body);
    if (data.error?.length) {
      const message = data.error.join("; ");
      if (/Too many requests|rate limit/i.test(message)) { await sleep(2000 * (attempt + 1)); continue; }
      throw new Error("Kraken API: " + message);
    }
    return data;
  }
  throw new Error("Kraken API retries exhausted");
}

const BITFINEX_BASE = "https://api-pub.bitfinex.com/v2/candles";

async function fetchCandleChunk(symbol, timeframe, fromMs, toMs) {
  const url = new URL(`${BITFINEX_BASE}/trade:${timeframe}:${symbol}/hist`);
  url.searchParams.set("start", String(fromMs));
  url.searchParams.set("end", String(toMs));
  url.searchParams.set("limit", "10000");
  url.searchParams.set("sort", "1");
  const response = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(30000) });
  const body = await response.text();
  if (!response.ok) throw new Error(`Bitfinex HTTP ${response.status}: ${body.slice(0, 240)}`);
  const rows = JSON.parse(body);
  if (!Array.isArray(rows)) throw new Error("Bitfinex candle response is not an array: " + body.slice(0, 240));
  return rows.map(row => ({
    timestamp: Number(row[0]), open: Number(row[1]), close: Number(row[2]),
    high: Number(row[3]), low: Number(row[4]), volume: Number(row[5])
  })).filter(c => Number.isFinite(c.timestamp) && [c.open,c.high,c.low,c.close,c.volume].every(Number.isFinite) &&
    c.open > 0 && c.low > 0 && c.high >= c.low && c.close > 0 && c.volume >= 0);
}

async function fetchBitfinexCandles(symbol, timeframe, intervalMs, fromMs, toMs) {
  const maxBars = 9000;
  const chunkMs = maxBars * intervalMs;
  const rows = [];
  let requests = 0;
  for (let start = fromMs; start < toMs; start += chunkMs) {
    const end = Math.min(toMs - 1, start + chunkMs - 1);
    const batch = await fetchCandleChunk(symbol, timeframe, start, end);
    rows.push(...batch);
    requests++;
    if (requests % 2 === 0) console.log(`Bitfinex ${symbol} ${timeframe}: ${rows.length} candles across ${requests} requests`);
    await sleep(250);
  }
  const byTime = new Map(rows.map(c => [c.timestamp,c]));
  const sorted = [...byTime.values()].sort((a,b)=>a.timestamp-b.timestamp);
  if (!sorted.length) throw new Error(`No ${timeframe} candles returned for ${symbol}`);
  const first = Math.floor(fromMs / intervalMs) * intervalMs;
  const last = Math.floor((toMs - 1) / intervalMs) * intervalMs;
  const filled = [];
  let previousClose = null, index = 0;
  for (let ts = first; ts <= last; ts += intervalMs) {
    while (index < sorted.length && sorted[index].timestamp < ts) index++;
    const candle = sorted[index]?.timestamp === ts ? sorted[index] : null;
    if (candle) {
      filled.push(candle);
      previousClose = candle.close;
      index++;
    } else if (previousClose != null) {
      filled.push({ timestamp: ts, open: previousClose, high: previousClose, low: previousClose, close: previousClose, volume: 0 });
    }
  }
  return { candles: filled, requests, rawCandles: sorted.length };
}

function aggregateHourlyTo4h(hourly) {
  const buckets = new Map();
  for (const c of hourly) {
    const ts = Math.floor(c.timestamp / (BAR4H * 1000)) * (BAR4H * 1000);
    let b = buckets.get(ts);
    if (!b) buckets.set(ts, b = { timestamp: ts, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume });
    else {
      b.high = Math.max(b.high,c.high);
      b.low = Math.min(b.low,c.low);
      b.close = c.close;
      b.volume += c.volume;
    }
  }
  return [...buckets.values()].sort((a,b)=>a.timestamp-b.timestamp);
}

async function loadMarketData() {
  const fromMs = WARMUP * 1000;
  const toMs = END * 1000;
  const symbols = ["tXAUTUSD", "tXAUT:USD"];
  let lastError = null;
  for (const symbol of symbols) {
    try {
      console.log(`Loading XAUT/USD candles from Bitfinex using ${symbol}...`);
      const [m15, h1] = await Promise.all([
        fetchBitfinexCandles(symbol, "15m", BAR15 * 1000, fromMs, toMs),
        fetchBitfinexCandles(symbol, "1h", 60 * 60 * 1000, fromMs, toMs)
      ]);
      if (m15.rawCandles < 1000 || h1.rawCandles < 100) throw new Error(`Insufficient candles for ${symbol}: 15m=${m15.rawCandles}, 1h=${h1.rawCandles}`);
      return {
        symbol, candles15: m15.candles, candles4h: aggregateHourlyTo4h(h1.candles),
        raw15m: m15.rawCandles, raw1h: h1.rawCandles, requests: m15.requests + h1.requests
      };
    } catch (error) {
      lastError = error;
      console.log(`Bitfinex symbol ${symbol} unavailable: ${error.message}`);
    }
  }
  throw new Error("Unable to load exact XAUT/USD candles from Bitfinex: " + (lastError?.message || "unknown error"));
}

function simulate(signal, bars, entryIndex) {
  const dir = signal.side === "LONG" ? 1 : -1;
  const next = bars[entryIndex];
  const rawEntry = next.open;
  const drift = Math.abs(rawEntry - signal.entry) / signal.atr15m;
  if (drift > AURUM_CONFIG.maxEntryDriftAtr) return { skipped: "next_open_gap" };
  const entry = rawEntry * (1 + dir * SLIPPAGE);
  const stop = signal.stop;
  const risk = dir * (entry - stop);
  if (!(risk > 0) || !Number.isFinite(risk)) return { skipped: "invalid_risk" };
  const target = entry + dir * risk * AURUM_CONFIG.tp1R;
  const endIndex = Math.min(bars.length - 1, entryIndex + MAX_HOLD_BARS);
  let exitRaw = null, exitReason = null, exitIndex = endIndex;
  for (let i = entryIndex; i <= endIndex; i++) {
    const b = bars[i];
    const stopGap = dir === 1 ? b.open <= stop : b.open >= stop;
    const stopHit = dir === 1 ? b.low <= stop : b.high >= stop;
    const targetHit = dir === 1 ? b.high >= target : b.low <= target;
    if (stopGap || stopHit) {
      exitRaw = stopGap ? b.open : stop;
      exitReason = "STOP";
      exitIndex = i;
      break;
    }
    // Conservative OHLC assumption: if both levels could be touched in one bar, stop is checked first.
    if (targetHit) {
      exitRaw = target;
      exitReason = "TP1";
      exitIndex = i;
      break;
    }
    if (i === endIndex) {
      exitRaw = b.close;
      exitReason = "TIME_EXIT";
    }
  }
  const exit = exitRaw * (1 - dir * SLIPPAGE);
  const grossR = dir * (exit - entry) / risk;
  const feesR = FEE * (entry + exit) / risk;
  return {
    skipped: null, side: signal.side, entry, stop, target, exit,
    riskPct: risk / entry * 100, grossR, feesR, netR: grossR - feesR,
    exitReason, signalTime: bars[entryIndex - 1].timestamp,
    entryTime: next.timestamp, exitTime: bars[exitIndex].timestamp,
    holdBars: exitIndex - entryIndex, score: signal.score, session: signal.session
  };
}

function metrics(trades) {
  const grossWins = trades.filter(t => t.grossR > 0), grossLosses = trades.filter(t => t.grossR < 0);
  const netWins = trades.filter(t => t.netR > 0), netLosses = trades.filter(t => t.netR < 0);
  const grossWin = grossWins.reduce((s,t)=>s+t.grossR,0);
  const grossLoss = Math.abs(grossLosses.reduce((s,t)=>s+t.grossR,0));
  const netWin = netWins.reduce((s,t)=>s+t.netR,0);
  const netLoss = Math.abs(netLosses.reduce((s,t)=>s+t.netR,0));
  let equity = 0, peak = 0, maxDD = 0;
  for (const t of trades) { equity += t.netR; peak = Math.max(peak,equity); maxDD = Math.max(maxDD,peak-equity); }
  const bySide = Object.fromEntries(["LONG","SHORT"].map(side => {
    const xs = trades.filter(t=>t.side===side);
    const gw=xs.filter(t=>t.grossR>0), gl=xs.filter(t=>t.grossR<0);
    const nw=xs.filter(t=>t.netR>0), nl=xs.filter(t=>t.netR<0);
    const gp=gw.reduce((s,t)=>s+t.grossR,0), gLoss=Math.abs(gl.reduce((s,t)=>s+t.grossR,0));
    return [side,{
      trades:xs.length,grossWins:gw.length,grossWinRatePct:xs.length?gw.length/xs.length*100:0,
      grossR:xs.reduce((s,t)=>s+t.grossR,0),grossProfitFactor:gLoss?gp/gLoss:gp?null:0,
      netWins:nw.length,netWinRatePct:xs.length?nw.length/xs.length*100:0,
      netR:xs.reduce((s,t)=>s+t.netR,0)
    }];
  }));
  return {
    trades: trades.length,
    grossWins: grossWins.length, grossLosses: grossLosses.length,
    grossWinRatePct: trades.length ? grossWins.length / trades.length * 100 : 0,
    grossR: trades.reduce((s,t)=>s+t.grossR,0),
    grossExpectancyR: trades.length ? trades.reduce((s,t)=>s+t.grossR,0) / trades.length : 0,
    grossProfitFactor: grossLoss ? grossWin / grossLoss : grossWin ? null : 0,
    averageGrossWinR: grossWins.length ? grossWin / grossWins.length : 0,
    averageGrossLossR: grossLosses.length ? -grossLoss / grossLosses.length : 0,
    netWins: netWins.length, netLosses: netLosses.length,
    netWinRatePct: trades.length ? netWins.length / trades.length * 100 : 0,
    feesR: trades.reduce((s,t)=>s+t.feesR,0),
    netR: trades.reduce((s,t)=>s+t.netR,0),
    netExpectancyR: trades.length ? trades.reduce((s,t)=>s+t.netR,0) / trades.length : 0,
    netProfitFactor: netLoss ? netWin / netLoss : netWin ? null : 0,
    maxDrawdownR: maxDD,
    averageHoldHours: trades.length ? trades.reduce((s,t)=>s+t.holdBars,0) * 0.25 / trades.length : 0,
    bySide
  };
}

async function main() {
  console.log("Downloading one-year XAUT/USD OHLCV candles...");
  const marketData = await loadMarketData();
  const candles15 = marketData.candles15;
  const candles4h = marketData.candles4h;
  console.log(`Loaded ${marketData.raw15m} native 15m candles and ${marketData.raw1h} native 1h candles in ${marketData.requests} requests.`);
  const firstTestIndex = candles15.findIndex(c => c.timestamp >= START * 1000);
  if (firstTestIndex < 120 || candles4h.length < 100) throw new Error("Not enough warm-up candles to start a valid backtest");
  let state = {};
  const tradesOut = [];
  let signals = 0, skippedOverlap = 0, skippedGap = 0, skippedRisk = 0;
  let busyUntil = -1, h4Index = 0;
  for (let i = firstTestIndex; i < candles15.length - 1; i++) {
    const bar = candles15[i];
    while (h4Index < candles4h.length && candles4h[h4Index].timestamp + BAR4H * 1000 <= bar.timestamp) h4Index++;
    const closed4h = candles4h.slice(0, h4Index);
    if (closed4h.length < 60) continue;
    const c15 = candles15.slice(Math.max(0, i - 119), i + 1);
    const result = analyzeAurum({
      symbol: "XAUTUSD", candles15m: c15, candles4h: closed4h,
      price: bar.close, lastCandleClosed: true, state
    });
    if (result.nextState) state = result.nextState;
    if (!result.eligible) continue;
    signals++;
    if (i <= busyUntil) { skippedOverlap++; continue; }
    const simulated = simulate(result, candles15, i + 1);
    if (simulated.skipped === "next_open_gap") { skippedGap++; continue; }
    if (simulated.skipped) { skippedRisk++; continue; }
    tradesOut.push(simulated);
    busyUntil = Math.max(i + 1, Math.floor((simulated.exitTime - candles15[0].timestamp) / (BAR15 * 1000)));
    if (signals % 25 === 0) console.log(`Signals: ${signals}; executed trades: ${tradesOut.length}`);
  }
  const report = {
    strategy: "Aurum v1.1",
    symbol: "XAUT/USD",
    exchange: "Kraken Spot",
    period: { start: new Date(START * 1000).toISOString(), end: new Date(END * 1000).toISOString() },
    data: { source: "Bitfinex public REST historical OHLCV candles", marketSymbol: marketData.symbol, raw15mCandles: marketData.raw15m, raw1hCandles: marketData.raw1h, requests: marketData.requests, candles15m: candles15.length, candles4h: candles4h.length, missingIntervalsFilledFlatAtPreviousClose: true },
    executionAssumptions: {
      entry: "next 15m candle open after a closed-candle signal",
      exit: "all-out at TP1 (1R), stop, or 24h time exit",
      sameCandleAmbiguity: "stop checked before target",
      feePerSide: FEE, slippagePerSide: SLIPPAGE,
      feeNote: "Default fee is an assumed Bitfinex base-tier taker rate; actual fee depends on the account tier and must be substituted for an account-specific result.",
      management: "TP2/TP3 and BE/trailing settings are not applied because the supplied engine does not define partial-exit weights or trailing-stop mechanics."
    },
    counts: { signals, executedTrades: tradesOut.length, skippedOverlap, skippedNextOpenGap: skippedGap, skippedInvalidRisk: skippedRisk },
    metrics: metrics(tradesOut),
    trades: tradesOut
  };
  await mkdir("artifacts", { recursive: true });
  await writeFile("artifacts/aurum-xaut-1y-report.json", JSON.stringify(report, null, 2));
  const cols = ["side","entry","stop","target","exit","grossR","feesR","netR","exitReason","signalTime","entryTime","exitTime","holdBars","score","session"];
  const csv = [cols.join(","), ...tradesOut.map(t=>cols.map(k=>JSON.stringify(t[k] ?? "")).join(","))].join("\n");
  await writeFile("artifacts/aurum-xaut-1y-trades.csv", csv);
  const m = report.metrics;
  const md = [
    "# Aurum v1.1 — XAUT/USD 1-year Bitfinex backtest",
    `Period: ${report.period.start} → ${report.period.end}`,
    `Native 15m candles: ${marketData.raw15m} | Native 1h candles: ${marketData.raw1h} | 15m bars after gap fill: ${candles15.length} | 4h bars: ${candles4h.length}`,
    `Signals: ${signals} | Executed: ${tradesOut.length} | Overlap skipped: ${skippedOverlap} | Gap skipped: ${skippedGap}`,
    `Gross win rate: ${m.grossWinRatePct.toFixed(2)}% | Gross PF: ${m.grossProfitFactor == null ? "∞" : m.grossProfitFactor.toFixed(3)} | Gross R: ${m.grossR.toFixed(3)}` ,
    `Net win rate: ${m.netWinRatePct.toFixed(2)}% | Net R: ${m.netR.toFixed(3)} | Net PF: ${m.netProfitFactor == null ? "∞" : m.netProfitFactor.toFixed(3)} | Max DD: ${m.maxDrawdownR.toFixed(3)}R`,
    `Fees R: ${m.feesR.toFixed(3)} | Gross expectancy: ${m.grossExpectancyR.toFixed(4)}R | Net expectancy: ${m.netExpectancyR.toFixed(4)}R/trade`,
    `Fee/side (assumption): ${(FEE*100).toFixed(3)}% | Slippage/side: ${(SLIPPAGE*100).toFixed(3)}%`,
    "",
    "Execution assumptions: next 15m open entry; all-out at TP1/SL/24h time exit; stop-first for same-candle ambiguity.",
    "TP2/TP3 and BE/trailing are excluded because the supplied signal engine does not specify position sizing across targets or a trailing-stop algorithm."
  ].join("\n");
  await writeFile("artifacts/aurum-xaut-1y-report.md", md);
  console.log(md);
}
main().catch(error => { console.error(error); process.exitCode = 1; });

// Workflow trigger refresh: run from an isolated experimental branch.

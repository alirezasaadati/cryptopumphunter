import { mkdir, writeFile } from "node:fs/promises";
import { analyzeFuturesSymbol as analyzeV490 } from "../src/v49-engine.mjs";
import { analyzeFuturesSymbol as analyzeCurrent } from "../src/current-main-engine.mjs";

const BASE = "https://futures.kraken.com";
const MS = { "5m": 300000, "15m": 900000, "1h": 3600000, "4h": 14400000 };
const WARMUP_DAYS = 20;
const FEE = Number(process.env.BACKTEST_FEE_PER_SIDE || 0.0005);
const SLIPPAGE = Number(process.env.BACKTEST_SLIPPAGE_PER_SIDE || 0.0003);
const SYMBOL_LIMIT = Math.max(5, Math.min(12, Number(process.env.BACKTEST_SYMBOL_LIMIT || 10)));
const PERIOD = {
  name: "SHORT_BEAR_2025_Q1",
  side: "SHORT",
  start: "2025-01-15T00:00:00Z",
  end: "2025-03-16T00:00:00Z"
};
const TARGETS = [
  { key: "TP1", field: "target1", label: "1.5R" },
  { key: "TP2", field: "target2", label: "2.2R" },
  { key: "TP3", field: "target3", label: "3.0R" }
];
const ENGINES = [
  { key: "production_main", label: "Current production main branch", analyze: analyzeCurrent },
  { key: "supplied_v490", label: "User-supplied v4.9.0", analyze: analyzeV490 }
];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function getJson(url, attempt = 0) {
  const response = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(30000) });
  const body = await response.text();
  if (!response.ok) {
    if (attempt < 5 && (response.status === 429 || response.status >= 500)) {
      await sleep(700 * (attempt + 1));
      return getJson(url, attempt + 1);
    }
    throw new Error("HTTP " + response.status + " for " + url + ": " + body.slice(0, 180));
  }
  let data;
  try { data = JSON.parse(body); } catch { throw new Error("Invalid JSON from " + url); }
  if (data?.result === "error" || (Array.isArray(data?.errors) && data.errors.length)) {
    throw new Error("Kraken API error: " + JSON.stringify(data.errors || data.error));
  }
  return data;
}

function normalizeCandles(rows, intervalMs) {
  if (!Array.isArray(rows)) throw new Error("Kraken candles array missing");
  const seen = new Set();
  return rows.map(row => ({
    time: Number(row.time) < 1e12 ? Number(row.time) * 1000 : Number(row.time),
    open: Number(row.open), high: Number(row.high), low: Number(row.low),
    close: Number(row.close), volume: Number(row.volume)
  })).filter(c =>
    Number.isFinite(c.time) &&
    [c.open, c.high, c.low, c.close, c.volume].every(Number.isFinite) &&
    c.open > 0 && c.close > 0 && c.low > 0 && c.high >= c.low && c.volume >= 0 &&
    c.time + intervalMs <= Date.now()
  ).sort((a, b) => a.time - b.time).filter(c => {
    if (seen.has(c.time)) return false;
    seen.add(c.time);
    return true;
  });
}

async function fetchHistoricalCandles(symbol, resolution, fromMs, toMs) {
  const intervalMs = MS[resolution];
  const chunkMs = intervalMs * 1650;
  const combined = [];
  for (let start = fromMs; start < toMs; start += chunkMs) {
    const end = Math.min(toMs, start + chunkMs);
    const url = new URL(BASE + "/api/charts/v1/trade/" + encodeURIComponent(symbol) + "/" + resolution);
    url.searchParams.set("from", String(Math.floor(start / 1000)));
    url.searchParams.set("to", String(Math.floor(end / 1000)));
    url.searchParams.set("count", "1750");
    const data = await getJson(url);
    if (data.more_candles === true) throw new Error(symbol + " " + resolution + ": incomplete Kraken candle chunk");
    combined.push(...normalizeCandles(data.candles, intervalMs));
    await sleep(80);
  }
  const byTime = new Map(combined.map(c => [c.time, c]));
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

function historicalChange(candles, index) {
  const old = candles[index - 24], current = candles[index];
  return !old || old.close <= 0 ? 0 : ((current.close / old.close) - 1) * 100;
}

function lowerBound(candles, time) {
  let lo = 0, hi = candles.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (candles[mid].time < time) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function simulateTarget({ candidate, target, candles, fromTime, endTime }) {
  const direction = -1;
  const rawEntry = Number(candidate.entry);
  const entryFill = rawEntry * (1 + direction * SLIPPAGE);
  const stop = Number(candidate.stop), targetPrice = Number(candidate[target.field]);
  const risk = stop - entryFill;
  if (!(risk > 0) || !Number.isFinite(risk) || !Number.isFinite(targetPrice)) {
    return { outcome: "INVALID_LEVELS", netR: null, entryTime: fromTime, closedAtMs: null };
  }
  const startIndex = lowerBound(candles, fromTime);
  for (let i = startIndex; i < candles.length && candles[i].time < endTime; i++) {
    const bar = candles[i];
    const stopHit = bar.high >= stop;
    const targetHit = bar.low <= targetPrice;
    if (!stopHit && !targetHit) continue;
    const stopAtOpen = bar.open >= stop;
    const targetAtOpen = bar.open <= targetPrice;
    const closeAtStop = stopAtOpen || (!targetAtOpen && stopHit);
    const outcome = closeAtStop ? "STOP" : "TP";
    const rawExit = closeAtStop
      ? (stopAtOpen ? bar.open : stop)
      : (targetAtOpen ? bar.open : targetPrice);
    const exitFill = rawExit * (1 - direction * SLIPPAGE);
    const netR = direction * (exitFill - entryFill) / risk -
      FEE * (entryFill + exitFill) / risk;
    return {
      outcome, target: target.key, targetLabel: target.label, netR,
      rawEntry, entryFill, stop, targetPrice, exitFill,
      entryTime: fromTime, closedAtMs: bar.time + MS["5m"],
      barsHeld: i - startIndex + 1
    };
  }
  return {
    outcome: "OPEN_AT_END", target: target.key, targetLabel: target.label,
    netR: null, rawEntry, entryFill, stop, targetPrice,
    entryTime: fromTime, closedAtMs: endTime, barsHeld: candles.length - startIndex
  };
}

function summarize(trades) {
  const closed = trades.filter(t => t.outcome === "TP" || t.outcome === "STOP");
  const wins = closed.filter(t => t.outcome === "TP");
  const stops = closed.filter(t => t.outcome === "STOP");
  const open = trades.filter(t => t.outcome === "OPEN_AT_END");
  const sum = xs => xs.reduce((n, t) => n + Number(t.netR || 0), 0);
  const grossWinR = wins.reduce((n, t) => n + Math.max(0, Number(t.netR || 0)), 0);
  const grossLossR = Math.abs(stops.reduce((n, t) => n + Math.min(0, Number(t.netR || 0)), 0));
  let equity = 0, peak = 0, maxDrawdownR = 0;
  for (const t of [...closed].sort((a, b) => a.closedAtMs - b.closedAtMs)) {
    equity += Number(t.netR || 0);
    peak = Math.max(peak, equity);
    maxDrawdownR = Math.max(maxDrawdownR, peak - equity);
  }
  return {
    trades: trades.length, closed: closed.length, tp: wins.length, sl: stops.length, open: open.length,
    winRatePct: closed.length ? wins.length / closed.length * 100 : 0,
    netR: sum(closed), averageNetR: closed.length ? sum(closed) / closed.length : 0,
    grossProfitR: grossWinR, grossLossR, profitFactor: grossLossR ? grossWinR / grossLossR : null,
    maxDrawdownR
  };
}

async function backtestSymbol(ticker) {
  const startMs = Date.parse(PERIOD.start), endMs = Date.parse(PERIOD.end);
  const warmupMs = startMs - WARMUP_DAYS * 86400000;
  const [oneHour, fourHour, fifteenMinute, fiveMinute] = await Promise.all([
    fetchHistoricalCandles(ticker.symbol, "1h", warmupMs, endMs),
    fetchHistoricalCandles(ticker.symbol, "4h", warmupMs, endMs),
    fetchHistoricalCandles(ticker.symbol, "15m", warmupMs, endMs),
    fetchHistoricalCandles(ticker.symbol, "5m", startMs, endMs)
  ]);
  if (oneHour.length < 100 || fourHour.length < 60 || fifteenMinute.length < 120 || fiveMinute.length < 500) {
    throw new Error("Insufficient candles (1h=" + oneHour.length + ", 4h=" + fourHour.length +
      ", 15m=" + fifteenMinute.length + ", 5m=" + fiveMinute.length + ")");
  }

  const engineStates = Object.fromEntries(ENGINES.map(engine => [engine.key, {
    engine: engine.label,
    eligibleSignals: 0, rejected: 0, rejectReasons: {},
    targets: Object.fromEntries(TARGETS.map(t => [t.key, { trades: [], lockUntil: 0, lockSkips: 0 }]))
  }]));
  let fourIndex = 0, fifteenIndex = 0;
  for (let i = 60; i < oneHour.length - 1; i++) {
    const signalBar = oneHour[i];
    const signalCloseTime = signalBar.time + MS["1h"];
    if (signalCloseTime < startMs || signalCloseTime >= endMs) continue;
    while (fourIndex < fourHour.length && fourHour[fourIndex].time + MS["4h"] <= signalCloseTime) fourIndex++;
    while (fifteenIndex < fifteenMinute.length && fifteenMinute[fifteenIndex].time + MS["15m"] <= signalCloseTime) fifteenIndex++;
    const closed4h = fourHour.slice(0, fourIndex);
    const closed15m = fifteenMinute.slice(Math.max(0, fifteenIndex - 120), fifteenIndex);
    if (closed4h.length < 60 || closed15m.length < 30) continue;

    // The next 1h open is the executable entry-time market price; both engines receive the identical input.
    const nextBar = oneHour[i + 1];
    const tickerAtSignal = {
      symbol: ticker.symbol, last: nextBar.open,
      quoteVolume: 0,
      priceChangePercent: historicalChange(oneHour, i),
      premium: {}
    };

    for (const engine of ENGINES) {
      const state = engineStates[engine.key];
      let candidate;
      try {
        candidate = engine.analyze(tickerAtSignal, oneHour.slice(0, i + 1), closed4h, closed15m);
      } catch {
        state.rejected++;
        continue;
      }
      if (candidate?.eligible !== true || candidate.side !== "SHORT") {
        if (candidate?.rejected) {
          state.rejected++;
          state.rejectReasons[candidate.rejected] = (state.rejectReasons[candidate.rejected] || 0) + 1;
        }
        continue;
      }
      state.eligibleSignals++;
      for (const target of TARGETS) {
        const bucket = state.targets[target.key];
        if (bucket.lockUntil > signalCloseTime) {
          bucket.lockSkips++;
          continue;
        }
        const trade = simulateTarget({ candidate, target, candles: fiveMinute, fromTime: signalCloseTime, endTime: endMs });
        trade.symbol = ticker.symbol;
        trade.side = "SHORT";
        trade.score = candidate.score;
        trade.signalTime = signalBar.time;
        trade.stopPct = (candidate.stop - candidate.entry) / candidate.entry * 100;
        bucket.trades.push(trade);
        bucket.lockUntil = trade.closedAtMs || endMs;
      }
    }
  }

  const result = { symbol: ticker.symbol, candleCounts: { "1h": oneHour.length, "4h": fourHour.length, "15m": fifteenMinute.length, "5m": fiveMinute.length } };
  const priceBars = oneHour.filter(c => c.time >= startMs && c.time < endMs);
  result.marketChangePct = priceBars.length > 1 ? (priceBars.at(-1).close / priceBars[0].close - 1) * 100 : null;
  for (const engine of ENGINES) {
    const s = engineStates[engine.key];
    result[engine.key] = {
      engine: s.engine, eligibleSignals: s.eligibleSignals, rejected: s.rejected, rejectReasons: s.rejectReasons,
      targets: Object.fromEntries(TARGETS.map(t => [t.key, {
        metrics: summarize(s.targets[t.key].trades),
        lockSkips: s.targets[t.key].lockSkips,
        trades: s.targets[t.key].trades
      }]))
    };
  }
  return result;
}

function aggregate(results, engineKey) {
  return Object.fromEntries(TARGETS.map(t => {
    const trades = results.flatMap(r => r[engineKey].targets[t.key].trades);
    return [t.key, { metrics: summarize(trades), trades }];
  }));
}

async function main() {
  const tickerData = await getJson(BASE + "/derivatives/api/v3/tickers");
  if (!Array.isArray(tickerData?.tickers)) throw new Error("Kraken Futures ticker response invalid");
  const universe = tickerData.tickers.filter(t =>
    t?.tag === "perpetual" && t.suspended !== true &&
    /^(PI|PF)_[A-Z0-9]+USD$/.test(String(t.symbol || "")) &&
    Number(t.volumeQuote) >= 5000000 && Number(t.last) > 0
  ).sort((a, b) => Number(b.volumeQuote) - Number(a.volumeQuote)).slice(0, SYMBOL_LIMIT);
  if (!universe.length) throw new Error("No current Kraken perpetuals passed the $5m quote-volume universe filter");

  console.log("Same-symbol, same-window comparison:", universe.map(t => t.symbol).join(", "));
  const results = [];
  for (const ticker of universe) {
    console.log("Testing " + ticker.symbol + " with both engines");
    try { results.push(await backtestSymbol(ticker)); }
    catch (error) { results.push({ symbol: ticker.symbol, error: String(error?.message || error) }); }
  }
  const successful = results.filter(r => !r.error);
  if (!successful.length) throw new Error("No symbol completed");

  const btc = successful.find(r => r.symbol === "PF_XBTUSD");
  const marketChanges = successful.map(r => r.marketChangePct).filter(Number.isFinite).sort((a,b)=>a-b);
  const medianMarketChangePct = marketChanges.length ? marketChanges[Math.floor(marketChanges.length / 2)] : null;
  const engineSummary = Object.fromEntries(ENGINES.map(e => {
    const byTarget = aggregate(successful, e.key);
    return [e.key, {
      label: e.label,
      eligibleSignals: successful.reduce((n,r)=>n+r[e.key].eligibleSignals,0),
      targets: Object.fromEntries(TARGETS.map(t=>[t.key, { label:t.label, metrics:byTarget[t.key].metrics, trades:byTarget[t.key].trades }]))
    }];
  }));

  const report = {
    generatedAt: new Date().toISOString(),
    period: PERIOD,
    venue: "Kraken Futures public historical trade candles",
    universe: { requestedTopN: SYMBOL_LIMIT, selected: universe.map(t=>t.symbol), successful: successful.map(r=>r.symbol) },
    marketContext: { btcChangePct: btc?.marketChangePct ?? null, medianSymbolChangePct: medianMarketChangePct },
    engines: engineSummary,
    perSymbol: successful.map(r => ({
      symbol:r.symbol, marketChangePct:r.marketChangePct,
      production_main:{ eligibleSignals:r.production_main.eligibleSignals, rejected:r.production_main.rejected,
        targets:Object.fromEntries(TARGETS.map(t=>[t.key,r.production_main.targets[t.key].metrics])) },
      supplied_v490:{ eligibleSignals:r.supplied_v490.eligibleSignals, rejected:r.supplied_v490.rejected,
        targets:Object.fromEntries(TARGETS.map(t=>[t.key,r.supplied_v490.targets[t.key].metrics])) }
    })),
    errors: results.filter(r=>r.error),
    assumptions: {
      identicalInputs:"Both exact analysis functions receive the same completed 1h, 4h and 15m candles and same next-1h-open market price.",
      signalTime:"One evaluation per completed 1h candle; only candles closed by signal time are passed.",
      entry:"Next 1h candle open; identical for both engines.",
      exits:"5m OHLC; same-candle stop-first unless candle opens beyond target.",
      targets:"Independent tests at 1.5R, 2.2R and 3R; one active trade per symbol and target per engine.",
      costs:{feePerSide:FEE,slippagePerSide:SLIPPAGE},
      funding:"Historical funding is not injected; both engines receive no funding-rate value, so funding penalties are not tested.",
      universeBias:"Same top-current-volume Kraken perpetual symbols are used for both engines; survivorship/listing bias remains.",
      scanCadence:"5-minute live scan cadence, max-20-signal cap and pending-signal deduplication are not replayed.",
      capital:"Results are in net R; no account sizing, leverage, compounding or liquidation simulation."
    }
  };
  await mkdir("artifacts",{recursive:true});
  await writeFile("artifacts/short-engine-same-window-comparison.json",JSON.stringify(report,null,2));
  const md = [
    "# SHORT engine same-window historical comparison",
    "",
    "Period: 2025-01-15 through 2025-03-16 UTC",
    "Symbols: "+universe.map(t=>t.symbol).join(", "),
    "BTC change: "+(btc?.marketChangePct?.toFixed(2) ?? "n/a")+"%; median symbol change: "+(medianMarketChangePct?.toFixed(2) ?? "n/a")+"%",
    "",
    "| Engine | Eligible signals | Target | Trades | TP | SL | Open | Win rate | Net R | Profit factor | Max DD R |",
    "|---|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|"
  ];
  for(const e of ENGINES) for(const t of TARGETS) {
    const m=engineSummary[e.key].targets[t.key].metrics;
    md.push("| "+e.label+" | "+engineSummary[e.key].eligibleSignals+" | "+t.label+" | "+m.trades+" | "+m.tp+" | "+m.sl+" | "+m.open+" | "+m.winRatePct.toFixed(2)+"% | "+m.netR.toFixed(2)+"R | "+(m.profitFactor==null?"—":m.profitFactor.toFixed(2))+" | "+m.maxDrawdownR.toFixed(2)+"R |");
  }
  md.push("", "## Per-symbol comparison", "", "| Symbol | Price change | Current signals | v4.9 signals | Current TP1 net R | v4.9 TP1 net R |", "|---|---:|---:|---:|---:|---:|");
  for(const r of successful) md.push("| "+r.symbol+" | "+r.marketChangePct.toFixed(2)+"% | "+r.production_main.eligibleSignals+" | "+r.supplied_v490.eligibleSignals+" | "+r.production_main.targets.TP1.metrics.netR.toFixed(2)+"R | "+r.supplied_v490.targets.TP1.metrics.netR.toFixed(2)+"R |");
  md.push("", "## Limitations",
    "- Both engines were run on the exact same historical candles, symbols, signal timestamps, execution price, exit candles, fees and slippage.",
    "- Historical funding is not injected; funding-dependent score differences are excluded.",
    "- Current top-volume universe introduces survivorship/listing bias.",
    "- The live 5-minute scan schedule and signal-cap/deduplication are not replayed.",
    "- Net R is not account ROI; no leverage, position sizing, compounding or liquidation model.");
  await writeFile("artifacts/short-engine-same-window-comparison.md",md.join("\n"));
  console.log("SHORT_ENGINE_COMPARISON_FINAL");
  console.log(JSON.stringify({
    period:PERIOD, symbols:successful.map(r=>r.symbol), marketContext:report.marketContext,
    summary:Object.fromEntries(ENGINES.map(e=>[e.key,{
      eligibleSignals:engineSummary[e.key].eligibleSignals,
      targets:Object.fromEntries(TARGETS.map(t=>[t.key,engineSummary[e.key].targets[t.key].metrics]))
    }])),
    errors:report.errors
  },null,2));
}
main().catch(error=>{console.error(error);process.exitCode=1;});

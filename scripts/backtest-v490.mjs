import { mkdir, writeFile } from "node:fs/promises";
import { analyzeFuturesSymbol } from "../src/v49-engine.mjs";

const BASE = "https://futures.kraken.com";
const MS = { "5m": 300000, "15m": 900000, "1h": 3600000, "4h": 14400000 };
const WARMUP_DAYS = 20;
const FEE = Number(process.env.BACKTEST_FEE_PER_SIDE || 0.0005);
const SLIPPAGE = Number(process.env.BACKTEST_SLIPPAGE_PER_SIDE || 0.0003);
const SYMBOL_LIMIT = Math.max(5, Math.min(12, Number(process.env.BACKTEST_SYMBOL_LIMIT || 10)));
const PERIODS = [
  { name: "LONG_BULL_2024_Q4", side: "LONG", start: "2024-10-01T00:00:00Z", end: "2024-11-30T00:00:00Z" },
  { name: "LONG_BULL_2025_Q2", side: "LONG", start: "2025-04-01T00:00:00Z", end: "2025-05-31T00:00:00Z" },
  { name: "SHORT_BEAR_2024_Q3", side: "SHORT", start: "2024-07-01T00:00:00Z", end: "2024-08-30T00:00:00Z" },
  { name: "SHORT_BEAR_2025_Q1", side: "SHORT", start: "2025-01-15T00:00:00Z", end: "2025-03-16T00:00:00Z" }
];
const TARGETS = [
  { key: "TP1", field: "target1", label: "LONG 1.2R / SHORT 1.5R" },
  { key: "TP2", field: "target2", label: "LONG 1.8R / SHORT 2.2R" },
  { key: "TP3", field: "target3", label: "LONG 2.5R / SHORT 3.0R" }
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
  const side = candidate.side, direction = side === "LONG" ? 1 : -1;
  const rawEntry = Number(candidate.entry);
  const entryFill = rawEntry * (1 + direction * SLIPPAGE);
  const stop = Number(candidate.stop), targetPrice = Number(candidate[target.field]);
  const risk = direction === 1 ? entryFill - stop : stop - entryFill;
  if (!(risk > 0) || !Number.isFinite(risk) || !Number.isFinite(targetPrice)) {
    return { outcome: "INVALID_LEVELS", netR: null, entryTime: fromTime, closedAtMs: null };
  }
  const startIndex = lowerBound(candles, fromTime);
  for (let i = startIndex; i < candles.length && candles[i].time < endTime; i++) {
    const bar = candles[i];
    const stopHit = side === "LONG" ? bar.low <= stop : bar.high >= stop;
    const targetHit = side === "LONG" ? bar.high >= targetPrice : bar.low <= targetPrice;
    if (!stopHit && !targetHit) continue;
    const stopAtOpen = side === "LONG" ? bar.open <= stop : bar.open >= stop;
    const targetAtOpen = side === "LONG" ? bar.open >= targetPrice : bar.open <= targetPrice;
    // Same-candle ambiguity is resolved conservatively: stop first, except when
    // the opening price itself already gapped through the target.
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

async function backtestSymbol(ticker, period) {
  const startMs = Date.parse(period.start), endMs = Date.parse(period.end);
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

  const state = Object.fromEntries(TARGETS.map(t => [t.key, { trades: [], lockUntil: 0, lockSkips: 0 }]));
  let fourIndex = 0, fifteenIndex = 0, eligibleSignals = 0, rejected = 0;
  const rejectReasons = {};
  for (let i = 60; i < oneHour.length - 1; i++) {
    const signalBar = oneHour[i];
    const signalCloseTime = signalBar.time + MS["1h"];
    if (signalCloseTime < startMs || signalCloseTime >= endMs) continue;
    while (fourIndex < fourHour.length && fourHour[fourIndex].time + MS["4h"] <= signalCloseTime) fourIndex++;
    while (fifteenIndex < fifteenMinute.length && fifteenMinute[fifteenIndex].time + MS["15m"] <= signalCloseTime) fifteenIndex++;
    const closed4h = fourHour.slice(0, fourIndex);
    const closed15m = fifteenMinute.slice(Math.max(0, fifteenIndex - 120), fifteenIndex);
    if (closed4h.length < 60 || closed15m.length < 30) continue;
    const nextBar = oneHour[i + 1];
    const tickerAtSignal = {
      symbol: ticker.symbol, last: nextBar.open,
      quoteVolume: Number(ticker.volumeQuote) || 0,
      priceChangePercent: historicalChange(oneHour, i),
      premium: { lastFundingRate: null }
    };
    let candidate;
    try {
      candidate = analyzeFuturesSymbol(tickerAtSignal, oneHour.slice(0, i + 1), closed4h, closed15m);
    } catch {
      rejected++;
      continue;
    }
    if (candidate?.eligible !== true || candidate.side !== period.side) {
      if (candidate?.rejected) {
        rejected++;
        rejectReasons[candidate.rejected] = (rejectReasons[candidate.rejected] || 0) + 1;
      }
      continue;
    }
    eligibleSignals++;
    for (const target of TARGETS) {
      const bucket = state[target.key];
      if (bucket.lockUntil > signalCloseTime) {
        bucket.lockSkips++;
        continue;
      }
      const trade = simulateTarget({ candidate, target, candles: fiveMinute, fromTime: signalCloseTime, endTime: endMs });
      trade.symbol = ticker.symbol;
      trade.side = candidate.side;
      trade.score = candidate.score;
      trade.signalTime = signalBar.time;
      bucket.trades.push(trade);
      bucket.lockUntil = trade.closedAtMs || endMs;
    }
  }
  const byTarget = Object.fromEntries(TARGETS.map(t => [t.key, {
    metrics: summarize(state[t.key].trades),
    lockSkips: state[t.key].lockSkips,
    trades: state[t.key].trades
  }]));
  const priceBars = oneHour.filter(c => c.time >= startMs && c.time < endMs);
  const marketChangePct = priceBars.length > 1 ? (priceBars.at(-1).close / priceBars[0].close - 1) * 100 : null;
  return {
    symbol: ticker.symbol, side: period.side, marketChangePct,
    candleCounts: { "1h": oneHour.length, "4h": fourHour.length, "15m": fifteenMinute.length, "5m": fiveMinute.length },
    eligibleSignals, rejected, rejectReasons, byTarget
  };
}

function aggregate(items) {
  return Object.fromEntries(TARGETS.map(target => {
    const trades = items.flatMap(x => x.byTarget[target.key]?.trades || []);
    const lockSkips = items.reduce((n, x) => n + (x.byTarget[target.key]?.lockSkips || 0), 0);
    return [target.key, { label: target.label, metrics: summarize(trades), lockSkips }];
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
  if (!universe.length) throw new Error("No current Kraken perpetuals passed the supplied engine's volume filter");
  const btcTicker = tickerData.tickers.find(t => t?.symbol === "PF_XBTUSD");
  if (!btcTicker) throw new Error("PF_XBTUSD was not present in Kraken Futures tickers");
  const symbols = [...new Map([...universe, btcTicker].map(t => [t.symbol, t])).values()];
  console.log("Selected multi-symbol universe:", universe.map(t => t.symbol).join(", "));
  console.log("BTC-only contract:", btcTicker.symbol);

  const periods = [];
  for (const period of PERIODS) {
    console.log("Starting period " + period.name);
    const results = [];
    for (const ticker of symbols) {
      console.log("  Fetching and testing " + ticker.symbol);
      try {
        results.push(await backtestSymbol(ticker, period));
      } catch (error) {
        results.push({ symbol: ticker.symbol, side: period.side, error: String(error?.message || error) });
        console.error("  FAILED " + ticker.symbol + ": " + String(error?.message || error));
      }
    }
    const successful = results.filter(x => !x.error);
    const multi = successful.filter(x => universe.some(u => u.symbol === x.symbol));
    const btc = successful.filter(x => x.symbol === "PF_XBTUSD");
    periods.push({
      ...period,
      btcMarketChangePct: btc[0]?.marketChangePct ?? null,
      symbolsRequested: universe.map(t => t.symbol),
      symbolsSucceeded: multi.map(x => x.symbol),
      errors: results.filter(x => x.error),
      multiSymbol: aggregate(multi),
      btcOnly: aggregate(btc),
      perSymbol: multi.map(x => ({
        symbol: x.symbol, marketChangePct: x.marketChangePct, eligibleSignals: x.eligibleSignals,
        rejected: x.rejected, targets: Object.fromEntries(TARGETS.map(t => [t.key, x.byTarget[t.key].metrics]))
      })),
      _rawResults: successful
    });
  }

  const allMulti = periods.flatMap(p => p.symbolsSucceeded.map(symbol => {
    const source = p.perSymbol.find(x => x.symbol === symbol);
    const periodResult = p;
    const raw = periodResult._raw;
    return { period: p.name, symbol, source, raw };
  }));
  // Aggregations use the per-period raw target trades retained separately below.
  const allTrades = Object.fromEntries(TARGETS.map(t => [t.key, []]));
  const groupTrades = {
    allMulti: Object.fromEntries(TARGETS.map(t => [t.key, []])),
    longMulti: Object.fromEntries(TARGETS.map(t => [t.key, []])),
    shortMulti: Object.fromEntries(TARGETS.map(t => [t.key, []])),
    btcLong: Object.fromEntries(TARGETS.map(t => [t.key, []])),
    btcShort: Object.fromEntries(TARGETS.map(t => [t.key, []]))
  };

  // Re-fetching is avoided: the raw per-symbol trades are captured in the temporary
  // results array below during this second, in-memory aggregation pass.
  // (period._trades is populated immediately after each period's symbol results.)
  for (const p of periods) {
    const rawSymbols = p._rawResults || [];
    for (const x of rawSymbols) {
      const isBtc = x.symbol === "PF_XBTUSD";
      for (const t of TARGETS) {
        const trades = x.byTarget[t.key].trades.map(tr => ({ ...tr, period: p.name }));
        groupTrades.allMulti[t.key].push(...trades.filter(() => universe.some(u => u.symbol === x.symbol)));
        if (p.side === "LONG" && universe.some(u => u.symbol === x.symbol)) groupTrades.longMulti[t.key].push(...trades);
        if (p.side === "SHORT" && universe.some(u => u.symbol === x.symbol)) groupTrades.shortMulti[t.key].push(...trades);
        if (isBtc && p.side === "LONG") groupTrades.btcLong[t.key].push(...trades);
        if (isBtc && p.side === "SHORT") groupTrades.btcShort[t.key].push(...trades);
      }
    }
  }

  const sections = {
    overallMultiSymbol: Object.fromEntries(TARGETS.map(t => [t.key, { label: t.label, metrics: summarize(groupTrades.allMulti[t.key]) }])),
    shortMultiSymbolBearish: Object.fromEntries(TARGETS.map(t => [t.key, { label: t.label, metrics: summarize(groupTrades.shortMulti[t.key]) }])),
    longMultiSymbolBullish: Object.fromEntries(TARGETS.map(t => [t.key, { label: t.label, metrics: summarize(groupTrades.longMulti[t.key]) }])),
    btcLongBullish: Object.fromEntries(TARGETS.map(t => [t.key, { label: t.label, metrics: summarize(groupTrades.btcLong[t.key]) }])),
    btcShortBearish: Object.fromEntries(TARGETS.map(t => [t.key, { label: t.label, metrics: summarize(groupTrades.btcShort[t.key]) }]))
  };
  const report = {
    generatedAt: new Date().toISOString(),
    engine: "User-supplied Crypto Pump Hunter Signal Engine v4.9.0; isolated copy of the submitted strategy functions",
    venue: "Kraken Futures public historical trade candles",
    universe: { requestedTopN: SYMBOL_LIMIT, selected: universe.map(t => t.symbol), btcOnly: "PF_XBTUSD" },
    periods: periods.map(({ _rawResults, ...p }) => p),
    sections,
    assumptions: {
      signalEvaluation: "One evaluation per completed 1h candle; only 1h, 4h and 15m candles closed by signal time are passed to the exact supplied analyzeFuturesSymbol logic.",
      entry: "Next 1h candle open (the ticker.last passed to the engine).",
      funding: "Historical funding was unavailable in the chart-candle response; the test supplies null, which Number(null) converts to 0 in the supplied function, so the v4.8 relative-funding penalty is not triggered.",
      outcomes: "Three independent tests per eligible signal: target1 (1.5R), target2 (2.2R), target3 (3R). Each target test runs until its target or the original stop is first reached; one active trade per symbol and target at a time.",
      candleResolution: "5m OHLC for exits; same-candle stop-first, except a candle opening beyond the target is treated as target first.",
      costs: { feePerSide: FEE, adverseSlippagePerSide: SLIPPAGE },
      roi: "Reported in net R multiples, not account ROI; no position sizing, compounding or liquidation model.",
      scan: "The 20-signals-per-scan cap and 5-minute repeat scan schedule are not replayed; this isolates the signal engine once per completed 1h candle.",
      universeBias: "Top current-volume Kraken perpetual contracts are used for all historical windows; this introduces survivorship/listing bias."
    }
  };
  await mkdir("artifacts", { recursive: true });
  await writeFile("artifacts/v490-signal-engine-backtest.json", JSON.stringify(report, null, 2));
  const fmt = m => [
    m.trades, m.tp, m.sl, m.open,
    m.winRatePct.toFixed(2) + "%", m.netR.toFixed(2) + "R",
    m.averageNetR.toFixed(3) + "R", m.profitFactor == null ? "—" : m.profitFactor.toFixed(2),
    m.maxDrawdownR.toFixed(2) + "R"
  ];
  const lines = [
    "# Supplied v4.9.0 signal-engine backtest",
    "",
    "Windows: LONG 2024-10-01—2024-11-30 and 2025-04-01—2025-05-31; SHORT 2024-07-01—2024-08-30 and 2025-01-15—2025-03-16.",
    "Universe: " + universe.map(t => t.symbol).join(", "),
    "BTC-only: PF_XBTUSD",
    "",
    "| Evaluation | Target | Trades | TP | SL | Open | Win rate | Net R | Avg R | PF | Max DD |",
    "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|"
  ];
  for (const [name, section] of Object.entries(sections)) {
    for (const t of TARGETS) {
      const m = section[t.key].metrics;
      lines.push("| " + name + " | " + t.key + " (" + t.label + ") | " + fmt(m).join(" | ") + " |");
    }
  }
  lines.push("", "## Per-period market context", "", "| Period | Side | BTC price change | Symbols tested | Errors |", "|---|---|---:|---:|---:|");
  for (const p of periods) lines.push("| " + p.name + " | " + p.side + " | " + (p.btcMarketChangePct == null ? "n/a" : p.btcMarketChangePct.toFixed(2) + "%") + " | " + p.symbolsSucceeded.length + " | " + p.errors.length + " |");
  lines.push("", "## Method and limitations",
    "- Signals are generated from completed 1h candles; only closed 4h and 15m candles are provided at each signal time. Entry is the next 1h open.",
    "- TP1, TP2 and TP3 are separate independent outcome tests against the same original stop. Each target is counted only if it is reached before the stop.",
    "- Exit resolution uses 5m OHLC. Same-candle target/stop ambiguity is stop-first unless the candle opens beyond the target.",
    "- Fees: " + (FEE * 100).toFixed(4) + "% per side; adverse slippage: " + (SLIPPAGE * 100).toFixed(4) + "% per side. Funding is unavailable for the historical windows and therefore its score penalty is not applied.",
    "- One active trade per symbol per target; no account capital constraint or compounding. Results are in R, not percentage account ROI.",
    "- The 5-minute scan cadence, 20-signal scan cap and pending-signal deduplication are not replayed; this evaluates the signal engine once per completed 1h candle.",
    "- Top current-volume contracts introduce survivorship/listing bias. Some symbols may not have full historical data.",
    "",
    "## Errors",
    ...periods.flatMap(p => p.errors.map(e => "- " + p.name + " / " + e.symbol + ": " + e.error))
  );
  await writeFile("artifacts/v490-signal-engine-backtest.md", lines.join("\n"));
  console.log("V490_BACKTEST_FINAL");
  console.log(JSON.stringify({
    universe: universe.map(t => t.symbol),
    sections: Object.fromEntries(Object.entries(sections).map(([name, s]) => [name, Object.fromEntries(TARGETS.map(t => [t.key, s[t.key].metrics]))])),
    periods: periods.map(p => ({ name: p.name, side: p.side, btcChange: p.btcMarketChangePct, symbols: p.symbolsSucceeded.length, errors: p.errors }))
  }, null, 2));
  if (periods.every(p => p.symbolsSucceeded.length === 0)) throw new Error("No symbols completed successfully");
}
main().catch(error => { console.error(error); process.exitCode = 1; });

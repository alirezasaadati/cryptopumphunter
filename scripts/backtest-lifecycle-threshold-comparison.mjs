import { mkdir, writeFile } from "node:fs/promises";
import { analyzeFuturesSymbol, FUTURES_CONFIG } from "../src/index.js";
import { evaluateTradeCandle, FUTURES_TRADE_LEVERAGE, FUTURES_MARGIN_PROFIT_TARGET_PERCENT } from "../src/futures-trade-lifecycle.js";

const BASE = "https://futures.kraken.com";
const INTERVALS = { "5m": 300000, "15m": 900000, "1h": 3600000, "4h": 14400000 };
const DAYS = Math.max(7, Math.min(60, Number(process.env.LIFECYCLE_BACKTEST_DAYS || 30)));
const SYMBOL_LIMIT = Math.max(1, Math.min(12, Number(process.env.LIFECYCLE_BACKTEST_SYMBOLS || 10)));
const WARMUP_DAYS = 15;
const TARGET = FUTURES_MARGIN_PROFIT_TARGET_PERCENT;
const LEVERAGE = FUTURES_TRADE_LEVERAGE;

async function getJson(url, attempt = 0) {
  const response = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(30000) });
  const body = await response.text();
  if (!response.ok) {
    if (attempt < 3 && (response.status === 429 || response.status >= 500)) {
      await new Promise(resolve => setTimeout(resolve, 800 * (attempt + 1)));
      return getJson(url, attempt + 1);
    }
    throw new Error("HTTP " + response.status + " for " + url + ": " + body.slice(0, 160));
  }
  let data;
  try { data = JSON.parse(body); } catch { throw new Error("Invalid JSON from " + url); }
  if (data?.result === "error" || (Array.isArray(data?.errors) && data.errors.length)) throw new Error("Kraken API error: " + JSON.stringify(data.errors || data.error));
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
    Number.isFinite(c.time) && [c.open,c.high,c.low,c.close,c.volume].every(Number.isFinite) &&
    c.open > 0 && c.close > 0 && c.low > 0 && c.high >= c.low && c.volume >= 0 &&
    c.time + intervalMs <= Date.now()
  ).sort((a,b)=>a.time-b.time).filter(c => {
    if (seen.has(c.time)) return false;
    seen.add(c.time); return true;
  });
}

async function fetchHistoricalCandles(symbol, resolution, fromMs, toMs) {
  const intervalMs = INTERVALS[resolution];
  const chunkMs = intervalMs * 1700;
  const combined = [];
  for (let start = fromMs; start < toMs; start += chunkMs) {
    const end = Math.min(toMs, start + chunkMs);
    const url = new URL(BASE + "/api/charts/v1/trade/" + encodeURIComponent(symbol) + "/" + resolution);
    url.searchParams.set("from", String(Math.floor(start / 1000)));
    url.searchParams.set("to", String(Math.floor(end / 1000)));
    url.searchParams.set("count", "1800");
    const data = await getJson(url);
    if (data.more_candles === true) throw new Error(symbol + " " + resolution + ": incomplete chunk from Kraken");
    combined.push(...normalizeCandles(data.candles, intervalMs));
  }
  const byTime = new Map(combined.map(c => [c.time,c]));
  return [...byTime.values()].sort((a,b)=>a.time-b.time);
}

function historicalChange(candles, index) {
  const old = candles[index - 24], now = candles[index];
  return !old || old.close <= 0 ? 0 : ((now.close / old.close) - 1) * 100;
}
function lowerBound(candles, time) {
  let lo = 0, hi = candles.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (candles[mid].time < time) lo = mid + 1; else hi = mid; }
  return lo;
}
function candleAmbiguous(side, trade, candle) {
  const entry = Number(trade.entry), stop = Number(trade.currentStop ?? trade.initialStop ?? trade.stop);
  const target = side === "LONG" ? entry * (1 + TARGET / LEVERAGE / 100) : entry * (1 - TARGET / LEVERAGE / 100);
  const stopHit = side === "LONG" ? candle.low <= stop : candle.high >= stop;
  const profitHit = side === "LONG" ? candle.high >= target : candle.low <= target;
  const stopAtOpen = side === "LONG" ? candle.open <= stop : candle.open >= stop;
  const profitAtOpen = side === "LONG" ? candle.open >= target : candle.open <= target;
  return stopHit && profitHit && !stopAtOpen && !profitAtOpen;
}
function summarize(trades) {
  const closed = trades.filter(t => t.status === "CLOSED_PROFIT" || t.status === "CLOSED_STOP");
  const profits = closed.filter(t => t.status === "CLOSED_PROFIT");
  const stops = closed.filter(t => t.status === "CLOSED_STOP");
  let equity = 0, peak = 0, maxDrawdown = 0;
  for (const trade of [...closed].sort((a,b)=>a.closedAtMs-b.closedAtMs)) {
    equity += Number(trade.marginReturnPercent || 0);
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
  }
  const longs = closed.filter(t => t.side === "LONG");
  const shorts = closed.filter(t => t.side === "SHORT");
  const sum = xs => xs.reduce((n,t)=>n+Number(t.marginReturnPercent || 0),0);
  return {
    tradesStarted: trades.length,
    closedTrades: closed.length,
    profitCloses: profits.length,
    stopCloses: stops.length,
    openAtEnd: trades.length - closed.length,
    longs: longs.length,
    shorts: shorts.length,
    winRatePct: closed.length ? profits.length / closed.length * 100 : 0,
    totalMarginReturnPct: sum(closed),
    averageMarginReturnPct: closed.length ? sum(closed) / closed.length : 0,
    maxDrawdownMarginPct: maxDrawdown,
    ambiguous5mCandles: trades.reduce((n,t)=>n+(t.ambiguousCandles || 0),0),
    bySide: {
      LONG: { trades: longs.length, profitCloses: longs.filter(t=>t.status==="CLOSED_PROFIT").length, stopCloses: longs.filter(t=>t.status==="CLOSED_STOP").length, marginReturnPct: sum(longs) },
      SHORT: { trades: shorts.length, profitCloses: shorts.filter(t=>t.status==="CLOSED_PROFIT").length, stopCloses: shorts.filter(t=>t.status==="CLOSED_STOP").length, marginReturnPct: sum(shorts) }
    }
  };
}

async function backtestSymbol(ticker, fromMs, toMs) {
  const [oneHour,fourHour,fifteenMinute,fiveMinute] = await Promise.all([
    fetchHistoricalCandles(ticker.symbol,"1h",fromMs,toMs),
    fetchHistoricalCandles(ticker.symbol,"4h",fromMs,toMs),
    fetchHistoricalCandles(ticker.symbol,"15m",fromMs,toMs),
    fetchHistoricalCandles(ticker.symbol,"5m",fromMs,toMs)
  ]);
  if (oneHour.length < 100 || fourHour.length < FUTURES_CONFIG.MIN_CANDLES || fifteenMinute.length < 120 || fiveMinute.length < 1000) {
    throw new Error("insufficient candles (1h="+oneHour.length+", 4h="+fourHour.length+", 15m="+fifteenMinute.length+", 5m="+fiveMinute.length+")");
  }

  const makeState = () => ({ trades: [], lockUntil: new Map(), candidateSignals: 0, passedThresholdSignals: 0, thresholdRejected: 0, skippedByLock: 0, rejectedSignals: 0 });
  const baseline = makeState();
  const thresholded = makeState();
  const testStart = toMs - DAYS * 86400000;
  let fourIndex = 0, fifteenIndex = 0;

  for (let i = 60; i < oneHour.length - 1; i++) {
    const signalBar = oneHour[i];
    const signalCloseTime = signalBar.time + INTERVALS["1h"];
    if (signalCloseTime < testStart || signalCloseTime >= toMs) continue;
    while (fourIndex < fourHour.length && fourHour[fourIndex].time + INTERVALS["4h"] <= signalCloseTime) fourIndex++;
    while (fifteenIndex < fifteenMinute.length && fifteenMinute[fifteenIndex].time + INTERVALS["15m"] <= signalCloseTime) fifteenIndex++;
    const closed4h = fourHour.slice(0,fourIndex);
    const closed15m = fifteenMinute.slice(Math.max(0,fifteenIndex-120),fifteenIndex);
    if (closed4h.length < FUTURES_CONFIG.MIN_CANDLES || closed15m.length < 40) continue;

    const nextBar = oneHour[i+1];
    const tickerAtSignal = {
      symbol: ticker.symbol, last: nextBar.open, quoteVolume: Number(ticker.volumeQuote)||0,
      priceChangePercent: historicalChange(oneHour,i), premium: { lastFundingRate: null }
    };
    let candidate;
    try { candidate = analyzeFuturesSymbol(tickerAtSignal,oneHour.slice(0,i+1),closed4h,closed15m); }
    catch { baseline.rejectedSignals++; thresholded.rejectedSignals++; continue; }
    if (!candidate || candidate.eligible !== true || !["LONG","SHORT"].includes(candidate.side)) {
      baseline.rejectedSignals++; thresholded.rejectedSignals++; continue;
    }

    baseline.candidateSignals++;
    baseline.passedThresholdSignals++;
    thresholded.candidateSignals++;

    // Match the threshold experiment's reference price: the close of the signal 1h candle.
    // Only the last three completed 1h candles are used; the next candle is not included.
    const last3 = oneHour.slice(i-2,i+1);
    let thresholdPass = false;
    if (last3.length === 3 && last3.every(c => Number.isFinite(c.high) && Number.isFinite(c.low))) {
      const referencePrice = Number(signalBar.close);
      if (candidate.side === "LONG") {
        const maxHigh = Math.max(...last3.map(c => c.high));
        const distance = Math.abs(referencePrice - maxHigh) / maxHigh;
        thresholdPass = Number.isFinite(distance) && maxHigh > 0 && distance >= 0.005;
      } else {
        const minLow = Math.min(...last3.map(c => c.low));
        const distance = Math.abs(referencePrice - minLow) / minLow;
        thresholdPass = Number.isFinite(distance) && minLow > 0 && distance >= 0.003;
      }
    }
    if (thresholdPass) thresholded.passedThresholdSignals++;
    else thresholded.thresholdRejected++;

    const execute = (state) => {
      const lockKey = ticker.symbol + "|" + candidate.side;
      if ((state.lockUntil.get(lockKey) || 0) > signalCloseTime) {
        state.skippedByLock++;
        return;
      }
      const entry = Number(candidate.entry);
      const trade = {
        id: ticker.symbol + ":" + candidate.side + ":" + signalCloseTime,
        symbol: ticker.symbol, side: candidate.side, status: "OPEN",
        entry, initialStop: Number(candidate.stop), stop: Number(candidate.stop),
        signalTime: signalBar.time, entryTime: signalCloseTime,
        score: candidate.score, ambiguousCandles: 0
      };
      let candleIndex = lowerBound(fiveMinute,signalCloseTime);
      let closed = false;
      for (; candleIndex < fiveMinute.length && fiveMinute[candleIndex].time < toMs; candleIndex++) {
        const bar = fiveMinute[candleIndex];
        if (candleAmbiguous(candidate.side,trade,bar)) trade.ambiguousCandles++;
        const evaluated = evaluateTradeCandle(trade,{...bar,time:bar.time+INTERVALS["5m"]});
        if (evaluated.changed) {
          Object.assign(trade,evaluated.trade);
          trade.closedAtMs = bar.time + INTERVALS["5m"];
          closed = true;
          break;
        }
      }
      if (!closed) {
        trade.status = "OPEN_AT_BACKTEST_END";
        trade.lastMark = fiveMinute.at(-1)?.close ?? null;
        trade.marginReturnAtMarkPct = trade.lastMark ? (candidate.side==="LONG" ? 1 : -1) * ((trade.lastMark-entry)/entry) * 100 * LEVERAGE : null;
        state.lockUntil.set(lockKey,toMs);
      } else {
        state.lockUntil.set(lockKey,trade.closedAtMs);
      }
      state.trades.push(trade);
    };

    execute(baseline);
    if (thresholdPass) execute(thresholded);
  }

  return {
    symbol:ticker.symbol,
    candles:{ "1h":oneHour.length, "4h":fourHour.length, "15m":fifteenMinute.length, "5m":fiveMinute.length },
    baseline:{
      candidateSignals:baseline.candidateSignals, passedThresholdSignals:baseline.passedThresholdSignals,
      thresholdRejected:baseline.thresholdRejected, skippedByLock:baseline.skippedByLock,
      rejectedSignals:baseline.rejectedSignals, metrics:summarize(baseline.trades), trades:baseline.trades
    },
    thresholded:{
      candidateSignals:thresholded.candidateSignals, passedThresholdSignals:thresholded.passedThresholdSignals,
      thresholdRejected:thresholded.thresholdRejected, skippedByLock:thresholded.skippedByLock,
      rejectedSignals:thresholded.rejectedSignals, metrics:summarize(thresholded.trades), trades:thresholded.trades
    }
  };
}

async function main() {
  // Fixed historical window and universe reproduce the screenshot's original test.
  const endMs = Date.parse("2026-11-20T17:16:55.178Z");
  const startMs = Date.parse("2026-10-21T17:16:55.178Z");
  const fromMs = startMs - WARMUP_DAYS*86400000;
  const fixedSymbols = ["PF_XBTUSD","PF_ETHUSD","PF_HYPEUSD","PF_SOLUSD","PF_ZECUSD","PF_XRPUSD","PF_NVDAXUSD","PF_NEARUSD","PF_XAGUSD","PF_ANTXUSD"];
  const tickerData = await getJson(BASE + "/derivatives/api/v3/tickers");
  if (!Array.isArray(tickerData?.tickers)) throw new Error("Kraken tickers response invalid");
  const universe = fixedSymbols.map(symbol =>
    tickerData.tickers.find(t => t?.symbol === symbol && t?.tag === "perpetual" && t.suspended !== true) ||
    { symbol, volumeQuote: 0, last: 1, tag: "perpetual", suspended: false }
  );

  const results = [];
  for (const ticker of universe) {
    try { results.push(await backtestSymbol(ticker,fromMs,endMs)); }
    catch (error) { results.push({symbol:ticker.symbol,error:String(error?.message||error)}); }
  }
  const successful = results.filter(r=>!r.error);
  const baselineTrades = successful.flatMap(r=>r.baseline.trades).sort((a,b)=>(a.closedAtMs||Number.MAX_SAFE_INTEGER)-(b.closedAtMs||Number.MAX_SAFE_INTEGER));
  const thresholdTrades = successful.flatMap(r=>r.thresholded.trades).sort((a,b)=>(a.closedAtMs||Number.MAX_SAFE_INTEGER)-(b.closedAtMs||Number.MAX_SAFE_INTEGER));
  const baselineMetrics = summarize(baselineTrades);
  const thresholdMetrics = summarize(thresholdTrades);
  const sum = (variant,key) => successful.reduce((n,r)=>n+Number(r[variant][key]||0),0);
  const report = {
    generatedAt:new Date().toISOString(), venue:"Kraken Futures public historical OHLC candles",
    period:{from:new Date(startMs).toISOString(),to:new Date(endMs).toISOString(),days:30,warmupDays:WARMUP_DAYS},
    comparison:"Same candle downloads, candidate engine, entry/exit lifecycle, leverage, 5m execution and symbol universe; only the added LONG/SHORT distance thresholds differ.",
    thresholds:{
      LONG:"Reject when signal 1h close is less than 0.5% away from the maximum High of the last 3 completed 1h candles",
      SHORT:"Reject when signal 1h close is less than 0.3% away from the minimum Low of the last 3 completed 1h candles",
      referencePrice:"Signal candle close (same reference convention as the 1y/2y threshold experiments)"
    },
    rules:{leverage:LEVERAGE,targetMarginReturnPct:TARGET,requiredFavorablePriceMovePct:TARGET/LEVERAGE,
      exit:"close only at +30% margin return or configured stop",tp1Tp2Tp3:"ignored for closing",
      candleResolution:"5m",sameCandleAmbiguity:"stop-first unless a gap at candle open proves one level was reached first",
      fees:"excluded by original test",funding:"excluded",
      execution:"signal generated from closed 1h/4h/15m candles; entry at next 1h open; exits evaluated on subsequent 5m OHLC",
      lock:"independent symbol+side lock until close; opposite side may overlap",
      universe:"fixed to the same ten symbols selected in the original test; ANTX expected to fail for insufficient history"},
    symbolsRequested:fixedSymbols.length,symbolsTested:successful.length,symbolErrors:results.filter(r=>r.error),
    baseline:{metrics:baselineMetrics,candidateSignals:sum("baseline","candidateSignals"),lockSkips:sum("baseline","skippedByLock"),rejectedSignals:sum("baseline","rejectedSignals"),trades:baselineTrades},
    thresholded:{metrics:thresholdMetrics,candidateSignals:sum("thresholded","candidateSignals"),passedThresholdSignals:sum("thresholded","passedThresholdSignals"),thresholdRejected:sum("thresholded","thresholdRejected"),lockSkips:sum("thresholded","skippedByLock"),rejectedSignals:sum("thresholded","rejectedSignals"),trades:thresholdTrades},
    bySymbol:successful.map(r=>({symbol:r.symbol,candles:r.candles,baseline:{...r.baseline, trades:undefined},thresholded:{...r.thresholded,trades:undefined}}))
  };
  await mkdir("artifacts",{recursive:true});
  await writeFile("artifacts/lifecycle-threshold-comparison.json",JSON.stringify(report,null,2));
  const rows = [
    "# Lifecycle backtest: baseline vs LONG 0.5% / SHORT 0.3%","",
    "Period: "+report.period.from+" — "+report.period.to+" (30 days)",
    "Symbols tested: "+report.symbolsTested+"/"+fixedSymbols.length,"",
    "| Metric | Original | Threshold 0.5% / 0.3% |",
    "|---|---:|---:|",
    "| Trades started | "+baselineMetrics.tradesStarted+" | "+thresholdMetrics.tradesStarted+" |",
    "| Closed trades | "+baselineMetrics.closedTrades+" | "+thresholdMetrics.closedTrades+" |",
    "| Profit closes | "+baselineMetrics.profitCloses+" | "+thresholdMetrics.profitCloses+" |",
    "| Stop closes | "+baselineMetrics.stopCloses+" | "+thresholdMetrics.stopCloses+" |",
    "| Open at end | "+baselineMetrics.openAtEnd+" | "+thresholdMetrics.openAtEnd+" |",
    "| Win rate | "+baselineMetrics.winRatePct.toFixed(2)+"% | "+thresholdMetrics.winRatePct.toFixed(2)+"% |",
    "| Total margin return (not compounded) | "+baselineMetrics.totalMarginReturnPct.toFixed(2)+"% | "+thresholdMetrics.totalMarginReturnPct.toFixed(2)+"% |",
    "| Average margin return / trade | "+baselineMetrics.averageMarginReturnPct.toFixed(2)+"% | "+thresholdMetrics.averageMarginReturnPct.toFixed(2)+"% |",
    "| Max drawdown (additive margin-return points) | "+baselineMetrics.maxDrawdownMarginPct.toFixed(2)+"% | "+thresholdMetrics.maxDrawdownMarginPct.toFixed(2)+"% |",
    "| LONG / SHORT closed | "+baselineMetrics.longs+" / "+baselineMetrics.shorts+" | "+thresholdMetrics.longs+" / "+thresholdMetrics.shorts+" |",
    "| Candidate signals rejected by threshold | 0 | "+report.thresholded.thresholdRejected+" |",
    "",
    "| Symbol | Original closed | Filtered closed | Original net % | Filtered net % |",
    "|---|---:|---:|---:|---:|",
    ...successful.map(r=>"| "+r.symbol+" | "+r.baseline.metrics.closedTrades+" | "+r.thresholded.metrics.closedTrades+" | "+r.baseline.metrics.totalMarginReturnPct.toFixed(2)+" | "+r.thresholded.metrics.totalMarginReturnPct.toFixed(2)+" |"),
    "",
    "The original lifecycle execution model is retained: 10x leverage, +30% margin-profit close or configured stop, 5m OHLC, stop-first ambiguity, no fees/funding/slippage. The threshold is the only strategy filter added.",
    "",
    "Symbol errors:", ...report.symbolErrors.map(x=>"- "+x.symbol+": "+x.error)
  ];
  await writeFile("artifacts/lifecycle-threshold-comparison.md",rows.join("\n"));
  console.log(JSON.stringify({ok:successful.length>0,period:report.period,baseline:report.baseline.metrics,thresholded:report.thresholded.metrics,thresholdDiagnostics:{candidateSignals:report.thresholded.candidateSignals,passed:report.thresholded.passedThresholdSignals,rejected:report.thresholded.thresholdRejected},bySymbol:report.bySymbol,symbolErrors:report.symbolErrors},null,2));
  if (!successful.length) process.exitCode=1;
}
main().catch(error=>{console.error(error);process.exitCode=1;});

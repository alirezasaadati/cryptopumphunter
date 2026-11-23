import { mkdir, writeFile } from "node:fs/promises";
import { analyzeFuturesSymbol, computeBtcRegime, FUTURES_CONFIG } from "../src/index.js";
import { evaluateTradeCandleR, FUTURES_TRADE_LEVERAGE } from "../src/futures-trade-lifecycle.js";

const BASE = "https://futures.kraken.com";
const INTERVALS = { "5m": 300000, "15m": 900000, "1h": 3600000, "4h": 14400000 };
const DAYS = Math.max(7, Math.min(60, Number(process.env.LIFECYCLE_BACKTEST_DAYS || 30)));
const SYMBOL_LIMIT = Math.max(1, Math.min(12, Number(process.env.LIFECYCLE_BACKTEST_SYMBOLS || 10)));
const WARMUP_DAYS = 15;
const TP_R = [1.5, 2.2, 3.0];
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
  const target = Number(trade.target1);
  const stopHit = side === "LONG" ? candle.low <= stop : candle.high >= stop;
  const profitHit = side === "LONG" ? candle.high >= target : candle.low <= target;
  const stopAtOpen = side === "LONG" ? candle.open <= stop : candle.open >= stop;
  const profitAtOpen = side === "LONG" ? candle.open >= target : candle.open <= target;
  return stopHit && profitHit && !stopAtOpen && !profitAtOpen;
}
function summarize(trades) {
  const closed = trades.filter(t => t.status === "CLOSED_PROFIT" || t.status === "CLOSED_STOP");
  const profits = closed.filter(t => Number(t.outcomeR) > 0);
  const stops = closed.filter(t => Number(t.outcomeR) <= 0);
  const rOf = trade => Number.isFinite(Number(trade.outcomeR)) ? Number(trade.outcomeR) : 0;
  const sumR = rows => rows.reduce((sum, trade) => sum + rOf(trade), 0);
  const grossWin = profits.reduce((sum, trade) => sum + rOf(trade), 0);
  const grossLoss = Math.abs(stops.reduce((sum, trade) => sum + rOf(trade), 0));
  let equity = 0, peak = 0, maxDrawdownR = 0;
  for (const trade of [...closed].sort((a,b)=>(a.closedAtMs||0)-(b.closedAtMs||0))) {
    equity += rOf(trade);
    peak = Math.max(peak, equity);
    maxDrawdownR = Math.max(maxDrawdownR, peak - equity);
  }
  const longs = closed.filter(t => t.side === "LONG");
  const shorts = closed.filter(t => t.side === "SHORT");
  const sideStats = rows => ({
    trades: rows.length,
    winRatePct: rows.length ? rows.filter(t => rOf(t) > 0).length / rows.length * 100 : 0,
    totalR: sumR(rows),
    avgR: rows.length ? sumR(rows) / rows.length : 0
  });
  return {
    tradesStarted: trades.length,
    closedTrades: closed.length,
    profitCloses: profits.length,
    stopCloses: stops.length,
    openAtEnd: trades.length - closed.length,
    longs: longs.length,
    shorts: shorts.length,
    winRatePct: closed.length ? profits.length / closed.length * 100 : 0,
    totalR: sumR(closed),
    averageR: closed.length ? sumR(closed) / closed.length : 0,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0),
    maxDrawdownR,
    ambiguous5mCandles: trades.reduce((n,t)=>n+(t.ambiguousCandles || 0),0),
    bySide: { LONG: sideStats(longs), SHORT: sideStats(shorts) }
  };
}

async function backtestSymbol(ticker, fromMs, toMs, btc4h = []) {
  const [oneHour,fourHour,fifteenMinute,fiveMinute] = await Promise.all([
    fetchHistoricalCandles(ticker.symbol,"1h",fromMs,toMs),
    fetchHistoricalCandles(ticker.symbol,"4h",fromMs,toMs),
    fetchHistoricalCandles(ticker.symbol,"15m",fromMs,toMs),
    fetchHistoricalCandles(ticker.symbol,"5m",fromMs,toMs)
  ]);
  if (oneHour.length < 100 || fourHour.length < FUTURES_CONFIG.MIN_CANDLES || fifteenMinute.length < 120 || fiveMinute.length < 1000) {
    throw new Error("insufficient candles (1h="+oneHour.length+", 4h="+fourHour.length+", 15m="+fifteenMinute.length+", 5m="+fiveMinute.length+")");
  }

  const trades = [];
  const lockUntil = new Map();
  let fourIndex = 0, fifteenIndex = 0, btcIndex = 0;
  let acceptedSignals = 0, skippedByLock = 0, rejectedSignals = 0;
  const testStart = toMs - DAYS * 86400000;

  for (let i = 60; i < oneHour.length - 1; i++) {
    const signalBar = oneHour[i];
    const signalCloseTime = signalBar.time + INTERVALS["1h"];
    if (signalCloseTime < testStart || signalCloseTime >= toMs) continue;
    while (fourIndex < fourHour.length && fourHour[fourIndex].time + INTERVALS["4h"] <= signalCloseTime) fourIndex++;
    while (fifteenIndex < fifteenMinute.length && fifteenMinute[fifteenIndex].time + INTERVALS["15m"] <= signalCloseTime) fifteenIndex++;
    while (btcIndex < btc4h.length && btc4h[btcIndex].time + INTERVALS["4h"] <= signalCloseTime) btcIndex++;
    const btcRegime = computeBtcRegime(btc4h.slice(Math.max(0,btcIndex-120),btcIndex));
    const closed4h = fourHour.slice(0,fourIndex);
    const closed15m = fifteenMinute.slice(Math.max(0,fifteenIndex-120),fifteenIndex);
    if (closed4h.length < FUTURES_CONFIG.MIN_CANDLES || closed15m.length < 40) continue;

    const nextBar = oneHour[i+1];
    const tickerAtSignal = {
      symbol: ticker.symbol, last: nextBar.open, quoteVolume: Number(ticker.volumeQuote)||0,
      priceChangePercent: historicalChange(oneHour,i), premium: { lastFundingRate: null }
    };
    let candidate;
    try { candidate = analyzeFuturesSymbol(tickerAtSignal,oneHour.slice(0,i+1),closed4h,closed15m,{ btcRegime }); }
    catch { rejectedSignals++; continue; }
    if (!candidate || candidate.eligible !== true || !["LONG","SHORT"].includes(candidate.side)) { rejectedSignals++; continue; }
    acceptedSignals++;
    const lockKey = ticker.symbol + "|" + candidate.side;
    if ((lockUntil.get(lockKey) || 0) > signalCloseTime) { skippedByLock++; continue; }

    const entry = Number(candidate.entry);
    const trade = {
      id: ticker.symbol + ":" + candidate.side + ":" + signalCloseTime,
      symbol: ticker.symbol, side: candidate.side, status: "OPEN",
      entry, actualEntry: entry, initialStop: Number(candidate.stop), stop: Number(candidate.stop),
      currentStop: Number(candidate.stop), target1: Number(candidate.target1), target2: Number(candidate.target2),
      target3: Number(candidate.target3), initialRisk: (candidate.side === "LONG" ? 1 : -1) * (entry - Number(candidate.stop)),
      tpHits: [], realizedR: 0, remainingFraction: 1, outcomeR: 0,
      signalTime: signalBar.time, entryTime: signalCloseTime,
      score: candidate.score, ambiguousCandles: 0
    };
    let candleIndex = lowerBound(fiveMinute,signalCloseTime);
    let closed = false;
    for (; candleIndex < fiveMinute.length && fiveMinute[candleIndex].time < toMs; candleIndex++) {
      const bar = fiveMinute[candleIndex];
      if (candleAmbiguous(candidate.side,trade,bar)) trade.ambiguousCandles++;
      const evaluated = evaluateTradeCandleR(trade,{...bar,time:bar.time+INTERVALS["5m"]});
      if (evaluated.changed) Object.assign(trade,evaluated.trade);
      if (evaluated.closed) {
        trade.closedAtMs = bar.time + INTERVALS["5m"];
        closed = true;
        break;
      }
    }
    if (!closed) {
      trade.status = "OPEN_AT_BACKTEST_END";
      trade.lastMark = fiveMinute.at(-1)?.close ?? null;
      trade.marginReturnAtMarkPct = trade.lastMark ? (candidate.side==="LONG" ? 1 : -1) * ((trade.lastMark-entry)/entry) * 100 * LEVERAGE : null;
      // Preserve the same-side lock through the sample end for still-open trades.
      lockUntil.set(lockKey,toMs);
    } else {
      lockUntil.set(lockKey,trade.closedAtMs);
    }
    trades.push(trade);
  }

  return {
    symbol:ticker.symbol,
    candles:{ "1h":oneHour.length, "4h":fourHour.length, "15m":fifteenMinute.length, "5m":fiveMinute.length },
    signalsAccepted:acceptedSignals, skippedBySameSideLock:skippedByLock, rejectedSignals,
    metrics:summarize(trades), trades
  };
}

async function main() {
  const endMs = Date.now();
  const startMs = endMs - DAYS*86400000;
  const fromMs = startMs - WARMUP_DAYS*86400000;
  const tickerData = await getJson(BASE + "/derivatives/api/v3/tickers");
  if (!Array.isArray(tickerData?.tickers)) throw new Error("Kraken tickers response invalid");
  const universe = tickerData.tickers.filter(t => t?.tag==="perpetual" && t.suspended!==true &&
    /^(PI|PF)_[A-Z0-9]+USD$/.test(String(t.symbol||"")) &&
    Number(t.volumeQuote)>=FUTURES_CONFIG.MIN_QUOTE_VOLUME && Number(t.last)>0)
    .sort((a,b)=>Number(b.volumeQuote)-Number(a.volumeQuote)).slice(0,SYMBOL_LIMIT);
  if (!universe.length) throw new Error("No eligible Kraken perpetual contracts found");

  const btc4h = await fetchHistoricalCandles(FUTURES_CONFIG.BTC_SYMBOL,"4h",fromMs,endMs);
  const results = [];
  for (const ticker of universe) {
    try { results.push(await backtestSymbol(ticker,fromMs,endMs,btc4h)); }
    catch (error) { results.push({symbol:ticker.symbol,error:String(error?.message||error)}); }
  }
  const successful = results.filter(r=>!r.error);
  const allTrades = successful.flatMap(r=>r.trades).sort((a,b)=>(a.closedAtMs||Number.MAX_SAFE_INTEGER)-(b.closedAtMs||Number.MAX_SAFE_INTEGER));
  const metrics = summarize(allTrades);
  const report = {
    generatedAt:new Date().toISOString(), venue:"Kraken Futures public historical OHLC candles",
    period:{from:new Date(startMs).toISOString(),to:new Date(endMs).toISOString(),days:DAYS,warmupDays:WARMUP_DAYS},
    rules:{leverage:LEVERAGE,tpRiskMultiples:TP_R,tpWeights:[0.40,0.35,0.25],
      exit:"40% at 1.5R, 35% at 2.2R, 25% at 3R; after TP1 remaining stop moves to breakeven",
      candleResolution:"5m",sameCandleAmbiguity:"stop-first unless a gap at candle open proves one level was reached first",
      fees:"excluded",funding:"excluded",
      execution:"signal generated from closed 1h/4h/15m candles; entry at next 1h open; exits evaluated on subsequent 5m OHLC",
      lock:"independent symbol+side lock until close; opposite side may overlap",
      universe:"top current Kraken perpetuals by current quote volume; survivorship bias applies"},
    symbolsRequested:SYMBOL_LIMIT,symbolsTested:successful.length,symbolErrors:results.filter(r=>r.error),
    metrics,eligibleSignalOpportunities:successful.reduce((n,r)=>n+r.signalsAccepted,0),
    bySymbol:successful.map(({trades,...r})=>({...r,metrics:r.metrics})),
    lockSkips:successful.reduce((n,r)=>n+r.skippedBySameSideLock,0),
    rejectedSignals:successful.reduce((n,r)=>n+r.rejectedSignals,0),
    trades:allTrades
  };
  await mkdir("artifacts",{recursive:true});
  await writeFile("artifacts/futures-lifecycle-backtest.json",JSON.stringify(report,null,2));
  const rows = [
    "# Futures lifecycle historical backtest","",
    "Period: "+report.period.from+" — "+report.period.to+" ("+DAYS+" days)",
    "Symbols tested: "+report.symbolsTested+"/"+SYMBOL_LIMIT,"",
    "| Metric | Result |","|---|---:|",
    "| Eligible signal opportunities | "+report.eligibleSignalOpportunities+" |",
    "| Trades started after same-side lock | "+metrics.tradesStarted+" |",
    "| Closed trades | "+metrics.closedTrades+" |",
    "| Profit closes | "+metrics.profitCloses+" |",
    "| Stop / non-positive closes | "+metrics.stopCloses+" |",
    "| Open at end | "+metrics.openAtEnd+" |",
    "| LONG / SHORT | "+metrics.longs+" / "+metrics.shorts+" |",
    "| Win rate | "+metrics.winRatePct.toFixed(2)+"% |",
    "| Total R | "+metrics.totalR.toFixed(2)+" |",
    "| Average R / trade | "+metrics.averageR.toFixed(3)+" |",
    "| Profit factor | "+(Number.isFinite(metrics.profitFactor)?metrics.profitFactor.toFixed(2):"∞")+" |",
    "| Max drawdown | "+metrics.maxDrawdownR.toFixed(2)+"R |",
    "| LONG win rate / total R | "+metrics.bySide.LONG.winRatePct.toFixed(1)+"% / "+metrics.bySide.LONG.totalR.toFixed(2)+"R |",
    "| SHORT win rate / total R | "+metrics.bySide.SHORT.winRatePct.toFixed(1)+"% / "+metrics.bySide.SHORT.totalR.toFixed(2)+"R |",
    "| Ambiguous 5m candles | "+metrics.ambiguous5mCandles+" |",
    "| Same-side lock skips | "+report.lockSkips+" |",
    "| Rejected signal opportunities | "+report.rejectedSignals+" |","",
    "| Symbol | Signals | Closed | Profit | Stop | LONG | SHORT | Total R |",
    "|---|---:|---:|---:|---:|---:|---:|---:|",
    ...successful.map(r=>"| "+r.symbol+" | "+r.signalsAccepted+" | "+r.metrics.closedTrades+" | "+r.metrics.profitCloses+" | "+r.metrics.stopCloses+" | "+r.metrics.longs+" | "+r.metrics.shorts+" | "+r.metrics.totalR.toFixed(2)+" |"),
    "", "Limitations: 5m OHLC cannot identify intrabar path; ambiguous candles use stop-first. Stop execution is assumed at the stop or gap open. Liquidation, funding, fees, and slippage are excluded. Universe selection uses current volume, so survivorship bias applies.",
    "", "Symbol errors:", ...report.symbolErrors.map(x=>"- "+x.symbol+": "+x.error)
  ];
  await writeFile("artifacts/futures-lifecycle-backtest.md",rows.join("\n"));
  console.log(JSON.stringify({ok:successful.length>0,period:report.period,metrics,symbols:report.bySymbol,symbolErrors:report.symbolErrors,lockSkips:report.lockSkips,rejectedSignals:report.rejectedSignals},null,2));
  if (!successful.length) process.exitCode=1;
}
main().catch(error=>{console.error(error);process.exitCode=1;});

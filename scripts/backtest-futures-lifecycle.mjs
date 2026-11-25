import { mkdir, writeFile } from "node:fs/promises";
import { analyzeFuturesSymbol, FUTURES_CONFIG } from "../src/index.js";
import { FUTURES_TRADE_LEVERAGE } from "../src/futures-trade-lifecycle.js";

const BASE = "https://futures.kraken.com";
const INTERVALS = { "5m": 300000, "15m": 900000, "1h": 3600000, "4h": 14400000 };
const DAYS = Math.max(7, Math.min(60, Number(process.env.LIFECYCLE_BACKTEST_DAYS || 30)));
const SYMBOL_LIMIT = Math.max(1, Math.min(12, Number(process.env.LIFECYCLE_BACKTEST_SYMBOLS || 10)));
const WARMUP_DAYS = 15;
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

// Mirror the live engine's closed-candle BTC 4h trend gate for historical tests.
function ema(values, period) {
  if (values.length < period) return null;
  const multiplier = 2 / (period + 1);
  let value = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) value = values[i] * multiplier + value * (1 - multiplier);
  return value;
}
function historicalBtcFourHourTrend(candles) {
  if (!Array.isArray(candles) || candles.length < FUTURES_CONFIG.MIN_CANDLES) return null;
  const closes = candles.map(c => c.close), lastClose = closes[closes.length - 1];
  const fast = ema(closes, 20), prevFast = ema(closes.slice(0, -1), 20), slow = ema(closes, 50);
  if (![fast, prevFast, slow, lastClose].every(Number.isFinite)) return null;
  if (fast > slow && lastClose > fast && fast >= prevFast) return "BULLISH";
  if (fast < slow && lastClose < fast && fast <= prevFast) return "BEARISH";
  return "NEUTRAL";
}
function lowerBound(candles, time) {
  let lo = 0, hi = candles.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (candles[mid].time < time) lo = mid + 1; else hi = mid; }
  return lo;
}
function targetLevels(trade) {
  const entry = Number(trade.entry);
  const dir = trade.side === "LONG" ? 1 : -1;
  // 30% gross return on $10 margin at 10x = 3% favorable underlying move.
  return [entry * (1 + dir * 0.03)];
}
function candleAmbiguous(side, trade, candle) {
  const stop = Number(trade.currentStop ?? trade.initialStop ?? trade.stop);
  const target = targetLevels(trade)[0];
  const stopHit = side === "LONG" ? candle.low <= stop : candle.high >= stop;
  const targetHit = side === "LONG" ? candle.high >= target : candle.low <= target;
  const stopAtOpen = side === "LONG" ? candle.open <= stop : candle.open >= stop;
  const targetAtOpen = side === "LONG" ? candle.open >= target : candle.open <= target;
  return stopHit && targetHit && !stopAtOpen && !targetAtOpen;
}
function evaluateStagedCandle(trade, candle) {
  if (trade.status !== "OPEN") return { changed: false };
  const entry = Number(trade.entry), stop = Number(trade.currentStop ?? trade.initialStop ?? trade.stop);
  const target = targetLevels(trade)[0], dir = trade.side === "LONG" ? 1 : -1;
  const open = Number(candle.open), high = Number(candle.high), low = Number(candle.low);
  const stopHit = trade.side === "LONG" ? low <= stop : high >= stop;
  const targetHit = trade.side === "LONG" ? high >= target : low <= target;
  const stopAtOpen = trade.side === "LONG" ? open <= stop : open >= stop;
  const targetAtOpen = trade.side === "LONG" ? open >= target : open <= target;
  // If both stop and TP are touched in the same 5m candle, stop wins.
  if (stopHit) {
    const exit = stopAtOpen ? open : stop;
    const pnl = dir * ((exit-entry)/entry) * 100 * LEVERAGE;
    return { changed:true, closed:true, reason:"CLOSED_STOP", trade:{
      ...trade,status:"CLOSED_STOP",closeReason:"CLOSED_STOP",exitPrice:exit,
      tpHits:[],remainingFraction:0,realizedMarginReturnPct:pnl,marginReturnPercent:pnl,
      closedAt:candle.time ?? new Date().toISOString(),currentStop:stop,lockReleaseEligible:true
    }};
  }
  if (targetHit) {
    const exit = targetAtOpen ? open : target;
    const pnl = dir * ((exit-entry)/entry) * 100 * LEVERAGE;
    return { changed:true,closed:true,reason:"CLOSED_PROFIT",trade:{
      ...trade,status:"CLOSED_PROFIT",closeReason:"CLOSED_PROFIT",exitPrice:exit,
      tpHits:["TP30"],remainingFraction:0,realizedMarginReturnPct:pnl,marginReturnPercent:pnl,
      closedAt:candle.time ?? new Date().toISOString(),currentStop:stop,lockReleaseEligible:true
    }};
  }
  return { changed:false,trade };
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
  const sum = xs => xs.reduce((n,t)=>n+Number(t.marginReturnPercent || 0),0);
  const sideSummary = side => {
    const started = trades.filter(t => t.side === side);
    const resolved = started.filter(t => t.status === "CLOSED_PROFIT" || t.status === "CLOSED_STOP");
    const wins = resolved.filter(t => Number(t.marginReturnPercent) > 0);
    return { tradesStarted: started.length, closedTrades: resolved.length, profitCloses: resolved.filter(t => t.status === "CLOSED_PROFIT").length,
      netPositiveClosedTrades: wins.length,
      netNegativeClosedTrades: resolved.filter(t => Number(t.marginReturnPercent) < 0).length,
      stopCloses: resolved.filter(t => t.status === "CLOSED_STOP").length,
      positiveStopCloses: resolved.filter(t => t.status === "CLOSED_STOP" && Number(t.marginReturnPercent) > 0).length,
      losingStopCloses: resolved.filter(t => t.status === "CLOSED_STOP" && Number(t.marginReturnPercent) < 0).length,
      openAtEnd: started.length - resolved.length,
      winRatePct: resolved.length ? wins.length / resolved.length * 100 : 0,
      netMarginReturnPct: sum(resolved) };
  };
  const longs = closed.filter(t => t.side === "LONG");
  const shorts = closed.filter(t => t.side === "SHORT");
  return {
    tradesStarted: trades.length, closedTrades: closed.length, profitCloses: profits.length, stopCloses: stops.length,
    openAtEnd: trades.length - closed.length, longs: longs.length, shorts: shorts.length,
    openPartialRealizedMarginReturnPct: trades.filter(t => t.status === "OPEN_AT_BACKTEST_END").reduce((n,t)=>n+Number(t.realizedMarginReturnPct||0),0),
    openRemainingUnrealizedMarginReturnPct: trades.filter(t => t.status === "OPEN_AT_BACKTEST_END").reduce((n,t)=>n+Number(t.unrealizedRemainingMarginReturnPct||0),0),
    openCombinedMarkToMarketMarginReturnPct: trades.filter(t => t.status === "OPEN_AT_BACKTEST_END").reduce((n,t)=>n+Number(t.marginReturnAtMarkPct||0),0),
    openTradesWithTP1: trades.filter(t => t.status === "OPEN_AT_BACKTEST_END" && (t.tpHits||[]).includes("TP1")).length,
    openTradesWithTP2: trades.filter(t => t.status === "OPEN_AT_BACKTEST_END" && (t.tpHits||[]).includes("TP2")).length,
    winRatePct: closed.length ? closed.filter(t => Number(t.marginReturnPercent) > 0).length / closed.length * 100 : 0,
    netPositiveClosedTrades: closed.filter(t => Number(t.marginReturnPercent) > 0).length,
    netNegativeClosedTrades: closed.filter(t => Number(t.marginReturnPercent) < 0).length,
    totalMarginReturnPct: sum(closed), averageMarginReturnPct: closed.length ? sum(closed) / closed.length : 0,
    maxDrawdownMarginPct: maxDrawdown, ambiguous5mCandles: trades.reduce((n,t)=>n+(t.ambiguousCandles || 0),0),
    breakEvenMoves: trades.reduce((n,t)=>n+(t.breakEvenMoveCount || 0),0),
    positiveStopCloses: stops.filter(t => Number(t.marginReturnPercent) > 0).length,
    losingStopCloses: stops.filter(t => Number(t.marginReturnPercent) < 0).length,
    bySide: { LONG: sideSummary("LONG"), SHORT: sideSummary("SHORT") }
  };
}
async function backtestSymbol(ticker, fromMs, toMs, btcFourHour) {
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
  let fourIndex = 0, fifteenIndex = 0, btcFourIndex = 0;
  let acceptedSignals = 0, skippedByLock = 0, rejectedSignals = 0;
  const testStart = toMs - DAYS * 86400000;

  for (let i = 60; i < oneHour.length - 1; i++) {
    const signalBar = oneHour[i];
    const signalCloseTime = signalBar.time + INTERVALS["1h"];
    if (signalCloseTime < testStart || signalCloseTime >= toMs) continue;
    while (fourIndex < fourHour.length && fourHour[fourIndex].time + INTERVALS["4h"] <= signalCloseTime) fourIndex++;
    while (fifteenIndex < fifteenMinute.length && fifteenMinute[fifteenIndex].time + INTERVALS["15m"] <= signalCloseTime) fifteenIndex++;
    while (btcFourIndex < btcFourHour.length && btcFourHour[btcFourIndex].time + INTERVALS["4h"] <= signalCloseTime) btcFourIndex++;
    const closed4h = fourHour.slice(0,fourIndex);
    const closed15m = fifteenMinute.slice(Math.max(0,fifteenIndex-120),fifteenIndex);
    const closedBtc4h = btcFourHour.slice(0,btcFourIndex);
    const btcFourHourTrend = historicalBtcFourHourTrend(closedBtc4h);
    if (!btcFourHourTrend) { rejectedSignals++; continue; }
    if (closed4h.length < FUTURES_CONFIG.MIN_CANDLES || closed15m.length < 40) continue;

    const nextBar = oneHour[i+1];
    const tickerAtSignal = {
      symbol: ticker.symbol, last: nextBar.open, quoteVolume: Number(ticker.volumeQuote)||0,
      priceChangePercent: historicalChange(oneHour,i), premium: { lastFundingRate: null }
    };
    let candidate;
    try { candidate = analyzeFuturesSymbol(tickerAtSignal,oneHour.slice(0,i+1),closed4h,closed15m,{btcFourHourTrend,requireBtcFourHourAlignment:true}); }
    catch { rejectedSignals++; continue; }
    if (!candidate || candidate.eligible !== true || !["LONG","SHORT"].includes(candidate.side)) { rejectedSignals++; continue; }
    acceptedSignals++;
    const lockKey = ticker.symbol + "|" + candidate.side;
    if ((lockUntil.get(lockKey) || 0) > signalCloseTime) { skippedByLock++; continue; }

    const entry = Number(candidate.entry);
    const trade = {
      id: ticker.symbol + ":" + candidate.side + ":" + signalCloseTime,
      symbol: ticker.symbol, side: candidate.side, status: "OPEN",
      entry, initialStop: Number(candidate.stop), stop: Number(candidate.stop),
      target1: Number(candidate.target1), target2: Number(candidate.target2), target3: Number(candidate.target3),
      remainingFraction: 1, tpHits: [], realizedMarginReturnPct: 0,
      signalTime: signalBar.time, entryTime: signalCloseTime,
      score: candidate.score, ambiguousCandles: 0
    };
    let candleIndex = lowerBound(fiveMinute,signalCloseTime);
    let closed = false;
    for (; candleIndex < fiveMinute.length && fiveMinute[candleIndex].time < toMs; candleIndex++) {
      const bar = fiveMinute[candleIndex];
      if (candleAmbiguous(candidate.side,trade,bar)) trade.ambiguousCandles++;
      const evaluated = evaluateStagedCandle(trade,{...bar,time:bar.time+INTERVALS["5m"]});
      if (evaluated.stopMoved) trade.breakEvenMoveCount = (trade.breakEvenMoveCount || 0) + 1;
      if (evaluated.changed || evaluated.stopMoved || evaluated.trade) Object.assign(trade,evaluated.trade);
      if (evaluated.closed) {
        trade.closedAtMs = bar.time + INTERVALS["5m"];
        closed = true;
        break;
      }
    }
    if (!closed) {
      trade.status = "OPEN_AT_BACKTEST_END";
      trade.lastMark = fiveMinute.at(-1)?.close ?? null;
      const dir = candidate.side === "LONG" ? 1 : -1;
      trade.unrealizedRemainingMarginReturnPct = trade.lastMark
        ? Number(trade.remainingFraction ?? 1) * dir * ((trade.lastMark-entry)/entry) * 100 * LEVERAGE : null;
      trade.marginReturnAtMarkPct = trade.lastMark
        ? Number(trade.realizedMarginReturnPct || 0) + Number(trade.unrealizedRemainingMarginReturnPct || 0) : null;
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

function simulatePortfolio(trades, initialCapital=100, marginPerTrade=10, endMs=Date.now()) {
  const events = [];
  for (const trade of trades) {
    events.push({time:Number(trade.entryTime),type:"ENTRY",trade});
    if (trade.status==="CLOSED_PROFIT" || trade.status==="CLOSED_STOP") {
      events.push({time:Number(trade.closedAtMs),type:"EXIT",trade});
    }
  }
  // Exit events are processed before entries at an identical timestamp.
  events.sort((a,b)=>a.time-b.time || (a.type==="EXIT"?-1:1));
  let freeMargin=initialCapital, usedMargin=0, peakEquity=initialCapital, maxDrawdown=0;
  let accepted=0, skipped=0, maxConcurrent=0, realizedPnl=0;
  const active=new Map(), skippedIds=new Set();
  for (const event of events) {
    const t=event.trade;
    if (event.type==="ENTRY") {
      if (freeMargin + 1e-9 < marginPerTrade) { skipped++; skippedIds.add(t.id); continue; }
      freeMargin-=marginPerTrade; usedMargin+=marginPerTrade;
      active.set(t.id,t); accepted++; maxConcurrent=Math.max(maxConcurrent,active.size);
    } else if (active.has(t.id)) {
      const pnl=marginPerTrade*Number(t.marginReturnPercent||0)/100;
      freeMargin+=marginPerTrade+pnl; usedMargin-=marginPerTrade;
      realizedPnl+=pnl; active.delete(t.id);
      const equity=freeMargin+usedMargin;
      peakEquity=Math.max(peakEquity,equity);
      maxDrawdown=Math.max(maxDrawdown,peakEquity-equity);
    }
  }
  let openUnrealizedPnl=0;
  for (const t of active.values()) {
    openUnrealizedPnl += marginPerTrade*Number(t.marginReturnAtMarkPct||0)/100;
  }
  const endingEquity=freeMargin+usedMargin+openUnrealizedPnl;
  return {
    initialCapitalUSD:initialCapital, marginPerTradeUSD:marginPerTrade,
    leverage:LEVERAGE, notionalPerTradeUSD:marginPerTrade*LEVERAGE,
    maxConcurrentPositions:maxConcurrent, acceptedTrades:accepted, skippedForInsufficientFreeMargin:skipped,
    closedPositions:accepted-active.size, openPositionsAtEnd:active.size,
    realizedNetPnlUSD:Number(realizedPnl.toFixed(4)),
    openPositionsMarkToMarketPnlUSD:Number(openUnrealizedPnl.toFixed(4)),
    endingEquityUSD:Number(endingEquity.toFixed(4)),
    netReturnPct:Number(((endingEquity/initialCapital-1)*100).toFixed(4)),
    maxDrawdownFromRealizedEquityUSD:Number(maxDrawdown.toFixed(4)),
    freeMarginAtEndUSD:Number(freeMargin.toFixed(4)),
    usedMarginAtEndUSD:Number(usedMargin.toFixed(4)),
    skippedTradeIds:[...skippedIds],
    accounting:"Fixed $10 initial margin per accepted trade; margin remains reserved until the full position closes. Realized trade PnL is applied at final close; open positions are marked to the final 5m close. No compounding of per-trade margin size."
  };
}

async function main() {
  const endMs = Number(process.env.BACKTEST_END_MS || Date.now());
  const startMs = endMs - DAYS*86400000;
  const fromMs = startMs - WARMUP_DAYS*86400000;
  const tickerData = await getJson(BASE + "/derivatives/api/v3/tickers");
  if (!Array.isArray(tickerData?.tickers)) throw new Error("Kraken tickers response invalid");
  const requestedSymbols = String(process.env.BACKTEST_SYMBOLS || "").split(",").map(s=>s.trim()).filter(Boolean);
  const eligibleTickers = tickerData.tickers.filter(t => t?.tag==="perpetual" && t.suspended!==true &&
    /^(PI|PF)_[A-Z0-9]+USD$/.test(String(t.symbol||"")) &&
    Number(t.volumeQuote)>=FUTURES_CONFIG.MIN_QUOTE_VOLUME && Number(t.last)>0);
  const universe = requestedSymbols.length
    ? requestedSymbols.map(symbol=>eligibleTickers.find(t=>t.symbol===symbol)).filter(Boolean)
    : eligibleTickers.sort((a,b)=>Number(b.volumeQuote)-Number(a.volumeQuote)).slice(0,SYMBOL_LIMIT);
  if (!universe.length) throw new Error("No eligible Kraken perpetual contracts found");

  // One shared historical BTC 4h series, evaluated only on candles closed at each signal time.
  const btcFourHour = await fetchHistoricalCandles("PF_XBTUSD","4h",fromMs,endMs);
  const results = [];
  for (const ticker of universe) {
    try { results.push(await backtestSymbol(ticker,fromMs,endMs,btcFourHour)); }
    catch (error) { results.push({symbol:ticker.symbol,error:String(error?.message||error)}); }
  }
  const successful = results.filter(r=>!r.error);
  const allTrades = successful.flatMap(r=>r.trades).sort((a,b)=>(a.closedAtMs||Number.MAX_SAFE_INTEGER)-(b.closedAtMs||Number.MAX_SAFE_INTEGER));
  const metrics = summarize(allTrades);
  const portfolio = simulatePortfolio(allTrades,100,10,endMs);
  const report = {
    generatedAt:new Date().toISOString(), venue:"Kraken Futures public historical OHLC candles",
    period:{from:new Date(startMs).toISOString(),to:new Date(endMs).toISOString(),days:DAYS,warmupDays:WARMUP_DAYS},
    rules:{leverage:LEVERAGE,targets:"single TP at +30% gross return on margin (3% favorable price move at 10x); no partial exits",
      exit:"full position closes at +30% margin TP or initial stop, whichever occurs first; no break-even move",
      candleResolution:"5m",sameCandleAmbiguity:"stop-first unless a gap at candle open proves one level was reached first",
      fees:"excluded by user-defined gross price-move × leverage model",funding:"excluded",
      execution:"signal generated from closed 1h/4h/15m candles; entry at next 1h open; exits evaluated on subsequent 5m OHLC",
      btcFilter:"mandatory historical BTC 4h alignment; trend computed only from BTC 4h candles closed by each signal time",
      lock:"independent symbol+side lock until close; opposite side may overlap",
      universe:"top current Kraken perpetuals by current quote volume; survivorship bias applies"},
    symbolsRequested:SYMBOL_LIMIT,symbolsTested:successful.length,symbolErrors:results.filter(r=>r.error),
    portfolio,metrics,eligibleSignalOpportunities:successful.reduce((n,r)=>n+r.signalsAccepted,0),
    bySymbol:successful.map(({trades,...r})=>({...r,metrics:r.metrics})),
    lockSkips:successful.reduce((n,r)=>n+r.skippedBySameSideLock,0),
    rejectedSignals:successful.reduce((n,r)=>n+r.rejectedSignals,0),
    trades:allTrades
  };
  await mkdir("artifacts",{recursive:true});
  await writeFile("artifacts/futures-lifecycle-backtest.json",JSON.stringify(report,null,2));
  const rows = [
    "# Futures fixed +30% margin TP historical backtest","",
    "Period: "+report.period.from+" — "+report.period.to+" ("+DAYS+" days)",
    "Symbols tested: "+report.symbolsTested+"/"+SYMBOL_LIMIT,"",
    "| Metric | Result |","|---|---:|",
    "| Starting account equity (USD) | $"+portfolio.initialCapitalUSD.toFixed(2)+" |",
    "| Fixed margin per trade (USD) | $"+portfolio.marginPerTradeUSD.toFixed(2)+" |",
    "| Leverage / notional per trade | "+portfolio.leverage+"x / $"+portfolio.notionalPerTradeUSD.toFixed(2)+" |",
    "| Accepted / skipped for insufficient free margin | "+portfolio.acceptedTrades+" / "+portfolio.skippedForInsufficientFreeMargin+" |",
    "| Maximum concurrent positions | "+portfolio.maxConcurrentPositions+" |",
    "| Realized net PnL (USD) | $"+portfolio.realizedNetPnlUSD.toFixed(2)+" |",
    "| Open-position mark-to-market PnL (USD) | $"+portfolio.openPositionsMarkToMarketPnlUSD.toFixed(2)+" |",
    "| Ending account equity (USD) | $"+portfolio.endingEquityUSD.toFixed(2)+" |",
    "| Net account return | "+portfolio.netReturnPct.toFixed(2)+"% |",
    "| Ending free / used margin (USD) | $"+portfolio.freeMarginAtEndUSD.toFixed(2)+" / $"+portfolio.usedMarginAtEndUSD.toFixed(2)+" |",

    "| Eligible signal opportunities | "+report.eligibleSignalOpportunities+" |",
    "| Trades started after same-side lock | "+metrics.tradesStarted+" |",
    "| Closed trades | "+metrics.closedTrades+" |",
    "| Trades reaching TP3 | "+metrics.profitCloses+" |",
    "| Net profitable closed trades | "+metrics.netPositiveClosedTrades+" |",
    "| Net losing closed trades | "+metrics.netNegativeClosedTrades+" |",
    "| Stop closes (including protected BE exits) | "+metrics.stopCloses+" |",
    "| Positive stop exits after partial TP / BE | "+metrics.positiveStopCloses+" |",
    "| Losing stop exits | "+metrics.losingStopCloses+" |",
    "| Open at end | "+metrics.openAtEnd+" |",
    "| Open trades with TP1 / TP2 already hit | "+metrics.openTradesWithTP1+" / "+metrics.openTradesWithTP2+" |",
    "| Partial TP realized on still-open trades (margin points) | "+metrics.openPartialRealizedMarginReturnPct.toFixed(2)+" |",
    "| Remaining open PnL at final mark (margin points) | "+metrics.openRemainingUnrealizedMarginReturnPct.toFixed(2)+" |",
    "| Open positions total mark-to-market (margin points) | "+metrics.openCombinedMarkToMarketMarginReturnPct.toFixed(2)+" |",
    "| LONG / SHORT closed | "+metrics.longs+" / "+metrics.shorts+" |",
    "| LONG net-positive rate (resolved only) | "+metrics.bySide.LONG.winRatePct.toFixed(2)+"% |",
    "| SHORT net-positive rate (resolved only) | "+metrics.bySide.SHORT.winRatePct.toFixed(2)+"% |",
    "| LONG net margin return | "+metrics.bySide.LONG.netMarginReturnPct.toFixed(2)+"% |",
    "| SHORT net margin return | "+metrics.bySide.SHORT.netMarginReturnPct.toFixed(2)+"% |",
    "| Automatic break-even moves | "+metrics.breakEvenMoves+" |",
    "| TP1 hits | "+allTrades.filter(t=>(t.tpHits||[]).includes("TP1")).length+" |",
    "| TP2 hits | "+allTrades.filter(t=>(t.tpHits||[]).includes("TP2")).length+" |",
    "| TP3 hits | "+allTrades.filter(t=>(t.tpHits||[]).includes("TP3")).length+" |",
    "| Net-positive closed-trade rate | "+metrics.winRatePct.toFixed(2)+"% |",
    "| Sum margin return (not compounded) | "+metrics.totalMarginReturnPct.toFixed(2)+"% |",
    "| Average margin return / trade | "+metrics.averageMarginReturnPct.toFixed(2)+"% |",
    "| Max drawdown (additive margin-return points) | "+metrics.maxDrawdownMarginPct.toFixed(2)+"% |",
    "| Ambiguous 5m candles | "+metrics.ambiguous5mCandles+" |",
    "| Same-side lock skips | "+report.lockSkips+" |",
    "| Rejected signal opportunities | "+report.rejectedSignals+" |","",
    "| Symbol | Signals | Closed | Profit | Stop | LONG | SHORT | Net margin % |",
    "|---|---:|---:|---:|---:|---:|---:|---:|",
    ...successful.map(r=>"| "+r.symbol+" | "+r.signalsAccepted+" | "+r.metrics.closedTrades+" | "+r.metrics.profitCloses+" | "+r.metrics.stopCloses+" | "+r.metrics.longs+" | "+r.metrics.shorts+" | "+r.metrics.totalMarginReturnPct.toFixed(2)+" |"),
    "", "Limitations: 5m OHLC cannot identify intrabar path; ambiguous candles use stop-first. Stop execution is assumed at the stop or gap open. Liquidation, funding, fees, and slippage are excluded. Universe selection uses current volume, so survivorship bias applies.",
    "", "Symbol errors:", ...report.symbolErrors.map(x=>"- "+x.symbol+": "+x.error)
  ];
  await writeFile("artifacts/futures-lifecycle-backtest.md",rows.join("\n"));
  console.log(JSON.stringify({ok:successful.length>0,period:report.period,portfolio,metrics,symbols:report.bySymbol,symbolErrors:report.symbolErrors,lockSkips:report.lockSkips,rejectedSignals:report.rejectedSignals},null,2));
  if (!successful.length) process.exitCode=1;
}
main().catch(error=>{console.error(error);process.exitCode=1;});

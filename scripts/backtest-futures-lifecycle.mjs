import { mkdir, writeFile } from "node:fs/promises";
import { analyzeFuturesSymbol, FUTURES_CONFIG } from "../src/index.js";
import { evaluateTradeCandle, FUTURES_TRADE_LEVERAGE, FUTURES_MARGIN_PROFIT_TARGET_PERCENT } from "../src/futures-trade-lifecycle.js";

const BASE = "https://futures.kraken.com";
const INTERVALS = { "5m": 300000, "15m": 900000, "1h": 3600000, "4h": 14400000 };
const DAYS = Math.max(7, Math.min(60, Number(process.env.LIFECYCLE_BACKTEST_DAYS || 30)));
const SYMBOL_LIMIT = Math.max(1, Math.min(12, Number(process.env.LIFECYCLE_BACKTEST_SYMBOLS || 10)));
const WARMUP_DAYS = 15;
const TARGET = FUTURES_MARGIN_PROFIT_TARGET_PERCENT;
const EXIT_MODE = process.env.BACKTEST_EXIT_MODE === "staged" ? "staged" : "fixed";
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

function stagedTargetLevels(trade) {
  const entry=Number(trade.entry), risk=Math.abs(entry-Number(trade.initialStop));
  const dir=trade.side==="LONG"?1:-1;
  return [1.5,2.5,3.5].map(r=>entry+dir*risk*r);
}
function evaluateStagedCandle(trade,candle) {
  if (trade.status!=="OPEN") return {changed:false,trade};
  const entry=Number(trade.entry), initialStop=Number(trade.initialStop);
  const dir=trade.side==="LONG"?1:-1, risk=Math.abs(entry-initialStop);
  const targets=stagedTargetLevels(trade);
  const open=Number(candle.open), high=Number(candle.high), low=Number(candle.low);
  const stop=Number(trade.currentStop??initialStop);
  const stopHit=trade.side==="LONG"?low<=stop:high>=stop;
  const stopAtOpen=trade.side==="LONG"?open<=stop:open>=stop;
  let realized=Number(trade.realizedMarginReturnPct||0);
  let remaining=Number(trade.remainingFraction??1);
  const tpHits=Array.isArray(trade.tpHits)?[...trade.tpHits]:[];
  const priceReturn=(exit)=>dir*((exit-entry)/entry)*100*LEVERAGE;
  if (stopHit) {
    const exit=stopAtOpen?open:stop;
    realized+=remaining*priceReturn(exit);
    return {changed:true,closed:true,reason:"CLOSED_STOP",trade:{
      ...trade,status:"CLOSED_STOP",closeReason:"CLOSED_STOP",exitPrice:exit,
      tpHits,remainingFraction:0,realizedMarginReturnPct:realized,
      marginReturnPercent:realized,closedAt:candle.time??new Date().toISOString(),
      currentStop:stop,lockReleaseEligible:true
    }};
  }
  let currentStop=stop, breakEvenActivated=trade.breakEvenActivated===true;
  const oneR=entry+dir*risk;
  const reachedOneR=trade.side==="LONG"?high>=oneR:low<=oneR;
  if (!breakEvenActivated && risk>0 && reachedOneR) {
    const beStop=entry+dir*entry*0.0012;
    if ((dir===1&&beStop>currentStop)||(dir===-1&&beStop<currentStop)) {
      currentStop=beStop; breakEvenActivated=true;
    }
  }
  for(let i=0;i<3;i++){
    const label="TP"+(i+1);
    if(tpHits.includes(label)) continue;
    const target=targets[i];
    const hit=trade.side==="LONG"?high>=target:low<=target;
    if(!hit) break;
    const gap=trade.side==="LONG"?open>=target:open<=target;
    const exit=gap?open:target;
    const fraction=i<2?Math.min(1/3,remaining):remaining;
    realized+=fraction*priceReturn(exit);
    remaining=Math.max(0,remaining-fraction);
    tpHits.push(label);
  }
  const closedAt=candle.time??new Date().toISOString();
  if(remaining<=1e-9){
    return {changed:true,closed:true,reason:"CLOSED_PROFIT",trade:{
      ...trade,status:"CLOSED_PROFIT",closeReason:"CLOSED_PROFIT",
      exitPrice:targets[2],tpHits,remainingFraction:0,
      realizedMarginReturnPct:realized,marginReturnPercent:realized,
      closedAt,currentStop,breakEvenActivated,lockReleaseEligible:true
    }};
  }
  const changed=tpHits.length!==(trade.tpHits||[]).length||currentStop!==stop||
    breakEvenActivated!==(trade.breakEvenActivated===true);
  return {changed,closed:false,stopMoved:currentStop!==stop,trade:{
    ...trade,tpHits,remainingFraction:remaining,realizedMarginReturnPct:realized,
    currentStop,breakEvenActivated
  }};
}
function stagedCandleAmbiguous(trade,candle){
  const stop=Number(trade.currentStop??trade.initialStop), targets=stagedTargetLevels(trade);
  const active=targets.filter((_,i)=>!(trade.tpHits||[]).includes("TP"+(i+1)));
  const stopHit=trade.side==="LONG"?candle.low<=stop:candle.high>=stop;
  const targetHit=active.some(t=>trade.side==="LONG"?candle.high>=t:candle.low<=t);
  const stopAtOpen=trade.side==="LONG"?candle.open<=stop:candle.open>=stop;
  const targetAtOpen=active.some(t=>trade.side==="LONG"?candle.open>=t:candle.open<=t);
  return stopHit&&targetHit&&!stopAtOpen&&!targetAtOpen;
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

  const trades = [];
  const lockUntil = new Map();
  let fourIndex = 0, fifteenIndex = 0;
  let acceptedSignals = 0, skippedByLock = 0, rejectedSignals = 0;
  const testStart = toMs - DAYS * 86400000;

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
      remainingFraction: 1, tpHits: [], realizedMarginReturnPct: 0,
      signalTime: signalBar.time, entryTime: signalCloseTime,
      score: candidate.score, ambiguousCandles: 0
    };
    let candleIndex = lowerBound(fiveMinute,signalCloseTime);
    let closed = false;
    for (; candleIndex < fiveMinute.length && fiveMinute[candleIndex].time < toMs; candleIndex++) {
      const bar = fiveMinute[candleIndex];
      const evaluated = EXIT_MODE==="staged"
        ? evaluateStagedCandle(trade,{...bar,time:bar.time+INTERVALS["5m"]})
        : evaluateTradeCandle(trade,{...bar,time:bar.time+INTERVALS["5m"]});
      if (EXIT_MODE==="staged" ? stagedCandleAmbiguous(trade,bar) : candleAmbiguous(candidate.side,trade,bar)) trade.ambiguousCandles++;
      if (evaluated.changed || evaluated.stopMoved) Object.assign(trade,evaluated.trade);
      if (EXIT_MODE==="staged" ? evaluated.closed : evaluated.changed) {
        trade.closedAtMs = bar.time + INTERVALS["5m"];
        closed = true;
        break;
      }
    }
    if (!closed) {
      trade.status = "OPEN_AT_BACKTEST_END";
      trade.lastMark = fiveMinute.at(-1)?.close ?? null;
      if (EXIT_MODE==="staged") {
        const dir=candidate.side==="LONG"?1:-1;
        trade.unrealizedRemainingMarginReturnPct=trade.lastMark
          ? Number(trade.remainingFraction??1)*dir*((trade.lastMark-entry)/entry)*100*LEVERAGE : null;
        trade.marginReturnAtMarkPct=trade.lastMark
          ? Number(trade.realizedMarginReturnPct||0)+Number(trade.unrealizedRemainingMarginReturnPct||0) : null;
      } else {
        trade.marginReturnAtMarkPct = trade.lastMark ? (candidate.side==="LONG" ? 1 : -1) * ((trade.lastMark-entry)/entry) * 100 * LEVERAGE : null;
      }
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


function simulatePortfolio(trades, initialCapital=100, marginPerTrade=10) {
  const events=[];
  for (const trade of trades) {
    events.push({time:Number(trade.entryTime),type:"ENTRY",trade});
    if (trade.status==="CLOSED_PROFIT" || trade.status==="CLOSED_STOP") {
      events.push({time:Number(trade.closedAtMs),type:"EXIT",trade});
    }
  }
  events.sort((a,b)=>a.time-b.time || (a.type==="EXIT"?-1:1));
  let free=initialCapital, used=0, realized=0, peak=initialCapital, maxDD=0, accepted=0, skipped=0, maxConcurrent=0;
  const active=new Map();
  for (const e of events) {
    const t=e.trade;
    if (e.type==="ENTRY") {
      if (free+1e-9<marginPerTrade) { skipped++; continue; }
      free-=marginPerTrade; used+=marginPerTrade; active.set(t.id,t); accepted++;
      maxConcurrent=Math.max(maxConcurrent,active.size);
    } else if (active.has(t.id)) {
      const pnl=marginPerTrade*Number(t.marginReturnPercent||0)/100;
      free+=marginPerTrade+pnl; used-=marginPerTrade; realized+=pnl; active.delete(t.id);
      const equity=free+used; peak=Math.max(peak,equity); maxDD=Math.max(maxDD,peak-equity);
    }
  }
  let unrealized=0;
  for (const t of active.values()) unrealized+=marginPerTrade*Number(t.marginReturnAtMarkPct||0)/100;
  const ending=free+used+unrealized;
  return {initialCapitalUSD:initialCapital,marginPerTradeUSD:marginPerTrade,leverage:LEVERAGE,
    notionalPerTradeUSD:marginPerTrade*LEVERAGE,acceptedTrades:accepted,skippedForInsufficientFreeMargin:skipped,
    closedPositions:accepted-active.size,openPositionsAtEnd:active.size,maxConcurrentPositions:maxConcurrent,
    realizedNetPnlUSD:Number(realized.toFixed(4)),openPositionsMarkToMarketPnlUSD:Number(unrealized.toFixed(4)),
    endingEquityUSD:Number(ending.toFixed(4)),netReturnPct:Number(((ending/initialCapital-1)*100).toFixed(4)),
    maxDrawdownFromRealizedEquityUSD:Number(maxDD.toFixed(4)),freeMarginAtEndUSD:Number(free.toFixed(4)),
    usedMarginAtEndUSD:Number(used.toFixed(4))};
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

  const results = [];
  for (const ticker of universe) {
    try { results.push(await backtestSymbol(ticker,fromMs,endMs)); }
    catch (error) { results.push({symbol:ticker.symbol,error:String(error?.message||error)}); }
  }
  const successful = results.filter(r=>!r.error);
  const allTrades = successful.flatMap(r=>r.trades).sort((a,b)=>(a.closedAtMs||Number.MAX_SAFE_INTEGER)-(b.closedAtMs||Number.MAX_SAFE_INTEGER));
  const metrics = summarize(allTrades);
  const portfolio = simulatePortfolio(allTrades,100,10);
  const report = {
    generatedAt:new Date().toISOString(), exitMode:EXIT_MODE, venue:"Kraken Futures public historical OHLC candles",
    period:{from:new Date(startMs).toISOString(),to:new Date(endMs).toISOString(),days:DAYS,warmupDays:WARMUP_DAYS},
    rules:{leverage:LEVERAGE,targetMarginReturnPct:TARGET,requiredFavorablePriceMovePct:TARGET/LEVERAGE,
      exit:EXIT_MODE==="staged" ? "one-third at each 1.5R/2.5R/3.5R target; stop protects remaining size; move stop to entry plus 0.12% after +1R" : "close only at +30% margin return or configured stop",
      exitMode:EXIT_MODE,tp1Tp2Tp3:EXIT_MODE==="staged" ? "one-third at each target" : "ignored for closing",
      candleResolution:"5m",sameCandleAmbiguity:"stop-first unless a gap at candle open proves one level was reached first",
      fees:"excluded by user-defined gross price-move × leverage model",funding:"excluded",
      execution:"signal generated from closed 1h/4h/15m candles; entry at next 1h open; exits evaluated on subsequent 5m OHLC",
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
    "# Futures lifecycle historical backtest ("+EXIT_MODE+" exits)","",
    "Period: "+report.period.from+" — "+report.period.to+" ("+DAYS+" days)",
    "Symbols tested: "+report.symbolsTested+"/"+SYMBOL_LIMIT,"",
    "| Metric | Result |","|---|---:|",
    "| Starting equity / fixed margin | $"+portfolio.initialCapitalUSD+" / $"+portfolio.marginPerTradeUSD+" |",
    "| Leverage / notional per trade | "+portfolio.leverage+"x / $"+portfolio.notionalPerTradeUSD+" |",
    "| Accepted / skipped for insufficient margin | "+portfolio.acceptedTrades+" / "+portfolio.skippedForInsufficientFreeMargin+" |",
    "| Realized PnL | $"+portfolio.realizedNetPnlUSD.toFixed(2)+" |",
    "| Ending equity | $"+portfolio.endingEquityUSD.toFixed(2)+" |",
    "| Account return | "+portfolio.netReturnPct.toFixed(2)+"% |",
    "| Eligible signal opportunities | "+report.eligibleSignalOpportunities+" |",
    "| Trades started after same-side lock | "+metrics.tradesStarted+" |",
    "| Closed trades | "+metrics.closedTrades+" |",
    "| Profit closes | "+metrics.profitCloses+" |",
    "| Stop closes | "+metrics.stopCloses+" |",
    "| Open at end | "+metrics.openAtEnd+" |",
    "| LONG / SHORT | "+metrics.longs+" / "+metrics.shorts+" |",
    "| Win rate | "+metrics.winRatePct.toFixed(2)+"% |",
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

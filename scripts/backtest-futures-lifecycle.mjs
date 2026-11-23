// SHORT entry source breakdown is included in the final report.
import { mkdir, writeFile } from "node:fs/promises";
import { analyzeFuturesSymbol, FUTURES_CONFIG } from "../src/index.js";
import { evaluateTradeCandle, FUTURES_TRADE_LEVERAGE, FUTURES_MARGIN_PROFIT_TARGET_PERCENT } from "../src/futures-trade-lifecycle.js";

const BASE = "https://futures.kraken.com";
const INTERVALS = { "5m": 300000, "15m": 900000, "1h": 3600000, "4h": 14400000 };
const DAYS = Math.max(7, Math.min(365, Number(process.env.LIFECYCLE_BACKTEST_DAYS || 30)));
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

function historicalQuoteVolume(candles, index) {
  const start = Math.max(0, index - 23);
  let quoteVolume = 0;
  for (let i = start; i <= index; i++) {
    quoteVolume += Number(candles[i].volume) * Number(candles[i].close);
  }
  return quoteVolume;
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
function evaluateTp1Candle(trade, bar) {
  const entry = Number(trade.entry);
  const stop = Number(trade.initialStop);
  const target = Number(trade.target1);
  const side = trade.side;
  const open = Number(bar.open), high = Number(bar.high), low = Number(bar.low);
  const stopHit = side === "LONG" ? low <= stop : high >= stop;
  const tp1Hit = side === "LONG" ? high >= target : low <= target;
  if (!stopHit && !tp1Hit) return null;
  const stopAtOpen = side === "LONG" ? open <= stop : open >= stop;
  const tp1AtOpen = side === "LONG" ? open >= target : open <= target;
  const closeAtStop = stopAtOpen || (!tp1AtOpen && stopHit);
  const exitPrice = closeAtStop
    ? (stopAtOpen ? open : stop)
    : (tp1AtOpen ? open : target);
  const movePct = (side === "LONG" ? 1 : -1) * ((exitPrice-entry)/entry) * 100;
  return {
    status: closeAtStop ? "CLOSED_STOP" : "CLOSED_TP1",
    closeReason: closeAtStop ? "CLOSED_STOP" : "CLOSED_TP1",
    exitPrice,
    closePriceChangePercent: movePct,
    marginReturnPercent: movePct * LEVERAGE,
    closedAtMs: bar.time + INTERVALS["5m"],
    ambiguousCandles: trade.ambiguousCandles || 0
  };
}

function summarize(trades) {
  const closed = trades.filter(t => t.status === "CLOSED_TP1" || t.status === "CLOSED_STOP");
  const profits = closed.filter(t => t.status === "CLOSED_TP1");
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
      LONG: { trades: longs.length, profitCloses: longs.filter(t=>t.status==="CLOSED_TP1").length, stopCloses: longs.filter(t=>t.status==="CLOSED_STOP").length, marginReturnPct: sum(longs) },
      SHORT: { trades: shorts.length, profitCloses: shorts.filter(t=>t.status==="CLOSED_TP1").length, stopCloses: shorts.filter(t=>t.status==="CLOSED_STOP").length, marginReturnPct: sum(shorts) }
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

  const baselineTrades = [];
  const strategyTrades = { EMA20_1H: [], PREVIOUS_CANDLE_HIGH: [], MARKET_FALLBACK: [] };
  const strategyExpired = { EMA20_1H: 0, PREVIOUS_CANDLE_HIGH: 0, MARKET_FALLBACK: 0 };
  const strategyNotApplicable = { EMA20_1H: 0, PREVIOUS_CANDLE_HIGH: 0, MARKET_FALLBACK: 0 };
  const strategyInvalid = { EMA20_1H: 0, PREVIOUS_CANDLE_HIGH: 0, MARKET_FALLBACK: 0 };
  // One shared symbol+side lock schedule governs all four arms. Every accepted
  // signal is offered to baseline and each applicable independent entry arm.
  const pairedLockUntil = new Map();
  let fourIndex = 0, fifteenIndex = 0;
  let acceptedSignals = 0, skippedByLock = 0, rejectedSignals = 0, skippedNonShortSignals = 0;
  const testStart = toMs - DAYS * 86400000;

  function simulateTrade(trade, firstBarIndex) {
    let closed = false;
    for (let k=firstBarIndex; k<fiveMinute.length && fiveMinute[k].time<toMs; k++) {
      const bar=fiveMinute[k];
      const evaluated=evaluateTp1Candle(trade,bar);
      if (evaluated) { Object.assign(trade,evaluated); closed=true; break; }
    }
    if (!closed) {
      trade.status="OPEN_AT_BACKTEST_END";
      trade.lastMark=fiveMinute.at(-1)?.close ?? null;
      trade.marginReturnAtMarkPct=trade.lastMark
        ? -((trade.lastMark-Number(trade.entry))/Number(trade.entry))*100*LEVERAGE : null;
    }
    return trade;
  }

  for (let i=60; i<oneHour.length-1; i++) {
    const signalBar=oneHour[i];
    const signalCloseTime=signalBar.time+INTERVALS["1h"];
    if (signalCloseTime<testStart || signalCloseTime>=toMs) continue;
    while (fourIndex<fourHour.length && fourHour[fourIndex].time+INTERVALS["4h"]<=signalCloseTime) fourIndex++;
    while (fifteenIndex<fifteenMinute.length && fifteenMinute[fifteenIndex].time+INTERVALS["15m"]<=signalCloseTime) fifteenIndex++;
    const closed4h=fourHour.slice(0,fourIndex);
    const closed15m=fifteenMinute.slice(Math.max(0,fifteenIndex-120),fifteenIndex);
    if (closed4h.length<FUTURES_CONFIG.MIN_CANDLES || closed15m.length<40) continue;

    const nextBar=oneHour[i+1];
    const tickerAtSignal={
      symbol:ticker.symbol,last:nextBar.open,quoteVolume:historicalQuoteVolume(oneHour,i),
      priceChangePercent:historicalChange(oneHour,i),premium:{lastFundingRate:null}
    };
    let candidate;
    try { candidate=analyzeFuturesSymbol(tickerAtSignal,oneHour.slice(0,i+1),closed4h,closed15m); }
    catch { rejectedSignals++; continue; }
    if (!candidate || candidate.eligible!==true || !["LONG","SHORT"].includes(candidate.side)) { rejectedSignals++; continue; }
    if (candidate.side!=="SHORT") { skippedNonShortSignals++; continue; }

    const lockKey=ticker.symbol+"|SHORT";
    if ((pairedLockUntil.get(lockKey)||0)>signalCloseTime) { skippedByLock++; continue; }
    const firstOrderBar=lowerBound(fiveMinute,signalCloseTime);
    if (!fiveMinute[firstOrderBar] || fiveMinute[firstOrderBar].time>=toMs) continue;

    const ema=Number(candidate.ema20);
    const wick=Number(signalBar.high);
    const market=Number(tickerAtSignal.last);
    const levelsGapPct=Math.abs(ema-wick)/market*100;
    const fallbackApplicable=Number.isFinite(ema)&&Number.isFinite(wick)&&ema>0&&wick>0&&market>0&&market<ema&&market<wick&&levelsGapPct>0.5;

    const baselineEntry=Number(candidate.entry);
    const baselineStop=Number(candidate.stop);
    const baselineTarget=Number(candidate.target1);
    if (![baselineEntry,baselineStop,baselineTarget].every(Number.isFinite) || baselineEntry<=0) { rejectedSignals++; continue; }
    acceptedSignals++;

    const baseline=simulateTrade({
      id:ticker.symbol+":SHORT:BASELINE:"+signalCloseTime,
      symbol:ticker.symbol,side:"SHORT",status:"OPEN",entry:baselineEntry,
      initialStop:baselineStop,stop:baselineStop,target1:baselineTarget,
      signalTime:signalBar.time,signalCloseTime,entryTime:fiveMinute[firstOrderBar].time,
      score:candidate.score,ambiguousCandles:0,entryMethod:"MARKET_BASELINE",
      fallbackApplicable
    },firstOrderBar);
    baselineTrades.push(baseline);
    const methodSpecs=[
      {name:"EMA20_1H",price:ema,kind:"LIMIT"},
      {name:"PREVIOUS_CANDLE_HIGH",price:wick,kind:"LIMIT"},
      {name:"MARKET_FALLBACK",price:null,kind:"FALLBACK"}
    ];
    const armTrades=[];
    for (const spec of methodSpecs) {
      if (spec.kind==="FALLBACK" && !fallbackApplicable) {
        strategyNotApplicable[spec.name]++;
        continue;
      }
      if (spec.kind==="LIMIT" && (!Number.isFinite(spec.price)||spec.price<=0)) {
        strategyInvalid[spec.name]++;
        continue;
      }
      let fill=null;
      if (spec.kind==="FALLBACK") {
        fill={price:fiveMinute[firstOrderBar].open,time:fiveMinute[firstOrderBar].time,barIndex:firstOrderBar,fillType:"MARKET_FALLBACK"};
      } else {
        const expiry=signalCloseTime+INTERVALS["1h"];
        for (let j=firstOrderBar;j<fiveMinute.length&&fiveMinute[j].time<expiry&&fiveMinute[j].time<toMs;j++) {
          const bar=fiveMinute[j];
          if (bar.open>=spec.price) fill={price:bar.open,time:bar.time,barIndex:j,fillType:"MARKETABLE_LIMIT_AT_OPEN"};
          else if (bar.high>=spec.price) fill={price:spec.price,time:bar.time,barIndex:j,fillType:"LIMIT_TOUCH"};
          if (fill) break;
        }
        if (!fill) { strategyExpired[spec.name]++; continue; }
      }

      const swing=oneHour.slice(Math.max(0,i-6),i+1);
      const swingHigh=Math.max(...swing.map(c=>c.high));
      const atr=Number(candidate.atr);
      const stop=Math.max(swingHigh,fill.price+atr*1.5);
      const risk=stop-fill.price;
      const riskPct=risk/fill.price;
      if (!Number.isFinite(risk)||risk<=0||riskPct<0.002||riskPct>0.08) {
        strategyInvalid[spec.name]++;
        continue;
      }
      const trade={
        id:ticker.symbol+":SHORT:"+spec.name+":"+signalCloseTime,
        symbol:ticker.symbol,side:"SHORT",status:"OPEN",entry:fill.price,
        entryMethod:spec.name,selectedEntrySource:spec.name,
        limitPrice:spec.price,fillType:fill.fillType,fillTime:fill.time,
        initialStop:stop,stop,target1:fill.price-risk*1.5,
        signalTime:signalBar.time,signalCloseTime,entryTime:fill.time,
        score:candidate.score,ema20:ema,wickEntry:wick,atrMultiplier:1.5,tp1R:1.5,
        ambiguousCandles:0
      };
      simulateTrade(trade,fill.barIndex);
      strategyTrades[spec.name].push(trade);
      armTrades.push(trade);
    }

    const unlockTimes=[baseline,...armTrades].map(t=>t.status==="OPEN_AT_BACKTEST_END"?toMs:(t.closedAtMs||signalCloseTime));
    pairedLockUntil.set(lockKey,Math.max(...unlockTimes));
  }

  return {
    symbol:ticker.symbol,
    candles:{"1h":oneHour.length,"4h":fourHour.length,"15m":fifteenMinute.length,"5m":fiveMinute.length},
    signalsAccepted:acceptedSignals,skippedBySameSideLock:skippedByLock,
    rejectedSignals,skippedNonShortSignals,
    baselineTrades,strategyTrades,strategyExpired,strategyNotApplicable,strategyInvalid,
    metricsByMethod:Object.fromEntries(Object.entries(strategyTrades).map(([name,trades])=>[name,summarize(trades)])),
    baselineMetrics:summarize(baselineTrades)
  };
}

async function main() {
  const configuredEnd=process.env.LIFECYCLE_BACKTEST_END?Date.parse(process.env.LIFECYCLE_BACKTEST_END):Date.now();
  if (!Number.isFinite(configuredEnd)) throw new Error("Invalid LIFECYCLE_BACKTEST_END");
  const endMs=configuredEnd;
  const startMs=endMs-DAYS*86400000;
  const fromMs=startMs-WARMUP_DAYS*86400000;
  const tickerData=await getJson(BASE+"/derivatives/api/v3/tickers");
  if (!Array.isArray(tickerData?.tickers)) throw new Error("Kraken tickers response invalid");
  const universe=tickerData.tickers.filter(t=>t?.tag==="perpetual"&&t.suspended!==true&&
    /^(PI|PF)_[A-Z0-9]+USD$/.test(String(t.symbol||""))&&
    Number(t.volumeQuote)>=FUTURES_CONFIG.MIN_QUOTE_VOLUME&&Number(t.last)>0)
    .sort((a,b)=>Number(b.volumeQuote)-Number(a.volumeQuote)).slice(0,SYMBOL_LIMIT);
  if (!universe.length) throw new Error("No eligible Kraken perpetual contracts found");

  const results=[];
  for (const ticker of universe) {
    try { results.push(await backtestSymbol(ticker,fromMs,endMs)); }
    catch(error) { results.push({symbol:ticker.symbol,error:String(error?.message||error)}); }
  }
  const successful=results.filter(r=>!r.error);
  const methods=["BASELINE_MARKET","EMA20_1H","PREVIOUS_CANDLE_HIGH","MARKET_FALLBACK"];
  const tradesByMethod={
    BASELINE_MARKET:successful.flatMap(r=>r.baselineTrades||[]),
    EMA20_1H:successful.flatMap(r=>r.strategyTrades?.EMA20_1H||[]),
    PREVIOUS_CANDLE_HIGH:successful.flatMap(r=>r.strategyTrades?.PREVIOUS_CANDLE_HIGH||[]),
    MARKET_FALLBACK:successful.flatMap(r=>r.strategyTrades?.MARKET_FALLBACK||[])
  };
  const metricsByMethod=Object.fromEntries(methods.map(name=>[name,summarize(tradesByMethod[name])]));
  const signalOpportunities=successful.reduce((n,r)=>n+r.signalsAccepted,0);
  const expiredByMethod=Object.fromEntries(["EMA20_1H","PREVIOUS_CANDLE_HIGH","MARKET_FALLBACK"].map(name=>[name,successful.reduce((n,r)=>n+(r.strategyExpired?.[name]||0),0)]));
  const notApplicableByMethod=Object.fromEntries(["EMA20_1H","PREVIOUS_CANDLE_HIGH","MARKET_FALLBACK"].map(name=>[name,successful.reduce((n,r)=>n+(r.strategyNotApplicable?.[name]||0),0)]));
  const invalidByMethod=Object.fromEntries(["EMA20_1H","PREVIOUS_CANDLE_HIGH","MARKET_FALLBACK"].map(name=>[name,successful.reduce((n,r)=>n+(r.strategyInvalid?.[name]||0),0)]));
  const baselineTrades=tradesByMethod.BASELINE_MARKET;
  const baselineComparableByMethod={
    EMA20_1H:baselineTrades,
    PREVIOUS_CANDLE_HIGH:baselineTrades,
    MARKET_FALLBACK:baselineTrades.filter(t=>t.fallbackApplicable===true)
  };
  const baselineMetricsByMethod=Object.fromEntries(Object.entries(baselineComparableByMethod).map(([name,trades])=>[name,summarize(trades)]));
  const comparisons=Object.fromEntries(["EMA20_1H","PREVIOUS_CANDLE_HIGH","MARKET_FALLBACK"].map(name=>{
    const m=metricsByMethod[name],base=baselineMetricsByMethod[name];
    return [name,{
      signalsOffered:name==="MARKET_FALLBACK"?base.tradesStarted:signalOpportunities,
      filled:m.tradesStarted,expired:expiredByMethod[name],
      notApplicable:notApplicableByMethod[name],invalid:invalidByMethod[name],
      closed:m.closedTrades,tp1:m.profitCloses,stops:m.stopCloses,openAtEnd:m.openAtEnd,
      winRatePct:m.winRatePct,grossPnlUsd:m.totalMarginReturnPct/10,
      baselineComparableTrades:base.tradesStarted,
      baselineComparableClosed:base.closedTrades,
      baselineComparableWinRatePct:base.winRatePct,
      baselineGrossPnlUsd:base.totalMarginReturnPct/10,
      differenceVsBaselineUsd:(m.totalMarginReturnPct-base.totalMarginReturnPct)/10,
      fillTypes:tradesByMethod[name].reduce((a,t)=>{a[t.fillType]=(a[t.fillType]||0)+1;return a;},{})
    }];
  }));
  const report={
    generatedAt:new Date().toISOString(),venue:"Kraken Futures public historical OHLC candles",
    period:{from:new Date(startMs).toISOString(),to:new Date(endMs).toISOString(),days:DAYS,warmupDays:WARMUP_DAYS},
    rules:{
      sideScope:"SHORT only; LONG signals ignored",
      signalEngine:"unchanged analyzeFuturesSymbol; closed 1h/4h/15m candles",
      leverage:LEVERAGE,marginPerTradeUsd:10,
      atrMultiplierShort:1.5,tp1RShort:1.5,
      methods:{
        BASELINE_MARKET:"Current analyzer market entry at next 5m open; analyzer stop and TP1 retained",
        EMA20_1H:"Independent sell-limit at 1h EMA20; valid for one hour; if marketable at 5m open, fill at open; otherwise fill on high touch",
        PREVIOUS_CANDLE_HIGH:"Independent sell-limit at high of just-closed 1h signal candle; valid for one hour; if marketable at 5m open, fill at open; otherwise fill on high touch",
        MARKET_FALLBACK:"Only applicable when next market price is below both EMA20 and previous candle high and their gap exceeds 0.5%; market entry at next 5m open"
      },
      exits:"Each arm recalculates same SHORT structural/ATR 1.5x stop around its actual fill and TP1 at 1.5R; exit evaluated on 5m OHLC",
      lock:"One shared symbol+SHORT lock across baseline and all three independent entry arms; next signal accepted only after every filled arm from prior signal closes",
      capital:"Gross method comparison at fixed $10 margin per filled trade; methods are separate arms, not combined into one account",
      fees:"excluded",funding:"excluded",slippage:"excluded",
      ambiguity:"stop-first on same 5m candle unless candle open proves a level was reached first",
      universe:"top 10 current Kraken perpetuals by current quote volume; survivorship bias applies"
    },
    symbolsRequested:SYMBOL_LIMIT,symbolsTested:successful.length,
    symbolErrors:results.filter(r=>r.error),
    eligibleSignalOpportunities:signalOpportunities,
    metricsByMethod,baselineMetricsByMethod,comparisons,expiredByMethod,notApplicableByMethod,invalidByMethod,
    lockSkips:successful.reduce((n,r)=>n+r.skippedBySameSideLock,0),
    rejectedSignals:successful.reduce((n,r)=>n+r.rejectedSignals,0),
    skippedNonShortSignals:successful.reduce((n,r)=>n+r.skippedNonShortSignals,0),
    bySymbol:successful.map(r=>({
      symbol:r.symbol,signalsAccepted:r.signalsAccepted,
      baseline:r.baselineMetrics,methods:r.metricsByMethod,
      expired:r.strategyExpired,notApplicable:r.strategyNotApplicable,invalid:r.strategyInvalid
    })),
    tradesByMethod
  };
  await mkdir("artifacts",{recursive:true});
  await writeFile("artifacts/short-entry-methods-comparison.json",JSON.stringify(report,null,2));
  const rows=[
    "# Independent SHORT entry-method comparison","",
    "Period: "+report.period.from+" — "+report.period.to+" ("+DAYS+" days)",
    "Symbols tested: "+report.symbolsTested+"/"+SYMBOL_LIMIT,
    "Same accepted SHORT signals offered to all arms: "+signalOpportunities,"",
    "| Method | Fills | Expired | Not applicable | Closed | TP1 | Stops | Win rate | Gross PnL | vs market baseline |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ...methods.map(name=>{
      const m=metricsByMethod[name];
      const c=report.comparisons[name]||{};
      return "| "+name+" | "+m.tradesStarted+" | "+(expiredByMethod[name]||0)+" | "+(notApplicableByMethod[name]||0)+" | "+m.closedTrades+" | "+m.profitCloses+" | "+m.stopCloses+" | "+m.winRatePct.toFixed(2)+"% | $"+(m.totalMarginReturnPct/10).toFixed(2)+" | "+(name==="BASELINE_MARKET"?"—":("$"+c.differenceVsBaselineUsd.toFixed(2)))+" |";
    }),
    "","## Execution detail","",
    ...["EMA20_1H","PREVIOUS_CANDLE_HIGH","MARKET_FALLBACK"].flatMap(name=>{
      const c=report.comparisons[name];
      return ["### "+name,
        "- Signals offered: "+c.signalsOffered,
        "- Filled: "+c.filled+"; expired: "+c.expired+"; not applicable: "+c.notApplicable+"; invalid: "+c.invalid,
        "- Fill types: "+JSON.stringify(c.fillTypes),
        "- Gross PnL: $"+c.grossPnlUsd.toFixed(2)+"; baseline: $"+c.baselineGrossPnlUsd.toFixed(2)+"; difference: $"+c.differenceVsBaselineUsd.toFixed(2),
        ""];
    }),
    "## Methodology and limitations",
    "All arms receive the same accepted SHORT signal cohort and share one symbol+SHORT lock. The lock remains active until every filled arm from that signal has closed. EMA20 and previous-candle-high are tested as separate one-hour limit orders. MARKET_FALLBACK is conditional; its baseline comparator is restricted to the exact same fallback-triggered signal subset, not all accepted signals. Fixed $10 margin is used only to express gross PnL; the four methods are not combined into one account.",
    "Current signal analyzer is unchanged. SHORT ATR multiplier 1.5 and TP1 1.5R are retained. Actual Kraken historical OHLC is used. 5m bars cannot fully reveal intrabar path; ambiguous candles are stop-first. Fees, funding, slippage, and liquidation are excluded. Current-volume universe selection creates survivorship bias. Only successfully fetched symbols count.",
    "","Symbol errors:",...report.symbolErrors.map(x=>"- "+x.symbol+": "+x.error)
  ];
  await writeFile("artifacts/short-entry-methods-comparison.md",rows.join("\n"));
  console.log(JSON.stringify({
    ok:successful.length>0,period:report.period,eligibleSignalOpportunities:signalOpportunities,
    symbolsTested:successful.length,metricsByMethod,comparisons,expiredByMethod,
    notApplicableByMethod,invalidByMethod,symbolErrors:report.symbolErrors
  },null,2));
  if (!successful.length) process.exitCode=1;
}
main().catch(error=>{console.error(error);process.exitCode=1;});

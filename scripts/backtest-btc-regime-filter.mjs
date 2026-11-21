import { mkdir, writeFile } from "node:fs/promises";
import { analyzeFuturesSymbol, FUTURES_CONFIG } from "../src/index.js";
import { evaluateTradeCandle, FUTURES_TRADE_LEVERAGE, FUTURES_MARGIN_PROFIT_TARGET_PERCENT } from "../src/futures-trade-lifecycle.js";

const BASE = "https://futures.kraken.com";
const INTERVALS = { "5m": 300000, "15m": 900000, "1h": 3600000, "4h": 14400000 };
const PERIODS = [
  { name: "LONG_bull_2024_Q1", side: "LONG", start: "2024-02-01T00:00:00Z", end: "2024-04-01T00:00:00Z" },
  { name: "LONG_bull_2025_Q2", side: "LONG", start: "2025-04-01T00:00:00Z", end: "2025-05-31T00:00:00Z" },
  { name: "SHORT_bear_2024_Q3", side: "SHORT", start: "2024-07-01T00:00:00Z", end: "2024-08-30T00:00:00Z" },
  { name: "SHORT_bear_2025_Q1", side: "SHORT", start: "2025-01-15T00:00:00Z", end: "2025-03-16T00:00:00Z" }
];
const SYMBOL_LIMIT = Math.max(1, Math.min(12, Number(process.env.LIFECYCLE_BACKTEST_SYMBOLS || 10)));
const WARMUP_DAYS = 15;
const TARGET = 30;
const FEE_PER_SIDE = 0.0005;
const SLIPPAGE_PER_SIDE = 0.0003;
const LEVERAGE = 10;
const STARTING_CAPITAL_USD = 100;
const MARGIN_PER_TRADE_USD = 10;
// Keep each policy isolated so the historical comparison never mutates production behavior.
const VARIANTS = ["baseline", "btc_1h", "btc_1h_4h"];

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
  const old=candles[index-24],now=candles[index];
  return !old||old.close<=0?0:((now.close/old.close)-1)*100;
}
function ema(values, period) {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let value = values.slice(0,period).reduce((a,b)=>a+b,0) / period;
  for (let i=period;i<values.length;i++) value = values[i]*k + value*(1-k);
  return value;
}
function trend1h(candles, at) {
  const closed = candles.filter(c => c.time + INTERVALS["1h"] <= at);
  if (closed.length < 50) return "NEUTRAL";
  const closes = closed.map(c=>c.close), e20=ema(closes,20), e50=ema(closes,50), last=closes.at(-1);
  if (e20>e50 && last>e20) return "BULLISH";
  if (e20<e50 && last<e20) return "BEARISH";
  return "NEUTRAL";
}
function trend4h(candles, at) {
  const closed = candles.filter(c => c.time + INTERVALS["4h"] <= at);
  if (closed.length < 50) return "NEUTRAL";
  const closes = closed.map(c=>c.close), e20=ema(closes,20), e50=ema(closes,50);
  if (e20>e50) return "BULLISH";
  if (e20<e50) return "BEARISH";
  return "NEUTRAL";
}
function btcRegime(btc1h, btc4h, at, variant) {
  if (variant === "baseline") return "BYPASS";
  const one = trend1h(btc1h,at);
  if (variant === "btc_1h") return one;
  const four = trend4h(btc4h,at);
  return one === four && one !== "NEUTRAL" ? one : "NEUTRAL";
}
function blockedByBtc(side, regime) {
  return (side === "LONG" && regime === "BEARISH") || (side === "SHORT" && regime === "BULLISH");
}
function lowerBound(candles, time) {
  let lo=0,hi=candles.length;
  while(lo<hi){const mid=(lo+hi)>>1;if(candles[mid].time<time)lo=mid+1;else hi=mid;}
  return lo;
}
function candleAmbiguous(side, trade, candle) {
  const entry=Number(trade.entry),stop=Number(trade.currentStop??trade.initialStop??trade.stop);
  const target=side==="LONG"?entry*(1+TARGET/LEVERAGE/100):entry*(1-TARGET/LEVERAGE/100);
  const stopHit=side==="LONG"?candle.low<=stop:candle.high>=stop;
  const profitHit=side==="LONG"?candle.high>=target:candle.low<=target;
  const stopAtOpen=side==="LONG"?candle.open<=stop:candle.open>=stop;
  const profitAtOpen=side==="LONG"?candle.open>=target:candle.open<=target;
  return stopHit&&profitHit&&!stopAtOpen&&!profitAtOpen;
}
function summarize(trades) {
  const closed=trades.filter(t=>t.status==="CLOSED_PROFIT"||t.status==="CLOSED_STOP");
  const wins=closed.filter(t=>t.status==="CLOSED_PROFIT"),stops=closed.filter(t=>t.status==="CLOSED_STOP");
  let equity=0,peak=0,maxDrawdown=0;
  for(const t of [...closed].sort((a,b)=>a.closedAtMs-b.closedAtMs)){
    equity+=Number(t.marginReturnPercent||0);peak=Math.max(peak,equity);maxDrawdown=Math.max(maxDrawdown,peak-equity);
  }
  const sum=xs=>xs.reduce((n,t)=>n+Number(t.marginReturnPercent||0),0);
  return {
    tradesStarted:trades.length,closedTrades:closed.length,profitCloses:wins.length,stopCloses:stops.length,
    openAtEnd:trades.length-closed.length,winRatePct:closed.length?wins.length/closed.length*100:0,
    totalMarginReturnPct:sum(closed),averageMarginReturnPct:closed.length?sum(closed)/closed.length:0,
    maxDrawdownMarginPct:maxDrawdown,ambiguous5mCandles:trades.reduce((n,t)=>n+(t.ambiguousCandles||0),0)
  };
}
function simulateTrade(ticker, candidate, signalBar, signalCloseTime, fiveMinute, toMs) {
  const entry=Number(candidate.entry)*(candidate.side==="LONG"?1+SLIPPAGE_PER_SIDE:1-SLIPPAGE_PER_SIDE);
  const trade={
    id:ticker.symbol+":"+candidate.side+":"+signalCloseTime,symbol:ticker.symbol,side:candidate.side,status:"OPEN",
    entry,actualEntry:entry,initialStop:Number(candidate.stop),stop:Number(candidate.stop),
    signalTime:signalBar.time,entryTime:signalCloseTime,score:candidate.score,ambiguousCandles:0
  };
  let closed=false;
  for(let i=lowerBound(fiveMinute,signalCloseTime);i<fiveMinute.length&&fiveMinute[i].time<toMs;i++){
    const bar=fiveMinute[i];
    if(candleAmbiguous(candidate.side,trade,bar))trade.ambiguousCandles++;
    const evaluated=evaluateTradeCandle(trade,{...bar,time:bar.time+INTERVALS["5m"]},{leverage:LEVERAGE,targetMarginPercent:TARGET});
    if(evaluated.changed){
      Object.assign(trade,evaluated.trade);
      const exitFill=Number(trade.exitPrice)*(candidate.side==="LONG"?1-SLIPPAGE_PER_SIDE:1+SLIPPAGE_PER_SIDE);
      const netMovePct=((exitFill-entry)/entry)*100*(candidate.side==="LONG"?1:-1);
      trade.exitFill=exitFill;
      trade.marginReturnPercent=Math.max(-100,netMovePct*LEVERAGE-(FEE_PER_SIDE*2*100*LEVERAGE));
      trade.closedAtMs=bar.time+INTERVALS["5m"];
      closed=true;break;
    }
  }
  if(!closed){
    trade.status="OPEN_AT_BACKTEST_END";
    trade.lastMark=fiveMinute.at(-1)?.close??null;
    if(trade.lastMark){const markFill=trade.lastMark*(candidate.side==="LONG"?1-SLIPPAGE_PER_SIDE:1+SLIPPAGE_PER_SIDE);const markMove=((markFill-entry)/entry)*100*(candidate.side==="LONG"?1:-1);trade.marginReturnAtMarkPct=Math.max(-100,markMove*LEVERAGE-(FEE_PER_SIDE*2*100*LEVERAGE));}else trade.marginReturnAtMarkPct=null;
  }
  return trade;
}

function portfolioSummary(allTrades, periodEndMs) {
  const ordered=[...allTrades].sort((a,b)=>a.entryTime-b.entryTime||a.symbol.localeCompare(b.symbol));
  let cash=STARTING_CAPITAL_USD;
  const active=[];
  const accepted=[];
  let skippedInsufficientCapital=0;
  const release=(position, markToMarket=false)=>{
    const pct=markToMarket?Number(position.marginReturnAtMarkPct||0):Number(position.marginReturnPercent||0);
    const pnl=Math.max(-MARGIN_PER_TRADE_USD,MARGIN_PER_TRADE_USD*pct/100);
    cash+=MARGIN_PER_TRADE_USD+pnl;
    position.portfolioPnlUsd=pnl;
    position.portfolioReturnPct=pct;
    position.portfolioMarkedAtEnd=markToMarket;
  };
  for(const trade of ordered){
    for(let i=active.length-1;i>=0;i--){
      if(active[i].closedAtMs!==null&&active[i].closedAtMs<=trade.entryTime){
        release(active[i]);active.splice(i,1);
      }
    }
    if(cash+1e-9<MARGIN_PER_TRADE_USD){skippedInsufficientCapital++;continue;}
    cash-=MARGIN_PER_TRADE_USD;
    accepted.push(trade);
    active.push(trade);
  }
  for(const position of active){
    if(position.status==="OPEN_AT_BACKTEST_END") release(position,true);
    else release(position);
  }
  const wins=accepted.filter(t=>t.status==="CLOSED_PROFIT");
  const stops=accepted.filter(t=>t.status==="CLOSED_STOP");
  const open=accepted.filter(t=>t.status==="OPEN_AT_BACKTEST_END");
  const winnerProfitUsd=wins.reduce((s,t)=>s+Math.max(0,Number(t.portfolioPnlUsd||0)),0);
  const stopLossUsd=stops.reduce((s,t)=>s+Math.abs(Math.min(0,Number(t.portfolioPnlUsd||0))),0);
  const netProfitUsd=cash-STARTING_CAPITAL_USD;
  return {
    startingCapitalUsd:STARTING_CAPITAL_USD,marginPerTradeUsd:MARGIN_PER_TRADE_USD,
    leverage:LEVERAGE,targetMarginProfitPct:TARGET,targetGrossProfitUsd:MARGIN_PER_TRADE_USD*TARGET/100,
    tradesTaken:accepted.length,tpTrades:wins.length,stopTrades:stops.length,openAtEnd:open.length,
    skippedInsufficientCapital,winningTradesProfitUsd:winnerProfitUsd,stoppedTradesLossUsd:stopLossUsd,
    netProfitUsd,finalAccountUsd:cash,accountGrowthPct:netProfitUsd/STARTING_CAPITAL_USD*100,
    accountGrew:cash>STARTING_CAPITAL_USD,ambiguous5mCandles:accepted.reduce((n,t)=>n+(t.ambiguousCandles||0),0),
    liquidationLossCap:"Each isolated $20 margin loss is capped at $20 (100% of allocated margin); exact Kraken liquidation price/maintenance tiers are not modeled."
  };
}

async function backtestSymbol(ticker, period, fromMs, toMs, btc1h, btc4h) {
  const [oneHour,fourHour,fifteenMinute,fiveMinute]=await Promise.all([
    fetchHistoricalCandles(ticker.symbol,"1h",fromMs,toMs),
    fetchHistoricalCandles(ticker.symbol,"4h",fromMs,toMs),
    fetchHistoricalCandles(ticker.symbol,"15m",fromMs,toMs),
    fetchHistoricalCandles(ticker.symbol,"5m",fromMs,toMs)
  ]);
  if(oneHour.length<100||fourHour.length<FUTURES_CONFIG.MIN_CANDLES||fifteenMinute.length<120||fiveMinute.length<1000)
    throw new Error("insufficient candles (1h="+oneHour.length+", 4h="+fourHour.length+", 15m="+fifteenMinute.length+", 5m="+fiveMinute.length+")");
  const state=Object.fromEntries(VARIANTS.map(v=>[v,{trades:[],locks:new Map(),blocked:0,lockSkips:0,eligible:0}]));
  let fourIndex=0,fifteenIndex=0;
  for(let i=60;i<oneHour.length-1;i++){
    const signalBar=oneHour[i],signalCloseTime=signalBar.time+INTERVALS["1h"];
    if(signalCloseTime<period.startMs||signalCloseTime>=toMs)continue;
    while(fourIndex<fourHour.length&&fourHour[fourIndex].time+INTERVALS["4h"]<=signalCloseTime)fourIndex++;
    while(fifteenIndex<fifteenMinute.length&&fifteenMinute[fifteenIndex].time+INTERVALS["15m"]<=signalCloseTime)fifteenIndex++;
    const closed4h=fourHour.slice(0,fourIndex);
    const closed15m=fifteenMinute.slice(Math.max(0,fifteenIndex-120),fifteenIndex);
    if(closed4h.length<FUTURES_CONFIG.MIN_CANDLES||closed15m.length<40)continue;
    const nextBar=oneHour[i+1];
    const tickerAtSignal={symbol:ticker.symbol,last:nextBar.open,quoteVolume:Number(ticker.volumeQuote)||0,
      priceChangePercent:historicalChange(oneHour,i),premium:{lastFundingRate:null}};
    let candidate;
    try{candidate=analyzeFuturesSymbol(tickerAtSignal,oneHour.slice(0,i+1),closed4h,closed15m);}
    catch{continue;}
    if(candidate?.eligible!==true||candidate.side!==period.side)continue;
    for(const variant of VARIANTS){
      const bucket=state[variant];bucket.eligible++;
      const regime=btcRegime(btc1h,btc4h,signalCloseTime,variant);
      if(variant!=="baseline"&&blockedByBtc(period.side,regime)){bucket.blocked++;continue;}
      const lockKey=ticker.symbol+"|"+candidate.side;
      if((bucket.locks.get(lockKey)||0)>signalCloseTime){bucket.lockSkips++;continue;}
      const trade=simulateTrade(ticker,candidate,signalBar,signalCloseTime,fiveMinute,toMs);
      bucket.trades.push(trade);
      bucket.locks.set(lockKey,trade.closedAtMs||toMs);
    }
  }
  const periodCandles=oneHour.filter(c=>c.time>=period.startMs&&c.time<toMs);
  const marketChangePct=periodCandles.length>=2?((periodCandles.at(-1).close/periodCandles[0].close)-1)*100:null;
  return {symbol:ticker.symbol,marketChangePct,state:Object.fromEntries(VARIANTS.map(v=>{
    const x=state[v];return [v,{metrics:summarize(x.trades),blockedByBtc:x.blocked,skippedByLock:x.lockSkips,eligibleCandidates:x.eligible,trades:x.trades}];
  }))};
}

async function main(){
  const tickerData=await getJson(BASE+"/derivatives/api/v3/tickers");
  if(!Array.isArray(tickerData?.tickers))throw new Error("Kraken tickers response invalid");
  const universe=tickerData.tickers.filter(t=>t?.tag==="perpetual"&&t.suspended!==true&&
    /^(PI|PF)_[A-Z0-9]+USD$/.test(String(t.symbol||""))&&Number(t.volumeQuote)>=FUTURES_CONFIG.MIN_QUOTE_VOLUME&&Number(t.last)>0)
    .sort((a,b)=>Number(b.volumeQuote)-Number(a.volumeQuote)).slice(0,SYMBOL_LIMIT);
  if(!universe.length)throw new Error("No eligible Kraken perpetual contracts found");
  const periodReports=[];
  for(const period of PERIODS){
    period.startMs=Date.parse(period.start);const endMs=Date.parse(period.end),fromMs=period.startMs-WARMUP_DAYS*86400000;
    const [btc1h,btc4h]=await Promise.all([
      fetchHistoricalCandles("PF_XBTUSD","1h",fromMs,endMs),
      fetchHistoricalCandles("PF_XBTUSD","4h",fromMs,endMs)
    ]);
    const results=[];
    for(const ticker of universe){
      try{results.push(await backtestSymbol(ticker,period,fromMs,endMs,btc1h,btc4h));}
      catch(error){results.push({symbol:ticker.symbol,error:String(error?.message||error)});}
    }
    const successful=results.filter(r=>!r.error);
    const variants=Object.fromEntries(VARIANTS.map(v=>{
      const trades=successful.flatMap(r=>r.state[v].trades).sort((a,b)=>a.entryTime-b.entryTime);
      return [v,{
        metrics:portfolioSummary(trades,endMs),
        btcBlocked:successful.reduce((n,r)=>n+r.state[v].blockedByBtc,0),
        sameSideLockSkips:successful.reduce((n,r)=>n+r.state[v].skippedByLock,0),
        eligibleCandidates:successful.reduce((n,r)=>n+r.state[v].eligibleCandidates,0),
        bySymbol:successful.map(r=>({symbol:r.symbol,marketChangePct:r.marketChangePct,metrics:r.state[v].metrics,btcBlocked:r.state[v].blockedByBtc}))
      }];
    }));
    periodReports.push({
      name:period.name,side:period.side,from:period.start,to:period.end,days:(endMs-period.startMs)/86400000,
      btcMarketChangePct:(()=>{const cs=btc1h.filter(c=>c.time>=period.startMs&&c.time<endMs);return cs.length>=2?(cs.at(-1).close/cs[0].close-1)*100:null;})(),
      btcCandles:{"1h":btc1h.length,"4h":btc4h.length},symbolsTested:successful.length,symbolErrors:results.filter(r=>r.error),variants
    });
  }
  const report={
    generatedAt:new Date().toISOString(),venue:"Kraken Futures public historical OHLC candles",
    strategy:"current production strategy evaluated offline; no production source changed",
    variants:{
      baseline:"No BTC filter",
      btc_1h:"Block LONG when closed BTC 1h regime is BEARISH; block SHORT when BULLISH; NEUTRAL passes",
      btc_1h_4h:"Same directional block, but BTC regime is directional only when closed 1h and 4h regimes agree; otherwise NEUTRAL passes"
    },
    rules:{startingCapitalUsd:STARTING_CAPITAL_USD,marginPerTradeUsd:MARGIN_PER_TRADE_USD,leverage:LEVERAGE,targetMarginProfitPct:TARGET,feePerSidePct:FEE_PER_SIDE*100,slippagePerSidePct:SLIPPAGE_PER_SIDE*100,
      entry:"signal on completed 1h/4h/15m candles; enter at next 1h open",exit:"5m OHLC lifecycle; stop-first on ambiguous candles",
      funding:"excluded",universe:"top current Kraken perpetuals by current quote volume; survivorship bias applies"},
    symbolsRequested:SYMBOL_LIMIT,periods:periodReports
  };
  await mkdir("artifacts",{recursive:true});
  await writeFile("artifacts/btc-regime-backtest.json",JSON.stringify(report,null,2));
  const rows=["# BTC regime filter comparison — fixed-capital account simulation","",
    "Production code was not changed. Each period is simulated with $100 initial capital and fixed $10 margin per trade at 10x leverage; periods are evaluated independently.","",
    "| Period | Side | BTC change | Symbols | Variant | Eligible | BTC blocked | Trades | TP | Stops | Skipped (capital) | Winner profit $ | Stop loss $ | Net P/L $ | Final $ | Growth |",
    "|---|---|---:|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|"];
  for(const p of periodReports)for(const v of VARIANTS){
    const x=p.variants[v],m=x.metrics;
    rows.push("| "+p.name+" | "+p.side+" | "+(p.btcMarketChangePct??0).toFixed(2)+"% | "+p.symbolsTested+" | "+v+" | "+x.eligibleCandidates+" | "+x.btcBlocked+" | "+m.tradesTaken+" | "+m.tpTrades+" | "+m.stopTrades+" | "+m.skippedInsufficientCapital+" | $"+m.winningTradesProfitUsd.toFixed(2)+" | $"+m.stoppedTradesLossUsd.toFixed(2)+" | $"+m.netProfitUsd.toFixed(2)+" | $"+m.finalAccountUsd.toFixed(2)+" | "+m.accountGrowthPct.toFixed(2)+"% |");
  }
  rows.push("","BTC 1h regime: EMA20/EMA50 alignment plus close relative to EMA20. BTC 4h regime: EMA20/EMA50 alignment. The multi-timeframe variant only declares BULLISH/BEARISH when 1h and 4h agree; all other cases are NEUTRAL and pass through.",
    "Portfolio: $100 initial capital, fixed $20 isolated margin per trade, 25x leverage, 17% gross margin TP ($3.40 gross per winner). Trades are accepted chronologically only when $20 free cash is available. Stop losses are capped at 100% of that trade margin; exact liquidation tiers are not modeled.",
    "Limitations: current top-volume universe creates survivorship/listing bias; funding and liquidation are excluded; 5m OHLC cannot identify intrabar path; ambiguous candles use stop-first; results are historical and not a guarantee.");
  await writeFile("artifacts/btc-regime-backtest.md",rows.join("\n"));
  console.log(JSON.stringify({ok:periodReports.every(p=>p.symbolsTested>0),periods:periodReports.map(p=>({name:p.name,side:p.side,btcMarketChangePct:p.btcMarketChangePct,symbolsTested:p.symbolsTested,variants:Object.fromEntries(VARIANTS.map(v=>[v,p.variants[v].metrics]))})),errors:periodReports.map(p=>p.symbolErrors)},null,2));
  if(periodReports.some(p=>p.symbolsTested===0))process.exitCode=1;
}
main().catch(error=>{console.error(error);process.exitCode=1;});

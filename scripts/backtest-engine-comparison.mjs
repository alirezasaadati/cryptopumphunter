import { mkdir, writeFile } from "node:fs/promises";
import { analyzeFuturesSymbol as analyzeCurrent, FUTURES_CONFIG as CURRENT_CONFIG } from "../src/index-current.js";
import { analyzeFuturesSymbol as analyzeV48, computeBtcRegime, FUTURES_CONFIG as V48_CONFIG } from "../src/index.js";
import { evaluateTradeCandle } from "../src/futures-trade-lifecycle.js";

const BASE = "https://futures.kraken.com";
const INTERVALS = { "5m": 300000, "15m": 900000, "1h": 3600000, "4h": 14400000 };
const DAYS = Number(process.env.LIFECYCLE_BACKTEST_DAYS || 60), WARMUP_DAYS = 15, SYMBOL_LIMIT = 10, MARGIN_USD = 10, LEVERAGE = 10, TARGET_MARGIN_PERCENT = 15;
const TAKER_FEE_RATE = Number(process.env.BACKTEST_TAKER_FEE_RATE || 0.0005);
const SLIPPAGE_RATE = Number(process.env.BACKTEST_SLIPPAGE_RATE || 0.0002);
const ROUND_TRIP_COST_USD = MARGIN_USD * LEVERAGE * 2 * (TAKER_FEE_RATE + SLIPPAGE_RATE);

async function getJson(url, attempt = 0) {
  const response = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(30000) });
  const body = await response.text();
  if (!response.ok) {
    if (attempt < 3 && (response.status === 429 || response.status >= 500)) {
      await new Promise(resolve => setTimeout(resolve, 800 * (attempt + 1)));
      return getJson(url, attempt + 1);
    }
    throw new Error("HTTP " + response.status + " for " + url + ": " + body.slice(0, 180));
  }
  const data = JSON.parse(body);
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
  })).filter(c => Number.isFinite(c.time) &&
    [c.open,c.high,c.low,c.close,c.volume].every(Number.isFinite) &&
    c.open > 0 && c.close > 0 && c.low > 0 && c.high >= c.low && c.volume >= 0 &&
    c.time + intervalMs <= Date.now()
  ).sort((a,b)=>a.time-b.time).filter(c => {
    if (seen.has(c.time)) return false;
    seen.add(c.time); return true;
  });
}

async function fetchCandles(symbol, resolution, fromMs, toMs) {
  const intervalMs = INTERVALS[resolution], chunkMs = intervalMs * 1700, combined = [];
  for (let start = fromMs; start < toMs; start += chunkMs) {
    const end = Math.min(toMs, start + chunkMs);
    const url = new URL(BASE + "/api/charts/v1/trade/" + encodeURIComponent(symbol) + "/" + resolution);
    url.searchParams.set("from", String(Math.floor(start / 1000)));
    url.searchParams.set("to", String(Math.floor(end / 1000)));
    url.searchParams.set("count", "1800");
    const data = await getJson(url);
    if (data.more_candles === true) throw new Error(symbol + " " + resolution + ": incomplete candle chunk");
    combined.push(...normalizeCandles(data.candles, intervalMs));
  }
  return [...new Map(combined.map(c => [c.time,c])).values()].sort((a,b)=>a.time-b.time);
}

function lowerBound(candles, time) {
  let lo=0, hi=candles.length;
  while(lo<hi){const mid=(lo+hi)>>1;if(candles[mid].time<time)lo=mid+1;else hi=mid;}
  return lo;
}
function historicalMetrics(oneHour, index) {
  const from = Math.max(0,index-23);
  const slice = oneHour.slice(from,index+1);
  const old = oneHour[Math.max(0,index-24)];
  const change = !old || old.close<=0 ? 0 : (oneHour[index].close/old.close-1)*100;
  const quoteVolume = slice.reduce((sum,c)=>sum+c.volume*c.close,0);
  return { change, quoteVolume };
}
function blankStats() {
  return { opened:0, closed:0, wins:0, stops:0, openAtEnd:0, longs:0, shorts:0,
    winRatePct:0, netPnlUsd:0, grossWinsUsd:0, grossLossUsd:0, profitFactor:0,
    avgMarginReturnPct:0, maxDrawdownUsd:0, eligibleCandidates:0, rejected:0, lockSkips:0 };
}
function summarize(trades, counters) {
  const closed=trades.filter(t=>t.status==="CLOSED_PROFIT"||t.status==="CLOSED_STOP");
  const wins=closed.filter(t=>t.status==="CLOSED_PROFIT"), stops=closed.filter(t=>t.status==="CLOSED_STOP");
  const grossPnl=t=>MARGIN_USD*Number(t.marginReturnPercent||0)/100;
  const pnl=t=>grossPnl(t)-ROUND_TRIP_COST_USD;
  const netTradePnls=closed.map(pnl);
  const grossWins=netTradePnls.filter(x=>x>0).reduce((s,x)=>s+x,0), grossLoss=Math.abs(netTradePnls.filter(x=>x<0).reduce((s,x)=>s+x,0));
  let equity=0, peak=0, maxDD=0;
  for(const t of [...closed].sort((a,b)=>(a.closedAtMs||0)-(b.closedAtMs||0))){equity+=pnl(t);peak=Math.max(peak,equity);maxDD=Math.max(maxDD,peak-equity);}
  const sideStats=side=>{
    const rows=trades.filter(t=>t.side===side), done=rows.filter(t=>t.status==="CLOSED_PROFIT"||t.status==="CLOSED_STOP");
    return {opened:rows.length,closed:done.length,wins:done.filter(t=>t.status==="CLOSED_PROFIT").length,
      stops:done.filter(t=>t.status==="CLOSED_STOP").length,open:rows.length-done.length,
      winRatePct:done.length?done.filter(t=>t.status==="CLOSED_PROFIT").length/done.length*100:0,
      netPnlUsd:done.reduce((s,t)=>s+pnl(t),0)};
  };
  return { ...blankStats(), opened:trades.length, closed:closed.length, wins:wins.length, stops:stops.length,
    openAtEnd:trades.length-closed.length, longs:trades.filter(t=>t.side==="LONG").length,
    shorts:trades.filter(t=>t.side==="SHORT").length, winRatePct:closed.length?wins.length/closed.length*100:0,
    netPnlUsd:closed.reduce((s,t)=>s+pnl(t),0), grossWinsUsd:grossWins, grossLossUsd:grossLoss,
    profitFactor:grossLoss?grossWins/grossLoss:(grossWins?Infinity:0),
    avgMarginReturnPct:closed.length?closed.reduce((s,t)=>s+Number(t.marginReturnPercent||0),0)/closed.length:0,
    maxDrawdownUsd:maxDD, eligibleCandidates:counters.eligible, rejected:counters.rejected, lockSkips:counters.lockSkips,
    bySide:{LONG:sideStats("LONG"),SHORT:sideStats("SHORT")} };
}

async function runEngine(engine, ticker, data, btc4h, testStart, endMs) {
  const {oneHour,fourHour,fifteenMinute,fiveMinute}=data;
  const trades=[], lockUntil=new Map(), counters={eligible:0,rejected:0,lockSkips:0};
  let fourIndex=0,fifteenIndex=0,btcIndex=0;
  for(let i=60;i<oneHour.length-1;i++){
    const bar=oneHour[i], closeTime=bar.time+INTERVALS["1h"];
    if(closeTime<testStart||closeTime>=endMs)continue;
    while(fourIndex<fourHour.length&&fourHour[fourIndex].time+INTERVALS["4h"]<=closeTime)fourIndex++;
    while(fifteenIndex<fifteenMinute.length&&fifteenMinute[fifteenIndex].time+INTERVALS["15m"]<=closeTime)fifteenIndex++;
    while(btcIndex<btc4h.length&&btc4h[btcIndex].time+INTERVALS["4h"]<=closeTime)btcIndex++;
    const closed4h=fourHour.slice(0,fourIndex),closed15m=fifteenMinute.slice(Math.max(0,fifteenIndex-120),fifteenIndex);
    if(closed4h.length<engine.config.MIN_CANDLES||closed15m.length<40)continue;
    const next=oneHour[i+1],hist=historicalMetrics(oneHour,i);
    const tickerAtSignal={symbol:ticker.symbol,last:next.open,quoteVolume:hist.quoteVolume,priceChangePercent:hist.change,premium:{lastFundingRate:null}};
    let candidate;
    try {
      candidate=engine.analyze(tickerAtSignal,oneHour.slice(0,i+1),closed4h,closed15m,
        engine.useBtcGate?{btcRegime:computeBtcRegime(btc4h.slice(Math.max(0,btcIndex-120),btcIndex))}:{});
    } catch { counters.rejected++; continue; }
    if(!candidate||candidate.eligible!==true||!["LONG","SHORT"].includes(candidate.side)){counters.rejected++;continue;}
    counters.eligible++;
    const lockKey=ticker.symbol+"|"+candidate.side;
    if((lockUntil.get(lockKey)||0)>closeTime){counters.lockSkips++;continue;}
    const entry=Number(candidate.entry),stop=Number(candidate.stop);
    const trade={id:engine.name+":"+ticker.symbol+":"+candidate.side+":"+closeTime,symbol:ticker.symbol,side:candidate.side,
      status:"OPEN",entry,actualEntry:entry,initialStop:stop,stop,currentStop:stop,
      signalTime:bar.time,entryTime:closeTime,score:candidate.score,riskLevel:candidate.riskLevel||"STANDARD"};
    let j=lowerBound(fiveMinute,closeTime),done=false;
    for(;j<fiveMinute.length&&fiveMinute[j].time<endMs;j++){
      const candle=fiveMinute[j];
      const result=evaluateTradeCandle(trade,{...candle,time:candle.time+INTERVALS["5m"]},
        {leverage:LEVERAGE,targetMarginPercent:TARGET_MARGIN_PERCENT});
      if(result.changed)Object.assign(trade,result.trade);
      if(trade.status==="CLOSED_PROFIT"||trade.status==="CLOSED_STOP"){
        trade.closedAtMs=candle.time+INTERVALS["5m"];done=true;break;
      }
    }
    if(!done){trade.status="OPEN_AT_BACKTEST_END";trade.lastMark=fiveMinute.at(-1)?.close??null;lockUntil.set(lockKey,endMs);}
    else lockUntil.set(lockKey,trade.closedAtMs);
    trades.push(trade);
  }
  return {trades,counters,metrics:summarize(trades,counters)};
}

async function main(){
  const configuredEnd=process.env.LIFECYCLE_BACKTEST_END ? Date.parse(process.env.LIFECYCLE_BACKTEST_END) : Date.now();
  if(!Number.isFinite(configuredEnd)) throw new Error("Invalid LIFECYCLE_BACKTEST_END");
  const endMs=configuredEnd,testStart=endMs-DAYS*86400000,fromMs=testStart-WARMUP_DAYS*86400000;
  const tickers=(await getJson(BASE+"/derivatives/api/v3/tickers")).tickers;
  if(!Array.isArray(tickers))throw new Error("Kraken tickers response invalid");
  const excluded=new Set(["XAU","NVDAX","EUR","GBP","JPY","AUD","CAD","CHF","SPX","NDX","US500","US100"]);
  const universe=tickers.filter(t=>t?.tag==="perpetual"&&t.suspended!==true&&/^(PI|PF)_[A-Z0-9]+USD$/.test(String(t.symbol||""))&&
    Number(t.volumeQuote)>=Math.max(CURRENT_CONFIG.HIGH_RISK_MIN_QUOTE_VOLUME,V48_CONFIG.HIGH_RISK_MIN_QUOTE_VOLUME)&&Number(t.last)>0&&
    !excluded.has(String(t.symbol).toUpperCase().replace(/^(PI|PF)_/,"").replace(/USD$/,"")))
    .sort((a,b)=>Number(b.volumeQuote)-Number(a.volumeQuote)).slice(0,SYMBOL_LIMIT);
  if(!universe.length)throw new Error("No eligible crypto perpetuals");
  const btc4h=await fetchCandles(V48_CONFIG.BTC_SYMBOL,"4h",fromMs,endMs);
  const currentTrades=[],v48Trades=[],perSymbol=[],errors=[];
  const currentCounters={eligible:0,rejected:0,lockSkips:0},v48Counters={eligible:0,rejected:0,lockSkips:0};
  for(const ticker of universe){
    try{
      const [oneHour,fourHour,fifteenMinute,fiveMinute]=await Promise.all([
        fetchCandles(ticker.symbol,"1h",fromMs,endMs),fetchCandles(ticker.symbol,"4h",fromMs,endMs),
        fetchCandles(ticker.symbol,"15m",fromMs,endMs),fetchCandles(ticker.symbol,"5m",fromMs,endMs)]);
      if(oneHour.length<100||fourHour.length<60||fifteenMinute.length<120||fiveMinute.length<1000)throw new Error("insufficient candles");
      const data={oneHour,fourHour,fifteenMinute,fiveMinute};
      const [cur,v48]=await Promise.all([
        runEngine({name:"CURRENT_11_2_0",analyze:analyzeCurrent,config:CURRENT_CONFIG,useBtcGate:false},ticker,data,btc4h,testStart,endMs),
        runEngine({name:"V48_EXPERIMENTAL",analyze:analyzeV48,config:V48_CONFIG,useBtcGate:true},ticker,data,btc4h,testStart,endMs)]);
      currentTrades.push(...cur.trades);v48Trades.push(...v48.trades);
      for(const k of ["eligible","rejected","lockSkips"]){currentCounters[k]+=cur.counters[k];v48Counters[k]+=v48.counters[k];}
      perSymbol.push({symbol:ticker.symbol,current:cur.metrics,v48:v48.metrics,currentCounters:cur.counters,v48Counters:v48.counters});
    }catch(error){errors.push({symbol:ticker.symbol,error:String(error?.message||error)});}
  }
  const current=summarize(currentTrades,currentCounters),v48=summarize(v48Trades,v48Counters);
  const report={generatedAt:new Date().toISOString(),period:{from:new Date(testStart).toISOString(),to:new Date(endMs).toISOString(),days:DAYS,warmupDays:WARMUP_DAYS},
    rules:{marginUsd:MARGIN_USD,leverage:LEVERAGE,targetMarginPercent:TARGET_MARGIN_PERCENT,fullCloseAtTarget:true,priceMoveTargetPercent:1.5,
      fees:"estimated taker fee 0.05% per side on 10x notional; round-trip cost deducted from each closed trade",funding:"not included (historical funding series not supplied)",slippage:"estimated 0.02% per side on 10x notional; round-trip cost deducted from each closed trade",takerFeeRate:TAKER_FEE_RATE,slippageRate:SLIPPAGE_RATE,roundTripCostUsd:ROUND_TRIP_COST_USD,
      entry:"signal on closed 1h/4h/15m; enter at next 1h open; exit on subsequent 5m OHLC; stop-first when same candle hits both",
      universe:"top 10 current-volume crypto Kraken USD perpetuals; non-crypto/index/FX symbols excluded; current-volume survivorship bias remains",
      historicalQuoteVolume:"approximated from preceding 24 hourly candles as sum(volume*close), avoiding current ticker-volume lookahead",
      fundingAnd24hVolume:"historical funding unavailable; quote volume approximated from candles"},
    engines:{current:{version:"11.2.0",source:"main snapshot copied into src/index-current.js"},experimental:{label:"V4.8 BTC-gated + tighter LONG filters",branch:"experiment/v48-r-scaled-btc-gated-20261123"}},
    symbolsTested:perSymbol.length,symbolsRequested:SYMBOL_LIMIT,errors,current,v48,perSymbol};
  await mkdir("artifacts",{recursive:true});
  await writeFile("artifacts/engine-comparison-15pct.json",JSON.stringify(report,null,2));
  const f=n=>Number(n||0).toFixed(2);
  const lines=["# Current 11.2.0 vs V4.8 experimental — fixed 15% margin target","",
    "Period: "+report.period.from+" — "+report.period.to,"Symbols tested: "+perSymbol.length+"/"+SYMBOL_LIMIT,"",
    "| Metric | Current 11.2.0 | V4.8 experimental |","|---|---:|---:|",
    "| Trades opened | "+current.opened+" | "+v48.opened+" |",
    "| Closed | "+current.closed+" | "+v48.closed+" |",
    "| Target first | "+current.wins+" | "+v48.wins+" |",
    "| Stop first | "+current.stops+" | "+v48.stops+" |",
    "| Open at end | "+current.openAtEnd+" | "+v48.openAtEnd+" |",
    "| LONG opened | "+current.longs+" | "+v48.longs+" |",
    "| SHORT opened | "+current.shorts+" | "+v48.shorts+" |",
    "| Win rate | "+f(current.winRatePct)+"% | "+f(v48.winRatePct)+"% |",
    "| Net PnL USD (after estimated fees/slippage) | $"+f(current.netPnlUsd)+" | $"+f(v48.netPnlUsd)+" |",
    "| Profit factor | "+f(current.profitFactor)+" | "+f(v48.profitFactor)+" |",
    "| Max drawdown USD | $"+f(current.maxDrawdownUsd)+" | $"+f(v48.maxDrawdownUsd)+" |",
    "| Avg margin return | "+f(current.avgMarginReturnPct)+"% | "+f(v48.avgMarginReturnPct)+"% |","",
    "| Engine / side | Opened | Wins | Stops | Win rate | PnL USD |",
    "|---|---:|---:|---:|---:|---:|",
    ...["current","v48"].flatMap(k=>["LONG","SHORT"].map(side=>{const x=(k==="current"?current:v48).bySide[side];return "| "+(k==="current"?"Current":"V4.8")+" "+side+" | "+x.opened+" | "+x.wins+" | "+x.stops+" | "+f(x.winRatePct)+"% | $"+f(x.netPnlUsd)+" |";})),
    "","## Per symbol","",
    "| Symbol | Current trades | Current PnL | V4.8 trades | V4.8 PnL |",
    "|---|---:|---:|---:|---:|",
    ...perSymbol.map(x=>"| "+x.symbol+" | "+x.current.opened+" | $"+f(x.current.netPnlUsd)+" | "+x.v48.opened+" | $"+f(x.v48.netPnlUsd)+" |"),
    "","Limitations: fees/slippage are modeled estimates (taker 0.05% each side + slippage 0.02% each side on 10x notional); funding, liquidation and cross-position margin competition are excluded. 5m OHLC cannot determine intrabar order; same-candle stop/target is conservative stop-first. Top-volume universe uses current rankings, so survivorship bias remains. Historical 24h quote volume is approximated from 1h candles."];
  await writeFile("artifacts/engine-comparison-15pct.md",lines.join("\n"));
  console.log(JSON.stringify(report,null,2));
  if(!perSymbol.length)process.exitCode=1;
}
main().catch(error=>{console.error(error);process.exitCode=1;});

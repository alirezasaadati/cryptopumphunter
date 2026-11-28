import { mkdir, writeFile } from "node:fs/promises";
import { evaluateLongSetup, isBullish15mRegime } from "../src/long-engine/long-engine.js";

const BASE="https://futures.kraken.com";
const MS={ "5m":300000, "15m":900000 };
const DAYS=Math.max(7,Math.min(60,Number(process.env.LONG_BACKTEST_DAYS||30)));
const SYMBOL_LIMIT=Math.max(1,Math.min(10,Number(process.env.LONG_BACKTEST_SYMBOLS||5)));
const FEE=Number(process.env.LONG_BACKTEST_FEE||0.0005);
const SLIPPAGE=Number(process.env.LONG_BACKTEST_SLIPPAGE||0.0003);
const MAX_HOLD_BARS=36;

async function getJson(url) {
  const response=await fetch(url,{headers:{accept:"application/json"},signal:AbortSignal.timeout(30000)});
  const body=await response.text();
  if(!response.ok) throw new Error("HTTP "+response.status+" "+body.slice(0,160));
  const data=JSON.parse(body);
  if(data?.result==="error" || data?.errors?.length) throw new Error("Kraken API error: "+JSON.stringify(data.errors||data.error));
  return data;
}
function normalize(rows,interval) {
  if(!Array.isArray(rows)) throw new Error("Missing candles array");
  const seen=new Set();
  return rows.map(x=>({time:Number(x.time)<1e12?Number(x.time)*1000:Number(x.time),
    open:Number(x.open),high:Number(x.high),low:Number(x.low),close:Number(x.close),volume:Number(x.volume)}))
    .filter(c=>Object.values(c).every(Number.isFinite)&&c.open>0&&c.low>0&&c.close>0&&c.high>=Math.max(c.open,c.close)&&c.low<=Math.min(c.open,c.close)&&c.volume>=0&&c.time+interval<=Date.now())
    .sort((a,b)=>a.time-b.time).filter(c=>{if(seen.has(c.time))return false;seen.add(c.time);return true;});
}
async function candles(symbol,resolution,from,to) {
  const interval=MS[resolution], chunk=interval*1600, all=[];
  for(let start=from;start<to;start+=chunk) {
    const end=Math.min(to,start+chunk), url=new URL(BASE+"/api/charts/v1/trade/"+encodeURIComponent(symbol)+"/"+resolution);
    url.searchParams.set("from",String(Math.floor(start/1000)));
    url.searchParams.set("to",String(Math.floor(end/1000)));
    url.searchParams.set("count","1650");
    const data=await getJson(url);
    if(data.more_candles===true) throw new Error(symbol+" "+resolution+" returned incomplete chunk");
    all.push(...normalize(data.candles,interval));
  }
  const map=new Map(all.map(c=>[c.time,c]));
  return [...map.values()].sort((a,b)=>a.time-b.time);
}
function lowerBound(rows,time) {
  let lo=0,hi=rows.length;
  while(lo<hi){const m=(lo+hi)>>1;if(rows[m].time+MS["15m"]<=time)lo=m+1;else hi=m;}
  return lo;
}
function simulate(candles,start,entry,stop,target) {
  let exit=entry,reason="TIME_EXIT",exitIndex=Math.min(candles.length-1,start+MAX_HOLD_BARS);
  for(let i=start;i<=exitIndex;i++) {
    const c=candles[i];
    if(c.open<=stop || c.low<=stop) {exit=c.open<=stop?c.open:stop;reason="STOP";exitIndex=i;break;}
    if(c.open>=target || c.high>=target) {exit=c.open>=target?c.open:target;reason="TARGET";exitIndex=i;break;}
    if(i===exitIndex) exit=c.close;
  }
  const fillEntry=entry*(1+SLIPPAGE), fillExit=exit*(1-SLIPPAGE);
  const grossR=(fillExit-fillEntry)/(fillEntry-stop);
  const feeR=FEE*(fillEntry+fillExit)/(fillEntry-stop);
  return {entry:fillEntry,stop,target,exit:fillExit,reason,entryTime:candles[start].time,exitTime:candles[exitIndex].time,netR:grossR-feeR};
}
function metrics(trades) {
  const wins=trades.filter(t=>t.netR>0),losses=trades.filter(t=>t.netR<0);
  const gw=wins.reduce((s,t)=>s+t.netR,0),gl=Math.abs(losses.reduce((s,t)=>s+t.netR,0));
  let equity=0,peak=0,dd=0;
  for(const t of trades){equity+=t.netR;peak=Math.max(peak,equity);dd=Math.max(dd,peak-equity);}
  return {trades:trades.length,wins:wins.length,losses:losses.length,winRatePct:trades.length?wins.length/trades.length*100:0,
    netR:trades.reduce((s,t)=>s+t.netR,0),expectancyR:trades.length?trades.reduce((s,t)=>s+t.netR,0)/trades.length:0,
    profitFactor:gl?gw/gl:gw?null:0,maxDrawdownR:dd};
}
async function runSymbol(ticker,btc15,from,to) {
  const [five,fifteen]=await Promise.all([candles(ticker.symbol,"5m",from,to),candles(ticker.symbol,"15m",from,to)]);
  if(five.length<1500||fifteen.length<300) throw new Error("Insufficient history: 5m="+five.length+", 15m="+fifteen.length);
  const trades=[];let nextAvailable=80,btcIndex=0,signalCount=0,accepted=0;
  const startTime=to-DAYS*86400000;
  for(let i=80;i<five.length-1;i++) {
    const closeTime=five[i].time+MS["5m"];
    if(closeTime<startTime) continue;
    while(btcIndex<btc15.length&&btc15[btcIndex].time+MS["15m"]<=closeTime) btcIndex++;
    const btcWindow=btc15.slice(Math.max(0,btcIndex-100),btcIndex);
    const own15End=lowerBound(fifteen,closeTime);
    const own15=fifteen.slice(Math.max(0,own15End-100),own15End);
    const own5=five.slice(Math.max(0,i-119),i+1);
    const btcBull=isBullish15mRegime(btcWindow);
    const result=evaluateLongSetup({fiveMin:own5,fifteenMin:own15,btcRegimeBullish:btcBull});
    if(!result.candidate) continue;
    signalCount++;
    if(i+1<nextAvailable) continue;
    const next=five[i+1],entry=next.open;
    const stop=result.candidate.stop;
    const risk=entry-stop;
    if(!(risk>0)||risk/entry>0.025) continue;
    const target=entry+risk*1.5;
    const trade=simulate(five,i+1,entry,stop,target);
    trade.symbol=ticker.symbol;trade.setupId=result.candidate.setupId;trade.score=result.candidate.score;
    trades.push(trade);accepted++;
    const exitIndex=five.findIndex((c,j)=>j>=i+1&&c.time===trade.exitTime);
    nextAvailable=Math.max(i+2,exitIndex+1);
  }
  return {symbol:ticker.symbol,candles5m:five.length,candles15m:fifteen.length,signalOpportunities:signalCount,executed:accepted,metrics:metrics(trades),trades};
}
async function main() {
  const end=Date.now(),start=end-DAYS*86400000,from=start-15*86400000;
  const tickerData=await getJson(BASE+"/derivatives/api/v3/tickers");
  const tickers=tickerData.tickers||[];
  const eligible=tickers.filter(t=>t?.tag==="perpetual"&&t.suspended!==true&&/^(PI|PF)_[A-Z0-9]+USD$/.test(String(t.symbol||""))&&Number(t.volumeQuote)>0&&Number(t.last)>0)
    .sort((a,b)=>Number(b.volumeQuote)-Number(a.volumeQuote));
  const btcTicker=eligible.find(t=>/^(PI|PF)_XBTUSD$/.test(t.symbol));
  if(!btcTicker) throw new Error("BTC perpetual contract not found in Kraken ticker universe");
  const universe=(process.env.LONG_BACKTEST_MARKETS||"").split(",").map(s=>s.trim()).filter(Boolean);
  const selected=universe.length?universe.map(s=>eligible.find(t=>t.symbol===s)).filter(Boolean):eligible.filter(t=>t.symbol!==btcTicker.symbol).slice(0,SYMBOL_LIMIT);
  if(!selected.length) throw new Error("No eligible contracts selected");
  const btc15=await candles(btcTicker.symbol,"15m",from,end);
  const results=[];
  for(const ticker of selected) {
    try {results.push(await runSymbol(ticker,btc15,from,end));}
    catch(error){results.push({symbol:ticker.symbol,error:String(error?.message||error)});}
  }
  const trades=results.flatMap(r=>r.trades||[]).sort((a,b)=>a.entryTime-b.entryTime);
  const report={generatedAt:new Date().toISOString(),venue:"Kraken Futures public historical OHLC",period:{from:new Date(start).toISOString(),to:new Date(end).toISOString(),days:DAYS,warmupDays:15},
    execution:"signal at closed 5m candle; entry at next 5m open; stop-first intrabar ordering",
    assumptions:{feePerSidePct:FEE*100,slippagePerSidePct:SLIPPAGE*100,funding:"excluded",maxHoldMinutes:MAX_HOLD_BARS*5,initialRR:1.5,
      btcFilter:"BTC 15m EMA20>EMA50, rising EMA50, ADX>=18, +DI>-DI",universe:"current top perpetuals by quote volume; survivorship bias applies"},
    symbolsTested:results.filter(r=>!r.error).length,symbolErrors:results.filter(r=>r.error),signalOpportunities:results.reduce((s,r)=>s+(r.signalOpportunities||0),0),
    portfolioMetrics:metrics(trades),bySymbol:results.map(({trades,...r})=>r),trades};
  await mkdir("artifacts",{recursive:true});
  await writeFile("artifacts/long-engine-backtest.json",JSON.stringify(report,null,2));
  const lines=["# Isolated conservative LONG engine backtest","", "Period: "+report.period.from+" to "+report.period.to,
    "Symbols tested: "+report.symbolsTested+"/"+selected.length,"","| Metric | Result |","|---|---:|",
    "| Signal opportunities | "+report.signalOpportunities+" |","| Executed trades | "+report.portfolioMetrics.trades+" |",
    "| Win rate | "+report.portfolioMetrics.winRatePct.toFixed(2)+"% |","| Expectancy | "+report.portfolioMetrics.expectancyR.toFixed(3)+"R |",
    "| Profit factor | "+report.portfolioMetrics.profitFactor+" |","| Net R | "+report.portfolioMetrics.netR.toFixed(2)+"R |",
    "| Max drawdown | "+report.portfolioMetrics.maxDrawdownR.toFixed(2)+"R |","",
    "Fees and slippage are modelled per side; funding is excluded. Current-volume universe selection creates survivorship bias. OHLC cannot reveal intrabar path; stop-first is assumed when both stop and target are touched.",
    "","| Symbol | Signals | Trades | Win rate | PF | Net R |","|---|---:|---:|---:|---:|---:|",
    ...results.map(r=>"| "+r.symbol+" | "+(r.signalOpportunities||0)+" | "+(r.metrics?.trades||0)+" | "+(r.metrics?.winRatePct||0).toFixed(2)+"% | "+(r.metrics?.profitFactor??"n/a")+" | "+(r.metrics?.netR||0).toFixed(2)+" |"),
    "","Symbol errors:",...report.symbolErrors.map(r=>"- "+r.symbol+": "+r.error)];
  await writeFile("artifacts/long-engine-backtest.md",lines.join("\n"));
  console.log(JSON.stringify({ok:report.symbolsTested>0,period:report.period,portfolioMetrics:report.portfolioMetrics,signalOpportunities:report.signalOpportunities,bySymbol:report.bySymbol,symbolErrors:report.symbolErrors},null,2));
  if(!report.symbolsTested) process.exitCode=1;
}
main().catch(error=>{console.error(error);process.exitCode=1;});

import { mkdir, writeFile } from "node:fs/promises";
import { analyzeFuturesSymbol, FUTURES_CONFIG } from "../src/index.js";
import { evaluateTradeCandle, FUTURES_TRADE_LEVERAGE, FUTURES_MARGIN_PROFIT_TARGET_PERCENT } from "../src/futures-trade-lifecycle.js";

const BASE = "https://futures.kraken.com";
const HOUR = 3600000, DAY = 86400000, WEEK = 7 * DAY;
const WINDOWS = [90, 180];
const WARMUP_DAYS = 230;
const TRADE_SYMBOL_LIMIT = 10;
const BREADTH_SYMBOL_LIMIT = 20;
const MAX_HOLD_HOURS = 72;

async function getJson(url, attempt = 0) {
  const response = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(30000) });
  const body = await response.text();
  if (!response.ok) {
    if (attempt < 3 && (response.status === 429 || response.status >= 500)) {
      await new Promise(r => setTimeout(r, 700 * (attempt + 1)));
      return getJson(url, attempt + 1);
    }
    throw new Error("HTTP " + response.status + " " + url + ": " + body.slice(0, 160));
  }
  const data = JSON.parse(body);
  if (data?.result === "error" || data?.errors?.length) throw new Error("Kraken API error: " + JSON.stringify(data.errors || data.error));
  return data;
}
function normalize(rows, interval) {
  const seen = new Set();
  return (rows || []).map(x => ({time:Number(x.time)<1e12?Number(x.time)*1000:Number(x.time),
    open:Number(x.open),high:Number(x.high),low:Number(x.low),close:Number(x.close),volume:Number(x.volume)}))
    .filter(c=>[c.time,c.open,c.high,c.low,c.close,c.volume].every(Number.isFinite)&&c.open>0&&c.close>0&&c.low>0&&c.high>=c.low&&c.volume>=0&&c.time+interval<=Date.now())
    .sort((a,b)=>a.time-b.time).filter(c=>{if(seen.has(c.time))return false;seen.add(c.time);return true;});
}
async function fetchCandles(symbol,resolution,from,to,interval) {
  const chunk=interval*1700, all=[];
  for(let start=from;start<to;start+=chunk){
    const end=Math.min(to,start+chunk),url=new URL(BASE+"/api/charts/v1/trade/"+encodeURIComponent(symbol)+"/"+resolution);
    url.searchParams.set("from",String(Math.floor(start/1000)));
    url.searchParams.set("to",String(Math.floor(end/1000)));
    url.searchParams.set("count","1800");
    const data=await getJson(url);
    if(data.more_candles===true)throw new Error(symbol+" "+resolution+" incomplete Kraken chunk");
    all.push(...normalize(data.candles,interval));
  }
  const map=new Map(all.map(c=>[c.time,c]));
  return [...map.values()].sort((a,b)=>a.time-b.time);
}
function lowerBound(a,t){let l=0,r=a.length;while(l<r){const m=(l+r)>>1;if(a[m].time<t)l=m+1;else r=m;}return l;}
function ema(values,n){if(values.length<n)return null;let v=values.slice(0,n).reduce((s,x)=>s+x,0)/n;const k=2/(n+1);for(let i=n;i<values.length;i++)v=values[i]*k+v*(1-k);return v;}
function mondayStart(t){const d=new Date(t);const day=(d.getUTCDay()+6)%7;return Math.floor(t/DAY)*DAY-day*DAY;}
function aggregateRange(a,start,end){
  const i=lowerBound(a,start),j=lowerBound(a,end),xs=a.slice(i,j);
  if(!xs.length)return null;
  return {time:start,open:xs[0].open,high:Math.max(...xs.map(x=>x.high)),low:Math.min(...xs.map(x=>x.low)),close:xs.at(-1).close,volume:xs.reduce((s,x)=>s+x.volume,0)};
}
function completedAggregates(a,period,until){
  const map=new Map();
  for(const c of a){if(c.time>=until)break;const key=period===DAY?Math.floor(c.time/DAY)*DAY:mondayStart(c.time);
    const old=map.get(key);if(!old)map.set(key,{time:key,open:c.open,high:c.high,low:c.low,close:c.close,volume:c.volume});
    else{old.high=Math.max(old.high,c.high);old.low=Math.min(old.low,c.low);old.close=c.close;old.volume+=c.volume;}}
  return [...map.values()].sort((x,y)=>x.time-y.time);
}
function snapshot(hourly,time){
  const endIndex=lowerBound(hourly,time);
  if(endIndex<1)return null;
  const past=hourly.slice(0,endIndex),last=past.at(-1);
  const dayStart=Math.floor(time/DAY)*DAY,weekStart=mondayStart(time);
  const daily=completedAggregates(past,DAY,dayStart);
  const weekly=completedAggregates(past,WEEK,weekStart);
  const partialDay=aggregateRange(past,dayStart,time+1);
  const partialWeek=aggregateRange(past,weekStart,time+1);
  if(!partialDay||!partialWeek||daily.length<24||weekly.length<24)return null;
  const dCloses=daily.map(x=>x.close),wCloses=weekly.map(x=>x.close);
  const dEma=ema(dCloses,20),dEmaPrior=ema(dCloses.slice(0,-3),20);
  const wEma=ema(wCloses,20),wEmaPrior=ema(wCloses.slice(0,-4),20);
  if(![dEma,dEmaPrior,wEma,wEmaPrior].every(Number.isFinite))return null;
  const old7=past.find(x=>x.time>=time-7*DAY-HOUR);
  const weeklyReturn=old7?((last.close/old7.open)-1)*100:null;
  const dailyReturn=((partialDay.close/partialDay.open)-1)*100;
  const dailySlope=((dEma/dEmaPrior)-1)*100;
  const weeklySlope=((wEma/wEmaPrior)-1)*100;
  return {lastPrice:last.close,dailyEma:dEma,dailySlope,dailyReturn,weeklyEma:wEma,weeklySlope,weeklyReturn,
    dailyBear:partialDay.close<dEma&&dailySlope<=0&&dailyReturn>=-3&&dailyReturn<=0.5,
    weeklyStrongBear:partialWeek.close<wEma&&weeklySlope<=-1&&weeklyReturn<=-5,
    weeklyNeutral:Math.abs(weeklyReturn)<=3&&Math.abs(partialWeek.close/wEma-1)<=0.03&&Math.abs(weeklySlope)<=1};
}
function altBearishAt(altSeries,time){
  let valid=0,bear=0;
  for(const candles of altSeries){
    const s=snapshot(candles,time);
    if(!s)continue;
    const idx=lowerBound(candles,time);
    if(idx<25)continue;
    const now=candles[idx-1],prev=candles[Math.max(0,idx-25)];
    const ret=(now.close/prev.close-1)*100;
    valid++;
    if(now.close<s.dailyEma&&ret<0)bear++;
  }
  return {valid,bear,breadthPct:valid?bear/valid*100:0,allBearish:valid>=10&&bear/valid>=0.60};
}
function classify(btc,alts,time){
  const b=snapshot(btc,time),a=altBearishAt(alts,time);
  if(!b||!a.allBearish)return null;
  if(!b.dailyBear)return null;
  if(b.weeklyStrongBear)return {regime:"WEEKLY_STRONG_BEAR",btc:b,alts:a};
  if(b.weeklyNeutral)return {regime:"WEEKLY_NEUTRAL",btc:b,alts:a};
  return null;
}
function summarize(trades,signals,lockSkips){
  const closed=trades.filter(t=>t.status==="CLOSED_PROFIT"||t.status==="CLOSED_STOP");
  const wins=closed.filter(t=>t.status==="CLOSED_PROFIT"),stops=closed.filter(t=>t.status==="CLOSED_STOP");
  const sum=xs=>xs.reduce((s,t)=>s+Number(t.marginReturnPercent||0),0);
  return {signalOpportunities:signals,tradesStarted:trades.length,closedTrades:closed.length,
    profitCloses:wins.length,stopCloses:stops.length,openAtEnd:trades.length-closed.length,
    winRatePct:closed.length?wins.length/closed.length*100:0,
    grossMarginReturnPct:sum(closed),averageMarginReturnPct:closed.length?sum(closed)/closed.length:0,
    sameSideLockSkips:lockSkips};
}
function simulate(side,entry,stop,targets,bars,startIndex,signalTime,symbol,score){
  const trade={id:symbol+":"+signalTime, symbol,side,status:"OPEN",entry,initialStop:stop,stop,
    signalTime,entryTime:signalTime,score,ambiguousCandles:0};
  const end=Math.min(bars.length-1,startIndex+MAX_HOLD_HOURS*12);
  for(let i=startIndex;i<=end;i++){
    const bar=bars[i];
    const target=side==="SHORT"?entry*(1-FUTURES_MARGIN_PROFIT_TARGET_PERCENT/FUTURES_TRADE_LEVERAGE/100):entry*(1+FUTURES_MARGIN_PROFIT_TARGET_PERCENT/FUTURES_TRADE_LEVERAGE/100);
    const stopHit=side==="SHORT"?bar.high>=trade.stop:bar.low<=trade.stop;
    const targetHit=side==="SHORT"?bar.low<=target:bar.high>=target;
    const stopAtOpen=side==="SHORT"?bar.open>=trade.stop:bar.open<=trade.stop;
    const targetAtOpen=side==="SHORT"?bar.open<=target:bar.open>=target;
    if(stopHit&&targetHit&&!stopAtOpen&&!targetAtOpen)trade.ambiguousCandles++;
    const evaluated=evaluateTradeCandle(trade,{...bar,time:bar.time+300000});
    if(evaluated.changed){Object.assign(trade,evaluated.trade);trade.closedAtMs=bar.time+300000;return trade;}
  }
  trade.status="OPEN_AT_BACKTEST_END";
  trade.lastMark=bars[end]?.close??null;
  trade.marginReturnAtMarkPct=trade.lastMark?(side==="SHORT"?-1:1)*(trade.lastMark-entry)/entry*100*FUTURES_TRADE_LEVERAGE:null;
  return trade;
}
async function main(){
  const end=Date.now(),maxStart=end-180*DAY,warmStart=maxStart-WARMUP_DAYS*DAY;
  const tickerData=await getJson(BASE+"/derivatives/api/v3/tickers");
  const all=tickerData.tickers.filter(t=>t?.tag==="perpetual"&&t.suspended!==true&&/^(PI|PF)_[A-Z0-9]+USD$/.test(String(t.symbol||""))&&Number(t.volumeQuote)>=FUTURES_CONFIG.HIGH_RISK_MIN_QUOTE_VOLUME&&Number(t.last)>0)
    .sort((a,b)=>Number(b.volumeQuote)-Number(a.volumeQuote));
  const tradeUniverse=all.filter(t=>Number(t.volumeQuote)>=FUTURES_CONFIG.MIN_QUOTE_VOLUME).slice(0,TRADE_SYMBOL_LIMIT);
  const alts=all.filter(t=>!/(XBT|BTC|USDT|USDC)/i.test(t.symbol)).slice(0,BREADTH_SYMBOL_LIMIT);
  const btcTicker=all.find(t=>/XBTUSD$/.test(t.symbol))||{symbol:"PF_XBTUSD"};
  const dataMap=new Map();
  const marketSymbols=[...new Set([btcTicker.symbol,...alts.map(x=>x.symbol)])];
  for(let i=0;i<marketSymbols.length;i+=4){
    await Promise.all(marketSymbols.slice(i,i+4).map(async symbol=>{
      dataMap.set(symbol,await fetchCandles(symbol,"1h",warmStart,end,HOUR));
    }));
  }
  const btc=dataMap.get(btcTicker.symbol);
  if(!btc||btc.length<500)throw new Error("BTC hourly history unavailable");
  const altSeries=alts.map(x=>dataMap.get(x.symbol)).filter(x=>x&&x.length>500);
  const results=[];
  for(const ticker of tradeUniverse){
    try{
      const [one,four,fifteen,five]=await Promise.all([
        dataMap.get(ticker.symbol)?Promise.resolve(dataMap.get(ticker.symbol)):fetchCandles(ticker.symbol,"1h",warmStart,end,HOUR),
        fetchCandles(ticker.symbol,"4h",warmStart,end,4*HOUR),
        fetchCandles(ticker.symbol,"15m",warmStart,end,900000),
        fetchCandles(ticker.symbol,"5m",maxStart-4*DAY,end,300000)
      ]);
      results.push({symbol:ticker.symbol,ticker,one,four,fifteen,five});
    }catch(e){results.push({symbol:ticker.symbol,error:String(e?.message||e)});}
  }
  const successful=results.filter(x=>!x.error);
  const regimeCache=new Map();
  const outputs={};
  for(const days of WINDOWS){
    const start=end-days*DAY;
    const cohorts={WEEKLY_STRONG_BEAR:{trades:[],signals:0,skips:0},WEEKLY_NEUTRAL:{trades:[],signals:0,skips:0}};
    const locks={WEEKLY_STRONG_BEAR:new Map(),WEEKLY_NEUTRAL:new Map()};
    for(const item of successful){
      const {symbol,ticker,one,four,fifteen,five}=item;
      let fi=0,pi=0;
      for(let i=60;i<one.length-1;i++){
        const signalBar=one[i],time=signalBar.time+HOUR;
        if(time<start||time>=end)continue;
        while(fi<four.length&&four[fi].time+4*HOUR<=time)fi++;
        while(pi<fifteen.length&&fifteen[pi].time+900000<=time)pi++;
        const closed4=four.slice(0,fi),closed15=fifteen.slice(Math.max(0,pi-120),pi);
        if(closed4.length<FUTURES_CONFIG.MIN_CANDLES||closed15.length<30)continue;
        let regime=regimeCache.get(time);
        if(regime===undefined){regime=classify(btc,altSeries,time)||false;regimeCache.set(time,regime);}
        if(!regime||!["WEEKLY_STRONG_BEAR","WEEKLY_NEUTRAL"].includes(regime.regime))continue;
        const next=one[i+1];
        const tickerAt={symbol,last:next.open,quoteVolume:Number(ticker.volumeQuote)||0,
          priceChangePercent:i>=24?((one[i].close/one[i-24].close)-1)*100:0,premium:{lastFundingRate:null}};
        let candidate;
        try{candidate=analyzeFuturesSymbol(tickerAt,one.slice(0,i+1),closed4,closed15);}
        catch{continue;}
        if(candidate?.eligible!==true||candidate.side!=="SHORT")continue;
        const cohort=cohorts[regime.regime];cohort.signals++;
        const lockKey=symbol+"|SHORT";
        if((locks[regime.regime].get(lockKey)||0)>time){cohort.skips++;continue;}
        const entry=Number(candidate.entry),stop=Number(candidate.stop);
        const start5=lowerBound(five,time);
        if(start5>=five.length)continue;
        const trade=simulate("SHORT",entry,stop,[candidate.target1,candidate.target2,candidate.target3],five,start5,time,symbol,candidate.score);
        trade.regime=regime.regime;trade.weeklyReturnPct=regime.btc.weeklyReturn;trade.dailyReturnPct=regime.btc.dailyReturn;
        trade.altBearishBreadthPct=regime.alts.breadthPct;
        cohort.trades.push(trade);
        locks[regime.regime].set(lockKey,trade.closedAtMs||end);
      }
    }
    outputs[days]={period:{from:new Date(start).toISOString(),to:new Date(end).toISOString(),days},
      groups:Object.fromEntries(Object.entries(cohorts).map(([k,v])=>[k,summarize(v.trades,v.signals,v.skips)])),
      diagnostics:{signalsWithRegime:cohorts.WEEKLY_STRONG_BEAR.signals+cohorts.WEEKLY_NEUTRAL.signals,
        btcCandles:btc.length,altBreadthSymbols:altSeries.length,tradingSymbols:successful.map(x=>x.symbol),
        symbolErrors:results.filter(x=>x.error).map(x=>({symbol:x.symbol,error:x.error}))},
      trades:Object.fromEntries(Object.entries(cohorts).map(([k,v])=>[k,v.trades]))};
  }
  const report={generatedAt:new Date().toISOString(),source:"Kraken Futures historical OHLC; current production source commit 5fb9555216b3dde4936cbee87266d3e647305f85",
    engine:"analyzeFuturesSymbol from src/index.js, SHORT candidates only; no strategy thresholds changed",
    regimeDefinitions:{
      weeklyStrongBear:"BTC rolling 7d return <= -5%, partial weekly close below EMA20W, EMA20W slope over four weekly observations <= -1%",
      weeklyNeutral:"BTC rolling 7d return in [-3%,+3%], partial weekly close within +/-3% of EMA20W, EMA20W slope over four weekly observations in [-1%,+1%]",
      dailyWeakModerateBear:"BTC partial daily close below prior completed daily EMA20, EMA20D slope over three daily observations <= 0%, partial UTC-day return in [-3%,+0.5%]",
      altsBroadlyBearish:"at least 60% of at least 10 sampled non-BTC top-volume Kraken perpetual altcoins have partial daily close below prior completed daily EMA20 and negative rolling 24h return",
      timing:"all market regime measurements use only candles completed by each signal timestamp; current UTC day/week are partial snapshots, no future candles"
    },
    execution:{entry:"candidate.entry at next 1h open timestamp as in lifecycle replay",exit:"production evaluateTradeCandle on subsequent 5m candles",leverage:FUTURES_TRADE_LEVERAGE,targetMarginReturnPct:FUTURES_MARGIN_PROFIT_TARGET_PERCENT,
      maxHoldHours:MAX_HOLD_HOURS,sameSideLock:"per symbol+SHORT, separately inside each disjoint regime cohort",
      fees:"excluded by existing lifecycle gross return model",funding:"excluded",slippage:"excluded",
      ambiguous5m:"conservative stop-first behavior delegated to evaluateTradeCandle",universe:"top current-volume Kraken perpetuals; survivorship bias applies"},
    regimeResults:outputs};
  await mkdir("artifacts",{recursive:true});
  await writeFile("artifacts/short-market-regime-backtest.json",JSON.stringify(report,null,2));
  const lines=["# Current Kraken Futures SHORT engine — market regime comparison","",
    "Engine source commit: 5fb9555216b3dde4936cbee87266d3e647305f85","",
    "Regime definitions:",...Object.entries(report.regimeDefinitions).map(([k,v])=>"- "+k+": "+v),"",
    "Execution: "+JSON.stringify(report.execution),"",
    ...WINDOWS.flatMap(days=>{const r=outputs[days];return ["## "+days+" days","",
      "| Metric | Strong bearish weekly | Neutral weekly |",
      "|---|---:|---:|",
      ...["signalOpportunities","tradesStarted","closedTrades","profitCloses","stopCloses","openAtEnd","winRatePct","grossMarginReturnPct","sameSideLockSkips"].map(k=>"| "+k+" | "+r.groups.WEEKLY_STRONG_BEAR[k]+" | "+r.groups.WEEKLY_NEUTRAL[k]+" |"),""]})];
  await writeFile("artifacts/short-market-regime-backtest.md",lines.join("\n"));
  console.log(JSON.stringify({ok:true,results:Object.fromEntries(WINDOWS.map(d=>[d,outputs[d].groups])),diagnostics:Object.fromEntries(WINDOWS.map(d=>[d,outputs[d].diagnostics]))},null,2));
}
main().catch(e=>{console.error(e);process.exitCode=1;});

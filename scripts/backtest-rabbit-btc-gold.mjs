import { mkdir, writeFile } from "node:fs/promises";
import { analyzeRabbitCorrection } from "../src/rabbit-engine.js";
import { computeBtcRegime, FUTURES_CONFIG } from "../src/index.js";

// Comparison-only instrument substitution: XAUT perpetual replaces the Gold Pyth index.
const BASE="https://futures.kraken.com",DAY=86400000;
const INTERVAL={"5m":300000,"15m":900000,"1h":3600000,"4h":14400000};
const END=process.env.RABBIT_BACKTEST_END?Date.parse(process.env.RABBIT_BACKTEST_END):Date.parse("2026-11-15T00:00:00Z");
const WINDOWS=[90],WARMUP_DAYS=25,MAX_HOLD_HOURS=6,MARGIN=10,LEVERAGE=10;
if(!Number.isFinite(END))throw new Error("Invalid RABBIT_BACKTEST_END");

async function getJson(url,attempt=0){
 const r=await fetch(url,{headers:{accept:"application/json"},signal:AbortSignal.timeout(30000)}),body=await r.text();
 if(!r.ok){if(attempt<3&&(r.status===429||r.status>=500)){await new Promise(x=>setTimeout(x,800*(attempt+1)));return getJson(url,attempt+1);}throw new Error("HTTP "+r.status+" "+url+" "+body.slice(0,160));}
 const d=JSON.parse(body);if(d?.result==="error"||d?.errors?.length)throw new Error("Kraken API error "+JSON.stringify(d.errors||d.error));return d;
}
function normalize(rows,step){
 const seen=new Set();return (rows||[]).map(x=>({time:Number(x.time)<1e12?Number(x.time)*1000:Number(x.time),open:Number(x.open),high:Number(x.high),low:Number(x.low),close:Number(x.close),volume:Number(x.volume)}))
 .filter(c=>[c.time,c.open,c.high,c.low,c.close,c.volume].every(Number.isFinite)&&c.open>0&&c.low>0&&c.high>=c.low&&c.close>0&&c.time+step<=END)
 .sort((a,b)=>a.time-b.time).filter(c=>{if(seen.has(c.time))return false;seen.add(c.time);return true;});
}
async function fetchCandles(symbol,res,from,to){
 const step=INTERVAL[res],chunk=step*1700,all=[];
 for(let start=from;start<to;start+=chunk){
  const end=Math.min(to,start+chunk),url=new URL(BASE+"/api/charts/v1/trade/"+encodeURIComponent(symbol)+"/"+res);
  url.searchParams.set("from",String(Math.floor(start/1000)));url.searchParams.set("to",String(Math.floor(end/1000)));url.searchParams.set("count","1800");
  const d=await getJson(url);if(d.more_candles===true)throw new Error(symbol+" "+res+" incomplete chunk");all.push(...normalize(d.candles,step));
 }
 return [...new Map(all.map(c=>[c.time,c])).values()].sort((a,b)=>a.time-b.time);
}
function lower(a,t){let l=0,h=a.length;while(l<h){const m=(l+h)>>1;if(a[m].time<t)l=m+1;else h=m;}return l;}
function portfolioMtm(trades){
 const events=[];
 trades.forEach((trade,index)=>(trade.markPath||[]).forEach(mark=>events.push({time:mark.time,index,pnlUsd:mark.pnlUsd})));
 events.sort((a,b)=>a.time-b.time||a.index-b.index);
 const marks=new Array(trades.length).fill(0);let equity=0,peak=0,maxDrawdown=0;
 for(let i=0;i<events.length;){const time=events[i].time;while(i<events.length&&events[i].time===time){const e=events[i++];equity+=e.pnlUsd-marks[e.index];marks[e.index]=e.pnlUsd;}peak=Math.max(peak,equity);maxDrawdown=Math.max(maxDrawdown,peak-equity);}
 return {finalEquityPnlUsd:equity,openMtmUsd:trades.filter(t=>t.status==="OPEN_AT_END").reduce((a,t)=>a+Number(t.markPath?.at(-1)?.pnlUsd||0),0),maxDrawdownMtmUsd:maxDrawdown};
}
function metrics(trades,eligible,rejected,lockSkips,lockSkipsBySymbol={},lockSkipDetails=[]){
 const closed=trades.filter(t=>t.status==="WIN"||t.status==="STOP"),wins=closed.filter(t=>t.status==="WIN"),stops=closed.filter(t=>t.status==="STOP");
 const pnls=closed.map(t=>t.pnlUsd),profit=pnls.filter(x=>x>0).reduce((a,b)=>a+b,0),loss=Math.abs(pnls.filter(x=>x<0).reduce((a,b)=>a+b,0));
 let eq=0,peak=0,dd=0;for(const t of [...closed].sort((a,b)=>a.exitTime-b.exitTime)){eq+=t.pnlUsd;peak=Math.max(peak,eq);dd=Math.max(dd,peak-eq);} const mtm=portfolioMtm(trades);
 return {eligibleSignals:eligible,tradesOpened:trades.length,closed:closed.length,wins:wins.length,stops:stops.length,openAtEnd:trades.length-closed.length,
 winRatePct:closed.length?wins.length/closed.length*100:0,stopRatePct:closed.length?stops.length/closed.length*100:0,
 grossPnlUsd:pnls.reduce((a,b)=>a+b,0),profitFactor:loss?profit/loss:(profit?Infinity:0),maxDrawdownUsd:dd,openMtmUsd:mtm.openMtmUsd,totalPnlWithOpenMtmUsd:pnls.reduce((a,b)=>a+b,0)+mtm.openMtmUsd,maxDrawdownMtmUsd:mtm.maxDrawdownMtmUsd,finalEquityPnlUsd:mtm.finalEquityPnlUsd,rejected,lockSkips,lockSkipsBySymbol,lockSkipDetails};
}
function simulate(symbol,entry,stop,bars,start,signalTime){
 const risk=stop-entry,target=entry-risk,end=Math.min(bars.length,start+MAX_HOLD_HOURS*12),markPath=[];
 for(let i=start;i<end;i++){
  const b=bars[i],stopHit=b.high>=stop,targetHit=b.low<=target,stopAtOpen=b.open>=stop,targetAtOpen=b.open<=target;
  let exit=null,status=null;
  if(stopAtOpen){exit=b.open;status="STOP";}
  else if(targetAtOpen){exit=b.open;status="WIN";}
  else if(stopHit){exit=stop;status="STOP";}
  else if(targetHit){exit=target;status="WIN";}
  const markPrice=status?exit:b.close,markPct=(entry-markPrice)/entry*100;markPath.push({time:b.time+INTERVAL["5m"],pnlUsd:MARGIN*markPct*LEVERAGE/100});
  if(status){
   const pricePct=(entry-exit)/entry*100,marginReturnPct=pricePct*LEVERAGE;
   return {symbol,side:"SHORT",status,signalTime,entryTime:bars[start].time,exitTime:b.time+INTERVAL["5m"],entry,stop,target,exit,pricePct,marginReturnPct,pnlUsd:MARGIN*marginReturnPct/100,holdMinutes:(b.time+INTERVAL["5m"]-bars[start].time)/60000,markPath};
  }
 }
 const last=bars[Math.max(start,end-1)],pricePct=last?(entry-last.close)/entry*100:0,marginReturnPct=pricePct*LEVERAGE;
 return {symbol,side:"SHORT",status:"OPEN_AT_END",signalTime,entryTime:bars[start]?.time??signalTime,entry,stop,target,exit:last?.close??null,pricePct,marginReturnPct,pnlUsd:0,holdMinutes:last?(last.time+INTERVAL["5m"]-bars[start].time)/60000:0,markPath};
}
async function main(){
 const tickers=(await getJson(BASE+"/derivatives/api/v3/tickers")).tickers;
 const symbols=["PF_XBTUSD","PF_XAUTUSD"];
 const universe=symbols.map(symbol=>tickers.find(t=>String(t?.symbol)===symbol&&t?.suspended!==true)||{symbol});
 const from=END-(WINDOWS[0]+WARMUP_DAYS)*DAY;
 const btc=await fetchCandles("PF_XBTUSD","4h",from,END),datasets=[],errors=[];
 for(const t of universe){
  try{
   const [one,four,fifteen,five]=await Promise.all([
    fetchCandles(t.symbol,"1h",from,END),fetchCandles(t.symbol,"4h",from,END),
    fetchCandles(t.symbol,"15m",from,END),fetchCandles(t.symbol,"5m",from,END)]);
   if(one.length<100||four.length<60||fifteen.length<100||five.length<500)throw new Error("Insufficient historical candles");
   datasets.push({symbol:t.symbol,one,four,fifteen,five});
   console.log("downloaded",t.symbol,{one:one.length,four:four.length,fifteen:fifteen.length,five:five.length});
  }catch(e){errors.push({symbol:t.symbol,error:String(e?.message||e)});console.error("failed",t.symbol,String(e?.message||e));}
 }
 const outputs={};
 for(const days of WINDOWS){
  const start=END-days*DAY,trades=[],locks=new Map(),rejectionReasons={},lockSkipsBySymbol={},lockSkipDetails=[];let eligible=0,rejected=0,lockSkips=0;
  for(const d of datasets){
   let i1=0,i4=0,rabbitState={};
   for(let i=40;i<d.fifteen.length;i++){
    const signalBar=d.fifteen[i],signalTime=signalBar.time+INTERVAL["15m"];
    if(signalTime>=END)break;
    while(i1<d.one.length&&d.one[i1].time+INTERVAL["1h"]<=signalTime)i1++;
    while(i4<d.four.length&&d.four[i4].time+INTERVAL["4h"]<=signalTime)i4++;
    const one=d.one.slice(0,i1),four=d.four.slice(0,i4),fifteen=d.fifteen.slice(0,i+1);
    if(one.length<60||four.length<60||fifteen.length<40)continue;
    const btcIdx=lower(btc,signalTime-INTERVAL["4h"]+1),btcClosed=btc.slice(0,btcIdx);
    const btcRegime=computeBtcRegime(btcClosed);
    const entryIndex=lower(d.five,signalTime);if(entryIndex>=d.five.length)continue;
    const entry=d.five[entryIndex].open;
    const candidate=analyzeRabbitCorrection({symbol:d.symbol,candles1h:one,candles4h:four,candles15m:fifteen,price:entry,btcRegime,state:rabbitState});
    if(candidate.nextState)rabbitState=candidate.nextState;
    // Process warm-up bars to build state and carry any still-open position lock into the test window.
    if(signalTime<start){
     if(candidate.eligible&&candidate.stop>entry){
      const warmTrade=simulate(d.symbol,entry,candidate.stop,d.five,entryIndex,signalTime);
      locks.set(d.symbol,warmTrade.exitTime||END);
     }
     continue;
    }
    if(!candidate.eligible){
     rejected++;
     const reason=String(candidate.rejected||"Unknown rejection");
     rejectionReasons[reason]=(rejectionReasons[reason]||0)+1;
     continue;
    }
    eligible++;
    if((locks.get(d.symbol)||0)>signalTime){lockSkips++;lockSkipsBySymbol[d.symbol]=(lockSkipsBySymbol[d.symbol]||0)+1;if(lockSkipDetails.length<500)lockSkipDetails.push({symbol:d.symbol,signalTime:new Date(signalTime).toISOString(),blockedUntil:new Date(locks.get(d.symbol)).toISOString()});continue;}
    const risk=candidate.stop-entry;
    if(!(risk>0)){rejected++;rejectionReasons["Invalid stop risk"]=(rejectionReasons["Invalid stop risk"]||0)+1;continue;}
    const trade=simulate(d.symbol,entry,candidate.stop,d.five,entryIndex,signalTime);
    trade.score=candidate.score;trade.surgePct=candidate.surgePct;trade.rsiPeak15m=candidate.rsiPeak15m;
    trades.push(trade);locks.set(d.symbol,trade.exitTime||END);
   }
  }
  const bySymbol={};for(const d of datasets){const ts=trades.filter(t=>t.symbol===d.symbol);bySymbol[d.symbol]=metrics(ts,ts.length,0,0);}
  outputs[days]={period:{from:new Date(start).toISOString(),to:new Date(END).toISOString(),days},metrics:metrics(trades,eligible,rejected,lockSkips,lockSkipsBySymbol,lockSkipDetails),rejectionReasons,bySymbol,trades};
 }
 const report={generatedAt:new Date().toISOString(),engine:"Rabbit experimental counter-trend SHORT",source:"Kraken Futures historical OHLC",
  marketRegimeValidation:{benchmark:"BTC/XBT",windowStart:new Date(END-WINDOWS[0]*DAY).toISOString(),windowEnd:new Date(END).toISOString(),btcStartClose:btc.find(c=>c.time+INTERVAL["4h"]>END-WINDOWS[0]*DAY)?.open??null,btcEndClose:btc.at(-1)?.close??null,btcReturnPct:(()=>{const a=btc.find(c=>c.time+INTERVAL["4h"]>END-WINDOWS[0]*DAY)?.open,b=btc.at(-1)?.close;return a>0&&b>0?(b/a-1)*100:null;})(),classification:"matched BTC-vs-XAUT comparison window; BTC 4h regime is the shared market filter"},
  rules:{bullRegime:"BTC 4h computeBtcRegime bullish; traded symbol 1h and 4h EMA20>EMA50 and close>EMA20",
   impulse:"8 closed 15m candles ending at the impulse peak; surge >=1.5%, >=1.8 ATR, and peak >=1.2 ATR above EMA20 calculated strictly before the impulse; RSI14 at peak >=65",
   confirmation:"closed bearish 15m candle closes below EMA9 and (by default) below the prior two candle lows; RSI at peak >=65; confirmation volume >=0.7x prior 20-bar average",
   state:"per-symbol state persisted on every candle, keyed by absolute peak timestamp; newer independent impulses replace older setups even when their absolute high is lower",
   entry:"next 5m candle open after the 15m confirmation closes",stop:"impulse swing high + 0.2 ATR",target:"full close at 1R",
   marginUsd:MARGIN,leverage:LEVERAGE,maxHoldHours:MAX_HOLD_HOURS,sameCandle:"stop-first unless open gaps through a level",
   costs:"fees, slippage, funding and liquidation excluded",universe:"Two matched Kraken USD perpetuals: PF_XBTUSD (Bitcoin) and PF_XAUTUSD (Tether XAUT); independent per-symbol position locks"},
  symbolsRequested:2,symbolsTested:datasets.length,errors,results:outputs};
 await mkdir("artifacts",{recursive:true});await writeFile("artifacts/rabbit-backtest.json",JSON.stringify(report,null,2));
 const fmt=n=>Number(n||0).toFixed(2),lines=["# Rabbit — matched BTC vs XAUT 90d correction SHORT backtest","","Matched BTC vs XAUT historical window ending 2026-11-15 (90 days; 2026-08-17 through 2026-11-15); PF_XBTUSD and PF_XAUTUSD; same Rabbit engine/settings; full close at 1R; $10 margin, 10x leverage; 5m OHLC; stop-first same-candle rule. Open positions are marked to market at every completed 5m close.","",
 "| Period | Eligible signals | Trades | Wins | Stops | Open | Win rate | Realized PnL | MTM PnL | PF | MTM DD |","|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|"];
 for(const days of WINDOWS){const m=outputs[days].metrics;lines.push("| "+days+"d | "+m.eligibleSignals+" | "+m.tradesOpened+" | "+m.wins+" | "+m.stops+" | "+m.openAtEnd+" | "+fmt(m.winRatePct)+"% | $"+fmt(m.grossPnlUsd)+" | $"+fmt(m.totalPnlWithOpenMtmUsd)+" | "+fmt(m.profitFactor)+" | $"+fmt(m.maxDrawdownMtmUsd)+" |");}
 lines.push("","## Per-symbol results","","| Symbol | Trades | Closed | Wins | Stops | Open at end | Realized PnL |","|---|---:|---:|---:|---:|---:|---:|");
 for(const d of datasets){const a=outputs[WINDOWS[0]].bySymbol[d.symbol];lines.push("| "+d.symbol+" | "+a.tradesOpened+" | "+a.closed+" | "+a.wins+" | "+a.stops+" | "+a.openAtEnd+" | $"+fmt(a.grossPnlUsd)+" |");}
 lines.push("","Lock skips are Rabbit-only per-symbol lock collisions; detailed counts and samples are in JSON. MTM uses every completed 5m candle close. Fees, slippage, funding, liquidation and portfolio margin simulation are excluded. Matched two-instrument comparison; BTC 4h regime is the shared market filter; trade setups and locks are evaluated independently for BTC and XAUT. XAUT contract began trading 2026-08-05, so this test window starts after listing.");
 await writeFile("artifacts/rabbit-backtest.md",lines.join("\n"));console.log(JSON.stringify(report,null,2));if(!datasets.length)process.exitCode=1;
}
main().catch(e=>{console.error(e);process.exitCode=1;});

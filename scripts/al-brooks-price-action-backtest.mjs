import {writeFile,mkdir} from "node:fs/promises";
import {analyzeBrooksPriceAction} from "../src/al-brooks-price-action.js";

const BASE="https://futures.kraken.com", HOUR=3600000, DAY=86400000, M15=900000, M5=300000;
const FEE=0.0005, SLIPPAGE=0.0003, RISK_USD=10, TARGET_R=1.5, MAX_HOLD_HOURS=48;
const SYMBOL_LIMIT=Math.max(1,Math.min(10,Number(process.env.BROOKS_SYMBOLS||7)));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function getJson(url){
 const res=await fetch(url,{headers:{accept:"application/json"},signal:AbortSignal.timeout(30000)});
 const body=await res.text();if(!res.ok)throw new Error("HTTP "+res.status+" "+url+" "+body.slice(0,120));
 const data=JSON.parse(body);if(data?.result==="error"||data?.errors?.length)throw new Error("Kraken API error "+JSON.stringify(data.errors||data.error));return data;
}
function normalize(rows,interval){
 if(!Array.isArray(rows))throw new Error("Missing candle array");
 const seen=new Set();
 return rows.map(r=>({time:Number(r.time)<1e12?Number(r.time)*1000:Number(r.time),open:Number(r.open),high:Number(r.high),low:Number(r.low),close:Number(r.close),volume:Number(r.volume)}))
 .filter(c=>Number.isFinite(c.time)&&[c.open,c.high,c.low,c.close,c.volume].every(Number.isFinite)&&c.open>0&&c.low>0&&c.high>=Math.max(c.open,c.close,c.low)&&c.low<=Math.min(c.open,c.close)&&c.volume>=0)
 .sort((a,b)=>a.time-b.time).filter(c=>{if(seen.has(c.time)||c.time+interval>Date.now())return false;seen.add(c.time);return true;});
}
async function fetchCandles(symbol,resolution,from,to,interval){
 const chunk=interval*1700,rows=[];
 for(let start=from;start<to;start+=chunk){
  const end=Math.min(to,start+chunk),url=new URL(BASE+"/api/charts/v1/trade/"+encodeURIComponent(symbol)+"/"+resolution);
  url.searchParams.set("from",String(Math.floor(start/1000)));url.searchParams.set("to",String(Math.floor(end/1000)));url.searchParams.set("count","1800");
  const data=await getJson(url);if(data.more_candles===true)throw new Error(symbol+" "+resolution+" incomplete candle chunk");
  rows.push(...normalize(data.candles,interval));await sleep(90);
 }
 return [...new Map(rows.map(c=>[c.time,c])).values()].sort((a,b)=>a.time-b.time);
}
function lowerBound(a,t){let l=0,r=a.length;while(l<r){const m=(l+r)>>1;if(a[m].time<t)l=m+1;else r=m;}return l;}
function metrics(trades){
 const wins=trades.filter(t=>t.netPnlUsd>0),losses=trades.filter(t=>t.netPnlUsd<0);
 const gp=wins.reduce((s,t)=>s+t.netPnlUsd,0),gl=Math.abs(losses.reduce((s,t)=>s+t.netPnlUsd,0));
 let equity=0,peak=0,dd=0;for(const t of [...trades].sort((a,b)=>a.entryTime-b.entryTime)){equity+=t.netPnlUsd;peak=Math.max(peak,equity);dd=Math.max(dd,peak-equity);}
 return {trades:trades.length,wins:wins.length,losses:losses.length,winRatePct:trades.length?100*wins.length/trades.length:0,
 netProfitUsd:trades.reduce((s,t)=>s+t.netPnlUsd,0),grossProfitUsd:gp,grossLossUsd:gl,profitFactor:gl?gp/gl:gp?null:0,
 averageNetPnlUsd:trades.length?trades.reduce((s,t)=>s+t.netPnlUsd,0)/trades.length:0,
 sequentialAdditiveMaxDrawdownUsd:dd,averageHoldHours:trades.length?trades.reduce((s,t)=>s+t.holdHours,0)/trades.length:0,
 targets:trades.filter(t=>t.reason==="TARGET").length,stops:trades.filter(t=>t.reason==="STOP").length,timeExits:trades.filter(t=>t.reason==="TIME").length,
 averageNotionalUsd:trades.length?trades.reduce((s,t)=>s+t.qty*t.entry,0)/trades.length:0,
 maxNotionalUsd:trades.length?Math.max(...trades.map(t=>t.qty*t.entry)):0,
 maxMarginAt10xUsd:trades.length?Math.max(...trades.map(t=>t.qty*t.entry/10)):0};
}
function simulateExit({side,entry,stop,bars,start,maxIndex}){
 const risk=Math.abs(entry-stop),target=side==="LONG"?entry+TARGET_R*risk:entry-TARGET_R*risk;
 let reason="TIME",rawExit=Number(bars[maxIndex]?.close),exitTime=bars[maxIndex]?.time;
 for(let i=start;i<=maxIndex;i++){
  const c=bars[i],o=c.open,stopHit=side==="LONG"?c.low<=stop:c.high>=stop,targetHit=side==="LONG"?c.high>=target:c.low<=target;
  const stopAtOpen=side==="LONG"?o<=stop:o>=stop,targetAtOpen=side==="LONG"?o>=target:o<=target;
  if(stopHit&&(!targetHit||!targetAtOpen||stopAtOpen)){
   rawExit=stopAtOpen?o:stop;reason="STOP";exitTime=c.time;break;
  }
  if(targetHit){rawExit=targetAtOpen?o:target;reason="TARGET";exitTime=c.time;break;}
 }
 const exit=side==="LONG"?rawExit*(1-SLIPPAGE):rawExit*(1+SLIPPAGE);
 const qty=RISK_USD/risk,entryFee=qty*entry*FEE,exitFee=qty*exit*FEE;
 const gross=side==="LONG"?qty*(exit-entry):qty*(entry-exit),netPnlUsd=gross-entryFee-exitFee;
 return {target,exit,exitTime,reason,qty,gross,entryFee,exitFee,netPnlUsd,holdHours:(exitTime-bars[start].time)/HOUR,riskUsd:RISK_USD};
}
function runSymbol(data,days,end){
 const {ticker,m15,m5}=data,start=end-days*DAY,signals=[],trades=[];
 const first=lowerBound(m15,start-90*DAY);let lockedUntil=0,expired=0,invalid=0;
 for(let i=Math.max(60,first);i<m15.length-1;i++){
  const bar=m15[i],signalTime=bar.time+M15;if(signalTime<start||signalTime>end)continue;
  const signal=analyzeBrooksPriceAction(m15.slice(Math.max(0,i-149),i+1));if(!signal)continue;
  signals.push({time:signalTime,side:signal.side,setup:signal.setup,score:signal.score});
  const next=lowerBound(m5,signalTime);if(next>=m5.length||next<lockedUntil)continue;
  const expiry=Math.min(m5.length-1,next+8);let entryIndex=-1,rawEntry=null;
  for(let j=next;j<=expiry;j++){
   const c=m5[j],hit=signal.side==="LONG"?c.high>=signal.entryTrigger:c.low<=signal.entryTrigger;
   if(hit){entryIndex=j;rawEntry=signal.side==="LONG"?Math.max(signal.entryTrigger,c.open):Math.min(signal.entryTrigger,c.open);break;}
  }
  if(entryIndex<0){expired++;continue;}
  const entry=signal.side==="LONG"?rawEntry*(1+SLIPPAGE):rawEntry*(1-SLIPPAGE);
  const stop=signal.stop, risk=signal.side==="LONG"?entry-stop:stop-entry;
  if(!(risk>0)||risk/entry>0.08){invalid++;continue;}
  const maxIndex=Math.min(m5.length-1,entryIndex+MAX_HOLD_HOURS*12);
  const result=simulateExit({side:signal.side,entry,stop,bars:m5,start:entryIndex,maxIndex});
  trades.push({symbol:ticker.symbol,side:signal.side,setup:signal.setup,context:signal.context,score:signal.score,
   signalTime,entryTime:m5[entryIndex].time,entry,stop,target:result.target,riskPct:risk/entry*100,...result});
  lockedUntil=lowerBound(m5,result.exitTime)+1;
 }
 const by=(key)=>Object.fromEntries([...new Set(trades.map(t=>t[key]))].map(v=>[v,metrics(trades.filter(t=>t[key]===v))]));
 return {symbol:ticker.symbol,signalCount:signals.length,filledTrades:trades.length,expiredEntries:expired,invalidRisk:invalid,
  overall:metrics(trades),bySide:by("side"),bySetup:by("setup"),trades};
}
async function main(){
 const end=Date.now(),from=end-(180+90)*DAY;
 const tick=await getJson(BASE+"/derivatives/api/v3/tickers");
 if(!Array.isArray(tick.tickers))throw new Error("Kraken ticker universe unavailable");
 const universe=tick.tickers.filter(t=>t?.tag==="perpetual"&&t.suspended!==true&&/^(PI|PF)_[A-Z0-9]+USD$/.test(String(t.symbol||""))&&Number(t.volumeQuote)>0)
  .sort((a,b)=>Number(b.volumeQuote)-Number(a.volumeQuote)).slice(0,SYMBOL_LIMIT);
 const loaded=[];
 for(const ticker of universe){
  try{const [m15,m5]=await Promise.all([fetchCandles(ticker.symbol,"15m",from,end,M15),fetchCandles(ticker.symbol,"5m",from,end,M5)]);
   if(m15.length<400||m5.length<1500)throw new Error("Insufficient history");loaded.push({ticker,m15,m5});
  }catch(e){loaded.push({ticker,error:String(e.message||e)});}
 }
 const windows={};
 for(const days of [90,180]){
  const results=loaded.map(d=>d.error?{symbol:d.ticker.symbol,error:d.error}:runSymbol(d,days,end));
  const trades=results.flatMap(x=>x.trades||[]).sort((a,b)=>a.entryTime-b.entryTime);
  const group=key=>Object.fromEntries([...new Set(trades.map(t=>t[key]))].map(v=>[v,metrics(trades.filter(t=>t[key]===v))]));
  windows[days+"d"]={period:{from:new Date(end-days*DAY).toISOString(),to:new Date(end).toISOString()},symbolsRequested:SYMBOL_LIMIT,
   symbolsLoaded:loaded.filter(d=>!d.error).length,symbols:results.map(({trades,...r})=>r),overall:metrics(trades),
   bySide:group("side"),bySetup:group("setup"),trades};
 }
 const report={strategy:"Al Brooks inspired price action engine v1",generatedAt:new Date().toISOString(),dataSource:"Kraken Futures historical OHLC",
  assumptions:{signalTimeframe:"15m closed candles",executionTimeframe:"5m",entry:"stop entry above/below signal bar; valid for 9 subsequent 5m bars; gap-aware next candle fill",
   stop:"beyond signal bar with 0.12 ATR buffer",target:"1.5R",riskPerTradeUsd:RISK_USD,maxHoldHours:MAX_HOLD_HOURS,
   feePerSide:FEE,slippagePerSide:SLIPPAGE,exitAmbiguity:"stop-first when stop and target touched in same 5m candle; gap-at-open handled explicitly",
   limitations:["Current-volume universe can introduce survivorship bias","No funding, liquidation, market impact or portfolio concurrency/capital model","$10 risk is per trade and concurrent trades are not portfolio-capped","5m OHLC cannot reveal intrabar path; ambiguous bars use conservative stop-first","Engine is an objective approximation of publicly described Al Brooks concepts, not an exact reproduction of discretionary judgment"]},
  config:{symbolLimit:SYMBOL_LIMIT,targetR:TARGET_R,riskUsd:RISK_USD},windows};
 await mkdir("artifacts",{recursive:true});await writeFile("artifacts/al-brooks-price-action-backtest.json",JSON.stringify(report,null,2));
 console.log(JSON.stringify({generatedAt:report.generatedAt,universe:universe.map(t=>t.symbol),windows:Object.fromEntries(Object.entries(windows).map(([k,v])=>[k,{overall:v.overall,bySide:v.bySide,bySetup:v.bySetup,symbols:v.symbols.map(s=>({symbol:s.symbol,error:s.error,signals:s.signalCount,trades:s.filledTrades}))}]))},null,2));
}
main().catch(e=>{console.error(e);process.exit(1);});

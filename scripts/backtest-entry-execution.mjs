import { mkdir, writeFile } from "node:fs/promises";
import { analyzeFuturesSymbol, FUTURES_CONFIG } from "../src/index.js";

const BASE="https://futures.kraken.com";
const I={ "5m":300000,"15m":900000,"1h":3600000,"4h":14400000 };
const DAYS=Math.max(7,Math.min(180,Number(process.env.ENTRY_DAYS||30)));
const LIMIT=Math.max(1,Math.min(15,Number(process.env.ENTRY_SYMBOLS||10)));
const MARGIN=10, LEVERAGE=10, TARGET_MOVE=0.03, MAX_WAIT=60*60000, MAX_HOLD=24*3600000;

async function get(url){
  for(let n=0;n<4;n++){const r=await fetch(url,{headers:{accept:"application/json"},signal:AbortSignal.timeout(30000)});const t=await r.text();if(r.ok){const j=JSON.parse(t);if(j.result==="error")throw Error(JSON.stringify(j.errors));return j;}if(n===3||!(r.status===429||r.status>=500))throw Error("HTTP "+r.status+" "+t.slice(0,160));await new Promise(x=>setTimeout(x,700*(n+1)));}
}
function norm(rows,ms){const seen=new Set();return (rows||[]).map(x=>({time:Number(x.time)<1e12?Number(x.time)*1000:Number(x.time),open:+x.open,high:+x.high,low:+x.low,close:+x.close,volume:+x.volume})).filter(x=>Number.isFinite(x.time)&&[x.open,x.high,x.low,x.close,x.volume].every(Number.isFinite)&&x.open>0&&x.low>0&&x.high>=x.low&&x.time+ms<=Date.now()).sort((a,b)=>a.time-b.time).filter(x=>{if(seen.has(x.time))return false;seen.add(x.time);return true;});}
async function candles(sym,res,from,to){const ms=I[res],all=[];for(let a=from;a<to;a+=ms*1700){const u=new URL(BASE+"/api/charts/v1/trade/"+encodeURIComponent(sym)+"/"+res);u.searchParams.set("from",String(Math.floor(a/1000)));u.searchParams.set("to",String(Math.floor(Math.min(to,a+ms*1700)/1000)));u.searchParams.set("count","1800");const d=await get(u);if(d.more_candles)throw Error("incomplete "+sym+" "+res);all.push(...norm(d.candles,ms));}return [...new Map(all.map(x=>[x.time,x])).values()].sort((a,b)=>a.time-b.time);}
function lb(a,t){let l=0,h=a.length;while(l<h){let m=(l+h)>>1;if(a[m].time<t)l=m+1;else h=m;}return l;}
function ema(xs,p){if(xs.length<p)return null;let v=xs.slice(0,p).reduce((s,x)=>s+x.close,0)/p;const k=2/(p+1);for(let i=p;i<xs.length;i++)v=xs[i].close*k+v*(1-k);return v;}
function entryAt(side,method,signalClose,m15,m5,baseEntry){
  if(method==="baseline")return {entry:baseEntry,index:lb(m5,signalClose),filled:true};
  const closed=m15.slice(0,lb(m15,signalClose));if(closed.length<30)return {filled:false,reason:"no_ema_history"};
  const e9=ema(closed,9),e21=ema(closed,21),level=method==="ema9"?e9:e21;
  if(!Number.isFinite(level)||level<=0)return {filled:false,reason:"no_ema"};
  const start=lb(m5,signalClose),end=lb(m5,signalClose+MAX_WAIT);
  if(method==="ema9"||method==="ema21"){
    // A retest limit is valid only when the level is on the pullback side of price.
    if((side==="LONG"&&level>=baseEntry)||(side==="SHORT"&&level<=baseEntry))return {filled:false,reason:"level_not_a_pullback"};
    for(let i=start;i<end;i++){const b=m5[i];const hit=side==="LONG"?b.low<=level&&b.high>=level:b.low<=level&&b.high>=level;if(hit)return {filled:true,entry:(side==="LONG"&&b.open<level)||(side==="SHORT"&&b.open>level)?b.open:level,index:i,fillTime:b.time,method};}
    return {filled:false,reason:"not_touched"};
  }
  // EMA21 touch followed by a closed 5m reclaim; fill only at next bar open.
  let touched=false;
  for(let i=start;i<end-1;i++){const b=m5[i];if(side==="LONG"&&b.low<=e21)touched=true;if(side==="SHORT"&&b.high>=e21)touched=true;
    if(touched&&((side==="LONG"&&b.close>e21)||(side==="SHORT"&&b.close<e21)))return {filled:true,entry:m5[i+1].open,index:i+1,fillTime:m5[i+1].time,method};}
  return {filled:false,reason:"no_touch_reclaim"};
}
function simulate(side,entry,stop,bars,start){
  if(!(entry>0&&stop>0)||(side==="LONG"?stop>=entry:stop<=entry))return {outcome:"invalid_stop"};
  const target=side==="LONG"?entry*(1+TARGET_MOVE):entry*(1-TARGET_MOVE);
  const end=Math.min(bars.length,lb(bars,bars[start]?.time+MAX_HOLD));
  for(let i=start;i<end;i++){const b=bars[i];const st=side==="LONG"?b.low<=stop:b.high>=stop;const tp=side==="LONG"?b.high>=target:b.low<=target;
    if(st&&tp)return {outcome:"LOSS",reason:"same_bar_stop_first",barsHeld:i-start+1,target,stop};
    if(st){const fill=side==="LONG"&&b.open<stop?b.open:side==="SHORT"&&b.open>stop?b.open:stop;return {outcome:"LOSS",reason:"STOP",exit:fill,barsHeld:i-start+1,target,stop};}
    if(tp)return {outcome:"WIN",reason:"30pct_margin_target",exit:target,barsHeld:i-start+1,target,stop};
  }
  return {outcome:"TIMEOUT",target,stop,barsHeld:end-start};
}
function summarize(rows){
  const filled=rows.filter(x=>x.fill?.filled&&x.result&&["WIN","LOSS","TIMEOUT"].includes(x.result.outcome));
  const wins=filled.filter(x=>x.result.outcome==="WIN").length,losses=filled.filter(x=>x.result.outcome==="LOSS").length,timeouts=filled.filter(x=>x.result.outcome==="TIMEOUT").length;
  const lossUsd=filled.filter(x=>x.result.outcome==="LOSS").reduce((s,x)=>s+100*Math.abs(x.fill.entry-x.result.exit)/x.fill.entry,0);
  const gross=wins*3-lossUsd;
  return {signals:rows.length,filled:filled.length,missed:rows.length-filled.length,fillRatePct:rows.length?100*filled.length/rows.length:0,wins,losses,timeouts,winRatePct:filled.length?100*wins/filled.length:0,lossRatePct:filled.length?100*losses/filled.length:0,timeoutRatePct:filled.length?100*timeouts/filled.length:0,grossPnlUsd:gross,avgGrossPnlPerOriginalSignalUsd:rows.length?gross/rows.length:0,avgBarsHeld:filled.length?filled.reduce((s,x)=>s+(x.result.barsHeld||0),0)/filled.length:null};
}
async function main(){
 const now=Date.now(),from=now-(DAYS+60)*86400000,to=now;
 const tick=await get(BASE+"/derivatives/api/v3/tickers");
 const universe=(tick.tickers||[]).filter(t=>t.tag==="perpetual"&&t.suspended!==true&&/^PF_[A-Z0-9]+USD$/.test(t.symbol||"")&&+t.last>0).sort((a,b)=>+b.volumeQuote-+a.volumeQuote).slice(0,LIMIT);
 const methods=["baseline","ema9","ema21","ema21_reclaim"],rows=Object.fromEntries(methods.map(m=>[m,[]])),symbolStats=[];
 for(const t of universe){try{
  const [h1,h4,m15,m5]=await Promise.all([candles(t.symbol,"1h",from,to),candles(t.symbol,"4h",from,to),candles(t.symbol,"15m",from,to),candles(t.symbol,"5m",from,to)]);
  let ix4=0,ix15=0,count=0;
  for(let i=60;i<h1.length-1;i++){const c=h1[i],close=c.time+I["1h"];if(close<now-DAYS*86400000||close>=now)continue;
   while(ix4<h4.length&&h4[ix4].time+I["4h"]<=close)ix4++;while(ix15<m15.length&&m15[ix15].time+I["15m"]<=close)ix15++;
   const a4=h4.slice(0,ix4),a15=m15.slice(Math.max(0,ix15-120),ix15);if(a4.length<FUTURES_CONFIG.MIN_CANDLES||a15.length<40)continue;
   const ticker={symbol:t.symbol,last:h1[i+1].open,quoteVolume:h1.slice(Math.max(0,i-23),i+1).reduce((s,x)=>s+x.volume*x.close,0),priceChangePercent:0,premium:{lastFundingRate:null}};
   let sig;try{sig=analyzeFuturesSymbol(ticker,h1.slice(0,i+1),a4,a15);}catch{continue;}
   if(sig?.eligible!==true||!["LONG","SHORT"].includes(sig.side)||!(+sig.stop>0))continue;
   count++;const base=h1[i+1].open;
   for(const method of methods){const fill=entryAt(sig.side,method,close,m15,m5,base);let result=null;
    if(fill.filled){if(method==="baseline")fill.entry=base;result=simulate(sig.side,fill.entry,+sig.stop,m5,fill.index);if(result.outcome==="invalid_stop")fill.filled=false;}
    rows[method].push({symbol:t.symbol,side:sig.side,signalTime:new Date(close).toISOString(),stop:+sig.stop,fill,result,method});
   }
  }
  symbolStats.push({symbol:t.symbol,signals:count,candles:{h1:h1.length,h4:h4.length,m15:m15.length,m5:m5.length}});
 }catch(e){symbolStats.push({symbol:t.symbol,error:String(e.message||e)});}}
 const summary=Object.fromEntries(methods.map(m=>[m,summarize(rows[m])]));
 const bySide={};for(const side of ["LONG","SHORT"]){bySide[side]=Object.fromEntries(methods.map(m=>[m,summarize(rows[m].filter(x=>x.side===side))]));}
 const report={generatedAt:new Date().toISOString(),periodDays:DAYS,universe:universe.map(x=>x.symbol),rules:{marginUsd:MARGIN,leverage:LEVERAGE,notionalUsd:MARGIN*LEVERAGE,targetMarginRoiPct:30,underlyingMovePct:TARGET_MOVE*100,holdHours:24,stopFirstOnSame5mBar:true,originalSignalStopPreserved:true,feesFundingExcluded:true},summary,bySide,symbolStats,records:rows};
 await mkdir("artifacts",{recursive:true});await writeFile("artifacts/entry-execution-report.json",JSON.stringify(report,null,2));
 const lines=["# Entry execution optimization","",`Period: ${DAYS} days | Kraken Futures | 10 USD margin × 10 leverage | target +30% margin ROI (±3% underlying)`,"","Stop is the original signal stop. Same 5m bar touching stop and target is a loss. 24h unresolved trades are timeouts. Fees/funding/slippage excluded.","","| Method | Signals | Filled | Missed | Fill % | Wins | Losses | Timeout | Win % of filled | Gross P/L USD | Avg P/L per original signal |","|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",...methods.map(m=>{const x=summary[m];return `| ${m} | ${x.signals} | ${x.filled} | ${x.missed} | ${x.fillRatePct.toFixed(1)}% | ${x.wins} | ${x.losses} | ${x.timeouts} | ${x.winRatePct.toFixed(1)}% | ${x.grossPnlUsd.toFixed(2)} | ${x.avgGrossPnlPerOriginalSignalUsd.toFixed(3)} |`; }),"","## By side","",...["LONG","SHORT"].flatMap(s=>["","### "+s,"","| Method | Filled | Missed | Win % | Gross P/L |","|---|---:|---:|---:|---:|",...methods.map(m=>{const x=bySide[s][m];return `| ${m} | ${x.filled} | ${x.missed} | ${x.winRatePct.toFixed(1)}% | ${x.grossPnlUsd.toFixed(2)} |`})]),"","## Per-symbol coverage","", "| Symbol | Signals | H1 | H4 | 15m | 5m | Error |","|---|---:|---:|---:|---:|---:|---|",...symbolStats.map(x=>`| ${x.symbol} | ${x.signals||0} | ${x.candles?.h1||"—"} | ${x.candles?.h4||"—"} | ${x.candles?.m15||"—"} | ${x.candles?.m5||"—"} | ${x.error||""} |`),"","## Limitations","- Top symbols selected from current Kraken ticker volume: survivorship/universe bias.","- OHLC 5m data cannot resolve intrabar sequence; stop-first convention is conservative.","- Retest methods use EMA calculated from the last fully closed 15m candle at signal time; no future EMA leakage.","- Baseline uses next 1h open. Retest limit fills use the first 5m candle that touches the fixed EMA level; reclaim fills at the next 5m open.","- Fees, funding, spread, slippage, liquidation and portfolio concurrency are not included.","- Timeout means neither target nor stop within 24h; not counted as win or loss."];
 await writeFile("artifacts/entry-execution-report.md",lines.join("\n"));
 console.log(JSON.stringify({ok:symbolStats.some(x=>x.signals>0),periodDays:DAYS,summary,bySide,symbolStats},null,2));
 if(!symbolStats.some(x=>x.signals>0))process.exitCode=1;
}
main().catch(e=>{console.error(e);process.exitCode=1;});

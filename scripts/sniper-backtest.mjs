import { analyzeFuturesSymbol, FUTURES_CONFIG } from "../src/index.js";
import { mkdir, writeFile } from "node:fs/promises";

const API="https://futures.kraken.com", H=3600000, H4=4*H;
const DAYS=Math.max(15,Math.min(90,Number(process.env.BACKTEST_DAYS||60)));
const LIMIT=Math.max(1,Math.min(24,Number(process.env.BACKTEST_SYMBOLS||24)));
const FEE=Number(process.env.BACKTEST_FEE||0.0005), SLIP=Number(process.env.BACKTEST_SLIPPAGE||0.0003), MAX_HOLD=72;

async function json(url){const r=await fetch(url,{signal:AbortSignal.timeout(25000)});const s=await r.text();if(!r.ok)throw Error("HTTP "+r.status+" "+s.slice(0,160));const d=JSON.parse(s);if(d.result==="error")throw Error(JSON.stringify(d.errors||d.error));return d;}
function normalize(rows,interval){const seen=new Set();return (rows||[]).map(x=>({time:Number(x.time)<1e12?Number(x.time)*1000:Number(x.time),open:+x.open,high:+x.high,low:+x.low,close:+x.close,volume:+x.volume})).filter(x=>Number.isFinite(x.time)&&[x.open,x.high,x.low,x.close,x.volume].every(Number.isFinite)&&x.low>0&&x.high>=x.low&&x.volume>=0).sort((a,b)=>a.time-b.time).filter(x=>{if(seen.has(x.time)||x.time+interval>Date.now())return false;seen.add(x.time);return true;});}
async function candles(symbol,res,from,to,interval){const u=new URL(API+"/api/charts/v1/trade/"+encodeURIComponent(symbol)+"/"+res);u.searchParams.set("from",Math.floor(from/1000));u.searchParams.set("to",Math.floor(to/1000));u.searchParams.set("count","2000");const d=await json(u);if(d.more_candles)throw Error("candle limit exceeded");return normalize(d.candles,interval);}
function ema(a,p){const o=Array(a.length).fill(null),k=2/(p+1);let v=a[0];o[0]=v;for(let i=1;i<a.length;i++){v=a[i]*k+v*(1-k);o[i]=v;}return o;}
function rsi(a,p=14){const o=Array(a.length).fill(null);if(a.length<=p)return o;let g=0,l=0;for(let i=1;i<=p;i++){let d=a[i]-a[i-1];g+=Math.max(d,0);l+=Math.max(-d,0);}g/=p;l/=p;o[p]=l===0?100:100-100/(1+g/l);for(let i=p+1;i<a.length;i++){let d=a[i]-a[i-1];g=(g*(p-1)+Math.max(d,0))/p;l=(l*(p-1)+Math.max(-d,0))/p;o[i]=l===0?100:100-100/(1+g/l);}return o;}
function atr(a,p=14){const o=Array(a.length).fill(null),tr=[];for(let i=1;i<a.length;i++)tr.push(Math.max(a[i].high-a[i].low,Math.abs(a[i].high-a[i-1].close),Math.abs(a[i].low-a[i-1].close)));if(tr.length<p)return o;let v=tr.slice(0,p).reduce((x,y)=>x+y,0)/p;o[p]=v;for(let i=p+1;i<a.length;i++){v=(v*(p-1)+tr[i-1])/p;o[i]=v;}return o;}
function originalSignal(a,i){ // exact lookback semantics in submitted code: breakout bar included in range
 const w=a.slice(i-19,i+1),hi=Math.max(...w.map(x=>x.high)),lo=Math.min(...w.map(x=>x.low)),bar=a[i],avg=w.reduce((s,x)=>s+Math.abs(x.close-x.open),0)/w.length,strong=Math.abs(bar.close-bar.open)>avg*1.5;
 if((hi-lo)/lo*100>=2)return null;
 if(bar.close>hi&&strong)return "LONG";
 if(bar.close<lo&&strong)return "SHORT";
 return null;
}
function correctedSetup(a,i){
 if(i<30)return null;
 const prev=a.slice(i-20,i),bar=a[i],hi=Math.max(...prev.map(x=>x.high)),lo=Math.min(...prev.map(x=>x.low)),range=(hi-lo)/lo*100;
 if(range>=2)return null;
 const avg=prev.reduce((s,x)=>s+Math.abs(x.close-x.open),0)/prev.length;
 const strong=Math.abs(bar.close-bar.open)>avg*1.5;
 let side=null;if(bar.close>hi&&strong)side="LONG";else if(bar.close<lo&&strong)side="SHORT";else return null;
 const vol=prev.reduce((s,x)=>s+x.volume,0),pocBar=prev.reduce((best,x)=>x.volume>best.volume?x:best,prev[0]),poc=pocBar.close;
 const recent=a.slice(Math.max(0,i-10),i);
 const opposite=recent.filter(x=>side==="LONG"?x.close<x.open:x.close>x.open);
 if(!opposite.length)return null;
 const obBar=opposite.at(-1),ob={high:obBar.high,low:obBar.low};
 const fib=side==="LONG"?bar.close-(bar.close-lo)*0.75:bar.close+(hi-bar.close)*0.75;
 const levels=[fib,poc,side==="LONG"?ob.high:ob.low],low=Math.min(...levels),high=Math.max(...levels);
 if(!(low>0)||((high-low)/low*100)>=1)return null;
 const entry=bar.close,stop=side==="LONG"?Math.min(ob.low,bar.low):Math.max(ob.high,bar.high);
 const riskPct=Math.abs(entry-stop)/entry*100;
 if(!(riskPct>0)||!Number.isFinite(riskPct))return null;
 return {side,entry,stop,riskPct,target:entry+(side==="LONG"?1:-1)*Math.abs(entry-stop)*2.5,range,poc,fib,ob,volume:vol};
}
function fill(p,side,entry){const dir=side==="LONG"?1:-1;return p*(1+(entry?dir:-dir)*SLIP);}
function simulate(side,entry,stop,target,bars){
 const dir=side==="LONG"?1:-1,risk=Math.abs(entry-stop);let net=-(FEE*entry/risk),reason="TIME",exitTime=bars.at(-1)?.time??null;
 for(let j=0;j<Math.min(MAX_HOLD,bars.length);j++){const b=bars[j],gap=dir===1?b.open<=stop:b.open>=stop,st=dir===1?b.low<=stop:b.high>=stop,tp=dir===1?b.high>=target:b.low<=target;
 if(gap||st){const px=fill(gap?b.open:stop,side,false);net+=dir*(px-entry)/risk-FEE*px/risk;reason="STOP";exitTime=b.time;break;}
 if(tp){const px=fill(target,side,false);net+=dir*(px-entry)/risk-FEE*px/risk;reason="TARGET";exitTime=b.time;break;}
 if(j===Math.min(MAX_HOLD,bars.length)-1){const px=fill(b.close,side,false);net+=dir*(px-entry)/risk-FEE*px/risk;exitTime=b.time;}
 }
 return {side,netR:net,reason,entryTime:bars[0]?.time??null,exitTime,priceRiskPct:risk/entry*100,marginLossPct:reason==="STOP"?risk/entry*100*10:null,marginTargetPct:Math.abs(target-entry)/entry*100*10};
}
function stats(ts){const wins=ts.filter(x=>x.netR>0),loss=ts.filter(x=>x.netR<0),gw=wins.reduce((s,x)=>s+x.netR,0),gl=-loss.reduce((s,x)=>s+x.netR,0);let eq=0,peak=0,dd=0;for(const t of [...ts].sort((a,b)=>a.entryTime-b.entryTime)){eq+=t.netR;peak=Math.max(peak,eq);dd=Math.max(dd,peak-eq);}return {trades:ts.length,winRate:ts.length?100*wins.length/ts.length:0,netR:ts.reduce((s,x)=>s+x.netR,0),expectancyR:ts.length?ts.reduce((s,x)=>s+x.netR,0)/ts.length:0,profitFactor:gl?gw/gl:gw?null:0,maxDrawdownR:dd,stopRate:ts.length?100*ts.filter(x=>x.reason==="STOP").length/ts.length:0,avgMarginTargetPct:ts.length?ts.reduce((s,x)=>s+x.marginTargetPct,0)/ts.length:0};}
function summary(ts){return {overall:stats(ts),LONG:stats(ts.filter(x=>x.side==="LONG")),SHORT:stats(ts.filter(x=>x.side==="SHORT"))};}
function change(a,i){return a[i-24]?.close>0?(a[i].close/a[i-24].close-1)*100:0;}
async function runSymbol(t,from,to){
 const [h1,h4]=await Promise.all([candles(t.symbol,"1h",from,to,H),candles(t.symbol,"4h",from,to,H4)]);
 if(h1.length<250||h4.length<FUTURES_CONFIG.MIN_CANDLES)throw Error("insufficient candles");
 const original=[],sniper=[],baseline=[];let freeO=220,freeS=220,freeB=220;
 for(let i=220;i<h1.length-1;i++){
  const b=h1[i],next=h1[i+1],entryTime=next.time;
  if(i>=freeO&&originalSignal(h1,i)){/* exact submitted breakout test is mathematically impossible; kept as diagnostic */}
  if(i>=freeS){const setup=correctedSetup(h1,i);if(setup){
    const side=setup.side,entry=fill(next.open,side,true),stop=entry+(setup.stop-setup.entry),target=entry+(setup.target-setup.entry);
    const sim=simulate(side,entry,stop,target,h1.slice(i+1,i+1+MAX_HOLD));Object.assign(sim,{symbol:t.symbol,signalTime:b.time,riskPct:setup.riskPct,rangePct:setup.range});
    sniper.push(sim);freeS=i+1+Math.max(1,Math.ceil((sim.exitTime-entryTime)/H));
  }}
  if(i>=freeB){const closedAt=b.time+H,closed4=h4.filter(x=>x.time+H4<=closedAt);
   if(closed4.length>=FUTURES_CONFIG.MIN_CANDLES){
    const ticker={symbol:t.symbol,last:b.close,quoteVolume:Number(t.volumeQuote)||0,priceChangePercent:change(h1,i),premium:{lastFundingRate:null}};
    const plan=analyzeFuturesSymbol(ticker,h1.slice(0,i+1),closed4);
    if(plan?.eligible){const side=plan.side,dir=side==="LONG"?1:-1,entry=fill(next.open,side,true),risk=Math.abs(plan.entry-plan.stop),stop=entry-dir*risk,target1=entry+dir*risk*1.5,target2=entry+dir*risk*2.5,target3=entry+dir*risk*3.5;
     // Three staged targets, 40/35/25; stop first on ambiguous bars.
     let rem=1,net=-(FEE*entry/risk),reason="TIME",exitTime=null;
     const bars=h1.slice(i+1,i+1+MAX_HOLD);
     for(let j=0;j<bars.length&&rem>1e-9;j++){const x=bars[j],sg=dir===1?x.open<=stop:x.open>=stop,st=dir===1?x.low<=stop:x.high>=stop;
      if(sg||st){const px=fill(sg?x.open:stop,side,false);net+=rem*(dir*(px-entry)/risk-FEE*px/risk);rem=0;reason="STOP";exitTime=x.time;break;}
      for(const [tar,w] of [[target1,.4],[target2,.35],[target3,.25]]){if(rem<=1e-9)break;if(dir===1?x.high>=tar:x.low<=tar){const q=Math.min(rem,w),px=fill(tar,side,false);net+=q*(dir*(px-entry)/risk-FEE*px/risk);rem-=q;}}
      if(rem<=1e-9){reason="TARGETS";exitTime=x.time;break;}
      if(j===bars.length-1){const px=fill(x.close,side,false);net+=rem*(dir*(px-entry)/risk-FEE*px/risk);rem=0;reason="TIME";exitTime=x.time;}
     }
     const sim={side,netR:net,reason,entryTime:entryTime,exitTime:exitTime??bars.at(-1)?.time??entryTime,symbol:t.symbol};baseline.push(sim);freeB=i+1+Math.max(1,Math.ceil(((sim.exitTime??entryTime)-entryTime)/H));
    }
   }
  }
 }
 return {symbol:t.symbol,candles1h:h1.length,candles4h:h4.length,originalAsWrittenSignals:0,correctedSniper:sniper,baseline,correctedStats:summary(sniper),baselineStats:summary(baseline)};
}
async function main(){
 const end=Date.now(),start=end-DAYS*24*H,from=start-15*24*H,d=await json(API+"/derivatives/api/v3/tickers");
 const universe=(d.tickers||[]).filter(t=>t?.tag==="perpetual"&&t.suspended!==true&&/^(PI|PF)_[A-Z0-9]+USD$/.test(String(t.symbol||""))&&Number(t.volumeQuote)>=FUTURES_CONFIG.MIN_QUOTE_VOLUME&&Number(t.last)>0).sort((a,b)=>Number(b.volumeQuote)-Number(a.volumeQuote)).slice(0,LIMIT);
 const results=[];for(const t of universe){try{results.push(await runSymbol(t,from,end));}catch(e){results.push({symbol:t.symbol,error:e.message,correctedSniper:[],baseline:[]});}}
 const allS=results.flatMap(x=>x.correctedSniper||[]).sort((a,b)=>a.entryTime-b.entryTime),allB=results.flatMap(x=>x.baseline||[]).sort((a,b)=>a.entryTime-b.entryTime);
 const report={generatedAt:new Date().toISOString(),venue:"Kraken Derivatives",period:{from:new Date(start).toISOString(),to:new Date(end).toISOString(),days:DAYS},settings:{symbolsRequested:LIMIT,symbolsTested:results.filter(x=>!x.error).length,feePerSidePct:FEE*100,slippagePerSidePct:SLIP*100,maxHoldHours:MAX_HOLD,submittedCodeAsWritten:"0 possible breakout signals because breakout candle is included in consolidation high/low",correctedVariant:"Consolidation uses preceding 20 completed candles, breakout confirmed by current completed candle, entry next 1h open, same Fib/POC/OB confluence, 2.5R target",currentEngine:"analyzeFuturesSymbol, 4h + 1h closed candles, staged 40/35/25 exits",leverage:10,marginROI:"Actual price move multiplied by 10; no fixed +25% target or -10% stop enforced by submitted code",funding:"excluded",universeBias:"current liquidity universe"},originalAsWrittenSignals:0,correctedSniper:summary(allS),currentEngine:summary(allB),symbols:results.map(x=>({symbol:x.symbol,error:x.error,candles1h:x.candles1h,candles4h:x.candles4h,corrected:x.correctedStats,current:x.baselineStats,correctedTrades:x.correctedSniper,currentTrades:x.baseline}))};
 await mkdir("artifacts",{recursive:true});await writeFile("artifacts/sniper-backtest.json",JSON.stringify(report,null,2));
 const f=x=>x==null?"n/a":Number(x).toFixed(2),rows=[ "# Sniper breakout vs current engine","", "Period: "+report.period.from+" to "+report.period.to,"Symbols tested: "+report.settings.symbolsTested+"/"+LIMIT,"","**Original code as written:** 0 possible breakout signals due to self-including consolidation range.","","| Metric | Current engine | Corrected Sniper |","|---|---:|---:|","| Trades | "+report.currentEngine.overall.trades+" | "+report.correctedSniper.overall.trades+" |","| Win rate | "+f(report.currentEngine.overall.winRate)+"% | "+f(report.correctedSniper.overall.winRate)+"% |","| Net R | "+f(report.currentEngine.overall.netR)+" | "+f(report.correctedSniper.overall.netR)+" |","| Expectancy R | "+f(report.currentEngine.overall.expectancyR)+" | "+f(report.correctedSniper.overall.expectancyR)+" |","| PF | "+f(report.currentEngine.overall.profitFactor)+" | "+f(report.correctedSniper.overall.profitFactor)+" |","| Max DD R | "+f(report.currentEngine.overall.maxDrawdownR)+" | "+f(report.correctedSniper.overall.maxDrawdownR)+" |","", "## Direction breakdown","| Model | Side | Trades | Win % | Net R | PF |","|---|---|---:|---:|---:|---:|",...["currentEngine","correctedSniper"].flatMap(k=>["LONG","SHORT"].map(s=>{const x=report[k][s];return "| "+k+" | "+s+" | "+x.trades+" | "+f(x.winRate)+" | "+f(x.netR)+" | "+f(x.profitFactor)+" |";})),"","## Caveats","- The corrected version changes only the consolidation lookback timing so a breakout can be detected; it is not the exact code as written.","- POC remains a proxy (close of the single highest-volume candle), not a true volume-profile POC.","- Order block remains the last opposite candle, not a displacement/structure-validated order block.","- Funding excluded; today's liquid universe creates survivorship bias; stop-first if stop and target are both hit in one 1h bar.","- Margin target +25% and stop -10% are not enforced in submitted logic; results are price/R-based and report actual margin move as 10x price move.","","| Symbol | Corrected trades | Corrected PF | Current trades | Current PF | Error |", "|---|---:|---:|---:|---:|---|",...results.map(x=>"| "+x.symbol+" | "+(x.correctedStats?.overall.trades??0)+" | "+f(x.correctedStats?.overall.profitFactor)+" | "+(x.baselineStats?.overall.trades??0)+" | "+f(x.baselineStats?.overall.profitFactor)+" | "+(x.error||"")+" |")];
 await writeFile("artifacts/sniper-backtest.md",rows.join("\n"));
 console.log(JSON.stringify({ok:true,period:report.period,tested:report.settings.symbolsTested,originalAsWrittenSignals:0,corrected:report.correctedSniper,current:report.currentEngine,errors:results.filter(x=>x.error).map(x=>({symbol:x.symbol,error:x.error}))},null,2));
}
if(process.argv[1]?.endsWith("sniper-backtest.mjs"))main().catch(e=>{console.error(e);process.exitCode=1;});

import { analyzeFuturesSymbol, FUTURES_CONFIG } from "../src/index.js";
import { evaluateShortTfConfirmation } from "../src/short-tf-confirmation.js";
import { mkdir, writeFile } from "node:fs/promises";

const BASE="https://futures.kraken.com", H=3_600_000, H4=14_400_000, M1=60_000, M5=300_000, M15=900_000;
const DAYS=Math.max(14,Math.min(120,Number(process.env.BACKTEST_DAYS||30)));
const END=process.env.BACKTEST_END?Date.parse(process.env.BACKTEST_END):Date.now();
const START=process.env.BACKTEST_START?Date.parse(process.env.BACKTEST_START):END-DAYS*24*H;
const SYMBOL_LIMIT=Math.max(1,Math.min(8,Number(process.env.BACKTEST_SYMBOLS||6)));
const FEE=Number(process.env.BACKTEST_FEE??0.0005), SLIP=Number(process.env.BACKTEST_SLIPPAGE??0.0003);
const MAX_SETUP_AGE=90*60_000, HOLD_M1=72*60, HOLD_M15=72*4; // identical settings for in-sample and out-of-sample runs

if(!Number.isFinite(START)||!Number.isFinite(END)||END<=START) throw Error("Invalid backtest period");

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function json(url){
  const r=await fetch(url,{headers:{accept:"application/json"},signal:AbortSignal.timeout(30_000)});
  const body=await r.text();
  if(!r.ok) throw Error("Kraken HTTP "+r.status+": "+body.slice(0,180));
  const d=JSON.parse(body);
  if(d?.result==="error"||d?.errors?.length) throw Error("Kraken API error");
  return d;
}
function normalize(rows,interval){
  const seen=new Set();
  return (rows||[]).map(x=>({time:Number(x.time)<1e12?Number(x.time)*1000:Number(x.time),open:+x.open,high:+x.high,low:+x.low,close:+x.close,volume:+x.volume}))
    .filter(c=>[c.time,c.open,c.high,c.low,c.close,c.volume].every(Number.isFinite)&&c.open>0&&c.low>0&&c.high>=c.low&&c.close>0&&c.volume>=0&&c.time+interval<=END)
    .sort((a,b)=>a.time-b.time).filter(c=>{if(seen.has(c.time))return false;seen.add(c.time);return true;});
}
async function fetchCandles(symbol,resolution,from,to,interval){
  const out=[],chunk=interval*1700;
  for(let s=from;s<to;s+=chunk){
    const u=new URL(BASE+"/api/charts/v1/trade/"+encodeURIComponent(symbol)+"/"+resolution);
    u.searchParams.set("from",String(Math.floor(s/1000)));
    u.searchParams.set("to",String(Math.floor(Math.min(to,s+chunk)/1000)));
    u.searchParams.set("count","1800");
    const d=await json(u);
    if(d.more_candles) throw Error("Kraken returned more_candles for "+resolution+" chunk");
    out.push(...normalize(d.candles,interval));
    await sleep(120);
  }
  return [...new Map(out.map(c=>[c.time,c])).values()].sort((a,b)=>a.time-b.time);
}
function ema(v,p){if(v.length<p)return null;const k=2/(p+1);let x=v.slice(0,p).reduce((a,b)=>a+b,0)/p;for(let i=p;i<v.length;i++)x=v[i]*k+x*(1-k);return x;}
function atr(cs,p=14){if(cs.length<=p)return null;const tr=[];for(let i=1;i<cs.length;i++){const c=cs[i],q=cs[i-1].close;tr.push(Math.max(c.high-c.low,Math.abs(c.high-q),Math.abs(c.low-q)));}const a=tr.slice(-p);return a.reduce((x,y)=>x+y,0)/a.length;}
function change(cs,i){return cs[i-24]?.close?((cs[i].close/cs[i-24].close)-1)*100:0;}
function levels(c,entry,h1,i){
  const w=h1.slice(Math.max(0,i-7),i),lo=Math.min(...w.map(x=>x.low)),hi=Math.max(...w.map(x=>x.high)),d=c.side==="LONG"?1:-1;
  const stop=d===1?Math.min(lo,entry-c.atr*1.5):Math.max(hi,entry+c.atr*1.5),risk=d===1?entry-stop:stop-entry;
  if(!(risk>0)||risk/entry<.002||risk/entry>.08)return null;
  return{entry,stop,risk,t1:entry+d*risk*1.5,t2:entry+d*risk*2.5,t3:entry+d*risk*3.5};
}
function simulate(side,l,cs,start,maxHold,interval){
  if(start<0||start>=cs.length)return null;
  const d=side==="LONG"?1:-1,e=l.entry*(1+d*SLIP),risk=d===1?e-l.stop:l.stop-e;
  if(risk<=0)return null;
  let left=1,net=0,hits=0,mae=0,ttp=null,reason="TIME_EXIT",exit=null;
  const targets=[l.t1,l.t2,l.t3],remain=[.4,.35,.25],end=Math.min(cs.length-1,start+maxHold);
  for(let i=start;i<=end&&left>1e-8;i++){
    const c=cs[i],adv=d===1?Math.max(0,e-c.low):Math.max(0,c.high-e);
    mae=Math.max(mae,adv/risk);
    if(ttp===null&&(d===1?c.close>e*(1+2*FEE+2*SLIP):c.close<e*(1-2*FEE-2*SLIP)))ttp=(c.time-cs[start].time)/60_000;
    const gap=d===1?c.open<=l.stop:c.open>=l.stop,touch=d===1?c.low<=l.stop:c.high>=l.stop;
    if(gap||touch){const px=gap?c.open:l.stop,fill=px*(1-d*SLIP);net+=left*(d*(fill-e)/risk-FEE*(e+fill)/risk);left=0;reason="STOP";exit=c.time;break;}
    for(let t=0;t<3&&left>1e-8;t++){if(!(d===1?c.high>=targets[t]:c.low<=targets[t]))continue;const wt=Math.min(left,remain[t]),fill=targets[t]*(1-d*SLIP);net+=wt*(d*(fill-e)/risk-FEE*(e+fill)/risk);left-=wt;remain[t]=0;hits++;}
    if(left<=1e-8){left=0;reason="TARGETS";exit=c.time;break;}
    if(i===end){const fill=c.close*(1-d*SLIP);net+=left*(d*(fill-e)/risk-FEE*(e+fill)/risk);left=0;exit=c.time;}
  }
  return{side,netR:net,targetHits:hits,maeR:mae,timeToProfitMin:ttp,exitReason:reason,entryTime:cs[start].time,exitTime:exit};
}
function median(a){a=a.filter(Number.isFinite).sort((x,y)=>x-y);return a.length?(a.length%2?a[(a.length-1)/2]:(a[a.length/2-1]+a[a.length/2])/2):null;}
function metrics(ts){
  const n=ts.length,w=ts.filter(x=>x.netR>0),los=ts.filter(x=>x.netR<0),grossWin=w.reduce((s,x)=>s+x.netR,0),grossLoss=Math.abs(los.reduce((s,x)=>s+x.netR,0)),sum=k=>ts.reduce((s,x)=>s+(Number.isFinite(x[k])?x[k]:0),0);
  return{trades:n,wins:w.length,winRatePct:n?w.length/n*100:0,netR:sum("netR"),expectancyR:n?sum("netR")/n:0,profitFactor:grossLoss?grossWin/grossLoss:grossWin?null:0,avgMAE_R:n?sum("maeR")/n:null,medianMAE_R:median(ts.map(x=>x.maeR)),medianTimeToProfitMin:median(ts.map(x=>x.timeToProfitMin)),timeToProfitCoveragePct:n?ts.filter(x=>x.timeToProfitMin!==null).length/n*100:0,tp1HitRatePct:n?ts.filter(x=>x.targetHits>0).length/n*100:0,bySide:Object.fromEntries(["LONG","SHORT"].map(side=>{const a=ts.filter(x=>x.side===side),k=a.length;return[side,{trades:k,winRatePct:k?a.filter(x=>x.netR>0).length/k*100:0,expectancyR:k?a.reduce((s,x)=>s+x.netR,0)/k:0,avgMAE_R:k?a.reduce((s,x)=>s+x.maeR,0)/k:null}]}))};
}
function firstAtOrAfter(rows,time){let lo=0,hi=rows.length;while(lo<hi){const mid=(lo+hi)>>1;if(rows[mid].time<time)lo=mid+1;else hi=mid;}return lo<rows.length?lo:-1;}

async function runSymbol(t,from,to){
  const warm=25*24*H,fetchFrom=from-warm;
  const h1=await fetchCandles(t.symbol,"1h",fetchFrom,to,H);
  const h4=await fetchCandles(t.symbol,"4h",fetchFrom,to,H4);
  const m15=await fetchCandles(t.symbol,"15m",fetchFrom,to,M15);
  const m5=await fetchCandles(t.symbol,"5m",fetchFrom,to,M5);
  const m1=await fetchCandles(t.symbol,"1m",fetchFrom,to,M1);
  if(h1.length<100||h4.length<FUTURES_CONFIG.MIN_CANDLES||m15.length<500||m5.length<1500||m1.length<5000)throw Error("Insufficient history; 1m candles="+m1.length);
  const baseline=[],confirmed=[];
  const counts={eligibleSetups:0,baselineEntries:0,confirmedEntries:0,expiredOrMissed:0,noChase:0,riskRejected:0};
  let cursor15=0,busyBase=0,busyConfirm=0;
  for(let i=60;i<h1.length-1;i++){
    const b=h1[i],closeTime=b.time+H,n=h1[i+1];
    if(closeTime<from||closeTime>=to)continue;
    while(cursor15<m15.length&&m15[cursor15].time+M15<=closeTime)cursor15++;
    const h4c=h4.filter(x=>x.time+H4<=closeTime);
    if(h4c.length<FUTURES_CONFIG.MIN_CANDLES)continue;
    const past=m15.slice(Math.max(0,cursor15-140),cursor15);
    const tk={symbol:t.symbol,last:n.open,quoteVolume:Number(t.volumeQuote)||0,priceChangePercent:change(h1,i),premium:{lastFundingRate:null}};
    const candidate=analyzeFuturesSymbol(tk,h1.slice(0,i+1),h4c,past,{skipEntryFilters:true});
    if(!candidate?.eligible)continue;
    const liveCandidate=analyzeFuturesSymbol(tk,h1.slice(0,i+1),h4c,past);
    if(!liveCandidate?.eligible)continue;
    counts.eligibleSetups++;
    const setupTime=n.time,baseIndex=firstAtOrAfter(m15,setupTime);
    if(baseIndex<0)continue;
    if(setupTime>=busyBase){
      const l=levels(liveCandidate,n.open,h1,i);
      if(l){const tr=simulate(liveCandidate.side,l,m15,baseIndex,HOLD_M15,M15);if(tr){tr.symbol=t.symbol;baseline.push(tr);busyBase=tr.exitTime;counts.baselineEntries++;}}
    }
    if(setupTime<busyConfirm)continue;
    let result=null,refIndex=-1;
    const end=Math.min(setupTime+MAX_SETUP_AGE,to-M1);
    for(let evalNow=setupTime+M1+1;evalNow<=end;evalNow+=M1){
      const quoteTime=evalNow-1,qi=firstAtOrAfter(m1,quoteTime);
      if(qi<0||m1[qi].time!==quoteTime)continue;
      const q5=firstAtOrAfter(m5,evalNow),q15=firstAtOrAfter(m15,evalNow);
      const hist1=m1.slice(Math.max(0,qi-80),qi+1);
      const hist5=m5.slice(Math.max(0,(q5<0?m5.length:q5)-80),q5<0?m5.length:q5+1);
      const hist15=m15.slice(Math.max(0,(q15<0?m15.length:q15)-80),q15<0?m15.length:q15+1);
      result=evaluateShortTfConfirmation({side:liveCandidate.side,candles1m:hist1,candles5m:hist5,candles15m:hist15,setupTime,now:evalNow,referencePrice:m1[qi].open,maxSetupAgeMs:MAX_SETUP_AGE});
      if(result.status==="CONFIRMED"){refIndex=qi;break;}
      if(result.status==="EXPIRED"){if(result.reason==="ENTRY_TOO_FAR_NO_CHASE")counts.noChase++;break;}
      if(String(result.reason||"").startsWith("EXPIRED_"))break;
    }
    if(result?.status==="CONFIRMED"&&refIndex>=0){
      const l=levels(liveCandidate,result.entryReference,h1,i),entryIndex=firstAtOrAfter(m1,result.triggerTime+M1);
      if(!l||entryIndex<0){counts.riskRejected++;continue;}
      const tr=simulate(liveCandidate.side,l,m1,entryIndex,HOLD_M1,M1);
      if(tr){tr.symbol=t.symbol;tr.triggerTime=result.triggerTime;tr.pullback15mTime=result.pullback15mTime;tr.confirmation5mTime=result.confirmation5mTime;confirmed.push(tr);busyConfirm=tr.exitTime;counts.confirmedEntries++;}
    }else counts.expiredOrMissed++;
  }
  return{symbol:t.symbol,candles:{h1:h1.length,h4:h4.length,m15:m15.length,m5:m5.length,m1:m1.length},counts,baseline,confirmed,baselineMetrics:metrics(baseline),confirmedMetrics:metrics(confirmed)};
}
async function main(){
  const tick=await json(BASE+"/derivatives/api/v3/tickers");
  if(!Array.isArray(tick.tickers))throw Error("Invalid Kraken ticker response");
  const universe=tick.tickers.filter(t=>t?.tag==="perpetual"&&t.suspended!==true&&/^(PI|PF)_[A-Z0-9]+USD$/.test(String(t.symbol||""))&&Number(t.volumeQuote)>=FUTURES_CONFIG.MIN_QUOTE_VOLUME&&Number(t.last)>0)
    .sort((a,b)=>Number(b.volumeQuote)-Number(a.volumeQuote)).slice(0,SYMBOL_LIMIT);
  const results=[];
  for(const t of universe){try{results.push(await runSymbol(t,START,END));}catch(e){results.push({symbol:t.symbol,error:String(e.message||e)});}}
  const all=k=>results.flatMap(x=>x[k]||[]),report={
    generatedAt:new Date().toISOString(),venue:"Kraken public futures OHLCV",
    period:{from:new Date(START).toISOString(),to:new Date(END).toISOString(),days:(END-START)/H/24},
    settings:{symbolsRequested:SYMBOL_LIMIT,symbolsTested:results.filter(x=>!x.error).length,feePerSide:FEE,slippagePerSide:SLIP,maxHoldHours:72,maxSetupAgeMinutes:90,sequence:"15m pullback → 5m recovery → 1m breakout; closed candles only; no chase",baseline:"current eligible setup at next 15m open",funding:"excluded",sameCandleRule:"stop first",universe:"present-day top-volume Kraken perpetuals; survivorship bias applies"},
    counts:{eligibleSetups:results.reduce((s,x)=>s+(x.counts?.eligibleSetups||0),0),baselineEntries:results.reduce((s,x)=>s+(x.counts?.baselineEntries||0),0),confirmedEntries:results.reduce((s,x)=>s+(x.counts?.confirmedEntries||0),0),expiredOrMissed:results.reduce((s,x)=>s+(x.counts?.expiredOrMissed||0),0),noChase:results.reduce((s,x)=>s+(x.counts?.noChase||0),0),riskRejected:results.reduce((s,x)=>s+(x.counts?.riskRejected||0),0)},
    baseline:metrics(all("baseline")),confirmed:metrics(all("confirmed")),
    symbols:results.map(({baseline,confirmed,...x})=>x)
  };
  await mkdir("artifacts",{recursive:true});
  await writeFile("artifacts/short-tf-confirmation-backtest.json",JSON.stringify(report,null,2));
  const keys=["trades","winRatePct","expectancyR","profitFactor","avgMAE_R","medianMAE_R","medianTimeToProfitMin","tp1HitRatePct","netR"];
  const md=["# 1m / 5m / 15m confirmation backtest","Period: "+report.period.from+" to "+report.period.to,"Symbols tested: "+report.settings.symbolsTested+"/"+SYMBOL_LIMIT,"","| Metric | Baseline | 15m→5m→1m confirmation |","|---|---:|---:|",...keys.map(k=>"| "+k+" | "+(report.baseline[k]??"—")+" | "+(report.confirmed[k]??"—")+" |"),"","Eligible setups: "+report.counts.eligibleSetups,"Baseline entries: "+report.counts.baselineEntries,"Confirmed entries: "+report.counts.confirmedEntries,"Expired/missed: "+report.counts.expiredOrMissed,"No-chase expiries: "+report.counts.noChase,"Risk rejected: "+report.counts.riskRejected,"","LONG/SHORT metrics and per-symbol details are in JSON. Fees and slippage are applied; funding is excluded. Stop is assumed first on ambiguous candles.","","Limitations: present-day universe creates survivorship bias; OHLCV cannot reveal exact intrabar ordering; fills are approximated. Results are exploratory, not a profitability guarantee. Run a separate non-overlapping OOS period before considering production."];
  await writeFile("artifacts/short-tf-confirmation-backtest.md",md.join("\n"));
  console.log(JSON.stringify({ok:true,period:report.period,settings:report.settings,counts:report.counts,baseline:report.baseline,confirmed:report.confirmed,symbols:report.symbols.map(x=>({symbol:x.symbol,error:x.error,counts:x.counts}))},null,2));
}
main().catch(e=>{console.error(e);process.exitCode=1;});

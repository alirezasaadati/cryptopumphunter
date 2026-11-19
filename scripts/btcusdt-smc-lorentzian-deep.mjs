import { analyzeFuturesSymbol } from "../src/index.js";
import { buildSmcStructure } from "../src/smc-structure-benchmark.js";
import { mkdir, writeFile, readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
const BASE="https://fapi.binance.com", SYMBOL="BTCUSDT", HOUR=3600000, FOUR_HOURS=14400000;
const DAYS=365,WARMUP_DAYS=30,MAX_HOLD_HOURS=72,FEE=.0005,SLIPPAGE=.0003;
const VARIANTS=[
{id:"baseline",label:"Current engine baseline"},
{id:"smc_h1_internal5_state",label:"SMC H1 internal 5 — structure state",smc:{tf:"h1",length:5,mode:"state"}},
{id:"smc_h1_swing10_state",label:"SMC H1 swing 10 — structure state",smc:{tf:"h1",length:10,mode:"state"}},
{id:"smc_h1_swing20_state",label:"SMC H1 swing 20 — structure state",smc:{tf:"h1",length:20,mode:"state"}},
{id:"smc_h1_swing50_state",label:"SMC H1 swing 50 — structure state",smc:{tf:"h1",length:50,mode:"state"}},
{id:"smc_h1_swing10_recent6",label:"SMC H1 swing 10 — break within 6 bars",smc:{tf:"h1",length:10,mode:"recent",age:6}},
{id:"smc_m15_internal5_state",label:"SMC M15 internal 5 — structure state",smc:{tf:"m15",length:5,mode:"state"}},
{id:"smc_m15_swing10_state",label:"SMC M15 swing 10 — structure state",smc:{tf:"m15",length:10,mode:"state"}},
{id:"smc_h1_10_m15_5_align",label:"SMC H1 swing 10 + M15 internal 5 alignment",smcCombo:[{tf:"h1",length:10},{tf:"m15",length:5}]},
{id:"smc_h1_10_choch12",label:"SMC H1 swing 10 — CHoCH within 12 bars",smc:{tf:"h1",length:10,mode:"choch",age:12}},
{id:"lor_h1_default",label:"Lorentzian jdehorty H1 — defaults",lor:{tf:"h1",key:"h1_default",mode:"direction"}},
{id:"lor_h1_entry_event",label:"Lorentzian jdehorty H1 — fresh buy/sell event",lor:{tf:"h1",key:"h1_default",mode:"event"}},
{id:"lor_h1_no_kernel",label:"Lorentzian H1 — kernel filter OFF",lor:{tf:"h1",key:"h1_no_kernel",mode:"direction"}},
{id:"lor_h1_k12",label:"Lorentzian H1 — 12 neighbors",lor:{tf:"h1",key:"h1_k12",mode:"direction"}},
{id:"lor_h1_k5",label:"Lorentzian H1 — 5 neighbors",lor:{tf:"h1",key:"h1_k5",mode:"direction"}},
{id:"lor_h1_features4",label:"Lorentzian H1 — 4 features",lor:{tf:"h1",key:"h1_features4",mode:"direction"}},
{id:"lor_h1_regime_off",label:"Lorentzian H1 — regime filter OFF",lor:{tf:"h1",key:"h1_regime_off",mode:"direction"}},
{id:"lor_h1_volatility_off",label:"Lorentzian H1 — volatility filter OFF",lor:{tf:"h1",key:"h1_volatility_off",mode:"direction"}},
{id:"lor_h1_adx20",label:"Lorentzian H1 — ADX filter ON (20)",lor:{tf:"h1",key:"h1_adx20",mode:"direction"}},
{id:"lor_h1_ema200",label:"Lorentzian H1 — EMA200 filter ON",lor:{tf:"h1",key:"h1_ema200",mode:"direction"}},
{id:"lor_m15_default",label:"Lorentzian jdehorty M15 — defaults",lor:{tf:"m15",key:"m15_default",mode:"direction"}},
{id:"lor_m15_no_kernel",label:"Lorentzian M15 — kernel filter OFF",lor:{tf:"m15",key:"m15_no_kernel",mode:"direction"}},
{id:"lor_h1_m15_align",label:"Lorentzian H1 + M15 directional alignment",lorCombo:["h1_default","m15_default"]}
];
async function getJson(url){const r=await fetch(url,{headers:{accept:"application/json"},signal:AbortSignal.timeout(25000)});const body=await r.text();if(!r.ok)throw new Error("Binance HTTP "+r.status+": "+body.slice(0,200));const d=JSON.parse(body);if(!Array.isArray(d))throw new Error("Unexpected Binance kline response");return d;}
function parseCsvCandles(csv,interval){
 const rows=[];
 for(const line of csv.split(/\r?\n/)){
  if(!line||!/^\d+,/.test(line))continue;
  const x=line.split(",");if(x.length<7)continue;
  const c={time:+x[0],open:+x[1],high:+x[2],low:+x[3],close:+x[4],volume:+x[5],closeTime:+x[6]};
  if([c.time,c.open,c.high,c.low,c.close,c.volume,c.closeTime].every(Number.isFinite)&&c.open>0&&c.low>0&&c.high>=c.low&&c.close>0&&c.volume>=0&&c.closeTime<Date.now())rows.push(c);
 }
 return rows;
}
async function fetchKlines(interval,fromMs,toMs){
 const dir=await mkdtemp(join(tmpdir(),"btc-klines-")),all=[];
 try{
  const first=new Date(fromMs),last=new Date(toMs);
  let month=new Date(Date.UTC(first.getUTCFullYear(),first.getUTCMonth(),1));
  const currentMonth=Date.UTC(last.getUTCFullYear(),last.getUTCMonth(),1);
  while(month.getTime()<currentMonth){
   const y=month.getUTCFullYear(),m=String(month.getUTCMonth()+1).padStart(2,"0");
   const file=SYMBOL+"-"+interval+"-"+y+"-"+m+".zip";
   const url="https://data.binance.vision/data/futures/um/monthly/klines/"+SYMBOL+"/"+interval+"/"+file;
   const response=await fetch(url,{signal:AbortSignal.timeout(30000)});
   if(response.status===404)throw new Error("Binance Vision monthly archive missing: "+file);
   if(!response.ok)throw new Error("Binance Vision HTTP "+response.status+" for "+file);
   const path=join(dir,file);await writeFile(path,Buffer.from(await response.arrayBuffer()));
   const csv=execFileSync("unzip",["-p",path],{encoding:"utf8",maxBuffer:128*1024*1024});
   all.push(...parseCsvCandles(csv,interval));
   month=new Date(Date.UTC(y,month.getUTCMonth()+1,1));
  }
  const day=new Date(Date.UTC(last.getUTCFullYear(),last.getUTCMonth(),1));
  while(day.getTime()<toMs){
   const y=day.getUTCFullYear(),m=String(day.getUTCMonth()+1).padStart(2,"0"),d=String(day.getUTCDate()).padStart(2,"0");
   const file=SYMBOL+"-"+interval+"-"+y+"-"+m+"-"+d+".zip";
   const url="https://data.binance.vision/data/futures/um/daily/klines/"+SYMBOL+"/"+interval+"/"+file;
   const response=await fetch(url,{signal:AbortSignal.timeout(30000)});
   if(response.status===404){day.setUTCDate(day.getUTCDate()+1);continue;}
   if(!response.ok)throw new Error("Binance Vision HTTP "+response.status+" for "+file);
   const path=join(dir,file);await writeFile(path,Buffer.from(await response.arrayBuffer()));
   const csv=execFileSync("unzip",["-p",path],{encoding:"utf8",maxBuffer:32*1024*1024});
   all.push(...parseCsvCandles(csv,interval));day.setUTCDate(day.getUTCDate()+1);
  }
 }finally{await rm(dir,{recursive:true,force:true});}
 const unique=new Map(all.filter(c=>c.time>=fromMs&&c.time<toMs).map(c=>[c.time,c]));
 return [...unique.values()].sort((x,y)=>x.time-y.time);
}
function summarize(ts){const w=ts.filter(t=>t.netR>0),l=ts.filter(t=>t.netR<0),gw=w.reduce((s,t)=>s+t.netR,0),gl=Math.abs(l.reduce((s,t)=>s+t.netR,0));let e=0,p=0,dd=0;for(const t of ts){e+=t.netR;p=Math.max(p,e);dd=Math.max(dd,p-e);}return{trades:ts.length,wins:w.length,losses:l.length,winRatePct:ts.length?w.length/ts.length*100:0,netR:ts.reduce((s,t)=>s+t.netR,0),expectancyR:ts.length?ts.reduce((s,t)=>s+t.netR,0)/ts.length:0,profitFactor:gl?gw/gl:gw?null:0,maxDrawdownR:dd};}
function simulate({side,entry,stop,targets,candles}){
 const dir=side==="LONG"?1:-1,risk=dir===1?entry-stop:stop-entry;
 if(!(risk>0)||!candles.length)return null;
 let rem=1,net=0,hits=0,reason="TIME_EXIT",exitTime=null;
 const feeR=p=>FEE*(entry+p)/risk;
 const close=(raw,time)=>{const fill=raw*(1-dir*SLIPPAGE);net+=rem*(dir*(fill-entry)/risk-feeR(fill));rem=0;exitTime=time;};
 for(let i=0;i<Math.min(candles.length,MAX_HOLD_HOURS+1)&&rem>1e-9;i++){
  const bar=candles[i],gap=dir===1?bar.open<=stop:bar.open>=stop,touch=dir===1?bar.low<=stop:bar.high>=stop;
  if(gap||touch){close(gap?bar.open:stop,bar.time);reason="STOP";break;}
  for(let k=0;k<3&&rem>1e-9;k++){
   const target=targets[k],hit=dir===1?bar.high>=target:bar.low<=target;if(!hit)break;
   const weight=[.4,.35,.25][k],fill=target*(1-dir*SLIPPAGE);
   net+=weight*(dir*(fill-entry)/risk-feeR(fill));rem-=weight;hits++;
  }
  if(rem<=1e-9){rem=0;reason="TARGETS";exitTime=bar.time;break;}
  if(i===Math.min(candles.length-1,MAX_HOLD_HOURS)){close(bar.close,bar.time);}
 }
 if(rem>1e-9){const bar=candles[Math.min(candles.length-1,MAX_HOLD_HOURS)];close(bar.close,bar.time);}
 return{side,entry,stop,risk,netR:net,targetHits:hits,exitReason:reason,entryTime:candles[0].time,exitTime};
}
function bySide(ts){return{LONG:summarize(ts.filter(t=>t.side==="LONG")),SHORT:summarize(ts.filter(t=>t.side==="SHORT"))};}
async function main(){const now=Date.now(),start=now-DAYS*24*HOUR,from=start-WARMUP_DAYS*24*HOUR;const [h1,h4,m15]=await Promise.all([fetchKlines("1h",from,now),fetchKlines("4h",from,now),fetchKlines("15m",from,now)]);if(h1.length<DAYS*20||h4.length<DAYS*4||m15.length<DAYS*80)throw new Error("Insufficient BTCUSDT candles: 1h="+h1.length+", 4h="+h4.length+", 15m="+m15.length);const tmp=await mkdtemp(join(tmpdir(),"smc-lorentzian-")),h1csv=join(tmp,"h1.csv"),m15csv=join(tmp,"m15.csv"),lorJson=join(tmp,"lorentzian.json");
const csvFor=bars=>"time,open,high,low,close\n"+bars.map(c=>[new Date(c.time).toISOString(),c.open,c.high,c.low,c.close].join(",")).join("\n")+"\n";
await writeFile(h1csv,csvFor(h1));await writeFile(m15csv,csvFor(m15));
try{
execFileSync("python3",["scripts/run-lorentzian-series.py",h1csv,lorJson,"h1"],{stdio:"inherit",env:{...process.env,PYTHONPATH:"scripts/vendor"}});const h1Lor=JSON.parse(await readFile(lorJson,"utf8"));
const lorM15Json=join(tmp,"lorentzian-m15.json");execFileSync("python3",["scripts/run-lorentzian-series.py",m15csv,lorM15Json,"m15"],{stdio:"inherit",env:{...process.env,PYTHONPATH:"scripts/vendor"}});const m15Lor=JSON.parse(await readFile(lorM15Json,"utf8"));
const smcH1=new Map([5,10,20,50].map(n=>[n,buildSmcStructure(h1,n)])),smcM15=new Map([5,10].map(n=>[n,buildSmcStructure(m15,n)]));
const m15IndexAt=t=>{let lo=0,hi=m15.length-1,ans=-1;while(lo<=hi){const mid=(lo+hi)>>1;if(m15[mid].closeTime<=t){ans=mid;lo=mid+1;}else hi=mid-1;}return ans;};
const sideDir=side=>side==="LONG"?1:-1;
const smcPass=(spec,i,mi,side)=>{const arr=spec.tf==="h1"?smcH1.get(spec.length):smcM15.get(spec.length),idx=spec.tf==="h1"?i:mi;if(!arr||idx<0)return false;const x=arr[idx],d=sideDir(side);if(spec.mode==="state")return x.direction===d;if(spec.mode==="recent")return x.direction===d&&x.eventAge<=spec.age;if(spec.mode==="choch")return x.eventDirection===d&&x.eventType==="CHoCH"&&x.eventAge<=spec.age;return false;};
const lorPass=(key,tf,i,mi,side,mode="direction")=>{const obj=tf==="h1"?h1Lor:m15Lor,idx=tf==="h1"?i:mi,row=obj.variants[key]?.[idx];if(!row||idx<0)return false;const d=sideDir(side);return mode==="event"?(d===1?row.buy:row.sell):row.direction===d;};
const results=[];const splitTime=start+Math.floor(DAYS*.7)*24*HOUR;for(const v of VARIANTS){const trades=[];let nextAvailable=130,candidateCount=0,indicatorPassCount=0;for(let i=130;i<h1.length-1;i++){const b=h1[i],closeTime=b.closeTime;if(closeTime<start||i<nextAvailable)continue;const h4closed=h4.filter(c=>c.closeTime<=closeTime);if(h4closed.length<60)continue;const old=h1[i-24],change=old?.close>0?(b.close/old.close-1)*100:0;const ticker={symbol:SYMBOL,last:b.close,quoteVolume:0,priceChangePercent:change,premium:{lastFundingRate:null}};const history=h1.slice(0,i+1);const m15closed=m15.filter(c=>c.closeTime<=closeTime).slice(-120);const sig=analyzeFuturesSymbol(ticker,history,h4closed,m15closed);if(!sig?.eligible||sig.volumeRatio<.75)continue;candidateCount++;const mi=m15IndexAt(closeTime);let passed=true;if(v.smc)passed=smcPass(v.smc,i,mi,sig.side);if(v.smcCombo)passed=v.smcCombo.every(x=>smcPass({...x,mode:"state"},i,mi,sig.side));if(v.lor)passed=lorPass(v.lor.key,v.lor.tf,i,mi,sig.side,v.lor.mode);if(v.lorCombo)passed=v.lorCombo.every((key,j)=>lorPass(key,j===0?"h1":"m15",i,mi,sig.side));if(!passed)continue;indicatorPassCount++;const next=h1[i+1],dir=sig.side==="LONG"?1:-1,entry=next.open*(1+dir*SLIPPAGE);if(!(sig.side==="LONG"?sig.stop<entry&&entry<sig.target1:sig.stop>entry&&entry>sig.target1))continue;const sim=simulate({side:sig.side,entry,stop:sig.stop,targets:[sig.target1,sig.target2,sig.target3],candles:h1.slice(i+1,i+MAX_HOLD_HOURS+2)});if(!sim)continue;sim.signalTime=b.time;sim.symbol=SYMBOL;sim.volumeRatio=sig.volumeRatio;sim.score=sig.score;trades.push(sim);const exitIndex=h1.findIndex(c=>c.time===sim.exitTime);nextAvailable=Math.max(i+2,exitIndex+1);}results.push({variant:v,baseCandidates:candidateCount,indicatorPasses:indicatorPassCount,overall:summarize(trades),inSample:summarize(trades.filter(t=>t.signalTime<splitTime)),outOfSample:summarize(trades.filter(t=>t.signalTime>=splitTime)),bySide:bySide(trades),bySideOOS:bySide(trades.filter(t=>t.signalTime>=splitTime)),trades});}
const report={generatedAt:new Date().toISOString(),exchange:"Binance USDⓈ-M Futures",symbol:SYMBOL,period:{from:new Date(start).toISOString(),to:new Date(now).toISOString(),days:DAYS,split:"first 70% in-sample; last 30% out-of-sample"},data:{oneHourCandles:h1.length,fourHourCandles:h4.length,fifteenMinuteCandles:m15.length,warmupDays:WARMUP_DAYS,lorentzianMaxBarsBack:{h1:10000,m15:40000},entry:"next 1h open with adverse slippage",feePerSidePct:FEE*100,slippagePerSidePct:SLIPPAGE*100,partialExitsPct:[40,35,25],maxHoldHours:MAX_HOLD_HOURS,stopTargetAmbiguity:"stop first",funding:"excluded",strategy:"same production analyzeFuturesSymbol; only SMC/Lorentzian eligibility filter varied",lorentzian:"AI Edge parity-tested Python port of jdehorty v2 defaults and parameter variants",smc:"confirmed symmetric swing pivots, each break consumed once, BOS/CHoCH state machine"}};
report.variants=results.map(({trades,...x})=>x);await mkdir("artifacts",{recursive:true});await writeFile("artifacts/btcusdt-smc-lorentzian-deep.json",JSON.stringify(report,null,2));
const fmt=x=>x.profitFactor===null?"n/a":x.profitFactor.toFixed(2);
const lines=["# BTCUSDT Binance USD-M — SMC and Lorentzian deep benchmark","", "Period: "+report.period.from+" to "+report.period.to,"Split: 70% in-sample / 30% out-of-sample","Candles: "+h1.length+" x 1h; "+h4.length+" x 4h; "+m15.length+" x 15m","Costs: "+(FEE*100)+"% fee + "+(SLIPPAGE*100)+"% slippage per side; funding excluded.","","## Out-of-sample (last 30%)","| Filter | Candidates | Passed | Trades | Win % | Net R | Exp. R | PF | Max DD | LONG net R / PF | SHORT net R / PF |","|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",...results.map(x=>{const l=x.bySideOOS.LONG,sh=x.bySideOOS.SHORT,o=x.outOfSample;return "| "+x.variant.id+" | "+x.baseCandidates+" | "+x.indicatorPasses+" | "+o.trades+" | "+o.winRatePct.toFixed(1)+" | "+o.netR.toFixed(2)+" | "+o.expectancyR.toFixed(3)+" | "+fmt(o)+" | "+o.maxDrawdownR.toFixed(2)+" | "+l.netR.toFixed(2)+" / "+fmt(l)+" | "+sh.netR.toFixed(2)+" / "+fmt(sh)+" |";}),"","## Full period","| Filter | Trades | Win % | Net R | Exp. R | PF | Max DD |","|---|---:|---:|---:|---:|---:|---:|",...results.map(x=>{const o=x.overall;return "| "+x.variant.id+" | "+o.trades+" | "+o.winRatePct.toFixed(1)+" | "+o.netR.toFixed(2)+" | "+o.expectancyR.toFixed(3)+" | "+fmt(o)+" | "+o.maxDrawdownR.toFixed(2)+" |";}),"","The Lorentzian calculation uses the MIT-licensed AI Edge port of jdehorty's reference algorithm. SMC is a causal BOS/CHoCH swing-structure approximation, not LuxAlgo source-code parity.","Simulation only; no historical funding or mark-price liquidation model."];await writeFile("artifacts/btcusdt-smc-lorentzian-deep.md",lines.join("\n"));console.log(JSON.stringify({ok:true,symbol:SYMBOL,exchange:report.exchange,period:report.period,data:report.data,variants:report.variants,artifacts:["artifacts/btcusdt-smc-lorentzian-deep.json","artifacts/btcusdt-smc-lorentzian-deep.md"]},null,2));}finally{await rm(tmp,{recursive:true,force:true});}}
main().catch(e=>{console.error(e);process.exitCode=1;});

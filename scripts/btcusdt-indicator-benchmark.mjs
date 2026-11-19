import { analyzeFuturesSymbol } from "../src/index.js";
import { indicatorPasses } from "../src/indicator-benchmark.js";
import { mkdir, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
const BASE="https://fapi.binance.com", SYMBOL="BTCUSDT", HOUR=3600000, FOUR_HOURS=14400000;
const DAYS=365,WARMUP_DAYS=30,MAX_HOLD_HOURS=72,FEE=.0005,SLIPPAGE=.0003;
const VARIANTS=[
{id:"baseline",label:"Current engine — no new indicator",minVolumeRatio:.75},
{id:"smc_structure",label:"SMC market structure BOS/CHoCH",minVolumeRatio:.75,indicator:"smc"},
{id:"liquidity_sweep",label:"Liquidity sweep reversal",minVolumeRatio:.75,indicator:"liquidity_sweep"},
{id:"lorentzian",label:"Lorentzian-style ML classifier",minVolumeRatio:.75,indicator:"lorentzian"},
{id:"hull",label:"Hull Moving Average Suite",minVolumeRatio:.75,indicator:"hull"},
{id:"supertrend",label:"SuperTrend 10,3",minVolumeRatio:.75,indicator:"supertrend"},
{id:"wavetrend",label:"WaveTrend WT1/WT2 direction",minVolumeRatio:.75,indicator:"wavetrend"},
{id:"wavetrend_slope",label:"WaveTrend WT1 slope",minVolumeRatio:.75,indicator:"wavetrend_slope"},
{id:"squeeze",label:"Squeeze Momentum release",minVolumeRatio:.75,indicator:"squeeze"},
{id:"squeeze_momentum",label:"Squeeze Momentum directional histogram",minVolumeRatio:.75,indicator:"squeeze_momentum"}
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
async function main(){const now=Date.now(),start=now-DAYS*24*HOUR,from=start-WARMUP_DAYS*24*HOUR;const [h1,h4,m15]=await Promise.all([fetchKlines("1h",from,now),fetchKlines("4h",from,now),fetchKlines("15m",from,now)]);if(h1.length<DAYS*20||h4.length<DAYS*4||m15.length<DAYS*80)throw new Error("Insufficient BTCUSDT candles: 1h="+h1.length+", 4h="+h4.length+", 15m="+m15.length);const results=[];for(const v of VARIANTS){const trades=[];let nextAvailable=130,candidateCount=0,indicatorPassCount=0;for(let i=130;i<h1.length-1;i++){const b=h1[i],closeTime=b.closeTime;if(closeTime<start||i<nextAvailable)continue;const h4closed=h4.filter(c=>c.closeTime<=closeTime);if(h4closed.length<60)continue;const old=h1[i-24],change=old?.close>0?(b.close/old.close-1)*100:0;const ticker={symbol:SYMBOL,last:b.close,quoteVolume:0,priceChangePercent:change,premium:{lastFundingRate:null}};const history=h1.slice(0,i+1);const m15closed=m15.filter(c=>c.closeTime<=closeTime).slice(-120);const sig=analyzeFuturesSymbol(ticker,history,h4closed,m15closed);if(!sig?.eligible||sig.volumeRatio<v.minVolumeRatio)continue;candidateCount++;if(v.indicator&&!indicatorPasses(v.indicator,history,sig.side))continue;indicatorPassCount++;const next=h1[i+1],dir=sig.side==="LONG"?1:-1,entry=next.open*(1+dir*SLIPPAGE);if(!(sig.side==="LONG"?sig.stop<entry&&entry<sig.target1:sig.stop>entry&&entry>sig.target1))continue;const sim=simulate({side:sig.side,entry,stop:sig.stop,targets:[sig.target1,sig.target2,sig.target3],candles:h1.slice(i+1,i+MAX_HOLD_HOURS+2)});if(!sim)continue;sim.signalTime=b.time;sim.symbol=SYMBOL;sim.volumeRatio=sig.volumeRatio;sim.score=sig.score;trades.push(sim);const exitIndex=h1.findIndex(c=>c.time===sim.exitTime);nextAvailable=Math.max(i+2,exitIndex+1);}results.push({variant:v,baseCandidates:candidateCount,indicatorPasses:indicatorPassCount,overall:summarize(trades),bySide:bySide(trades),trades});}
const report={generatedAt:new Date().toISOString(),exchange:"Binance USDⓈ-M Futures",symbol:SYMBOL,period:{from:new Date(start).toISOString(),to:new Date(now).toISOString(),days:DAYS},data:{oneHourCandles:h1.length,fourHourCandles:h4.length,fifteenMinuteCandles:m15.length,warmupDays:WARMUP_DAYS,entry:"next 1h open with adverse slippage",feePerSidePct:FEE*100,slippagePerSidePct:SLIPPAGE*100,partialExitsPct:[40,35,25],maxHoldHours:MAX_HOLD_HOURS,stopTargetAmbiguity:"stop first",funding:"excluded",strategy:"same production analyzeFuturesSymbol; filters only alter eligibility"}};report.variants=results.map(({trades,...x})=>x);await mkdir("artifacts",{recursive:true});await writeFile("artifacts/btcusdt-indicator-benchmark.json",JSON.stringify(report,null,2));const lines=["# BTCUSDT Binance USD-M — 90-day indicator benchmark","", "Period: "+report.period.from+" to "+report.period.to,"Candles: "+h1.length+" x 1h; "+h4.length+" x 4h; "+m15.length+" x 15m","Costs: "+(FEE*100)+"% fee + "+(SLIPPAGE*100)+"% slippage per side; funding excluded.","","| Indicator filter | Trades | Win % | Net R | Exp. R | PF | Max DD | LONG net R / PF | SHORT net R / PF |","|---|---:|---:|---:|---:|---:|---:|---:|---:|",...results.map(x=>{const l=x.bySide.LONG,s=x.bySide.SHORT;return "| "+x.variant.id+" | "+x.overall.trades+" | "+x.overall.winRatePct.toFixed(1)+" | "+x.overall.netR.toFixed(2)+" | "+x.overall.expectancyR.toFixed(3)+" | "+(x.overall.profitFactor===null?"n/a":x.overall.profitFactor.toFixed(2))+" | "+x.overall.maxDrawdownR.toFixed(2)+" | "+l.netR.toFixed(2)+" / "+(l.profitFactor===null?"n/a":l.profitFactor.toFixed(2))+" | "+s.netR.toFixed(2)+" / "+(s.profitFactor===null?"n/a":s.profitFactor.toFixed(2))+" |";}),"","Simulation only; no historical funding or mark-price liquidation model."];await writeFile("artifacts/btcusdt-indicator-benchmark.md",lines.join("\n"));console.log(JSON.stringify({ok:true,symbol:SYMBOL,exchange:report.exchange,period:report.period,data:report.data,variants:report.variants,artifacts:["artifacts/btcusdt-indicator-benchmark.json","artifacts/btcusdt-indicator-benchmark.md"]},null,2));}
main().catch(e=>{console.error(e);process.exitCode=1;});

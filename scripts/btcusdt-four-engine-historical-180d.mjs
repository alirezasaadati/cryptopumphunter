import { analyzeFuturesSymbol } from "../src/index.js";
import { passesCompression, passesAtrCap, passesBreakoutBody } from "../src/futures-filter-experiments.js";
import { passesVolumeThreshold, isLateEntry, hasPullbackOrBreakout, passesEntryFreshness } from "../src/futures-entry-experiments.js";
import { detectOneHourBOS, buildPriceActionSignal } from "./btcusdt-price-action.mjs";
import { mkdir, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const BASE="https://data.binance.vision/data/futures/um";
const SYMBOL="BTCUSDT", HOUR=3600000, DAY=24*HOUR;
const DAYS=180, WARMUP_DAYS=30, FEE=.0005, SLIPPAGE=.0003;
const MAX_HOLD_15M=288, MAX_PENDING_15M=4;
const VARIANTS=[
 {id:"A_baseline",label:"Baseline",minVolume:.75},
 {id:"B_all_filters",label:"All filters",minVolume:1.2,compression:.8,atrCap:5,bodyRatio:1.2,requireSetup:true,avoidLate:true},
 {id:"C_avoid_late",label:"Avoid late entry",minVolume:.75,avoidLate:true},
 {id:"D_price_action",label:"Pure price action (4H structure / 1H BOS / 15M sweep)",priceAction:true}
];
const finite=(...xs)=>xs.every(Number.isFinite);
function parseCsv(csv){
 const out=[];
 for(const line of csv.split(/\r?\n/)){
  if(!/^\d+,/.test(line))continue;
  const x=line.split(","); if(x.length<7)continue;
  const c={time:+x[0],open:+x[1],high:+x[2],low:+x[3],close:+x[4],volume:+x[5],closeTime:+x[6]};
  if(finite(c.time,c.open,c.high,c.low,c.close,c.volume,c.closeTime)&&c.open>0&&c.low>0&&c.high>=c.low&&c.close>0&&c.volume>=0&&c.closeTime<Date.now())out.push(c);
 }
 return out;
}
async function fetchKlines(interval,fromMs,toMs){
 const dir=await mkdtemp(join(tmpdir(),"btc-hist-")),all=[];
 try{
  const first=new Date(fromMs),last=new Date(toMs);
  let month=new Date(Date.UTC(first.getUTCFullYear(),first.getUTCMonth(),1));
  const lastMonth=Date.UTC(last.getUTCFullYear(),last.getUTCMonth(),1);
  while(month.getTime()<lastMonth){
   const y=month.getUTCFullYear(),m=String(month.getUTCMonth()+1).padStart(2,"0");
   const file=`${SYMBOL}-${interval}-${y}-${m}.zip`;
   const res=await fetch(`${BASE}/monthly/klines/${SYMBOL}/${interval}/${file}`,{signal:AbortSignal.timeout(30000)});
   if(res.status===404)throw new Error("Missing Binance monthly archive: "+file);
   if(!res.ok)throw new Error("Binance archive HTTP "+res.status+" for "+file);
   const p=join(dir,file);await writeFile(p,Buffer.from(await res.arrayBuffer()));
   all.push(...parseCsv(execFileSync("unzip",["-p",p],{encoding:"utf8",maxBuffer:160*1024*1024})));
   month=new Date(Date.UTC(y,month.getUTCMonth()+1,1));
  }
  const day=new Date(Date.UTC(last.getUTCFullYear(),last.getUTCMonth(),1));
  while(day.getTime()<=last.getTime()){
   const y=day.getUTCFullYear(),m=String(day.getUTCMonth()+1).padStart(2,"0"),d=String(day.getUTCDate()).padStart(2,"0");
   const file=`${SYMBOL}-${interval}-${y}-${m}-${d}.zip`;
   const res=await fetch(`${BASE}/daily/klines/${SYMBOL}/${interval}/${file}`,{signal:AbortSignal.timeout(30000)});
   if(res.status!==404){
    if(!res.ok)throw new Error("Binance daily archive HTTP "+res.status+" for "+file);
    const p=join(dir,file);await writeFile(p,Buffer.from(await res.arrayBuffer()));
    all.push(...parseCsv(execFileSync("unzip",["-p",p],{encoding:"utf8",maxBuffer:64*1024*1024})));
   }
   day.setUTCDate(day.getUTCDate()+1);
  }
 }finally{await rm(dir,{recursive:true,force:true});}
 const unique=new Map(all.filter(c=>c.time>=fromMs&&c.time<toMs).map(c=>[c.time,c]));
 return [...unique.values()].sort((a,b)=>a.time-b.time);
}
function ema(values,period=20){
 if(values.length<period)return null;const k=2/(period+1);
 let v=values.slice(0,period).reduce((a,b)=>a+b,0)/period;
 for(let i=period;i<values.length;i++)v=values[i]*k+v*(1-k);
 return v;
}
function confirm15m(side,candle,history){
 const e=ema(history.map(x=>x.close),20);if(!Number.isFinite(e))return false;
 return side==="LONG"?candle.close>e&&candle.close>candle.open:candle.close<e&&candle.close<candle.open;
}
function filterPasses(v,sig,h1,idx){
 if(!passesVolumeThreshold(sig.volumeRatio,v.minVolume))return false;
 if(v.compression&&!passesCompression(h1,idx,v.compression))return false;
 if(v.atrCap&&!passesAtrCap(sig.atr,sig.entry,v.atrCap))return false;
 if(v.bodyRatio&&!passesBreakoutBody(h1,idx,v.bodyRatio))return false;
 if(v.avoidLate&&isLateEntry({side:sig.side,entry:sig.entry,ema20:sig.ema20,atr:sig.atr}))return false;
 if(v.requireSetup&&!hasPullbackOrBreakout({side:sig.side,candles:h1.slice(0,idx+1),ema20:sig.ema20,atr:sig.atr,lookback:20}))return false;
 return true;
}
function startTrade(side,signal,nextBar){
 if(!nextBar||!(nextBar.open>0))return null;
 const dir=side==="LONG"?1:-1;
 if(!passesEntryFreshness(signal.entry,nextBar.open,.35))return null;
 const entry=nextBar.open*(1+dir*SLIPPAGE),shift=entry-signal.entry;
 const stop=signal.stop+shift,targets=[signal.target1+shift,signal.target2+shift,signal.target3+shift];
 const risk=dir===1?entry-stop:stop-entry;
 if(!(risk>0)||!finite(entry,stop,...targets))return null;
 return{side,entry,stop,targets,risk,openedAt:new Date(nextBar.time).toISOString(),entryTime:nextBar.time,remaining:1,netR:0,targetHits:[],barsHeld:0,signalTime:signal.candleTime??signal.bosTime??nextBar.time};
}
function closeR(t,raw,fraction,reason,time){
 const dir=t.side==="LONG"?1:-1,fill=raw*(1-dir*SLIPPAGE),feeR=FEE*(t.entry+fill)/t.risk;
 t.netR+=fraction*(dir*(fill-t.entry)/t.risk-feeR);t.remaining=Math.max(0,t.remaining-fraction);
 if(t.remaining<1e-8){t.remaining=0;t.closedAt=new Date(time).toISOString();t.exitReason=reason;}
}
function updateTrade(t,bar){
 const dir=t.side==="LONG"?1:-1,stopHit=dir===1?bar.low<=t.stop:bar.high>=t.stop;
 if(stopHit){closeR(t,t.stop,t.remaining,"STOP",bar.time);return;}
 const weights=[.4,.35,.25];
 for(let k=0;k<3&&t.remaining>1e-8;k++){
  if(t.targetHits.includes(k))continue;
  const hit=dir===1?bar.high>=t.targets[k]:bar.low<=t.targets[k];
  if(hit){closeR(t,t.targets[k],Math.min(weights[k],t.remaining),"TARGET_"+(k+1),bar.time);t.targetHits.push(k);}
 }
 t.barsHeld++;
 if(t.remaining>1e-8&&t.barsHeld>=MAX_HOLD_15M)closeR(t,bar.close,t.remaining,"TIME_EXIT",bar.time);
}
function stats(trades){
 const wins=trades.filter(t=>t.netR>0),loss=trades.filter(t=>t.netR<0);
 const gw=wins.reduce((s,t)=>s+t.netR,0),gl=Math.abs(loss.reduce((s,t)=>s+t.netR,0));
 let eq=0,peak=0,dd=0;for(const t of [...trades].sort((a,b)=>a.exitTime-b.exitTime)){eq+=t.netR;peak=Math.max(peak,eq);dd=Math.max(dd,peak-eq);}
 return{trades:trades.length,wins:wins.length,losses:loss.length,winRatePct:trades.length?100*wins.length/trades.length:0,netR:trades.reduce((s,t)=>s+t.netR,0),expectancyR:trades.length?trades.reduce((s,t)=>s+t.netR,0)/trades.length:0,profitFactor:gl?gw/gl:gw?null:0,maxDrawdownR:dd};
}
function summarizeTrades(trades,split,openAtEnd){
 const done=trades.filter(t=>t.closedAt),oos=done.filter(t=>t.signalTime>=split),ins=done.filter(t=>t.signalTime<split);
 return{overall:stats(done),inSample:stats(ins),outOfSample:stats(oos),openAtEnd};
}
async function main(){
 const now=Date.now(),periodStart=now-DAYS*DAY,from=periodStart-WARMUP_DAYS*DAY;
 console.log("Downloading Binance USD-M BTCUSDT 1h/4h/15m archives...");
 const [h1,h4,m15]=await Promise.all([fetchKlines("1h",from,now),fetchKlines("4h",from,now),fetchKlines("15m",from,now)]);
 if(h1.length<1000||h4.length<250||m15.length<5000)throw new Error("Insufficient history: "+JSON.stringify({h1:h1.length,h4:h4.length,m15:m15.length}));
 const split=periodStart+120*DAY;
 const state=Object.fromEntries(VARIANTS.map(v=>[v.id,{pending:null,open:null,trades:[]}]));
 let hi=0,qi=0;
 for(let j=0;j<m15.length-1;j++){
  const bar=m15[j],next=m15[j+1];
  while(hi<h1.length&&h1[hi].closeTime<=bar.closeTime){
   const hb=h1[hi],h1prefix=h1.slice(0,hi+1);
   while(qi<h4.length&&h4[qi].closeTime<=hb.closeTime)qi++;
   const h4prefix=h4.slice(0,qi);
   if(hb.closeTime>=periodStart&&h4prefix.length>=60&&hi>=130){
    const change=(hb.close/h1[Math.max(0,hi-24)].close-1)*100;
    const ticker={symbol:SYMBOL,last:hb.close,quoteVolume:0,priceChangePercent:change,premium:{lastFundingRate:null}};
    const candidate=analyzeFuturesSymbol(ticker,h1prefix,h4prefix);
    for(const v of VARIANTS){
     const s=state[v.id];
     if(v.priceAction){
      const direction=detectOneHourBOS(h4prefix,h1prefix);
      s.pending=direction?{...direction,createdAt:hb.closeTime,expiresAt:hb.closeTime+4*15*60000,variant:v.id}:null;
     }else{
      s.pending=candidate?.eligible&&filterPasses(v,candidate,h1prefix,hi)
       ?{...candidate,candleTime:hb.time,createdAt:hb.closeTime,expiresAt:hb.closeTime+MAX_PENDING_15M*15*60000,variant:v.id}:null;
     }
    }
   }
   hi++;
  }
  if(bar.closeTime<periodStart)continue;
  for(const v of VARIANTS){
   const s=state[v.id];
   if(s.open&&bar.time>s.open.entryTime){
    updateTrade(s.open,bar);
    if(s.open.remaining<=1e-8){s.open.exitTime=bar.time;s.trades.push(s.open);s.open=null;}
   }
   if(!s.open&&s.pending&&bar.closeTime>=s.pending.createdAt){
    if(bar.closeTime>s.pending.expiresAt)s.pending=null;
    else{
     let sig=null;
     if(v.priceAction){
      const hist=m15.slice(Math.max(0,j-12),j+1);
      sig=buildPriceActionSignal(s.pending,hist,8);
     }else if(confirm15m(s.pending.side,bar,m15.slice(Math.max(0,j-40),j+1)))sig=s.pending;
     if(sig){
      const tradeSignal=v.priceAction?{...sig,candleTime:bar.time}:sig;
      s.open=startTrade(tradeSignal.side,tradeSignal,next);
      s.pending=null;
     }
    }
   }
  }
 }
 const variants={};
 for(const v of VARIANTS){
  const s=state[v.id];
  variants[v.id]={label:v.label,...summarizeTrades(s.trades,split,s.open?1:0),pendingAtEnd:Boolean(s.pending)};
 }
 const report={generatedAt:new Date().toISOString(),exchange:"Binance USD-M Futures",symbol:SYMBOL,period:{from:new Date(periodStart).toISOString(),to:new Date(now).toISOString(),days:DAYS},split:{inSampleDays:120,outOfSampleDays:60,outOfSampleFrom:new Date(split).toISOString()},data:{oneHourCandles:h1.length,fourHourCandles:h4.length,fifteenMinuteCandles:m15.length,warmupDays:WARMUP_DAYS},execution:{entry:"next 15m open",feePerSidePct:FEE*100,slippagePerSidePct:SLIPPAGE*100,partialExitsPct:[40,35,25],maxHoldHours:72,stopTargetSameCandle:"stop first",funding:"excluded"},method:"Chronological 15m simulation. A-C use the current analyzer, the same filter definitions and closed-15m EMA20 confirmation. D uses the independent pure-PA 4H/1H/15m logic. One open position per model; overlapping signals while a position is open are ignored.",variants};
 await mkdir("artifacts",{recursive:true});
 await writeFile("artifacts/btcusdt-four-engine-historical-180d.json",JSON.stringify(report,null,2));
 const rows=VARIANTS.map(v=>{const x=variants[v.id],o=x.outOfSample;return`| ${v.id} | ${x.overall.trades} | ${x.overall.netR.toFixed(2)} | ${x.overall.profitFactor===null?"n/a":x.overall.profitFactor.toFixed(2)} | ${o.trades} | ${o.winRatePct.toFixed(1)}% | ${o.netR.toFixed(2)} | ${o.profitFactor===null?"n/a":o.profitFactor.toFixed(2)} | ${o.maxDrawdownR.toFixed(2)} |`;});
 const md=["# BTCUSDT — Four-engine historical backtest","",`Period: ${report.period.from} to ${report.period.to} (180 days)`,`Out-of-sample: final 60 days from ${report.split.outOfSampleFrom}`,`Candles: ${h1.length} 1h / ${h4.length} 4h / ${m15.length} 15m`,"Costs: 0.05% fee + 0.03% slippage per side; funding excluded.","","| Model | All trades | Net R | PF | OOS trades | OOS win rate | OOS Net R | OOS PF | OOS Max DD R |","|---|---:|---:|---:|---:|---:|---:|---:|---:|",...rows,"","Important: simulation only. No funding or liquidation model. Same-candle stop/target ambiguity is resolved conservatively as stop first. OOS is a chronological holdout, not proof of future profitability."].join("\n");
 await writeFile("artifacts/btcusdt-four-engine-historical-180d.md",md);
 console.log(JSON.stringify({ok:true,...report,artifacts:["artifacts/btcusdt-four-engine-historical-180d.json","artifacts/btcusdt-four-engine-historical-180d.md"]},null,2));
}
main().catch(e=>{console.error(e);process.exitCode=1;});

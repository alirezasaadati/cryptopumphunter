import { mkdir, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const SYMBOL="BTCUSDT", INTERVAL="15m", STEP=15*60*1000, HOUR=4*STEP;
const END=Date.UTC(2026,10,20), DAYS=365, START=END-DAYS*24*60*60*1000;
const FEE=.0005, SLIPPAGE=.0003, MAX_HOLD=24;
const VARIANTS=[
  {id:"A_indicators",label:"ADX + BB(20,2.5) + RSI(25/75)",smc:"none",tp:"0.3R"},
  {id:"A_indicators_05R",label:"ADX + BB + RSI, TP 0.5R",smc:"none",tp:"0.5R"},
  {id:"B_sweep",label:"Indicators + Liquidity Sweep",smc:"sweep",tp:"0.3R"},
  {id:"B_sweep_05R",label:"Sweep, TP 0.5R",smc:"sweep",tp:"0.5R"},
  {id:"C_choch",label:"Indicators + CHoCH",smc:"choch",tp:"0.3R"},
  {id:"C_choch_05R",label:"CHoCH, TP 0.5R",smc:"choch",tp:"0.5R"},
  {id:"D_sweep_choch",label:"Indicators + Sweep + CHoCH",smc:"both",tp:"0.3R"},
  {id:"D_sweep_choch_05R",label:"Sweep + CHoCH, TP 0.5R",smc:"both",tp:"0.5R"}
];
const finite=x=>Number.isFinite(x);
async function archiveCsv(url,dir){
 const r=await fetch(url,{signal:AbortSignal.timeout(35000)});
 if(r.status===404)return null;
 if(!r.ok)throw new Error("Binance Vision HTTP "+r.status+" "+url);
 const p=join(dir,Math.random().toString(36).slice(2)+".zip");
 await writeFile(p,Buffer.from(await r.arrayBuffer()));
 try{return execFileSync("unzip",["-p",p],{encoding:"utf8",maxBuffer:160*1024*1024});}
 finally{await rm(p,{force:true});}
}
function parseCsv(csv){
 const out=[];
 for(const line of csv.split(/\r?\n/)){
  if(!/^\d+,/.test(line))continue;
  const x=line.split(",");
  if(x.length<7)continue;
  const c={time:+x[0],open:+x[1],high:+x[2],low:+x[3],close:+x[4],volume:+x[5],closeTime:+x[6]};
  if([c.time,c.open,c.high,c.low,c.close,c.volume,c.closeTime].every(finite)&&c.closeTime<END&&c.open>0&&c.low>0&&c.high>=c.low&&c.close>0)out.push(c);
 }
 return out;
}
async function loadCandles(){
 const dir=await mkdtemp(join(tmpdir(),"mean-reversion-")),all=[];
 try{
  let month=new Date(Date.UTC(new Date(START).getUTCFullYear(),new Date(START).getUTCMonth(),1));
  const lastMonth=Date.UTC(new Date(END).getUTCFullYear(),new Date(END).getUTCMonth(),1);
  while(month.getTime()<lastMonth){
   const y=month.getUTCFullYear(),m=String(month.getUTCMonth()+1).padStart(2,"0");
   const f=SYMBOL+"-"+INTERVAL+"-"+y+"-"+m+".zip";
   const csv=await archiveCsv("https://data.binance.vision/data/futures/um/monthly/klines/"+SYMBOL+"/"+INTERVAL+"/"+f,dir);
   if(csv)all.push(...parseCsv(csv));
   month=new Date(Date.UTC(y,month.getUTCMonth()+1,1));
  }
  const last=new Date(END),day=new Date(Date.UTC(last.getUTCFullYear(),last.getUTCMonth(),1));
  while(day.getTime()<END){
   const y=day.getUTCFullYear(),m=String(day.getUTCMonth()+1).padStart(2,"0"),d=String(day.getUTCDate()).padStart(2,"0");
   const f=SYMBOL+"-"+INTERVAL+"-"+y+"-"+m+"-"+d+".zip";
   const csv=await archiveCsv("https://data.binance.vision/data/futures/um/daily/klines/"+SYMBOL+"/"+INTERVAL+"/"+f,dir);
   if(csv)all.push(...parseCsv(csv));
   day.setUTCDate(day.getUTCDate()+1);
  }
 }finally{await rm(dir,{recursive:true,force:true});}
 const unique=new Map(all.filter(c=>c.time>=START-35*24*60*60*1000&&c.time<END).map(c=>[c.time,c]));
 return [...unique.values()].sort((a,b)=>a.time-b.time);
}
function aggregate1h(bars){
 const map=new Map();
 for(const b of bars){
  const t=Math.floor(b.time/HOUR)*HOUR;
  let x=map.get(t);
  if(!x){x={time:t,open:b.open,high:b.high,low:b.low,close:b.close,closeTime:t+HOUR-1,count:0};map.set(t,x);}
  x.high=Math.max(x.high,b.high);x.low=Math.min(x.low,b.low);x.close=b.close;x.count++;
 }
 return [...map.values()].filter(x=>x.count===4).sort((a,b)=>a.time-b.time);
}
function sma(a,n,i){if(i<n-1)return null;let s=0;for(let k=i-n+1;k<=i;k++)s+=a[k];return s/n;}
function ema(values,n){
 const out=Array(values.length).fill(null),k=2/(n+1);let seed=0;
 if(values.length<n)return out;
 for(let i=0;i<n;i++)seed+=values[i];
 out[n-1]=seed/n;
 for(let i=n;i<values.length;i++)out[i]=values[i]*k+out[i-1]*(1-k);
 return out;
}
function rsi(closes,n=14){
 const out=Array(closes.length).fill(null);let gain=0,loss=0;
 for(let i=1;i<=n;i++){const d=closes[i]-closes[i-1];gain+=Math.max(0,d);loss+=Math.max(0,-d);}
 let ag=gain/n,al=loss/n;out[n]=al===0?100:100-100/(1+ag/al);
 for(let i=n+1;i<closes.length;i++){const d=closes[i]-closes[i-1];ag=(ag*(n-1)+Math.max(0,d))/n;al=(al*(n-1)+Math.max(0,-d))/n;out[i]=al===0?100:100-100/(1+ag/al);}
 return out;
}
function atr(bars,n=14){
 const tr=bars.map((b,i)=>i===0?b.high-b.low:Math.max(b.high-b.low,Math.abs(b.high-bars[i-1].close),Math.abs(b.low-bars[i-1].close)));
 const out=Array(bars.length).fill(null);if(bars.length<=n)return out;
 let v=tr.slice(1,n+1).reduce((a,b)=>a+b,0)/n;out[n]=v;
 for(let i=n+1;i<bars.length;i++){v=(v*(n-1)+tr[i])/n;out[i]=v;}
 return out;
}
function adx(bars,n=14){
 const out=Array(bars.length).fill(null),tr=[],pdm=[],mdm=[];
 for(let i=0;i<bars.length;i++){
  if(!i){tr.push(0);pdm.push(0);mdm.push(0);continue;}
  const up=bars[i].high-bars[i-1].high,down=bars[i-1].low-bars[i].low;
  tr.push(Math.max(bars[i].high-bars[i].low,Math.abs(bars[i].high-bars[i-1].close),Math.abs(bars[i].low-bars[i-1].close)));
  pdm.push(up>down&&up>0?up:0);mdm.push(down>up&&down>0?down:0);
 }
 if(bars.length<2*n+1)return out;
 let st=tr.slice(1,n+1).reduce((a,b)=>a+b,0),sp=pdm.slice(1,n+1).reduce((a,b)=>a+b,0),sm=mdm.slice(1,n+1).reduce((a,b)=>a+b,0),dx=[];
 for(let i=n+1;i<bars.length;i++){
  if(i>n){st=st-st/n+tr[i];sp=sp-sp/n+pdm[i];sm=sm-sm/n+mdm[i];}
  const plus=st?100*sp/st:0,minus=st?100*sm/st:0,den=plus+minus;
  dx[i]=den?100*Math.abs(plus-minus)/den:0;
  if(i===2*n){let v=0;for(let j=n+1;j<=2*n;j++)v+=dx[j]||0;out[i]=v/n;}
  else if(i>2*n)out[i]=(out[i-1]*(n-1)+(dx[i]||0))/n;
 }
 return out;
}
function bollinger(closes,n=20,mult=2.5){
 const mid=Array(closes.length).fill(null),upper=mid.slice(),lower=mid.slice();
 for(let i=n-1;i<closes.length;i++){const mean=sma(closes,n,i);let v=0;for(let j=i-n+1;j<=i;j++)v+=(closes[j]-mean)**2;const sd=Math.sqrt(v/n);mid[i]=mean;upper[i]=mean+mult*sd;lower[i]=mean-mult*sd;}
 return{mid,upper,lower};
}
function pivots(bars,left=2,right=2){
 const hi=Array(bars.length).fill(null),lo=Array(bars.length).fill(null);
 let lastH=null,lastL=null;
 for(let i=0;i<bars.length;i++){
  const p=i-right;
  if(p>=left){
   let isH=true,isL=true;
   for(let j=p-left;j<=p+right;j++){if(j===p)continue;if(bars[p].high<=bars[j].high)isH=false;if(bars[p].low>=bars[j].low)isL=false;}
   if(isH)lastH={price:bars[p].high,index:p};
   if(isL)lastL={price:bars[p].low,index:p};
  }
  hi[i]=lastH;lo[i]=lastL;
 }
 return{hi,lo};
}
function summarize(ts){
 const wins=ts.filter(x=>x.netR>0),losses=ts.filter(x=>x.netR<0),gp=wins.reduce((s,x)=>s+x.netR,0),gl=Math.abs(losses.reduce((s,x)=>s+x.netR,0));
 let equity=0,peak=0,dd=0;for(const t of ts){equity+=t.netR;peak=Math.max(peak,equity);dd=Math.max(dd,peak-equity);}
 return{trades:ts.length,wins:wins.length,losses:losses.length,winRatePct:ts.length?100*wins.length/ts.length:0,netR:ts.reduce((s,x)=>s+x.netR,0),expectancyR:ts.length?ts.reduce((s,x)=>s+x.netR,0)/ts.length:0,profitFactor:gl?gp/gl:gp?null:0,maxDrawdownR:dd,avgWinR:wins.length?gp/wins.length:0,avgLossR:losses.length?gl/losses.length:0};
}
function simulate(bars,i,side,entry,stop,target,emaTarget){
 const dir=side==="LONG"?1:-1,risk=dir===1?entry-stop:stop-entry;if(!(risk>0))return null;
 let exit=null,reason="TIME_EXIT",gross=0,exitIdx=Math.min(bars.length-1,i+MAX_HOLD);
 for(let j=i+1;j<=exitIdx;j++){
  const b=bars[j],stopHit=dir===1?b.low<=stop:b.high>=stop;
  if(stopHit){const gap=dir===1?b.open<=stop:b.open>=stop;exit=gap?b.open:stop;reason=gap?"STOP_GAP":"STOP";exitIdx=j;break;}
  const tp=emaTarget?b._ema20:target;
  const tpHit=finite(tp)&&(dir===1?b.high>=tp:b.low<=tp);
  if(tpHit){exit=tp;reason=emaTarget?"EMA20":"TP";exitIdx=j;break;}
 }
 if(exit===null){exit=bars[exitIdx].close;reason="TIME_EXIT";}
 const fill=exit*(1-dir*SLIPPAGE),entryFill=entry;
 gross=dir*(fill-entryFill)/risk;
 const feeR=FEE*(entryFill+fill)/risk;
 return{side,entry:entryFill,stop,target,exit:fill,netR:gross-feeR,exitReason:reason,signalTime:bars[i].time,exitTime:bars[exitIdx].time};
}
function mainBacktest(bars,variant,ind){
 const trades=[];let nextAllowed=0,lastSweepLong=-999,lastSweepShort=-999,lastChochLong=-999,lastChochShort=-999;
 for(let i=ind.warmup;i<bars.length-2;i++){
  if(i<nextAllowed)continue;
  const b=bars[i],prev=bars[i-1],r=ind.rsi[i],a=ind.adxAt[i],lo=ind.bb.lower[i],up=ind.bb.upper[i],atr15=ind.atr[i],pH=ind.piv.hi[i],pL=ind.piv.lo[i];
  if(!finite(r)||!finite(a)||!finite(lo)||!finite(up)||!finite(atr15)||!pH||!pL)continue;
  const sweepLong=b.low<pL.price&&b.close>pL.price,sweepShort=b.high>pH.price&&b.close<pH.price;
  if(sweepLong)lastSweepLong=i;if(sweepShort)lastSweepShort=i;
  const chochLong=prev.close<=pH.price&&b.close>pH.price,chochShort=prev.close>=pL.price&&b.close<pL.price;
  if(chochLong)lastChochLong=i;if(chochShort)lastChochShort=i;
  if(a>=20)continue;
  let side=null;
  if(b.close<lo&&r<25&&b.close>b.open)side="LONG";
  else if(b.close>up&&r>75&&b.close<b.open)side="SHORT";
  if(!side)continue;
  const sweep=side==="LONG"?lastSweepLong:lastSweepShort,choch=side==="LONG"?lastChochLong:lastChochShort;
  if(variant.smc==="sweep"&&i-sweep>8)continue;
  if(variant.smc==="choch"&&i-choch>8)continue;
  if(variant.smc==="both"&&(i-sweep>8||i-choch>8||choch<sweep))continue;
  const entry=bars[i+1].open*(1+(side==="LONG"?1:-1)*SLIPPAGE);
  const dir=side==="LONG"?1:-1;
  const recent=bars.slice(Math.max(0,i-7),i+1);
  const extreme=side==="LONG"?Math.min(...recent.map(x=>x.low)):Math.max(...recent.map(x=>x.high));
  const stop=side==="LONG"?extreme-atr15*.15:extreme+atr15*.15;
  const risk=side==="LONG"?entry-stop:stop-entry;
  if(!(risk>atr15*.25&&risk<atr15*2.5))continue;
  const target=entry+dir*risk*(variant.tp==="0.3R"?.3:.5);
  const emaTarget=variant.tp==="EMA20";
  const t=simulate(bars,i,side,entry,stop,target,emaTarget);
  if(t){trades.push(t);let exitIdx=i+1;while(exitIdx<bars.length&&bars[exitIdx].time<t.exitTime)exitIdx++;nextAllowed=Math.max(i+2,exitIdx+1);}
 }
 return trades;
}
async function main(){
 console.log("Loading one year of BTCUSDT 15m futures candles...");
 const raw=await loadCandles();if(raw.length<30000)throw new Error("Insufficient candles: "+raw.length);
 const bars=raw.filter(x=>x.time>=START&&x.time<END),h1=aggregate1h(raw);
 const closes=bars.map(x=>x.close),bb=bollinger(closes),rs=rsi(closes),atr15=atr(bars),piv=pivots(bars),h1adx=adx(h1);
 let h=0;const adxAt=bars.map(b=>{while(h+1<h1.length&&h1[h+1].closeTime<=b.closeTime)h++;return h1[h]?.closeTime<=b.closeTime?h1adx[h]:null;});
 const ema20=ema(closes,20);bars.forEach((b,i)=>b._ema20=ema20[i]);
 const warmup=200,split=START+Math.floor(DAYS*.7)*24*60*60*1000;
 const ind={bb,rsi:rs,atr:atr15,piv,adxAt,warmup};
 const results=[];
 for(const v of VARIANTS){
  const trades=mainBacktest(bars,v,ind);
  const oos=trades.filter(t=>t.signalTime>=split),is=trades.filter(t=>t.signalTime<split);
  results.push({variant:v,overall:summarize(trades),inSample:summarize(is),outOfSample:summarize(oos),bySide:{LONG:summarize(trades.filter(t=>t.side==="LONG")),SHORT:summarize(trades.filter(t=>t.side==="SHORT"))},oosBySide:{LONG:summarize(oos.filter(t=>t.side==="LONG")),SHORT:summarize(oos.filter(t=>t.side==="SHORT"))},trades});
 }
 const report={generatedAt:new Date().toISOString(),symbol:SYMBOL,exchange:"Binance USDⓈ-M Futures",period:{from:new Date(START).toISOString(),to:new Date(END).toISOString(),days:DAYS,split:"70% in-sample / 30% out-of-sample"},data:{candles15m:bars.length,candles1h:h1.length,feePerSidePct:FEE*100,slippagePerSidePct:SLIPPAGE*100,funding:"excluded",entry:"next 15m open, adverse slippage",stop:"beyond 8-bar local extreme by 0.15 ATR; reject risk outside 0.25-2.5 ATR",maxHoldBars:MAX_HOLD,stopTargetSameBar:"stop first",adx:"1h ADX(14) < 20",bollinger:"15m BB(20, 2.5 standard deviations)",rsi:"15m RSI(14), <25 long / >75 short",swing:"confirmed 2-left/2-right pivots; no future data used before confirmation",note:"Funding, liquidation and intrabar tick order are not modeled; stop-first assumption is conservative."}};
 report.variants=results.map(({trades,...x})=>x);
 await mkdir("artifacts",{recursive:true});
 await writeFile("artifacts/btcusdt-low-risk-mean-reversion.json",JSON.stringify(report,null,2));
 const f=x=>x.profitFactor===null?"∞":x.profitFactor.toFixed(2);
 const lines=["# BTCUSDT — Low-risk mean-reversion engine benchmark","", "Period: "+report.period.from+" to "+report.period.to+" (UTC)","Candles: "+bars.length+" x 15m; "+h1.length+" x 1h","Costs: "+FEE*100+"% fee + "+SLIPPAGE*100+"% slippage per side; funding excluded.","","## Out-of-sample (last 30%)","| Variant | Trades | Win % | Net R | Exp R | PF | Max DD R | LONG trades / net R | SHORT trades / net R |","|---|---:|---:|---:|---:|---:|---:|---:|---:|",...results.map(x=>{const o=x.outOfSample,l=x.oosBySide.LONG,s=x.oosBySide.SHORT;return "| "+x.variant.id+" | "+o.trades+" | "+o.winRatePct.toFixed(1)+" | "+o.netR.toFixed(2)+" | "+o.expectancyR.toFixed(3)+" | "+f(o.profitFactor)+" | "+o.maxDrawdownR.toFixed(2)+" | "+l.trades+" / "+l.netR.toFixed(2)+" | "+s.trades+" / "+s.netR.toFixed(2)+" |";}),"","## Full sample","| Variant | Trades | Win % | Net R | Exp R | PF | Max DD R |","|---|---:|---:|---:|---:|---:|---:|",...results.map(x=>{const o=x.overall;return "| "+x.variant.id+" | "+o.trades+" | "+o.winRatePct.toFixed(1)+" | "+o.netR.toFixed(2)+" | "+o.expectancyR.toFixed(3)+" | "+f(o.profitFactor)+" | "+o.maxDrawdownR.toFixed(2)+" |";}),"","## Method notes","- All signals are evaluated only on closed 15m candles; entries are at the next 15m open.","- The 1h ADX filter uses only fully closed 1h candles.","- Stop is checked before target when both could be touched within one candle.","- This is a research simulation, not a guarantee; historical funding and liquidation are excluded."];
 await writeFile("artifacts/btcusdt-low-risk-mean-reversion.md",lines.join("\n"));
 console.log(JSON.stringify({ok:true,period:report.period,data:report.data,results:report.variants.map(x=>({id:x.variant.id,overall:x.overall,outOfSample:x.outOfSample,oosBySide:x.oosBySide})),artifacts:["artifacts/btcusdt-low-risk-mean-reversion.json","artifacts/btcusdt-low-risk-mean-reversion.md"]},null,2));
}
main().catch(e=>{console.error(e);process.exitCode=1;});

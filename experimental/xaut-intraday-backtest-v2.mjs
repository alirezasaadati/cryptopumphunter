import { mkdir, writeFile } from "node:fs/promises";

const BASE = "https://futures.kraken.com";
const SYMBOL = "PF_XAUTUSD";
const DAY = 86400000, HOUR = 3600000, M15 = 900000, M5 = 300000;
const DAYS = Math.max(30, Math.min(365, Number(process.env.XAUT_DAYS || 180)));
const FEE = Number(process.env.XAUT_FEE || 0.0005);
const SLIPPAGE = Number(process.env.XAUT_SLIPPAGE || 0.0002);
const START_EQUITY = 1000, RISK_FRACTION = 0.005, MAX_HOLD_HOURS = 12;

async function getJson(url) {
  const r = await fetch(url, {headers:{accept:"application/json"}, signal:AbortSignal.timeout(30000)});
  const t = await r.text();
  if (!r.ok) throw new Error("Kraken HTTP "+r.status+": "+t.slice(0,200));
  const j = JSON.parse(t);
  if (j.result === "error" || j.error) throw new Error("Kraken API: "+JSON.stringify(j.error||j.errors));
  return j;
}
function clean(rows, interval) {
  const seen = new Set();
  return (rows||[]).map(x=>({time:Number(x.time)<1e12?Number(x.time)*1000:Number(x.time),open:+x.open,high:+x.high,low:+x.low,close:+x.close,volume:+x.volume}))
    .filter(c=>Object.values(c).every(Number.isFinite)&&c.open>0&&c.low>0&&c.high>=c.low&&c.close>0&&c.volume>=0&&c.time+interval<=Date.now())
    .sort((a,b)=>a.time-b.time).filter(c=>{if(seen.has(c.time))return false;seen.add(c.time);return true;});
}
async function candles(resolution, interval, from, to) {
  const out=[];
  for(let s=from;s<to;s+=interval*1700){
    const e=Math.min(to,s+interval*1700),u=new URL(BASE+"/api/charts/v1/trade/"+SYMBOL+"/"+resolution);
    u.searchParams.set("from",String(Math.floor(s/1000)));u.searchParams.set("to",String(Math.floor(e/1000)));u.searchParams.set("count","1800");
    const j=await getJson(u);out.push(...clean(j.candles,interval));
  }
  const m=new Map(out.map(c=>[c.time,c]));return [...m.values()].sort((a,b)=>a.time-b.time);
}
function ema(a,n){const out=Array(a.length).fill(null),k=2/(n+1);let v=null;for(let i=0;i<a.length;i++){v=v==null?a[i]:a[i]*k+v*(1-k);out[i]=i>=n-1?v:null;}return out;}
function rsi(a,n=14){const out=Array(a.length).fill(null);let g=0,l=0;for(let i=1;i<=n&&i<a.length;i++){const d=a[i]-a[i-1];g+=Math.max(0,d);l+=Math.max(0,-d);}if(a.length>n){g/=n;l/=n;out[n]=l===0?100:100-100/(1+g/l);}for(let i=n+1;i<a.length;i++){const d=a[i]-a[i-1];g=(g*(n-1)+Math.max(0,d))/n;l=(l*(n-1)+Math.max(0,-d))/n;out[i]=l===0?100:100-100/(1+g/l);}return out;}
function atr(cs,n=14){const tr=cs.map((c,i)=>i?Math.max(c.high-c.low,Math.abs(c.high-cs[i-1].close),Math.abs(c.low-cs[i-1].close)):c.high-c.low);const out=Array(cs.length).fill(null);let v=0;for(let i=0;i<tr.length;i++){if(i<n){v+=tr[i];if(i===n-1)out[i]=v/n;}else{v=(v*(n-1)+tr[i])/n;out[i]=v;}}return out;}
function sma(a,n,i){if(i<n-1)return null;let s=0;for(let k=i-n+1;k<=i;k++)s+=a[k];return s/n;}
function indexAtOrBefore(a,t){let lo=0,hi=a.length-1,ans=-1;while(lo<=hi){const m=(lo+hi)>>1;if(a[m].time<=t){ans=m;lo=m+1;}else hi=m-1;}return ans;}
function metrics(ts){const wins=ts.filter(t=>t.netR>0),loss=ts.filter(t=>t.netR<0),gw=wins.reduce((s,t)=>s+t.netR,0),gl=Math.abs(loss.reduce((s,t)=>s+t.netR,0));let eq=0,peak=0,dd=0;for(const t of ts){eq+=t.netR;peak=Math.max(peak,eq);dd=Math.max(dd,peak-eq);}return {trades:ts.length,wins:wins.length,losses:loss.length,winRatePct:ts.length?100*wins.length/ts.length:0,netR:ts.reduce((s,t)=>s+t.netR,0),expectancyR:ts.length?ts.reduce((s,t)=>s+t.netR,0)/ts.length:0,profitFactor:gl?gw/gl:gw?null:0,maxDrawdownR:dd};}

const to=Date.now(),from=to-DAYS*DAY;
const [m5,m15,h1]=await Promise.all([candles("5m",M5,from,to),candles("15m",M15,from,to),candles("1h",HOUR,from,to)]);
if(m5.length<1000||m15.length<300||h1.length<100)throw new Error("Insufficient XAUT history: 5m="+m5.length+" 15m="+m15.length+" 1h="+h1.length);
const c15=m15.map(c=>c.close), c1=h1.map(c=>c.close), v15=m15.map(c=>c.volume);
const e20_15=ema(c15,20),e50_15=ema(c15,50),r14=rsi(c15),a14=atr(m15),e20_1=ema(c1,20),e50_1=ema(c1,50);
const trades=[],reject={warmup:0,h1Trend:0,m15Trend:0,noPullbackReclaim:0,rsi:0,volume:0,invalidStop:0,occupied:0};
let nextAllowed=0,openTrade=null;
function closeTrade(tr,price,time,reason){const dir=tr.side==="LONG"?1:-1,fill=price*(1-dir*SLIPPAGE);const r=dir*(fill-tr.entry)/tr.risk;const feeR=FEE*(tr.entry+fill)/tr.risk;tr.netR+=tr.remaining*(r-feeR);tr.remaining=0;tr.exitTime=time;tr.exitReason=reason;tr.exitPrice=fill;trades.push(tr);}
for(let i=60;i<m15.length-2;i++){
 const bar=m15[i],prev=m15[i-1],a=a14[i],r=r14[i],vavg=sma(v15,20,i),hidx=indexAtOrBefore(h1,bar.time+M15-HOUR);
 if(!a||!r||!vavg||hidx<50){reject.warmup++;continue;}
 const hb=h1[hidx],ht=e20_1[hidx]>e50_1[hidx]&&hb.close>e20_1[hidx]?"LONG":e20_1[hidx]<e50_1[hidx]&&hb.close<e20_1[hidx]?"SHORT":null;
 if(!ht){reject.h1Trend++;continue;}
 const mt=e20_15[i]>e50_15[i]&&bar.close>e20_15[i]?"LONG":e20_15[i]<e50_15[i]&&bar.close<e20_15[i]?"SHORT":null;
 if(mt!==ht){reject.m15Trend++;continue;}
 const priorHigh=Math.max(...m15.slice(i-3,i).map(x=>x.high)),priorLow=Math.min(...m15.slice(i-3,i).map(x=>x.low));
 const longPull=prev.low<=e20_15[i-1]+0.15*a && prev.low>=e20_15[i-1]-0.50*a && bar.close>priorHigh && bar.close>bar.open;
 const shortPull=prev.high>=e20_15[i-1]-0.15*a && prev.high<=e20_15[i-1]+0.50*a && bar.close<priorLow && bar.close<bar.open;
 const side=ht==="LONG"&&longPull?"LONG":ht==="SHORT"&&shortPull?"SHORT":null;
 if(!side){reject.noPullbackReclaim++;continue;}
 if(side==="LONG"?(r<52||r>66):(r<34||r>48)){reject.rsi++;continue;}
 if(bar.volume<vavg*1.00){reject.volume++;continue;}
 const entryBar=indexAtOrBefore(m5,bar.time+M15);
 const entryIndex=entryBar+1;
 if(entryIndex<0||entryIndex>=m5.length)continue;
 const entry=m5[entryIndex].open,look=m15.slice(Math.max(0,i-5),i+1);
 const swingLow=Math.min(...look.map(x=>x.low)),swingHigh=Math.max(...look.map(x=>x.high));
 const stop=side==="LONG"?swingLow-0.20*a:swingHigh+0.20*a;
 const risk=side==="LONG"?entry-stop:stop-entry;
 if(!(risk>0)||risk/entry>0.012){reject.invalidStop++;continue;}
 if(m5[entryIndex].time>=nextAllowed){/* eligible */} else {reject.occupied++;continue;}
 if(openTrade){reject.occupied++;continue;}
 const t={side,signalTime:bar.time,entryTime:m5[entryIndex].time,entry,stop,risk,target1:entry+(side==="LONG"?1:-1)*risk,target2:entry+(side==="LONG"?2:-2)*risk,remaining:1,netR:0,target1Hit:false,target2Hit:false};
 openTrade=t;const maxTime=Math.min(m5[m5.length-1].time,t.entryTime+MAX_HOLD_HOURS*HOUR,Math.floor(t.entryTime/DAY)*DAY+DAY);
 for(let k=entryIndex;k<m5.length&&m5[k].time<=maxTime&&openTrade===t;k++){
   const b=m5[k],dir=side==="LONG"?1:-1;
   const stopGap=dir===1?b.open<=stop:b.open>=stop,stopTouch=dir===1?b.low<=stop:b.high>=stop;
   if(stopGap||stopTouch){closeTrade(t,stopGap?b.open:stop,b.time,"STOP");openTrade=null;nextAllowed=b.time+M5;break;}
   if(!t.target1Hit&&(dir===1?b.high>=t.target1:b.low<=t.target1)){
     const fill=t.target1*(1-dir*SLIPPAGE),rr=dir*(fill-entry)/risk,feeR=FEE*(entry+fill)/risk;
     t.netR+=0.5*(rr-feeR);t.remaining=0.5;t.target1Hit=true;
   }
   if(t.target1Hit&&!t.target2Hit&&(dir===1?b.high>=t.target2:b.low<=t.target2)){
     const fill=t.target2*(1-dir*SLIPPAGE),rr=dir*(fill-entry)/risk,feeR=FEE*(entry+fill)/risk;
     t.netR+=0.5*(rr-feeR);t.remaining=0;t.target2Hit=true;t.exitTime=b.time;t.exitPrice=fill;t.exitReason="TARGETS";trades.push(t);openTrade=null;nextAllowed=b.time+M5;break;
   }
   if(b.time>=maxTime&&openTrade===t){closeTrade(t,b.close,b.time,"INTRADAY_TIME_EXIT");openTrade=null;nextAllowed=b.time+M5;}
 }
 if(openTrade===t){const last=m5[Math.min(m5.length-1,indexAtOrBefore(m5,maxTime))];closeTrade(t,last.close,last.time,"DATA_END_OR_TIME_EXIT");openTrade=null;nextAllowed=last.time+M5;}
 i=Math.max(i,Math.floor((t.exitTime-m15[0].time)/M15)-1);
}
const long=trades.filter(t=>t.side==="LONG"),short=trades.filter(t=>t.side==="SHORT");
const result={symbol:SYMBOL,period:{from:new Date(from).toISOString(),to:new Date(to).toISOString()},candles:{m5:m5.length,m15:m15.length,h1:h1.length},settings:{strategy:"XAUT-only intraday trend-pullback continuation v2 (strict pullback, RSI/volume confirmation, 0.45% minimum stop distance)",independentOfBTC:true,entry:"next 5m open after closed 15m confirmation",riskPerTradePct:0.5,minStopDistancePct:0.45,maxStopDistancePct:1.2,target1R:1,target2R:2,scaleOut:"50% at 1R, 50% at 2R",maxHoldHours:MAX_HOLD_HOURS,forceExitAtUtcDayEnd:true,feePerSide:FEE,slippagePerSide:SLIPPAGE,sameCandlePriority:"STOP_FIRST",startingEquity:START_EQUITY},summary:metrics(trades),long:metrics(long),short:metrics(short),rejections:reject,trades};
await mkdir("artifacts",{recursive:true});
await writeFile("artifacts/xaut-intraday-backtest-v2.json",JSON.stringify(result,null,2));
const fmt=x=>Number(x).toFixed(3);
const md=["# XAUT independent intraday LONG/SHORT backtest — v2","",`Period: ${result.period.from} — ${result.period.to}`,"",`Candles: 5m=${m5.length}, 15m=${m15.length}, 1h=${h1.length}`,"","| Metric | All | LONG | SHORT |","|---|---:|---:|---:|",`| Trades | ${result.summary.trades} | ${result.long.trades} | ${result.short.trades} |`,`| Win rate | ${fmt(result.summary.winRatePct)}% | ${fmt(result.long.winRatePct)}% | ${fmt(result.short.winRatePct)}% |`,`| Net R | ${fmt(result.summary.netR)} | ${fmt(result.long.netR)} | ${fmt(result.short.netR)} |`,`| Expectancy R | ${fmt(result.summary.expectancyR)} | ${fmt(result.long.expectancyR)} | ${fmt(result.short.expectancyR)} |`,`| Profit factor | ${result.summary.profitFactor===null?"∞":fmt(result.summary.profitFactor)} | ${result.long.profitFactor===null?"∞":fmt(result.long.profitFactor)} | ${result.short.profitFactor===null?"∞":fmt(result.short.profitFactor)} |`,`| Max drawdown R | ${fmt(result.summary.maxDrawdownR)} | ${fmt(result.long.maxDrawdownR)} | ${fmt(result.short.maxDrawdownR)} |`,"", "## Rejection counts",...Object.entries(reject).map(([k,v])=>`- ${k}: ${v}`),"","Costs include configured fee and slippage. Funding, liquidation, and live execution latency are not modeled.",""];
await writeFile("artifacts/xaut-intraday-backtest-v2.md",md.join("\n"));
console.log(JSON.stringify({symbol:SYMBOL,period:result.period,candles:result.candles,summary:result.summary,long:result.long,short:result.short,rejections:reject},null,2));

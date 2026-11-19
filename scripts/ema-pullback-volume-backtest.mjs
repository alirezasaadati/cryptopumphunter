import { evaluateEmaPullback } from "../src/ema-pullback-volume-engine.js";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

const SYMBOL="BTCUSDT", START=Date.UTC(2025,10,1), END=Date.UTC(2026,10,1);
const FIVE=300000, FEE=0.0005, SLIPPAGE=0.0003, MAX_HOLD=7*24*12;
function months(){const a=[];for(let y=2025,m=11;y<2026||(y===2026&&m<=10);){a.push(y+"-"+String(m).padStart(2,"0"));m++;if(m===13){m=1;y++;}}return a;}
async function load5m(){
 const all=[];
 for(const month of months()){
  const file=SYMBOL+"-5m-"+month+".zip",url="https://data.binance.vision/data/spot/monthly/klines/"+SYMBOL+"/5m/"+file;
  const res=await fetch(url,{signal:AbortSignal.timeout(90000)});if(!res.ok)throw new Error("Archive download failed "+res.status);
  const path=join(tmpdir(),file),bytes=Buffer.from(await res.arrayBuffer());
  await import("node:fs/promises").then(fs=>fs.writeFile(path,bytes));
  const csv=execFileSync("unzip",["-p",path],{encoding:"utf8",maxBuffer:128*1024*1024});
  for(const line of csv.split(/\r?\n/)){if(!line)continue;const p=line.split(",");if(!/^\d+$/.test(p[0]||""))continue;
   const t=Number(p[0]),c={time:t>1e14?Math.floor(t/1000):t,open:+p[1],high:+p[2],low:+p[3],close:+p[4],volume:+p[5]};
   if(c.time>=START-4*86400000&&c.time<END&&Object.values(c).every(Number.isFinite))all.push(c);
  }
  process.stdout.write("Downloaded "+month+"\n");
 }
 const map=new Map(all.map(c=>[c.time,c]));return [...map.values()].sort((a,b)=>a.time-b.time);
}
function aggregate(xs,ms,count){const groups=new Map();for(const c of xs){const t=Math.floor(c.time/ms)*ms;if(!groups.has(t))groups.set(t,[]);groups.get(t).push(c);}
 return [...groups.entries()].sort((a,b)=>a[0]-b[0]).filter(([,v])=>v.length===count).map(([time,v])=>({time,open:v[0].open,high:Math.max(...v.map(x=>x.high)),low:Math.min(...v.map(x=>x.low)),close:v.at(-1).close,volume:v.reduce((s,x)=>s+x.volume,0)}));}
function fill(price,dir,isEntry){return price*(1+(isEntry?dir:-dir)*SLIPPAGE);}
function runPair(htf,ltf,label,htfMs,ltfMs){
 let hp=0,trades=[],rejected={},signals=0,busyUntil=-1,lastKey="";
 for(let i=60;i<ltf.length-1;i++){
  const closeTime=ltf[i].time+ltfMs;while(hp<htf.length&&htf[hp].time+htfMs<=closeTime)hp++;if(hp<60)continue;
  const result=evaluateEmaPullback({symbol:SYMBOL,higherTimeframe:htf.slice(Math.max(0,hp-100),hp),entryTimeframe:ltf.slice(Math.max(0,i-119),i+1)});
  if(!result.eligible){rejected[result.rejected]=(rejected[result.rejected]||0)+1;continue;}
  const s=result.signal,key=s.side+"|"+s.time;if(key===lastKey)continue;lastKey=key;signals++;if(i+1<=busyUntil)continue;
  const dir=s.side==="LONG"?1:-1,first=ltf[i+1],entry=fill(first.open,dir,true),stop=s.stop,risk=dir*(entry-stop);if(!(risk>0))continue;
  const targets=[entry+dir*risk*2,entry+dir*risk*3];let remaining=1,netR=0,exitReason="TIME_EXIT",exitTime=null,targetHits=0;
  const maxHoldBars=Math.floor(7*24*60*60*1000/ltfMs);
  const end=Math.min(ltf.length-1,i+1+maxHoldBars);
  for(let j=i+1;j<=end&&remaining>1e-9;j++){
   const b=ltf[j],gap=dir===1?b.open<=stop:b.open>=stop,touched=dir===1?b.low<=stop:b.high>=stop;
   if(gap||touched){const px=fill(gap?b.open:stop,dir,false);netR+=remaining*(dir*(px-entry)/risk-FEE*(entry+px)/risk);remaining=0;exitReason="STOP";exitTime=b.time;break;}
   for(let k=0;k<2&&remaining>1e-9;k++){const hit=dir===1?b.high>=targets[k]:b.low<=targets[k];if(!hit)continue;
    const px=fill(targets[k],dir,false);netR+=0.5*(dir*(px-entry)/risk-FEE*(entry+px)/risk);remaining-=0.5;targetHits++;}
   if(remaining<=1e-9){remaining=0;exitReason="ALL_TARGETS";exitTime=b.time;break;}
   if(j===end){const px=fill(b.close,dir,false);netR+=remaining*(dir*(px-entry)/risk-FEE*(entry+px)/risk);remaining=0;exitReason="TIME_EXIT";exitTime=b.time;}
  }
  trades.push({side:s.side,signalTime:s.time,entryTime:first.time,entry,stop,targets,netR,targetHits,exitReason,exitTime});
  const endIdx=ltf.findIndex((b,k)=>k>i&&b.time===exitTime);busyUntil=endIdx<0?end:endIdx;
 }
 const wins=trades.filter(t=>t.netR>0),losses=trades.filter(t=>t.netR<0),gw=wins.reduce((a,t)=>a+t.netR,0),gl=Math.abs(losses.reduce((a,t)=>a+t.netR,0));
 let eq=0,peak=0,dd=0;for(const t of trades){eq+=t.netR;peak=Math.max(peak,eq);dd=Math.max(dd,peak-eq);}
 return {configuration:label,signals,trades:trades.length,wins:wins.length,losses:losses.length,winRatePct:trades.length?100*wins.length/trades.length:null,
  netR:trades.reduce((a,t)=>a+t.netR,0),expectancyR:trades.length?trades.reduce((a,t)=>a+t.netR,0)/trades.length:null,
  profitFactor:gl?gw/gl:gw?null:null,maxDrawdownR:dd,long:trades.filter(t=>t.side==="LONG").length,short:trades.filter(t=>t.side==="SHORT").length,rejections:rejected,tradeLog:trades};
}
async function main(){
 const m5=await load5m();if(m5.length<100000)throw new Error("Incomplete M5 dataset: "+m5.length);
 const m15=aggregate(m5,15*60000,3),h1=aggregate(m5,60*60000,12),h4=aggregate(m5,4*60*60000,48);
 const results=[runPair(h1,m15,"H1 trend + M15 entry",60*60000,15*60000),runPair(h4,m5,"H4 trend + M5 entry",4*60*60000,FIVE)];
 const report={symbol:SYMBOL,period:{start:new Date(START).toISOString(),end:new Date(END).toISOString()},candles:{m5:m5.length,m15:m15.length,h1:h1.length,h4:h4.length},
  assumptions:{trend:"HTF close vs EMA50 and EMA20 vs EMA50",entry:"pullback volume contraction + confirmed pivot or EMA20-50 band + engulfing/pinbar + trigger volume expansion",
   execution:"next entry timeframe open; 0.03% slippage each side; 0.05% fee each side; 50% exit at 2R and 50% at 3R; stop-first on ambiguous candles; max hold 7 days; one position at a time",
   limitation:"No funding, spread, market impact or historical news filter."},results};
 await mkdir("artifacts",{recursive:true});await writeFile("artifacts/ema-pullback-volume-backtest.json",JSON.stringify(report,null,2));
 const lines=["# BTC EMA Pullback + Volume Backtest","","Period: "+report.period.start+" to "+report.period.end,"","Candles: M5 "+m5.length+", M15 "+m15.length+", H1 "+h1.length+", H4 "+h4.length,""];
 for(const r of results){lines.push("## "+r.configuration,"","- Signals: "+r.signals,"- Trades: "+r.trades,"- Wins / losses: "+r.wins+" / "+r.losses,
  "- Win rate: "+(r.winRatePct===null?"n/a":r.winRatePct.toFixed(2)+"%"),"- Net R: "+r.netR.toFixed(3),
  "- Expectancy: "+(r.expectancyR===null?"n/a":r.expectancyR.toFixed(3)+"R"),"- Profit factor: "+(r.profitFactor===null?"n/a":r.profitFactor.toFixed(3)),
  "- Max drawdown: "+r.maxDrawdownR.toFixed(3)+"R","- Long / short: "+r.long+" / "+r.short,"","### Rejections","",
  ...Object.entries(r.rejections).sort((a,b)=>b[1]-a[1]).map(x=>"- "+x[0]+": "+x[1]),"");}
 lines.push("## Assumptions","","- "+report.assumptions.trend,"- "+report.assumptions.entry,"- "+report.assumptions.execution,"- "+report.assumptions.limitation,"");
 await writeFile("artifacts/ema-pullback-volume-backtest.md",lines.join("\n"));
 console.log(JSON.stringify(results.map(({tradeLog,rejections,...r})=>r),null,2));
}
main().catch(e=>{console.error(e);process.exitCode=1;});

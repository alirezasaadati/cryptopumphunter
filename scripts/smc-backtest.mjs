import { analyzeSMCSignal } from "../src/smc-signal-engine.js";
import { mkdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SYMBOL="BTCUSDT";
const START=Date.UTC(2025,10,1);
const END=Date.UTC(2026,10,1);
const FIVE=5*60_000, FIFTEEN=15*60_000, FOUR_H=4*60*60_000;
const FEE=0.0005, SLIPPAGE=0.0003, MAX_HOLD_BARS=72*12;
const WEIGHTS=[0.40,0.35,0.25];

function monthKeys(){
  const out=[];
  for(let y=2025,m=11;y<2026||(y===2026&&m<=10);){
    out.push(y+"-"+String(m).padStart(2,"0"));
    m++;if(m===13){m=1;y++;}
  }
  return out;
}
async function downloadKlines(interval,month){
  const file=SYMBOL+"-"+interval+"-"+month+".zip";
  const url="https://data.binance.vision/data/spot/monthly/klines/"+SYMBOL+"/"+interval+"/"+file;
  const res=await fetch(url,{signal:AbortSignal.timeout(90000)});
  if(!res.ok)throw new Error("Archive download failed "+res.status+": "+url);
  const bytes=Buffer.from(await res.arrayBuffer());
  const zip=join(tmpdir(),file);
  await import("node:fs/promises").then(fs=>fs.writeFile(zip,bytes));
  const csv=execFileSync("unzip",["-p",zip],{maxBuffer:128*1024*1024,encoding:"utf8"});
  return csv.split(/\r?\n/).filter(Boolean).map(line=>{
    const p=line.split(",");
    if(!/^\d+$/.test(p[0]||""))return null;
    const rawTime=Number(p[0]);
    // Binance Vision switched recent archive timestamps to microseconds.
    const c={time:rawTime>1e14?Math.floor(rawTime/1000):rawTime,
      open:Number(p[1]),high:Number(p[2]),low:Number(p[3]),close:Number(p[4]),volume:Number(p[5])};
    if(![c.time,c.open,c.high,c.low,c.close,c.volume].every(Number.isFinite))return null;
    return c;
  }).filter(Boolean);
}
async function loadInterval(interval){
  const all=[];
  for(const month of monthKeys()){
    const rows=await downloadKlines(interval,month);
    all.push(...rows);
    process.stdout.write("Downloaded "+interval+" "+month+": "+rows.length+" rows\n");
  }
  const map=new Map();
  for(const c of all)if(c.time>=START-7*24*60*60_000&&c.time<END)map.set(c.time,c);
  return [...map.values()].sort((a,b)=>a.time-b.time);
}
function aggregate(candles,interval,requiredCount){
  const groups=new Map();
  for(const c of candles){
    const t=Math.floor(c.time/interval)*interval;
    if(!groups.has(t))groups.set(t,[]);
    groups.get(t).push(c);
  }
  return [...groups.entries()].sort((a,b)=>a[0]-b[0]).filter(([,xs])=>xs.length===requiredCount)
    .map(([time,xs])=>({time,open:xs[0].open,high:Math.max(...xs.map(x=>x.high)),
      low:Math.min(...xs.map(x=>x.low)),close:xs.at(-1).close,
      volume:xs.reduce((s,x)=>s+x.volume,0)}));
}
function adverseFill(price,dir,entry=false){return price*(1+(entry?dir:-dir)*SLIPPAGE);}
function simulate(signal,bars,startIndex){
  const dir=signal.side==="LONG"?1:-1;
  const entry=adverseFill(bars[startIndex].open,dir,true);
  const stop=signal.stop;
  const risk=dir*(entry-stop);
  if(!(risk>0))return null;
  const targets=[signal.target1,signal.target2,signal.target3];
  let remaining=1,netR=0,targetHits=0,exitReason="TIME_EXIT",exitTime=null;
  const end=Math.min(bars.length-1,startIndex+MAX_HOLD_BARS);
  for(let i=startIndex;i<=end&&remaining>1e-9;i++){
    const b=bars[i];
    const gap=dir===1?b.open<=stop:b.open>=stop;
    const touched=dir===1?b.low<=stop:b.high>=stop;
    if(gap||touched){
      const raw=gap?b.open:stop,fill=adverseFill(raw,dir,false);
      netR+=remaining*(dir*(fill-entry)/risk-FEE*(entry+fill)/risk);
      remaining=0;exitReason="STOP";exitTime=b.time;break;
    }
    for(let t=0;t<3&&remaining>1e-9;t++){
      const target=targets[t];
      const hit=dir===1?b.high>=target:b.low<=target;
      if(!hit)continue;
      const portion=WEIGHTS[t],fill=adverseFill(target,dir,false);
      netR+=portion*(dir*(fill-entry)/risk-FEE*(entry+fill)/risk);
      remaining-=portion;targetHits++;
    }
    if(remaining<=1e-9){remaining=0;exitReason="ALL_TARGETS";exitTime=b.time;break;}
    if(i===end){
      const fill=adverseFill(b.close,dir,false);
      netR+=remaining*(dir*(fill-entry)/risk-FEE*(entry+fill)/risk);
      remaining=0;exitReason="TIME_EXIT";exitTime=b.time;
    }
  }
  return{side:signal.side,entry,stop,targets,netR,targetHits,exitReason,
    entryTime:bars[startIndex].time,exitTime,score:signal.score};
}
function metrics(trades){
  const wins=trades.filter(t=>t.netR>0),losses=trades.filter(t=>t.netR<0);
  const grossWin=wins.reduce((s,t)=>s+t.netR,0),grossLoss=Math.abs(losses.reduce((s,t)=>s+t.netR,0));
  let equity=0,peak=0,maxDD=0;
  for(const t of trades){equity+=t.netR;peak=Math.max(peak,equity);maxDD=Math.max(maxDD,peak-equity);}
  return{trades:trades.length,wins:wins.length,losses:losses.length,breakeven:trades.length-wins.length-losses.length,
    winRatePct:trades.length?100*wins.length/trades.length:0,netR:trades.reduce((s,t)=>s+t.netR,0),
    expectancyR:trades.length?trades.reduce((s,t)=>s+t.netR,0)/trades.length:0,
    profitFactor:grossLoss?grossWin/grossLoss:grossWin?null:0,maxDrawdownR:maxDD,
    targetHits:trades.reduce((s,t)=>s+t.targetHits,0)};
}
async function main(){
  const [m5,m15]=await Promise.all([loadInterval("5m"),loadInterval("15m")]);
  const h4=aggregate(m15,FOUR_H,16);
  if(m5.length<100000||m15.length<30000||h4.length<2000)
    throw new Error("Unexpectedly incomplete data: 5m="+m5.length+", 15m="+m15.length+", H4="+h4.length);
  let p15=0,p4=0,signals=0,rejected=0,overlapSkipped=0;
  let openUntil=-1,lastSignalKey="",lastEvaluated15=-1;
  const trades=[],rejectReasons={};
  for(let i=60;i<m5.length-1;i++){
    const now=m5[i].time+FIVE;
    while(p15<m15.length&&m15[p15].time+FIFTEEN<=now)p15++;
    while(p4<h4.length&&h4[p4].time+FOUR_H<=now)p4++;
    if(p15<60||p4<60)continue;
    const last15=m15[p15-1];
    // Evaluate each newly closed M5 bar; 15m/H4 inputs contain closed bars only.
    const result=analyzeSMCSignal({
      symbol:SYMBOL,
      higherTimeframe:h4.slice(Math.max(0,p4-100),p4),
      structureTimeframe:m15.slice(Math.max(0,p15-120),p15),
      entryTimeframe:m5.slice(Math.max(0,i-64),i+1),
      // News is deliberately neutralized for this technical-only test; news performance is NOT tested. // CHOCH v2: reversal-only trigger.
      news:{status:"CLEAR",highImpact:false,score:100,reason:"News layer bypassed: no historical news archive in this test."},
      riskConfig:{maxRiskPct:0.04}
    });
    if(!result.eligible){
      if(result.rejected)rejectReasons[result.rejected]=(rejectReasons[result.rejected]||0)+1;
      rejected++;continue;
    }
    const s=result.signal,d=result.diagnostics;
    const key=[s.side,d.bos?.time,d.choch?.time,d.fvg?.index].join("|");
    if(key===lastSignalKey)continue;
    lastSignalKey=key;signals++;
    const nextIndex=i+1;
    if(nextIndex<=openUntil){overlapSkipped++;continue;}
    const trade=simulate(s,m5,nextIndex);
    if(!trade)continue;
    trade.signalTime=now;trade.bosTime=d.bos?.time;trade.chochTime=d.choch?.time;
    trades.push(trade);
    const exitIndex=m5.findIndex(c=>c.time===trade.exitTime);
    openUntil=Math.max(nextIndex,exitIndex);
    if(i%10000===0)process.stdout.write("Processed "+i+"/"+m5.length+" M5 candles; trades="+trades.length+"\n");
  }
  trades.sort((a,b)=>a.entryTime-b.entryTime);
  const bySide={LONG:metrics(trades.filter(t=>t.side==="LONG")),SHORT:metrics(trades.filter(t=>t.side==="SHORT"))};
  const byMonth={};
  for(const t of trades){const k=new Date(t.entryTime).toISOString().slice(0,7);(byMonth[k]??=[]).push(t);}
  const report={
    generatedAt:new Date().toISOString(),symbol:SYMBOL,venue:"Binance Spot public monthly klines",
    period:{from:new Date(START).toISOString(),to:new Date(END).toISOString(),days:365},
    data:{m5:m5.length,m15:m15.length,h4:h4.length,missingM5:0,missingM15:0},
    assumptions:{higherTimeframe:"4h",structureTimeframe:"15m",entryTimeframe:"5m",
      entry:"next 5m candle open with adverse slippage",feePerSidePct:FEE*100,slippagePerSidePct:SLIPPAGE*100,
      maxHoldHours:72,partialTargetsPct:[40,35,25],sameCandleStopAndTarget:"stop first",
      funding:"not applicable (spot)",newsFilter:"bypassed with CLEAR; historical news not tested",
      riskMaxPct:4,onePositionAtATime:true,lookahead:"confirmed pivots only; closed candles only"},
    counts:{signals,rejected,overlapSkipped,executedTrades:trades.length,rejectionReasons:rejectReasons},
    overall:metrics(trades),bySide,byMonth:Object.fromEntries(Object.entries(byMonth).map(([k,v])=>[k,metrics(v)])),
    trades
  };
  await mkdir("artifacts",{recursive:true});
  await writeFile("artifacts/btc-smc-one-year.json",JSON.stringify(report,null,2));
  const pct=x=>Number(x||0).toFixed(2)+"%";
  const lines=["# BTCUSDT SMC engine — 1-year backtest","",
    "Period: "+report.period.from+" → "+report.period.to+" (365 days)","",
    "## Data & execution","",
    "- Binance Spot public klines; "+m5.length+" M5, "+m15.length+" M15, "+h4.length+" H4 candles",
    "- H4 trend / M15 liquidity + OB / M5 CHOCH + FVG",
    "- Entry next M5 open; fee 0.05% and slippage 0.03% per side",
    "- Partial exits 40% / 35% / 25%; stop-first ambiguity; max hold 72h",
    "- News layer bypassed as CLEAR; this is technical-only and does not validate news filter","",
    "## Results","",
    "| Metric | Result |","|---|---:|",
    "| Signals | "+signals+" |","| Rejected evaluations | "+rejected+" |","| Skipped (position open) | "+overlapSkipped+" |",
    "| Executed trades | "+trades.length+" |","| Win rate | "+pct(report.overall.winRatePct)+" |",
    "| Net result | "+report.overall.netR.toFixed(2)+"R |","| Expectancy | "+report.overall.expectancyR.toFixed(3)+"R |",
    "| Profit factor | "+(report.overall.profitFactor===null?"n/a":report.overall.profitFactor.toFixed(3))+" |","| Max drawdown | "+report.overall.maxDrawdownR.toFixed(2)+"R |","",
    "## Long / Short","",
    "| Side | Trades | Win rate | Net R | Expectancy | PF |","|---|---:|---:|---:|---:|---:|",
    ...["LONG","SHORT"].map(k=>{const x=bySide[k];return "| "+k+" | "+x.trades+" | "+pct(x.winRatePct)+" | "+x.netR.toFixed(2)+" | "+x.expectancyR.toFixed(3)+" | "+(x.profitFactor===null?"n/a":x.profitFactor.toFixed(3))+" |";}),
    "","Caution: the news layer is not historically tested; results must not be treated as a fully validated live strategy.",
    "Full trade-level data: btc-smc-one-year.json",""].join("\n");
  await writeFile("artifacts/btc-smc-one-year.md",lines);
  process.stdout.write("\n"+lines+"\n");
}
main().catch(e=>{console.error(e);process.exitCode=1;});

import { mkdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SYMBOL = "BTCUSDT";
const INTERVAL = 15 * 60 * 1000;
const FOUR_HOURS = 4 * 60 * 60 * 1000;
const DAYS = 365;
const FEE = 0.0005;
const SLIPPAGE = 0.0003;
const H4_ORDER = 5;
const M15_ORDER = 3;
const MIN_RR = 2;
const MAX_HOLD_BARS = 72 * 4;

async function fetchKlines() {
  const end=Date.now(), start=end-DAYS*86400000;
  const now=new Date(end), from=new Date(start), rows=[];
  const months=[];
  let y=from.getUTCFullYear(),m=from.getUTCMonth()+1;
  while(y<now.getUTCFullYear()||(y===now.getUTCFullYear()&&m<=now.getUTCMonth()+1)){
    months.push({y,m}); if(++m===13){m=1;y++;}
  }
  async function csvFromZip(url){
    const res=await fetch(url,{signal:AbortSignal.timeout(45000)});
    if(res.status===404)return null;
    if(!res.ok)throw new Error("Archive HTTP "+res.status+" "+url);
    const path=join(tmpdir(),"btc-"+Date.now()+"-"+Math.random().toString(16).slice(2)+".zip");
    const {writeFile:wt,unlink}=await import("node:fs/promises");
    await wt(path,Buffer.from(await res.arrayBuffer()));
    try{return execFileSync("unzip",["-p",path],{encoding:"utf8",maxBuffer:80*1024*1024});}
    finally{await unlink(path).catch(()=>{});}
  }
  function parse(csv){
    if(!csv)return;
    for(const line of csv.trim().split(/\r?\n/)){
      const x=line.split(","); if(x.length<7)continue;
      let t=Number(x[0]),ct=Number(x[6]);
      if(t>1e14)t=Math.floor(t/1000); if(ct>1e14)ct=Math.floor(ct/1000);
      const c={time:t,open:+x[1],high:+x[2],low:+x[3],close:+x[4],volume:+x[5],closeTime:ct};
      if(t>=start&&ct<end&&Number.isFinite(c.close)&&c.close>0)rows.push(c);
    }
  }
  for(const {y,m} of months){
    const mm=String(m).padStart(2,"0");
    const name=SYMBOL+"-15m-"+y+"-"+mm+".zip";
    const url="https://data.binance.vision/data/spot/monthly/klines/"+SYMBOL+"/15m/"+name;
    const csv=await csvFromZip(url);
    if(csv!==null)parse(csv);
    else{
      const days=new Date(Date.UTC(y,m,0)).getUTCDate();
      for(let d=1;d<=days;d++){
        const date=y+"-"+mm+"-"+String(d).padStart(2,"0");
        parse(await csvFromZip("https://data.binance.vision/data/spot/daily/klines/"+SYMBOL+"/15m/"+SYMBOL+"-15m-"+date+".zip"));
      }
    }
    await new Promise(r=>setTimeout(r,80));
  }
  // Current month: daily archives only, through yesterday UTC.
  const cy=now.getUTCFullYear(),cm=now.getUTCMonth()+1,lastDay=now.getUTCDate()-1;
  for(let d=1;d<=lastDay;d++){
    const date=cy+"-"+String(cm).padStart(2,"0")+"-"+String(d).padStart(2,"0");
    parse(await csvFromZip("https://data.binance.vision/data/spot/daily/klines/"+SYMBOL+"/15m/"+SYMBOL+"-15m-"+date+".zip"));
    await new Promise(r=>setTimeout(r,80));
  }
  return [...new Map(rows.map(c=>[c.time,c])).values()].sort((a,b)=>a.time-b.time);
}

function aggregate4h(m15) {
  const groups = new Map();
  for (const c of m15) {
    const t = Math.floor(c.time / FOUR_HOURS) * FOUR_HOURS;
    let g = groups.get(t);
    if (!g) {
      g = { time:t, open:c.open, high:c.high, low:c.low, close:c.close, count:0 };
      groups.set(t,g);
    }
    g.high = Math.max(g.high,c.high);
    g.low = Math.min(g.low,c.low);
    g.close = c.close;
    g.count++;
  }
  return [...groups.values()].filter(x=>x.count===16).sort((a,b)=>a.time-b.time);
}

function findSwings(candles, order) {
  const highs=[], lows=[];
  for (let i=order;i<candles.length-order;i++) {
    let max=-Infinity,min=Infinity,maxCount=0,minCount=0;
    for (let j=i-order;j<=i+order;j++) {
      const h=candles[j].high, l=candles[j].low;
      if (h>max) {max=h;maxCount=1;} else if (h===max) maxCount++;
      if (l<min) {min=l;minCount=1;} else if (l===min) minCount++;
    }
    if (candles[i].high===max && maxCount===1)
      highs.push({type:"HIGH",index:i,confirmedAt:i+order,price:candles[i].high,time:candles[i].time});
    if (candles[i].low===min && minCount===1)
      lows.push({type:"LOW",index:i,confirmedAt:i+order,price:candles[i].low,time:candles[i].time});
  }
  return [...highs,...lows].sort((a,b)=>a.confirmedAt-b.confirmedAt || a.index-b.index);
}

function lastTwo(list) { return list.length>=2 ? [list[list.length-2],list[list.length-1]] : [null,null]; }

function metrics(trades) {
  const wins=trades.filter(t=>t.netR>0), losses=trades.filter(t=>t.netR<0);
  const grossWin=wins.reduce((s,t)=>s+t.netR,0);
  const grossLoss=Math.abs(losses.reduce((s,t)=>s+t.netR,0));
  let equity=0, peak=0, maxDD=0;
  for (const t of trades) { equity+=t.netR; peak=Math.max(peak,equity); maxDD=Math.max(maxDD,peak-equity); }
  const total=trades.reduce((s,t)=>s+t.netR,0);
  return {
    trades:trades.length, wins:wins.length, losses:losses.length,
    breakeven:trades.length-wins.length-losses.length,
    winRatePct:trades.length?100*wins.length/trades.length:0,
    netR:total, expectancyR:trades.length?total/trades.length:0,
    profitFactor:grossLoss?grossWin/grossLoss:(grossWin?null:0),
    maxDrawdownR:maxDD,
    takeProfitExits:trades.filter(t=>t.exit==="TP").length,
    stopExits:trades.filter(t=>t.exit==="SL").length,
    timeExits:trades.filter(t=>t.exit==="TIME").length
  };
}

function simulate(candles, entryIndex, side, entry, stop, target) {
  const dir=side==="LONG"?1:-1;
  const risk=dir===1?entry-stop:stop-entry;
  const entryFill=entry*(1+dir*SLIPPAGE);
  const end=Math.min(candles.length-1,entryIndex+MAX_HOLD_BARS);
  for (let i=entryIndex;i<=end;i++) {
    const c=candles[i];
    const stopGap=dir===1?c.open<=stop:c.open>=stop;
    const stopTouch=dir===1?c.low<=stop:c.high>=stop;
    const targetGap=dir===1?c.open>=target:c.open<=target;
    const targetTouch=dir===1?c.high>=target:c.low<=target;
    let exitPrice, reason;
    if (stopGap || stopTouch) {
      exitPrice=stopGap?c.open:stop;
      reason="SL";
    } else if (targetGap || targetTouch) {
      exitPrice=targetGap?c.open:target;
      reason="TP";
    } else if (i===end) {
      exitPrice=c.close;
      reason="TIME";
    } else continue;
    const exitFill=exitPrice*(1-dir*SLIPPAGE);
    const grossR=dir*(exitFill-entryFill)/risk;
    const fees=FEE*(entryFill+exitFill)/risk;
    return {side,entry:entryFill,stop,target,netR:grossR-fees,exit:reason,
      entryTime:candles[entryIndex].time,exitTime:c.time,holdingBars:i-entryIndex+1};
  }
  return null;
}

function runBacktest(m15,h4) {
  const h4Swings=findSwings(h4,H4_ORDER);
  const m15Swings=findSwings(m15,M15_ORDER);
  let h4Ptr=0,m15Ptr=0,h4Highs=[],h4Lows=[],mHighs=[],mLows=[];
  let h4Index=-1, activeUntil=-1, signals=0, invalidRR=0;
  const trades=[];
  const signalRows=[];
  for (let i=0;i<m15.length-1;i++) {
    const closeTime=m15[i].time+INTERVAL;
    while (h4Index+1<h4.length && h4[h4Index+1].time+FOUR_HOURS<=closeTime) h4Index++;
    if (h4Index<0) continue;
    while (h4Ptr<h4Swings.length && h4Swings[h4Ptr].confirmedAt<=h4Index) {
      const s=h4Swings[h4Ptr++];
      (s.type==="HIGH"?h4Highs:h4Lows).push(s);
    }
    while (m15Ptr<m15Swings.length && m15Swings[m15Ptr].confirmedAt<=i) {
      const s=m15Swings[m15Ptr++];
      (s.type==="HIGH"?mHighs:mLows).push(s);
    }
    if (h4Highs.length<2 || h4Lows.length<2 || mHighs.length<2 || mLows.length<2) continue;
    const [ph,lh]=lastTwo(h4Highs), [pl,ll]=lastTwo(h4Lows);
    let trend="NEUTRAL";
    if (lh.price>ph.price && ll.price>pl.price) trend="BULLISH";
    else if (lh.price<ph.price && ll.price<pl.price) trend="BEARISH";
    if (trend==="NEUTRAL") continue;

    const [pmh,lmh]=lastTwo(mHighs), [pml,lml]=lastTwo(mLows);
    const prevClose=m15[i-1]?.close, close=m15[i].close;
    let side=null, stop=null, target=null, broken=null, correctionPivot=null;
    if (trend==="BULLISH") {
      const correction=lmh.price<pmh.price && lml.price<pml.price && lmh.index<lml.index;
      const choch=prevClose<=lmh.price && close>lmh.price;
      if (correction && choch) {
        side="LONG"; stop=lml.price; target=lh.price; broken=lmh.price; correctionPivot=lml.time;
      }
    } else {
      const correction=lmh.price>pmh.price && lml.price>pml.price && lml.index<lmh.index;
      const choch=prevClose>=lml.price && close<lml.price;
      if (correction && choch) {
        side="SHORT"; stop=lmh.price; target=ll.price; broken=lml.price; correctionPivot=lmh.time;
      }
    }
    if (!side) continue;
    signals++;
    const next=m15[i+1];
    const entry=next.open;
    const dir=side==="LONG"?1:-1;
    const risk=dir===1?entry-stop:stop-entry;
    const reward=dir===1?target-entry:entry-target;
    if (!(risk>0 && reward>0 && reward/risk>=MIN_RR)) {invalidRR++;continue;}
    const signalId=side+":"+m15[i].time+":"+broken+":"+correctionPivot;
    signalRows.push({time:m15[i].time,side,entry,stop,target,rr:reward/risk,signalId});
    if (i+1<=activeUntil) continue;
    const trade=simulate(m15,i+1,side,entry,stop,target);
    if (trade) {
      trade.signalTime=m15[i].time;
      trade.rr=reward/risk;
      trades.push(trade);
      const exitIndex=Math.max(i+1,Math.floor((trade.exitTime-m15[0].time)/INTERVAL));
      activeUntil=exitIndex;
    }
  }
  return {signals,invalidRR,executed:trades.length,trades,metrics:metrics(trades),signalRows};
}

function periodSummary(trades) {
  const out={};
  for (const t of trades) {
    const key=new Date(t.entryTime).toISOString().slice(0,7);
    (out[key]??=[]).push(t);
  }
  return Object.fromEntries(Object.entries(out).map(([k,v])=>[k,metrics(v)]));
}

async function main() {
  const candles=await fetchKlines();
  if (candles.length<10000) throw new Error("Insufficient candles: "+candles.length);
  const gaps=[];
  for(let i=1;i<candles.length;i++) if(candles[i].time-candles[i-1].time!==INTERVAL) gaps.push({from:candles[i-1].time,to:candles[i].time});
  const h4=aggregate4h(candles);
  const result=runBacktest(candles,h4);
  const long=result.trades.filter(t=>t.side==="LONG"), short=result.trades.filter(t=>t.side==="SHORT");
  const report={
    generatedAt:new Date().toISOString(),symbol:SYMBOL,venue:"Binance Spot public klines",
    period:{from:new Date(candles[0].time).toISOString(),to:new Date(candles[candles.length-1].time+INTERVAL).toISOString(),days:DAYS},
    data:{m15Candles:candles.length,h4Candles:h4.length,missing15mIntervals:gaps.length,missingSamples:gaps.slice(0,10)},
    parameters:{h4SwingOrder:H4_ORDER,m15SwingOrder:M15_ORDER,minRiskReward:MIN_RR,feePerSidePct:FEE*100,slippagePerSidePct:SLIPPAGE*100,maxHoldingHours:72,entry:"next 15m candle open",sameCandleStopTarget:"stop first",capitalAllocation:"1R normalized; no compounding"},
    summary:{signals:result.signals,signalsRejectedByRR:result.invalidRR,executedTrades:result.executed,overall:result.metrics,
      long:metrics(long),short:metrics(short),monthly:periodSummary(result.trades)},
    trades:result.trades,signals:result.signalRows
  };
  await mkdir("artifacts",{recursive:true});
  await writeFile("artifacts/btc-market-structure-backtest.json",JSON.stringify(report,null,2));
  const lines=[
    "# BTCUSDT H4/M15 Market Structure Backtest","",
    "Period: "+report.period.from+" — "+report.period.to,
    "15m candles: "+candles.length+" | H4 candles: "+h4.length+" | missing 15m intervals: "+gaps.length,"",
    "## Results","",
    "| Metric | Overall | LONG | SHORT |",
    "|---|---:|---:|---:|",
    "| Executed trades | "+result.metrics.trades+" | "+metrics(long).trades+" | "+metrics(short).trades+" |",
    "| Win rate | "+result.metrics.winRatePct.toFixed(2)+"% | "+metrics(long).winRatePct.toFixed(2)+"% | "+metrics(short).winRatePct.toFixed(2)+"% |",
    "| Net R | "+result.metrics.netR.toFixed(2)+"R | "+metrics(long).netR.toFixed(2)+"R | "+metrics(short).netR.toFixed(2)+"R |",
    "| Expectancy | "+result.metrics.expectancyR.toFixed(3)+"R | "+metrics(long).expectancyR.toFixed(3)+"R | "+metrics(short).expectancyR.toFixed(3)+"R |",
    "| Profit factor | "+result.metrics.profitFactor+" | "+metrics(long).profitFactor+" | "+metrics(short).profitFactor+" |",
    "| Max drawdown | "+result.metrics.maxDrawdownR.toFixed(2)+"R | — | — |",
    "| TP exits | "+result.metrics.takeProfitExits+" | "+metrics(long).takeProfitExits+" | "+metrics(short).takeProfitExits+" |",
    "| SL exits | "+result.metrics.stopExits+" | "+metrics(long).stopExits+" | "+metrics(short).stopExits+" |",
    "| Time exits | "+result.metrics.timeExits+" | "+metrics(long).timeExits+" | "+metrics(short).timeExits+" |",
    "",
    "Signals detected: "+result.signals+"; rejected by RR at next-open execution: "+result.invalidRR+".",
    "Assumptions: entry at next 15m open; 0.05% fee and 0.03% slippage each side; full exit at one H4 swing target; 72h max hold; stop-first when SL and TP touch in the same candle; one open trade at a time. Results are normalized in R and exclude funding.",
    "",
    "## Monthly",
    "| Month | Trades | Win rate | Net R | Expectancy | PF |",
    "|---|---:|---:|---:|---:|---:|",
    ...Object.entries(report.summary.monthly).map(([m,x])=>"| "+m+" | "+x.trades+" | "+x.winRatePct.toFixed(2)+"% | "+x.netR.toFixed(2)+" | "+x.expectancyR.toFixed(3)+" | "+x.profitFactor+" |")
  ];
  await writeFile("artifacts/btc-market-structure-backtest.md",lines.join("\n"));
  console.log(JSON.stringify({ok:true,data:report.data,period:report.period,parameters:report.parameters,summary:report.summary},null,2));
}
main().catch(e=>{console.error(e);process.exitCode=1;});

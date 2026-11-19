import { mkdir, writeFile } from "node:fs/promises";

const BASE = "https://futures.kraken.com";
const H1 = 3600000, DAY = 86400000, MAX_HOLD = 72 * H1;
const START = Date.parse(process.env.BACKTEST_START || "2025-11-19T00:00:00Z");
const END = Date.parse(process.env.BACKTEST_END || "2026-11-19T00:00:00Z");
const SYMBOL_LIMIT = Math.max(3, Math.min(8, Number(process.env.BACKTEST_SYMBOLS || 8)));
const FEE = Number(process.env.BACKTEST_FEE || 0.0005);
const SLIP = Number(process.env.BACKTEST_SLIPPAGE || 0.0003);
const LEVELS = [0.236, 0.382, 0.5, 0.618, 0.786];
const WEIGHTS = [0.4, 0.35, 0.25];
const WARMUP = 45 * DAY;

async function getJson(url) {
  const r = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(30000) });
  const body = await r.text();
  if (!r.ok) throw new Error("HTTP " + r.status + " " + body.slice(0, 180));
  const d = JSON.parse(body);
  if (d?.result === "error" || d?.errors?.length) throw new Error(JSON.stringify(d.errors || d.error));
  return d;
}
function normalize(rows) {
  const m = new Map();
  for (const x of rows || []) {
    const c = { time: Number(x.time) < 1e12 ? Number(x.time) * 1000 : Number(x.time),
      open: +x.open, high: +x.high, low: +x.low, close: +x.close, volume: +x.volume };
    if (![c.time,c.open,c.high,c.low,c.close].every(Number.isFinite) || c.low <= 0 || c.high < c.low) continue;
    if (c.time + H1 > Date.now()) continue;
    m.set(c.time,c);
  }
  return [...m.values()].sort((a,b)=>a.time-b.time);
}
async function fetchCandles(symbol, from, to) {
  const chunk = H1 * 1700, out = [];
  for (let a=from; a<to; a+=chunk) {
    const b=Math.min(to,a+chunk), u=new URL(BASE+"/api/charts/v1/trade/"+encodeURIComponent(symbol)+"/1h");
    u.searchParams.set("from",String(Math.floor(a/1000)));
    u.searchParams.set("to",String(Math.floor(b/1000)));
    u.searchParams.set("count","1800");
    const d=await getJson(u);
    if (d.more_candles===true) throw new Error(symbol+" 1h chunk overflow");
    out.push(...(d.candles||[]));
  }
  return normalize(out).filter(c=>c.time>=from&&c.time<to);
}
async function mapLimit(items,limit,fn){const out=new Array(items.length);let next=0;await Promise.all(Array.from({length:Math.min(limit,items.length)},async()=>{while(next<items.length){const i=next++;try{out[i]=await fn(items[i],i);}catch(e){out[i]={symbol:items[i].symbol,error:e.message};}}}));return out;}

function confirmedSwing(bars, endTime) {
  const highs=[], lows=[];
  // Evaluate all pivots in the available history; only use a pivot after 3 right bars have closed.
  for(let i=3;i<bars.length-3;i++){
    const p=bars[i], confirmationTime=bars[i+3].time+H1;
    if(confirmationTime>endTime)continue;
    let hi=true,lo=true;
    for(let k=i-3;k<=i+3;k++){if(k===i)continue;if(bars[k].high>=p.high)hi=false;if(bars[k].low<=p.low)lo=false;}
    if(hi)highs.push({index:i,time:p.time,price:p.high,type:"H"});
    if(lo)lows.push({index:i,time:p.time,price:p.low,type:"L"});
  }
  const pivots=[...highs,...lows].sort((a,b)=>a.index-b.index);
  if(pivots.length<2)return null;
  // Select the most recent alternating confirmed pivot pair.
  for(let j=pivots.length-1;j>0;j--){
    const a=pivots[j-1],b=pivots[j];
    if(a.type==="L"&&b.type==="H"&&b.price>a.price)
      return {side:"LONG",low:a.price,high:b.price,anchor:a.price,anchorTime:a.time,endTime:b.time,key:"L"+a.time+"H"+b.time};
    if(a.type==="H"&&b.type==="L"&&a.price>b.price)
      return {side:"SHORT",high:a.price,low:b.price,anchor:a.price,anchorTime:a.time,endTime:b.time,key:"H"+a.time+"L"+b.time};
  }
  return null;
}
function levelPrice(swing,level){
  const range=swing.high-swing.low;
  return swing.side==="LONG" ? swing.high-range*level : swing.low+range*level;
}
function touchedLevel(bar,price){return bar.low<=price&&bar.high>=price;}
function touchedZone(bar,swing){
  const a=levelPrice(swing,0.618),b=levelPrice(swing,0.5);
  const lo=Math.min(a,b),hi=Math.max(a,b);
  return bar.low<=hi&&bar.high>=lo;
}
function simulate(bars,startIndex,swing,entryRaw,model,levelLabel){
  const dir=swing.side==="LONG"?1:-1,entry=entryRaw*(1+dir*SLIP),stop=swing.anchor;
  const risk=dir===1?entry-stop:stop-entry;
  if(!(risk>0))return null;
  const targets=[1,2,3].map(r=>entry+dir*risk*r);
  let remaining=1,netR=0;const hit=[false,false,false];
  const end=Math.min(bars.length-1,startIndex+Math.floor(MAX_HOLD/H1));
  let exitReason="TIME_EXIT",exitTime=bars[end].time;
  const fill=p=>p*(1-dir*SLIP);
  for(let i=startIndex;i<=end&&remaining>1e-9;i++){
    const b=bars[i],gap=dir===1?b.open<=stop:b.open>=stop,stopTouch=dir===1?b.low<=stop:b.high>=stop;
    const add=(portion,p)=>{const f=fill(p);netR+=portion*(dir*(f-entry)/risk-FEE*(entry+f)/risk);remaining-=portion;};
    if(gap||stopTouch){add(remaining,gap?b.open:stop);exitReason="STOP";exitTime=b.time;break;}
    for(let k=0;k<3&&remaining>1e-9;k++){
      const touch=dir===1?b.high>=targets[k]:b.low<=targets[k];
      if(touch&&!hit[k]){add(WEIGHTS[k],targets[k]);hit[k]=true;}
    }
    if(remaining<=1e-9){remaining=0;exitReason="TARGETS";exitTime=b.time;break;}
    if(i===end){add(remaining,b.close);exitTime=b.time;}
  }
  return {symbol:null,model,level:levelLabel,side:swing.side,swingKey:swing.key,anchorTime:swing.anchorTime,
    signalTime:bars[startIndex-1]?.time??bars[startIndex].time,entryTime:bars[startIndex].time,
    entry,stop,risk,targets,target1Hit:hit[0],target2Hit:hit[1],target3Hit:hit[2],netR,exitReason,exitTime};
}
function runVariant(symbol,bars,variant,level=null){
  const trades=[];let nextFree=0,lastSwingKey="";const consumedSwings=new Set();
  for(let i=1;i<bars.length-1;i++){
    const bar=bars[i],closeTime=bar.time+H1;
    if(closeTime<START||closeTime>=END||bar.time<nextFree)continue;
    const history=bars.slice(0,i+1);
    const swing=confirmedSwing(history,closeTime);
    if(!swing)continue;
    if(swing.key!==lastSwingKey)lastSwingKey=swing.key;
    if(consumedSwings.has(swing.key))continue;
    if(swing.endTime<=swing.anchorTime)continue;
    const eligible=variant==="all_levels"?touchedLevel(bar,levelPrice(swing,level)):touchedZone(bar,swing);
    if(!eligible)continue;
    const entryIndex=i+1;if(entryIndex>=bars.length)continue;
    const label=variant==="all_levels"?String(level):"0.5-0.618";
    const t=simulate(bars,entryIndex,swing,bars[entryIndex].open,variant,label);
    if(!t)continue;
    t.symbol=symbol;trades.push(t);consumedSwings.add(swing.key);nextFree=t.exitTime+H1;
  }
  return trades;
}
function metrics(rows){
  const wins=rows.filter(x=>x.netR>0),loss=rows.filter(x=>x.netR<0);
  const grossWin=wins.reduce((s,x)=>s+x.netR,0),grossLoss=Math.abs(loss.reduce((s,x)=>s+x.netR,0));
  let equity=0,peak=0,dd=0;for(const t of [...rows].sort((a,b)=>a.entryTime-b.entryTime)){equity+=t.netR;peak=Math.max(peak,equity);dd=Math.max(dd,peak-equity);}
  const total=rows.reduce((s,x)=>s+x.netR,0);
  return {trades:rows.length,wins:wins.length,losses:loss.length,winRatePct:rows.length?100*wins.length/rows.length:0,
    netR:total,expectancyR:rows.length?total/rows.length:0,profitFactor:grossLoss?grossWin/grossLoss:grossWin?null:0,maxDrawdownR:dd,
    tp1:rows.filter(x=>x.target1Hit).length,tp2:rows.filter(x=>x.target2Hit).length,tp3:rows.filter(x=>x.target3Hit).length,
    bySide:Object.fromEntries(["LONG","SHORT"].map(side=>{const a=rows.filter(x=>x.side===side),w=a.filter(x=>x.netR>0),l=a.filter(x=>x.netR<0),gw=w.reduce((s,x)=>s+x.netR,0),gl=Math.abs(l.reduce((s,x)=>s+x.netR,0)),n=a.reduce((s,x)=>s+x.netR,0);return [side,{trades:a.length,winRatePct:a.length?w.length/a.length*100:0,netR:n,expectancyR:a.length?n/a.length:0,profitFactor:gl?gw/gl:gw?null:0}];}))
  };
}
async function main(){
  if(!(END>START))throw new Error("Invalid backtest period");
  const tick=await getJson(BASE+"/derivatives/api/v3/tickers");
  const universe=(tick.tickers||[]).filter(t=>t?.tag==="perpetual"&&t.suspended!==true&&/^(PI|PF)_[A-Z0-9]+USD$/.test(String(t.symbol||""))&&Number(t.volumeQuote)>0)
    .sort((a,b)=>Number(b.volumeQuote)-Number(a.volumeQuote)).slice(0,SYMBOL_LIMIT);
  const results=await mapLimit(universe,3,async ticker=>{
    const bars=await fetchCandles(ticker.symbol,START-WARMUP,END);
    if(bars.length<500)throw new Error("Insufficient 1h candles: "+bars.length);
    const variants={};for(const level of LEVELS)variants["level_"+level]=runVariant(ticker.symbol,bars,"all_levels",level);
    variants.golden_zone=runVariant(ticker.symbol,bars,"golden_zone");
    return {symbol:ticker.symbol,candles:bars.length,variants};
  });
  const good=results.filter(x=>!x.error),failed=results.filter(x=>x.error);
  const summary={};for(const level of LEVELS){const id="level_"+level,rows=good.flatMap(x=>x.variants[id]);summary[id]={label:"Fib "+level,metrics:metrics(rows),trades:rows};}
  const zoneRows=good.flatMap(x=>x.variants.golden_zone);
  summary.golden_zone={label:"Fib 0.5-0.618 zone",metrics:metrics(zoneRows),trades:zoneRows};
  const report={generatedAt:new Date().toISOString(),venue:"Kraken Futures public historical OHLC",period:{from:new Date(START).toISOString(),to:new Date(END).toISOString()},
    rules:{timeframe:"1h only; no lower-timeframe confirmation or additional indicators",pivot:"confirmed pivot: 3 candles left + 3 candles right; usable only after third right candle closes; latest alternating confirmed pivots define impulse",
      model1:"five independent tests: 0.236, 0.382, 0.5, 0.618, 0.786; first candle touching the level triggers one entry per confirmed swing at next 1h open",
      model2:"first candle intersecting the 0.5-0.618 retracement band triggers one entry per confirmed swing at next 1h open",
      stop:"impulse anchor pivot",targets:"1R/2R/3R; partial exits 40%/35%/25%",feePerSidePct:FEE*100,slippagePerSidePct:SLIP*100,
      maxHoldHours:72,sameCandleAmbiguity:"stop first",funding:"excluded",nonOverlap:"one entry per confirmed swing per symbol and per level/variant; one open trade at a time",
      important:"Model 1 levels are separate independent portfolios; do not sum their trades or Net R into one portfolio."},
    symbols:{requested:universe.length,tested:good.length,failed},results:Object.fromEntries(Object.entries(summary).map(([k,v])=>[k,{label:v.label,metrics:v.metrics}])),
    trades:Object.fromEntries(Object.entries(summary).map(([k,v])=>[k,v.trades]))};
  await mkdir("artifacts",{recursive:true});
  await writeFile("artifacts/fibonacci-only-comparison.json",JSON.stringify(report,null,2));
  const rows=Object.entries(summary).map(([k,v])=>{const m=v.metrics;return "| "+v.label+" | "+m.trades+" | "+m.winRatePct.toFixed(2)+" | "+m.netR.toFixed(2)+" | "+m.expectancyR.toFixed(3)+" | "+(m.profitFactor===null?"n/a":m.profitFactor.toFixed(2))+" | "+m.maxDrawdownR.toFixed(2)+" | "+m.bySide.LONG.trades+" / "+m.bySide.LONG.netR.toFixed(2)+" | "+m.bySide.SHORT.trades+" / "+m.bySide.SHORT.netR.toFixed(2)+" |";});
  const md=["# Standalone Fibonacci backtest — two-model comparison","",
    "Period: "+report.period.from+" to "+report.period.to,
    "Symbols tested: "+good.length+"/"+universe.length+"; failed: "+failed.length,"",
    "| Test | Trades | Win % | Net R | Expectancy R | PF | Max DD R | LONG trades / Net R | SHORT trades / Net R |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|",...rows,"",
    "Costs: "+(FEE*100)+"% fee and "+(SLIP*100)+"% slippage per side; funding excluded.",
    "Model 1 levels are independent tests and must not be added together. Model 2 is one 0.5-0.618 band test.",
    "Universe is selected by current Kraken perpetual volume; results have universe/survivorship bias.",
    "Failed symbols:",...failed.map(x=>"- "+x.symbol+": "+x.error)];
  await writeFile("artifacts/fibonacci-only-comparison.md",md.join("\n"));
  console.log(JSON.stringify({ok:true,period:report.period,symbols:report.symbols,results:report.results,artifacts:["artifacts/fibonacci-only-comparison.json","artifacts/fibonacci-only-comparison.md"]},null,2));
}
main().catch(e=>{console.error(e);process.exitCode=1;});

import { mkdir, writeFile } from "node:fs/promises";

const BASE = "https://futures.kraken.com";
const HOUR = 3600000, M15 = 900000, M5 = 300000, DAY = 86400000;
const START = Date.parse(process.env.BACKTEST_START || "2025-11-19T00:00:00Z");
const END = Date.parse(process.env.BACKTEST_END || "2026-11-19T00:00:00Z");
const SYMBOL_LIMIT = Math.max(3, Math.min(8, Number(process.env.BACKTEST_SYMBOLS || 8)));
const FEE = Number(process.env.BACKTEST_FEE || 0.0005);
const SLIP = Number(process.env.BACKTEST_SLIPPAGE || 0.0003);
const MAX_HOLD = 72 * HOUR;
const PIVOT_L = 3, PIVOT_R = 3;
const WEIGHTS = [0.4, 0.35, 0.25];
const WARMUP = 45 * DAY;

async function getJson(url) {
  const r = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(30000) });
  const body = await r.text();
  if (!r.ok) throw new Error("HTTP " + r.status + " " + body.slice(0, 160));
  const d = JSON.parse(body);
  if (d?.result === "error" || d?.errors?.length) throw new Error(JSON.stringify(d.errors || d.error));
  return d;
}
function normalize(rows, interval) {
  const m = new Map();
  for (const x of rows || []) {
    const c = { time: Number(x.time) < 1e12 ? Number(x.time) * 1000 : Number(x.time),
      open:+x.open, high:+x.high, low:+x.low, close:+x.close, volume:+x.volume };
    if (![c.time,c.open,c.high,c.low,c.close,c.volume].every(Number.isFinite) || c.low<=0 || c.high<c.low || c.close<=0) continue;
    if (c.time + interval > Date.now()) continue;
    m.set(c.time,c);
  }
  return [...m.values()].sort((a,b)=>a.time-b.time);
}
async function fetchCandles(symbol, resolution, interval, from, to) {
  const chunk = interval * 1700, out = [];
  for (let a=from; a<to; a+=chunk) {
    const b=Math.min(to,a+chunk), u=new URL(BASE+"/api/charts/v1/trade/"+encodeURIComponent(symbol)+"/"+resolution);
    u.searchParams.set("from",String(Math.floor(a/1000)));
    u.searchParams.set("to",String(Math.floor(b/1000)));
    u.searchParams.set("count","1800");
    const d=await getJson(u);
    if (d.more_candles===true) throw new Error(symbol+" "+resolution+" chunk overflow");
    out.push(...(d.candles||[]));
  }
  return normalize(out,interval).filter(c=>c.time>=from && c.time<to);
}
async function mapLimit(items, limit, fn) {
  const out=new Array(items.length); let next=0;
  await Promise.all(Array.from({length:Math.min(limit,items.length)},async()=>{
    while(next<items.length){const i=next++;try{out[i]=await fn(items[i],i);}catch(e){out[i]={error:e.message};}}
  }));
  return out;
}
function pivots(bars, lastClosedTime) {
  const highs=[],lows=[];
  for(let i=PIVOT_L;i<bars.length-PIVOT_R;i++){
    const p=bars[i], confirm=bars[i+PIVOT_R].time+HOUR;
    if(confirm>lastClosedTime) continue;
    let hi=true,lo=true;
    for(let k=i-PIVOT_L;k<=i+PIVOT_R;k++){if(k===i)continue;if(bars[k].high>=p.high)hi=false;if(bars[k].low<=p.low)lo=false;}
    if(hi)highs.push({index:i,time:p.time,price:p.high});
    if(lo)lows.push({index:i,time:p.time,price:p.low});
  }
  const all=[...highs.map(x=>({...x,type:"H"})),...lows.map(x=>({...x,type:"L"}))].sort((a,b)=>a.index-b.index);
  if(all.length<2)return null;
  const a=all.at(-2),b=all.at(-1);
  if(a.type==="L"&&b.type==="H"&&b.price>a.price)return {side:"LONG",low:a.price,high:b.price,anchorTime:a.time,pivotTime:b.time};
  if(a.type==="H"&&b.type==="L"&&a.price>b.price)return {side:"SHORT",high:a.price,low:b.price,anchorTime:a.time,pivotTime:b.time};
  return null;
}
function maxHigh(bars,n){return Math.max(...bars.slice(-n).map(x=>x.high));}
function minLow(bars,n){return Math.min(...bars.slice(-n).map(x=>x.low));}
function inFibZone(side, low, high, price){
  const range=high-low;if(!(range>0))return false;
  if(side==="LONG"){const a=high-range*.618,b=high-range*.5;return price>=a&&price<=b;}
  const a=low+range*.5,b=low+range*.618;return price>=a&&price<=b;
}
function simulate(side, entryRaw, stopRaw, bars, startIndex, signalTime, symbol, model) {
  const dir=side==="LONG"?1:-1, entry=entryRaw*(1+dir*SLIP), stop=stopRaw;
  const risk=dir===1?entry-stop:stop-entry;
  if(!(risk>0) || !Number.isFinite(risk))return null;
  const targets=[1,2,3].map(r=>entry+dir*risk*r);
  let remaining=1,netR=0,hit=[false,false,false],exitReason="TIME_EXIT",exitTime=null;
  const end=Math.min(bars.length-1,startIndex+Math.floor(MAX_HOLD/M5));
  for(let i=startIndex;i<=end&&remaining>1e-9;i++){
    const b=bars[i],stopGap=dir===1?b.open<=stop:b.open>=stop,stopTouch=dir===1?b.low<=stop:b.high>=stop;
    const fill=(p)=>p*(1-dir*SLIP);
    const add=(portion,p)=>{const f=fill(p);netR+=portion*(dir*(f-entry)/risk-FEE*(entry+f)/risk);remaining-=portion;};
    if(stopGap||stopTouch){const px=stopGap?b.open:stop;add(remaining,px);exitReason="STOP";exitTime=b.time;break;}
    for(let k=0;k<3&&remaining>1e-9;k++){
      const touched=dir===1?b.high>=targets[k]:b.low<=targets[k];
      if(touched&&!hit[k]){add(WEIGHTS[k],targets[k]);hit[k]=true;}
    }
    if(remaining<=1e-9){remaining=0;exitReason="TARGETS";exitTime=b.time;break;}
    if(i===end){add(remaining,b.close);exitTime=b.time;}
  }
  if(exitTime===null){const b=bars[end];const f=fill(b.close);netR+=remaining*(dir*(f-entry)/risk-FEE*(entry+f)/risk);remaining=0;exitTime=b.time;}
  return {symbol,model,side,signalTime,entryTime:bars[startIndex].time,entry,stop,risk,targets,
    target1Hit:hit[0],target2Hit:hit[1],target3Hit:hit[2],netR,exitReason,exitTime};
}
function nonOverlap(rows){
  const next=new Map(),out=[];
  for(const t of [...rows].sort((a,b)=>a.entryTime-b.entryTime)){
    if(t.entryTime<(next.get(t.symbol)||0))continue;
    out.push(t);next.set(t.symbol,t.exitTime);
  }
  return out;
}
function metrics(rows){
  const wins=rows.filter(x=>x.netR>0),loss=rows.filter(x=>x.netR<0);
  const gw=wins.reduce((s,x)=>s+x.netR,0),gl=Math.abs(loss.reduce((s,x)=>s+x.netR,0));
  let eq=0,peak=0,dd=0;for(const t of rows){eq+=t.netR;peak=Math.max(peak,eq);dd=Math.max(dd,peak-eq);}
  return {trades:rows.length,wins:wins.length,losses:loss.length,winRatePct:rows.length?100*wins.length/rows.length:0,
    netR:rows.reduce((s,x)=>s+x.netR,0),expectancyR:rows.length?rows.reduce((s,x)=>s+x.netR,0)/rows.length:0,
    profitFactor:gl?gw/gl:gw?null:0,maxDrawdownR:dd,
    tp1:rows.filter(x=>x.target1Hit).length,tp2:rows.filter(x=>x.target2Hit).length,tp3:rows.filter(x=>x.target3Hit).length,
    bySide:Object.fromEntries(["LONG","SHORT"].map(side=>[side,sideMetrics(rows.filter(x=>x.side===side))]))};
}
function sideMetrics(rows){const w=rows.filter(x=>x.netR>0),l=rows.filter(x=>x.netR<0),gw=w.reduce((s,x)=>s+x.netR,0),gl=Math.abs(l.reduce((s,x)=>s+x.netR,0));return{trades:rows.length,winRatePct:rows.length?w.length/rows.length*100:0,netR:rows.reduce((s,x)=>s+x.netR,0),expectancyR:rows.length?rows.reduce((s,x)=>s+x.netR,0)/rows.length:0,profitFactor:gl?gw/gl:gw?null:0};}
function latestBars(bars,time,interval){let lo=0,hi=bars.length;while(lo<hi){const mid=(lo+hi)>>1;if(bars[mid].time+interval<=time)lo=mid+1;else hi=mid;}return bars.slice(0,lo);}
function buildTrades(symbol,h1,m15,m5,model){
  const trades=[];let nextFree=0,lastSetupKey="";
  for(let i=60;i<h1.length;i++){
    const h=h1[i],hClose=h.time+HOUR;if(hClose<START||hClose>=END)continue;
    const hs=h1.slice(0,i+1);const swing=pivots(hs,hClose);if(!swing)continue;
    const zone=inFibZone(swing.side,swing.low,swing.high,h.close);
    const bars15=latestBars(m15,hClose,M15),bars5=latestBars(m5,hClose,M5);
    if(bars15.length<10||bars5.length<20)continue;
    const direction=swing.side==="LONG"?1:-1;
    const fibRequired=model!=="breakout15_5";
    if(fibRequired&&!zone)continue;
    const last15=bars15.at(-1),prev15=bars15.slice(0,-1);
    const breakout15=direction===1?last15.close>maxHigh(prev15,4):last15.close<minLow(prev15,4);
    if(model!=="fib_5_only"&&!breakout15)continue;
    const last5=bars5.at(-1),prev5=bars5.slice(-5,-1);
    const confirm5=direction===1?last5.close>maxHigh(prev5,3):last5.close<minLow(prev5,3);
    if(!confirm5)continue;
    const key=swing.side+"|"+swing.anchorTime+"|"+swing.pivotTime+"|"+last15.time;
    if(key===lastSetupKey)continue;lastSetupKey=key;
    const signalTime=last5.time+M5,entryIndex=m5.findIndex(x=>x.time===signalTime);
    if(entryIndex<0||entryIndex>=m5.length-1||signalTime<nextFree)continue;
    const stop=direction===1?swing.low:swing.high;
    const trade=simulate(swing.side,m5[entryIndex].open,stop,m5,entryIndex,signalTime,symbol,model);
    if(trade){trades.push(trade);nextFree=trade.exitTime+M5;}
  }
  return trades;
}
async function main(){
  if(!(END>START))throw new Error("Invalid period");
  const from=START-WARMUP;
  const tick=await getJson(BASE+"/derivatives/api/v3/tickers");
  const universe=(tick.tickers||[]).filter(t=>t?.tag==="perpetual"&&t.suspended!==true&&/^(PI|PF)_[A-Z0-9]+USD$/.test(String(t.symbol||""))&&Number(t.volumeQuote)>0)
    .sort((a,b)=>Number(b.volumeQuote)-Number(a.volumeQuote)).slice(0,SYMBOL_LIMIT);
  const results=await mapLimit(universe,3,async ticker=>{
    const [h1,m15,m5]=await Promise.all([
      fetchCandles(ticker.symbol,"1h",HOUR,from,END),
      fetchCandles(ticker.symbol,"15m",M15,from,END),
      fetchCandles(ticker.symbol,"5m",M5,from,END)
    ]);
    if(h1.length<500||m15.length<1000||m5.length<3000)throw new Error("Insufficient candles h1="+h1.length+" 15m="+m15.length+" 5m="+m5.length);
    const models={breakout15_5:buildTrades(ticker.symbol,h1,m15,m5,"breakout15_5"),
      fib15_5:buildTrades(ticker.symbol,h1,m15,m5,"fib15_5"),
      fib5_only:buildTrades(ticker.symbol,h1,m15,m5,"fib_5_only")};
    return {symbol:ticker.symbol,candles:{h1:h1.length,m15:m15.length,m5:m5.length},models};
  });
  const good=results.filter(x=>!x.error),failed=results.filter(x=>x.error);
  const all={};for(const id of ["breakout15_5","fib15_5","fib5_only"]){const rows=nonOverlap(good.flatMap(x=>x.models[id]));all[id]={metrics:metrics(rows),trades:rows};}
  const report={generatedAt:new Date().toISOString(),venue:"Kraken Futures public historical OHLC",period:{from:new Date(START).toISOString(),to:new Date(END).toISOString()},
    rules:{pivot:"3 bars left + 3 bars right; pivot usable only after the third right-hand 1h candle has closed",
      fib:"last two consecutive confirmed alternating pivots form the impulse; long retracement zone 0.5-0.618; short retracement zone 0.5-0.618",
      breakout15:"15m close breaks prior 4 completed 15m bars' high/low",
      confirm5:"5m close breaks prior 3 completed 5m bars' high/low; entry next 5m open",
      fib5Only:"same confirmed 1h Fibonacci zone, with 5m break confirmation and no 15m breakout requirement",
      stop:"beyond the confirmed 1h impulse anchor pivot",targets:"1R / 2R / 3R, partial exits 40% / 35% / 25%",
      costs:{feePerSidePct:FEE*100,slippagePerSidePct:SLIP*100},maxHoldHours:72,sameBarAmbiguity:"stop first"},
    symbols:{requested:universe.length,tested:good.length,failed},models:Object.fromEntries(Object.entries(all).map(([k,v])=>[k,{metrics:v.metrics}])),
    trades:Object.fromEntries(Object.entries(all).map(([k,v])=>[k,v.trades]))};
  await mkdir("artifacts",{recursive:true});
  await writeFile("artifacts/fibonacci-15m-5m-comparison.json",JSON.stringify(report,null,2));
  const lines=["# Fibonacci 1h + 15m breakout + 5m confirmation — comparative backtest","",
    "Period: "+report.period.from+" to "+report.period.to,
    "Symbols tested: "+good.length+"/"+universe.length+"; failed: "+failed.length,"",
    "| Model | Trades | Win % | Net R | Expectancy R | Profit factor | Max DD R | LONG trades / Net R | SHORT trades / Net R |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|",
    ...Object.entries(all).map(([k,v])=>{const m=v.metrics;return "| "+k+" | "+m.trades+" | "+m.winRatePct.toFixed(2)+" | "+m.netR.toFixed(2)+" | "+m.expectancyR.toFixed(3)+" | "+(m.profitFactor===null?"n/a":m.profitFactor.toFixed(2))+" | "+m.maxDrawdownR.toFixed(2)+" | "+m.bySide.LONG.trades+" / "+m.bySide.LONG.netR.toFixed(2)+" | "+m.bySide.SHORT.trades+" / "+m.bySide.SHORT.netR.toFixed(2)+" |";}),
    "","Costs: "+(FEE*100)+"% fee and "+(SLIP*100)+"% slippage per side; funding excluded.",
    "This is a rules-based simulation, not live performance. The universe is selected by current Kraken perpetual volume and has survivorship/universe bias.",
    "","Failed symbols:",...failed.map(x=>"- "+x.symbol+": "+x.error)];
  await writeFile("artifacts/fibonacci-15m-5m-comparison.md",lines.join("\n"));
  console.log(JSON.stringify({ok:true,period:report.period,symbols:report.symbols,models:report.models,artifacts:["artifacts/fibonacci-15m-5m-comparison.json","artifacts/fibonacci-15m-5m-comparison.md"]},null,2));
}
main().catch(e=>{console.error(e);process.exitCode=1;});

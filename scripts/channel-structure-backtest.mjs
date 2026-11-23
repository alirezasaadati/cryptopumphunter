import { writeFile, mkdir } from "node:fs/promises";
import { detectPriceChannel, generateChannelSignal, scoreChannelSignal } from "../src/channel-structure-engine.js";

const BASE = "https://futures.kraken.com";
const HOUR = 3600000, FOUR_HOURS = 4 * HOUR, FIFTEEN = 900000, FIVE = 300000, DAY = 86400000;
const FEE = 0.0005, SLIPPAGE = 0.0003, MAX_HOLD_HOURS = 72;
const SYMBOL_LIMIT = Math.max(1, Math.min(10, Number(process.env.CHANNEL_SYMBOLS || 7)));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function getJson(url) {
  const response = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(30000) });
  const body = await response.text();
  if (!response.ok) throw new Error("HTTP " + response.status + " for " + url + ": " + body.slice(0, 160));
  const data = JSON.parse(body);
  if (data?.result === "error" || data?.errors?.length) throw new Error("Kraken API error: " + JSON.stringify(data.errors || data.error));
  return data;
}
function normalize(rows, interval) {
  if (!Array.isArray(rows)) throw new Error("Missing candle array");
  const seen = new Set();
  return rows.map(r => ({ time: Number(r.time) < 1e12 ? Number(r.time) * 1000 : Number(r.time),
    open: Number(r.open), high: Number(r.high), low: Number(r.low), close: Number(r.close), volume: Number(r.volume) }))
    .filter(c => Number.isFinite(c.time) && [c.open,c.high,c.low,c.close,c.volume].every(Number.isFinite) &&
      c.open > 0 && c.low > 0 && c.high >= Math.max(c.open,c.close,c.low) && c.low <= Math.min(c.open,c.close) && c.volume >= 0)
    .sort((a,b)=>a.time-b.time).filter(c => {
      if (seen.has(c.time) || c.time + interval > Date.now()) return false;
      seen.add(c.time); return true;
    });
}
async function fetchCandles(symbol, resolution, from, to, interval) {
  const chunk = interval * 1700, rows = [];
  for (let start=from; start<to; start+=chunk) {
    const end = Math.min(to, start+chunk);
    const url = new URL(BASE + "/api/charts/v1/trade/" + encodeURIComponent(symbol) + "/" + resolution);
    url.searchParams.set("from", String(Math.floor(start/1000)));
    url.searchParams.set("to", String(Math.floor(end/1000)));
    url.searchParams.set("count", "1800");
    const data = await getJson(url);
    if (data.more_candles === true) throw new Error(symbol+" "+resolution+": incomplete chunk");
    rows.push(...normalize(data.candles, interval));
    await sleep(80);
  }
  return [...new Map(rows.map(c=>[c.time,c])).values()].sort((a,b)=>a.time-b.time);
}
function lowerBound(rows,time) {
  let lo=0,hi=rows.length;
  while(lo<hi){const mid=(lo+hi)>>1;if(rows[mid].time<time)lo=mid+1;else hi=mid;}
  return lo;
}
function closeTrade(side, entry, stop, target, bars, startIndex) {
  const risk = Math.abs(entry-stop), maxIndex = Math.min(bars.length-1,startIndex+MAX_HOLD_HOURS*12);
  for(let i=startIndex;i<=maxIndex;i++){
    const c=bars[i]; if(!c)break;
    const stopHit=side==="LONG"?c.low<=stop:c.high>=stop;
    const targetHit=side==="LONG"?c.high>=target:c.low<=target;
    if(!stopHit&&!targetHit)continue;
    const open=Number(c.open);
    const stopAtOpen=side==="LONG"?open<=stop:open>=stop;
    const targetAtOpen=side==="LONG"?open>=target:open<=target;
    const stopFirst=stopAtOpen||(!targetAtOpen&&stopHit);
    let raw=stopFirst?(side==="LONG"?Math.min(open,stop):Math.max(open,stop)):(side==="LONG"?Math.max(open,target):Math.min(open,target));
    const exit=side==="LONG"?raw*(1-SLIPPAGE):raw*(1+SLIPPAGE);
    const gross=(side==="LONG"?exit-entry:entry-exit)/risk;
    const fees=FEE*(entry+exit)/risk;
    return {exitPrice:exit,exitTime:c.time,exitReason:stopFirst?"STOP":"TARGET",netR:gross-fees,holdHours:(c.time-bars[startIndex].time)/HOUR};
  }
  const c=bars[maxIndex], raw=Number(c?.close);
  const exit=side==="LONG"?raw*(1-SLIPPAGE):raw*(1+SLIPPAGE);
  return {exitPrice:exit,exitTime:c?.time,exitReason:"TIME",netR:(side==="LONG"?exit-entry:entry-exit)/risk-FEE*(entry+exit)/risk,
    holdHours:(c.time-bars[startIndex].time)/HOUR};
}
function metrics(trades) {
  const wins=trades.filter(t=>t.netR>0), losses=trades.filter(t=>t.netR<0);
  const gw=wins.reduce((s,t)=>s+t.netR,0), gl=Math.abs(losses.reduce((s,t)=>s+t.netR,0));
  let equity=0,peak=0,maxDD=0;
  for(const t of [...trades].sort((a,b)=>a.entryTime-b.entryTime)){equity+=t.netR;peak=Math.max(peak,equity);maxDD=Math.max(maxDD,peak-equity);}
  return {trades:trades.length,wins:wins.length,losses:losses.length,winRatePct:trades.length?wins.length/trades.length*100:0,
    netR:trades.reduce((s,t)=>s+t.netR,0),expectancyR:trades.length?trades.reduce((s,t)=>s+t.netR,0)/trades.length:0,
    profitFactor:gl?gw/gl:gw?null:0,maxDrawdownR:maxDD,
    averageHoldHours:trades.length?trades.reduce((s,t)=>s+t.holdHours,0)/trades.length:0};
}
function runSymbol(data, days, endMs) {
  const start=endMs-days*DAY, {ticker,h1,h4,m15,m5}=data;
  let h4Index=0,m15Index=0,lockedUntil=0;
  const trades=[], counts={opportunities:0,belowMinRisk:0,lockSkips:0,bySetup:{}};
  const first=lowerBound(h1,start-20*DAY);
  for(let i=Math.max(40,first);i<h1.length-1;i++){
    const h=h1[i], signalTime=h.time+HOUR;
    if(signalTime<start||signalTime>endMs)continue;
    while(h4Index<h4.length&&h4[h4Index].time+FOUR_HOURS<=signalTime)h4Index++;
    while(m15Index<m15.length&&m15[m15Index].time+FIFTEEN<=signalTime)m15Index++;
    const closed4h=h4.slice(Math.max(0,h4Index-120),h4Index);
    const closed15=m15.slice(Math.max(0,m15Index-4),m15Index);
    if(closed4h.length<40||closed15.length<2)continue;
    const signal=generateChannelSignal({candles4h:closed4h,candles1h:h1.slice(0,i+1),candles15m:closed15});
    if(!signal)continue;
    counts.opportunities++;
    counts.bySetup[signal.setup]=(counts.bySetup[signal.setup]||0)+1;
    if(signal.risk/signal.referenceEntry<0.001||signal.targetR<0.75){counts.belowMinRisk++;continue;}
    const entryIndex=lowerBound(m5,signalTime);
    if(entryIndex>=m5.length)continue;
    if(entryIndex<lockedUntil){counts.lockSkips++;continue;}
    const rawEntry=Number(m5[entryIndex].open);
    const entry=signal.side==="LONG"?rawEntry*(1+SLIPPAGE):rawEntry*(1-SLIPPAGE);
    const adjustedRisk=signal.side==="LONG"?entry-signal.stop:signal.stop-entry;
    if(!(adjustedRisk>0))continue;
    const target=signal.side==="LONG"?entry+adjustedRisk*signal.targetR:entry-adjustedRisk*signal.targetR;
    const result=closeTrade(signal.side,entry,signal.stop,target,m5,entryIndex);
    const trade={symbol:ticker.symbol,side:signal.side,setup:signal.setup,channelType:signal.channelType,
      score:scoreChannelSignal(signal),entry,stop:signal.stop,target,targetR:signal.targetR,
      entryTime:m5[entryIndex].time,...result};
    trades.push(trade);
    lockedUntil=lowerBound(m5,result.exitTime)+1;
  }
  return {symbol:ticker.symbol,counts,metrics:metrics(trades),trades};
}
async function main(){
  const endMs=Date.now(), from=endMs-(180+20)*DAY;
  const response=await getJson(BASE+"/derivatives/api/v3/tickers");
  if(!Array.isArray(response.tickers))throw new Error("Kraken ticker list unavailable");
  const universe=response.tickers.filter(t=>t?.tag==="perpetual"&&t.suspended!==true&&/^(PI|PF)_[A-Z0-9]+USD$/.test(String(t.symbol||""))&&Number(t.volumeQuote)>0)
    .sort((a,b)=>Number(b.volumeQuote)-Number(a.volumeQuote)).slice(0,SYMBOL_LIMIT);
  const loaded=[];
  for(const ticker of universe){
    try{
      const [h1,h4,m15,m5]=await Promise.all([
        fetchCandles(ticker.symbol,"1h",from,endMs,HOUR),fetchCandles(ticker.symbol,"4h",from,endMs,FOUR_HOURS),
        fetchCandles(ticker.symbol,"15m",from,endMs,FIFTEEN),fetchCandles(ticker.symbol,"5m",from,endMs,FIVE)
      ]);
      if(h1.length<100||h4.length<80||m15.length<100||m5.length<1000)throw new Error("Insufficient history");
      loaded.push({ticker,h1,h4,m15,m5});
    }catch(error){loaded.push({ticker,error:String(error.message||error)});}
  }
  const windows={};
  for(const days of [90,180]){
    const results=loaded.map(d=>d.error?{symbol:d.ticker.symbol,error:d.error}:runSymbol(d,days,endMs));
    const trades=results.flatMap(x=>x.trades||[]).sort((a,b)=>a.entryTime-b.entryTime);
    const group=(key)=>Object.fromEntries([...new Set(trades.map(t=>t[key]))].map(v=>[v,metrics(trades.filter(t=>t[key]===v))]));
    windows[days+"d"]={period:{from:new Date(endMs-days*DAY).toISOString(),to:new Date(endMs).toISOString(),days},
      symbolsRequested:SYMBOL_LIMIT,symbolsLoaded:loaded.filter(d=>!d.error).length,
      symbols:results.map(({trades,...rest})=>rest),overall:metrics(trades),
      bySide:group("side"),bySetup:group("setup"),byChannelType:group("channelType"),trades};
  }
  const output={strategy:"Channel Structure Engine v0.1",generatedAt:new Date().toISOString(),
    dataSource:"Kraken Futures historical OHLC",execution:"signal at closed 1h; 5m next-open entry; stop-first OHLC exit",
    assumptions:{feePerSide:FEE,slippagePerSide:SLIPPAGE,leverageContext:"R-multiple reporting; no fixed account sizing",maxHoldHours:MAX_HOLD_HOURS,
      warmupDays:20,universe:"top current-volume eligible Kraken perpetuals; survivorship bias possible",
      limitations:["Historical OHLC cannot reveal intrabar path; stop-first is conservative when stop and target occur in same 5m candle.",
        "Funding, liquidation, market impact and portfolio-level concurrency/capital constraints are not modeled.",
        "The 4h channel uses confirmed fractal pivots only; a pivot is available after its right-side confirmation candles close."]},
    windows};
  await mkdir("artifacts",{recursive:true});
  await writeFile("artifacts/channel-structure-backtest.json",JSON.stringify(output,null,2));
  console.log(JSON.stringify({generatedAt:output.generatedAt,windows:Object.fromEntries(Object.entries(windows).map(([k,v])=>[k,{symbolsLoaded:v.symbolsLoaded,overall:v.overall,bySide:v.bySide,bySetup:v.bySetup,byChannelType:v.byChannelType}]))},null,2));
}
main().catch(error=>{console.error(error);process.exitCode=1;});

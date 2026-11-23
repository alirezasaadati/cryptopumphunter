import { writeFile, mkdir } from "node:fs/promises";
import { generateChannelSignal, scoreChannelSignal } from "../src/channel-structure-engine.js";

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
function metrics(trades) {
  const wins=trades.filter(t=>t.netPnlUsd>0), losses=trades.filter(t=>t.netPnlUsd<0);
  const gw=wins.reduce((s,t)=>s+t.netPnlUsd,0), gl=Math.abs(losses.reduce((s,t)=>s+t.netPnlUsd,0));
  let equity=0,peak=0,maxDD=0;
  for(const t of [...trades].sort((a,b)=>a.entryTime-b.entryTime)){equity+=t.netPnlUsd;peak=Math.max(peak,equity);maxDD=Math.max(maxDD,peak-equity);}
  return {trades:trades.length,wins:wins.length,losses:losses.length,winRatePct:trades.length?wins.length/trades.length*100:0,
    netProfitUsd:trades.reduce((s,t)=>s+t.netPnlUsd,0),averageProfitUsd:trades.length?trades.reduce((s,t)=>s+t.netPnlUsd,0)/trades.length:0,
    profitFactor:gl?gw/gl:gw?null:0,maxDrawdownUsd:maxDD,
    averageHoldHours:trades.length?trades.reduce((s,t)=>s+t.holdHours,0)/trades.length:0,
    targetHits:trades.filter(t=>t.exitReason==="TARGET_30PCT_MARGIN").length,
    stopHits:trades.filter(t=>t.exitReason==="STOP_BEFORE_TARGET").length,
    timeExits:trades.filter(t=>t.exitReason==="TIME").length};
}
function simulateFixedMarginExit({side,entry,stop,bars,startIndex,quantity,maxHoldHours=72}) {
  const maxIndex=Math.min(bars.length-1,startIndex+maxHoldHours*12);
  const marginUsd=10, targetProfitUsd=3;
  const entryFee=FEE*quantity*entry;
  // Solve separately for each side so the slipped exit fill nets exactly +$3 after both fees.
  const effectiveTarget=side==="LONG"
    ? (quantity*entry+entryFee+targetProfitUsd)/(quantity*(1-FEE))
    : (quantity*entry-entryFee-targetProfitUsd)/(quantity*(1+FEE));
  const rawTarget=side==="LONG"?effectiveTarget/(1-SLIPPAGE):effectiveTarget/(1+SLIPPAGE);
  let reason="TIME",exitTime=bars[maxIndex]?.time,rawExit=Number(bars[maxIndex]?.close);
  for(let i=startIndex;i<=maxIndex;i++){
    const c=bars[i],open=Number(c.open),high=Number(c.high),low=Number(c.low);
    const stopHit=side==="LONG"?low<=stop:high>=stop;
    const targetHit=side==="LONG"?high>=rawTarget:low<=rawTarget;
    // Conservative intrabar rule: if both levels are touched in one 5m candle, count stop first.
    if(stopHit){
      rawExit=(side==="LONG"&&open<=stop)||(side==="SHORT"&&open>=stop)?open:stop;
      reason="STOP_BEFORE_TARGET";exitTime=c.time;break;
    }
    if(targetHit){
      rawExit=(side==="LONG"&&open>=rawTarget)||(side==="SHORT"&&open<=rawTarget)?open:rawTarget;
      reason="TARGET_30PCT_MARGIN";exitTime=c.time;break;
    }
  }
  const exit=side==="LONG"?rawExit*(1-SLIPPAGE):rawExit*(1+SLIPPAGE);
  const exitFee=FEE*quantity*exit;
  const gross=side==="LONG"?quantity*(exit-entry):quantity*(entry-exit);
  const netPnlUsd=gross-entryFee-exitFee;
  return {exitPrice:exit,exitTime,exitReason:reason,netPnlUsd,marginUsd,marginReturnPct:netPnlUsd/marginUsd*100,
    holdHours:(exitTime-bars[startIndex].time)/HOUR,targetPriceRaw:rawTarget,targetProfitUsd};
}
function runSymbol(data, days, endMs, mode) {
  const start=endMs-days*DAY, {ticker,h1,h4,m15,m5,d1}=data;
  let h4Index=0,m15Index=0,d1Index=0,lockedUntil=0;
  const trades=[], counts={opportunities:0,opportunitiesBySide:{LONG:0,SHORT:0},lockSkips:0,filled:0,marketFills:0,limitFills:0,limitExpired:0,invalidFillRisk:0,bySetup:{}};
  const first=lowerBound(h1,start-20*DAY);
  for(let i=Math.max(40,first);i<h1.length-1;i++){
    const h=h1[i], signalTime=h.time+HOUR;
    if(signalTime<start||signalTime>endMs)continue;
    while(h4Index<h4.length&&h4[h4Index].time+FOUR_HOURS<=signalTime)h4Index++;
    while(m15Index<m15.length&&m15[m15Index].time+FIFTEEN<=signalTime)m15Index++;
    while(d1Index<d1.length&&d1[d1Index].time+DAY<=signalTime)d1Index++;
    const closedDaily=d1.slice(Math.max(0,d1Index-200),d1Index);
    const closed4h=h4.slice(Math.max(0,h4Index-120),h4Index);
    const closed15=m15.slice(Math.max(0,m15Index-4),m15Index);
    if(closed4h.length<40||closed15.length<2)continue;
    const signal=generateChannelSignal({candles4h:closed4h,candles1h:h1.slice(0,i+1),candles15m:closed15,candles1d:closedDaily,mode});
    if(!signal)continue;
    counts.opportunities++;
    counts.opportunitiesBySide[signal.side]++;
    counts.bySetup[signal.setup]=(counts.bySetup[signal.setup]||0)+1;
    const signalBarIndex=lowerBound(m5,signalTime)-1;
    const nextIndex=signalBarIndex+1;
    if(signalBarIndex<0||nextIndex>=m5.length)continue;
    if(nextIndex<lockedUntil){counts.lockSkips++;continue;}
    const signalBar=m5[signalBarIndex];
    const aligned=signal.side==="LONG"?signalBar.close>signalBar.open:signalBar.close<signalBar.open;
    let entryIndex=nextIndex, rawEntry=null, orderType="MARKET";
    if(aligned){
      rawEntry=Number(m5[entryIndex].open);
    }else{
      orderType="LIMIT";
      const limitPrice=signal.side==="LONG"?Number(signalBar.low):Number(signalBar.high);
      const expiryIndex=Math.min(m5.length-1,nextIndex+11);
      entryIndex=-1;
      for(let j=nextIndex;j<=expiryIndex;j++){
        const candle=m5[j], open=Number(candle.open);
        const touched=signal.side==="LONG"?Number(candle.low)<=limitPrice:Number(candle.high)>=limitPrice;
        const marketable=signal.side==="LONG"?open<=limitPrice:open>=limitPrice;
        if(marketable||touched){entryIndex=j;rawEntry=marketable?open:limitPrice;break;}
      }
      if(entryIndex<0){counts.limitExpired=(counts.limitExpired||0)+1;continue;}
    }
    const entry=signal.side==="LONG"?rawEntry*(1+SLIPPAGE):rawEntry*(1-SLIPPAGE);
    const adjustedRisk=signal.side==="LONG"?entry-signal.stop:signal.stop-entry;
    if(!(adjustedRisk>0)){counts.invalidFillRisk=(counts.invalidFillRisk||0)+1;continue;}
    const marginUsd=10, leverage=10, notionalUsd=marginUsd*leverage, quantity=notionalUsd/entry;
    const result=simulateFixedMarginExit({side:signal.side,entry,stop:signal.stop,bars:m5,startIndex:entryIndex,quantity,maxHoldHours:MAX_HOLD_HOURS});
    const trade={symbol:ticker.symbol,side:signal.side,setup:signal.setup,channelType:signal.channelType,
      score:scoreChannelSignal(signal),orderType,entry,stop:signal.stop,targetPriceRaw:result.targetPriceRaw,
      riskPct:adjustedRisk/entry,quantity,notionalUsd,estimatedMarginUsd:marginUsd,leverage,
      baseMarginUsd:marginUsd,positionMultiplier:1,dailyContext:signal.dailyContext,fourHourConfirmed:signal.fourHourConfirmed,multiTimeframeAligned:signal.multiTimeframeAligned,mode,volumeConfirmed:signal.volumeConfirmed,rsiDivergence:signal.rsiDivergence,
      entryTime:m5[entryIndex].time,...result};
    trades.push(trade);
    counts.filled=(counts.filled||0)+1;
    counts[orderType==="MARKET"?"marketFills":"limitFills"]=(counts[orderType==="MARKET"?"marketFills":"limitFills"]||0)+1;
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
      const [h1,h4,m15,m5,d1]=await Promise.all([
        fetchCandles(ticker.symbol,"1h",from,endMs,HOUR),fetchCandles(ticker.symbol,"4h",from,endMs,FOUR_HOURS),
        fetchCandles(ticker.symbol,"15m",from,endMs,FIFTEEN),fetchCandles(ticker.symbol,"5m",from,endMs,FIVE),
        fetchCandles(ticker.symbol,"1d",from-220*DAY,endMs,DAY)
      ]);
      if(h1.length<100||h4.length<80||m15.length<100||m5.length<1000||d1.length<35)throw new Error("Insufficient history");
      loaded.push({ticker,h1,h4,m15,m5,d1});
    }catch(error){loaded.push({ticker,error:String(error.message||error)});}
  }
  const windows={};
  for(const mode of ["BASELINE","A","B"]){
    windows[mode]={};
    for(const days of [90,180]){
      const results=loaded.map(d=>d.error?{symbol:d.ticker.symbol,error:d.error}:runSymbol(d,days,endMs,mode));
      const trades=results.flatMap(x=>x.trades||[]).sort((a,b)=>a.entryTime-b.entryTime);
      const group=(key)=>Object.fromEntries([...new Set(trades.map(t=>t[key]))].map(v=>[v,metrics(trades.filter(t=>t[key]===v))]));
      windows[mode][days+"d"]={period:{from:new Date(endMs-days*DAY).toISOString(),to:new Date(endMs).toISOString(),days},
        symbolsRequested:SYMBOL_LIMIT,symbolsLoaded:loaded.filter(d=>!d.error).length,
        symbols:results.map(({trades,...rest})=>rest),overall:metrics(trades),
        bySide:group("side"),bySetup:group("setup"),byChannelType:group("channelType"),
        byDailyContext:group("dailyContext"),byPositionMultiplier:group("positionMultiplier"),trades};
    }
  }
  const output={strategy:"Channel Structure Engine MTF experiment: BASELINE vs A vs B; fixed $10 margin, 10x leverage, net +30% margin target",generatedAt:new Date().toISOString(),
    dataSource:"Kraken Futures historical OHLC",execution:"signal at closed 1h; aligned completed 5m candle => next-open market; counter-direction/doji => limit at signal-candle low (LONG) or high (SHORT), valid 12 subsequent 5m bars; fixed $10 margin and 10x leverage ($100 notional) per trade; close full position at +$3 net profit after entry/exit fees and slippage, or count a stop only if structural stop is hit first; if both stop and target touch in same 5m candle, stop-first; 72h time exit if neither is hit",
    assumptions:{feePerSide:FEE,slippagePerSide:SLIPPAGE,leverage:10,marginUsdPerTrade:10,notionalUsdPerTrade:100,targetNetProfitUsd:3,targetMarginReturnPct:30,maxHoldHours:MAX_HOLD_HOURS,
      warmupDays:20,universe:"top current-volume eligible Kraken perpetuals; survivorship bias possible",
      limitations:["Historical OHLC cannot reveal intrabar path; stop-first is conservative when stop and target occur in same 5m candle.",
        "Funding, liquidation, market impact and portfolio-level concurrency/capital constraints are not modeled.", "Each trade uses exactly $10 margin at 10x ($100 notional); daily position-size multipliers are disabled so the margin stays fixed across modes.", "The +$3 target is net of modeled entry/exit fees and slippage; stop level is the unchanged structural stop from the signal engine.",
        "The 4h channel uses confirmed fractal pivots only; a pivot is available after its right-side confirmation candles close."]},
    windows};
  await mkdir("artifacts",{recursive:true});
  await writeFile("artifacts/channel-structure-backtest.json",JSON.stringify(output,null,2));
  console.log(JSON.stringify({generatedAt:output.generatedAt,windows:Object.fromEntries(Object.entries(windows).map(([k,v])=>[k,{symbolsLoaded:v.symbolsLoaded,overall:v.overall,bySide:v.bySide,bySetup:v.bySetup,byChannelType:v.byChannelType}]))},null,2));
}
main().catch(error=>{console.error(error);process.exitCode=1;});

import { analyzeFuturesSymbol, FUTURES_CONFIG } from "../src/index.js";
import { resolveShortFallbackFill } from "../src/short-entry-fallback-experiment.js";
import { mkdir, writeFile } from "node:fs/promises";

const BASE = "https://futures.kraken.com";
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const FIVE_MINUTES = 5 * 60 * 1000;
const FOUR_HOURS = 4 * HOUR;
const FIFTEEN_MINUTES = 15 * 60 * 1000;
const WARMUP_DAYS = 15;
const SYMBOL_LIMIT = Math.max(1, Math.min(10, Number(process.env.SHORT_PRIORITY_SYMBOLS || 7)));
const FEE_PER_SIDE = Math.max(0, Number(process.env.SHORT_PRIORITY_FEE || 0.0005));
const SLIPPAGE_PER_SIDE = Math.max(0, Number(process.env.SHORT_PRIORITY_SLIPPAGE || 0.0003));
const MAX_HOLD_HOURS = 72;
const LIMIT_VALID_BARS = 12;
const TARGET_WEIGHTS = [0.40, 0.35, 0.25];

async function getJson(url) {
  const response = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(30000) });
  const body = await response.text();
  if (!response.ok) throw new Error("HTTP " + response.status + " for " + url + ": " + body.slice(0, 180));
  let data;
  try { data = JSON.parse(body); } catch { throw new Error("Invalid JSON from " + url); }
  if (data?.result === "error" || (Array.isArray(data?.errors) && data.errors.length)) {
    throw new Error("Kraken API error: " + JSON.stringify(data.errors || data.error));
  }
  return data;
}

function normalizeCandles(rows, intervalMs) {
  if (!Array.isArray(rows)) throw new Error("Kraken candles array missing");
  const seen = new Set();
  return rows.map(row => ({
    time: Number(row.time) < 1e12 ? Number(row.time) * 1000 : Number(row.time),
    open: Number(row.open), high: Number(row.high), low: Number(row.low),
    close: Number(row.close), volume: Number(row.volume)
  })).filter(c =>
    Number.isFinite(c.time) && [c.open,c.high,c.low,c.close,c.volume].every(Number.isFinite) &&
    c.open > 0 && c.close > 0 && c.low > 0 && c.high >= Math.max(c.open,c.close,c.low) &&
    c.low <= Math.min(c.open,c.close) && c.volume >= 0
  ).sort((a,b)=>a.time-b.time).filter(c => {
    if (seen.has(c.time) || c.time + intervalMs > Date.now()) return false;
    seen.add(c.time); return true;
  });
}

async function fetchHistoricalCandles(symbol, resolution, fromMs, toMs, intervalMs) {
  const chunkMs = intervalMs * 1800;
  const combined = [];
  for (let start = fromMs; start < toMs; start += chunkMs) {
    const end = Math.min(toMs, start + chunkMs);
    const url = new URL(BASE + "/api/charts/v1/trade/" + encodeURIComponent(symbol) + "/" + resolution);
    url.searchParams.set("from", String(Math.floor(start / 1000)));
    url.searchParams.set("to", String(Math.floor(end / 1000)));
    url.searchParams.set("count", "1900");
    const data = await getJson(url);
    if (data.more_candles === true) throw new Error(symbol + " " + resolution + ": Kraken returned more candles than requested in a chunk.");
    combined.push(...normalizeCandles(data.candles, intervalMs));
  }
  const byTime = new Map(combined.map(c => [c.time,c]));
  return [...byTime.values()].sort((a,b)=>a.time-b.time);
}

function ema(values, period) {
  if (values.length < period) return null;
  const multiplier = 2 / (period + 1);
  let value = values.slice(0,period).reduce((a,b)=>a+b,0) / period;
  for (let i=period;i<values.length;i++) value = values[i]*multiplier + value*(1-multiplier);
  return value;
}

function historicalChange(candles,index) {
  const old=candles[index-24],now=candles[index];
  return old && old.close>0 ? (now.close/old.close-1)*100 : 0;
}

function summarize(trades) {
  const wins=trades.filter(t=>t.netR>0), losses=trades.filter(t=>t.netR<0);
  const grossWin=wins.reduce((s,t)=>s+t.netR,0);
  const grossLoss=Math.abs(losses.reduce((s,t)=>s+t.netR,0));
  let equity=0,peak=0,maxDrawdownR=0;
  for(const t of trades){equity+=t.netR;peak=Math.max(peak,equity);maxDrawdownR=Math.max(maxDrawdownR,peak-equity);}
  return {
    trades:trades.length,wins:wins.length,losses:losses.length,
    winRatePct:trades.length?wins.length/trades.length*100:0,
    netR:trades.reduce((s,t)=>s+t.netR,0),
    expectancyR:trades.length?trades.reduce((s,t)=>s+t.netR,0)/trades.length:0,
    profitFactor:grossLoss?grossWin/grossLoss:grossWin?null:0,
    maxDrawdownR,targetHits:trades.reduce((s,t)=>s+t.targetHits,0)
  };
}

function buildShortLevels({oneHour,signalIndex,entry,atr}) {
  const swing=oneHour.slice(Math.max(0,signalIndex-7),signalIndex);
  if(swing.length<7)return null;
  const swingHigh=Math.max(...swing.map(c=>c.high));
  const stop=Math.max(swingHigh,entry+atr*1.5);
  const risk=stop-entry;
  const riskPct=risk/entry;
  if(!(risk>0)||riskPct<0.002||riskPct>0.08)return null;
  const target1Distance=Math.min(risk*1.5,atr*2.5);
  return {entry,stop,risk,atr,target1:entry-target1Distance,target2:entry-risk*2.5,target3:entry-risk*3.5,
    rewardRisk:target1Distance/risk};
}

function simulateShortTrade({symbol,levels,candles5m,fillIndex,fee,slippage,maxHoldHours}) {
  const entry=levels.entry, risk=levels.risk;
  const targets=[levels.target1,levels.target2,levels.target3];
  const remaining=[...TARGET_WEIGHTS];
  let left=1,netR=0,targetHits=0,exitReason="TIME_EXIT",exitIndex=Math.min(candles5m.length-1,fillIndex+maxHoldHours*12);
  const end=Math.min(candles5m.length-1,fillIndex+maxHoldHours*12);
  for(let i=fillIndex;i<=end&&left>1e-9;i++){
    const bar=candles5m[i];
    const stopGap=bar.open>=levels.stop;
    const stopTouched=bar.high>=levels.stop;
    if(stopGap||stopTouched){
      const raw=stopGap?bar.open:levels.stop;
      const exit=raw*(1+slippage);
      const gross=(entry-exit)/risk;
      const feeR=fee*(entry+exit)/risk;
      netR+=left*(gross-feeR);
      left=0;exitReason="STOP";exitIndex=i;break;
    }
    for(let t=0;t<targets.length&&left>1e-9;t++){
      if(bar.low>targets[t])continue;
      const weight=Math.min(remaining[t],left);
      const exit=targets[t]*(1+slippage);
      const gross=(entry-exit)/risk;
      const feeR=fee*(entry+exit)/risk;
      netR+=weight*(gross-feeR);
      left-=weight;remaining[t]=0;targetHits++;
    }
    if(left<=1e-9){left=0;exitReason="TARGETS";exitIndex=i;break;}
    if(i===end){
      const exit=bar.close*(1+slippage);
      netR+=left*((entry-exit)/risk-fee*(entry+exit)/risk);
      left=0;exitReason="TIME_EXIT";exitIndex=i;
    }
  }
  return {symbol,entry,stop:levels.stop,target1:levels.target1,target2:levels.target2,target3:levels.target3,
    rewardRisk:levels.rewardRisk,netR,targetHits,exitReason,fillIndex,exitIndex,entryTime:candles5m[fillIndex].time,
    exitTime:candles5m[exitIndex].time};
}

function lowerBound(candles,time) {
  let lo=0,hi=candles.length;
  while(lo<hi){const mid=(lo+hi)>>1;if(candles[mid].time<time)lo=mid+1;else hi=mid;}
  return lo;
}

function createArm() {
  return {trades:[],opportunities:0,filled:0,expired:0,lockSkips:0,marketOrders:0,limitOrders:0,limitGapFills:0,limitTouchFills:0};
}

function runWindowForSymbol(data,days,endMs) {
  const startMs=endMs-days*DAY;
  const {ticker,oneHour,fourHour,fifteenMinute,fiveMinute}=data;
  const baseline=createArm(), experimental=createArm();
  let lockUntilFiveIndex=0;
  let fourIndex=0,fifteenIndex=0;
  const firstHourly=lowerBound(oneHour,startMs-WARMUP_DAYS*DAY);
  for(let i=Math.max(60,firstHourly);i<oneHour.length-1;i++){
    const signalBar=oneHour[i],signalCloseTime=signalBar.time+HOUR;
    if(signalCloseTime<startMs||signalCloseTime>endMs)continue;
    while(fourIndex<fourHour.length&&fourHour[fourIndex].time+FOUR_HOURS<=signalCloseTime)fourIndex++;
    while(fifteenIndex<fifteenMinute.length&&fifteenMinute[fifteenIndex].time+FIFTEEN_MINUTES<=signalCloseTime)fifteenIndex++;
    if(fourIndex<FUTURES_CONFIG.MIN_CANDLES)continue;
    const closed4h=fourHour.slice(0,fourIndex);
    const closed15m=fifteenMinute.slice(Math.max(0,fifteenIndex-160),fifteenIndex);
    const historicalQuoteVolume=oneHour.slice(Math.max(0,i-23),i+1)
      .reduce((sum,c)=>sum+Number(c.volume)*Number(c.close),0);
    const tickerAtSignal={symbol:ticker.symbol,last:signalBar.close,quoteVolume:historicalQuoteVolume,
      priceChangePercent:historicalChange(oneHour,i),premium:{lastFundingRate:null}};
    const candidate=analyzeFuturesSymbol(tickerAtSignal,oneHour.slice(0,i+1),closed4h,closed15m);
    if(candidate?.side!=="SHORT"||candidate?.eligible!==true)continue;
    const decisionIndex=lowerBound(fiveMinute,signalCloseTime);
    const decisionCandle=fiveMinute[decisionIndex];
    if(!decisionCandle||decisionIndex+1>=fiveMinute.length)continue;
    const resistance=Number(oneHour[i-1]?.high);
    const ema20=ema(oneHour.slice(0,i+1).map(c=>c.close),20);
    if(!Number.isFinite(resistance)||!Number.isFinite(ema20)||ema20<=0)continue;
    const observedPrice=decisionCandle.close;
    const belowBoth=observedPrice<ema20&&observedPrice<resistance;
    const levelGapPct=Math.abs(ema20-resistance)/Math.min(ema20,resistance)*100;
    if(!belowBoth||levelGapPct<=0.5)continue;
    baseline.opportunities++;experimental.opportunities++;
    if(decisionIndex+1<lockUntilFiveIndex){baseline.lockSkips++;experimental.lockSkips++;continue;}
    const following=fiveMinute.slice(decisionIndex+1,decisionIndex+1+LIMIT_VALID_BARS);
    const decision=resolveShortFallbackFill({decisionCandle,followingCandles:following,validBars:LIMIT_VALID_BARS,
      marketSlippage:SLIPPAGE_PER_SIDE});
    const marketRaw=Number(fiveMinute[decisionIndex+1]?.open);
    if(!Number.isFinite(marketRaw)||marketRaw<=0)continue;
    const baselineEntry=marketRaw*(1-SLIPPAGE_PER_SIDE);
    const baselineLevels=buildShortLevels({oneHour,signalIndex:i,entry:baselineEntry,atr:candidate.atr});
    if(!baselineLevels)continue;
    const baselineTrade=simulateShortTrade({symbol:ticker.symbol,levels:baselineLevels,candles5m:fiveMinute,
      fillIndex:decisionIndex+1,fee:FEE_PER_SIDE,slippage:SLIPPAGE_PER_SIDE,maxHoldHours:MAX_HOLD_HOURS});
    baseline.trades.push({...baselineTrade,entryType:"MARKET"});
    baseline.filled++;
    let experimentalTrade=null;
    if(decision.filled){
      const fillIndex=decisionIndex+1+decision.fillIndex;
      const levels=buildShortLevels({oneHour,signalIndex:i,entry:decision.fillPrice,atr:candidate.atr});
      if(levels){
        experimentalTrade=simulateShortTrade({symbol:ticker.symbol,levels,candles5m:fiveMinute,fillIndex,
          fee:FEE_PER_SIDE,slippage:SLIPPAGE_PER_SIDE,maxHoldHours:MAX_HOLD_HOURS});
        experimental.trades.push({...experimentalTrade,entryType:decision.type,orderReason:decision.reason});
        experimental.filled++;
        if(decision.type==="MARKET")experimental.marketOrders++;
        else {
          experimental.limitOrders++;
          if(decision.reason==="LIMIT_GAP_FILL")experimental.limitGapFills++;
          if(decision.reason==="LIMIT_TOUCH_FILL")experimental.limitTouchFills++;
        }
      } else experimental.expired++;
    } else experimental.expired++;
    const expExit=experimentalTrade?.exitIndex??(decision.type==="LIMIT"?decisionIndex+LIMIT_VALID_BARS:baselineTrade.exitIndex);
    lockUntilFiveIndex=Math.max(baselineTrade.exitIndex,expExit)+1;
  }
  return {
    symbol:ticker.symbol,
    baseline:{opportunities:baseline.opportunities,filled:baseline.filled,metrics:summarize(baseline.trades),trades:baseline.trades},
    experimental:{opportunities:experimental.opportunities,filled:experimental.filled,expired:experimental.expired,
      marketOrders:experimental.marketOrders,limitOrders:experimental.limitOrders,limitGapFills:experimental.limitGapFills,
      limitTouchFills:experimental.limitTouchFills,metrics:summarize(experimental.trades),trades:experimental.trades}
  };
}

async function main() {
  const endMs=Date.now(),fromMs=endMs-(180+WARMUP_DAYS)*DAY;
  const tickerData=await getJson(BASE+"/derivatives/api/v3/tickers");
  if(!Array.isArray(tickerData?.tickers))throw new Error("Kraken tickers response invalid");
  const universe=tickerData.tickers.filter(t=>t?.tag==="perpetual"&&t.suspended!==true&&
    /^(PI|PF)_[A-Z0-9]+USD$/.test(String(t.symbol||""))&&Number(t.volumeQuote)>=FUTURES_CONFIG.MIN_QUOTE_VOLUME&&Number(t.last)>0)
    .sort((a,b)=>Number(b.volumeQuote)-Number(a.volumeQuote)).slice(0,SYMBOL_LIMIT);
  if(!universe.length)throw new Error("No eligible Kraken perpetual contracts found");
  const loaded=[];
  for(const ticker of universe){
    try{
      const [oneHour,fourHour,fifteenMinute,fiveMinute]=await Promise.all([
        fetchHistoricalCandles(ticker.symbol,"1h",fromMs,endMs,HOUR),
        fetchHistoricalCandles(ticker.symbol,"4h",fromMs,endMs,FOUR_HOURS),
        fetchHistoricalCandles(ticker.symbol,"15m",fromMs,endMs,FIFTEEN_MINUTES),
        fetchHistoricalCandles(ticker.symbol,"5m",fromMs,endMs,FIVE_MINUTES)
      ]);
      if(oneHour.length<120||fourHour.length<FUTURES_CONFIG.MIN_CANDLES||fifteenMinute.length<120||fiveMinute.length<1000){
        throw new Error("Insufficient history: 1h="+oneHour.length+", 4h="+fourHour.length+", 15m="+fifteenMinute.length+", 5m="+fiveMinute.length);
      }
      loaded.push({ticker,oneHour,fourHour,fifteenMinute,fiveMinute});
    }catch(error){loaded.push({ticker,error:error.message});}
  }
  const windows={};
  for(const days of [90,180]){
    const symbolResults=loaded.map(data=>data.error?{symbol:data.ticker.symbol,error:data.error}:runWindowForSymbol(data,days,endMs));
    const baselineTrades=symbolResults.flatMap(x=>x.baseline?.trades||[]).sort((a,b)=>a.entryTime-b.entryTime);
    const experimentalTrades=symbolResults.flatMap(x=>x.experimental?.trades||[]).sort((a,b)=>a.entryTime-b.entryTime);
    const sum=(arm,key)=>symbolResults.reduce((n,x)=>n+Number(x[arm]?.[key]||0),0);
    windows[days+"d"]={
      period:{from:new Date(endMs-days*DAY).toISOString(),to:new Date(endMs).toISOString(),days},
      symbolsLoaded:loaded.filter(x=>!x.error).length,symbolsRequested:SYMBOL_LIMIT,
      baseline:{opportunities:sum("baseline","opportunities"),filled:sum("baseline","filled"),lockSkips:sum("baseline","lockSkips"),metrics:summarize(baselineTrades)},
      experimental:{
        opportunities:sum("experimental","opportunities"),filled:sum("experimental","filled"),expired:sum("experimental","expired"),lockSkips:sum("experimental","lockSkips"),
        marketOrders:sum("experimental","marketOrders"),limitOrders:sum("experimental","limitOrders"),
        limitGapFills:sum("experimental","limitGapFills"),limitTouchFills:sum("experimental","limitTouchFills"),
        metrics:summarize(experimentalTrades)
      },
      paired:{filledBoth:Math.min(baselineTrades.length,experimentalTrades.length),
        netRDelta:experimentalTrades.reduce((s,t)=>s+t.netR,0)-baselineTrades.reduce((s,t)=>s+t.netR,0)},
      symbols:symbolResults.map(({baseline,experimental,...rest})=>({ ...rest,
        baseline:baseline?{opportunities:baseline.opportunities,filled:baseline.filled,metrics:baseline.metrics}:null,
        experimental:experimental?{opportunities:experimental.opportunities,filled:experimental.filled,expired:experimental.expired,lockSkips:experimental.lockSkips,
          marketOrders:experimental.marketOrders,limitOrders:experimental.limitOrders,metrics:experimental.metrics}:null
      })),
      trades:{baseline:baselineTrades,experimental:experimentalTrades}
    };
  }
  const report={
    generatedAt:new Date().toISOString(),venue:"Kraken Derivatives public historical OHLC",
    settings:{symbolsRequested:SYMBOL_LIMIT,feePerSidePct:FEE_PER_SIDE*100,slippagePerSidePct:SLIPPAGE_PER_SIDE*100,
      maxHoldHours:MAX_HOLD_HOURS,limitValidityMinutes:LIMIT_VALID_BARS*5,
      fallback:"completed 5m bearish => market at next 5m open; bullish/Doji => sell limit at observed high; limit fills at open if gapped above, else at touched limit; expiry after 12 bars",
      target1:"SHORT TP1 distance=min(1.5R,2.5*1h ATR); TP2=2.5R; TP3=3.5R; weights 40/35/25",
      entryCohort:"eligible SHORT candidates where first completed post-signal 5m close is below both 1h EMA20 and prior 1h high, with levels >0.5% apart",
      stopTargetSameBar:"stop first (conservative)",funding:"excluded",
      lookahead:"5m direction and high are taken only from the completed decision candle; entry starts on following 5m candles",
      universe:"top current Kraken perpetuals by current quote volume; survivorship/universe bias applies"},
    windows
  };
  await mkdir("artifacts",{recursive:true});
  await writeFile("artifacts/short-priority-fallback-backtest.json",JSON.stringify(report,null,2));
  const lines=["# SHORT priority and fallback experiment","",
    "Generated: "+report.generatedAt,"",
    "Fees: "+report.settings.feePerSidePct+"% per side; slippage: "+report.settings.slippagePerSidePct+"% per side",
    "Universe: "+report.settings.symbolsRequested+" top current-volume Kraken perpetuals; survivorship bias applies.",""];
  for(const [label,w] of Object.entries(windows)){
    lines.push("## "+label,"",
      "| Metric | Baseline Market | Smart Fallback |",
      "|---|---:|---:|",
      "| Opportunities | "+w.baseline.opportunities+" | "+w.experimental.opportunities+" |",
      "| Filled | "+w.baseline.filled+" | "+w.experimental.filled+" |",
      "| Expired | 0 | "+w.experimental.expired+" |",
      "| Win rate | "+w.baseline.metrics.winRatePct.toFixed(2)+"% | "+w.experimental.metrics.winRatePct.toFixed(2)+"% |",
      "| Net R | "+w.baseline.metrics.netR.toFixed(3)+" | "+w.experimental.metrics.netR.toFixed(3)+" |",
      "| Expectancy R | "+w.baseline.metrics.expectancyR.toFixed(4)+" | "+w.experimental.metrics.expectancyR.toFixed(4)+" |",
      "| Profit factor | "+w.baseline.metrics.profitFactor+" | "+w.experimental.metrics.profitFactor+" |",
      "| Max drawdown R | "+w.baseline.metrics.maxDrawdownR.toFixed(3)+" | "+w.experimental.metrics.maxDrawdownR.toFixed(3)+" |",
      "| Limit orders | 0 | "+w.experimental.limitOrders+" |",
      "| Market orders | "+w.baseline.filled+" | "+w.experimental.marketOrders+" |",""
    );
  }
  lines.push("## Methodology","",report.settings.fallback,"",report.settings.target1,"",
    "The test cohort is intentionally limited to the exact MARKET_FALLBACK condition. The signal is not removed when a Limit fails to fill; only the simulated execution expires. 5m OHLC cannot reveal intrabar order, so stop is evaluated before targets when both are touched. Funding is excluded. Results are research-only and do not represent live execution.","");
  await writeFile("artifacts/short-priority-fallback-backtest.md",lines.join("\n"));
  console.log(JSON.stringify(report,null,2));
}

main().catch(error=>{console.error(error);process.exitCode=1;});

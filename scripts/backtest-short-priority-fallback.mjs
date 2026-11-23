import { analyzeFuturesSymbol, FUTURES_CONFIG } from "../src/index.js";
import { evaluateTradeCandle, FUTURES_TRADE_LEVERAGE } from "../src/futures-trade-lifecycle.js";
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
    profitCloses:trades.filter(t=>t.exitReason==="CLOSED_PROFIT").length,
    stopCloses:trades.filter(t=>t.exitReason==="CLOSED_STOP").length,
    winRatePct:trades.length?wins.length/trades.length*100:0,
    netR:trades.reduce((s,t)=>s+t.netR,0),
    expectancyR:trades.length?trades.reduce((s,t)=>s+t.netR,0)/trades.length:0,
    profitFactor:grossLoss?grossWin/grossLoss:grossWin?null:0,
    maxDrawdownR
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
    rewardRisk:target1Distance/risk,target1Mode:"ATR_CAPPED_SHORT"};
}

function simulateShortTrade({symbol,levels,candles5m,fillIndex,fee,slippage,maxHoldHours,targetMode="LEGACY_3_PERCENT"}) {
  const entry=levels.entry, risk=levels.risk;
  const trade={symbol,side:"SHORT",status:"OPEN",entry,actualEntry:entry,stop:levels.stop,
    initialStop:levels.stop,currentStop:levels.stop,target1:levels.target1};
  if(targetMode==="ATR_CAPPED_SHORT")trade.target1Mode="ATR_CAPPED_SHORT";
  const end=Math.min(candles5m.length-1,fillIndex+maxHoldHours*12);
  let exitPrice=null,exitReason="TIME_EXIT",exitIndex=end;
  for(let i=fillIndex;i<=end;i++){
    const result=evaluateTradeCandle(trade,candles5m[i],{leverage:FUTURES_TRADE_LEVERAGE});
    if(result.changed){
      exitPrice=Number(result.trade.exitPrice);
      exitReason=result.reason;
      exitIndex=i;
      break;
    }
  }
  if(!Number.isFinite(exitPrice)||exitPrice<=0)exitPrice=Number(candles5m[end]?.close);
  const adjustedExit=exitPrice*(1+slippage);
  const netR=(entry-adjustedExit)/risk-fee*(entry+adjustedExit)/risk;
  return {symbol,entry,stop:levels.stop,target1:levels.target1,target2:levels.target2,target3:levels.target3,
    target1Mode:targetMode,rewardRisk:levels.rewardRisk,exitPrice:adjustedExit,netR,
    exitReason,fillIndex,exitIndex,entryTime:candles5m[fillIndex].time,exitTime:candles5m[exitIndex].time};
}

function lowerBound(candles,time) {
  let lo=0,hi=candles.length;
  while(lo<hi){const mid=(lo+hi)>>1;if(candles[mid].time<time)lo=mid+1;else hi=mid;}
  return lo;
}

function createArm() {
  return {trades:[],opportunities:0,filled:0,expired:0,invalidLevels:0,lockSkips:0,marketOrders:0,limitOrders:0,bullishLimitOrders:0,dojiLimitOrders:0,limitGapFills:0,limitTouchFills:0};
}

function runWindowForSymbol(data,days,endMs) {
  const startMs=endMs-days*DAY;
  const {ticker,oneHour,fourHour,fifteenMinute,fiveMinute}=data;
  const arms={baselineLegacy:createArm(),baselineDynamic:createArm(),smartLegacy:createArm(),smartDynamic:createArm()};
  const smartOrders={marketOrders:0,limitOrders:0,bullishLimitOrders:0,dojiLimitOrders:0,limitGapFills:0,limitTouchFills:0};
  let lockUntilFiveIndex=0,fourIndex=0,fifteenIndex=0;
  const firstHourly=lowerBound(oneHour,startMs-WARMUP_DAYS*DAY);
  for(let i=Math.max(60,firstHourly);i<oneHour.length-1;i++){
    const signalBar=oneHour[i],signalCloseTime=signalBar.time+HOUR;
    if(signalCloseTime<startMs||signalCloseTime>endMs)continue;
    while(fourIndex<fourHour.length&&fourHour[fourIndex].time+FOUR_HOURS<=signalCloseTime)fourIndex++;
    while(fifteenIndex<fifteenMinute.length&&fifteenMinute[fifteenIndex].time+FIFTEEN_MINUTES<=signalCloseTime)fifteenIndex++;
    if(fourIndex<FUTURES_CONFIG.MIN_CANDLES)continue;
    const closed4h=fourHour.slice(0,fourIndex);
    const closed15m=fifteenMinute.slice(Math.max(0,fifteenIndex-160),fifteenIndex);
    const historicalQuoteVolume=oneHour.slice(Math.max(0,i-23),i+1).reduce((sum,c)=>sum+Number(c.volume)*Number(c.close),0);
    const tickerAtSignal={symbol:ticker.symbol,last:signalBar.close,quoteVolume:historicalQuoteVolume,
      priceChangePercent:historicalChange(oneHour,i),premium:{lastFundingRate:null}};
    const candidate=analyzeFuturesSymbol(tickerAtSignal,oneHour.slice(0,i+1),closed4h,closed15m);
    if(candidate?.side!=="SHORT"||candidate?.eligible!==true)continue;
    const decisionIndex=lowerBound(fiveMinute,signalCloseTime);
    const decisionCandle=fiveMinute[decisionIndex];
    if(!decisionCandle||decisionIndex+1>=fiveMinute.length)continue;
    const resistance=Number(oneHour[i-1]?.high),ema20=ema(oneHour.slice(0,i+1).map(c=>c.close),20);
    if(!Number.isFinite(resistance)||!Number.isFinite(ema20)||ema20<=0)continue;
    const observedPrice=decisionCandle.close;
    if(!(observedPrice<ema20&&observedPrice<resistance))continue;
    const levelGapPct=Math.abs(ema20-resistance)/Math.min(ema20,resistance)*100;
    if(levelGapPct<=0.5)continue;
    for(const arm of Object.values(arms))arm.opportunities++;
    if(decisionIndex+1<lockUntilFiveIndex){for(const arm of Object.values(arms))arm.lockSkips++;continue;}

    const following=fiveMinute.slice(decisionIndex+1,decisionIndex+1+LIMIT_VALID_BARS);
    const decision=resolveShortFallbackFill({decisionCandle,followingCandles:following,validBars:LIMIT_VALID_BARS,
      marketSlippage:SLIPPAGE_PER_SIDE});
    const marketRaw=Number(fiveMinute[decisionIndex+1]?.open);
    if(!Number.isFinite(marketRaw)||marketRaw<=0)continue;
    const baselineEntry=marketRaw*(1-SLIPPAGE_PER_SIDE);
    const baselineLevels=buildShortLevels({oneHour,signalIndex:i,entry:baselineEntry,atr:candidate.atr});
    if(!baselineLevels){for(const arm of Object.values(arms))arm.invalidLevels++;continue;}

    const baseMeta={entryType:"MARKET",signalTime:signalCloseTime};
    const baseLegacy=simulateShortTrade({symbol:ticker.symbol,levels:baselineLevels,candles5m:fiveMinute,
      fillIndex:decisionIndex+1,fee:FEE_PER_SIDE,slippage:SLIPPAGE_PER_SIDE,maxHoldHours:MAX_HOLD_HOURS,targetMode:"LEGACY_3_PERCENT"});
    const baseDynamic=simulateShortTrade({symbol:ticker.symbol,levels:baselineLevels,candles5m:fiveMinute,
      fillIndex:decisionIndex+1,fee:FEE_PER_SIDE,slippage:SLIPPAGE_PER_SIDE,maxHoldHours:MAX_HOLD_HOURS,targetMode:"ATR_CAPPED_SHORT"});
    arms.baselineLegacy.trades.push({...baseLegacy,...baseMeta});
    arms.baselineDynamic.trades.push({...baseDynamic,...baseMeta});
    arms.baselineLegacy.filled++;arms.baselineDynamic.filled++;

    if(decision.type==="MARKET")smartOrders.marketOrders++;
    else {
      smartOrders.limitOrders++;
      if(decision.decisionReason==="BULLISH_5M")smartOrders.bullishLimitOrders++;
      if(decision.decisionReason==="DOJI_5M")smartOrders.dojiLimitOrders++;
    }
    let smartLegacyTrade=null,smartDynamicTrade=null;
    if(decision.filled){
      const fillIndex=decisionIndex+1+decision.fillIndex;
      const levels=buildShortLevels({oneHour,signalIndex:i,entry:decision.fillPrice,atr:candidate.atr});
      if(levels){
        const meta={entryType:decision.type,orderDecision:decision.decisionReason,fillReason:decision.reason,signalTime:signalCloseTime};
        smartLegacyTrade=simulateShortTrade({symbol:ticker.symbol,levels,candles5m:fiveMinute,fillIndex,
          fee:FEE_PER_SIDE,slippage:SLIPPAGE_PER_SIDE,maxHoldHours:MAX_HOLD_HOURS,targetMode:"LEGACY_3_PERCENT"});
        smartDynamicTrade=simulateShortTrade({symbol:ticker.symbol,levels,candles5m:fiveMinute,fillIndex,
          fee:FEE_PER_SIDE,slippage:SLIPPAGE_PER_SIDE,maxHoldHours:MAX_HOLD_HOURS,targetMode:"ATR_CAPPED_SHORT"});
        arms.smartLegacy.trades.push({...smartLegacyTrade,...meta});
        arms.smartDynamic.trades.push({...smartDynamicTrade,...meta});
        arms.smartLegacy.filled++;arms.smartDynamic.filled++;
        if(decision.type==="LIMIT"){
          if(decision.reason==="LIMIT_GAP_FILL")smartOrders.limitGapFills++;
          if(decision.reason==="LIMIT_TOUCH_FILL")smartOrders.limitTouchFills++;
        }
      }else{arms.smartLegacy.invalidLevels++;arms.smartDynamic.invalidLevels++;}
    }else{arms.smartLegacy.expired++;arms.smartDynamic.expired++;}
    const expiryIndex=decision.filled
      ? (smartDynamicTrade?.exitIndex??smartLegacyTrade?.exitIndex??decisionIndex+LIMIT_VALID_BARS)
      : decisionIndex+LIMIT_VALID_BARS;
    lockUntilFiveIndex=Math.max(baseLegacy.exitIndex,baseDynamic.exitIndex,
      smartLegacyTrade?.exitIndex??expiryIndex,smartDynamicTrade?.exitIndex??expiryIndex,expiryIndex)+1;
  }
  const output={symbol:ticker.symbol,smartOrders};
  for(const [name,arm] of Object.entries(arms)){
    output[name]={opportunities:arm.opportunities,filled:arm.filled,expired:arm.expired,
      invalidLevels:arm.invalidLevels,lockSkips:arm.lockSkips,metrics:summarize(arm.trades),trades:arm.trades};
  }
  return output;
}

async function main() {
  const dataEndMs=Date.now();
  const endMs=dataEndMs-MAX_HOLD_HOURS*HOUR;
  const fromMs=endMs-(180+WARMUP_DAYS)*DAY;
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
        fetchHistoricalCandles(ticker.symbol,"1h",fromMs,dataEndMs,HOUR),
        fetchHistoricalCandles(ticker.symbol,"4h",fromMs,dataEndMs,FOUR_HOURS),
        fetchHistoricalCandles(ticker.symbol,"15m",fromMs,dataEndMs,FIFTEEN_MINUTES),
        fetchHistoricalCandles(ticker.symbol,"5m",fromMs,dataEndMs,FIVE_MINUTES)
      ]);
      if(oneHour.length<120||fourHour.length<FUTURES_CONFIG.MIN_CANDLES||fifteenMinute.length<120||fiveMinute.length<1000)
        throw new Error("Insufficient history: 1h="+oneHour.length+", 4h="+fourHour.length+", 15m="+fifteenMinute.length+", 5m="+fiveMinute.length);
      loaded.push({ticker,oneHour,fourHour,fifteenMinute,fiveMinute});
    }catch(error){loaded.push({ticker,error:error.message});}
  }
  const windows={};
  for(const days of [90,180]){
    const symbolResults=loaded.map(data=>data.error?{symbol:data.ticker.symbol,error:data.error}:runWindowForSymbol(data,days,endMs));
    const names=["baselineLegacy","baselineDynamic","smartLegacy","smartDynamic"];
    const arms={};
    for(const name of names){
      const trades=symbolResults.flatMap(x=>x[name]?.trades||[]).sort((a,b)=>a.entryTime-b.entryTime);
      const sum=key=>symbolResults.reduce((n,x)=>n+Number(x[name]?.[key]||0),0);
      arms[name]={opportunities:sum("opportunities"),filled:sum("filled"),expired:sum("expired"),
        invalidLevels:sum("invalidLevels"),lockSkips:sum("lockSkips"),metrics:summarize(trades),trades};
    }
    const smartOrders={};
    for(const key of ["marketOrders","limitOrders","bullishLimitOrders","dojiLimitOrders","limitGapFills","limitTouchFills"])
      smartOrders[key]=symbolResults.reduce((n,x)=>n+Number(x.smartOrders?.[key]||0),0);
    function compare(baseName,expName){
      const base=arms[baseName].trades,exp=arms[expName].trades;
      const baseMap=new Map(base.map(t=>[t.symbol+"|"+t.signalTime,t]));
      const expMap=new Map(exp.map(t=>[t.symbol+"|"+t.signalTime,t]));
      const keys=[...expMap.keys()].filter(k=>baseMap.has(k));
      const baseNet=keys.reduce((n,k)=>n+baseMap.get(k).netR,0);
      const expNet=keys.reduce((n,k)=>n+expMap.get(k).netR,0);
      return {matchedFills:keys.length,baselineMatchedNetR:baseNet,experimentalMatchedNetR:expNet,
        matchedNetRDelta:expNet-baseNet,totalStrategyNetRDelta:exp.reduce((n,t)=>n+t.netR,0)-base.reduce((n,t)=>n+t.netR,0)};
    }
    windows[days+"d"]={
      period:{from:new Date(endMs-days*DAY).toISOString(),to:new Date(endMs).toISOString(),days},
      symbolsLoaded:loaded.filter(x=>!x.error).length,symbolsRequested:SYMBOL_LIMIT,arms,smartOrders,
      comparisons:{
        dynamicTp1VsLegacyMarket:compare("baselineLegacy","baselineDynamic"),
        smartFallbackVsMarketLegacyTp1:compare("baselineLegacy","smartLegacy"),
        smartFallbackVsMarketDynamicTp1:compare("baselineDynamic","smartDynamic"),
        combinedSmartVsCurrentLegacy:compare("baselineLegacy","smartDynamic")
      },
      symbols:symbolResults.map(x=>({symbol:x.symbol,error:x.error||null,
        baselineLegacy:x.baselineLegacy?{filled:x.baselineLegacy.filled,metrics:x.baselineLegacy.metrics}:null,
        baselineDynamic:x.baselineDynamic?{filled:x.baselineDynamic.filled,metrics:x.baselineDynamic.metrics}:null,
        smartLegacy:x.smartLegacy?{filled:x.smartLegacy.filled,expired:x.smartLegacy.expired,metrics:x.smartLegacy.metrics}:null,
        smartDynamic:x.smartDynamic?{filled:x.smartDynamic.filled,expired:x.smartDynamic.expired,metrics:x.smartDynamic.metrics}:null,
        smartOrders:x.smartOrders||null}))
    };
  }
  const report={generatedAt:new Date().toISOString(),venue:"Kraken Derivatives public historical OHLC",
    settings:{symbolsRequested:SYMBOL_LIMIT,feePerSidePct:FEE_PER_SIDE*100,slippagePerSidePct:SLIPPAGE_PER_SIDE*100,
      leverage:FUTURES_TRADE_LEVERAGE,maxHoldHours:MAX_HOLD_HOURS,limitValidityMinutes:LIMIT_VALID_BARS*5,
      legacyTarget:"production legacy lifecycle target: fixed 3% favorable price move (30% margin return at 10x)",
      dynamicTarget:"SHORT TP1 distance=min(1.5R,2.5*1h ATR); production lifecycle closes the whole trade at TP1 or stop; TP2/TP3 remain signal information only",
      fallback:"completed 5m bearish => market at next 5m open; bullish/Doji => sell limit at observed high; limit fills at open if gapped above, else at touched limit; expiry after 12 bars",
      entryCohort:"eligible SHORT candidates where first completed post-signal 5m close is below both 1h EMA20 and prior 1h high, with levels >0.5% apart",
      stopTargetSameBar:"production lifecycle: an open-gap through a level wins; otherwise stop wins when both levels are touched intrabar",
      funding:"excluded",drawdownMethod:"maximum drawdown of chronological additive per-trade R; not account or portfolio equity drawdown",
      lookahead:"5m direction and high are taken only from the completed decision candle; entry starts on following 5m candles",
      rightCensoring:"analysis window ends 72 hours before data end so every trade can receive the full 72-hour maximum hold window",
      universe:"top current Kraken perpetuals by current quote volume; survivorship/universe bias applies"},
    windows};
  await mkdir("artifacts",{recursive:true});
  await writeFile("artifacts/short-priority-fallback-backtest.json",JSON.stringify(report,null,2));
  const lines=["# SHORT priority, dynamic TP1 and fallback experiment","",
    "Generated: "+report.generatedAt,"",
    "Fees: "+report.settings.feePerSidePct+"% per side; slippage: "+report.settings.slippagePerSidePct+"% per side",
    "Universe: "+report.settings.symbolsRequested+" top current-volume Kraken perpetuals; survivorship bias applies.",""];
  const rows=[["Current market + legacy 3% target","baselineLegacy"],["Market + dynamic TP1","baselineDynamic"],
    ["Smart fallback + legacy 3% target","smartLegacy"],["Smart fallback + dynamic TP1","smartDynamic"]];
  for(const [label,w] of Object.entries(windows)){
    lines.push("## "+label,"",
      "| Strategy | Filled | Expired | Win rate | Profit closes | Stop closes | Net R | Expectancy R | Profit factor | Max DD R |",
      "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
    for(const [name,key] of rows){const a=w.arms[key],m=a.metrics;
      lines.push("| "+name+" | "+a.filled+" | "+a.expired+" | "+m.winRatePct.toFixed(2)+"% | "+m.profitCloses+" | "+
        m.stopCloses+" | "+m.netR.toFixed(3)+" | "+m.expectancyR.toFixed(4)+" | "+m.profitFactor+" | "+m.maxDrawdownR.toFixed(3)+" |");
    }
    lines.push("",
      "Opportunities: "+w.arms.baselineLegacy.opportunities+"; shared lock skips: "+w.arms.baselineLegacy.lockSkips+
      "; invalid risk levels: "+w.arms.baselineLegacy.invalidLevels+".",
      "Smart orders: market "+w.smartOrders.marketOrders+", limit "+w.smartOrders.limitOrders+
      " (bullish "+w.smartOrders.bullishLimitOrders+", Doji "+w.smartOrders.dojiLimitOrders+
      "); limit gap fills "+w.smartOrders.limitGapFills+", limit touch fills "+w.smartOrders.limitTouchFills+
      "; unfilled limits "+w.arms.smartDynamic.expired+".","",
      "| Comparison | Matched fills | Matched net R delta | Total strategy net R delta |",
      "|---|---:|---:|---:|");
    const comps=[["Dynamic TP1 vs current market",w.comparisons.dynamicTp1VsLegacyMarket],
      ["Smart fallback vs market (legacy target)",w.comparisons.smartFallbackVsMarketLegacyTp1],
      ["Smart fallback vs market (dynamic TP1)",w.comparisons.smartFallbackVsMarketDynamicTp1],
      ["Combined smart vs current market",w.comparisons.combinedSmartVsCurrentLegacy]];
    for(const [name,c] of comps)lines.push("| "+name+" | "+c.matchedFills+" | "+c.matchedNetRDelta.toFixed(3)+" | "+c.totalStrategyNetRDelta.toFixed(3)+" |");
    lines.push("");
  }
  lines.push("## Methodology","",report.settings.legacyTarget,"",report.settings.dynamicTarget,"",report.settings.fallback,"",
    "The cohort is limited to the exact MARKET_FALLBACK condition. Signals are counted identically across arms; a failed Limit only expires that simulated execution. Exits use production evaluateTradeCandle. Open gaps are honored; otherwise stop wins if both stop and TP1 are touched intrabar. Funding is excluded. Drawdown is additive per-trade R, not portfolio-level equity drawdown. Results are research-only and do not represent live order execution.","");
  await writeFile("artifacts/short-priority-fallback-backtest.md",lines.join("\n"));
  console.log(JSON.stringify(report,null,2));
}

main().catch(error=>{console.error(error);process.exitCode=1;});

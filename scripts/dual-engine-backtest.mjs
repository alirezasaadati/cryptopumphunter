import fs from "node:fs/promises";
import { analyzeEngineA } from "../src/engines/engine-a.js";
import { analyzeEngineB } from "../src/engines/engine-b.js";
import { simulatePaperTrade } from "../src/engines/paper-simulator.js";

const BASE = "https://futures.kraken.com/api/charts/v1";
const SYMBOLS = [
  "PF_XBTUSD","PF_ETHUSD","PF_SOLUSD","PF_XRPUSD","PF_DOGEUSD",
  "PF_ADAUSD","PF_LINKUSD","PF_AVAXUSD","PF_DOTUSD"
];
const INTERVAL_MS = 15 * 60 * 1000;
const DAYS = Number(process.env.BACKTEST_DAYS ?? 90);
const ENTRY_NOTIONAL = Number(process.env.ENTRY_NOTIONAL_USD ?? 100);
const FEE_RATE = Number(process.env.FEE_RATE ?? 0.0005);
const SLIPPAGE_BPS = Number(process.env.SLIPPAGE_BPS ?? 2);
const MAX_HOLD_BARS = Number(process.env.MAX_HOLD_BARS ?? 500);
const A_WEIGHTS = [0.2,0.2,0.2,0.2,0.2];
const B_WEIGHTS = [0.4,0.35,0.25];
const end = Math.floor(Date.now()/INTERVAL_MS)*INTERVAL_MS;
const start = end - DAYS*24*60*60*1000;
const splitAt = start + Math.floor(DAYS*2/3)*24*60*60*1000;

const report = {
  generatedAt: new Date().toISOString(),
  source: "Kraken Futures public 15m OHLC candles",
  timeframe: "15m",
  window: {start:new Date(start).toISOString(),end:new Date(end).toISOString(),days:DAYS,splitAt:new Date(splitAt).toISOString()},
  universe: SYMBOLS,
  methodology: {
    signalTiming: "Signal is evaluated using the just-closed candle; execution starts no earlier than the next candle.",
    liquidity: "Historical quote turnover is not validated; liquidity filter is explicitly bypassed for this research run. Current contract tick size and quantity precision are read from Kraken instrument metadata.",
    universe: "Current listed PF contracts only; delisted/historical universe and survivorship bias are not resolved.",
    fees: {rate:FEE_RATE, note:"Configurable research assumption; not verified account-specific Kraken fee tier."},
    slippageBps: SLIPPAGE_BPS,
    maxEntryDriftPct: 0.35,
    quantityPrecision: "per-instrument contractValueTradePrecision",
    priceLevels: "Rounded conservatively to each instrument tick size.",
    funding: "Kraken historical relativeFundingRate is applied at settlement boundaries to positions carried into that timestamp; settlement price uses the 15m candle open.",
    exits: {
      engineA: {weights:A_WEIGHTS, note:"Equal allocation across five targets is an explicit provisional research assumption."},
      engineA_BE: {weights:A_WEIGHTS, stopPolicy:"Move stop to weighted average entry only after TP1; separate variant."},
      engineB: {weights:B_WEIGHTS, note:"40/35/25 provisional allocation."}
    },
    entryNotionalPerLegUsd: ENTRY_NOTIONAL,
    maxHoldBars: MAX_HOLD_BARS,
    portfolio: "Trades are sequential per engine/symbol; cross-symbol portfolio exposure, correlation, and concurrent capital constraints are not modeled.",
    drawdown: "Max drawdown is a closed-trade equity-curve proxy sorted by exit timestamp, not a true portfolio drawdown because cross-symbol overlap and capital allocation are not modeled.",
    walkForward: "Fixed parameters are evaluated separately on the first two-thirds development window and final one-third holdout window; no tuning is performed on the holdout.",
    intrabar: "Stop-first; ambiguous Entry 2 versus TP1 resolves TP1-first/cancel Entry 2 and is recorded."
  },
  data: [],
  engines: {A:{trades:[],skipped:[],summary:null},A_BE:{trades:[],skipped:[],summary:null},B:{trades:[],skipped:[],summary:null}},
  warnings: [
    "This is an exploratory strategy backtest, not proof of future performance.",
    "Liquidity filter is disabled because historical quote turnover and contract multipliers are not yet validated.",
    "Funding-rate completeness is reported per contract; if Kraken does not return historical rates for a symbol, that symbol has incomplete funding accounting.",
    "Current-contract-only universe introduces survivorship bias."
  ]
};

const sleep = ms => new Promise(resolve=>setTimeout(resolve,ms));
async function getJson(url) {
  let error;
  for(let attempt=0;attempt<5;attempt++){
    try{
      const response=await fetch(url,{headers:{accept:"application/json"}});
      if(!response.ok) throw new Error("HTTP "+response.status);
      return await response.json();
    }catch(e){error=e;await sleep(400*(attempt+1));}
  }
  throw error;
}

async function fetchInstruments(){
  const payload=await getJson("https://futures.kraken.com/derivatives/api/v3/instruments");
  return new Map((payload.instruments??[]).map(item=>[item.symbol, item]));
}

function normalizeSignal(signal,tickSize){
  const side=signal.side;
  const snap=(price,mode)=>Number((Math[mode](price/tickSize)*tickSize).toPrecision(12));
  const normalized={...signal,entry:snap(signal.entry,"round"),
    stop:snap(signal.stop,side==="LONG"?"floor":"ceil"),
    targets:signal.targets.map(price=>snap(price,side==="LONG"?"ceil":"floor"))};
  const rawEntry2=signal.entry2??signal.context?.entry2??null;
  const entry2=rawEntry2===null?null:snap(rawEntry2,side==="LONG"?"floor":"ceil");
  normalized.entry2=entry2;
  normalized.context={...signal.context,entry2};
  return normalized;
}

async function fetchFunding(symbol){
  const payload=await getJson(`https://futures.kraken.com/derivatives/api/v3/historical-funding-rates?symbol=${encodeURIComponent(symbol)}`);
  const rates=new Map();
  for(const item of payload.rates??[]){
    const time=Date.parse(item.timestamp), rate=Number(item.relativeFundingRate);
    if(Number.isFinite(time)&&Number.isFinite(rate)) rates.set(time,rate);
  }
  return rates;
}

async function fetchCandles(symbol){
  const byTime=new Map();
  for(let from=start;from<end;from+=7*24*60*60*1000){
    const to=Math.min(end,from+7*24*60*60*1000);
    const url=`${BASE}/trade/${symbol}/15m?from=${Math.floor(from/1000)}&to=${Math.floor(to/1000)}&count=1000`;
    const payload=await getJson(url);
    for(const c of payload.candles??[]){
      const candle={time:Number(c.time),open:Number(c.open),high:Number(c.high),
        low:Number(c.low),close:Number(c.close),volume:Number(c.volume)};
      if(Number.isFinite(candle.time)) byTime.set(candle.time,candle);
    }
    await sleep(180);
  }
  return [...byTime.values()].sort((a,b)=>a.time-b.time);
}

function summarize(trades,skipped){
  const closed=trades.filter(t=>t.status==="closed").sort((a,b)=>(a.closedAt??0)-(b.closedAt??0));
  const wins=closed.filter(t=>t.netPnl>0);
  const losses=closed.filter(t=>t.netPnl<0);
  const grossProfit=wins.reduce((s,t)=>s+t.netPnl,0);
  const grossLoss=Math.abs(losses.reduce((s,t)=>s+t.netPnl,0));
  let equity=0, peak=0, maxDrawdown=0;
  for(const trade of closed){
    equity+=trade.netPnl; peak=Math.max(peak,equity);
    maxDrawdown=Math.max(maxDrawdown,peak-equity);
  }
  const sideStats=side=>{
    const subset=closed.filter(t=>t.side===side), sideWins=subset.filter(t=>t.netPnl>0), sideLosses=subset.filter(t=>t.netPnl<0);
    const profit=sideWins.reduce((s,t)=>s+t.netPnl,0), loss=Math.abs(sideLosses.reduce((s,t)=>s+t.netPnl,0));
    return {closed:subset.length,netPnlUsd:Number(subset.reduce((s,t)=>s+t.netPnl,0).toFixed(6)),
      winRatePct:subset.length?Number((sideWins.length/subset.length*100).toFixed(2)):null,
      profitFactor:loss?Number((profit/loss).toFixed(4)):profit?null:0};
  };
  return {
    signals:trades.length+skipped,executed:trades.length,skipped,closed:closed.length,open:trades.filter(t=>t.status==="open").length,
    wins:wins.length,losses:losses.length,
    winRatePct:closed.length?Number((wins.length/closed.length*100).toFixed(2)):null,
    netPnlUsd:Number(trades.reduce((s,t)=>s+t.netPnl,0).toFixed(6)),
    closedNetPnlUsd:Number(closed.reduce((s,t)=>s+t.netPnl,0).toFixed(6)),
    profitFactor:grossLoss?Number((grossProfit/grossLoss).toFixed(4)):grossProfit?null:0,
    expectancyUsd:closed.length?Number((closed.reduce((s,t)=>s+t.netPnl,0)/closed.length).toFixed(6)):null,
    maxDrawdownUsd:Number(maxDrawdown.toFixed(6)),
    feesUsd:Number(trades.reduce((s,t)=>s+t.fees,0).toFixed(6)),
    fundingUsd:Number(trades.reduce((s,t)=>s+(t.funding??0),0).toFixed(6)),
    ambiguousBars:trades.reduce((s,t)=>s+t.ambiguousEvents.length,0),
    entry2FillRatePct:trades.length?Number((trades.filter(t=>t.entry2Filled).length/trades.length*100).toFixed(2)):0,
    bySide:{LONG:sideStats("LONG"),SHORT:sideStats("SHORT")}
  };
}

const instruments=await fetchInstruments();

for(const symbol of SYMBOLS){
  let candles;
  try{
    const instrument=instruments.get(symbol);
    const quantityPrecision=Number(instrument?.contractValueTradePrecision);
    const tickSize=Number(instrument?.tickSize);
    if(!instrument || !Number.isInteger(quantityPrecision) || quantityPrecision<0 || !(tickSize>0)){
      report.data.push({symbol,error:"Missing valid exchange tick/quantity precision metadata"});
      continue;
    }
    candles=await fetchCandles(symbol);
    let fundingRates=new Map(), fundingError=null;
    try{fundingRates=await fetchFunding(symbol);}catch(error){fundingError=String(error?.message??error);}
    const valid=candles.filter(c=>[c.time,c.open,c.high,c.low,c.close,c.volume].every(Number.isFinite) &&
      c.open>0 && c.low>0 && c.volume>=0 && c.high>=Math.max(c.open,c.close) &&
      c.low<=Math.min(c.open,c.close));
    let fundingSettlements=0;
    for(const candle of valid){
      if(fundingRates.has(candle.time)){
        candle.fundingSettlement=true;
        candle.fundingRate=fundingRates.get(candle.time);
        fundingSettlements++;
      }
    }
    const gaps=[];
    for(let i=1;i<valid.length;i++){
      const delta=valid[i].time-valid[i-1].time;
      if(delta>INTERVAL_MS) gaps.push({from:valid[i-1].time,to:valid[i].time,count:Math.round(delta/INTERVAL_MS)-1});
    }
    report.data.push({symbol,candles:valid.length,first:valid[0]?.time??null,last:valid.at(-1)?.time??null,
      gapCount:gaps.length,missingIntervals:gaps.reduce((s,g)=>s+g.count,0),errors:valid.length!==candles.length?candles.length-valid.length:0,
      fundingRecords:fundingRates.size,fundingSettlementsInWindow:fundingSettlements,fundingError,
      tickSize,quantityPrecision,contractSize:instrument.contractSize,contractType:instrument.type});
    for(const engine of ["A","A_BE","B"]){
      const analyze=engine==="B"?analyzeEngineB:analyzeEngineA;
      const weights=engine==="B"?B_WEIGHTS:A_WEIGHTS;
      const trades=report.engines[engine].trades;
      let i=79;
      while(i<valid.length-1){
        const history=valid.slice(0,i+1);
        const signal=analyze({symbol,candles:history,skipLiquidityCheck:true});
        if(!signal){i++;continue;}
        const executableSignal=normalizeSignal(signal,tickSize);
        const result=simulatePaperTrade({
          signal:executableSignal,candles:valid.slice(i+1),entryNotional:ENTRY_NOTIONAL,
          targetWeights:weights,feeRate:FEE_RATE,slippageBps:SLIPPAGE_BPS,maxEntryDriftPct:0.35,
          quantityPrecision,moveStopToBreakevenAfterTarget1:engine==="A_BE",maxBars:MAX_HOLD_BARS
        });
        if(["invalid_input","invalid_data","no_future_candles","not_filled"].includes(result.status)){
          report.engines[engine].skipped.push({symbol,side:signal.side,candleTime:signal.candleTime,
            score:signal.score,status:result.status,reason:result.reason??null});
          i++;continue;
        }
        trades.push({symbol,side:signal.side,candleTime:signal.candleTime,score:signal.score,
          entry:executableSignal.entry,entry2:executableSignal.entry2??null,stop:executableSignal.stop,targets:executableSignal.targets,
          status:result.status,netPnl:result.netPnl,fees:result.fees,funding:result.funding,closedAt:result.exits.at(-1)?.time??null,
          returnPct:result.returnPct,barsObserved:result.barsObserved,entry2Filled:result.entry2Filled,
          stopMovedToBreakeven:result.stopMovedToBreakeven,ambiguousEvents:result.ambiguousEvents,exits:result.exits});
        i += result.barsObserved + 1;
      }
    }
    console.log(`completed ${symbol}: ${valid.length} candles`);
  }catch(error){
    report.data.push({symbol,error:String(error?.message??error)});
    console.log(`failed ${symbol}: ${String(error?.message??error)}`);
  }
}
for(const engine of ["A","A_BE","B"]){
  const item=report.engines[engine];
  item.summary=summarize(item.trades,item.skipped.length);
  item.summary.periods={
    development:summarize(item.trades.filter(t=>t.candleTime<splitAt && t.status==="closed" && t.closedAt!==null && t.closedAt<splitAt),item.skipped.filter(t=>t.candleTime<splitAt).length),
    holdout:summarize(item.trades.filter(t=>t.candleTime>=splitAt),item.skipped.filter(t=>t.candleTime>=splitAt).length),
    developmentBoundaryExcluded:item.trades.filter(t=>t.candleTime<splitAt && (t.status!=="closed" || t.closedAt===null || t.closedAt>=splitAt)).length
  };
}
await fs.mkdir("artifacts",{recursive:true});
await fs.writeFile("artifacts/dual-engine-backtest.json",JSON.stringify(report,null,2));
console.log(JSON.stringify({
  data:report.data.map(({symbol,candles,gapCount,missingIntervals,error})=>({symbol,candles,gapCount,missingIntervals,error})),
  A:report.engines.A.summary,A_BE:report.engines.A_BE.summary,B:report.engines.B.summary
},null,2));
if(!report.data.some(d=>d.candles>=80)) process.exitCode=1;

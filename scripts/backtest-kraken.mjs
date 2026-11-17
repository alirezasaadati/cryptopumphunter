import { analyzeFuturesSymbol, FUTURES_CONFIG, calculateTradeEconomics, qualifyTradeEconomics } from "../src/index.js";
import { mkdir, writeFile } from "node:fs/promises";

const BASE = "https://futures.kraken.com";
const HOUR = 60 * 60 * 1000;
const FOUR_HOURS = 4 * HOUR;
const FIFTEEN_MINUTES = 15 * 60 * 1000;
const DAYS = Math.max(15, Math.min(90, Number(process.env.BACKTEST_DAYS || 90)));
const SYMBOL_LIMIT = Math.max(1, Math.min(10, Number(process.env.BACKTEST_SYMBOLS || 5)));
const FEE_PER_SIDE = Math.max(0, Number(process.env.BACKTEST_FEE || 0.0005));
const SLIPPAGE_PER_SIDE = Math.max(0, Number(process.env.BACKTEST_SLIPPAGE || 0.0003));
const MAX_HOLD_HOURS = 72;
const MAX_HOLD_BARS = MAX_HOLD_HOURS * 4;
const DIRECTION_MODES = ["BOTH", "LONG_ONLY", "SHORT_ONLY"];
const TARGET_WEIGHTS = [0.20, 0.20, 0.60];

async function getJson(url) {
  const response = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(25000) });
  const body = await response.text();
  if (!response.ok) throw new Error("HTTP " + response.status + " for " + url + ": " + body.slice(0, 180));
  let data;
  try { data = JSON.parse(body); } catch { throw new Error("Invalid JSON from " + url); }
  if (data?.result === "error" || (Array.isArray(data?.errors) && data.errors.length)) throw new Error("Kraken API error: " + JSON.stringify(data.errors || data.error));
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
    Number.isFinite(c.time) && Number.isFinite(c.open) && Number.isFinite(c.high) &&
    Number.isFinite(c.low) && Number.isFinite(c.close) && Number.isFinite(c.volume) &&
    c.open > 0 && c.close > 0 && c.low > 0 && c.high >= c.low && c.volume >= 0
  ).sort((a,b)=>a.time-b.time).filter(c => {
    if (seen.has(c.time) || c.time + intervalMs > Date.now()) return false;
    seen.add(c.time); return true;
  });
}

async function fetchHistoricalCandles(symbol, resolution, fromMs, toMs, intervalMs) {
  const url = new URL(BASE + "/api/charts/v1/trade/" + encodeURIComponent(symbol) + "/" + resolution);
  url.searchParams.set("from", String(Math.floor(fromMs / 1000)));
  url.searchParams.set("to", String(Math.floor(toMs / 1000)));
  url.searchParams.set("count", "2000");
  const data = await getJson(url);
  if (data.more_candles === true) throw new Error(symbol + " " + resolution + ": Kraken reports more candles than requested; shorten backtest window.");
  return normalizeCandles(data.candles, intervalMs);
}

async function fetchHistoricalCandlesInChunks(symbol, resolution, fromMs, toMs, intervalMs) {
  const chunkMs = intervalMs * 1800;
  const batches = [];
  for (let start = fromMs; start < toMs; start += chunkMs) {
    batches.push(await fetchHistoricalCandles(symbol, resolution, start, Math.min(toMs, start + chunkMs), intervalMs));
  }
  const byTime = new Map();
  for (const candle of batches.flat()) byTime.set(candle.time, candle);
  return [...byTime.values()].sort((a,b)=>a.time-b.time);
}

function historicalChange(candles, index) {
  const old = candles[index - 24], now = candles[index];
  if (!old || old.close <= 0) return 0;
  return ((now.close / old.close) - 1) * 100;
}

function closeTrade(position, rawPrice, reason, time, config) {
  const dir = position.direction;
  const exitFill = rawPrice * (1 - dir * config.slippage);
  const grossR = dir * (exitFill - position.entry) / position.risk;
  const feeR = config.fee * (position.entry + exitFill) / position.risk;
  position.realizedR += position.remaining * (grossR - feeR);
  position.remaining = 0;
  position.exitTime = time;
  position.exitReason = reason;
  return position;
}

export function repriceSignalForExecution(signal, fillPrice) {
  const direction = signal?.side === "LONG" ? 1 : signal?.side === "SHORT" ? -1 : 0;
  const originalRisk = direction === 1 ? signal.entry - signal.stop : signal.stop - signal.entry;
  const executionRisk = direction === 1 ? fillPrice - signal.stop : signal.stop - fillPrice;
  if (!direction || !(originalRisk > 0) || !(executionRisk > 0) || !Number.isFinite(fillPrice)) return null;
  const oldTargets = [signal.target1, signal.target2, signal.target3];
  const multiples = oldTargets.map((target, index) =>
    Number.isFinite(target) ? direction * (target - signal.entry) / originalRisk : [1.5, 2.2, 3][index]
  );
  if (multiples.some(r => !Number.isFinite(r) || r <= 0)) return null;
  const targets = multiples.map(r => fillPrice + direction * executionRisk * r);
  return { ...signal, entry: fillPrice, target1: targets[0], target2: targets[1], target3: targets[2] };
}

export function simulateTrade({ side, entry, stop, targets, candles, startIndex, fee = 0.0005, slippage = 0.0003, maxHoldBars = 72 }) {
  const direction = side === "LONG" ? 1 : -1;
  const risk = direction === 1 ? entry - stop : stop - entry;
  if (!(risk > 0) || !Number.isFinite(risk)) throw new Error("Invalid trade risk");
  const position = { side, entry, stop, risk, direction, remaining: 1, realizedR: 0, targetHits: 0, exitTime: null, exitReason: null };
  const config = { fee, slippage };
  const endIndex = Math.min(candles.length - 1, startIndex + maxHoldBars);
  for (let i = startIndex; i <= endIndex && position.remaining > 0; i++) {
    const bar = candles[i];
    const stopGap = direction === 1 ? bar.open <= stop : bar.open >= stop;
    const stopTouched = direction === 1 ? bar.low <= stop : bar.high >= stop;
    if (stopGap || stopTouched) {
      closeTrade(position, stopGap ? bar.open : stop, "STOP", bar.time, config);
      break;
    }
    for (let t = 0; t < targets.length && position.remaining > 0; t++) {
      const target = targets[t];
      if (target == null) continue;
      const touched = direction === 1 ? bar.high >= target : bar.low <= target;
      if (!touched) break;
      const weight = TARGET_WEIGHTS[t];
      const exitFill = target * (1 - direction * slippage);
      const grossR = direction * (exitFill - entry) / risk;
      const feeR = fee * (entry + exitFill) / risk;
      position.realizedR += weight * (grossR - feeR);
      position.remaining -= weight;
      position.targetHits++;
      targets[t] = null;
    }
    if (position.remaining <= 1e-9) {
      position.remaining = 0; position.exitTime = bar.time; position.exitReason = "TARGETS"; break;
    }
    if (i === endIndex) closeTrade(position, bar.close, "TIME_EXIT", bar.time, config);
  }
  if (position.remaining > 0) closeTrade(position, candles[endIndex].close, "TIME_EXIT", candles[endIndex].time, config);
  return {
    side, entry, stop, risk, netR: position.realizedR, targetHits: position.targetHits,
    exitReason: position.exitReason, entryTime: candles[startIndex].time, exitTime: position.exitTime
  };
}

function summarize(trades) {
  const wins = trades.filter(t => t.netR > 0), losses = trades.filter(t => t.netR < 0);
  const grossWin = wins.reduce((s,t)=>s+t.netR,0), grossLoss = Math.abs(losses.reduce((s,t)=>s+t.netR,0));
  let equity = 0, peak = 0, maxDrawdown = 0;
  for (const trade of trades) { equity += trade.netR; peak = Math.max(peak,equity); maxDrawdown = Math.max(maxDrawdown,peak-equity); }
  return {
    trades: trades.length, wins: wins.length, losses: losses.length,
    breakeven: trades.length-wins.length-losses.length,
    winRatePct: trades.length ? wins.length/trades.length*100 : 0,
    netR: trades.reduce((s,t)=>s+t.netR,0),
    expectancyR: trades.length ? trades.reduce((s,t)=>s+t.netR,0)/trades.length : 0,
    profitFactor: grossLoss ? grossWin/grossLoss : grossWin ? null : 0,
    maxDrawdownR: maxDrawdown,
    averageDurationHours: trades.length ? trades.reduce((s,t)=>s+Math.max(0,t.exitTime-t.entryTime+FIFTEEN_MINUTES)/HOUR,0)/trades.length : 0,
    targetHits: trades.reduce((s,t)=>s+t.targetHits,0)
  };
}

async function backtestSymbol(ticker, fromMs, toMs, testStartMs) {
  const [oneHour,fourHour,fifteenMin] = await Promise.all([
    fetchHistoricalCandlesInChunks(ticker.symbol,"1h",fromMs,toMs,HOUR),
    fetchHistoricalCandlesInChunks(ticker.symbol,"4h",fromMs,toMs,FOUR_HOURS),
    fetchHistoricalCandlesInChunks(ticker.symbol,"15m",fromMs,toMs,FIFTEEN_MINUTES)
  ]);
  if (oneHour.length < FUTURES_CONFIG.MIN_CANDLES || fourHour.length < FUTURES_CONFIG.MIN_CANDLES ||
      fifteenMin.length < 4 * FUTURES_CONFIG.MIN_CANDLES) {
    throw new Error(ticker.symbol + ": insufficient historical candles (1h=" + oneHour.length +
      ", 4h=" + fourHour.length + ", 15m=" + fifteenMin.length + ")");
  }

  const strategyResults = {};
  for (const directionMode of DIRECTION_MODES) {
    const trades = [];
    let nextAvailableIndex = 0;
    for (let i=0;i<fifteenMin.length-1;i++) {
      if (i<nextAvailableIndex) continue;
      const signalBar=fifteenMin[i], signalCloseTime=signalBar.time+FIFTEEN_MINUTES;
      if (signalCloseTime < testStartMs) continue;
      const closed1h=oneHour.filter(c=>c.time+HOUR<=signalCloseTime);
      const closed4h=fourHour.filter(c=>c.time+FOUR_HOURS<=signalCloseTime);
      const closed15m=fifteenMin.slice(0,i+1);
      if (closed1h.length<FUTURES_CONFIG.MIN_CANDLES ||
          closed4h.length<FUTURES_CONFIG.MIN_CANDLES ||
          closed15m.length<4*FUTURES_CONFIG.MIN_CANDLES) continue;

      const tickerAtSignal={
        symbol:ticker.symbol,last:signalBar.close,quoteVolume:Number(ticker.volumeQuote)||0,
        priceChangePercent:historicalChange(closed1h,closed1h.length-1),premium:{lastFundingRate:null}
      };
      const signal=analyzeFuturesSymbol(tickerAtSignal,closed1h,closed4h,closed15m,{directionMode});
      if (!signal?.eligible) continue;

      // Execute no earlier than the next 15m candle open, with adverse slippage.
      const nextBar=fifteenMin[i+1];
      const direction=signal.side==="LONG"?1:-1;
      const fillPrice=nextBar.open*(1+direction*SLIPPAGE_PER_SIDE);
      if (Math.abs(fillPrice-signal.entry)/signal.entry*100 > FUTURES_CONFIG.MAX_ENTRY_DRIFT_PCT) continue;
      const executable=repriceSignalForExecution(signal,fillPrice);
      if (!executable) continue;
      const executionEconomics=calculateTradeEconomics(executable);
      if (!qualifyTradeEconomics(executionEconomics).eligible) continue;

      const tradeCandles=fifteenMin.slice(i+1,Math.min(fifteenMin.length,i+1+MAX_HOLD_BARS+1));
      if (!tradeCandles.length) continue;
      const trade=simulateTrade({
        side:executable.side,entry:executable.entry,stop:executable.stop,
        targets:[executable.target1,executable.target2,executable.target3],
        candles:tradeCandles,startIndex:0,fee:FEE_PER_SIDE,slippage:SLIPPAGE_PER_SIDE,
        maxHoldBars:MAX_HOLD_BARS
      });
      trade.symbol=ticker.symbol; trade.score=signal.score; trade.signalTime=signalBar.time;
      trades.push(trade);
      const exitIndex=fifteenMin.findIndex(c=>c.time===trade.exitTime);
      nextAvailableIndex=Math.max(i+2,exitIndex+1);
    }
    strategyResults[directionMode]={trades,metrics:summarize(trades)};
  }
  return {
    symbol:ticker.symbol,candles1h:oneHour.length,candles4h:fourHour.length,candles15m:fifteenMin.length,
    strategies:Object.fromEntries(Object.entries(strategyResults).map(([mode,result])=>[mode,{metrics:result.metrics}])),
    strategyTrades:strategyResults
  };
}
async function main() {
  const endMs=Date.now(), startMs=endMs-DAYS*24*HOUR, fromMs=startMs-15*24*HOUR;
  const tickerData=await getJson(BASE+"/derivatives/api/v3/tickers");
  if (!Array.isArray(tickerData?.tickers)) throw new Error("Kraken tickers response invalid");
  const universe=tickerData.tickers.filter(t=>t?.tag==="perpetual"&&t.suspended!==true&&
    /^(PI|PF)_[A-Z0-9]+USD$/.test(String(t.symbol||""))&&
    Number(t.volumeQuote)>=FUTURES_CONFIG.MIN_QUOTE_VOLUME&&Number(t.last)>0)
    .sort((a,b)=>Number(b.volumeQuote)-Number(a.volumeQuote)).slice(0,SYMBOL_LIMIT);
  if (!universe.length) throw new Error("No eligible Kraken perpetual contracts found");
  const results=[];
  for (const ticker of universe) {
    try { results.push(await backtestSymbol(ticker,fromMs,endMs,startMs)); }
    catch(error) { results.push({symbol:ticker.symbol,error:error.message,trades:[],metrics:summarize([])}); }
  }
  const combinedTrades=results.flatMap(r=>r.strategyTrades?.BOTH?.trades||[]).sort((a,b)=>a.entryTime-b.entryTime);
  const directionalSummary=Object.fromEntries(DIRECTION_MODES.map(mode=>[
    mode,summarize(results.flatMap(r=>r.strategyTrades?.[mode]?.trades||[]).sort((a,b)=>a.entryTime-b.entryTime))
  ]));
  const report={
    generatedAt:new Date().toISOString(),venue:"Kraken Derivatives public historical candles",
    period:{from:new Date(startMs).toISOString(),to:new Date(endMs).toISOString(),days:DAYS},
    settings:{
      symbolsRequested:SYMBOL_LIMIT,symbolsTested:results.filter(r=>!r.error).length,
      feePerSidePct:FEE_PER_SIDE*100,slippagePerSidePct:SLIPPAGE_PER_SIDE*100,
      maxHoldHours:MAX_HOLD_HOURS,maxHoldBars:MAX_HOLD_BARS,scanCadenceApproximation:"15m close then next 15m open; production cron runs every 5m",targetWeightsPct:[20,20,60],
      sameCandleStopTargetRule:"stop first (conservative)",
      entryRule:"signal evaluated only with candles closed by each 15m close; next 15m candle open with adverse slippage; stop and targets recalculated from executable fill",
      funding:"excluded (historical funding series not included)",
      signalUses:"walk-forward historical 4h/1h/15m closed candles; signal livePrice uses the just-closed 15m close; no future candle data; current top-volume universe only"
    },
    overall:directionalSummary.BOTH,
    directionalComparison:directionalSummary,
    symbols:results.map(({strategyTrades,...rest})=>({...rest,strategies:rest.strategies})),
    trades:combinedTrades
  };
  await mkdir("artifacts",{recursive:true});
  await writeFile("artifacts/kraken-futures-backtest.json",JSON.stringify(report,null,2));
  const lines=[
    "# Kraken Futures — Walk-forward Directional Backtest","",
    ...DIRECTION_MODES.flatMap(mode=>[
      "## "+mode,
      "Trades: "+directionalSummary[mode].trades,
      "Win rate: "+directionalSummary[mode].winRatePct.toFixed(2)+"%",
      "Net result: "+directionalSummary[mode].netR.toFixed(2)+"R",
      "Expectancy: "+directionalSummary[mode].expectancyR.toFixed(3)+"R/trade",
      "Profit factor: "+(directionalSummary[mode].profitFactor===null?"n/a":directionalSummary[mode].profitFactor.toFixed(2)),
      "Max drawdown: "+directionalSummary[mode].maxDrawdownR.toFixed(2)+"R",
      "Average duration: "+directionalSummary[mode].averageDurationHours.toFixed(2)+" hours",""
    ]),
    "Period: "+report.period.from+" to "+report.period.to+" ("+DAYS+" days)",
    "Symbols successfully tested: "+report.settings.symbolsTested+"/"+SYMBOL_LIMIT,
    "Trades: "+report.overall.trades,
    "Win rate: "+report.overall.winRatePct.toFixed(2)+"%",
    "Net result: "+report.overall.netR.toFixed(2)+"R",
    "Expectancy: "+report.overall.expectancyR.toFixed(3)+"R/trade",
    "Profit factor: "+(report.overall.profitFactor===null?"n/a":report.overall.profitFactor.toFixed(2)),
    "Max drawdown: "+report.overall.maxDrawdownR.toFixed(2)+"R",
    "Average duration: "+report.overall.averageDurationHours.toFixed(2)+" hours","",
    "Costs assumed: "+(FEE_PER_SIDE*100).toFixed(3)+"% fee + "+(SLIPPAGE_PER_SIDE*100).toFixed(3)+"% slippage per side.",
    "Partial exits: 20% at 1.5R, 20% at 2.2R, 60% at 3R. Same-candle stop/target ambiguity is resolved as stop first.",
    "Signal scan approximation: 15m close then next 15m open; production cron runs every 5m.",
    "Historical funding is excluded. Simplified price-based simulation; not a live-fill or profitability guarantee.","",
    "| Symbol | 1h candles | 4h candles | Trades | Win rate | Net R | Expectancy | Max DD | Error |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---|",
    ...results.map(r=>"| "+r.symbol+" | "+(r.candles1h||0)+" | "+(r.candles4h||0)+" | "+(r.strategies?.BOTH?.metrics.trades||0)+" | "+(r.strategies?.BOTH?.metrics.winRatePct||0).toFixed(1)+"% | "+(r.strategies?.BOTH?.metrics.netR||0).toFixed(2)+" | "+(r.strategies?.BOTH?.metrics.expectancyR||0).toFixed(3)+" | "+(r.strategies?.BOTH?.metrics.maxDrawdownR||0).toFixed(2)+" | "+(r.error||"").replaceAll("|","/")+" |")
  ];
  await writeFile("artifacts/kraken-futures-backtest.md",lines.join("\n"));
  console.log(JSON.stringify({ok:true,overall:report.overall,symbols:report.symbols,artifacts:["artifacts/kraken-futures-backtest.json","artifacts/kraken-futures-backtest.md"]},null,2));
}

if (process.argv[1] && import.meta.url === new URL("file://" + process.argv[1]).href) {
  main().catch(error=>{console.error(error);process.exitCode=1;});
}

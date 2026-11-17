import { analyzeFuturesSymbol, FUTURES_CONFIG } from "../src/index.js";
import { mkdir, writeFile } from "node:fs/promises";
import { simulateManagedTrade, summarizeManagementComparison } from "../src/futures-management-backtest.js";

const BASE = "https://futures.kraken.com";
const HOUR = 60 * 60 * 1000;
const FOUR_HOURS = 4 * HOUR;
const FIFTEEN_MINUTES = 15 * 60 * 1000;
const DAYS = Math.max(15, Math.min(180, Number(process.env.BACKTEST_DAYS || 30)));
const SYMBOL_LIMIT = Math.max(1, Math.min(5, Number(process.env.BACKTEST_SYMBOLS || 3)));
const FEE_PER_SIDE = Math.max(0, Number(process.env.BACKTEST_FEE || 0.0005));
const SLIPPAGE_PER_SIDE = Math.max(0, Number(process.env.BACKTEST_SLIPPAGE || 0.0003));
const MAX_HOLD_HOURS = 72;
const TARGET_WEIGHTS = [0.40, 0.35, 0.25];

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
  // Kraken's chart endpoint caps practical responses around 2,000 candles.
  // Fetch bounded, overlapping chunks so 90-day 1h history is complete.
  const chunkSpan = 1800 * intervalMs;
  const rows = [];
  for (let cursor = fromMs; cursor < toMs; cursor += chunkSpan) {
    const chunkEnd = Math.min(toMs, cursor + chunkSpan);
    const url = new URL(BASE + "/api/charts/v1/trade/" + encodeURIComponent(symbol) + "/" + resolution);
    url.searchParams.set("from", String(Math.floor(cursor / 1000)));
    url.searchParams.set("to", String(Math.floor(chunkEnd / 1000)));
    url.searchParams.set("count", "2000");
    const data = await getJson(url);
    if (data.more_candles === true) {
      throw new Error(symbol + " " + resolution + ": Kraken returned more than 2,000 candles for a chunk.");
    }
    if (Array.isArray(data.candles)) rows.push(...data.candles);
  }
  return normalizeCandles(rows, intervalMs);
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

export function simulateTrade({ side, entry, stop, targets, candles, startIndex, fee = 0.0005, slippage = 0.0003, maxHoldHours = 72 }) {
  const direction = side === "LONG" ? 1 : -1;
  const risk = direction === 1 ? entry - stop : stop - entry;
  if (!(risk > 0) || !Number.isFinite(risk)) throw new Error("Invalid trade risk");
  const position = { side, entry, stop, risk, direction, remaining: 1, realizedR: 0, targetHits: 0, exitTime: null, exitReason: null };
  const config = { fee, slippage };
  const endIndex = Math.min(candles.length - 1, startIndex + maxHoldHours);
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
      const weight = [0.40, 0.35, 0.25][t];
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
    maxDrawdownR: maxDrawdown, targetHits: trades.reduce((s,t)=>s+t.targetHits,0)
  };
}

async function backtestSymbol(ticker, fromMs, toMs) {
  const [oneHour,fourHour,fifteenMin] = await Promise.all([
    fetchHistoricalCandles(ticker.symbol,"1h",fromMs,toMs,HOUR),
    fetchHistoricalCandles(ticker.symbol,"4h",fromMs,toMs,FOUR_HOURS),
    fetchHistoricalCandles(ticker.symbol,"15m",fromMs,toMs,FIFTEEN_MINUTES)
  ]);
  if (oneHour.length < 100 || fourHour.length < 30 || fifteenMin.length < 40) {
    throw new Error(ticker.symbol + ": insufficient historical candles (1h=" + oneHour.length + ", 4h=" + fourHour.length + ", 15m=" + fifteenMin.length + ")");
  }
  const trades = [], managedTrades = [];
  let nextAvailableIndex = 60, lastClosed15mIndex = 0;
  for (let i=60;i<oneHour.length-1;i++) {
    if (i<nextAvailableIndex) continue;
    const signalBar=oneHour[i], signalCloseTime=signalBar.time+HOUR;
    const closed4h=fourHour.filter(c=>c.time+FOUR_HOURS<=signalCloseTime).slice(-120);
    while (lastClosed15mIndex < fifteenMin.length &&
      fifteenMin[lastClosed15mIndex].time + FIFTEEN_MINUTES <= signalCloseTime) lastClosed15mIndex++;
    const closed15m=fifteenMin.slice(Math.max(0,lastClosed15mIndex-120),lastClosed15mIndex);
    if (closed4h.length<30 || closed15m.length<40) continue;
    const nextBar=oneHour[i+1];
    const historical1h=oneHour.slice(Math.max(0,i+1-120),i+1);
    const entry15mIndex=lastClosed15mIndex;
    const entry15mBar=fifteenMin[entry15mIndex];
    // The signal is evaluated only after the 1h, 4h and final 15m candles close.
    // Entry is the first 15m candle opening at that signal-close timestamp.
    if (!entry15mBar || entry15mBar.time !== signalCloseTime) continue;
    const tickerAtSignal={
      symbol:ticker.symbol,last:entry15mBar.open,quoteVolume:Number(ticker.volumeQuote)||0,
      priceChangePercent:historicalChange(oneHour,i),premium:{lastFundingRate:null}
    };
    const first=analyzeFuturesSymbol(tickerAtSignal,historical1h,closed4h,closed15m);
    if (!first?.eligible) continue;
    const direction=first.side==="LONG"?1:-1;
    tickerAtSignal.last=entry15mBar.open*(1+direction*SLIPPAGE_PER_SIDE);
    const confirmed=analyzeFuturesSymbol(tickerAtSignal,historical1h,closed4h,closed15m);
    if (!confirmed?.eligible) continue;
    const executionEntry = entry15mBar.open * (1 + direction * SLIPPAGE_PER_SIDE);
    const executionStop = confirmed.stop;
    const executionRisk = direction===1 ? executionEntry-executionStop : executionStop-executionEntry;
    if (!(executionRisk>0)) continue;
    const targets=[1.5,2.2,3].map(r=>executionEntry+direction*executionRisk*r);
    const tradeCandles=fifteenMin.slice(entry15mIndex,Math.min(fifteenMin.length,entry15mIndex+MAX_HOLD_HOURS*4+1));
    const setup = {
      side:confirmed.side,entry:executionEntry,stop:executionStop,
      targets,candles:tradeCandles,startIndex:0,fee:FEE_PER_SIDE,slippage:SLIPPAGE_PER_SIDE,maxHoldHours:MAX_HOLD_HOURS*4
    };
    const trade=simulateTrade({...setup,targets:[...setup.targets]});
    const managed=simulateManagedTrade({...setup,targets:[...setup.targets]});
    trade.symbol=ticker.symbol; trade.score=confirmed.score; trade.signalTime=signalBar.time;
    managed.symbol=ticker.symbol; managed.score=confirmed.score; managed.signalTime=signalBar.time;
    trades.push(trade); managedTrades.push(managed);
    const exitTime=trade.exitTime;
    const exitIndex=oneHour.findIndex(c=>c.time<=exitTime && c.time+HOUR>exitTime);

    nextAvailableIndex=Math.max(i+2,exitIndex+1);
  }
  return {symbol:ticker.symbol,candles1h:oneHour.length,candles4h:fourHour.length,trades,managedTrades,metrics:summarize(trades),managementMetrics:summarizeManagementComparison(managedTrades)};
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
    try { results.push(await backtestSymbol(ticker,fromMs,endMs)); }
    catch(error) { results.push({symbol:ticker.symbol,error:error.message,trades:[],managedTrades:[],metrics:summarize([]),managementMetrics:summarizeManagementComparison([])}); }
  }
  const allTrades=results.flatMap(r=>r.trades||[]).sort((a,b)=>a.entryTime-b.entryTime);
  const allManagedTrades=results.flatMap(r=>r.managedTrades||[]).sort((a,b)=>a.entryTime-b.entryTime);
  // Exploratory filter grid; select on the first two-thirds and report the final
  // third separately as an untouched chronological holdout.
  const validationStart=startMs + (toMs-startMs)*2/3;
  const filterExperiments=[];
  for (const minScore of [80,90]) for (const minRiskPct of [0,0.30,0.40,0.50,0.60,0.75,1.00]) {
    const keep=t=>t.score>=minScore && (t.risk/t.entry*100)>=minRiskPct;
    const split=(rows,from,to)=>rows.filter(t=>t.entryTime>=from && t.entryTime<to && keep(t));
    const trainBase=split(allTrades,startMs,validationStart);
    const testBase=split(allTrades,validationStart,toMs);
    const trainManaged=split(allManagedTrades,startMs,validationStart);
    const testManaged=split(allManagedTrades,validationStart,toMs);
    filterExperiments.push({
      minScore,minRiskPct,
      train:{baseline:summarize(trainBase),managed:summarizeManagementComparison(trainManaged)},
      holdout:{baseline:summarize(testBase),managed:summarizeManagementComparison(testManaged)}
    });
  }
  const report={
    generatedAt:new Date().toISOString(),venue:"Kraken Derivatives public historical candles",
    period:{from:new Date(startMs).toISOString(),to:new Date(endMs).toISOString(),days:DAYS},
    settings:{
      symbolsRequested:SYMBOL_LIMIT,symbolsTested:results.filter(r=>!r.error).length,
      feePerSidePct:FEE_PER_SIDE*100,slippagePerSidePct:SLIPPAGE_PER_SIDE*100,
      maxHoldHours:MAX_HOLD_HOURS,targetWeightsPct:[40,35,25],executionTimeframe:"15m",
      sameCandleStopTargetRule:"stop first (conservative)",\n      chronologicalSplit:"first 2/3 exploratory; final 1/3 holdout",
      entryRule:"first 15m candle open after confirmed 1h/4h/15m close, adverse slippage applied",
      funding:"excluded (historical funding series not included)",
      comparison:"Both exit models use identical signals and entries; managed model retains the same 40/35/25 targets and adds conservative staged stops.",
      signalUses:"historical 1h/4h/15m closed candles; 24h change derived from historical bars; 15m execution and exits; no current funding or future candle data"
    },
    baseline:{name:"Current 40/35/25 target exits",metrics:summarize(allTrades)},
    stagedManagement:{name:"40/35/25 targets plus staged protective stops",metrics:summarizeManagementComparison(allManagedTrades)},\n    filterExperiments,
    symbols:results.map(({trades,managedTrades,...rest})=>rest),
    trades:allTrades,
    managedTrades:allManagedTrades
  };
  await mkdir("artifacts",{recursive:true});
  await writeFile("artifacts/kraken-futures-backtest.json",JSON.stringify(report,null,2));
  const lines=[
    "# Kraken Futures v3.9.0 — Historical Backtest","",
    "Period: "+report.period.from+" to "+report.period.to+" ("+DAYS+" days)",
    "Symbols successfully tested: "+report.settings.symbolsTested+"/"+SYMBOL_LIMIT,
    "COMPARISON — same entries and same historical candles",
    "Baseline: "+JSON.stringify(report.baseline.metrics),
    "Staged management: "+JSON.stringify(report.stagedManagement.metrics),"",
    "Costs assumed: "+(FEE_PER_SIDE*100).toFixed(3)+"% fee + "+(SLIPPAGE_PER_SIDE*100).toFixed(3)+"% slippage per side.",
    "Partial exits: 40% at 1.5R, 35% at 2.2R, 25% at 3R. Same-candle stop/target ambiguity is resolved as stop first.",
    "Historical funding is excluded. Simplified price-based simulation; not a live-fill or profitability guarantee.","",\n    "Filter experiments: each score/risk threshold is selected on the first 2/3 only; final 1/3 is chronological holdout.",\n    ...filterExperiments.map(x=>"score >= "+x.minScore+", risk >= "+x.minRiskPct.toFixed(2)+"% | train n="+x.train.baseline.trades+" netR="+x.train.baseline.netR.toFixed(2)+" PF="+x.train.baseline.profitFactor.toFixed(2)+" | holdout n="+x.holdout.baseline.trades+" netR="+x.holdout.baseline.netR.toFixed(2)+" PF="+x.holdout.baseline.profitFactor.toFixed(2)),\n    "",
    "| Symbol | Trades | Baseline Net R | Managed Net R | Baseline DD | Managed DD | Error |",
    "|---|---:|---:|---:|---:|---:|---|",
    ...results.map(r=>"| "+r.symbol+" | "+r.metrics.trades+" | "+r.metrics.netR.toFixed(2)+" | "+r.managementMetrics.netR.toFixed(2)+" | "+r.metrics.maxDrawdownR.toFixed(2)+" | "+r.managementMetrics.maxDrawdownR.toFixed(2)+" | "+(r.error||"").replaceAll("|","/")+" |")
  ];
  await writeFile("artifacts/kraken-futures-backtest.md",lines.join("\n"));
  console.log(JSON.stringify({ok:true,overall:report.overall,symbols:report.symbols,artifacts:["artifacts/kraken-futures-backtest.json","artifacts/kraken-futures-backtest.md"]},null,2));
}

if (process.argv[1] && import.meta.url === new URL("file://" + process.argv[1]).href) {
  main().catch(error=>{console.error(error);process.exitCode=1;});
}

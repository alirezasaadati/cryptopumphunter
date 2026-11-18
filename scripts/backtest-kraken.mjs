import { analyzeFuturesSymbol, FUTURES_CONFIG } from "../src/index.js";
import { passesVolumeThreshold, isLateEntry, hasPullbackOrBreakout } from "../src/futures-entry-experiments.js";
import { mkdir, writeFile } from "node:fs/promises";

const BASE = "https://futures.kraken.com";
const HOUR = 60 * 60 * 1000;
const FOUR_HOURS = 4 * HOUR;
const DAYS = Math.max(15, Math.min(90, Number(process.env.BACKTEST_DAYS || 30)));
const SYMBOL_LIMIT = Math.max(1, Math.min(5, Number(process.env.BACKTEST_SYMBOLS || 5)));
const FEE_PER_SIDE = Math.max(0, Number(process.env.BACKTEST_FEE || 0.0005));
const SLIPPAGE_PER_SIDE = Math.max(0, Number(process.env.BACKTEST_SLIPPAGE || 0.0003));
const MAX_HOLD_HOURS = 72;
const TARGET_WEIGHTS = [0.40, 0.35, 0.25];
const VARIANTS = [
  { id: "baseline", label: "Current engine baseline", minVolumeRatio: 0.75 },
  { id: "volume_1_2x", label: "Volume minimum 1.2x", minVolumeRatio: 1.20 },
  { id: "volume_1_5x", label: "Volume minimum 1.5x", minVolumeRatio: 1.50 },
  { id: "pullback_or_breakout", label: "Pullback or confirmed breakout", minVolumeRatio: 0.75, requireSetup: true },
  { id: "avoid_late_entry", label: "Avoid late entries", minVolumeRatio: 0.75, avoidLate: true },
  { id: "combined_1_2x_quality", label: "1.2x volume + entry quality", minVolumeRatio: 1.20, requireSetup: true, avoidLate: true }
];

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

function compareSignalTiming(baselineTrades, candidateTrades, maxDelayHours = 24) {
  const baseline = [...baselineTrades].filter(t => Number.isFinite(Number(t.signalTime)))
    .sort((a,b) => a.signalTime - b.signalTime);
  const candidates = [...candidateTrades].filter(t => Number.isFinite(Number(t.signalTime)))
    .sort((a,b) => a.signalTime - b.signalTime);
  const used = new Set();
  const delays = [];
  let unmatched = 0;
  for (const base of baseline) {
    const index = candidates.findIndex((candidate, i) =>
      !used.has(i) && candidate.symbol === base.symbol && candidate.side === base.side &&
      candidate.signalTime >= base.signalTime &&
      candidate.signalTime <= base.signalTime + maxDelayHours * HOUR
    );
    if (index < 0) { unmatched++; continue; }
    used.add(index);
    delays.push((candidates[index].signalTime - base.signalTime) / HOUR);
  }
  const sorted = [...delays].sort((a,b)=>a-b);
  const median = sorted.length
    ? (sorted.length % 2 ? sorted[(sorted.length-1)/2] : (sorted[sorted.length/2-1]+sorted[sorted.length/2])/2)
    : null;
  return {
    baselineSignals: baseline.length,
    candidateSignals: candidates.length,
    matchedWithin24h: delays.length,
    unmatchedWithin24h: unmatched,
    averageDelayHours: delays.length ? delays.reduce((s,x)=>s+x,0)/delays.length : null,
    medianDelayHours: median,
    delayedOver1h: delays.filter(x=>x>1).length
  };
}

async function backtestSymbol(ticker, fromMs, toMs, variant) {
  const [oneHour,fourHour] = await Promise.all([
    fetchHistoricalCandles(ticker.symbol,"1h",fromMs,toMs,HOUR),
    fetchHistoricalCandles(ticker.symbol,"4h",fromMs,toMs,FOUR_HOURS)
  ]);
  if (oneHour.length < 100 || fourHour.length < FUTURES_CONFIG.MIN_CANDLES) throw new Error(ticker.symbol + ": insufficient historical candles (1h=" + oneHour.length + ", 4h=" + fourHour.length + ")");
  const trades = [];
  let nextAvailableIndex = 60;
  for (let i=60;i<oneHour.length-1;i++) {
    if (i<nextAvailableIndex) continue;
    const signalBar=oneHour[i], signalCloseTime=signalBar.time+HOUR;
    const closed4h=fourHour.filter(c=>c.time+FOUR_HOURS<=signalCloseTime);
    if (closed4h.length<FUTURES_CONFIG.MIN_CANDLES) continue;
    const nextBar=oneHour[i+1];
    const tickerAtSignal={
      symbol:ticker.symbol,last:signalBar.close,quoteVolume:Number(ticker.volumeQuote)||0,
      priceChangePercent:historicalChange(oneHour,i),premium:{lastFundingRate:null}
    };
    const signal=analyzeFuturesSymbol(tickerAtSignal,oneHour.slice(0,i+1),closed4h);
    if (!signal?.eligible) continue;
    if (!passesVolumeThreshold(signal.volumeRatio, variant.minVolumeRatio)) continue;
    const signalCandles = oneHour.slice(0,i+1);
    if (variant.avoidLate && isLateEntry({
      side:signal.side,entry:signal.entry,ema20:signal.ema20,atr:signal.atr
    })) continue;
    if (variant.requireSetup && !hasPullbackOrBreakout({
      side:signal.side,candles:signalCandles,ema20:signal.ema20,atr:signal.atr,lookback:20
    })) continue;
    const direction=signal.side==="LONG"?1:-1;
    const actualEntry=nextBar.open*(1+direction*SLIPPAGE_PER_SIDE);
    const validFillGeometry=signal.side==="LONG"
      ? signal.stop<actualEntry&&actualEntry<signal.target1
      : signal.stop>actualEntry&&actualEntry>signal.target1;
    if (!validFillGeometry) continue;
    const entryIndex=i+1;
    const tradeCandles=oneHour.slice(entryIndex,Math.min(oneHour.length,entryIndex+MAX_HOLD_HOURS+1));
    const trade=simulateTrade({
      side:signal.side,entry:actualEntry,stop:signal.stop,
      targets:[signal.target1,signal.target2,signal.target3],
      candles:tradeCandles,startIndex:0,fee:FEE_PER_SIDE,slippage:SLIPPAGE_PER_SIDE,maxHoldHours:MAX_HOLD_HOURS
    });
    trade.symbol=ticker.symbol; trade.score=signal.score; trade.signalTime=signalBar.time;
    trade.signalEntry=signal.entry; trade.entryGapPct=(actualEntry-signal.entry)/signal.entry*100;
    trades.push(trade);
    const exitIndex=oneHour.findIndex(c=>c.time===trade.exitTime);
    nextAvailableIndex=Math.max(entryIndex+1,exitIndex+1);
  }
  return {symbol:ticker.symbol,candles1h:oneHour.length,candles4h:fourHour.length,trades,metrics:summarize(trades)};
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

  const variantResults=[];
  for (const variant of VARIANTS) {
    const results=[];
    for (const ticker of universe) {
      try { results.push(await backtestSymbol(ticker,fromMs,endMs,variant)); }
      catch(error) { results.push({symbol:ticker.symbol,error:error.message,trades:[],metrics:summarize([])}); }
    }
    const allTrades=results.flatMap(r=>r.trades||[]).sort((a,b)=>a.entryTime-b.entryTime);
    variantResults.push({
      variant:{id:variant.id,label:variant.label,minVolumeRatio:variant.minVolumeRatio,
        requireSetup:Boolean(variant.requireSetup),avoidLate:Boolean(variant.avoidLate)},
      overall:summarize(allTrades),
      symbols:results.map(({trades,...rest})=>rest),
      trades:allTrades
    });
  }
  const baseline=variantResults.find(x=>x.variant.id==="baseline");
  const variantSummaries=variantResults.map(({trades,...rest})=>({
    ...rest,
    timing:compareSignalTiming(baseline?.trades||[],trades,24)
  }));
  const report={
    generatedAt:new Date().toISOString(),venue:"Kraken Derivatives public historical candles",
    period:{from:new Date(startMs).toISOString(),to:new Date(endMs).toISOString(),days:DAYS},
    settings:{
      symbolsRequested:SYMBOL_LIMIT,symbolsTested:universe.length,
      feePerSidePct:FEE_PER_SIDE*100,slippagePerSidePct:SLIPPAGE_PER_SIDE*100,
      maxHoldHours:MAX_HOLD_HOURS,targetWeightsPct:[40,35,25],
      sameCandleStopTargetRule:"stop first (conservative)",
      entryRule:"next 1h candle open plus adverse slippage; original signal stop/target prices remain unchanged",
      exitLogic:"unchanged existing stop, target levels, weights and stop-first ambiguity handling",
      funding:"excluded (historical funding series not included)",
      signalUses:"historical 1h/4h closed candles; 24h change derived from historical bars; no current funding or future candle data",
      note:"All variants reuse analyzeFuturesSymbol's existing stop/target outputs and the same trade simulator. Only entry eligibility gates vary."
    },
    variants:variantSummaries,
    variantTrades:variantResults.map(x=>({id:x.variant.id,trades:x.trades}))
  };
  await mkdir("artifacts",{recursive:true});
  await writeFile("artifacts/kraken-entry-volume-experiments.json",JSON.stringify(report,null,2));
  const lines=[
    "# Kraken Futures — Volume and Entry Quality Experiments","",
    "Period: "+report.period.from+" to "+report.period.to+" ("+DAYS+" days)",
    "Symbols tested: "+universe.length+"/"+SYMBOL_LIMIT,
    "Costs: "+(FEE_PER_SIDE*100).toFixed(3)+"% fee + "+(SLIPPAGE_PER_SIDE*100).toFixed(3)+"% slippage per side.",
    "Exit logic: unchanged existing stop/target outputs and simulator.","",
    "| Variant | Trades | Win rate | Net R | Expectancy | PF | Max DD | Avg delay (h) | Matched / baseline |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|",
    ...variantResults.map((x,i)=>{
      const timing=variantSummaries[i].timing;
      return "| "+x.variant.id+" | "+x.overall.trades+" | "+x.overall.winRatePct.toFixed(2)+"% | "+x.overall.netR.toFixed(2)+" | "+x.overall.expectancyR.toFixed(3)+" | "+(x.overall.profitFactor===null?"n/a":x.overall.profitFactor.toFixed(2))+" | "+x.overall.maxDrawdownR.toFixed(2)+" | "+(timing.averageDelayHours===null?"n/a":timing.averageDelayHours.toFixed(2))+" | "+timing.matchedWithin24h+"/"+timing.baselineSignals+" |";
    }),
    "",
    "This is a historical simulation, not a live-fill guarantee. Historical funding is excluded."
  ];
  await writeFile("artifacts/kraken-entry-volume-experiments.md",lines.join("\n"));
  console.log(JSON.stringify({
    ok:true,period:report.period,
    variants:variantResults.map(x=>({id:x.variant.id,overall:x.overall,symbols:x.symbols})),
    artifacts:["artifacts/kraken-entry-volume-experiments.json","artifacts/kraken-entry-volume-experiments.md"]
  },null,2));
}

if (process.argv[1] && import.meta.url === new URL("file://" + process.argv[1]).href) {
  main().catch(error=>{console.error(error);process.exitCode=1;});
}

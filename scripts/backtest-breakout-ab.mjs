import { analyzeFuturesSymbol, FUTURES_CONFIG } from "../src/index.js";
import { mkdir, writeFile } from "node:fs/promises";

const BASE = "https://futures.kraken.com";
const HOUR = 60 * 60 * 1000;
const FOUR_HOURS = 4 * HOUR;
const FIFTEEN_MINUTES = 15 * 60 * 1000;
const DAYS = Math.max(15, Math.min(90, Number(process.env.BACKTEST_DAYS || 30)));
const SYMBOL_LIMIT = Math.max(1, Math.min(24, Number(process.env.BACKTEST_SYMBOLS || 5)));
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
  const marginProfitPrice = entry * (1 + direction * 0.02); // 20% on 10x margin = 2% favorable underlying move
  let hit20PctMarginBeforeStop = false;
  let hit20PctMarginTime = null;
  let maxFavorablePctBeforeStop = 0;
  for (let i = startIndex; i <= endIndex && position.remaining > 0; i++) {
    const bar = candles[i];
    const stopGap = direction === 1 ? bar.open <= stop : bar.open >= stop;
    const stopTouched = direction === 1 ? bar.low <= stop : bar.high >= stop;
    // Conservative intrabar ordering: if stop and +2% threshold occur in the same candle,
    // count the stop first and do not count the 20%-margin profit threshold.
    if (stopGap || stopTouched) {
      closeTrade(position, stopGap ? bar.open : stop, "STOP", bar.time, config);
      break;
    }
    const favorablePct = direction === 1
      ? (bar.high / entry - 1) * 100
      : (entry / bar.low - 1) * 100;
    maxFavorablePctBeforeStop = Math.max(maxFavorablePctBeforeStop, favorablePct);
    const profitThresholdTouched = direction === 1 ? bar.high >= marginProfitPrice : bar.low <= marginProfitPrice;
    if (!hit20PctMarginBeforeStop && profitThresholdTouched) {
      hit20PctMarginBeforeStop = true;
      hit20PctMarginTime = bar.time;
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
    hit20PctMarginBeforeStop, hit20PctMarginTime, maxFavorablePctBeforeStop,
    exitReason: position.exitReason, entryTime: candles[startIndex].time, exitTime: position.exitTime
  };
}

function sideMetrics(trades) {
  const wins = trades.filter(t => t.netR > 0), losses = trades.filter(t => t.netR < 0);
  const grossWin = wins.reduce((sum,t)=>sum+t.netR,0);
  const grossLoss = Math.abs(losses.reduce((sum,t)=>sum+t.netR,0));
  return {
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRatePct: trades.length ? wins.length / trades.length * 100 : 0,
    netR: trades.reduce((sum,t)=>sum+t.netR,0),
    expectancyR: trades.length ? trades.reduce((sum,t)=>sum+t.netR,0) / trades.length : 0,
    profitFactor: grossLoss ? grossWin / grossLoss : grossWin ? null : 0
  };
}

function summarize(trades) {
  const wins = trades.filter(t => t.netR > 0), losses = trades.filter(t => t.netR < 0);
  const grossWin = wins.reduce((s,t)=>s+t.netR,0), grossLoss = Math.abs(losses.reduce((s,t)=>s+t.netR,0));
  let equity = 0, peak = 0, maxDrawdown = 0;
  for (const trade of trades) { equity += trade.netR; peak = Math.max(peak,equity); maxDrawdown = Math.max(maxDrawdown,peak-equity); }
  return {
    trades: trades.length, wins: wins.length, losses: losses.length,
    anyTpHit: trades.filter(t=>t.targetHits>0).length,
    hit20PctMarginBeforeStop: trades.filter(t=>t.hit20PctMarginBeforeStop).length,
    hit20PctMarginBeforeStopPct: trades.length ? trades.filter(t=>t.hit20PctMarginBeforeStop).length / trades.length * 100 : 0,
    totalStops: trades.filter(t=>t.exitReason==="STOP").length,
    tp1Hit: trades.filter(t=>t.targetHits>=1).length,
    tp2Hit: trades.filter(t=>t.targetHits>=2).length,
    tp3Hit: trades.filter(t=>t.targetHits>=3).length,
    stopBeforeAnyTp: trades.filter(t=>t.exitReason==="STOP"&&t.targetHits===0).length,
    stopAfterTp: trades.filter(t=>t.exitReason==="STOP"&&t.targetHits>0).length,
    timeExitWithoutTp: trades.filter(t=>t.exitReason==="TIME_EXIT"&&t.targetHits===0).length,
    breakeven: trades.length-wins.length-losses.length,
    winRatePct: trades.length ? wins.length/trades.length*100 : 0,
    netR: trades.reduce((s,t)=>s+t.netR,0),
    expectancyR: trades.length ? trades.reduce((s,t)=>s+t.netR,0)/trades.length : 0,
    profitFactor: grossLoss ? grossWin/grossLoss : grossWin ? null : 0,
    maxDrawdownR: maxDrawdown, targetHits: trades.reduce((s,t)=>s+t.targetHits,0),
    bySide: {
      LONG: sideMetrics(trades.filter(t=>t.side==="LONG")),
      SHORT: sideMetrics(trades.filter(t=>t.side==="SHORT"))
    }
  };
}

async function backtestSymbol(ticker, fromMs, toMs) {
  const [oneHour,fourHour,fifteenMinute] = await Promise.all([
    fetchHistoricalCandles(ticker.symbol,"1h",fromMs,toMs,HOUR),
    fetchHistoricalCandles(ticker.symbol,"4h",fromMs,toMs,FOUR_HOURS),
    fetchHistoricalCandles(ticker.symbol,"15m",fromMs,toMs,FIFTEEN_MINUTES)
  ]);
  if (oneHour.length < 100 || fourHour.length < FUTURES_CONFIG.MIN_CANDLES || fifteenMinute.length < 120) {
    throw new Error(ticker.symbol + ": insufficient historical candles (1h=" + oneHour.length + ", 4h=" + fourHour.length + ", 15m=" + fifteenMinute.length + ")");
  }
  const strategies = {
    withBreakout: { trades: [], signals: 0, valid: 0, risky: 0 },
    withoutBreakout: { trades: [], signals: 0, valid: 0, risky: 0 }
  };
  const nextAvailable = { withBreakout: 60, withoutBreakout: 60 };
  let fifteenIndex = 0;
  for (let i=60;i<oneHour.length-1;i++) {
    const signalBar=oneHour[i], signalCloseTime=signalBar.time+HOUR;
    const closed4h=fourHour.filter(c=>c.time+FOUR_HOURS<=signalCloseTime);
    if (closed4h.length<FUTURES_CONFIG.MIN_CANDLES) continue;
    while (fifteenIndex < fifteenMinute.length && fifteenMinute[fifteenIndex].time + FIFTEEN_MINUTES <= signalCloseTime) fifteenIndex++;
    const closed15m=fifteenMinute.slice(Math.max(0,fifteenIndex-120),fifteenIndex);
    const nextBar=oneHour[i+1];
    const tickerAtSignal={
      symbol:ticker.symbol,last:nextBar.open,quoteVolume:Number(ticker.volumeQuote)||0,
      priceChangePercent:historicalChange(oneHour,i),premium:{lastFundingRate:null}
    };
    for (const mode of ["withBreakout","withoutBreakout"]) {
      const state=strategies[mode];
      const candidate = mode === "withoutBreakout"
        ? analyzeFuturesSymbol(tickerAtSignal,oneHour.slice(0,i+1),closed4h,closed15m,{skipBreakoutFilter:true})
        : analyzeFuturesSymbol(tickerAtSignal,oneHour.slice(0,i+1),closed4h,closed15m);
      if (!candidate || (!candidate.eligible && !candidate.experimentalEligible)) {
        
        continue;
      }
      // Count every hourly signal opportunity before applying trade-overlap rules.
      // This makes baseline/current signal frequency directly comparable at identical timestamps.
      state.signals++;
      if (candidate.eligible) state.valid++; else state.risky++;
      if (i < nextAvailable[mode]) continue;
      const direction=candidate.side==="LONG"?1:-1;
      const entry = candidate.entry * (1 + direction * SLIPPAGE_PER_SIDE);
      const tradeCandles=oneHour.slice(i+1,Math.min(oneHour.length,i+1+MAX_HOLD_HOURS+1));
      const trade=simulateTrade({
        side:candidate.side,entry,stop:candidate.stop,
        targets:[candidate.target1,candidate.target2,candidate.target3],
        candles:tradeCandles,startIndex:0,fee:FEE_PER_SIDE,slippage:SLIPPAGE_PER_SIDE,maxHoldHours:MAX_HOLD_HOURS
      });
      trade.symbol=ticker.symbol; trade.score=candidate.score; trade.signalTime=signalBar.time;
      trade.entryModel="next_1h_open";
      state.trades.push(trade);
      const exitIndex=oneHour.findIndex(c=>c.time===trade.exitTime);
      nextAvailable[mode]=Math.max(i+1,exitIndex+1);
    }
  }
  return {
    symbol:ticker.symbol,candles1h:oneHour.length,candles4h:fourHour.length,candles15m:fifteenMinute.length,
    withBreakout:{signals:strategies.withBreakout.signals,valid:strategies.withBreakout.valid,risky:strategies.withBreakout.risky,metrics:summarize(strategies.withBreakout.trades)},
    withoutBreakout:{signals:strategies.withoutBreakout.signals,valid:strategies.withoutBreakout.valid,risky:strategies.withoutBreakout.risky,metrics:summarize(strategies.withoutBreakout.trades)},
    trades:{withBreakout:strategies.withBreakout.trades,withoutBreakout:strategies.withoutBreakout.trades}
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
    try { results.push(await backtestSymbol(ticker,fromMs,endMs)); }
    catch(error) { results.push({symbol:ticker.symbol,error:error.message,withBreakout:{signals:0,metrics:summarize([])},withoutBreakout:{signals:0,metrics:summarize([])}}); }
  }
  const allWith=results.flatMap(r=>r.trades?.withBreakout||[]).sort((a,b)=>a.entryTime-b.entryTime);
  const allWithout=results.flatMap(r=>r.trades?.withoutBreakout||[]).sort((a,b)=>a.entryTime-b.entryTime);
  const sum=(mode,key)=>results.reduce((n,r)=>n+Number(r[mode]?.[key]||0),0);
  const report={
    generatedAt:new Date().toISOString(),venue:"Kraken Derivatives public historical candles",
    period:{from:new Date(startMs).toISOString(),to:new Date(endMs).toISOString(),days:DAYS},
    settings:{symbolsRequested:SYMBOL_LIMIT,symbolsTested:results.filter(r=>!r.error).length,feePerSidePct:FEE_PER_SIDE*100,
      slippagePerSidePct:SLIPPAGE_PER_SIDE*100,maxHoldHours:MAX_HOLD_HOURS,targetWeightsPct:[40,35,25],
      sameCandleStopTargetRule:"stop first (conservative)",funding:"excluded",
      entryModel:"next 1h candle open with adverse slippage, identical in both arms",
      onlyDifference:"skipBreakoutFilter=true in withoutBreakout arm; every other engine filter and setting unchanged",
      universe:"top current Kraken perpetuals by current quote volume; survivorship/universe bias applies"},
    withBreakout:{signals:sum("withBreakout","signals"),valid:sum("withBreakout","valid"),risky:sum("withBreakout","risky"),metrics:summarize(allWith)},
    withoutBreakout:{signals:sum("withoutBreakout","signals"),valid:sum("withoutBreakout","valid"),risky:sum("withoutBreakout","risky"),metrics:summarize(allWithout)},
    signalCountChangePct:sum("withBreakout","signals")?((sum("withoutBreakout","signals")/sum("withBreakout","signals"))-1)*100:0,
    symbols:results.map(({trades,...r})=>r),trades:{withBreakout:allWith,withoutBreakout:allWithout}
  };
  await mkdir("artifacts",{recursive:true});
  await writeFile("artifacts/kraken-futures-backtest-comparison.json",JSON.stringify(report,null,2));
  const lines=[
    "# Kraken Futures — 0.3% breakout filter A/B comparison","",
    "Period: "+report.period.from+" to "+report.period.to+" ("+DAYS+" days)",
    "Symbols successfully tested: "+report.settings.symbolsTested+"/"+SYMBOL_LIMIT,"",
    "| Metric | With 0.3% filter | Without 0.3% filter |",
    "|---|---:|---:|",
    "| Signals | "+report.withBreakout.signals+" | "+report.withoutBreakout.signals+" |",
    "| Valid signals | "+report.withBreakout.valid+" | "+report.withoutBreakout.valid+" |",
    "| Risky signals | "+report.withBreakout.risky+" | "+report.withoutBreakout.risky+" |",
    "| Executed non-overlapping trades | "+report.withBreakout.metrics.trades+" | "+report.withoutBreakout.metrics.trades+" |",
    "| Trades that hit any TP (TP1/TP2/TP3) | "+report.withBreakout.metrics.anyTpHit+" | "+report.withoutBreakout.metrics.anyTpHit+" |",
    "| Reached +20% on 10x margin (2% favorable move) before stop | "+report.withBreakout.metrics.hit20PctMarginBeforeStop+" ("+report.withBreakout.metrics.hit20PctMarginBeforeStopPct.toFixed(2)+"%) | "+report.withoutBreakout.metrics.hit20PctMarginBeforeStop+" ("+report.withoutBreakout.metrics.hit20PctMarginBeforeStopPct.toFixed(2)+"%) |",
    "| TP1 hit | "+report.withBreakout.metrics.tp1Hit+" | "+report.withoutBreakout.metrics.tp1Hit+" |",
    "| TP2 hit | "+report.withBreakout.metrics.tp2Hit+" | "+report.withoutBreakout.metrics.tp2Hit+" |",
    "| TP3 hit | "+report.withBreakout.metrics.tp3Hit+" | "+report.withoutBreakout.metrics.tp3Hit+" |",
    "| Total trades that hit stop | "+report.withBreakout.metrics.totalStops+" | "+report.withoutBreakout.metrics.totalStops+" |",
    "| Stop before any TP | "+report.withBreakout.metrics.stopBeforeAnyTp+" | "+report.withoutBreakout.metrics.stopBeforeAnyTp+" |",
    "| Stop after partial TP | "+report.withBreakout.metrics.stopAfterTp+" | "+report.withoutBreakout.metrics.stopAfterTp+" |",
    "| Time exit without TP | "+report.withBreakout.metrics.timeExitWithoutTp+" | "+report.withoutBreakout.metrics.timeExitWithoutTp+" |",
    "| Win rate | "+report.withBreakout.metrics.winRatePct.toFixed(2)+"% | "+report.withoutBreakout.metrics.winRatePct.toFixed(2)+"% |",
    "| Expectancy | "+report.withBreakout.metrics.expectancyR.toFixed(3)+"R | "+report.withoutBreakout.metrics.expectancyR.toFixed(3)+"R |",
    "| Profit factor | "+(report.withBreakout.metrics.profitFactor??"n/a")+" | "+(report.withoutBreakout.metrics.profitFactor??"n/a")+" |",
    "| Net R | "+report.withBreakout.metrics.netR.toFixed(2)+"R | "+report.withoutBreakout.metrics.netR.toFixed(2)+"R |",
    "| Max drawdown | "+report.withBreakout.metrics.maxDrawdownR.toFixed(2)+"R | "+report.withoutBreakout.metrics.maxDrawdownR.toFixed(2)+"R |",
    
    "| Signal count change | — | "+report.signalCountChangePct.toFixed(2)+"% |","",
    "Assumptions: 0.05% fee and 0.03% slippage per side; 72h maximum hold; 40/35/25 partial exits; stop-first same-candle ambiguity. A trade is counted as TP-hit if any target was touched; STOP before TP is reported separately.",
    "Funding excluded. Current universe is selected using present-day volume and therefore has survivorship/universe bias. This is a comparative simulation, not a guarantee of live fills.","",
    "| Symbol | With-filter signals | Without-filter signals | Change | With-filter trades | Without-filter trades |",
    "|---|---:|---:|---:|---:|---:|",
    ...results.map(r=>"| "+r.symbol+" | "+(r.withBreakout?.signals||0)+" | "+(r.withoutBreakout?.signals||0)+" | "+((r.withoutBreakout?.signals||0)-(r.withBreakout?.signals||0))+" | "+(r.withBreakout?.metrics?.trades||0)+" | "+(r.withoutBreakout?.metrics?.trades||0)+" |")
  ];
  await writeFile("artifacts/kraken-futures-backtest-comparison.md",lines.join("\n"));
  console.log(JSON.stringify({ok:true,withBreakout:report.withBreakout,withoutBreakout:report.withoutBreakout,signalCountChangePct:report.signalCountChangePct,symbols:report.symbols},null,2));
}
if (process.argv[1] && import.meta.url === new URL("file://" + process.argv[1]).href) {
  main().catch(error=>{console.error(error);process.exitCode=1;});
}

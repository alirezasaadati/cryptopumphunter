import { analyzeFuturesSymbol, FUTURES_CONFIG } from "../src/index.js";
import { mkdir, writeFile } from "node:fs/promises";

const BASE = "https://futures.kraken.com";
const HOUR = 60 * 60 * 1000;
const FOUR_HOURS = 4 * HOUR;
const FIFTEEN_MINUTES = 15 * 60 * 1000;
const ONE_MINUTE = 60 * 1000;
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

async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({length: Math.min(limit, items.length)}, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      try { results[index] = await mapper(items[index], index); }
      catch (error) { results[index] = { error: error.message }; }
    }
  });
  await Promise.all(workers);
  return results;
}

function excursionForWindow(trade, candles, minutes) {
  const cutoff = trade.entryTime + minutes * 60 * 1000;
  const bars = candles.filter(c => c.time >= trade.entryTime && c.time < cutoff);
  if (!bars.length) return null;
  const high = Math.max(...bars.map(c => c.high));
  const low = Math.min(...bars.map(c => c.low));
  const favorable = trade.side === "LONG" ? high - trade.entry : trade.entry - low;
  const adverse = trade.side === "LONG" ? trade.entry - low : high - trade.entry;
  return {
    bars: bars.length,
    mfeR: Math.max(0, favorable / trade.risk),
    maeR: Math.max(0, adverse / trade.risk),
    mfePct: Math.max(0, favorable / trade.entry * 100),
    maePct: Math.max(0, adverse / trade.entry * 100)
  };
}

function summarizeExcursions(trades) {
  const windows = [1,5,15,30,60];
  const summarizeValues = values => {
    const sorted = values.filter(Number.isFinite).sort((a,b)=>a-b);
    if (!sorted.length) return {count:0,mean:null,median:null,p75:null,max:null};
    const at = p => sorted[Math.min(sorted.length-1,Math.ceil(sorted.length*p)-1)];
    return {count:sorted.length,mean:sorted.reduce((a,b)=>a+b,0)/sorted.length,median:at(0.5),p75:at(0.75),max:sorted[sorted.length-1]};
  };
  return Object.fromEntries(windows.map(minutes => {
    const rows = trades.map(t => t.excursions?.[minutes]).filter(Boolean);
    return [minutes + "m", {
      sample: rows.length,
      maeR: summarizeValues(rows.map(x=>x.maeR)),
      mfeR: summarizeValues(rows.map(x=>x.mfeR)),
      adverseAtLeast025R: rows.filter(x=>x.maeR>=0.25).length,
      adverseAtLeast05R: rows.filter(x=>x.maeR>=0.5).length,
      favorableAtLeast025R: rows.filter(x=>x.mfeR>=0.25).length
    }];
  }));
}

async function addMinuteExcursions(trades) {
  const requests = trades.map((trade,index)=>({trade,index}));
  const rows = await mapLimit(requests, 5, async ({trade,index}) => {
    const candles = await fetchHistoricalCandles(trade.symbol, "1m", trade.entryTime, trade.entryTime + 61 * ONE_MINUTE, ONE_MINUTE);
    if (!candles.length) throw new Error("No 1m candles returned");
    const excursions = Object.fromEntries([1,5,15,30,60].map(m => [m, excursionForWindow(trade,candles,m)]));
    let firstPositive = null, firstNegative = null, ambiguousThresholdMinute = false;
    for (const bar of candles) {
      const positive = trade.side === "LONG"
        ? bar.high >= trade.entry + 0.25 * trade.risk
        : bar.low <= trade.entry - 0.25 * trade.risk;
      const negative = trade.side === "LONG"
        ? bar.low <= trade.entry - 0.25 * trade.risk
        : bar.high >= trade.entry + 0.25 * trade.risk;
      if (positive && negative) ambiguousThresholdMinute = true;
      if (positive && firstPositive === null) firstPositive = Math.max(0,(bar.time-trade.entryTime)/60000);
      if (negative && firstNegative === null) firstNegative = Math.max(0,(bar.time-trade.entryTime)/60000);
    }
    return {index,excursions,firstPositive025RMinute:firstPositive,firstNegative025RMinute:firstNegative,ambiguousThresholdMinute,candleCount:candles.length};
  });
  let successful = 0;
  for (const row of rows) {
    if (row.error) continue;
    const trade = trades[row.index];
    Object.assign(trade,{excursions:row.excursions,firstPositive025RMinute:row.firstPositive025RMinute,
      firstNegative025RMinute:row.firstNegative025RMinute,ambiguousThresholdMinute:row.ambiguousThresholdMinute,
      minuteCandlesLoaded:row.candleCount});
    successful++;
  }
  const failed = rows.map((r,i)=>r.error?{symbol:trades[i].symbol,entryTime:new Date(trades[i].entryTime).toISOString(),error:r.error}:null).filter(Boolean);
  return {requested:trades.length,loaded:successful,failed};
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
  const position = { side, entry, stop, risk, direction, remaining: 1, realizedR: 0, targetHits: 0, target1Hit: false, target2Hit: false, target3Hit: false, exitTime: null, exitReason: null };
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
      if (t === 0) position.target1Hit = true;
      if (t === 1) position.target2Hit = true;
      if (t === 2) position.target3Hit = true;
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
    target1Hit: position.target1Hit, target2Hit: position.target2Hit, target3Hit: position.target3Hit,
    exitReason: position.exitReason, entryTime: candles[startIndex].time, exitTime: position.exitTime
  };
}

function sideMetrics(trades) {
  const wins = trades.filter(t => t.netR > 0), losses = trades.filter(t => t.netR < 0);
  const grossWin = wins.reduce((sum,t)=>sum+t.netR,0);
  const grossLoss = Math.abs(losses.reduce((sum,t)=>sum+t.netR,0));
  return {
    trades: trades.length,
    tp1Trades: trades.filter(t => t.target1Hit).length,
    tp2Trades: trades.filter(t => t.target2Hit).length,
    tp3Trades: trades.filter(t => t.target3Hit).length,
    stopAfterTp1Trades: trades.filter(t => t.target1Hit && t.exitReason === "STOP").length,
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
    breakeven: trades.length-wins.length-losses.length,
    tp1Trades: trades.filter(t => t.target1Hit).length,
    tp2Trades: trades.filter(t => t.target2Hit).length,
    tp3Trades: trades.filter(t => t.target3Hit).length,
    stopAfterTp1Trades: trades.filter(t => t.target1Hit && t.exitReason === "STOP").length,
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
    baseline: { trades: [], signals: 0, valid: 0, risky: 0, rejected: 0, rejectReasons: {} },
    current: { trades: [], signals: 0, valid: 0, risky: 0, rejected: 0, rejectReasons: {} }
  };
  const nextAvailable = { baseline: 60, current: 60 };
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
    for (const mode of ["baseline","current"]) {
      const state=strategies[mode];
      const candidate = mode === "baseline"
        ? analyzeFuturesSymbol(tickerAtSignal,oneHour.slice(0,i+1),closed4h,closed15m,{skipEntryFilters:true})
        : analyzeFuturesSymbol(tickerAtSignal,oneHour.slice(0,i+1),closed4h,closed15m);
      if (!candidate || (!candidate.eligible && !candidate.experimentalEligible)) {
        if (mode === "current" && candidate?.rejected &&
            /قیمت لحظه‌ای|ورود دیرهنگام|حرکت تأییدی/.test(candidate.rejected)) {
          state.rejected++;
          state.rejectReasons[candidate.rejected]=(state.rejectReasons[candidate.rejected]||0)+1;
        }
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
      trade.entryModel=mode === "baseline" ? "last_1h_close" : "next_1h_open";
      state.trades.push(trade);
      const exitIndex=oneHour.findIndex(c=>c.time===trade.exitTime);
      nextAvailable[mode]=Math.max(i+1,exitIndex+1);
    }
  }
  return {
    symbol:ticker.symbol,candles1h:oneHour.length,candles4h:fourHour.length,candles15m:fifteenMinute.length,
    baseline:{signals:strategies.baseline.signals,valid:strategies.baseline.valid,risky:strategies.baseline.risky,metrics:summarize(strategies.baseline.trades)},
    current:{signals:strategies.current.signals,valid:strategies.current.valid,risky:strategies.current.risky,rejected:strategies.current.rejected,rejectReasons:strategies.current.rejectReasons,metrics:summarize(strategies.current.trades)},
    trades:{baseline:strategies.baseline.trades,current:strategies.current.trades}
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
    catch(error) { results.push({symbol:ticker.symbol,error:error.message,baseline:{signals:0,metrics:summarize([])},current:{signals:0,metrics:summarize([])}}); }
  }
  const allBaseline=results.flatMap(r=>r.trades?.baseline||[]).sort((a,b)=>a.entryTime-b.entryTime);
  const allCurrent=results.flatMap(r=>r.trades?.current||[]).sort((a,b)=>a.entryTime-b.entryTime);
  const minuteDataStatus = await addMinuteExcursions(allCurrent);
  const excursionAnalysis = {
    dataStatus: minuteDataStatus,
    all: summarizeExcursions(allCurrent),
    bySide: {
      LONG: summarizeExcursions(allCurrent.filter(t=>t.side==="LONG")),
      SHORT: summarizeExcursions(allCurrent.filter(t=>t.side==="SHORT"))
    },
    byTp1Outcome: {
      touchedTP1: summarizeExcursions(allCurrent.filter(t=>t.target1Hit)),
      neverTouchedTP1: summarizeExcursions(allCurrent.filter(t=>!t.target1Hit))
    },
    thresholdTiming: {
      firstPositive025R: {
        reached: allCurrent.filter(t=>t.firstPositive025RMinute!==null && t.firstPositive025RMinute!==undefined).length,
        medianMinute: (()=>{const v=allCurrent.map(t=>t.firstPositive025RMinute).filter(Number.isFinite).sort((a,b)=>a-b);return v.length?v[Math.floor(v.length/2)]:null;})()
      },
      firstNegative025R: {
        reached: allCurrent.filter(t=>t.firstNegative025RMinute!==null && t.firstNegative025RMinute!==undefined).length,
        medianMinute: (()=>{const v=allCurrent.map(t=>t.firstNegative025RMinute).filter(Number.isFinite).sort((a,b)=>a-b);return v.length?v[Math.floor(v.length/2)]:null;})()
      },
      ambiguousMinuteBars: allCurrent.filter(t=>t.ambiguousThresholdMinute).length
    }
  };
  const sum=(mode,key)=>results.reduce((n,r)=>n+Number(r[mode]?.[key]||0),0);
  const report={
    generatedAt:new Date().toISOString(),venue:"Kraken Derivatives public historical candles",
    period:{from:new Date(startMs).toISOString(),to:new Date(endMs).toISOString(),days:DAYS},
    settings:{symbolsRequested:SYMBOL_LIMIT,symbolsTested:results.filter(r=>!r.error).length,feePerSidePct:FEE_PER_SIDE*100,
      slippagePerSidePct:SLIPPAGE_PER_SIDE*100,maxHoldHours:MAX_HOLD_HOURS,targetWeightsPct:[40,35,25],
      sameCandleStopTargetRule:"stop first (conservative)",funding:"excluded",
      baselineEntry:"signal candle close",currentEntry:"next 1h candle open, adverse slippage applied",
      currentFilters:"0.35% live/reference drift; 1.25 ATR max distance to 1h EMA20; 1.25 ATR max 15m reclaim extension; 15m momentum/pullback advisory only",
      universe:"top current Kraken perpetuals by current quote volume; survivorship/universe bias applies"},
    baseline:{signals:sum("baseline","signals"),valid:sum("baseline","valid"),risky:sum("baseline","risky"),metrics:summarize(allBaseline)},
    current:{signals:sum("current","signals"),valid:sum("current","valid"),risky:sum("current","risky"),rejected:sum("current","rejected"),metrics:summarize(allCurrent)},
    minuteExcursions: excursionAnalysis,
    signalCountChangePct:sum("baseline","signals")?((sum("current","signals")/sum("baseline","signals"))-1)*100:0,
    symbols:results.map(({trades,...r})=>r),trades:{baseline:allBaseline,current:allCurrent}
  };
  await mkdir("artifacts",{recursive:true});
  await writeFile("artifacts/kraken-futures-backtest-comparison.json",JSON.stringify(report,null,2));
  const lines=[
    "# Kraken Futures — baseline vs current entry filters","",
    "Period: "+report.period.from+" to "+report.period.to+" ("+DAYS+" days)",
    "Symbols successfully tested: "+report.settings.symbolsTested+"/"+SYMBOL_LIMIT,"",
    "| Metric | Baseline | Current |",
    "|---|---:|---:|",
    "| Signals | "+report.baseline.signals+" | "+report.current.signals+" |",
    "| Valid signals | "+report.baseline.valid+" | "+report.current.valid+" |",
    "| Risky signals | "+report.baseline.risky+" | "+report.current.risky+" |",
    "| Executed non-overlapping trades | "+report.baseline.metrics.trades+" | "+report.current.metrics.trades+" |",
    "| Trades that touched TP1 (includes TP2/TP3) | "+report.baseline.metrics.tp1Trades+" | "+report.current.metrics.tp1Trades+" |",
    "| Trades that touched TP2 (includes TP3) | "+report.baseline.metrics.tp2Trades+" | "+report.current.metrics.tp2Trades+" |",
    "| Trades that touched TP3 | "+report.baseline.metrics.tp3Trades+" | "+report.current.metrics.tp3Trades+" |",
    "| TP1 then later stopped out | "+report.baseline.metrics.stopAfterTp1Trades+" | "+report.current.metrics.stopAfterTp1Trades+" |",
    "| Win rate | "+report.baseline.metrics.winRatePct.toFixed(2)+"% | "+report.current.metrics.winRatePct.toFixed(2)+"% |",
    "| Expectancy | "+report.baseline.metrics.expectancyR.toFixed(3)+"R | "+report.current.metrics.expectancyR.toFixed(3)+"R |",
    "| Profit factor | "+(report.baseline.metrics.profitFactor??"n/a")+" | "+(report.current.metrics.profitFactor??"n/a")+" |",
    "| Net R | "+report.baseline.metrics.netR.toFixed(2)+"R | "+report.current.metrics.netR.toFixed(2)+"R |",
    "| Max drawdown | "+report.baseline.metrics.maxDrawdownR.toFixed(2)+"R | "+report.current.metrics.maxDrawdownR.toFixed(2)+"R |",
    "| Current filter rejections | — | "+report.current.rejected+" |",
    "| Signal count change | — | "+report.signalCountChangePct.toFixed(2)+"% |","",
    "Assumptions: 0.05% fee and 0.03% slippage per side; 72h maximum hold; 40/35/25 partial exits; stop-first same-candle ambiguity.",
    "Funding excluded. Current universe is selected using present-day volume and therefore has survivorship/universe bias. This is a comparative simulation, not a guarantee of live fills.","",
    "| Symbol | Baseline signals | Current signals | Change | Current valid | Current risky | Current rejected |",
    "|---|---:|---:|---:|---:|---:|---:|",
    ...results.map(r=>"| "+r.symbol+" | "+(r.baseline?.signals||0)+" | "+(r.current?.signals||0)+" | "+(((r.current?.signals||0)-(r.baseline?.signals||0)))+" | "+(r.current?.valid||0)+" | "+(r.current?.risky||0)+" | "+(r.current?.rejected||0)+" |")
  ];
  await writeFile("artifacts/kraken-futures-backtest-comparison.md",lines.join("\n"));
  console.log(JSON.stringify({ok:true,baseline:report.baseline,current:report.current,signalCountChangePct:report.signalCountChangePct,symbols:report.symbols},null,2));
}
if (process.argv[1] && import.meta.url === new URL("file://" + process.argv[1]).href) {
  main().catch(error=>{console.error(error);process.exitCode=1;});
}

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

async function backtestSymbol(ticker, fromMs, toMs, btcFourHourCandles) {
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
    current: { trades: [], signals: 0, valid: 0, risky: 0, rejected: 0, rejectReasons: {} },
    aligned: { trades: [], signals: 0, valid: 0, risky: 0, rejected: 0, rawCandidates: 0, rejectReasons: {} }
  };
  const nextAvailable = { baseline: 60, current: 60, aligned: 60 };
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
    const btcClosed4h = btcFourHourCandles.filter(c => c.time + FOUR_HOURS <= signalCloseTime);
    const btcTrend = btcClosed4h.length >= FUTURES_CONFIG.MIN_CANDLES ? (ema(btcClosed4h.map(c=>c.close),20) > ema(btcClosed4h.map(c=>c.close),50) ? "BULLISH" : ema(btcClosed4h.map(c=>c.close),20) < ema(btcClosed4h.map(c=>c.close),50) ? "BEARISH" : "NEUTRAL") : null;
    for (const mode of ["baseline","current","aligned"]) {
      const state=strategies[mode];
      const candidate = mode === "baseline"
        ? analyzeFuturesSymbol(tickerAtSignal,oneHour.slice(0,i+1),closed4h,closed15m,{skipEntryFilters:true})
        : analyzeFuturesSymbol(tickerAtSignal,oneHour.slice(0,i+1),closed4h,closed15m);
      if (mode === "aligned" && candidate && (candidate.eligible || candidate.experimentalEligible)) {
        state.rawCandidates++;
        const expected = candidate.side === "LONG" ? "BULLISH" : "BEARISH";
        if (!btcTrend || btcTrend !== expected || candidate.fourHourTrend !== expected) {
          state.rejected++;
          const reason = !btcTrend || btcTrend === "NEUTRAL" ? "BTC_4H_NEUTRAL_OR_MISSING" : btcTrend !== expected ? "BTC_4H_MISMATCH" : "SYMBOL_4H_MISMATCH";
          state.rejectReasons[reason] = (state.rejectReasons[reason] || 0) + 1;
          continue;
        }
      }
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
    aligned:{signals:strategies.aligned.signals,valid:strategies.aligned.valid,risky:strategies.aligned.risky,rejected:strategies.aligned.rejected,rawCandidates:strategies.aligned.rawCandidates,rejectReasons:strategies.aligned.rejectReasons,metrics:summarize(strategies.aligned.trades)},
    trades:{baseline:strategies.baseline.trades,current:strategies.current.trades,aligned:strategies.aligned.trades}
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
  const btcFourHourCandles = await fetchHistoricalCandles("PF_XBTUSD","4h",fromMs,endMs,FOUR_HOURS);
  if (btcFourHourCandles.length < FUTURES_CONFIG.MIN_CANDLES) throw new Error("Insufficient BTC 4h candles for mandatory alignment backtest");
  const results=[];
  for (const ticker of universe) {
    try { results.push(await backtestSymbol(ticker,fromMs,endMs,btcFourHourCandles)); }
    catch(error) { results.push({symbol:ticker.symbol,error:error.message,baseline:{signals:0,metrics:summarize([])},current:{signals:0,metrics:summarize([])}}); }
  }
  const allBaseline=results.flatMap(r=>r.trades?.baseline||[]).sort((a,b)=>a.entryTime-b.entryTime);
  const allCurrent=results.flatMap(r=>r.trades?.current||[]).sort((a,b)=>a.entryTime-b.entryTime);
  const allAligned=results.flatMap(r=>r.trades?.aligned||[]).sort((a,b)=>a.entryTime-b.entryTime);
  const sum=(mode,key)=>results.reduce((n,r)=>n+Number(r[mode]?.[key]||0),0);
  const report={
    generatedAt:new Date().toISOString(),venue:"Kraken Derivatives public historical candles",
    period:{from:new Date(startMs).toISOString(),to:new Date(endMs).toISOString(),days:DAYS},
    settings:{symbolsRequested:SYMBOL_LIMIT,symbolsTested:results.filter(r=>!r.error).length,btcAlignment:"mandatory BTC 4h EMA20/EMA50 and symbol 4h EMA20/EMA50 must both match candidate direction; neutral/missing BTC rejects",feePerSidePct:FEE_PER_SIDE*100,
      slippagePerSidePct:SLIPPAGE_PER_SIDE*100,maxHoldHours:MAX_HOLD_HOURS,targetWeightsPct:[40,35,25],
      sameCandleStopTargetRule:"stop first (conservative)",funding:"excluded",
      baselineEntry:"signal candle close",currentEntry:"next 1h candle open, adverse slippage applied",
      currentFilters:"0.35% live/reference drift; 1.25 ATR max distance to 1h EMA20; 1.25 ATR max 15m reclaim extension; 15m momentum/pullback advisory only",
      universe:"top current Kraken perpetuals by current quote volume; survivorship/universe bias applies"},
    baseline:{signals:sum("baseline","signals"),valid:sum("baseline","valid"),risky:sum("baseline","risky"),metrics:summarize(allBaseline)},
    current:{signals:sum("current","signals"),valid:sum("current","valid"),risky:sum("current","risky"),rejected:sum("current","rejected"),metrics:summarize(allCurrent)},
    aligned:{signals:sum("aligned","signals"),valid:sum("aligned","valid"),risky:sum("aligned","risky"),rejected:sum("aligned","rejected"),rawCandidates:sum("aligned","rawCandidates"),metrics:summarize(allAligned)},
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
    "| Win rate | "+report.baseline.metrics.winRatePct.toFixed(2)+"% | "+report.current.metrics.winRatePct.toFixed(2)+"% |",
    "| Expectancy | "+report.baseline.metrics.expectancyR.toFixed(3)+"R | "+report.current.metrics.expectancyR.toFixed(3)+"R |",
    "| Profit factor | "+(report.baseline.metrics.profitFactor??"n/a")+" | "+(report.current.metrics.profitFactor??"n/a")+" |",
    "| Net R | "+report.baseline.metrics.netR.toFixed(2)+"R | "+report.current.metrics.netR.toFixed(2)+"R |",
    "| Max drawdown | "+report.baseline.metrics.maxDrawdownR.toFixed(2)+"R | "+report.current.metrics.maxDrawdownR.toFixed(2)+"R |",
    "| Current filter rejections | — | "+report.current.rejected+" |",
    "| Aligned signals | — | "+report.aligned.signals+" |",
    "| Aligned executed trades | — | "+report.aligned.metrics.trades+" |",
    "| Aligned win rate | — | "+report.aligned.metrics.winRatePct.toFixed(2)+"% |",
    "| Aligned expectancy | — | "+report.aligned.metrics.expectancyR.toFixed(3)+"R |",
    "| Aligned profit factor | — | "+(report.aligned.metrics.profitFactor??"n/a")+" |",
    "| Aligned net R | — | "+report.aligned.metrics.netR.toFixed(2)+"R |",
    "| Alignment rejected | — | "+report.aligned.rejected+" |",
    "| Signal count change | — | "+report.signalCountChangePct.toFixed(2)+"% |","",
    "Assumptions: 0.05% fee and 0.03% slippage per side; 72h maximum hold; 40/35/25 partial exits; stop-first same-candle ambiguity.",
    "Funding excluded. Current universe is selected using present-day volume and therefore has survivorship/universe bias. This is a comparative simulation, not a guarantee of live fills.","",
    "| Symbol | Baseline signals | Current signals | Change | Current valid | Current risky | Current rejected |",
    "|---|---:|---:|---:|---:|---:|---:|",
    ...results.map(r=>"| "+r.symbol+" | "+(r.baseline?.signals||0)+" | "+(r.current?.signals||0)+" | "+(((r.current?.signals||0)-(r.baseline?.signals||0)))+" | "+(r.current?.valid||0)+" | "+(r.current?.risky||0)+" | "+(r.current?.rejected||0)+" |")
  ];
  await writeFile("artifacts/kraken-futures-backtest-comparison.md",lines.join("\n"));
  console.log(JSON.stringify({ok:true,baseline:report.baseline,current:report.current,aligned:report.aligned,signalCountChangePct:report.signalCountChangePct,symbols:report.symbols},null,2));
}
if (process.argv[1] && import.meta.url === new URL("file://" + process.argv[1]).href) {
  main().catch(error=>{console.error(error);process.exitCode=1;});
}

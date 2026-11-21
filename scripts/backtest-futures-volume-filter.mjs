import { mkdir, writeFile } from "node:fs/promises";
import { analyzeFuturesSymbol, FUTURES_CONFIG } from "../src/index.js";
import { evaluateTradeCandle, FUTURES_TRADE_LEVERAGE, FUTURES_MARGIN_PROFIT_TARGET_PERCENT } from "../src/futures-trade-lifecycle.js";

const BASE = "https://futures.kraken.com";
const INTERVALS = { "5m": 300000, "15m": 900000, "1h": 3600000, "4h": 14400000 };
const DAYS = Math.max(7, Math.min(60, Number(process.env.LIFECYCLE_BACKTEST_DAYS || 60)));
const SYMBOL_LIMIT = Math.max(1, Math.min(12, Number(process.env.LIFECYCLE_BACKTEST_SYMBOLS || 10)));
const WARMUP_DAYS = 15;
const TARGET = FUTURES_MARGIN_PROFIT_TARGET_PERCENT;
const LEVERAGE = FUTURES_TRADE_LEVERAGE;
const SHORT_MAX_VOLUME_RATIO = Math.max(0, Number(process.env.LIFECYCLE_SHORT_MAX_VOLUME_RATIO || 0));
const SHORT_MIN_ATR_PCT = Math.max(0, Number(process.env.LIFECYCLE_SHORT_MIN_ATR_PCT || 0));
const SHORT_MAX_EMA20_DISTANCE_PCT = Math.max(0, Number(process.env.LIFECYCLE_SHORT_MAX_EMA20_DISTANCE_PCT || 0));

async function getJson(url, attempt = 0) {
  const response = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(30000) });
  const body = await response.text();
  if (!response.ok) {
    if (attempt < 3 && (response.status === 429 || response.status >= 500)) {
      await new Promise(resolve => setTimeout(resolve, 800 * (attempt + 1)));
      return getJson(url, attempt + 1);
    }
    throw new Error("HTTP " + response.status + " for " + url + ": " + body.slice(0, 160));
  }
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
    Number.isFinite(c.time) && [c.open,c.high,c.low,c.close,c.volume].every(Number.isFinite) &&
    c.open > 0 && c.close > 0 && c.low > 0 && c.high >= c.low && c.volume >= 0 &&
    c.time + intervalMs <= Date.now()
  ).sort((a,b)=>a.time-b.time).filter(c => {
    if (seen.has(c.time)) return false;
    seen.add(c.time); return true;
  });
}

async function fetchHistoricalCandles(symbol, resolution, fromMs, toMs) {
  const intervalMs = INTERVALS[resolution];
  const chunkMs = intervalMs * 1700;
  const combined = [];
  for (let start = fromMs; start < toMs; start += chunkMs) {
    const end = Math.min(toMs, start + chunkMs);
    const url = new URL(BASE + "/api/charts/v1/trade/" + encodeURIComponent(symbol) + "/" + resolution);
    url.searchParams.set("from", String(Math.floor(start / 1000)));
    url.searchParams.set("to", String(Math.floor(end / 1000)));
    url.searchParams.set("count", "1800");
    const data = await getJson(url);
    if (data.more_candles === true) throw new Error(symbol + " " + resolution + ": incomplete chunk from Kraken");
    combined.push(...normalizeCandles(data.candles, intervalMs));
  }
  const byTime = new Map(combined.map(c => [c.time,c]));
  return [...byTime.values()].sort((a,b)=>a.time-b.time);
}

function emaValue(values, period) {
  if (values.length < period) return null;
  const multiplier = 2 / (period + 1);
  let value = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) value = values[i] * multiplier + value * (1 - multiplier);
  return value;
}
function signalDiagnostics(candidate, side, candles1h, candles4h) {
  const closes4h = candles4h.map(c => Number(c.close));
  const ema20_4h = emaValue(closes4h, 20), ema50_4h = emaValue(closes4h, 50);
  const last1h = candles1h.at(-1), price = Number(last1h.close);
  const up1h = Number(candidate.ema20) > Number(candidate.ema50) && price > Number(candidate.ema20);
  const down1h = Number(candidate.ema20) < Number(candidate.ema50) && price < Number(candidate.ema20);
  const up4h = Number.isFinite(ema20_4h) && Number.isFinite(ema50_4h) && ema20_4h > ema50_4h;
  const down4h = Number.isFinite(ema20_4h) && Number.isFinite(ema50_4h) && ema20_4h < ema50_4h;
  const trend1h = up1h ? "UP" : down1h ? "DOWN" : "MIXED";
  const trend4h = up4h ? "UP" : down4h ? "DOWN" : "MIXED";
  const aligned1h = side === "LONG" ? trend1h === "UP" : trend1h === "DOWN";
  const aligned4h = side === "LONG" ? trend4h === "UP" : trend4h === "DOWN";
  return {
    trend1h, trend4h, aligned1h, aligned4h, bothAligned: aligned1h && aligned4h,
    rsi: Number(candidate.rsi),
    ema20DistancePct: Number.isFinite(price) && Number(candidate.ema20) > 0 ? (price / Number(candidate.ema20) - 1) * 100 : null,
    atrPct: Number.isFinite(price) && price > 0 ? Number(candidate.atr) / price * 100 : null,
    volumeRatio: Number(candidate.volumeRatio)
  };
}
function historicalChange(candles, index) {
  const old = candles[index - 24], now = candles[index];
  return !old || old.close <= 0 ? 0 : ((now.close / old.close) - 1) * 100;
}
function lowerBound(candles, time) {
  let lo = 0, hi = candles.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (candles[mid].time < time) lo = mid + 1; else hi = mid; }
  return lo;
}
function candleAmbiguous(side, trade, candle) {
  const entry = Number(trade.entry), stop = Number(trade.currentStop ?? trade.initialStop ?? trade.stop);
  const target = side === "LONG" ? entry * (1 + TARGET / LEVERAGE / 100) : entry * (1 - TARGET / LEVERAGE / 100);
  const stopHit = side === "LONG" ? candle.low <= stop : candle.high >= stop;
  const profitHit = side === "LONG" ? candle.high >= target : candle.low <= target;
  const stopAtOpen = side === "LONG" ? candle.open <= stop : candle.open >= stop;
  const profitAtOpen = side === "LONG" ? candle.open >= target : candle.open <= target;
  return stopHit && profitHit && !stopAtOpen && !profitAtOpen;
}
function summarize(trades) {
  const closed = trades.filter(t => t.status === "CLOSED_PROFIT" || t.status === "CLOSED_STOP");
  const profits = closed.filter(t => t.status === "CLOSED_PROFIT");
  const stops = closed.filter(t => t.status === "CLOSED_STOP");
  let equity = 0, peak = 0, maxDrawdown = 0;
  for (const trade of [...closed].sort((a,b)=>a.closedAtMs-b.closedAtMs)) {
    equity += Number(trade.marginReturnPercent || 0);
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
  }
  const longs = closed.filter(t => t.side === "LONG");
  const shorts = closed.filter(t => t.side === "SHORT");
  const sum = xs => xs.reduce((n,t)=>n+Number(t.marginReturnPercent || 0),0);
  const stopLosses = stops.map(t => Math.abs(Number(t.marginReturnPercent || 0))).filter(Number.isFinite).sort((a,b)=>a-b);
  const percentile = (values, p) => values.length ? values[Math.min(values.length-1, Math.ceil(p*values.length)-1)] : null;
  const stopLossStats = {
    count: stopLosses.length,
    averageMarginLossPct: stopLosses.length ? stopLosses.reduce((a,b)=>a+b,0)/stopLosses.length : null,
    medianMarginLossPct: percentile(stopLosses,0.5),
    p90MarginLossPct: percentile(stopLosses,0.9),
    minMarginLossPct: stopLosses.length ? stopLosses[0] : null,
    maxMarginLossPct: stopLosses.length ? stopLosses.at(-1) : null,
    buckets: {
      under10: stopLosses.filter(x=>x<10).length,
      from10To20: stopLosses.filter(x=>x>=10&&x<20).length,
      from20To30: stopLosses.filter(x=>x>=20&&x<30).length,
      from30To50: stopLosses.filter(x=>x>=30&&x<50).length,
      from50To80: stopLosses.filter(x=>x>=50&&x<80).length,
      atLeast80: stopLosses.filter(x=>x>=80).length
    }
  };
  return {
    tradesStarted: trades.length,
    stopLossStats,
    closedTrades: closed.length,
    profitCloses: profits.length,
    stopCloses: stops.length,
    openAtEnd: trades.length - closed.length,
    longs: longs.length,
    shorts: shorts.length,
    winRatePct: closed.length ? profits.length / closed.length * 100 : 0,
    totalMarginReturnPct: sum(closed),
    averageMarginReturnPct: closed.length ? sum(closed) / closed.length : 0,
    maxDrawdownMarginPct: maxDrawdown,
    ambiguous5mCandles: trades.reduce((n,t)=>n+(t.ambiguousCandles || 0),0),
    bySide: {
      LONG: { trades: longs.length, profitCloses: longs.filter(t=>t.status==="CLOSED_PROFIT").length, stopCloses: longs.filter(t=>t.status==="CLOSED_STOP").length, marginReturnPct: sum(longs) },
      SHORT: { trades: shorts.length, profitCloses: shorts.filter(t=>t.status==="CLOSED_PROFIT").length, stopCloses: shorts.filter(t=>t.status==="CLOSED_STOP").length, marginReturnPct: sum(shorts) }
    }
  };
}

async function backtestSymbol(ticker, fromMs, toMs) {
  const [oneHour,fourHour,fifteenMinute,fiveMinute] = await Promise.all([
    fetchHistoricalCandles(ticker.symbol,"1h",fromMs,toMs),
    fetchHistoricalCandles(ticker.symbol,"4h",fromMs,toMs),
    fetchHistoricalCandles(ticker.symbol,"15m",fromMs,toMs),
    fetchHistoricalCandles(ticker.symbol,"5m",fromMs,toMs)
  ]);
  if (oneHour.length < 100 || fourHour.length < FUTURES_CONFIG.MIN_CANDLES || fifteenMinute.length < 120 || fiveMinute.length < 1000) {
    throw new Error("insufficient candles (1h="+oneHour.length+", 4h="+fourHour.length+", 15m="+fifteenMinute.length+", 5m="+fiveMinute.length+")");
  }

  const trades = [];
  const lockUntil = new Map();
  let fourIndex = 0, fifteenIndex = 0;
  let eligibleSignalOpportunities = 0, skippedByLock = 0, skippedByVolumeFilter = 0, rejectedSignals = 0, rejectedByHistoricalVolume = 0;
  const testStart = toMs - DAYS * 86400000;

  for (let i = 60; i < oneHour.length - 1; i++) {
    const signalBar = oneHour[i];
    const signalCloseTime = signalBar.time + INTERVALS["1h"];
    if (signalCloseTime < testStart || signalCloseTime >= toMs) continue;
    while (fourIndex < fourHour.length && fourHour[fourIndex].time + INTERVALS["4h"] <= signalCloseTime) fourIndex++;
    while (fifteenIndex < fifteenMinute.length && fifteenMinute[fifteenIndex].time + INTERVALS["15m"] <= signalCloseTime) fifteenIndex++;
    const closed4h = fourHour.slice(0,fourIndex);
    const closed15m = fifteenMinute.slice(Math.max(0,fifteenIndex-120),fifteenIndex);
    if (closed4h.length < FUTURES_CONFIG.MIN_CANDLES || closed15m.length < 40) continue;

    const nextBar = oneHour[i+1];
    // Approximate historical 24h quote turnover from closed hourly base-volume × close.
    // This avoids leaking today's ticker.volumeQuote into past signal eligibility.
    const historicalQuoteVolume = oneHour.slice(Math.max(0, i-23), i+1)
      .reduce((sum, candle) => sum + Number(candle.volume) * Number(candle.close), 0);
    if (!Number.isFinite(historicalQuoteVolume) || historicalQuoteVolume < FUTURES_CONFIG.MIN_QUOTE_VOLUME) {
      rejectedByHistoricalVolume++;
      continue;
    }
    const tickerAtSignal = {
      symbol: ticker.symbol, last: nextBar.open, quoteVolume: historicalQuoteVolume,
      priceChangePercent: historicalChange(oneHour,i), premium: { lastFundingRate: null }
    };
    let candidate;
    try { candidate = analyzeFuturesSymbol(tickerAtSignal,oneHour.slice(0,i+1),closed4h,closed15m); }
    catch { rejectedSignals++; continue; }
    if (!candidate || candidate.eligible !== true || !["LONG","SHORT"].includes(candidate.side)) { rejectedSignals++; continue; }
    eligibleSignalOpportunities++;
    const diagnostics = signalDiagnostics(candidate,candidate.side,oneHour.slice(0,i+1),closed4h);
    const failsVolume = SHORT_MAX_VOLUME_RATIO > 0 && Number(candidate.volumeRatio) > SHORT_MAX_VOLUME_RATIO;
    const failsAtr = SHORT_MIN_ATR_PCT > 0 && Number(diagnostics.atrPct) < SHORT_MIN_ATR_PCT;
    const failsEmaExtension = SHORT_MAX_EMA20_DISTANCE_PCT > 0 && Math.abs(Number(diagnostics.ema20DistancePct)) > SHORT_MAX_EMA20_DISTANCE_PCT;
    if (candidate.side === "SHORT" && (failsVolume || failsAtr || failsEmaExtension)) { skippedByVolumeFilter++; continue; }
    const lockKey = ticker.symbol + "|" + candidate.side;
    if ((lockUntil.get(lockKey) || 0) > signalCloseTime) { skippedByLock++; continue; }

    const entry = Number(candidate.entry);
    const trade = {
      id: ticker.symbol + ":" + candidate.side + ":" + signalCloseTime,
      symbol: ticker.symbol, side: candidate.side, status: "OPEN",
      entry, initialStop: Number(candidate.stop), stop: Number(candidate.stop),
      signalTime: signalBar.time, entryTime: signalCloseTime,
      score: candidate.score, stopDistancePct: Math.abs((entry-Number(candidate.stop))/entry)*100, signalDiagnostics: diagnostics, ambiguousCandles: 0
    };
    let candleIndex = lowerBound(fiveMinute,signalCloseTime);
    let closed = false;
    for (; candleIndex < fiveMinute.length && fiveMinute[candleIndex].time < toMs; candleIndex++) {
      const bar = fiveMinute[candleIndex];
      if (candleAmbiguous(candidate.side,trade,bar)) trade.ambiguousCandles++;
      const evaluated = evaluateTradeCandle(trade,{...bar,time:bar.time+INTERVALS["5m"]});
      if (evaluated.changed) {
        Object.assign(trade,evaluated.trade);
        trade.closedAtMs = bar.time + INTERVALS["5m"];
        closed = true;
        break;
      }
    }
    if (!closed) {
      trade.status = "OPEN_AT_BACKTEST_END";
      trade.lastMark = fiveMinute.at(-1)?.close ?? null;
      trade.marginReturnAtMarkPct = trade.lastMark ? (candidate.side==="LONG" ? 1 : -1) * ((trade.lastMark-entry)/entry) * 100 * LEVERAGE : null;
      // Preserve the same-side lock through the sample end for still-open trades.
      lockUntil.set(lockKey,toMs);
    } else {
      lockUntil.set(lockKey,trade.closedAtMs);
    }
    trades.push(trade);
  }

  return {
    symbol:ticker.symbol,
    candles:{ "1h":oneHour.length, "4h":fourHour.length, "15m":fifteenMinute.length, "5m":fiveMinute.length },
    eligibleSignalOpportunities, skippedBySameSideLock:skippedByLock, skippedByVolumeFilter, rejectedSignals, rejectedByHistoricalVolume,
    metrics:summarize(trades), trades
  };
}

async function main() {
  const configuredEndMs = Number(process.env.LIFECYCLE_BACKTEST_END_MS || 0);
  const endMs = Number.isFinite(configuredEndMs) && configuredEndMs > 0 ? configuredEndMs : Date.now();
  const startMs = endMs - DAYS*86400000;
  const fromMs = startMs - WARMUP_DAYS*86400000;
  const tickerData = await getJson(BASE + "/derivatives/api/v3/tickers");
  if (!Array.isArray(tickerData?.tickers)) throw new Error("Kraken tickers response invalid");
  const universe = tickerData.tickers.filter(t => t?.tag==="perpetual" && t.suspended!==true &&
    /^(PI|PF)_[A-Z0-9]+USD$/.test(String(t.symbol||"")) &&
    Number(t.volumeQuote)>=FUTURES_CONFIG.MIN_QUOTE_VOLUME && Number(t.last)>0)
    .sort((a,b)=>Number(b.volumeQuote)-Number(a.volumeQuote)).slice(0,SYMBOL_LIMIT);
  if (!universe.length) throw new Error("No eligible Kraken perpetual contracts found");

  const results = [];
  for (const ticker of universe) {
    try { results.push(await backtestSymbol(ticker,fromMs,endMs)); }
    catch (error) { results.push({symbol:ticker.symbol,error:String(error?.message||error)}); }
  }
  const successful = results.filter(r=>!r.error);
  const allTrades = successful.flatMap(r=>r.trades).sort((a,b)=>(a.closedAtMs||Number.MAX_SAFE_INTEGER)-(b.closedAtMs||Number.MAX_SAFE_INTEGER));
  const metrics = summarize(allTrades);
  const diagnosticSummary = Object.fromEntries(["CLOSED_PROFIT","CLOSED_STOP"].map(status => {
    const rows = allTrades.filter(t => t.status === status);
    const n = key => rows.filter(t => t.signalDiagnostics?.[key] === true).length;
    const avg = key => { const v=rows.map(t=>Number(t.signalDiagnostics?.[key])).filter(Number.isFinite); return v.length ? v.reduce((a,b)=>a+b,0)/v.length : null; };
    return [status,{count:rows.length,aligned1h:n("aligned1h"),aligned4h:n("aligned4h"),bothAligned:n("bothAligned"),
      trend4hOpposite:rows.filter(t=>t.signalDiagnostics?.trend4h!=="MIXED"&&!t.signalDiagnostics?.aligned4h).length,
      averageRsi:avg("rsi"),averageEma20DistancePct:avg("ema20DistancePct"),averageAtrPct:avg("atrPct"),
      averageVolumeRatio:avg("volumeRatio"),averageScore:rows.length?rows.reduce((a,t)=>a+Number(t.score||0),0)/rows.length:null}];
  }));
  const report = {
    generatedAt:new Date().toISOString(), venue:"Kraken Futures public historical OHLC candles",
    period:{from:new Date(startMs).toISOString(),to:new Date(endMs).toISOString(),days:DAYS,warmupDays:WARMUP_DAYS},
    rules:{leverage:LEVERAGE,targetMarginReturnPct:TARGET,requiredFavorablePriceMovePct:TARGET/LEVERAGE,
      exit:"close only at +30% margin return or configured stop",tp1Tp2Tp3:"ignored for closing",
      candleResolution:"5m",sameCandleAmbiguity:"stop-first unless a gap at candle open proves one level was reached first",
      fees:"excluded by user-defined gross price-move × leverage model",funding:"excluded",
      execution:"one evaluation per completed 1h candle; signal generated from closed 1h/4h/15m candles; entry approximated at next 1h open; exits evaluated on subsequent 5m OHLC",
      scheduler:"live Worker cron is every 5 minutes; this runner does not yet replay each 5-minute scan, so repeated intra-hour scan/TTL behavior is not represented",
      lifecycleSemantics:"the live Durable Object creates a SIGNAL_EVALUATION trade when a signal is registered; this is not evidence of a user accepting or an exchange order filling",
      lock:"independent symbol+side lock until close; opposite side may overlap",
      experimentalShortFilters:{ appliesTo:"SHORT only", maxVolumeRatio:SHORT_MAX_VOLUME_RATIO || null, minAtrPct:SHORT_MIN_ATR_PCT || null, maxAbsEma20DistancePct:SHORT_MAX_EMA20_DISTANCE_PCT || null, timing:"after signal eligibility, before same-side lock and trade entry" },
      universe:"top current Kraken perpetuals by current quote volume; survivorship bias applies",
      historicalVolumeFilter:"per-signal rolling 24h estimate = sum(hourly base volume × hourly close); approximate quote turnover, not exact exchange ticker volume",},
    symbolsRequested:SYMBOL_LIMIT,symbolsTested:successful.length,symbolErrors:results.filter(r=>r.error),
    metrics,diagnosticSummary,eligibleSignalOpportunities:successful.reduce((n,r)=>n+r.eligibleSignalOpportunities,0),
    bySymbol:successful.map(({trades,...r})=>({...r,metrics:r.metrics})),
    lockSkips:successful.reduce((n,r)=>n+r.skippedBySameSideLock,0),
    skippedByVolumeFilter:successful.reduce((n,r)=>n+r.skippedByVolumeFilter,0),
    rejectedSignals:successful.reduce((n,r)=>n+r.rejectedSignals,0),
    rejectedByHistoricalVolume:successful.reduce((n,r)=>n+r.rejectedByHistoricalVolume,0),
    trades:allTrades
  };
  await mkdir("artifacts",{recursive:true});
  await writeFile("artifacts/futures-lifecycle-backtest.json",JSON.stringify(report,null,2));
  const rows = [
    "# Futures lifecycle historical backtest","",
    "Period: "+report.period.from+" — "+report.period.to+" ("+DAYS+" days)",
    "Symbols tested: "+report.symbolsTested+"/"+SYMBOL_LIMIT,"",
    "| Metric | Result |","|---|---:|",
    "| Eligible signal opportunities (before lock) | "+report.eligibleSignalOpportunities+" |",
    "| Signal-evaluation lifecycles started (not exchange fills) | "+metrics.tradesStarted+" |",
    "| Closed trades | "+metrics.closedTrades+" |",
    "| Profit closes (+30% margin) | "+metrics.profitCloses+" |",
    "| Stop closes | "+metrics.stopCloses+" |",
    "| Open at end | "+metrics.openAtEnd+" |",
    "| LONG / SHORT | "+metrics.longs+" / "+metrics.shorts+" |",
    "| Win rate | "+metrics.winRatePct.toFixed(2)+"% |",
    "| Sum margin return (not compounded) | "+metrics.totalMarginReturnPct.toFixed(2)+"% |",
    "| Average margin return / trade | "+metrics.averageMarginReturnPct.toFixed(2)+"% |",
    "| Max drawdown (additive margin-return points) | "+metrics.maxDrawdownMarginPct.toFixed(2)+"% |",
    "| Ambiguous 5m candles | "+metrics.ambiguous5mCandles+" |",
    "| Same-side lock skips | "+report.lockSkips+" |",
    "| Skipped by experimental SHORT volume filter | "+report.skippedByVolumeFilter+" |",
    "| Rejected signal opportunities | "+report.rejectedSignals+" |",
    "| Rejected by historical 24h volume | "+report.rejectedByHistoricalVolume+" |","",
    "| Symbol | Signals | Closed | Profit | Stop | LONG | SHORT | Net margin % |",
    "|---|---:|---:|---:|---:|---:|---:|---:|",
    ...successful.map(r=>"| "+r.symbol+" | "+r.eligibleSignalOpportunities+" | "+r.metrics.closedTrades+" | "+r.metrics.profitCloses+" | "+r.metrics.stopCloses+" | "+r.metrics.longs+" | "+r.metrics.shorts+" | "+r.metrics.totalMarginReturnPct.toFixed(2)+" |"),
    "", "Limitations: scan cadence/TTL and actual user acceptance are not replayed; each signal-evaluation lifecycle is not an exchange fill. Historical quote turnover is approximated from hourly base volume × close; current-contract universe still has survivorship bias. 5m OHLC cannot identify intrabar path; ambiguous candles use stop-first. Stop execution is assumed at the stop or gap open. Liquidation, funding, fees, and slippage are excluded. Universe selection uses current volume, so survivorship bias applies.",
    "", "Symbol errors:", ...report.symbolErrors.map(x=>"- "+x.symbol+": "+x.error)
  ];
  await writeFile("artifacts/futures-lifecycle-backtest.md",rows.join("\n"));
  console.log(JSON.stringify({ok:successful.length>0,period:report.period,metrics,diagnosticSummary,symbols:report.bySymbol,symbolErrors:report.symbolErrors,lockSkips:report.lockSkips,skippedByVolumeFilter:report.skippedByVolumeFilter,rejectedSignals:report.rejectedSignals},null,2));
  if (!successful.length) process.exitCode=1;
}
main().catch(error=>{console.error(error);process.exitCode=1;});

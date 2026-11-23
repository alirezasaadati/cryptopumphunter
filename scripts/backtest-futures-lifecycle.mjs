// SHORT entry source breakdown is included in the final report.
import { mkdir, writeFile } from "node:fs/promises";
import { analyzeFuturesSymbol, FUTURES_CONFIG } from "../src/index.js";
import { evaluateTradeCandle, FUTURES_TRADE_LEVERAGE, FUTURES_MARGIN_PROFIT_TARGET_PERCENT } from "../src/futures-trade-lifecycle.js";

const BASE = "https://futures.kraken.com";
const INTERVALS = { "5m": 300000, "15m": 900000, "1h": 3600000, "4h": 14400000 };
const DAYS = Math.max(7, Math.min(365, Number(process.env.LIFECYCLE_BACKTEST_DAYS || 30)));
const SYMBOL_LIMIT = Math.max(1, Math.min(12, Number(process.env.LIFECYCLE_BACKTEST_SYMBOLS || 10)));
const WARMUP_DAYS = 15;
const TARGET = FUTURES_MARGIN_PROFIT_TARGET_PERCENT;
const LEVERAGE = FUTURES_TRADE_LEVERAGE;

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

function historicalQuoteVolume(candles, index) {
  const start = Math.max(0, index - 23);
  let quoteVolume = 0;
  for (let i = start; i <= index; i++) {
    quoteVolume += Number(candles[i].volume) * Number(candles[i].close);
  }
  return quoteVolume;
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
function evaluateTp1Candle(trade, bar) {
  const entry = Number(trade.entry);
  const stop = Number(trade.initialStop);
  const target = Number(trade.target1);
  const side = trade.side;
  const open = Number(bar.open), high = Number(bar.high), low = Number(bar.low);
  const stopHit = side === "LONG" ? low <= stop : high >= stop;
  const tp1Hit = side === "LONG" ? high >= target : low <= target;
  if (!stopHit && !tp1Hit) return null;
  const stopAtOpen = side === "LONG" ? open <= stop : open >= stop;
  const tp1AtOpen = side === "LONG" ? open >= target : open <= target;
  const closeAtStop = stopAtOpen || (!tp1AtOpen && stopHit);
  const exitPrice = closeAtStop
    ? (stopAtOpen ? open : stop)
    : (tp1AtOpen ? open : target);
  const movePct = (side === "LONG" ? 1 : -1) * ((exitPrice-entry)/entry) * 100;
  return {
    status: closeAtStop ? "CLOSED_STOP" : "CLOSED_TP1",
    closeReason: closeAtStop ? "CLOSED_STOP" : "CLOSED_TP1",
    exitPrice,
    closePriceChangePercent: movePct,
    marginReturnPercent: movePct * LEVERAGE,
    closedAtMs: bar.time + INTERVALS["5m"],
    ambiguousCandles: trade.ambiguousCandles || 0
  };
}

function summarize(trades) {
  const closed = trades.filter(t => t.status === "CLOSED_TP1" || t.status === "CLOSED_STOP");
  const profits = closed.filter(t => t.status === "CLOSED_TP1");
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
  return {
    tradesStarted: trades.length,
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
      LONG: { trades: longs.length, profitCloses: longs.filter(t=>t.status==="CLOSED_TP1").length, stopCloses: longs.filter(t=>t.status==="CLOSED_STOP").length, marginReturnPct: sum(longs) },
      SHORT: { trades: shorts.length, profitCloses: shorts.filter(t=>t.status==="CLOSED_TP1").length, stopCloses: shorts.filter(t=>t.status==="CLOSED_STOP").length, marginReturnPct: sum(shorts) }
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
  const baselineTrades = [];
  // Shared lock schedule keeps the accepted signal set identical in both arms.
  const pairedLockUntil = new Map();
  let fourIndex = 0, fifteenIndex = 0;
  let acceptedSignals = 0, skippedByLock = 0, rejectedSignals = 0, skippedNonShortSignals = 0;
  let limitOrdersFilled = 0, limitOrdersExpired = 0;
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
    const tickerAtSignal = {
      symbol: ticker.symbol, last: nextBar.open, quoteVolume: historicalQuoteVolume(oneHour,i),
      priceChangePercent: historicalChange(oneHour,i), premium: { lastFundingRate: null }
    };
    let candidate;
    try { candidate = analyzeFuturesSymbol(tickerAtSignal,oneHour.slice(0,i+1),closed4h,closed15m); }
    catch { rejectedSignals++; continue; }
    if (!candidate || candidate.eligible !== true || !["LONG","SHORT"].includes(candidate.side)) { rejectedSignals++; continue; }
    if (candidate.side !== "SHORT") { skippedNonShortSignals++; continue; }

    const lockKey = ticker.symbol + "|" + candidate.side;
    const firstOrderBar = lowerBound(fiveMinute,signalCloseTime);

    // Both arms must be eligible for this exact same signal opportunity.
    if ((pairedLockUntil.get(lockKey) || 0) > signalCloseTime) { skippedByLock++; continue; }
    acceptedSignals++;

    // Paired control: unchanged current short-engine market entry.
    let baselineTrade = null;
    if (fiveMinute[firstOrderBar] && fiveMinute[firstOrderBar].time < toMs) {
      const baselineEntry = Number(candidate.entry);
      const baselineStop = Number(candidate.stop);
      const baselineTarget = Number(candidate.target1);
      if ([baselineEntry,baselineStop,baselineTarget].every(Number.isFinite) && baselineEntry > 0) {
        baselineTrade = {
          id:ticker.symbol+":SHORT:BASELINE:"+signalCloseTime,
          symbol:ticker.symbol, side:"SHORT", status:"OPEN",
          entry:baselineEntry, initialStop:baselineStop, stop:baselineStop, target1:baselineTarget,
          signalTime:signalBar.time, signalCloseTime, entryTime:fiveMinute[firstOrderBar].time,
          score:candidate.score, ambiguousCandles:0
        };
        let baselineClosed = false;
        for (let k=firstOrderBar; k<fiveMinute.length && fiveMinute[k].time<toMs; k++) {
          const bar=fiveMinute[k];
          const evaluated=evaluateTp1Candle(baselineTrade,bar);
          if (evaluated) { Object.assign(baselineTrade,evaluated); baselineClosed=true; break; }
        }
        if (!baselineClosed) {
          baselineTrade.status="OPEN_AT_BACKTEST_END";
          baselineTrade.lastMark=fiveMinute.at(-1)?.close ?? null;
          baselineTrade.marginReturnAtMarkPct=baselineTrade.lastMark
            ? -((baselineTrade.lastMark-baselineEntry)/baselineEntry)*100*LEVERAGE : null;
        }
        baselineTrades.push(baselineTrade);
      }
    }

    // Select the closer of 1h EMA20 and the just-closed signal candle wick:
    // LONG: EMA20 or previous candle low; SHORT: EMA20 or previous candle high.
    // "Closer" is measured from the signal candle close (the observable price
    // when the signal is issued), not from any future candle.
    const emaEntry = Number(candidate.ema20);
    const wickEntry = candidate.side === "LONG" ? Number(signalBar.low) : Number(signalBar.high);
    const referencePrice = Number(signalBar.close);
    if (![emaEntry,wickEntry,referencePrice].every(Number.isFinite) || emaEntry <= 0 || wickEntry <= 0 || referencePrice <= 0) {
      rejectedSignals++; continue;
    }
    const limitPrice = Math.abs(emaEntry-referencePrice) <= Math.abs(wickEntry-referencePrice) ? emaEntry : wickEntry;
    const marketAtSignal = Number(tickerAtSignal.last);
    const levelsGapPct = Math.abs(emaEntry-wickEntry) / marketAtSignal * 100;
    const useMarketFallback = marketAtSignal < emaEntry && marketAtSignal < wickEntry && levelsGapPct > 0.5;
    const selectedEntrySource = useMarketFallback ? "MARKET_FALLBACK" : (limitPrice === emaEntry ? "EMA20_1H" : "PREVIOUS_CANDLE_HIGH");
    const orderExpiry = signalCloseTime + INTERVALS["1h"];
    let fill = null;
    if (useMarketFallback && fiveMinute[firstOrderBar] && fiveMinute[firstOrderBar].time < toMs) {
      fill = { price: fiveMinute[firstOrderBar].open, time: fiveMinute[firstOrderBar].time, barIndex: firstOrderBar, fillType: "MARKET_FALLBACK" };
    }
    for (let j = firstOrderBar; !fill && j < fiveMinute.length && fiveMinute[j].time < orderExpiry && fiveMinute[j].time < toMs; j++) {
      const bar = fiveMinute[j];
      if (candidate.side === "LONG") {
        if (bar.open <= limitPrice) fill = { price: bar.open, time: bar.time, barIndex: j, fillType: "MARKETABLE_LIMIT_AT_OPEN" };
        else if (bar.low <= limitPrice) fill = { price: limitPrice, time: bar.time, barIndex: j, fillType: "LIMIT_TOUCH" };
      } else {
        if (bar.open >= limitPrice) fill = { price: bar.open, time: bar.time, barIndex: j, fillType: "MARKETABLE_LIMIT_AT_OPEN" };
        else if (bar.high >= limitPrice) fill = { price: limitPrice, time: bar.time, barIndex: j, fillType: "LIMIT_TOUCH" };
      }
      if (fill) break;
    }
    if (!fill) {
      limitOrdersExpired++;
      if (baselineTrade) pairedLockUntil.set(lockKey, baselineTrade.status === "OPEN_AT_BACKTEST_END" ? toMs : baselineTrade.closedAtMs);
      continue;
    }

    // Recalculate the existing structural/ATR stop around the actual EMA20 fill.
    // The same 1.5R / 2.5R / 3.5R target multipliers are retained.
    const swing = oneHour.slice(Math.max(0,i-6),i+1);
    const swingLow = Math.min(...swing.map(c=>c.low));
    const swingHigh = Math.max(...swing.map(c=>c.high));
    const atr = Number(candidate.atr);
    const atrMultiplier = candidate.side === "LONG" ? 2.0 : 1.5;
    const stop = candidate.side === "LONG"
      ? Math.min(swingLow,fill.price-atr*atrMultiplier)
      : Math.max(swingHigh,fill.price+atr*atrMultiplier);
    const risk = candidate.side === "LONG" ? fill.price-stop : stop-fill.price;
    const riskPct = risk/fill.price;
    if (!Number.isFinite(risk) || risk <= 0 || riskPct < 0.002 || riskPct > 0.08) {
      rejectedSignals++;
      if (baselineTrade) pairedLockUntil.set(lockKey, baselineTrade.status === "OPEN_AT_BACKTEST_END" ? toMs : baselineTrade.closedAtMs);
      continue;
    }
    const direction = candidate.side === "LONG" ? 1 : -1;
    const trade = {
      id:ticker.symbol+":"+candidate.side+":"+signalCloseTime,
      symbol:ticker.symbol, side:candidate.side, status:"OPEN",
      entry:fill.price, limitPrice, selectedEntrySource, referencePrice, wickEntry, fillType:fill.fillType, fillTime:fill.time,
      initialStop:stop, stop, atrMultiplier, tp1R: candidate.side === "LONG" ? 1.3 : 1.5,
      target1:fill.price+direction*risk*(candidate.side === "LONG" ? 1.3 : 1.5),
      signalTime:signalBar.time, signalCloseTime, entryTime:fill.time,
      score:candidate.score, ema20:Number(candidate.ema20), ambiguousCandles:0
    };
    limitOrdersFilled++;
    let closed = false;
    for (let j=fill.barIndex; j<fiveMinute.length && fiveMinute[j].time<toMs; j++) {
      const bar=fiveMinute[j];
      if (candleAmbiguous(candidate.side,trade,bar)) trade.ambiguousCandles++;
      const evaluated=evaluateTp1Candle(trade,bar);
      if (evaluated) { Object.assign(trade,evaluated); closed=true; break; }
    }
    if (!closed) {
      trade.status="OPEN_AT_BACKTEST_END";
      trade.lastMark=fiveMinute.at(-1)?.close ?? null;
      trade.marginReturnAtMarkPct=trade.lastMark ? direction*((trade.lastMark-fill.price)/fill.price)*100*LEVERAGE : null;
    }
    const baselineUnlock = baselineTrade
      ? (baselineTrade.status === "OPEN_AT_BACKTEST_END" ? toMs : baselineTrade.closedAtMs)
      : signalCloseTime;
    const experimentalUnlock = trade.status === "OPEN_AT_BACKTEST_END" ? toMs : trade.closedAtMs;
    pairedLockUntil.set(lockKey, Math.max(baselineUnlock || signalCloseTime, experimentalUnlock || signalCloseTime));
    trades.push(trade);
  }

  return {
    symbol:ticker.symbol,
    candles:{ "1h":oneHour.length, "4h":fourHour.length, "15m":fifteenMinute.length, "5m":fiveMinute.length },
    signalsAccepted:acceptedSignals, limitOrdersFilled, limitOrdersExpired,
    skippedBySameSideLock:skippedByLock, rejectedSignals, skippedNonShortSignals,
    metrics:summarize(trades), trades, baselineTrades
  };
}
async function main() {
  const configuredEnd = process.env.LIFECYCLE_BACKTEST_END ? Date.parse(process.env.LIFECYCLE_BACKTEST_END) : Date.now();
  if (!Number.isFinite(configuredEnd)) throw new Error("Invalid LIFECYCLE_BACKTEST_END");
  const endMs = configuredEnd;
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
  const baselineAllTrades = successful.flatMap(r=>r.baselineTrades || []).sort((a,b)=>(a.closedAtMs||Number.MAX_SAFE_INTEGER)-(b.closedAtMs||Number.MAX_SAFE_INTEGER));
  const metrics = summarize(allTrades);
  const baselineMetrics = summarize(baselineAllTrades);
  const fillTypeCounts = allTrades.reduce((acc,t)=>{ const key=t.fillType||"UNKNOWN"; acc[key]=(acc[key]||0)+1; return acc; },{});
  const entrySourceMetrics = Object.fromEntries(["EMA20_1H","PREVIOUS_CANDLE_HIGH","MARKET_FALLBACK"].map(source => {
    const group = allTrades.filter(t => t.selectedEntrySource === source);
    return [source, { ...summarize(group), filledTrades: group.length,
      fillTypes: group.reduce((acc,t)=>{ const key=t.fillType||"UNKNOWN"; acc[key]=(acc[key]||0)+1; return acc; },{}) }];
  }));
  const STARTING_CAPITAL = 100;
  const MARGIN_PER_TRADE = 10;
  const events = allTrades.flatMap(t => [
    { time: t.entryTime, type: "ENTRY", trade: t },
    ...(t.closedAtMs ? [{ time: t.closedAtMs, type: "EXIT", trade: t }] : [])
  ]).sort((a,b) => a.time-b.time || (a.type === "EXIT" ? -1 : 1));
  let freeMargin = STARTING_CAPITAL, realizedPnl = 0, peakOpenPositions = 0;
  const acceptedIds = new Set(), active = new Map();
  for (const event of events) {
    const t = event.trade;
    if (event.type === "EXIT") {
      if (active.has(t.id)) {
        realizedPnl += Number(t.marginReturnPercent || 0) / 100 * MARGIN_PER_TRADE;
        freeMargin += MARGIN_PER_TRADE;
        active.delete(t.id);
      }
    } else if (freeMargin >= MARGIN_PER_TRADE) {
      freeMargin -= MARGIN_PER_TRADE;
      active.set(t.id, t);
      acceptedIds.add(t.id);
      peakOpenPositions = Math.max(peakOpenPositions, active.size);
    }
  }
  const accountTrades = allTrades.filter(t => acceptedIds.has(t.id));
  const excludedForCapital = allTrades.length - accountTrades.length;
  const accountMetrics = summarize(accountTrades);
  const openUnrealizedPnl = [...active.values()].reduce((sum,t) => sum + Number(t.marginReturnAtMarkPct || 0) / 100 * MARGIN_PER_TRADE, 0);
  const lockedMargin = active.size * MARGIN_PER_TRADE;
  const finalEquity = freeMargin + lockedMargin + realizedPnl + openUnrealizedPnl;
  const report = {
    generatedAt:new Date().toISOString(), venue:"Kraken Futures public historical OHLC candles",
    period:{from:new Date(startMs).toISOString(),to:new Date(endMs).toISOString(),days:DAYS,warmupDays:WARMUP_DAYS},
    rules:{leverage:LEVERAGE,startingCapitalUsd:STARTING_CAPITAL,marginPerTradeUsd:MARGIN_PER_TRADE,maxConcurrentPositions:STARTING_CAPITAL/MARGIN_PER_TRADE,
      sideScope:"SHORT only; LONG signals are not backtested",atrMultiplierShort:1.5,tp1RShort:1.5,
      shortEntry:"Choose the nearer of 1h EMA20 and previous closed 1h candle high, measured from signal candle close. If market is below both levels and their separation exceeds 0.5% of market price, enter at the next 5m open using MARKET_FALLBACK; otherwise place the selected limit for one hour.",
      exit:"SHORT closes at TP1=1.5R or initial stop; current short engine ATR multiplier 1.5 is retained",tp1Tp2Tp3:"TP1 only; TP2 and TP3 ignored",
      candleResolution:"5m",sameCandleAmbiguity:"stop-first unless a gap at candle open proves one level was reached first",
      fees:"excluded by user-defined gross price-move × leverage model",funding:"excluded",
      execution:"SHORT-only signals from the unchanged current Kraken Futures analyzer on closed 1h/4h/15m candles; choose nearer 1h EMA20 or previous closed 1h high from signal close; if market is below both and level gap >0.5%, market fallback at next 5m open; otherwise one-hour limit; stop recalculated using current short engine ATR 1.5x and prior seven closed 1h candles; TP1 1.5R; exits on 5m OHLC",
      lock:"independent symbol+side lock until close; opposite side may overlap",
      universe:"top 10 current Kraken perpetuals by current quote volume; historical 24h quote-volume filter reconstructed from prior 24 closed 1h candles; survivorship bias applies"},
    symbolsRequested:SYMBOL_LIMIT,symbolsTested:successful.length,symbolErrors:results.filter(r=>r.error),
    metrics,baselineMetrics,fillTypeCounts,entrySourceMetrics,accountMetrics,account:{startingCapitalUsd:STARTING_CAPITAL,marginPerTradeUsd:MARGIN_PER_TRADE,maxConcurrentPositions:STARTING_CAPITAL/MARGIN_PER_TRADE,peakConcurrentPositions:peakOpenPositions,excludedForInsufficientFreeMargin:excludedForCapital,realizedPnlUsd:realizedPnl,openUnrealizedPnlUsd:openUnrealizedPnl,lockedMarginUsd:lockedMargin,finalEquityUsd:finalEquity},eligibleSignalOpportunities:successful.reduce((n,r)=>n+r.signalsAccepted,0),
    limitOrdersFilled:successful.reduce((n,r)=>n+r.limitOrdersFilled,0),
    limitOrdersExpired:successful.reduce((n,r)=>n+r.limitOrdersExpired,0),
    averageSignalsPerDay:successful.reduce((n,r)=>n+r.signalsAccepted,0)/DAYS,
    bySymbol:successful.map(({trades,baselineTrades,...r})=>({...r,metrics:r.metrics,baselineMetrics:summarize(baselineTrades||[])})),
    lockSkips:successful.reduce((n,r)=>n+r.skippedBySameSideLock,0),
    rejectedSignals:successful.reduce((n,r)=>n+r.rejectedSignals,0),
    skippedNonShortSignals:successful.reduce((n,r)=>n+(r.skippedNonShortSignals||0),0),
    trades:allTrades
  };
  await mkdir("artifacts",{recursive:true});
  await writeFile("artifacts/futures-lifecycle-backtest.json",JSON.stringify(report,null,2));
  const rows = [
    "# Futures TP1 historical backtest","",
    "Period: "+report.period.from+" — "+report.period.to+" ("+DAYS+" days)",
    "Symbols tested: "+report.symbolsTested+"/"+SYMBOL_LIMIT,"",
    "| Metric | Result |","|---|---:|",
    "| Eligible signal opportunities | "+report.eligibleSignalOpportunities+" |",
    "| Average eligible signals / day | "+report.averageSignalsPerDay.toFixed(2)+" |",
    "| Entry fills (all types) / expired limits | "+report.limitOrdersFilled+" / "+report.limitOrdersExpired+" |",
    "| Fill execution: fallback / limit touch / marketable-at-open | "+(report.fillTypeCounts.MARKET_FALLBACK||0)+" / "+(report.fillTypeCounts.LIMIT_TOUCH||0)+" / "+(report.fillTypeCounts.MARKETABLE_LIMIT_AT_OPEN||0)+" |",
    "",
    "## Entry-source breakdown",
    "",
    "| Selected source | Filled | TP1 | Stop | Win rate | Gross PnL ($10 margin/trade) |",
    "|---|---:|---:|---:|---:|---:|",
    ...Object.entries(report.entrySourceMetrics).map(([source,m])=>"| "+source+" | "+m.filledTrades+" | "+m.profitCloses+" | "+m.stopCloses+" | "+m.winRatePct.toFixed(2)+"% | $"+(m.totalMarginReturnPct/10).toFixed(2)+" |"),
    "| Trades started after same-side lock | "+metrics.tradesStarted+" |",
    "| Closed trades | "+metrics.closedTrades+" |",
    "| TP1 closes (SHORT 1.5R) | "+accountMetrics.profitCloses+" |",
    "| Stop closes | "+accountMetrics.stopCloses+" |",
    "| Open at end | "+accountMetrics.openAtEnd+" |",
    "| LONG / SHORT (capital-constrained) | 0 / "+accountMetrics.shorts+" |",
    "| Win rate | "+accountMetrics.winRatePct.toFixed(2)+"% |",
    "| Starting capital / margin per trade | $"+STARTING_CAPITAL+" / $"+MARGIN_PER_TRADE+" |",
    "| Realized PnL / open unrealized PnL | $"+realizedPnl.toFixed(2)+" / $"+openUnrealizedPnl.toFixed(2)+" |",
    "| Final equity (incl. open mark-to-market) | $"+finalEquity.toFixed(2)+" |",
    "| Trades excluded by available margin | "+excludedForCapital+" |",
    "| Sum margin return (not compounded) | "+metrics.totalMarginReturnPct.toFixed(2)+"% |",
    "| Average margin return / trade | "+metrics.averageMarginReturnPct.toFixed(2)+"% |",
    "| Max drawdown (additive margin-return points) | "+metrics.maxDrawdownMarginPct.toFixed(2)+"% |",
    "| Baseline market-entry closed / TP1 / stop | "+baselineMetrics.closedTrades+" / "+baselineMetrics.profitCloses+" / "+baselineMetrics.stopCloses+" |",
    "| Baseline market-entry win rate | "+baselineMetrics.winRatePct.toFixed(2)+"% |",
    "| Baseline market-entry gross PnL ($10 margin/trade) | $"+(baselineMetrics.totalMarginReturnPct/10).toFixed(2)+" |",
    "| Experimental entry gross PnL ($10 margin/trade) | $"+(metrics.totalMarginReturnPct/10).toFixed(2)+" |",
    "| Ambiguous 5m candles | "+metrics.ambiguous5mCandles+" |",
    "| Same-side lock skips | "+report.lockSkips+" |",
    "| Rejected signal opportunities | "+report.rejectedSignals+" |",
    "| LONG signals ignored (SHORT-only test) | "+report.skippedNonShortSignals+" |","",
    "| Symbol | Signals | Closed | Profit | Stop | LONG | SHORT | Net margin % |",
    "|---|---:|---:|---:|---:|---:|---:|---:|",
    ...successful.map(r=>"| "+r.symbol+" | "+r.signalsAccepted+" | "+r.metrics.closedTrades+" | "+r.metrics.profitCloses+" | "+r.metrics.stopCloses+" | "+r.metrics.longs+" | "+r.metrics.shorts+" | "+r.metrics.totalMarginReturnPct.toFixed(2)+" |"),
    "", "Limitations: 5m OHLC cannot identify intrabar path; ambiguous candles use stop-first. Stop execution is assumed at the stop or gap open. Liquidation, funding, fees, and slippage are excluded. Universe selection uses current volume, so survivorship bias applies.",
    "", "Symbol errors:", ...report.symbolErrors.map(x=>"- "+x.symbol+": "+x.error)
  ];
  await writeFile("artifacts/futures-lifecycle-backtest.md",rows.join("\n"));
  console.log(JSON.stringify({ok:successful.length>0,period:report.period,metrics,accountMetrics,account:report.account,symbols:report.bySymbol,symbolErrors:report.symbolErrors,lockSkips:report.lockSkips,rejectedSignals:report.rejectedSignals},null,2));
  if (!successful.length) process.exitCode=1;
}
main().catch(error=>{console.error(error);process.exitCode=1;});

// 90d/180d SHORT entry-source experiment; production files are intentionally untouched.

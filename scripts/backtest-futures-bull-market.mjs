import { mkdir, writeFile } from "node:fs/promises";
import { analyzeFuturesSymbol, FUTURES_CONFIG } from "../src/index.js";
import { analyzeIndependentSignal } from "../src/futures-independent-signals.js";
import { evaluateTradeCandle, FUTURES_TRADE_LEVERAGE, FUTURES_MARGIN_PROFIT_TARGET_PERCENT } from "../src/futures-trade-lifecycle.js";

const BASE = "https://futures.kraken.com";
const INTERVALS = { "5m": 300000, "15m": 900000, "1h": 3600000, "4h": 14400000 };
const DAYS = Math.max(7, Math.min(180, Number(process.env.LIFECYCLE_BACKTEST_DAYS || 92)));
const CONFIGURED_START_MS = Number(process.env.LIFECYCLE_BACKTEST_START_MS || 0);
const SYMBOL_LIMIT = Math.max(1, Math.min(12, Number(process.env.LIFECYCLE_BACKTEST_SYMBOLS || 10)));
const WARMUP_DAYS = 15;
const TARGET = FUTURES_MARGIN_PROFIT_TARGET_PERCENT;
const LEVERAGE = FUTURES_TRADE_LEVERAGE;
const BREAK_EVEN_TRIGGER = Math.max(0, Number(process.env.LIFECYCLE_BREAK_EVEN_MARGIN_PCT || 0));
const STRUCTURAL_STOP_MODE = String(process.env.LIFECYCLE_STRUCTURAL_STOP_MODE || "original").toLowerCase();
const ENTRY_PULLBACK_PCT = Math.max(0, Math.min(5, Number(process.env.LIFECYCLE_ENTRY_PULLBACK_PCT || 0)));
const STRUCTURAL_STOP_BUFFER_ATR = Math.max(0, Number(process.env.LIFECYCLE_STRUCTURAL_STOP_BUFFER_ATR || 0.2));
const RISK_PER_TRADE_PCT = Math.max(0.01, Number(process.env.LIFECYCLE_RISK_PER_TRADE_PCT || 1));
const FIXED_SYMBOLS = String(process.env.LIFECYCLE_BACKTEST_SYMBOL_LIST || "").split(",").map(x=>x.trim()).filter(Boolean);

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
function calculateAtrLocal(candles, period = 14) {
  if (!Array.isArray(candles) || candles.length < period + 1) return null;
  const ranges = [];
  for (let i=1;i<candles.length;i++) {
    const c=candles[i], previousClose=Number(candles[i-1].close);
    ranges.push(Math.max(Number(c.high)-Number(c.low),Math.abs(Number(c.high)-previousClose),Math.abs(Number(c.low)-previousClose)));
  }
  const recent=ranges.slice(-period);
  return recent.length===period?recent.reduce((a,b)=>a+b,0)/period:null;
}
function findLatestProtectivePivot(candles, side, left=2, right=2) {
  if (!Array.isArray(candles)||candles.length<left+right+1) return null;
  const field=side==="LONG"?"low":"high";
  for(let i=candles.length-right-1;i>=left;i--){
    const value=Number(candles[i]?.[field]);
    if(!Number.isFinite(value))continue;
    let pivot=true;
    for(let j=i-left;j<=i+right;j++){
      if(j===i)continue;
      const neighbor=Number(candles[j]?.[field]);
      if(!Number.isFinite(neighbor)||(side==="LONG"?neighbor<=value:neighbor>=value)){pivot=false;break;}
    }
    if(pivot)return{index:i,time:candles[i].time,price:value};
  }
  return null;
}
function excursionForBar(side, entry, bar) {
  if (side === "LONG") return {
    favorable: Math.max(0, (bar.high / entry - 1) * LEVERAGE * 100),
    adverse: Math.max(0, (1 - bar.low / entry) * LEVERAGE * 100)
  };
  return {
    favorable: Math.max(0, ((entry - bar.low) / entry) * LEVERAGE * 100),
    adverse: Math.max(0, (bar.high / entry - 1) * LEVERAGE * 100)
  };
}
function excursionStats(rows) {
  const values = key => rows.map(t => Number(t[key])).filter(Number.isFinite).sort((a,b)=>a-b);
  const stats = xs => {
    const pct = p => xs.length ? xs[Math.min(xs.length-1, Math.ceil(p*xs.length)-1)] : null;
    return { count:xs.length, average:xs.length?xs.reduce((a,b)=>a+b,0)/xs.length:null, median:pct(.5), p90:pct(.9), min:xs[0]??null, max:xs.at(-1)??null };
  };
  return { count:rows.length, mfeMarginPct:stats(values("maxFavorableExcursionMarginPct")), maeMarginPct:stats(values("maxAdverseExcursionMarginPct")),
    touchedFavorable10Pct:rows.filter(t=>t.maxFavorableExcursionMarginPct>=10).length,
    touchedFavorable15Pct:rows.filter(t=>t.maxFavorableExcursionMarginPct>=15).length,
    touchedFavorable20Pct:rows.filter(t=>t.maxFavorableExcursionMarginPct>=20).length };
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
  const allLongSignals = trades.filter(t => t.side === "LONG");
  const allShortSignals = trades.filter(t => t.side === "SHORT");
  const summarizeSide = sideTrades => {
    const sideClosed = sideTrades.filter(t => t.status === "CLOSED_PROFIT" || t.status === "CLOSED_STOP");
    const sideProfits = sideClosed.filter(t => t.status === "CLOSED_PROFIT");
    const sideStops = sideClosed.filter(t => t.status === "CLOSED_STOP");
    return {
      signalsIssued: sideTrades.length,
      closedTrades: sideClosed.length,
      profitCloses: sideProfits.length,
      stopCloses: sideStops.length,
      openAtEnd: sideTrades.length - sideClosed.length,
      winRatePct: sideClosed.length ? sideProfits.length / sideClosed.length * 100 : 0
    };
  };
  const sum = xs => xs.reduce((n,t)=>n+Number(t.marginReturnPercent || 0),0);
  const riskSizedReturn = t => {
    const distance=Number(t.stopDistancePct), margin=Number(t.marginReturnPercent||0);
    return Number.isFinite(distance)&&distance>0?(margin/LEVERAGE/distance)*RISK_PER_TRADE_PCT:0;
  };
  let riskEquity=0,riskPeak=0,riskMaxDrawdown=0;
  for(const trade of [...closed].sort((a,b)=>a.closedAtMs-b.closedAtMs)){
    riskEquity+=riskSizedReturn(trade);riskPeak=Math.max(riskPeak,riskEquity);
    riskMaxDrawdown=Math.max(riskMaxDrawdown,riskPeak-riskEquity);
  }
  const stopLosses = stops.map(t => Math.abs(Number(t.marginReturnPercent || 0))).filter(x=>Number.isFinite(x) && x > 0).sort((a,b)=>a-b);
  const breakEvenStops = stops.filter(t => t.breakEvenActivated === true && Math.abs(Number(t.marginReturnPercent || 0)) < 1e-9);
  const lossStops = stops.filter(t => Number(t.marginReturnPercent || 0) < -1e-9);
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
    lossStopCloses: lossStops.length,
    breakEvenActivatedTrades: trades.filter(t=>t.breakEvenActivated===true).length,
    breakEvenStopCloses: breakEvenStops.length,
    openAtEnd: trades.length - closed.length,
    longs: longs.length,
    shorts: shorts.length,
    winRatePct: closed.length ? profits.length / closed.length * 100 : 0,
    totalMarginReturnPct: sum(closed),
    averageMarginReturnPct: closed.length ? sum(closed) / closed.length : 0,
    maxDrawdownMarginPct: maxDrawdown,
    riskPerTradePct:RISK_PER_TRADE_PCT,
    totalRiskSizedReturnPct:closed.reduce((n,t)=>n+riskSizedReturn(t),0),
    averageRiskSizedReturnPct:closed.length?closed.reduce((n,t)=>n+riskSizedReturn(t),0)/closed.length:0,
    maxRiskSizedDrawdownPct:riskMaxDrawdown,
    ambiguous5mCandles: trades.reduce((n,t)=>n+(t.ambiguousCandles || 0),0),
    excursion: { allClosed: excursionStats(closed), stopped: excursionStats(stops), profitable: excursionStats(profits) },
    bySide: {
      LONG: { ...summarizeSide(allLongSignals), marginReturnPct: sum(longs) },
      SHORT: { ...summarizeSide(allShortSignals), marginReturnPct: sum(shorts) }
    }
  };
}


function backtestIndependentEngines(ticker, oneHour, fourHour, fifteenMinute, fiveMinute, testStart, toMs) {
  const trades=[],locks=new Map();
  let fourIndex=0, opportunities={LONG:0,SHORT:0},lockSkips={LONG:0,SHORT:0};
  for(let i=60;i<fifteenMinute.length-1;i++){
    const signalBar=fifteenMinute[i],signalCloseTime=signalBar.time+INTERVALS["15m"];
    if(signalCloseTime<testStart||signalCloseTime>=toMs)continue;
    while(fourIndex<fourHour.length&&fourHour[fourIndex].time+INTERVALS["4h"]<=signalCloseTime)fourIndex++;
    const closed4h=fourHour.slice(0,fourIndex);
    const closed15m=fifteenMinute.slice(Math.max(0,i+1-160),i+1);
    if(closed4h.length<FUTURES_CONFIG.MIN_CANDLES||closed15m.length<40)continue;
    const eligibleHourIndex=lowerBound(oneHour,signalCloseTime)-1;
    if(eligibleHourIndex<23)continue;
    const historicalQuoteVolume=oneHour.slice(eligibleHourIndex-23,eligibleHourIndex+1).reduce((sum,candle)=>sum+Number(candle.volume)*Number(candle.close),0);
    if(!Number.isFinite(historicalQuoteVolume)||historicalQuoteVolume<FUTURES_CONFIG.MIN_QUOTE_VOLUME)continue;
    for(const side of ["LONG","SHORT"]){
      const candidate=analyzeIndependentSignal({side,candles4h:closed4h,candles15m:closed15m});
      if(!candidate)continue;
      opportunities[side]++;
      const lockKey=ticker.symbol+"|"+side;
      if((locks.get(lockKey)||0)>signalCloseTime){lockSkips[side]++;continue;}
      const fillIndex=lowerBound(fiveMinute,signalCloseTime),fillBar=fiveMinute[fillIndex];
      if(!fillBar||fillBar.time>=toMs)continue;
      const entry=Number(fillBar.open),stop=Number(candidate.stop);
      const distance=Math.abs((entry-stop)/entry)*100;
      if(!Number.isFinite(entry)||entry<=0||(side==="LONG"?stop>=entry:stop<=entry)||!Number.isFinite(distance)||distance<=0||distance>8)continue;
      const trade={id:ticker.symbol+":"+side+":independent:"+signalCloseTime,symbol:ticker.symbol,side,status:"OPEN",engine:"independent-"+side.toLowerCase(),entry,signalEntry:candidate.entry,initialStop:stop,stop,signalTime:signalBar.time,entryTime:signalCloseTime,entryFillBarTime:fillBar.time,score:candidate.score,stopDistancePct:distance,ambiguousCandles:0,maxFavorableExcursionMarginPct:0,maxAdverseExcursionMarginPct:0,breakEvenActivated:false,setup:candidate.setup};
      let closed=false;
      for(let j=fillIndex;j<fiveMinute.length&&fiveMinute[j].time<toMs;j++){
        const bar=fiveMinute[j];
        if(candleAmbiguous(side,trade,bar))trade.ambiguousCandles++;
        const evaluated=evaluateTradeCandle(trade,{...bar,time:bar.time+INTERVALS["5m"]});
        if(evaluated.changed){
          if(evaluated.trade.status==="CLOSED_PROFIT")trade.maxFavorableExcursionMarginPct=Math.max(trade.maxFavorableExcursionMarginPct,TARGET);
          Object.assign(trade,evaluated.trade);trade.closedAtMs=bar.time+INTERVALS["5m"];closed=true;break;
        }
        if(bar.time!==fillBar.time){
          const excursion=excursionForBar(side,entry,bar);
          trade.maxFavorableExcursionMarginPct=Math.max(trade.maxFavorableExcursionMarginPct,excursion.favorable);
          trade.maxAdverseExcursionMarginPct=Math.max(trade.maxAdverseExcursionMarginPct,excursion.adverse);
        }
      }
      if(!closed){trade.status="OPEN_AT_BACKTEST_END";trade.lastMark=fiveMinute.at(-1)?.close??null;trade.marginReturnAtMarkPct=trade.lastMark?(side==="LONG"?1:-1)*((trade.lastMark-entry)/entry)*100*LEVERAGE:null;locks.set(lockKey,toMs);}
      else locks.set(lockKey,trade.closedAtMs);
      trades.push(trade);
    }
  }
  return {trades,opportunities,lockSkips};
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
  const entryOrders={placed:0,filled:0,expired:0,invalidated:0};
  let fourIndex = 0, fifteenIndex = 0;
  let eligibleSignalOpportunities = 0, skippedByLock = 0, rejectedSignals = 0, rejectedByHistoricalVolume = 0, rejectedStructuralStops = 0;
  const testStart = CONFIGURED_START_MS > 0 ? CONFIGURED_START_MS : toMs - DAYS * 86400000;

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
    const lockKey = ticker.symbol + "|" + candidate.side;
    if ((lockUntil.get(lockKey) || 0) > signalCloseTime) { skippedByLock++; continue; }

    const signalEntry = Number(candidate.entry);
    let stop=Number(candidate.stop), protectivePivot=null, structuralAtr15m=null;
    if(STRUCTURAL_STOP_MODE==="pivot15m"){
      protectivePivot=findLatestProtectivePivot(closed15m,candidate.side,2,2);
      structuralAtr15m=calculateAtrLocal(closed15m,14);
      if(!protectivePivot||!Number.isFinite(structuralAtr15m)||structuralAtr15m<=0){rejectedStructuralStops++;continue;}
      stop=candidate.side==="LONG"
        ? protectivePivot.price-structuralAtr15m*STRUCTURAL_STOP_BUFFER_ATR
        : protectivePivot.price+structuralAtr15m*STRUCTURAL_STOP_BUFFER_ATR;
    }

    const limitPrice = candidate.side==="LONG"
      ? signalEntry*(1-ENTRY_PULLBACK_PCT/100)
      : signalEntry*(1+ENTRY_PULLBACK_PCT/100);
    entryOrders.placed++;
    let fillIndex = lowerBound(fiveMinute,signalCloseTime);
    let entry = signalEntry, fillBar = null, fillTime = signalCloseTime;
    const expiresAt = signalCloseTime + FUTURES_CONFIG.SIGNAL_TTL_MINUTES*60000;
    if(ENTRY_PULLBACK_PCT>0){
      fillBar=null;
      for(let j=fillIndex;j<fiveMinute.length&&fiveMinute[j].time+INTERVALS["5m"]<=Math.min(expiresAt,toMs);j++){
        const bar=fiveMinute[j];
        const touched=candidate.side==="LONG"?bar.low<=limitPrice:bar.high>=limitPrice;
        if(!touched)continue;
        // A limit order receives price improvement if the 5m bar opens beyond its limit.
        entry=candidate.side==="LONG"?Math.min(limitPrice,bar.open):Math.max(limitPrice,bar.open);
        fillBar=bar;fillIndex=j;fillTime=bar.time;
        break;
      }
      if(!fillBar){entryOrders.expired++;continue;}
    } else {
      fillBar=fiveMinute[fillIndex]||null;
      if(!fillBar||fillBar.time>=toMs){entryOrders.expired++;continue;}
    }

    const directionValid=candidate.side==="LONG"?stop<entry:stop>entry;
    const stopDistancePct=Math.abs((entry-stop)/entry)*100;
    if(!directionValid||!Number.isFinite(stopDistancePct)||stopDistancePct<=0||stopDistancePct>8){
      entryOrders.invalidated++;
      continue;
    }
    entryOrders.filled++;
    const trade = {
      id: ticker.symbol + ":" + candidate.side + ":" + signalCloseTime,
      symbol: ticker.symbol, side: candidate.side, status: "OPEN",
      entry, signalEntry, requestedLimitPrice:ENTRY_PULLBACK_PCT>0?limitPrice:null,
      entryPullbackPct:ENTRY_PULLBACK_PCT, initialStop: stop, stop,
      protectivePivotPrice:protectivePivot?.price??null, structuralAtr15m,
      stopMode:STRUCTURAL_STOP_MODE,
      signalTime: signalBar.time, entryTime: fillTime,
      entryFillBarTime:fillBar.time,
      score: candidate.score, stopDistancePct, signalDiagnostics: signalDiagnostics(candidate,candidate.side,oneHour.slice(0,i+1),closed4h), ambiguousCandles: 0,
      maxFavorableExcursionMarginPct: 0, maxAdverseExcursionMarginPct: 0,
      breakEvenActivated: false
    };
    let candleIndex = ENTRY_PULLBACK_PCT>0?fillIndex:lowerBound(fiveMinute,signalCloseTime);
    let closed = false;
    for (; candleIndex < fiveMinute.length && fiveMinute[candleIndex].time < toMs; candleIndex++) {
      const bar = fiveMinute[candleIndex];
      if (bar.time < fillTime) continue;
      if (candleAmbiguous(candidate.side,trade,bar)) trade.ambiguousCandles++;
      const evaluated = evaluateTradeCandle(trade,{...bar,time:bar.time+INTERVALS["5m"]});
      if (evaluated.changed) {
        // Conservative: if the fill candle also touches the stop, count the fill and stop in that candle.
        if (evaluated.trade.status === "CLOSED_PROFIT") trade.maxFavorableExcursionMarginPct = Math.max(trade.maxFavorableExcursionMarginPct, TARGET);
        Object.assign(trade,evaluated.trade);
        trade.closedAtMs = bar.time + INTERVALS["5m"];
        closed = true;
        break;
      }
      // The fill candle is evaluated for stop/target safety, but its pre-fill path is unknowable; exclude it from MAE/MFE.
      if(bar.time!==fillTime){
        const excursion = excursionForBar(candidate.side,entry,bar);
        trade.maxFavorableExcursionMarginPct = Math.max(trade.maxFavorableExcursionMarginPct,excursion.favorable);
        trade.maxAdverseExcursionMarginPct = Math.max(trade.maxAdverseExcursionMarginPct,excursion.adverse);
      }
      if (BREAK_EVEN_TRIGGER > 0 && !trade.breakEvenActivated && trade.maxFavorableExcursionMarginPct >= BREAK_EVEN_TRIGGER) {
        trade.currentStop = entry;
        trade.breakEvenActivated = true;
      }
    }
    if (!closed) {
      trade.status = "OPEN_AT_BACKTEST_END";
      trade.lastMark = fiveMinute.at(-1)?.close ?? null;
      trade.marginReturnAtMarkPct = trade.lastMark ? (candidate.side==="LONG" ? 1 : -1) * ((trade.lastMark-entry)/entry) * 100 * LEVERAGE : null;
      lockUntil.set(lockKey,toMs);
    } else {
      lockUntil.set(lockKey,trade.closedAtMs);
    }
    trades.push(trade);
  }

  const independent=backtestIndependentEngines(ticker,oneHour,fourHour,fifteenMinute,fiveMinute,testStart,toMs);
  const periodBars=oneHour.filter(c=>c.time>=testStart&&c.time<toMs);
  const periodPriceChangePct=periodBars.length>1?(periodBars.at(-1).close/periodBars[0].open-1)*100:null;
  return {
    symbol:ticker.symbol,
    periodPriceChangePct,
    candles:{ "1h":oneHour.length, "4h":fourHour.length, "15m":fifteenMinute.length, "5m":fiveMinute.length },
    eligibleSignalOpportunities, skippedBySameSideLock:skippedByLock, rejectedSignals, rejectedByHistoricalVolume, rejectedStructuralStops,
    entryOrders, metrics:summarize(trades), trades
  };
}

async function main() {
  const configuredEndMs = Number(process.env.LIFECYCLE_BACKTEST_END_MS || 0);
  const endMs = Number.isFinite(configuredEndMs) && configuredEndMs > 0 ? configuredEndMs : Date.now();
  const startMs = CONFIGURED_START_MS > 0 ? CONFIGURED_START_MS : endMs - DAYS*86400000;
  const periodDays = (endMs-startMs)/86400000;
  const fromMs = startMs - WARMUP_DAYS*86400000;
  const tickerData = await getJson(BASE + "/derivatives/api/v3/tickers");
  if (!Array.isArray(tickerData?.tickers)) throw new Error("Kraken tickers response invalid");
  const allPerpetuals=tickerData.tickers.filter(t=>t?.tag==="perpetual"&&t.suspended!==true&&/^(PI|PF)_[A-Z0-9]+USD$/.test(String(t.symbol||""))&&Number(t.last)>0);
  const eligibleTickers=allPerpetuals.filter(t=>Number(t.volumeQuote)>=FUTURES_CONFIG.MIN_QUOTE_VOLUME);
  const bySymbol=new Map(allPerpetuals.map(t=>[t.symbol,t]));
  const universe=FIXED_SYMBOLS.length?FIXED_SYMBOLS.map(symbol=>bySymbol.get(symbol)).filter(Boolean)
    :eligibleTickers.sort((a,b)=>Number(b.volumeQuote)-Number(a.volumeQuote)).slice(0,SYMBOL_LIMIT);
  if (!universe.length) throw new Error("No eligible Kraken perpetual contracts found");

  const results = [];
  for (const ticker of universe) {
    try { results.push(await backtestSymbol(ticker,fromMs,endMs)); }
    catch (error) { results.push({symbol:ticker.symbol,error:String(error?.message||error)}); }
  }
  const successful = results.filter(r=>!r.error);
  const allTrades = successful.flatMap(r=>r.trades).sort((a,b)=>(a.closedAtMs||Number.MAX_SAFE_INTEGER)-(b.closedAtMs||Number.MAX_SAFE_INTEGER));
  const metrics = summarize(allTrades);
  const independentTrades=successful.flatMap(r=>r.independentTrades||[]).sort((a,b)=>(a.closedAtMs||Number.MAX_SAFE_INTEGER)-(b.closedAtMs||Number.MAX_SAFE_INTEGER));
  const independentMetrics=summarize(independentTrades);
  const engineComparison={currentLong:{...metrics.bySide.LONG},independentLong:{...independentMetrics.bySide.LONG},currentShort:{...metrics.bySide.SHORT},independentShort:{...independentMetrics.bySide.SHORT}};
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
    period:{from:new Date(startMs).toISOString(),to:new Date(endMs).toISOString(),days:periodDays,warmupDays:WARMUP_DAYS},
    rules:{leverage:LEVERAGE,targetMarginReturnPct:TARGET,requiredFavorablePriceMovePct:TARGET/LEVERAGE,
      exit:"close only at +30% margin return or configured stop",tp1Tp2Tp3:"ignored for closing",
      candleResolution:"5m",sameCandleAmbiguity:"stop-first unless a gap at candle open proves one level was reached first",
      fees:"excluded by user-defined gross price-move × leverage model",funding:"excluded",
      execution:"one evaluation per completed 1h candle; signal generated from closed 1h/4h/15m candles; entry approximated at next 1h open; exits evaluated on subsequent 5m OHLC",
      breakEvenTriggerMarginPct: BREAK_EVEN_TRIGGER,
      breakEvenRule: BREAK_EVEN_TRIGGER > 0 ? "after a completed 5m candle reaches the configured favorable margin return, move stop to entry for subsequent candles" : "disabled",
      structuralStopMode:STRUCTURAL_STOP_MODE, structuralStopBufferAtr15m:STRUCTURAL_STOP_BUFFER_ATR,
      entryPullbackPct:ENTRY_PULLBACK_PCT, entryOrderExpiryMinutes:FUTURES_CONFIG.SIGNAL_TTL_MINUTES,
      entryExecutionRule:ENTRY_PULLBACK_PCT>0?"limit at signal entry adjusted by pullback; fill only if a subsequent 5m candle touches within the live 60-minute signal TTL; price improvement at candle open; unfilled orders expire; same-candle fill/stop is counted conservatively as a filled stop":"market-style baseline at next 1h open; no limit wait",
      structuralStopPivotRule:"latest confirmed 15m protective swing pivot with 2 candles left/right; LONG uses swing low, SHORT uses swing high",
      positionSizingModel:"fixed risk per trade; normalized return = realized price move / initial stop distance × risk percentage; additive, not compounded; aggregate simultaneous open risk is not capped",
      scheduler:"live Worker cron is every 5 minutes; this runner does not yet replay each 5-minute scan, so repeated intra-hour scan/TTL behavior is not represented",
      lifecycleSemantics:"the live Durable Object creates a SIGNAL_EVALUATION trade when a signal is registered; this is not evidence of a user accepting or an exchange order filling",
      lock:"independent symbol+side lock until close; opposite side may overlap",
      universe:"top current Kraken perpetuals by current quote volume; survivorship bias applies",
      historicalVolumeFilter:"per-signal rolling 24h estimate = sum(hourly base volume × hourly close); approximate quote turnover, not exact exchange ticker volume",},
    symbolsRequested:SYMBOL_LIMIT,symbolsTested:successful.length,symbolErrors:results.filter(r=>r.error),
    metrics,independentMetrics,engineComparison,independentOpportunities:{LONG:successful.reduce((n,r)=>n+(r.independentOpportunities?.LONG||0),0),SHORT:successful.reduce((n,r)=>n+(r.independentOpportunities?.SHORT||0),0)},independentLockSkips:{LONG:successful.reduce((n,r)=>n+(r.independentLockSkips?.LONG||0),0),SHORT:successful.reduce((n,r)=>n+(r.independentLockSkips?.SHORT||0),0)},diagnosticSummary,eligibleSignalOpportunities:successful.reduce((n,r)=>n+r.eligibleSignalOpportunities,0),
    bySymbol:successful.map(({trades,...r})=>({...r,metrics:r.metrics})),
    lockSkips:successful.reduce((n,r)=>n+r.skippedBySameSideLock,0),
    rejectedSignals:successful.reduce((n,r)=>n+r.rejectedSignals,0),
    rejectedByHistoricalVolume:successful.reduce((n,r)=>n+r.rejectedByHistoricalVolume,0),
    rejectedStructuralStops:successful.reduce((n,r)=>n+r.rejectedStructuralStops,0),
    entryOrders:successful.reduce((a,r)=>({placed:a.placed+r.entryOrders.placed,filled:a.filled+r.entryOrders.filled,expired:a.expired+r.entryOrders.expired,invalidated:a.invalidated+r.entryOrders.invalidated}),{placed:0,filled:0,expired:0,invalidated:0}),
    trades:allTrades
  };
  await mkdir("artifacts",{recursive:true});
  await writeFile("artifacts/futures-lifecycle-backtest.json",JSON.stringify(report,null,2));
  const rows = [
    "# Futures lifecycle historical backtest","",
    "Period: "+report.period.from+" — "+report.period.to+" ("+report.period.days+" days)",
    "Symbols tested: "+report.symbolsTested+"/"+SYMBOL_LIMIT,"",
    "| Metric | Result |","|---|---:|",
    "| Eligible signal opportunities (before lock) | "+report.eligibleSignalOpportunities+" |",
    "| Signal-evaluation lifecycles started (not exchange fills) | "+metrics.tradesStarted+" |",
    "| Entry orders placed / filled / expired / invalidated | "+report.entryOrders.placed+" / "+report.entryOrders.filled+" / "+report.entryOrders.expired+" / "+report.entryOrders.invalidated+" |",
    "| Entry fill rate | "+(report.entryOrders.placed?((report.entryOrders.filled/report.entryOrders.placed)*100).toFixed(2):"0.00")+"% |",
    "| Closed trades | "+metrics.closedTrades+" |",
    "| Profit closes (+30% margin) | "+metrics.profitCloses+" |",
    "| Stop closes (including break-even exits) | "+metrics.stopCloses+" |",
    "| Loss stop closes | "+metrics.lossStopCloses+" |",
    "| Break-even activated trades | "+metrics.breakEvenActivatedTrades+" |",
    "| Break-even exits | "+metrics.breakEvenStopCloses+" |",
    "| Open at end | "+metrics.openAtEnd+" |",
    "| LONG / SHORT signals issued | "+metrics.bySide.LONG.signalsIssued+" / "+metrics.bySide.SHORT.signalsIssued+" |",
    "| LONG profit / stop / open | "+metrics.bySide.LONG.profitCloses+" / "+metrics.bySide.LONG.stopCloses+" / "+metrics.bySide.LONG.openAtEnd+" |",
    "| SHORT profit / stop / open | "+metrics.bySide.SHORT.profitCloses+" / "+metrics.bySide.SHORT.stopCloses+" / "+metrics.bySide.SHORT.openAtEnd+" |",
    "| LONG win rate | "+metrics.bySide.LONG.winRatePct.toFixed(2)+"% |",
    "| SHORT win rate | "+metrics.bySide.SHORT.winRatePct.toFixed(2)+"% |",
    "| Win rate | "+metrics.winRatePct.toFixed(2)+"% |",
    "| Sum margin return (not compounded) | "+metrics.totalMarginReturnPct.toFixed(2)+"% |",
    "| Average margin return / trade | "+metrics.averageMarginReturnPct.toFixed(2)+"% |",
    "| Max drawdown (additive margin-return points) | "+metrics.maxDrawdownMarginPct.toFixed(2)+"% |",
    "| Risk-normalized return (fixed "+RISK_PER_TRADE_PCT+"% risk/trade, additive) | "+metrics.totalRiskSizedReturnPct.toFixed(2)+"% |",
    "| Risk-normalized max drawdown (additive) | "+metrics.maxRiskSizedDrawdownPct.toFixed(2)+"% |",
    "| Ambiguous 5m candles | "+metrics.ambiguous5mCandles+" |",
    "", "## Independent engines versus current strategy",
    "| Engine | Signals started | Closed | Wins | Stops | Win rate | Net margin return | Max drawdown |",
    "|---|---:|---:|---:|---:|---:|---:|---:|",
    ...[["Current LONG",metrics.bySide.LONG],["Independent LONG",independentMetrics.bySide.LONG],["Current SHORT",metrics.bySide.SHORT],["Independent SHORT",independentMetrics.bySide.SHORT]].map(([name,m])=>"| "+name+" | "+m.signalsIssued+" | "+m.closedTrades+" | "+m.profitCloses+" | "+m.stopCloses+" | "+m.winRatePct.toFixed(2)+"% | "+m.marginReturnPct.toFixed(2)+"% | "+(name.startsWith("Independent")?summarize(independentTrades.filter(t=>t.side=== (name.endsWith("LONG")?"LONG":"SHORT"))).maxDrawdownMarginPct:summarize(allTrades.filter(t=>t.side===(name.endsWith("LONG")?"LONG":"SHORT"))).maxDrawdownMarginPct).toFixed(2)+"% |"),
    "| Same-side lock skips | "+report.lockSkips+" |",
    "| Rejected signal opportunities | "+report.rejectedSignals+" |",
    "| Rejected by historical 24h volume | "+report.rejectedByHistoricalVolume+" |",
    "| Rejected by structural stop validity | "+report.rejectedStructuralStops+" |","",
    "| Symbol | Signals | Closed | Profit | Stop | LONG | SHORT | Net margin % |",
    "|---|---:|---:|---:|---:|---:|---:|---:|",
    ...successful.map(r=>"| "+r.symbol+" | "+r.eligibleSignalOpportunities+" | "+r.metrics.closedTrades+" | "+r.metrics.profitCloses+" | "+r.metrics.stopCloses+" | "+r.metrics.longs+" | "+r.metrics.shorts+" | "+r.metrics.totalMarginReturnPct.toFixed(2)+" |"),
    "", "Limitations: scan cadence/TTL and actual user acceptance are not replayed; each signal-evaluation lifecycle is not an exchange fill. Historical quote turnover is approximated from hourly base volume × close; current-contract universe still has survivorship bias. 5m OHLC cannot identify intrabar path; ambiguous candles use stop-first. Stop execution is assumed at the stop or gap open. Liquidation, funding, fees, and slippage are excluded. Universe selection uses current volume, so survivorship bias applies.",
    "", "Symbol errors:", ...report.symbolErrors.map(x=>"- "+x.symbol+": "+x.error)
  ];
  await writeFile("artifacts/futures-lifecycle-backtest.md",rows.join("\n"));
  console.log(JSON.stringify({ok:successful.length>0,period:report.period,metrics,independentMetrics,engineComparison,independentOpportunities:report.independentOpportunities,diagnosticSummary,entryOrders:report.entryOrders,symbols:report.bySymbol,symbolErrors:report.symbolErrors,lockSkips:report.lockSkips,rejectedSignals:report.rejectedSignals,rejectedStructuralStops:report.rejectedStructuralStops},null,2));
  if (!successful.length) process.exitCode=1;
}
main().catch(error=>{console.error(error);process.exitCode=1;});

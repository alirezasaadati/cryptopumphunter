import { analyzeFuturesSymbol, FUTURES_CONFIG } from "../src/index.js";
import { mkdir, writeFile } from "node:fs/promises";

const BASE = "https://futures.kraken.com";
const HOUR = 60 * 60 * 1000;
const FOUR_HOURS = 4 * HOUR;
const FIFTEEN_MINUTES = 15 * 60 * 1000;
const DAYS = 60;
const FEE_PER_SIDE = 0.0005;
const SLIPPAGE_PER_SIDE = 0.0003;
const SYMBOL = "PF_XBTUSD";

async function getJson(url) {
  const response = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(25000) });
  const body = await response.text();
  if (!response.ok) throw new Error("HTTP " + response.status + " for " + url + ": " + body.slice(0, 180));
  const data = JSON.parse(body);
  if (data?.result === "error" || (Array.isArray(data?.errors) && data.errors.length)) {
    throw new Error("Kraken API error: " + JSON.stringify(data.errors || data.error));
  }
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

function simulateTrade({ side, entry, stop, target, candles, fee = FEE_PER_SIDE, slippage = SLIPPAGE_PER_SIDE }) {
  const direction = side === "LONG" ? 1 : -1;
  const risk = direction === 1 ? entry - stop : stop - entry;
  if (!(risk > 0) || !Number.isFinite(risk)) throw new Error("Invalid trade risk");
  for (const bar of candles) {
    const stopGap = direction === 1 ? bar.open <= stop : bar.open >= stop;
    const stopTouched = direction === 1 ? bar.low <= stop : bar.high >= stop;
    const targetTouched = direction === 1 ? bar.high >= target : bar.low <= target;
    // Conservative OHLC rule: if stop and target are both touched in one candle, count stop first.
    if (stopGap || stopTouched) {
      const rawExit = stopGap ? bar.open : stop;
      const fill = rawExit * (1 - direction * slippage);
      const netR = direction * (fill - entry) / risk - fee * (entry + fill) / risk;
      return { outcome:"STOP", exitTime:bar.time, exitPrice:fill, netR };
    }
    if (targetTouched) {
      const fill = target * (1 - direction * slippage);
      const netR = direction * (fill - entry) / risk - fee * (entry + fill) / risk;
      return { outcome:"TP1", exitTime:bar.time, exitPrice:fill, netR };
    }
  }
  return { outcome:"OPEN_AT_DATA_END", exitTime:null, exitPrice:null, netR:null };
}

async function main() {
  const endMs = Date.now();
  const startMs = endMs - DAYS * 24 * HOUR;
  // Extra warm-up history is needed for the 4h/1h/15m structure calculations.
  const fetchFromMs = startMs - 20 * 24 * HOUR;
  const [oneHour, fourHour, fifteenMinute] = await Promise.all([
    fetchHistoricalCandles(SYMBOL,"1h",fetchFromMs,endMs,HOUR),
    fetchHistoricalCandles(SYMBOL,"4h",fetchFromMs,endMs,FOUR_HOURS),
    fetchHistoricalCandles(SYMBOL,"15m",fetchFromMs,endMs,FIFTEEN_MINUTES)
  ]);
  if (oneHour.length < 100 || fourHour.length < FUTURES_CONFIG.MIN_CANDLES || fifteenMinute.length < 120) {
    throw new Error("Insufficient candles: 1h=" + oneHour.length + ", 4h=" + fourHour.length + ", 15m=" + fifteenMinute.length);
  }

  const results = [];
  let nextAvailableIndex = 60;
  let fifteenIndex = 0;
  let signalCandidates = 0;
  let rejectedCandidates = 0;
  const rejectReasons = {};

  for (let i=60; i<oneHour.length-1; i++) {
    const signalBar = oneHour[i];
    const signalCloseTime = signalBar.time + HOUR;
    if (signalCloseTime < startMs) continue;
    const closed4h = fourHour.filter(c => c.time + FOUR_HOURS <= signalCloseTime);
    if (closed4h.length < FUTURES_CONFIG.MIN_CANDLES) continue;
    while (fifteenIndex < fifteenMinute.length && fifteenMinute[fifteenIndex].time + FIFTEEN_MINUTES <= signalCloseTime) fifteenIndex++;
    const closed15m = fifteenMinute.slice(Math.max(0,fifteenIndex-120),fifteenIndex);
    const nextBar = oneHour[i+1];
    const ticker = {
      symbol:SYMBOL,
      last:nextBar.open,
      quoteVolume:0,
      priceChangePercent:historicalChange(oneHour,i),
      premium:{lastFundingRate:null}
    };
    const candidate = analyzeFuturesSymbol(ticker,oneHour.slice(0,i+1),closed4h,closed15m);
    if (!candidate || (!candidate.eligible && !candidate.experimentalEligible)) {
      if (candidate?.rejected) {
        rejectedCandidates++;
        rejectReasons[candidate.rejected]=(rejectReasons[candidate.rejected]||0)+1;
      }
      continue;
    }
    signalCandidates++;
    if (i < nextAvailableIndex) continue;

    const direction = candidate.side === "LONG" ? 1 : -1;
    const entry = candidate.entry * (1 + direction * SLIPPAGE_PER_SIDE);
    // The production engine supplies target1 at 1.5R. Verify this per signal to prevent a stale setup.
    const initialRisk = direction === 1 ? candidate.entry - candidate.stop : candidate.stop - candidate.entry;
    const targetR = direction * (candidate.target1 - candidate.entry) / initialRisk;
    if (Math.abs(targetR - 1.5) > 1e-8) {
      throw new Error("Unexpected TP1 multiple " + targetR + " on " + new Date(signalBar.time).toISOString());
    }
    const trade = simulateTrade({
      side:candidate.side,
      entry,
      stop:candidate.stop,
      target:candidate.target1,
      candles:oneHour.slice(i+1),
    });
    results.push({
      symbol:SYMBOL,
      side:candidate.side,
      signalTime:signalBar.time,
      entryTime:nextBar.time,
      entry,
      stop:candidate.stop,
      target1:candidate.target1,
      targetR,
      outcome:trade.outcome,
      exitTime:trade.exitTime,
      exitPrice:trade.exitPrice,
      netR:trade.netR
    });
    if (trade.exitTime == null) {
      nextAvailableIndex = oneHour.length;
    } else {
      const exitIndex = oneHour.findIndex(c=>c.time===trade.exitTime);
      nextAvailableIndex = Math.max(i+1,exitIndex+1);
    }
  }

  const tp1 = results.filter(t=>t.outcome==="TP1");
  const stops = results.filter(t=>t.outcome==="STOP");
  const open = results.filter(t=>t.outcome==="OPEN_AT_DATA_END");
  const closed = results.filter(t=>t.outcome!=="OPEN_AT_DATA_END");
  const report = {
    generatedAt:new Date().toISOString(),
    venue:"Kraken Derivatives public historical OHLC candles",
    symbol:SYMBOL,
    period:{from:new Date(startMs).toISOString(),to:new Date(endMs).toISOString(),days:DAYS},
    strategy:{target:"single TP1 = 1.5R, 100% position closed",breakoutDistanceMaxPct:0.3,entry:"next 1h candle open with adverse slippage",stop:"current engine stop",maxHoldingPeriod:"none; position followed until TP1/SL or end of dataset"},
    simulation:{timeframeForOutcome:"1h OHLC",feePerSidePct:FEE_PER_SIDE*100,slippagePerSidePct:SLIPPAGE_PER_SIDE*100,sameCandleRule:"stop first (conservative)",funding:"excluded",overlap:"one active position at a time"},
    candles:{oneHour:oneHour.length,fourHour:fourHour.length,fifteenMinute:fifteenMinute.length},
    counts:{
      eligibleSignalCandidates:signalCandidates,
      executedTrades:results.length,
      tp1Hits:tp1.length,
      directStops:stops.length,
      stillOpenAtDataEnd:open.length,
      closedTrades:closed.length,
      long:results.filter(t=>t.side==="LONG").length,
      short:results.filter(t=>t.side==="SHORT").length,
      tp1HitPct:closed.length?tp1.length/closed.length*100:0,
      stopPct:closed.length?stops.length/closed.length*100:0,
      rejectedCandidates,
      rejectReasons
    },
    performance:{
      netR:closed.reduce((s,t)=>s+(t.netR||0),0),
      averageRPerClosedTrade:closed.length?closed.reduce((s,t)=>s+(t.netR||0),0)/closed.length:0,
      averageTp1NetR:tp1.length?tp1.reduce((s,t)=>s+t.netR,0)/tp1.length:0,
      averageStopNetR:stops.length?stops.reduce((s,t)=>s+t.netR,0)/stops.length:0
    },
    trades:results
  };
  await mkdir("artifacts",{recursive:true});
  await writeFile("artifacts/btc-single-tp-1-5r-backtest.json",JSON.stringify(report,null,2));
  const md = [
    "# BTC historical backtest — single TP1 1.5R",
    "",
    "Period: "+report.period.from+" to "+report.period.to+" ("+DAYS+" days)",
    "Symbol: "+SYMBOL,
    "Executed trades: "+results.length,
    "",
    "| Outcome | Count |",
    "|---|---:|",
    "| TP1 1.5R hit | "+tp1.length+" |",
    "| Direct stop loss | "+stops.length+" |",
    "| Still open at data end | "+open.length+" |",
    "| Closed trades | "+closed.length+" |",
    "",
    "TP1 hit rate among closed trades: "+report.counts.tp1HitPct.toFixed(2)+"%",
    "Stop rate among closed trades: "+report.counts.stopPct.toFixed(2)+"%",
    "",
    "Assumptions: Kraken BTC perpetual, 1h OHLC for outcome detection; one active position at a time; 0.05% fee and 0.03% slippage per side; no funding; no max holding time; if TP and SL are both touched in the same 1h candle, SL is counted first. Open trades at the end are not classified as TP1 or SL."
  ].join("\n");
  await writeFile("artifacts/btc-single-tp-1-5r-backtest.md",md);
  console.log(JSON.stringify({ok:true,period:report.period,counts:report.counts,performance:report.performance,candles:report.candles},null,2));
}

main().catch(error=>{console.error(error);process.exitCode=1;});

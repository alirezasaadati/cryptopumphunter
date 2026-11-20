import { analyzeFuturesSymbol, FUTURES_CONFIG } from "../src/index.js";
import { mkdir, writeFile } from "node:fs/promises";

const BASE = "https://futures.kraken.com";
const HOUR = 60 * 60 * 1000;
const FOUR_HOURS = 4 * HOUR;
const FIFTEEN_MINUTES = 15 * 60 * 1000;
const DAYS = Number(process.env.BACKTEST_DAYS || 60);
const FEE_PER_SIDE = Number(process.env.BACKTEST_FEE || 0.0005);
const SLIPPAGE_PER_SIDE = Number(process.env.BACKTEST_SLIPPAGE || 0.0003);
const SYMBOLS = (process.env.BACKTEST_SYMBOLS || "PF_XBTUSD,PF_ETHUSD,PF_SOLUSD,PF_XRPUSD,PF_DOGEUSD,PF_ADAUSD,PF_LINKUSD,PF_LTCUSD,PF_BCHUSD,PF_AVAXUSD")
  .split(",").map(s => s.trim()).filter(Boolean);

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

function simulateTrade({ side, entry, stop, target, candles }) {
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
      const fill = rawExit * (1 - direction * SLIPPAGE_PER_SIDE);
      const netR = direction * (fill - entry) / risk - FEE_PER_SIDE * (entry + fill) / risk;
      return { outcome:"STOP", exitTime:bar.time, exitPrice:fill, netR };
    }
    if (targetTouched) {
      const fill = target * (1 - direction * SLIPPAGE_PER_SIDE);
      const netR = direction * (fill - entry) / risk - FEE_PER_SIDE * (entry + fill) / risk;
      return { outcome:"30% margin target", exitTime:bar.time, exitPrice:fill, netR };
    }
  }
  return { outcome:"OPEN_AT_DATA_END", exitTime:null, exitPrice:null, netR:null };
}

async function backtestSymbol(symbol, startMs, endMs) {
  const fetchFromMs = startMs - 20 * 24 * HOUR;
  const [oneHour, fourHour, fifteenMinute] = await Promise.all([
    fetchHistoricalCandles(symbol,"1h",fetchFromMs,endMs,HOUR),
    fetchHistoricalCandles(symbol,"4h",fetchFromMs,endMs,FOUR_HOURS),
    fetchHistoricalCandles(symbol,"15m",fetchFromMs,endMs,FIFTEEN_MINUTES)
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
      symbol,
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
    // 30% ROI on 10x margin = 3% underlying price movement from executable entry.
    const target30 = entry * (1 + direction * 0.03);
    const initialRisk = direction === 1 ? entry - candidate.stop : candidate.stop - entry;
    const targetR = direction * (target30 - entry) / initialRisk;
    const trade = simulateTrade({
      side:candidate.side, entry, stop:candidate.stop, target:target30,
      candles:oneHour.slice(i+1)
    });
    results.push({
      symbol, side:candidate.side, signalTime:signalBar.time, entryTime:nextBar.time,
      entry, stop:candidate.stop, target30, targetR, outcome:trade.outcome,
      exitTime:trade.exitTime, exitPrice:trade.exitPrice, netR:trade.netR
    });
    if (trade.exitTime == null) {
      nextAvailableIndex = oneHour.length;
    } else {
      const exitIndex = oneHour.findIndex(c=>c.time===trade.exitTime);
      nextAvailableIndex = Math.max(i+1,exitIndex+1);
    }
  }

  const targets = results.filter(t=>t.outcome==="30% margin target");
  const stops = results.filter(t=>t.outcome==="STOP");
  const open = results.filter(t=>t.outcome==="OPEN_AT_DATA_END");
  const closed = results.filter(t=>t.outcome!=="OPEN_AT_DATA_END");
  const pnl = t => t.netR * (Math.abs(t.entry-t.stop)/t.entry) * 100;
  return {
    symbol,
    candles:{oneHour:oneHour.length,fourHour:fourHour.length,fifteenMinute:fifteenMinute.length},
    counts:{
      eligibleSignalCandidates:signalCandidates, executedTrades:results.length,
      target30Hits:targets.length, directStops:stops.length, stillOpenAtDataEnd:open.length,
      closedTrades:closed.length, long:results.filter(t=>t.side==="LONG").length,
      short:results.filter(t=>t.side==="SHORT").length,
      rejectedCandidates, rejectReasons
    },
    performance:{
      wins:closed.filter(t=>t.netR>0).length,
      losses:closed.filter(t=>t.netR<0).length,
      grossProfitUsd:closed.filter(t=>t.netR>0).reduce((s,t)=>s+pnl(t),0),
      grossLossUsd:Math.abs(closed.filter(t=>t.netR<0).reduce((s,t)=>s+pnl(t),0)),
      netPnlUsd:closed.reduce((s,t)=>s+pnl(t),0),
      profitFactor:(()=>{const gp=closed.filter(t=>t.netR>0).reduce((s,t)=>s+pnl(t),0);const gl=Math.abs(closed.filter(t=>t.netR<0).reduce((s,t)=>s+pnl(t),0));return gl?gp/gl:null;})()
    },
    trades:results
  };
}

async function main() {
  if (!SYMBOLS.length) throw new Error("BACKTEST_SYMBOLS is empty");
  const endMs = Date.now();
  const startMs = endMs - DAYS * 24 * HOUR;
  const perSymbol = [];
  const failures = [];

  // Sequential symbol processing reduces the chance of hitting Kraken rate limits.
  for (const symbol of SYMBOLS) {
    console.log("Starting " + symbol);
    try {
      const report = await backtestSymbol(symbol,startMs,endMs);
      perSymbol.push(report);
      console.log(JSON.stringify({symbol,counts:report.counts,performance:report.performance}));
    } catch (error) {
      failures.push({symbol,error:String(error?.message || error)});
      console.error("FAILED " + symbol + ": " + String(error?.message || error));
    }
  }

  const trades = perSymbol.flatMap(r=>r.trades);
  const closed = trades.filter(t=>t.outcome!=="OPEN_AT_DATA_END");
  const targets = trades.filter(t=>t.outcome==="30% margin target");
  const stops = trades.filter(t=>t.outcome==="STOP");
  const pnl = t => t.netR * (Math.abs(t.entry-t.stop)/t.entry) * 100;
  const grossProfitUsd = closed.filter(t=>t.netR>0).reduce((s,t)=>s+pnl(t),0);
  const grossLossUsd = Math.abs(closed.filter(t=>t.netR<0).reduce((s,t)=>s+pnl(t),0));
  const report = {
    generatedAt:new Date().toISOString(),
    venue:"Kraken Derivatives public historical OHLC candles",
    symbolsRequested:SYMBOLS,
    symbolsTested:perSymbol.map(r=>r.symbol),
    failures,
    period:{from:new Date(startMs).toISOString(),to:new Date(endMs).toISOString(),days:DAYS},
    strategy:{
      target:"single target = +30% ROI on 10x margin (3.0% underlying move), 100% position closed",
      leverage:10,targetMarginRoiPct:30,targetUnderlyingMovePct:3,
      entry:"next 1h candle open with adverse slippage",stop:"current engine stop",
      maxHoldingPeriod:"none; position followed until target/SL or end of dataset",
      engine:"analyzeFuturesSymbol imported unchanged from src/index.js"
    },
    simulation:{
      timeframeForOutcome:"1h OHLC",feePerSidePct:FEE_PER_SIDE*100,
      slippagePerSidePct:SLIPPAGE_PER_SIDE*100,
      sameCandleRule:"stop first (conservative)",funding:"excluded",
      overlap:"one active position per symbol; positions across different symbols may overlap",
      pnlAssumption:"fixed $100 notional per trade ($10 margin at 10x); PnL is normalized per trade"
    },
    counts:{
      symbolsTested:perSymbol.length,symbolsFailed:failures.length,
      eligibleSignalCandidates:perSymbol.reduce((s,r)=>s+r.counts.eligibleSignalCandidates,0),
      executedTrades:trades.length,target30Hits:targets.length,directStops:stops.length,
      stillOpenAtDataEnd:trades.filter(t=>t.outcome==="OPEN_AT_DATA_END").length,
      closedTrades:closed.length,long:trades.filter(t=>t.side==="LONG").length,
      short:trades.filter(t=>t.side==="SHORT").length,
      wins:closed.filter(t=>t.netR>0).length,losses:closed.filter(t=>t.netR<0).length
    },
    performance:{
      grossProfitUsd,grossLossUsd,netPnlUsd:closed.reduce((s,t)=>s+pnl(t),0),
      profitFactor:grossLossUsd?grossProfitUsd/grossLossUsd:null,
      targetHitPct:closed.length?targets.length/closed.length*100:0
    },
    perSymbol:perSymbol.map(({trades,...r})=>r),
    trades
  };

  await mkdir("artifacts",{recursive:true});
  await writeFile("artifacts/multi-symbol-single-target-30-margin-backtest.json",JSON.stringify(report,null,2));
  const md = [
    "# Multi-symbol futures backtest — single 30% margin ROI target",
    "",
    "Period: "+report.period.from+" to "+report.period.to+" ("+DAYS+" days)",
    "Requested symbols: "+SYMBOLS.join(", "),
    "Successfully tested: "+perSymbol.map(r=>r.symbol).join(", "),
    "Failed symbols: "+(failures.map(f=>f.symbol+": "+f.error).join("; ") || "None"),
    "",
    "| Symbol | Trades | Target | Stops | Open | Net PnL ($) | PF |",
    "|---|---:|---:|---:|---:|---:|---:|",
    ...perSymbol.map(r=>"| "+r.symbol+" | "+r.counts.executedTrades+" | "+r.counts.target30Hits+" | "+r.counts.directStops+" | "+r.counts.stillOpenAtDataEnd+" | "+r.performance.netPnlUsd.toFixed(2)+" | "+(r.performance.profitFactor==null?"—":r.performance.profitFactor.toFixed(2))+" |"),
    "",
    "| Aggregate metric | Result |",
    "|---|---:|",
    "| Executed trades | "+report.counts.executedTrades+" |",
    "| Long / Short | "+report.counts.long+" / "+report.counts.short+" |",
    "| Target hits | "+report.counts.target30Hits+" |",
    "| Stops | "+report.counts.directStops+" |",
    "| Still open | "+report.counts.stillOpenAtDataEnd+" |",
    "| Gross profit | $"+grossProfitUsd.toFixed(2)+" |",
    "| Gross loss | $"+grossLossUsd.toFixed(2)+" |",
    "| Net PnL | $"+report.performance.netPnlUsd.toFixed(2)+" |",
    "| Profit factor | "+(report.performance.profitFactor==null?"—":report.performance.profitFactor.toFixed(2))+" |",
    "",
    "Assumptions: current engine imported unchanged; one full-position target at +30% ROI on 10x margin (3% underlying move); current engine stop; next 1h candle open entry with adverse slippage; 0.05% fee and 0.03% slippage per side; no funding; one active position per symbol; positions across symbols may overlap; stop-first if target and stop are both touched in one 1h candle; no maximum holding period. PnL assumes $100 notional / $10 margin per trade."
  ].join("\n");
  await writeFile("artifacts/multi-symbol-single-target-30-margin-backtest.md",md);
  console.log("FINAL_REPORT");
  console.log(JSON.stringify({period:report.period,symbolsTested:report.symbolsTested,failures,counts:report.counts,performance:report.performance,perSymbol:report.perSymbol.map(r=>({symbol:r.symbol,counts:r.counts,performance:r.performance}))},null,2));
  if (!perSymbol.length) throw new Error("No symbols completed successfully");
}

main().catch(error=>{console.error(error);process.exitCode=1;});

// Isolated backtest harness for the exact user-supplied v7.1.1 LONG Hybrid rules.
// Strategy conditions and configuration are copied without optimization.
// Only execution simulation, historical data loading, and reporting are added.
import { mkdir, writeFile } from "node:fs/promises";

const API = "https://futures.kraken.com/api/charts/v1/trade/";
const H1 = 60 * 60 * 1000;
const H4 = 4 * H1;
const SYMBOLS = [
  "PF_XBTUSD", "PF_ETHUSD", "PF_SOLUSD", "PF_XRPUSD", "PF_DOGEUSD",
  "PF_ADAUSD", "PF_LINKUSD", "PF_LTCUSD", "PF_BCHUSD", "PF_AVAXUSD"
];
const CFG = {
  MIN_CANDLES: 200, TARGET_1_R: 1.5, TARGET_2_R: 2.5,
  STOP_BUFFER_ATR: 0.2, MAX_RISK_PCT: 2.5
};
const FEE_PER_SIDE = 0.0005;
const SLIPPAGE_PER_SIDE = 0.0003;

function ema(values, period) {
  if (values.length < period) return null;
  const multiplier = 2 / (period + 1);
  let value = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) value = values[i] * multiplier + value * (1 - multiplier);
  return value;
}
function rsi(values, period = 14) {
  if (values.length <= period) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const change = values[i] - values[i - 1];
    gains += Math.max(change, 0); losses += Math.max(-change, 0);
  }
  let avgGain = gains / period, avgLoss = losses / period;
  for (let i = period + 1; i < values.length; i++) {
    const change = values[i] - values[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(change, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-change, 0)) / period;
  }
  if (avgLoss === 0) return 100;
  if (avgGain === 0) return 0;
  return 100 - 100 / (1 + avgGain / avgLoss);
}
function average(values) {
  if (!values.length) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}
function calculateAtr(candles, period = 14) {
  if (candles.length <= period) return null;
  const ranges = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], prevClose = candles[i - 1].close;
    ranges.push(Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose)));
  }
  return average(ranges.slice(-period));
}
function isBtcMacroBullish(btcCandles4h) {
  if (!btcCandles4h || btcCandles4h.length < 60) return false;
  const closes = btcCandles4h.map(c => c.close);
  const currentClose = closes[closes.length - 1];
  const ema50 = ema(closes, 50);
  const ema50Past = ema(closes.slice(0, -5), 50);
  if (!ema50 || !ema50Past) return false;
  return currentClose > ema50 && ema50 > ema50Past;
}
// Exact signal rules from analyzeLongHybrid, with backtestEntryOpen set to next bar open.
function analyzeLongHybrid(candles1h, btcCandles4h, backtestEntryOpen) {
  if (candles1h.length < CFG.MIN_CANDLES) return { rejected: "INSUFFICIENT_HISTORY" };
  if (!isBtcMacroBullish(btcCandles4h)) return { rejected: "BTC_MACRO" };
  const closes = candles1h.map(c => c.close);
  const last = candles1h[candles1h.length - 1], prev = candles1h[candles1h.length - 2];
  const e20 = ema(closes, 20), e50 = ema(closes, 50), e200 = ema(closes, 200);
  const rsiValue = rsi(closes, 14), atr = calculateAtr(candles1h, 14);
  if ([e20, e50, e200, rsiValue, atr].some(v => !Number.isFinite(v))) return { rejected: "BAD_INDICATOR" };
  let mode = null, score = 70, stopPrice = null;
  const isTrendUp = e20 > e50 && last.close > e20;
  if (isTrendUp && rsiValue > 45 && rsiValue < 75) {
    mode = "TREND"; score = 75;
    const recentLows = candles1h.slice(-7).map(c => c.low);
    stopPrice = Math.min(...recentLows) - atr * CFG.STOP_BUFFER_ATR;
  } else if (rsiValue < 35 && last.close > e200) {
    mode = "REVERSION"; score = 80;
    stopPrice = prev.low - atr * CFG.STOP_BUFFER_ATR;
  } else return { rejected: "NO_SETUP" };
  const entry = backtestEntryOpen;
  const risk = entry - stopPrice, riskPct = risk / entry * 100;
  if (risk <= 0 || riskPct > CFG.MAX_RISK_PCT) return { rejected: "RISK" };
  return { eligible: true, mode, score, entry, stop: stopPrice, risk, riskPct,
    target1: entry + risk * CFG.TARGET_1_R,
    target2: entry + risk * CFG.TARGET_2_R };
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function fetchJson(url) {
  let lastError;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const response = await fetch(url, {
        headers: { Accept: "application/json", "User-Agent": "v7.1.1-historical-backtest" },
        signal: AbortSignal.timeout(30000)
      });
      const body = await response.text();
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${body.slice(0, 180)}`);
      return JSON.parse(body);
    } catch (error) {
      lastError = error;
      if (attempt < 4) await sleep(500 * attempt);
    }
  }
  throw lastError;
}
function normalize(rows, intervalMs) {
  if (!Array.isArray(rows)) throw new Error("Kraken response has no candles array");
  const unique = new Map();
  for (const row of rows) {
    const rawTime = Number(row.time);
    const candle = {
      time: rawTime < 1e12 ? rawTime * 1000 : rawTime,
      open: Number(row.open), high: Number(row.high), low: Number(row.low),
      close: Number(row.close), volume: Number(row.volume)
    };
    if (![candle.time, candle.open, candle.high, candle.low, candle.close].every(Number.isFinite)) continue;
    if (candle.open <= 0 || candle.close <= 0 || candle.low <= 0 || candle.high < candle.low) continue;
    if (candle.time + intervalMs > Date.now()) continue;
    unique.set(candle.time, candle);
  }
  return [...unique.values()].sort((a, b) => a.time - b.time);
}
async function loadCandles(symbol, resolution, fromMs, toMs, intervalMs) {
  const chunkMs = intervalMs * 450;
  const all = [];
  for (let from = fromMs; from < toMs; from += chunkMs) {
    const to = Math.min(toMs, from + chunkMs);
    const url = new URL(encodeURIComponent(symbol) + "/" + encodeURIComponent(resolution), API);
    url.searchParams.set("from", String(Math.floor(from / 1000)));
    url.searchParams.set("to", String(Math.floor(to / 1000)));
    url.searchParams.set("count", "500");
    const data = await fetchJson(url);
    all.push(...normalize(data.candles, intervalMs));
    await sleep(120);
  }
  return [...new Map(all.map(c => [c.time, c])).values()].sort((a, b) => a.time - b.time);
}
function executionR(entryOpen, stop, exitRaw, exitType) {
  const risk = entryOpen - stop;
  const entryFill = entryOpen * (1 + SLIPPAGE_PER_SIDE);
  const exitFill = exitRaw * (1 - SLIPPAGE_PER_SIDE);
  const grossR = (exitFill - entryFill) / risk;
  const feeR = FEE_PER_SIDE * (entryFill + exitFill) / risk;
  return { grossR, feeR, netR: grossR - feeR, exitType };
}
function simulateTrade(entryBar, stop, barsToEnd) {
  const entry = entryBar.open;
  const target = entry * 1.03; // 30% gross return on 10x leveraged margin
  for (const bar of barsToEnd) {
    // Conservative OHLC handling: if stop and TP both touch in one candle, count STOP.
    const stopGap = bar.open <= stop;
    const stopHit = bar.low <= stop;
    if (stopGap || stopHit) {
      return { exitType: "STOP", exitTime: bar.time, exitPrice: stopGap ? bar.open : stop };
    }
    if (bar.high >= target) {
      return { exitType: "TP_30_MARGIN", exitTime: bar.time, exitPrice: target };
    }
  }
  return { exitType: "OPEN_AT_PERIOD_END", exitTime: null, exitPrice: null };
}
function stats(trades) {
  const closed = trades.filter(t => t.exitTime !== null);
  const wins = closed.filter(t => t.exitType === "TP_30_MARGIN");
  const losses = closed.filter(t => t.exitType === "STOP");
  return {
    totalTrades: trades.length, closedTrades: closed.length,
    openAtEnd: trades.length - closed.length,
    wins: wins.length, stops: losses.length,
    winRatePct: closed.length ? 100 * wins.length / closed.length : 0
  };
}
function seededRandom(seed) {
  let state = seed >>> 0;
  return () => { state = (1664525 * state + 1013904223) >>> 0; return state / 4294967296; };
}
function periodReturn(candles, start, end) {
  const p = candles.filter(c => c.time >= start && c.time < end);
  if (p.length < 2) return null;
  return { firstOpen: p[0].open, lastClose: p[p.length - 1].close,
    returnPct: (p[p.length - 1].close / p[0].open - 1) * 100, candles: p.length };
}
async function runPeriod(name, start, end) {
  console.log(`\n=== ${name}: ${new Date(start).toISOString()} → ${new Date(end).toISOString()} ===`);
  const btc = await loadCandles("PF_XBTUSD", "4h", start - 75 * H4, end, H4);
  const btcReturn = periodReturn(btc, start, end);
  const allTrades = [], failures = [], rejections = {};
  for (const symbol of SYMBOLS) {
    try {
      const bars = await loadCandles(symbol, "1h", start - 220 * H1, end, H1);
      if (bars.length < CFG.MIN_CANDLES) throw new Error(`only ${bars.length} hourly candles returned`);
      let nextAvailableEntryTime = 0;
      const symbolTrades = [];
      for (let i = 199; i < bars.length - 1; i++) {
        const signalCloseTime = bars[i].time + H1;
        if (signalCloseTime < start || signalCloseTime >= end) continue;
        const btcAtSignal = btc.filter(c => c.time + H4 <= signalCloseTime);
        const nextBar = bars[i + 1];
        if (nextBar.time >= end || nextBar.time < nextAvailableEntryTime) continue;
        const signal = analyzeLongHybrid(bars.slice(0, i + 1), btcAtSignal, nextBar.open);
        if (!signal.eligible) {
          rejections[signal.rejected] = (rejections[signal.rejected] || 0) + 1;
          continue;
        }
        const trade = simulateTrade(nextBar, signal.stop, bars.slice(i + 1).filter(c => c.time < end));
        if (!trade) continue;
        const row = {
          symbol, mode: signal.mode, score: signal.score,
          signalTime: signalCloseTime, entryTime: nextBar.time,
          entry: nextBar.open, stop: signal.stop, riskPct: signal.riskPct, ...trade
        };
        symbolTrades.push(row); allTrades.push(row);
        nextAvailableEntryTime = trade.exitTime === null ? end : trade.exitTime + H1;
      }
      console.log(`${symbol}: ${bars.length} candles, ${symbolTrades.length} trades`);
    } catch (error) {
      failures.push({ symbol, error: String(error.message || error) });
      console.log(`DATA/TEST FAILURE ${symbol}: ${String(error.message || error)}`);
    }
  }
  if (allTrades.length === 0) {
    console.log("No trades generated. Rejections:", JSON.stringify(rejections));
  }
  return {
    name, from: new Date(start).toISOString(), to: new Date(end).toISOString(),
    btcMarketReturn: btcReturn, btcBullishPeriodVerified: btcReturn !== null && btcReturn.returnPct > 0,
    btcMacroCandlesLoaded: btc.length, performance: stats(allTrades),
    byMode: {
      TREND: stats(allTrades.filter(t => t.mode === "TREND")),
      REVERSION: stats(allTrades.filter(t => t.mode === "REVERSION"))
    },
    bySymbol: SYMBOLS.map(symbol => ({ symbol, ...stats(allTrades.filter(t => t.symbol === symbol)) })),
    rejectionCounts: rejections, failures, trades: allTrades
  };
}
async function main() {
  const span = 30 * 24 * H1;
  const random = seededRandom(0x7112026);
  const earliest = Date.UTC(2023, 0, 1);
  const latestStart = Date.UTC(2025, 10, 1) - span;
  const randomStart = earliest + Math.floor(random() * ((latestStart - earliest) / H1)) * H1;
  const bullishStart = Date.UTC(2024, 9, 1);
  const periods = [
    await runPeriod("RANDOM_30D", randomStart, randomStart + span),
    await runPeriod("BULLISH_30D_2024_10", bullishStart, bullishStart + span)
  ];
  const bullish = periods[1].btcBullishPeriodVerified;
  const report = {
    generatedAt: new Date().toISOString(),
    strategy: "CRYPTO PUMP HUNTER v7.1.1 LONG Hybrid — fixed TP 30% margin / 10x",
    testedSymbols: SYMBOLS,
    parameters: { ...CFG, feePerSidePct: FEE_PER_SIDE * 100, slippagePerSidePct: SLIPPAGE_PER_SIDE * 100 },
    executionAssumptions: {
      signal: "Calculated only after a fully closed 1h candle.",
      entry: "Next 1h candle open; backtestEntryOpen equals that open, matching v7.1.1.",
      btcGuard: "Only fully closed 4h BTC candles with close time <= signal time are used.",
      takeProfit: "Close full position when price reaches +3.0% from entry, equivalent to +30% gross return on 10x leverage and $10 margin.",
      stopLoss: "Original strategy stop remains active until TP or stop is hit; no breakeven move.",
      intrabarAmbiguity: "Stop-first if original stop and TP are both touched in the same candle.",
      positionSizing: "$10 margin per trade, 10x leverage, $100 notional; counts are independent of sizing.",
      concurrency: "At most one open trade per symbol; symbols are otherwise independent.",
      costs: "Trade classification uses gross +3% underlying TP and original stop trigger; fees, slippage and funding are excluded from the win/stop count. Net ROI would be slightly lower after costs.",
      funding: "Excluded because funding-rate history is not part of the supplied strategy.",
      openTrades: "Trades still open at the period end are reported but excluded from closed-trade win rate, PF, and net R.",
      universe: "Ten liquid USD perpetual contracts listed in testedSymbols; this is a reproducible sample, not a claim that every Kraken contract was tested.",
      drawdown: "Portfolio cumulative net R, treating each trade as one equal initial-risk unit; not a dollar-equity simulation."
    },
    periods
  };
  await mkdir("artifacts", { recursive: true });
  await writeFile("artifacts/v711-tp30-report.json", JSON.stringify(report, null, 2));
  const pf = x => x.profitFactor === null ? (x.noLosingTrades ? "∞*" : "—") : x.profitFactor.toFixed(2);
  const summary = [
    "# CRYPTO PUMP HUNTER v7.1.1 — TP 30% margin / 10x backtest", "",
    `Generated: ${report.generatedAt}`, "",
    "| Period | BTC return | Closed | TP 30% | Stops | Win rate | Open |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|",
    ...periods.map(p => {
      const x = p.performance;
      return `| ${p.name} | ${p.btcMarketReturn ? p.btcMarketReturn.returnPct.toFixed(2)+"%" : "n/a"} | ${x.closedTrades} | ${x.wins} | ${x.stops} | ${x.winRatePct.toFixed(1)}% | ${x.openAtEnd} |`;
    }),
    "", `Bullish period verified by BTC return > 0: ${bullish ? "YES" : "NO — period must not be described as bullish"}`, "",
    "## Mode breakdown", ""
  ];
  for (const p of periods) {
    summary.push(`### ${p.name}`, "", "| Mode | Closed | TP 30% | Stops | Win rate | Open |", "|---|---:|---:|---:|---:|---:|");
    for (const mode of ["TREND", "REVERSION"]) {
      const x = p.byMode[mode];
      summary.push(`| ${mode} | ${x.closedTrades} | ${x.wins} | ${x.stops} | ${x.winRatePct.toFixed(1)}% | ${x.openAtEnd} |`);
    }
    summary.push("");
  }
  summary.push("## Assumptions", "", "```json", JSON.stringify(report.executionAssumptions, null, 2), "```", "");
  await writeFile("artifacts/v711-tp30-report.md", summary.join("\n"));
  console.log("\nFINAL_SUMMARY " + JSON.stringify(periods.map(p => ({
    name: p.name, from: p.from, to: p.to, btcMarketReturn: p.btcMarketReturn,
    performance: p.performance, byMode: p.byMode, failures: p.failures
  }))));
  if (periods.some(p => p.failures.length === SYMBOLS.length)) throw new Error("All symbol data requests failed in at least one period.");
  if (!bullish) throw new Error("Chosen second period failed BTC positive-return validation; cannot label it bullish.");
}
main().catch(error => { console.error(error); process.exit(1); });

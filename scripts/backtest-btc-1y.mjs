// scripts/backtest-btc-1y.mjs
// Backtest the corrected price-action engine on BTC-PERP over a configurable period.
//
// Usage:
//   node scripts/backtest-btc-1y.mjs
//   BACKTEST_DAYS=365 BACKTEST_SYMBOL=PF_XBTUSD node scripts/backtest-btc-1y.mjs
//   BACKTEST_DAYS=365 BACKTEST_SYMBOL=PF_XBTUSD node scripts/backtest-btc-1y.mjs

import { mkdir, writeFile } from "node:fs/promises";
import { analyzePriceAction } from "../src/price-action-engine.js";

/* -------------------------------------------------------------------------- */
/* Config                                                                     */
/* -------------------------------------------------------------------------- */

const BASE = "https://futures.kraken.com";
const HOUR = 60 * 60 * 1000;
const FOUR_HOURS = 4 * HOUR;
const FIFTEEN_MINUTES = 15 * 60 * 1000;
const DAY = 24 * HOUR;

const SYMBOL = String(process.env.BACKTEST_SYMBOL || "PF_XBTUSD").trim();
const DAYS = Math.max(30, Math.min(730, Number(process.env.BACKTEST_DAYS || 365)));
const FEE_PER_SIDE = Math.max(0, Number(process.env.BACKTEST_FEE || 0.0005));
const SLIPPAGE_PER_SIDE = Math.max(0, Number(process.env.BACKTEST_SLIPPAGE || 0.0003));
const WARMUP_DAYS = Math.max(10, Number(process.env.BACKTEST_WARMUP_DAYS || 20));
const TARGET_WEIGHTS = [0.40, 0.35, 0.25];
const SAME_CANDLE_RULE = String(process.env.BACKTEST_SAME_CANDLE_RULE || "stop_first"); // stop_first | target_first | 50_50

/* -------------------------------------------------------------------------- */
/* HTTP                                                                       */
/* -------------------------------------------------------------------------- */

async function getJson(url) {
  const response = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(30000)
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}: ${body.slice(0, 200)}`);
  let data;
  try { data = JSON.parse(body); }
  catch { throw new Error(`Invalid JSON from ${url}`); }
  if (data?.result === "error" || (Array.isArray(data?.errors) && data.errors.length)) {
    throw new Error(`Kraken API error: ${JSON.stringify(data.errors || data.error)}`);
  }
  return data;
}

/* -------------------------------------------------------------------------- */
/* Historical candles                                                         */
/* -------------------------------------------------------------------------- */

function normalizeCandles(rows, intervalMs) {
  if (!Array.isArray(rows)) throw new Error("Kraken candles array missing");
  const seen = new Set();
  return rows.map(row => ({
    time: Number(row.time) < 1e12 ? Number(row.time) * 1000 : Number(row.time),
    open: Number(row.open),
    high: Number(row.high),
    low: Number(row.low),
    close: Number(row.close),
    volume: Number(row.volume)
  }))
    .filter(c =>
      Number.isFinite(c.time) && Number.isFinite(c.open) && Number.isFinite(c.high) &&
      Number.isFinite(c.low) && Number.isFinite(c.close) && Number.isFinite(c.volume) &&
      c.open > 0 && c.close > 0 && c.low > 0 && c.high >= c.low && c.volume >= 0
    )
    .sort((a, b) => a.time - b.time)
    .filter(c => {
      if (seen.has(c.time)) return false;
      seen.add(c.time);
      return true;
    });
}

async function fetchHistoricalCandles(symbol, resolution, fromMs, toMs, intervalMs) {
  const chunkMs = intervalMs * 1800; // Kraken limit is 2000 candles per request; use 1800 for safety
  const combined = [];
  for (let start = fromMs; start < toMs; start += chunkMs) {
    const end = Math.min(toMs, start + chunkMs);
    const url = new URL(`${BASE}/api/charts/v1/trade/${encodeURIComponent(symbol)}/${resolution}`);
    url.searchParams.set("from", String(Math.floor(start / 1000)));
    url.searchParams.set("to", String(Math.floor(end / 1000)));
    url.searchParams.set("count", "1900");
    const data = await getJson(url);
    if (data.more_candles === true) {
      throw new Error(`${symbol} ${resolution}: Kraken returned more candles than requested in a chunk.`);
    }
    combined.push(...normalizeCandles(data.candles, intervalMs));
  }
  const byTime = new Map(combined.map(c => [c.time, c]));
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

/* -------------------------------------------------------------------------- */
/* Trade simulation                                                           */
/* -------------------------------------------------------------------------- */

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

function applyTarget(position, target, weight, fee, slippage, time) {
  const dir = position.direction;
  const exitFill = target * (1 - dir * slippage);
  const grossR = dir * (exitFill - position.entry) / position.risk;
  const feeR = fee * (position.entry + exitFill) / position.risk;
  position.realizedR += weight * (grossR - feeR);
  position.remaining -= weight;
  position.targetHits++;
  if (position.remaining <= 1e-9) {
    position.remaining = 0;
    position.exitTime = time;
    position.exitReason = "TARGETS";
  }
}

export function simulateTrade({
  side, entry, stop, targets, candles, startIndex,
  fee = 0.0005, slippage = 0.0003,
  sameCandleRule = "stop_first"
}) {
  const direction = side === "LONG" ? 1 : -1;
  const risk = direction === 1 ? entry - stop : stop - entry;
  if (!(risk > 0) || !Number.isFinite(risk)) throw new Error("Invalid trade risk");

  const position = {
    side, entry, stop, risk, direction,
    remaining: 1, realizedR: 0, targetHits: 0,
    exitTime: null, exitReason: null
  };
  const config = { fee, slippage };
  // No time-based exit: keep scanning all available candles until TP/SL.
  const endIndex = candles.length - 1;

  for (let i = startIndex; i <= endIndex && position.remaining > 0; i++) {
    const bar = candles[i];
    const stopGap = direction === 1 ? bar.open <= stop : bar.open >= stop;
    const stopTouched = direction === 1 ? bar.low <= stop : bar.high >= stop;

    const touchedTargets = [];
    for (let t = 0; t < targets.length; t++) {
      const target = targets[t];
      if (target == null) continue;
      const touched = direction === 1 ? bar.high >= target : bar.low <= target;
      if (touched) touchedTargets.push({ index: t, price: target });
    }

    const stopEvent = stopGap || stopTouched;
    const targetEvent = touchedTargets.length > 0;

    if (stopEvent && targetEvent && !stopGap) {
      if (sameCandleRule === "target_first") {
        for (const { index: t, price } of touchedTargets) {
          if (position.remaining <= 0) break;
          applyTarget(position, price, TARGET_WEIGHTS[t], fee, slippage, bar.time);
          targets[t] = null;
        }
        if (position.remaining > 0) closeTrade(position, stop, "STOP", bar.time, config);
      } else if (sameCandleRule === "50_50") {
        const firstTarget = touchedTargets[0];
        const halfRemaining = position.remaining / 2;
        const stopFill = stop * (1 - direction * slippage);
        const stopGrossR = direction * (stopFill - position.entry) / position.risk;
        const stopFeeR = fee * (position.entry + stopFill) / position.risk;
        position.realizedR += halfRemaining * (stopGrossR - stopFeeR);
        position.remaining -= halfRemaining;
        applyTarget(position, firstTarget.price, halfRemaining, fee, slippage, bar.time);
        targets[firstTarget.index] = null;
        if (position.remaining > 0) closeTrade(position, bar.close, "AMBIGUOUS_CLOSE", bar.time, config);
      } else {
        closeTrade(position, stop, "STOP", bar.time, config);
      }
      break;
    }

    if (stopEvent) {
      closeTrade(position, stopGap ? bar.open : stop, "STOP", bar.time, config);
      break;
    }

    if (targetEvent) {
      for (const { index: t, price } of touchedTargets) {
        if (position.remaining <= 0) break;
        applyTarget(position, price, TARGET_WEIGHTS[t], fee, slippage, bar.time);
        targets[t] = null;
      }
      if (position.remaining <= 1e-9) break;
    }

  }

  // Keep unresolved positions open at the end of available history.
  if (position.remaining > 0 && position.exitReason == null) {
    position.exitReason = "OPEN_AT_DATA_END";
    position.exitTime = candles[endIndex].time;
  }

  return {
    side, entry, stop, risk,
    netR: position.realizedR,
    targetHits: position.targetHits,
    remaining: position.remaining,
    isOpen: position.remaining > 0,
    exitReason: position.exitReason,
    entryTime: candles[startIndex].time,
    exitTime: position.exitTime,
    sameCandleRule
  };
}

/* -------------------------------------------------------------------------- */
/* Metrics                                                                    */
/* -------------------------------------------------------------------------- */

function sideMetrics(trades) {
  const closed = trades.filter(t => !t.isOpen);
  const wins = closed.filter(t => t.netR > 0);
  const losses = closed.filter(t => t.netR < 0);
  const grossWin = wins.reduce((s, t) => s + t.netR, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.netR, 0));
  return {
    trades: trades.length,
    closedTrades: closed.length,
    openTrades: trades.length - closed.length,
    wins: wins.length,
    losses: losses.length,
    winRatePct: closed.length ? (wins.length / closed.length) * 100 : 0,
    netR: trades.reduce((s, t) => s + t.netR, 0),
    expectancyR: closed.length ? closed.reduce((s, t) => s + t.netR, 0) / closed.length : 0,
    profitFactor: grossLoss ? grossWin / grossLoss : grossWin ? null : 0,
    tp1Trades: trades.filter(t => t.targetHits >= 1).length,
    stoppedTrades: trades.filter(t => t.exitReason === "STOP").length,
    avgTargetHits: trades.length ? trades.reduce((s, t) => s + t.targetHits, 0) / trades.length : 0
  };
}

function summarize(trades) {
  const closed = trades.filter(t => !t.isOpen);
  const open = trades.filter(t => t.isOpen);
  const wins = closed.filter(t => t.netR > 0);
  const losses = closed.filter(t => t.netR < 0);
  const grossWin = wins.reduce((s, t) => s + t.netR, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.netR, 0));
  let equity = 0, peak = 0, maxDrawdown = 0;
  for (const trade of closed) {
    equity += trade.netR;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
  }
  const exitReasons = {};
  for (const t of trades) exitReasons[t.exitReason || "UNKNOWN"] = (exitReasons[t.exitReason || "UNKNOWN"] || 0) + 1;
  return {
    trades: trades.length,
    closedTrades: closed.length,
    openTrades: open.length,
    wins: wins.length,
    losses: losses.length,
    breakeven: closed.length - wins.length - losses.length,
    winRatePct: closed.length ? (wins.length / closed.length) * 100 : 0,
    tp1Trades: trades.filter(t => t.targetHits >= 1).length,
    stoppedTrades: trades.filter(t => t.exitReason === "STOP").length,
    netR: trades.reduce((s, t) => s + t.netR, 0),
    expectancyR: closed.length ? closed.reduce((s, t) => s + t.netR, 0) / closed.length : 0,
    profitFactor: grossLoss ? grossWin / grossLoss : grossWin ? null : 0,
    maxDrawdownR: maxDrawdown,
    totalTargetHits: trades.reduce((s, t) => s + t.targetHits, 0),
    exitReasons,
    bySide: {
      LONG: sideMetrics(trades.filter(t => t.side === "LONG")),
      SHORT: sideMetrics(trades.filter(t => t.side === "SHORT"))
    },
    byStrategy: (() => {
      const groups = {};
      for (const t of trades) {
        const key = t.strategyId || "unknown";
        (groups[key] = groups[key] || []).push(t);
      }
      const out = {};
      for (const [k, v] of Object.entries(groups)) out[k] = sideMetrics(v);
      return out;
    })()
  };
}

/* -------------------------------------------------------------------------- */
/* Backtest                                                                   */
/* -------------------------------------------------------------------------- */

async function runBacktest() {
  const endMs = Date.now();
  const startMs = endMs - DAYS * DAY;
  const fromMs = startMs - WARMUP_DAYS * DAY;
  const toMs = endMs;

  console.log(`\n📊 Backtest ${SYMBOL}`);
  console.log(`   Period: ${new Date(startMs).toISOString()} → ${new Date(endMs).toISOString()} (${DAYS} days)`);
  console.log(`   Warmup: ${WARMUP_DAYS} days before period`);
  console.log(`   Hold limit: NONE (TP/SL only) | Fee: ${FEE_PER_SIDE * 100}%/side | Slippage: ${SLIPPAGE_PER_SIDE * 100}%/side`);
  console.log(`   Same-candle rule: ${SAME_CANDLE_RULE}\n`);

  console.log("⏳ Fetching historical candles...");
  const [oneHour, fourHour, fifteenMinute] = await Promise.all([
    fetchHistoricalCandles(SYMBOL, "1h", fromMs, toMs, HOUR),
    fetchHistoricalCandles(SYMBOL, "4h", fromMs, toMs, FOUR_HOURS),
    fetchHistoricalCandles(SYMBOL, "15m", fromMs, toMs, FIFTEEN_MINUTES)
  ]);
  console.log(`   1h: ${oneHour.length} candles`);
  console.log(`   4h: ${fourHour.length} candles`);
  console.log(`   15m: ${fifteenMinute.length} candles\n`);

  if (oneHour.length < 100 || fourHour.length < 60 || fifteenMinute.length < 200) {
    throw new Error(`Insufficient historical candles (1h=${oneHour.length}, 4h=${fourHour.length}, 15m=${fifteenMinute.length})`);
  }

  console.log("🔍 Running backtest...");

  const trades = [];
  const skipped = { invalid_candles: 0, no_candles_4h: 0, no_candles_15m: 0, no_signal: 0, overlap: 0, late_entry: 0, direction_conflict: 0, below_score: 0 };
  const signalCounts = { total_signals: 0, long: 0, short: 0, by_strategy: {} };
  let nextAvailable = 60;
  let lastProgress = 0;

  // Iterate each 1H bar as a signal opportunity
  for (let i = 60; i < oneHour.length - 1; i++) {
    const signalBar = oneHour[i];
    const signalCloseTime = signalBar.time + HOUR;

    // Only consider signals inside the requested period (not warmup)
    if (signalCloseTime < startMs) continue;

    // Filter 4H candles that closed at or before signal close
    const closed4h = fourHour.filter(c => c.time + FOUR_HOURS <= signalCloseTime);
    if (closed4h.length < 60) { skipped.no_candles_4h++; continue; }

    // Filter 15M candles that closed at or before signal close
    const closed15m = fifteenMinute.filter(c => c.time + FIFTEEN_MINUTES <= signalCloseTime);
    if (closed15m.length < 120) { skipped.no_candles_15m++; continue; }

    // Take the last 120 15M candles for the strategy
    const window15m = closed15m.slice(-120);

    // Use the next 1H open as the live price (realistic entry reference)
    const nextBar = oneHour[i + 1];
    if (!nextBar) continue;
    const livePrice = nextBar.open;

    // Run the corrected engine
    const result = analyzePriceAction({
      symbol: SYMBOL,
      oneHour: oneHour.slice(0, i + 1),
      fourHour: closed4h,
      fifteenMin: window15m,
      livePrice
    });

    // Track rejection reasons from diagnostics
    for (const d of result.diagnostics || []) {
      if (d.status === "below_score") skipped.below_score++;
      else if (d.status === "direction_conflict") skipped.direction_conflict++;
      else if (d.status === "late_entry") skipped.late_entry++;
    }

    if (!result.signals.length) { skipped.no_signal++; continue; }

    // Pick the highest-scoring signal
    const signal = result.signals[0];
    signalCounts.total_signals++;
    if (signal.side === "LONG") signalCounts.long++;
    else signalCounts.short++;
    signalCounts.by_strategy[signal.strategyId] = (signalCounts.by_strategy[signal.strategyId] || 0) + 1;

    // Avoid overlapping trades on the same symbol
    if (i < nextAvailable) { skipped.overlap++; continue; }

    // Simulate with adverse slippage on entry
    const direction = signal.side === "LONG" ? 1 : -1;
    const entry = signal.entry * (1 + direction * SLIPPAGE_PER_SIDE);

    // Include all remaining candles; no maximum holding time.
    const tradeCandles = oneHour.slice(i + 1);
    if (tradeCandles.length < 2) continue;

    let trade;
    try {
      trade = simulateTrade({
        side: signal.side,
        entry,
        stop: signal.stop,
        targets: [signal.target1, signal.target2, signal.target3],
        candles: tradeCandles,
        startIndex: 0,
        fee: FEE_PER_SIDE,
        slippage: SLIPPAGE_PER_SIDE,
        sameCandleRule: SAME_CANDLE_RULE
      });
    } catch (error) {
      console.error(`   ⚠️ Trade simulation failed at ${new Date(signalBar.time).toISOString()}: ${error.message}`);
      continue;
    }

    trade.symbol = SYMBOL;
    trade.strategyId = signal.strategyId;
    trade.strategyName = signal.strategyName;
    trade.score = signal.score;
    trade.rewardRisk = signal.rewardRisk;
    trade.signalTime = signalBar.time;
    trade.signalCloseTime = signalCloseTime;
    trade.entryReason = signal.reason;
    trades.push(trade);

    const exitIndex = oneHour.findIndex(c => c.time === trade.exitTime);
    nextAvailable = Math.max(i + 1, exitIndex + 1);

    // Progress
    const pct = Math.round(((i - 60) / (oneHour.length - 61)) * 100);
    if (pct >= lastProgress + 10) {
      lastProgress = pct;
      process.stdout.write(`   ${pct}% (${trades.length} trades, ${signalCounts.total_signals} signals)\n`);
    }
  }

  console.log(`\n✅ Backtest complete: ${trades.length} trades, ${signalCounts.total_signals} signals\n`);

  const summary = summarize(trades);

  // Period description (uptrend + downtrend check)
  const btcStart = oneHour.find(c => c.time >= startMs)?.close;
  const btcEnd = oneHour.at(-1)?.close;
  const btcMin = Math.min(...oneHour.filter(c => c.time >= startMs).map(c => c.close));
  const btcMax = Math.max(...oneHour.filter(c => c.time >= startMs).map(c => c.close));

  const report = {
    generatedAt: new Date().toISOString(),
    symbol: SYMBOL,
    period: {
      from: new Date(startMs).toISOString(),
      to: new Date(endMs).toISOString(),
      days: DAYS,
      btcStart,
      btcEnd,
      btcChangePct: btcStart ? ((btcEnd - btcStart) / btcStart) * 100 : null,
      btcMin,
      btcMax,
      btcRangePct: btcStart ? ((btcMax - btcMin) / btcStart) * 100 : null
    },
    settings: {
      feePerSidePct: FEE_PER_SIDE * 100,
      slippagePerSidePct: SLIPPAGE_PER_SIDE * 100,
      targetWeightsPct: TARGET_WEIGHTS.map(w => w * 100),
      sameCandleRule: SAME_CANDLE_RULE,
      funding: "excluded"
    },
    signals: signalCounts,
    skipped,
    summary,
    trades
  };

  await mkdir("artifacts", { recursive: true });
  await writeFile(`artifacts/${SYMBOL}-backtest-1y.json`, JSON.stringify(report, null, 2));

  // Markdown report
  const md = [];
  md.push(`# Backtest ${SYMBOL} — ${DAYS} days`);
  md.push("");
  md.push(`**Period:** ${new Date(startMs).toISOString().slice(0, 10)} → ${new Date(endMs).toISOString().slice(0, 10)}`);
  md.push(`**BTC change:** ${report.period.btcChangePct?.toFixed(2)}% | **Range:** ${report.period.btcRangePct?.toFixed(2)}%`);
  md.push(`**Holding:** No time limit; TP/SL only | **Fee:** ${FEE_PER_SIDE * 100}%/side | **Slippage:** ${SLIPPAGE_PER_SIDE * 100}%/side | **Same-candle:** ${SAME_CANDLE_RULE}`);
  md.push("");
  md.push(`## Overall`);
  md.push("");
  md.push(`| Metric | Value |`);
  md.push(`|---|---:|`);
  md.push(`| Total trades | ${summary.trades} |`);
  md.push(`| Closed trades | ${summary.closedTrades} |`);
  md.push(`| Still open at data end | ${summary.openTrades} |`);
  md.push(`| Trades that reached TP1 (including later-stopped trades) | ${summary.tp1Trades} |`);
  md.push(`| Stop-loss trades | ${summary.stoppedTrades} |`);
  md.push(`| LONG trades | ${summary.bySide.LONG.trades} |`);
  md.push(`| SHORT trades | ${summary.bySide.SHORT.trades} |`);
  md.push(`| Wins (closed trades only) | ${summary.wins} |`);
  md.push(`| Losses (closed trades only) | ${summary.losses} |`);
  md.push(`| Win rate (closed trades only) | ${summary.winRatePct.toFixed(2)}% |`);
  md.push(`| Net R | ${summary.netR.toFixed(2)}R |`);
  md.push(`| Expectancy | ${summary.expectancyR.toFixed(3)}R |`);
  md.push(`| Profit factor | ${summary.profitFactor ?? "n/a"} |`);
  md.push(`| Max drawdown | ${summary.maxDrawdownR.toFixed(2)}R |`);
  md.push(`| Total TP hits | ${summary.totalTargetHits} |`);
  md.push("");
  md.push(`## By side`);
  md.push("");
  md.push(`| Side | Trades | Wins | Losses | Win rate | Net R | Expectancy | Profit factor |`);
  md.push(`|---|---:|---:|---:|---:|---:|---:|---:|`);
  for (const side of ["LONG", "SHORT"]) {
    const s = summary.bySide[side];
    md.push(`| ${side} | ${s.trades} | ${s.wins} | ${s.losses} | ${s.winRatePct.toFixed(2)}% | ${s.netR.toFixed(2)}R | ${s.expectancyR.toFixed(3)}R | ${s.profitFactor ?? "n/a"} |`);
  }
  md.push("");
  md.push(`## By strategy`);
  md.push("");
  md.push(`| Strategy | Trades | Wins | Losses | Win rate | Net R | Expectancy | Profit factor |`);
  md.push(`|---|---:|---:|---:|---:|---:|---:|---:|`);
  for (const [id, s] of Object.entries(summary.byStrategy)) {
    md.push(`| ${id} | ${s.trades} | ${s.wins} | ${s.losses} | ${s.winRatePct.toFixed(2)}% | ${s.netR.toFixed(2)}R | ${s.expectancyR.toFixed(3)}R | ${s.profitFactor ?? "n/a"} |`);
  }
  md.push("");
  md.push(`## Exit reasons`);
  md.push("");
  md.push(`| Reason | Count |`);
  md.push(`|---|---:|`);
  for (const [r, c] of Object.entries(summary.exitReasons).sort((a, b) => b[1] - a[1])) {
    md.push(`| ${r} | ${c} |`);
  }
  md.push("");
  md.push(`## Signals`);
  md.push("");
  md.push(`| Metric | Value |`);
  md.push(`|---|---:|`);
  md.push(`| Total signals | ${signalCounts.total_signals} |`);
  md.push(`| LONG | ${signalCounts.long} |`);
  md.push(`| SHORT | ${signalCounts.short} |`);
  for (const [id, n] of Object.entries(signalCounts.by_strategy)) {
    md.push(`| Strategy: ${id} | ${n} |`);
  }
  md.push("");
  md.push(`## Skipped bars`);
  md.push("");
  md.push(`| Reason | Count |`);
  md.push(`|---|---:|`);
  for (const [r, c] of Object.entries(skipped)) md.push(`| ${r} | ${c} |`);
  md.push("");
  md.push(`## Trades (full list)`);
  md.push("");
  md.push(`| # | Time | Side | Strategy | Score | Entry | Stop | TP1 | RR | Net R | TP hits | Exit |`);
  md.push(`|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---|`);
  trades.forEach((t, idx) => {
    md.push(`| ${idx + 1} | ${new Date(t.signalTime).toISOString().slice(0, 16)} | ${t.side} | ${t.strategyId} | ${t.score} | ${t.entry.toFixed(2)} | ${t.stop.toFixed(2)} | — | ${t.rewardRisk} | ${t.netR.toFixed(2)}R | ${t.targetHits} | ${t.exitReason} |`);
  });
  md.push("");
  md.push(`_Funding excluded. Entry uses next 1H open with adverse slippage. Not a guarantee of live fills._`);

  await writeFile(`artifacts/${SYMBOL}-backtest-1y.md`, md.join("\n"));

  // Console summary
  console.log("═".repeat(60));
  console.log(`📈 ${SYMBOL} — ${DAYS} days`);
  console.log(`BTC change: ${report.period.btcChangePct?.toFixed(2)}% | Range: ${report.period.btcRangePct?.toFixed(2)}%`);
  console.log("═".repeat(60));
  console.log(`Trades:        ${summary.trades}`);
  console.log(`Closed/Open:   ${summary.closedTrades}/${summary.openTrades}`);
  console.log(`TP1 trades:    ${summary.tp1Trades}`);
  console.log(`Stopped:       ${summary.stoppedTrades}`);
  console.log(`Win rate:      ${summary.winRatePct.toFixed(2)}% (closed trades only)`);
  console.log(`Net R:         ${summary.netR.toFixed(2)}R`);
  console.log(`Expectancy:    ${summary.expectancyR.toFixed(3)}R`);
  console.log(`Profit factor: ${summary.profitFactor ?? "n/a"}`);
  console.log(`Max drawdown:  ${summary.maxDrawdownR.toFixed(2)}R`);
  console.log("─".repeat(60));
  console.log(`LONG:  ${summary.bySide.LONG.trades} trades | ${summary.bySide.LONG.winRatePct.toFixed(1)}% win | ${summary.bySide.LONG.netR.toFixed(2)}R`);
  console.log(`SHORT: ${summary.bySide.SHORT.trades} trades | ${summary.bySide.SHORT.winRatePct.toFixed(1)}% win | ${summary.bySide.SHORT.netR.toFixed(2)}R`);
  console.log("─".repeat(60));
  console.log(`Trades: LONG ${summary.bySide.LONG.trades} / SHORT ${summary.bySide.SHORT.trades}`);
  console.log(`Signals (pre-overlap filter): ${signalCounts.total_signals} (LONG ${signalCounts.long} / SHORT ${signalCounts.short})`);
  console.log(`Exit reasons: ${Object.entries(summary.exitReasons).map(([r, c]) => `${r}=${c}`).join(", ")}`);
  console.log("═".repeat(60));
  console.log(`📄 Reports: artifacts/${SYMBOL}-backtest-1y.md and .json\n`);

  return report;
}

runBacktest().catch(error => {
  console.error("\n❌ Backtest failed:", error);
  process.exitCode = 1;
});
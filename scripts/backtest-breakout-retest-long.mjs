import { mkdir, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { analyzeBreakoutRetestLongA } from "../src/futures-breakout-retest-long-a.js";
import { analyzeBreakoutRetestLong } from "../src/futures-breakout-retest-long.js";

const API = "https://api.bybit.com/v5/market/kline";
const SYMBOLS = ["SOLUSDT", "ETHUSDT", "AVAXUSDT", "SUIUSDT", "LINKUSDT", "BNBUSDT", "XRPUSDT"];
const INTERVALS = { "5": 300000, "15": 900000, "60": 3600000, "240": 14400000 };
const DAYS = Math.max(30, Math.min(180, Number(process.env.BREAKOUT_BACKTEST_DAYS || 90)));
const WARMUP_DAYS = 25;
const LEVERAGE = 10;
const MARGIN_TARGET_PCT = 30;
const MAX_CONTEXT_CANDLES = 100;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function fetchKlines(symbol, interval, fromMs, toMs) {
  const intervalMs = INTERVALS[interval];
  if (!intervalMs) throw new Error("Unsupported interval " + interval);
  const combined = [];
  let cursor = fromMs;
  while (cursor < toMs) {
    const chunkEnd = Math.min(toMs - intervalMs, cursor + intervalMs * 999);
    const url = new URL(API);
    url.searchParams.set("category", "linear");
    url.searchParams.set("symbol", symbol);
    url.searchParams.set("interval", interval);
    url.searchParams.set("start", String(cursor));
    url.searchParams.set("end", String(chunkEnd));
    url.searchParams.set("limit", "1000");

    let payload = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      const response = await fetch(url, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(25000)
      });
      const body = await response.text();
      if (!response.ok) {
        if (attempt < 4 && (response.status === 429 || response.status >= 500)) {
          await sleep(500 * (attempt + 1));
          continue;
        }
        throw new Error("Bybit HTTP " + response.status + " " + symbol + " " + interval + ": " + body.slice(0, 180));
      }
      try { payload = JSON.parse(body); }
      catch { throw new Error("Invalid Bybit JSON for " + symbol + " " + interval); }
      if (payload.retCode === 0) break;
      if (attempt < 4 && (payload.retCode === 10006 || payload.retCode === 10000)) {
        await sleep(700 * (attempt + 1));
        payload = null;
        continue;
      }
      throw new Error("Bybit API error " + payload.retCode + ": " + payload.retMsg);
    }
    if (!payload || payload.retCode !== 0) throw new Error("Bybit request retries exhausted for " + symbol + " " + interval);

    const rows = payload.result?.list;
    if (!Array.isArray(rows)) throw new Error("Bybit candle list missing for " + symbol + " " + interval);
    for (const row of rows) {
      const time = Number(row[0]);
      const candle = {
        time, open: Number(row[1]), high: Number(row[2]), low: Number(row[3]),
        close: Number(row[4]), volume: Number(row[5])
      };
      if (Number.isFinite(time) &&
          [candle.open,candle.high,candle.low,candle.close,candle.volume].every(Number.isFinite) &&
          candle.open > 0 && candle.low > 0 && candle.high >= candle.low &&
          candle.volume >= 0 && time + intervalMs <= toMs) combined.push(candle);
    }
    cursor = chunkEnd + intervalMs;
    await sleep(120);
  }

  const byTime = new Map(combined.map(c => [c.time, c]));
  return [...byTime.values()].sort((a,b) => a.time - b.time);
}

function countClosed(candles, intervalMs, cutoffMs) {
  let lo = 0, hi = candles.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (candles[mid].time + intervalMs <= cutoffMs) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
function lowerBound(candles, time) {
  let lo = 0, hi = candles.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (candles[mid].time < time) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
function recentClosed(candles, count) {
  return candles.slice(Math.max(0, count - MAX_CONTEXT_CANDLES), count);
}

export function resolveLongTrade({ candles, entryIndex, stopPrice, leverage = LEVERAGE, marginTargetPct = MARGIN_TARGET_PCT }) {
  const entryBar = candles[entryIndex];
  if (!entryBar) return { status: "NO_ENTRY_BAR", ambiguousCandles: 0 };
  const entryPrice = Number(entryBar.open);
  const stop = Number(stopPrice);
  if (!(entryPrice > 0) || !Number.isFinite(stop) || !(leverage > 0)) {
    return { status: "INVALID_TRADE", ambiguousCandles: 0 };
  }
  const targetPrice = entryPrice * (1 + marginTargetPct / (leverage * 100));
  let ambiguousCandles = 0;

  for (let i = entryIndex; i < candles.length; i++) {
    const bar = candles[i];
    const open = Number(bar.open), high = Number(bar.high), low = Number(bar.low);
    if (open <= stop) {
      return { status: "STOP", entryPrice, exitPrice: open, targetPrice, stopPrice: stop,
        exitTime: bar.time + INTERVALS["5"], ambiguousCandles,
        marginRoiPct: ((open / entryPrice) - 1) * leverage * 100 };
    }
    if (open >= targetPrice) {
      return { status: "PROFIT_30", entryPrice, exitPrice: open, targetPrice, stopPrice: stop,
        exitTime: bar.time + INTERVALS["5"], ambiguousCandles,
        marginRoiPct: ((open / entryPrice) - 1) * leverage * 100 };
    }
    const stopHit = low <= stop;
    const targetHit = high >= targetPrice;
    if (stopHit && targetHit) {
      ambiguousCandles++;
      return { status: "STOP", entryPrice, exitPrice: stop, targetPrice, stopPrice: stop,
        exitTime: bar.time + INTERVALS["5"], ambiguousCandles,
        marginRoiPct: ((stop / entryPrice) - 1) * leverage * 100 };
    }
    if (stopHit) {
      return { status: "STOP", entryPrice, exitPrice: stop, targetPrice, stopPrice: stop,
        exitTime: bar.time + INTERVALS["5"], ambiguousCandles,
        marginRoiPct: ((stop / entryPrice) - 1) * leverage * 100 };
    }
    if (targetHit) {
      return { status: "PROFIT_30", entryPrice, exitPrice: targetPrice, targetPrice, stopPrice: stop,
        exitTime: bar.time + INTERVALS["5"], ambiguousCandles,
        marginRoiPct: marginTargetPct };
    }
  }
  const last = candles.at(-1);
  return {
    status: "OPEN_AT_END", entryPrice, targetPrice, stopPrice: stop,
    lastMark: last ? Number(last.close) : null,
    exitTime: null, ambiguousCandles,
    marginRoiAtEndPct: last ? ((Number(last.close) / entryPrice) - 1) * leverage * 100 : null
  };
}

function summarize(trades) {
  const closed = trades.filter(t => t.status === "PROFIT_30" || t.status === "STOP");
  const wins = closed.filter(t => t.status === "PROFIT_30");
  const stops = closed.filter(t => t.status === "STOP");
  let equity = 0, peak = 0, maxDrawdown = 0;
  for (const trade of [...closed].sort((a,b) => a.exitTime - b.exitTime)) {
    equity += Number(trade.marginRoiPct || 0);
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
  }
  const totalRoi = closed.reduce((sum,t) => sum + Number(t.marginRoiPct || 0), 0);
  return {
    signals: trades.length,
    closedTrades: closed.length,
    wins30PctBeforeStop: wins.length,
    stopFirst: stops.length,
    openAtEnd: trades.filter(t => t.status === "OPEN_AT_END").length,
    winRatePct: closed.length ? wins.length / closed.length * 100 : 0,
    totalMarginRoiPct: totalRoi,
    averageMarginRoiPct: closed.length ? totalRoi / closed.length : 0,
    maxDrawdownMarginPoints: maxDrawdown,
    ambiguous5mCandles: trades.reduce((sum,t) => sum + (t.ambiguousCandles || 0), 0)
  };
}

function runEngine({ engine, symbol, data, testStartMs, testEndMs }) {
  const trades = [];
  let lockUntil = 0;
  const startIndex = lowerBound(data.m15, testStartMs - INTERVALS["15"]);
  for (let i = Math.max(startIndex, 100); i < data.m15.length; i++) {
    const signalCandle = data.m15[i];
    const signalCloseTime = signalCandle.time + INTERVALS["15"];
    if (signalCloseTime < testStartMs || signalCloseTime >= testEndMs) continue;
    if (signalCloseTime < lockUntil) continue;

    const btcCount = countClosed(data.btc15, INTERVALS["15"], signalCloseTime);
    const h1Count = countClosed(data.h1, INTERVALS["60"], signalCloseTime);
    const h4Count = countClosed(data.h4, INTERVALS["240"], signalCloseTime);
    const m15 = recentClosed(data.m15, i + 1);
    let candidate = null;
    if (engine === "A") {
      candidate = analyzeBreakoutRetestLongA({
        symbol, candles15m: m15, candlesBtc15m: recentClosed(data.btc15, btcCount)
      });
    } else {
      candidate = analyzeBreakoutRetestLong({
        symbol, candles15m: m15,
        candles1h: recentClosed(data.h1, h1Count),
        candles4h: recentClosed(data.h4, h4Count)
      });
    }
    if (!candidate || candidate.eligible !== true) continue;

    const entryIndex = lowerBound(data.m5, signalCloseTime);
    const entryBar = data.m5[entryIndex];
    if (!entryBar || entryBar.time >= testEndMs || entryBar.time - signalCloseTime > INTERVALS["5"]) continue;
    const outcome = resolveLongTrade({ candles: data.m5, entryIndex, stopPrice: candidate.stop });
    const trade = {
      engine, symbol, signalTime: signalCandle.time, signalCloseTime,
      signalClose: signalCandle.close, plannedEntry: candidate.entry,
      entryPrice: outcome.entryPrice ?? null, stopPrice: candidate.stop,
      targetPrice: outcome.targetPrice ?? null,
      status: outcome.status, exitTime: outcome.exitTime ?? null,
      exitPrice: outcome.exitPrice ?? null,
      marginRoiPct: outcome.marginRoiPct ?? null,
      marginRoiAtEndPct: outcome.marginRoiAtEndPct ?? null,
      ambiguousCandles: outcome.ambiguousCandles || 0
    };
    trades.push(trade);
    lockUntil = outcome.exitTime ?? testEndMs;
  }
  return { symbol, metrics: summarize(trades), trades };
}

async function main() {
  const testEndMs = Math.floor(Date.now() / INTERVALS["15"]) * INTERVALS["15"];
  const testStartMs = testEndMs - DAYS * 86400000;
  const historyStartMs = testStartMs - WARMUP_DAYS * 86400000;
  const results = [];
  console.log("Downloading Bybit linear perpetual OHLC data for " + DAYS + " days...");
  const btc15 = await fetchKlines("BTCUSDT", "15", historyStartMs, testEndMs);

  for (const symbol of SYMBOLS) {
    try {
      console.log("Loading " + symbol + "...");
      const m15 = await fetchKlines(symbol, "15", historyStartMs, testEndMs);
      const h1 = await fetchKlines(symbol, "60", historyStartMs, testEndMs);
      const h4 = await fetchKlines(symbol, "240", historyStartMs, testEndMs);
      const m5 = await fetchKlines(symbol, "5", testStartMs - INTERVALS["5"], testEndMs);
      if (m15.length < 150 || h1.length < 100 || h4.length < 60 || m5.length < 100) {
        throw new Error("Insufficient history: 15m=" + m15.length + ", 1h=" + h1.length + ", 4h=" + h4.length + ", 5m=" + m5.length);
      }
      const data = { m15, h1, h4, m5, btc15 };
      const a = runEngine({ engine: "A", symbol, data, testStartMs, testEndMs });
      const b = runEngine({ engine: "B", symbol, data, testStartMs, testEndMs });
      results.push({ symbol, candles: { "15m": m15.length, "1h": h1.length, "4h": h4.length, "5m": m5.length }, A: a, B: b });
    } catch (error) {
      results.push({ symbol, error: String(error?.message || error) });
    }
  }

  const successful = results.filter(r => !r.error);
  const aggregate = engine => summarize(successful.flatMap(r => r[engine].trades));
  const report = {
    generatedAt: new Date().toISOString(),
    venue: "Bybit linear USDT perpetual public OHLCV",
    period: { from: new Date(testStartMs).toISOString(), to: new Date(testEndMs).toISOString(), days: DAYS, warmupDays: WARMUP_DAYS },
    rules: {
      leverage: LEVERAGE, marginProfitTargetPct: MARGIN_TARGET_PCT,
      requiredFavorablePriceMovePct: MARGIN_TARGET_PCT / LEVERAGE,
      winDefinition: "5m candles reach +30% gross ROI on margin before stop",
      lossDefinition: "stop is reached before +30% margin ROI",
      execution: "signal uses only closed candles; entry at next available 5m candle open",
      ambiguous5mCandles: "if target and stop both fall within one 5m candle, count stop-first",
      stop: "engine-provided stop remains fixed after next-5m-open entry",
      sameSymbolConcurrency: "one open LONG per symbol; next signal allowed only after prior trade closes",
      costs: "fees, funding and slippage excluded; results are gross",
      universe: "fixed seven symbols from the supplied scanner; no dynamic universe selection"
    },
    symbolsTested: successful.length,
    symbolErrors: results.filter(r => r.error).map(r => ({ symbol: r.symbol, error: r.error })),
    aggregate: { A: aggregate("A"), B: aggregate("B") },
    bySymbol: successful.map(r => ({
      symbol: r.symbol, candles: r.candles, A: r.A.metrics, B: r.B.metrics
    })),
    trades: {
      A: successful.flatMap(r => r.A.trades).sort((a,b) => a.signalCloseTime - b.signalCloseTime),
      B: successful.flatMap(r => r.B.trades).sort((a,b) => a.signalCloseTime - b.signalCloseTime)
    }
  };

  await mkdir("artifacts", { recursive: true });
  await writeFile("artifacts/breakout-retest-long-comparison.json", JSON.stringify(report, null, 2));
  const rows = [
    "# Breakout-retest LONG: Version A vs Version B", "",
    "Period: " + report.period.from + " — " + report.period.to + " (" + DAYS + " days)",
    "Symbols tested: " + report.symbolsTested + "/" + SYMBOLS.length, "",
    "| Metric | Version A: Python baseline | Version B: advanced |",
    "|---|---:|---:|",
    "| Signals | " + report.aggregate.A.signals + " | " + report.aggregate.B.signals + " |",
    "| Closed trades | " + report.aggregate.A.closedTrades + " | " + report.aggregate.B.closedTrades + " |",
    "| Wins (+30% before stop) | " + report.aggregate.A.wins30PctBeforeStop + " | " + report.aggregate.B.wins30PctBeforeStop + " |",
    "| Stop-first losses | " + report.aggregate.A.stopFirst + " | " + report.aggregate.B.stopFirst + " |",
    "| Open at end | " + report.aggregate.A.openAtEnd + " | " + report.aggregate.B.openAtEnd + " |",
    "| Win rate | " + report.aggregate.A.winRatePct.toFixed(2) + "% | " + report.aggregate.B.winRatePct.toFixed(2) + "% |",
    "| Net gross margin ROI points | " + report.aggregate.A.totalMarginRoiPct.toFixed(2) + "% | " + report.aggregate.B.totalMarginRoiPct.toFixed(2) + "% |",
    "| Average margin ROI / closed trade | " + report.aggregate.A.averageMarginRoiPct.toFixed(2) + "% | " + report.aggregate.B.averageMarginRoiPct.toFixed(2) + "% |",
    "| Max drawdown (additive ROI points) | " + report.aggregate.A.maxDrawdownMarginPoints.toFixed(2) + "% | " + report.aggregate.B.maxDrawdownMarginPoints.toFixed(2) + "% |",
    "| Ambiguous 5m candles | " + report.aggregate.A.ambiguous5mCandles + " | " + report.aggregate.B.ambiguous5mCandles + " |",
    "", "| Symbol | A signals | A wins | A stops | A win rate | B signals | B wins | B stops | B win rate |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|",
    ...report.bySymbol.map(r => "| " + r.symbol + " | " + r.A.signals + " | " + r.A.wins30PctBeforeStop + " | " + r.A.stopFirst + " | " + r.A.winRatePct.toFixed(2) + "% | " + r.B.signals + " | " + r.B.wins30PctBeforeStop + " | " + r.B.stopFirst + " | " + r.B.winRatePct.toFixed(2) + "% |"),
    "", "## Limitations", "",
    "- Gross results exclude fees, funding and slippage.",
    "- 5m OHLC cannot reveal the exact intrabar path; candles touching both stop and target are conservatively classified stop-first.",
    "- Historical entry is the next available 5m candle open, not the signal candle close.",
    "- Version A uses BTC 15m EMA50 as in the supplied Python scanner. Version B uses its 1h/4h trend filters and does not add the BTC filter.",
    "- Version A compares breakout volume with the 20 preceding completed candles; this corrects the source script's self-inclusion of breakout volume.",
    "", "## Data errors", ...report.symbolErrors.map(x => "- " + x.symbol + ": " + x.error)
  ];
  await writeFile("artifacts/breakout-retest-long-comparison.md", rows.join("\n"));
  console.log(JSON.stringify({ period: report.period, aggregate: report.aggregate, bySymbol: report.bySymbol, symbolErrors: report.symbolErrors }, null, 2));
  if (!successful.length) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}

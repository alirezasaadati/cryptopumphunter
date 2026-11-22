import { mkdir, writeFile } from "node:fs/promises";

const BASE = "https://futures.kraken.com";
const INTERVAL_MS = 15 * 60 * 1000;
const FEE_PER_SIDE = 0.0005;
const SLIPPAGE_PER_SIDE = 0.0003;
const SYMBOLS = ["PF_XBTUSD", "PF_ETHUSD"];
const PERIODS = [
  { name: "strong_bullish", label: "بازار صعودی قوی", from: "2024-10-01T00:00:00Z", to: "2024-10-31T00:00:00Z" },
  { name: "sideways_bullish", label: "بازار خنثی متمایل به صعودی", from: "2024-07-01T00:00:00Z", to: "2024-07-31T00:00:00Z" }
];
const CFG = { MIN_CANDLES: 60, TARGET_1_R: 1.5, STOP_BUFFER_ATR: 0.1, MAX_RISK_PCT: 1.0 };

async function getCandles(symbol, fromMs, toMs) {
  const url = new URL(BASE + "/api/charts/v1/trade/" + encodeURIComponent(symbol) + "/15m");
  url.searchParams.set("from", String(Math.floor(fromMs / 1000)));
  url.searchParams.set("to", String(Math.floor(toMs / 1000)));
  url.searchParams.set("count", "5000");
  const response = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(30000) });
  const body = await response.text();
  if (!response.ok) throw new Error("Kraken HTTP " + response.status + ": " + body.slice(0, 250));
  const data = JSON.parse(body);
  if (!Array.isArray(data?.candles)) throw new Error("Kraken candle response missing: " + body.slice(0, 250));
  const byTime = new Map();
  for (const row of data.candles) {
    const time = Number(row.time) < 1e12 ? Number(row.time) * 1000 : Number(row.time);
    const c = { time, open: Number(row.open), high: Number(row.high), low: Number(row.low), close: Number(row.close), volume: Number(row.volume) };
    if (Number.isFinite(time) && c.open > 0 && c.high >= c.low && c.low > 0 && c.close > 0 && time + INTERVAL_MS <= Date.now()) byTime.set(time, c);
  }
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}
function average(values) { return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0; }

// Reproduces the RSI implementation supplied in v9.0.0.
function rsi(values, period = 14) {
  if (values.length <= period) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const change = values[i] - values[i - 1];
    gains += Math.max(change, 0);
    losses += Math.max(-change, 0);
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
function atr(candles, period = 14) {
  if (candles.length <= period) return null;
  const ranges = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], prevClose = candles[i - 1].close;
    ranges.push(Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose)));
  }
  return average(ranges.slice(-period));
}
function analyze(candles, entryOpen) {
  if (candles.length < CFG.MIN_CANDLES) return null;
  const last = candles.at(-1), prev = candles.at(-2);
  const rsiValue = rsi(candles.map(c => c.close), 14);
  const a = atr(candles, 14);
  // Keep the original truthiness check exactly as written in the submitted code.
  if (!rsiValue || !a) return null;
  if (rsiValue > 25) return null;
  if (last.close <= last.open) return null;
  const entry = entryOpen;
  const stop = prev.low - a * CFG.STOP_BUFFER_ATR;
  const risk = entry - stop;
  const riskPct = risk / entry * 100;
  if (risk <= 0 || riskPct > CFG.MAX_RISK_PCT) return null;
  return { entry, stop, target1: entry + risk * CFG.TARGET_1_R, risk, riskPct, rsi: rsiValue };
}
function settle(entryFill, exitRaw, risk, reason, time, isOpen = false) {
  const exitFill = exitRaw * (1 - SLIPPAGE_PER_SIDE);
  const grossPnl = exitFill - entryFill;
  const fees = (entryFill * FEE_PER_SIDE) + (exitFill * FEE_PER_SIDE);
  const netPnl = grossPnl - fees;
  return { reason, exitTime: time, exitPrice: exitRaw, entryFill, exitFill, grossPnl, fees, netPnl, netR: netPnl / risk, open: isOpen };
}
function simulate(candles, entryIndex, signal) {
  const entryFill = signal.entry * (1 + SLIPPAGE_PER_SIDE);
  const risk = entryFill - signal.stop;
  const target = signal.target1;
  if (!(risk > 0)) return null;
  for (let i = entryIndex; i < candles.length; i++) {
    const c = candles[i];
    // Conservative intrabar rule: if stop and target both touch, stop is counted first.
    if (c.open <= signal.stop || c.low <= signal.stop) {
      const exit = c.open <= signal.stop ? c.open : signal.stop;
      return settle(entryFill, exit, risk, "STOP", c.time);
    }
    if (c.open >= target || c.high >= target) {
      // TP1 closes the entire position. Limit target fill is conservatively capped at target.
      return settle(entryFill, target, risk, "TP1", c.time);
    }
  }
  const last = candles.at(-1);
  return settle(entryFill, last.close, risk, "OPEN_MARKED_TO_MARKET", last.time, true);
}
function metrics(trades) {
  const closed = trades.filter(t => !t.open);
  const wins = closed.filter(t => t.netPnl > 0), losses = closed.filter(t => t.netPnl < 0), be = closed.filter(t => Math.abs(t.netPnl) < 1e-12);
  const grossWins = wins.reduce((s, t) => s + t.netPnl, 0);
  const grossLosses = Math.abs(losses.reduce((s, t) => s + t.netPnl, 0));
  let equity = 0, peak = 0, maxDD = 0;
  for (const t of [...closed].sort((a, b) => a.entryTime - b.entryTime)) {
    equity += t.netR;
    peak = Math.max(peak, equity);
    maxDD = Math.max(maxDD, peak - equity);
  }
  return {
    totalTrades: trades.length, closedTrades: closed.length, openAtEnd: trades.length - closed.length,
    wins: wins.length, losses: losses.length, breakeven: be.length,
    winRatePct: closed.length ? wins.length / closed.length * 100 : 0,
    netPnlUsdPerOneUnit: trades.reduce((s, t) => s + t.netPnl, 0),
    netR: trades.reduce((s, t) => s + t.netR, 0),
    expectancyRClosed: closed.length ? closed.reduce((s, t) => s + t.netR, 0) / closed.length : 0,
    profitFactor: grossLosses ? grossWins / grossLosses : (grossWins ? null : 0),
    maxDrawdownR: maxDD,
    tp1: trades.filter(t => t.reason === "TP1").length,
    stops: trades.filter(t => t.reason === "STOP").length
  };
}
async function runPeriod(period) {
  const from = Date.parse(period.from), to = Date.parse(period.to);
  const fetchFrom = from - 7 * 24 * 60 * 60 * 1000;
  const bySymbol = [], allTrades = [];
  for (const symbol of SYMBOLS) {
    try {
      const candles = await getCandles(symbol, fetchFrom, to);
      if (candles.length < CFG.MIN_CANDLES + 10) throw new Error("Insufficient 15m candles returned: " + candles.length);
      const trades = [];
      let nextAvailable = 0;
      for (let i = CFG.MIN_CANDLES - 1; i < candles.length - 1; i++) {
        const signalCloseTime = candles[i].time + INTERVAL_MS;
        if (signalCloseTime < from || signalCloseTime >= to || i < nextAvailable) continue;
        const signal = analyze(candles.slice(0, i + 1), candles[i + 1].open);
        if (!signal) continue;
        const trade = simulate(candles, i + 1, signal);
        if (!trade) continue;
        trade.symbol = symbol;
        trade.signalTime = candles[i].time;
        trade.entryTime = candles[i + 1].time;
        trade.riskPct = signal.riskPct;
        trade.rsiAtSignal = signal.rsi;
        trades.push(trade);
        allTrades.push(trade);
        if (trade.open) nextAvailable = candles.length;
        else {
          const exitIndex = candles.findIndex(c => c.time === trade.exitTime);
          nextAvailable = Math.max(i + 1, exitIndex + 1);
        }
      }
      bySymbol.push({ symbol, candleCount: candles.length, metrics: metrics(trades), trades });
    } catch (e) {
      bySymbol.push({ symbol, error: e.message, candleCount: 0, metrics: metrics([]), trades: [] });
    }
  }
  const btcCandles = await getCandles("PF_XBTUSD", from, to);
  const first = btcCandles.find(c => c.time >= from);
  const last = [...btcCandles].reverse().find(c => c.time + INTERVAL_MS <= to);
  const btcReturnPct = first && last ? (last.close / first.open - 1) * 100 : null;
  return { name: period.name, label: period.label, period: { from: period.from, to: period.to }, btcReturnPct, metrics: metrics(allTrades), symbols: bySymbol.map(({ trades, ...x }) => x), trades: allTrades };
}
async function main() {
  const periods = [];
  for (const p of PERIODS) periods.push(await runPeriod(p));
  await mkdir("artifacts", { recursive: true });
  const report = {
    version: "9.0.0 LONG Mean-Reversion Scalp",
    generatedAt: new Date().toISOString(),
    exchange: "Kraken Futures", timeframe: "15m", symbols: SYMBOLS,
    assumptions: {
      entry: "next 15m candle open after closed signal candle",
      stop: "previous candle low minus 0.1 ATR",
      target: "full position closed at 1.5R",
      ambiguity: "stop-first if stop and target touch in the same candle",
      fees: "0.05% per side", slippage: "0.03% adverse per side",
      funding: "excluded", concurrency: "one open trade per symbol",
      openTrades: "marked to market at period end and excluded from closed-trade win rate",
      positionSize: "PnL shown per one unit of underlying position; R-normalized metrics are size-independent"
    },
    periods
  };
  await writeFile("artifacts/v900-long-scalp-report.json", JSON.stringify(report, null, 2));
  const lines = [
    "# v9.0.0 LONG Mean-Reversion Scalp — Historical Backtest", "",
    "Kraken Futures; PF_XBTUSD and PF_ETHUSD; 15m candles.",
    "Entry next candle open; full close at 1.5R or stop. Fees 0.05%/side and adverse slippage 0.03%/side; funding excluded.",
    "One active trade per symbol. Open trades at period end are marked to market and excluded from closed-trade win rate.", ""
  ];
  for (const p of periods) {
    const m = p.metrics;
    lines.push("## " + p.label, "", "Period: " + p.period.from + " to " + p.period.to,
      "BTC change: " + (p.btcReturnPct === null ? "n/a" : p.btcReturnPct.toFixed(2) + "%"), "",
      "| Metric | Result |", "|---|---:|",
      "| Total trades | " + m.totalTrades + " |", "| Closed / open | " + m.closedTrades + " / " + m.openAtEnd + " |",
      "| Wins / losses / BE | " + m.wins + " / " + m.losses + " / " + m.breakeven + " |",
      "| Win rate (closed) | " + m.winRatePct.toFixed(2) + "% |", "| Net R | " + m.netR.toFixed(2) + "R |",
      "| Expectancy | " + m.expectancyRClosed.toFixed(3) + "R |", "| Profit Factor | " + (m.profitFactor === null ? "n/a" : m.profitFactor.toFixed(2)) + " |",
      "| Max drawdown | " + m.maxDrawdownR.toFixed(2) + "R |", "| TP1 / stops | " + m.tp1 + " / " + m.stops + " |", "",
      "| Symbol | Trades | Wins | Losses | Net R | PF |", "|---|---:|---:|---:|---:|---:|",
      ...p.symbols.map(s => "| " + s.symbol + " | " + s.metrics.totalTrades + " | " + s.metrics.wins + " | " + s.metrics.losses + " | " + s.metrics.netR.toFixed(2) + " | " + (s.metrics.profitFactor === null ? "n/a" : s.metrics.profitFactor.toFixed(2)) + " |"), "");
  }
  await writeFile("artifacts/v900-long-scalp-report.md", lines.join("\n"));
  console.log(JSON.stringify(periods.map(p => ({ name: p.name, btcReturnPct: p.btcReturnPct, metrics: p.metrics, symbols: p.symbols })), null, 2));
}
main().catch(e => { console.error(e); process.exitCode = 1; });

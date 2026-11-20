// One-year PA v2.2 backtest on the five highest-quote-volume Kraken USD perpetuals.
// Universe selection deliberately mirrors src/symbol-universe.js supplied by the user.
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { execFile } from "node:child_process";

const execFileAsync = promisify(execFile);
const BASE = "https://futures.kraken.com";
const MIN_QUOTE_VOLUME_24H = 10_000_000;
const MAX_SYMBOLS = 5;
const EXCLUDED_SYMBOLS = new Set();

async function getTopFiveSymbols() {
  const res = await fetch(`${BASE}/derivatives/api/v3/tickers`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(30000)
  });
  if (!res.ok) throw new Error(`Kraken tickers HTTP ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data?.tickers)) throw new Error("Kraken tickers response invalid");

  const eligible = data.tickers.filter(t =>
    t?.tag === "perpetual" &&
    t.suspended !== true &&
    /^(PI|PF)_[A-Z0-9]+USD$/.test(String(t.symbol || "")) &&
    Number(t.last) > 0 &&
    Number(t.volumeQuote) >= MIN_QUOTE_VOLUME_24H &&
    !EXCLUDED_SYMBOLS.has(t.symbol)
  );
  eligible.sort((a, b) => Number(b.volumeQuote) - Number(a.volumeQuote));
  return eligible.slice(0, MAX_SYMBOLS).map(t => ({
    symbol: t.symbol,
    volumeQuote24h: Number(t.volumeQuote),
    last: Number(t.last)
  }));
}

async function main() {
  const selected = await getTopFiveSymbols();
  if (selected.length !== MAX_SYMBOLS) {
    throw new Error(`Expected ${MAX_SYMBOLS} eligible symbols, got ${selected.length}. Refusing to silently run a smaller universe.`);
  }
  const symbols = selected.map(x => x.symbol);
  console.log("Selected top-five Kraken perpetuals by 24h quote volume:");
  console.log(JSON.stringify(selected, null, 2));

  await mkdir("artifacts", { recursive: true });
  const outcomes = [];
  for (let i = 0; i < symbols.length; i++) {
    const symbol = symbols[i];
    console.log(`\n[${i + 1}/${symbols.length}] ${symbol}`);
    try {
      const { stdout, stderr } = await execFileAsync("node", ["scripts/backtest-btc-1y.mjs"], {
        env: { ...process.env, BACKTEST_SYMBOL: symbol, BACKTEST_DAYS: "365", BACKTEST_WARMUP_DAYS: "20" },
        maxBuffer: 20 * 1024 * 1024,
        timeout: 12 * 60 * 1000
      });
      if (stdout) process.stdout.write(stdout);
      if (stderr) process.stderr.write(stderr);
      const report = JSON.parse(await readFile(`artifacts/${symbol}-backtest-1y.json`, "utf8"));
      outcomes.push({ symbol, ok: true, report });
    } catch (error) {
      console.error(`FAILED ${symbol}: ${error.message}`);
      outcomes.push({ symbol, ok: false, error: error.message });
    }
  }

  const successful = outcomes.filter(x => x.ok);
  const reports = successful.map(x => x.report);
  const trades = reports.flatMap(r => r.trades || []);
  const closed = trades.filter(t => !t.isOpen);
  const wins = closed.filter(t => t.netR > 0);
  const losses = closed.filter(t => t.netR < 0);
  const grossWin = wins.reduce((s, t) => s + t.netR, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.netR, 0));
  const chronologicalClosed = [...closed].sort((a, b) => Number(a.exitTime) - Number(b.exitTime));
  let equity = 0, peak = 0, maxDrawdownR = 0;
  for (const trade of chronologicalClosed) {
    equity += trade.netR;
    peak = Math.max(peak, equity);
    maxDrawdownR = Math.max(maxDrawdownR, peak - equity);
  }

  const summary = {
    requestedSymbols: MAX_SYMBOLS,
    testedSymbols: symbols.length,
    successfulSymbols: successful.length,
    failedSymbols: outcomes.length - successful.length,
    totalTrades: trades.length,
    closedTrades: closed.length,
    openTrades: trades.length - closed.length,
    tp1Trades: trades.filter(t => t.targetHits >= 1).length,
    tp2Trades: trades.filter(t => t.targetHits >= 2).length,
    tp3Trades: trades.filter(t => t.targetHits >= 3).length,
    stoppedTrades: trades.filter(t => t.exitReason === "STOP").length,
    longTrades: trades.filter(t => t.side === "LONG").length,
    shortTrades: trades.filter(t => t.side === "SHORT").length,
    wins: wins.length,
    losses: losses.length,
    winRatePct: closed.length ? wins.length / closed.length * 100 : 0,
    netR: trades.reduce((s, t) => s + t.netR, 0),
    expectancyR: closed.length ? closed.reduce((s, t) => s + t.netR, 0) / closed.length : 0,
    profitFactor: grossLoss ? grossWin / grossLoss : grossWin ? null : 0,
    maxDrawdownR
  };

  const perSymbol = successful.map(x => {
    const s = x.report.summary;
    return {
      symbol: x.symbol, trades: s.trades, closed: s.closedTrades, open: s.openTrades,
      tp1: s.tp1Trades, tp2: s.totalTargetHits, stops: s.stoppedTrades,
      longs: s.bySide.LONG.trades, shorts: s.bySide.SHORT.trades,
      winRatePct: s.winRatePct, netR: s.netR, profitFactor: s.profitFactor,
      maxDrawdownR: s.maxDrawdownR
    };
  });

  const result = {
    generatedAt: new Date().toISOString(),
    engine: "Pure Price Action v2.2",
    periodDays: 365,
    universeMethod: "Top 5 Kraken perpetual tickers by volumeQuote, minimum $10m, tag=perpetual, unsuspended, PI/PF USD symbols",
    selectedSymbols: selected,
    settings: {
      feePerSidePct: 0.05, slippagePerSidePct: 0.03,
      targetWeightsPct: [40, 35, 25], sameCandleRule: "stop_first",
      holdLimit: "none", funding: "excluded", warmupDays: 20
    },
    summary, perSymbol,
    failures: outcomes.filter(x => !x.ok),
    reports: reports.map(r => ({
      symbol: r.symbol, period: r.period, signals: r.signals,
      skipped: r.skipped, summary: r.summary, trades: r.trades
    }))
  };

  await writeFile("artifacts/pa-v22-5-symbols-1y.json", JSON.stringify(result, null, 2));
  const lines = [
    "# Pure Price Action v2.2 — five highest-volume Kraken perpetuals — one-year backtest",
    "", `Generated: ${result.generatedAt}`,
    `Selected symbols: ${selected.map(x => x.symbol).join(", ")}`,
    "Period: rolling 365 days per symbol | fee 0.05% per side | slippage 0.03% per side",
    "No time-based exit | same-candle: stop first | target weights: 40/35/25 | funding excluded | warmup: 20 days",
    "", "## Aggregate results", "",
    "| Metric | Result |", "|---|---:|",
    ...Object.entries(summary).map(([k, v]) => `| ${k} | ${typeof v === "number" ? (Number.isInteger(v) ? v : v.toFixed(3)) : v} |`),
    "", "## Selected symbols and 24h quote volume", "",
    "| Symbol | 24h quote volume | Last price |", "|---|---:|---:|",
    ...selected.map(x => `| ${x.symbol} | ${x.volumeQuote24h.toLocaleString("en-US")} | ${x.last} |`),
    "", "## Per-symbol results", "",
    "| Symbol | Trades | Closed | TP1 | Stops | Long | Short | Win rate | Net R | PF | Max DD R |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ...perSymbol.map(x => `| ${x.symbol} | ${x.trades} | ${x.closed} | ${x.tp1} | ${x.stops} | ${x.longs} | ${x.shorts} | ${x.winRatePct.toFixed(1)}% | ${x.netR.toFixed(2)} | ${x.profitFactor ?? "n/a"} | ${x.maxDrawdownR.toFixed(2)} |`),
    "", "## Failures", ...outcomes.filter(x => !x.ok).map(x => `- ${x.symbol}: ${x.error}`),
    "", "Open positions include only realized partial R; unrealized P&L and funding are excluded.",
    "Universe is selected using the current 24h volume snapshot, not point-in-time historical constituents."
  ];
  await writeFile("artifacts/pa-v22-5-symbols-1y.md", lines.join("\n"));
  console.log("\nAGGREGATE SUMMARY");
  console.log(JSON.stringify(summary, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; });

// Run the same 1-year Kraken perpetual backtest on the 30 most active USD-margined PF contracts.
import { mkdir, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { execFile } from "node:child_process";

const execFileAsync = promisify(execFile);
const BASE = "https://futures.kraken.com";
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function getInstruments() {
  const res = await fetch(`${BASE}/derivatives/api/v3/instruments`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`Kraken instruments HTTP ${res.status}`);
  const json = await res.json();
  const rows = json.instruments || json.result?.instruments || [];
  if (!Array.isArray(rows) || !rows.length) throw new Error("Kraken instruments response has no instruments array");
  const candidates = rows.filter(x =>
    x && typeof x.symbol === "string" &&
    x.symbol.startsWith("PF_") && x.symbol.endsWith("USD") &&
    x.tradeable !== false
  );
  candidates.sort((a,b) => Number(b.volume24h || b.volume || 0) - Number(a.volume24h || a.volume || 0));
  return candidates.slice(0, 30).map(x => x.symbol);
}

async function main() {
  const symbols = await getInstruments();
  if (symbols.length < 30) console.log(`WARNING: Kraken returned only ${symbols.length} eligible PF USD contracts; testing all available.`);
  console.log(`Selected ${symbols.length} symbols: ${symbols.join(", ")}`);
  await mkdir("artifacts", { recursive: true });
  const outcomes = [];
  for (let i = 0; i < symbols.length; i++) {
    const symbol = symbols[i];
    console.log(`\\n[${i+1}/${symbols.length}] ${symbol}`);
    try {
      const { stdout, stderr } = await execFileAsync("node", ["scripts/backtest-btc-1y.mjs"], {
        env: { ...process.env, BACKTEST_SYMBOL: symbol, BACKTEST_DAYS: "365", BACKTEST_WARMUP_DAYS: "20" },
        maxBuffer: 20 * 1024 * 1024,
        timeout: 12 * 60 * 1000
      });
      if (stdout) process.stdout.write(stdout);
      if (stderr) process.stderr.write(stderr);
      const report = JSON.parse(await (await import("node:fs/promises")).readFile(`artifacts/${symbol}-backtest-1y.json`, "utf8"));
      outcomes.push({ symbol, ok: true, report });
    } catch (error) {
      console.error(`FAILED ${symbol}: ${error.message}`);
      outcomes.push({ symbol, ok: false, error: error.message });
    }
    await sleep(200);
  }

  const successful = outcomes.filter(x => x.ok);
  const reports = successful.map(x => x.report);
  const trades = reports.flatMap(r => r.trades || []);
  const closed = trades.filter(t => !t.isOpen);
  const wins = closed.filter(t => t.netR > 0);
  const losses = closed.filter(t => t.netR < 0);
  const grossWin = wins.reduce((s,t) => s+t.netR, 0);
  const grossLoss = Math.abs(losses.reduce((s,t) => s+t.netR, 0));
  const summary = {
    requestedSymbols: 30,
    testedSymbols: symbols.length,
    successfulSymbols: successful.length,
    failedSymbols: outcomes.length - successful.length,
    totalTrades: trades.length,
    closedTrades: closed.length,
    openTrades: trades.length - closed.length,
    tp1Trades: trades.filter(t => t.targetHits >= 1).length,
    stoppedTrades: trades.filter(t => t.exitReason === "STOP").length,
    longTrades: trades.filter(t => t.side === "LONG").length,
    shortTrades: trades.filter(t => t.side === "SHORT").length,
    wins: wins.length,
    losses: losses.length,
    winRatePct: closed.length ? wins.length / closed.length * 100 : 0,
    netR: trades.reduce((s,t) => s+t.netR, 0),
    expectancyR: closed.length ? closed.reduce((s,t) => s+t.netR, 0) / closed.length : 0,
    profitFactor: grossLoss ? grossWin / grossLoss : grossWin ? null : 0,
    totalTargetHits: trades.reduce((s,t) => s+t.targetHits, 0)
  };
  const perSymbol = successful.map(x => {
    const s = x.report.summary;
    return { symbol: x.symbol, trades: s.trades, closed: s.closedTrades, tp1: s.tp1Trades, stops: s.stoppedTrades,
      longs: s.bySide.LONG.trades, shorts: s.bySide.SHORT.trades, winRatePct: s.winRatePct,
      netR: s.netR, profitFactor: s.profitFactor, maxDrawdownR: s.maxDrawdownR };
  }).sort((a,b) => b.netR - a.netR);

  const result = { generatedAt: new Date().toISOString(), periodDays: 365, settings: {
    feePerSidePct: 0.05, slippagePerSidePct: 0.03, targetWeightsPct: [40,35,25],
    sameCandleRule: "stop_first", holdLimit: "none", funding: "excluded"
  }, summary, perSymbol, failures: outcomes.filter(x => !x.ok), symbols, reports: reports.map(r => ({
    symbol: r.symbol, period: r.period, signals: r.signals, skipped: r.skipped, summary: r.summary, trades: r.trades
  })) };
  await writeFile("artifacts/pa-v22-30-symbols-1y.json", JSON.stringify(result, null, 2));
  const lines = [
    "# Pure Price Action v2.2 — 30-symbol one-year backtest", "",
    `Generated: ${result.generatedAt}`,
    `Eligible symbols: ${symbols.length}; successful: ${successful.length}; failed: ${summary.failedSymbols}`,
    "Period: rolling 365 days per symbol | Fee: 0.05% per side | Slippage: 0.03% per side",
    "No time-based exit | same-candle: stop first | target weights: 40/35/25 | funding excluded", "",
    "## Aggregate results", "",
    "| Metric | Result |", "|---|---:|",
    ...Object.entries(summary).map(([k,v]) => [`| ${k} | ${typeof v === "number" ? (Number.isInteger(v) ? v : v.toFixed(3)) : v} |`][0]),
    "", "## Per-symbol ranking (by net R)", "",
    "| Symbol | Trades | Closed | TP1 | Stops | Long | Short | Win rate | Net R | PF | Max DD R |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ...perSymbol.map(x => `| ${x.symbol} | ${x.trades} | ${x.closed} | ${x.tp1} | ${x.stops} | ${x.longs} | ${x.shorts} | ${x.winRatePct.toFixed(1)}% | ${x.netR.toFixed(2)} | ${x.profitFactor ?? "n/a"} | ${x.maxDrawdownR.toFixed(2)} |`),
    "", "## Failed symbols", "",
    ...outcomes.filter(x => !x.ok).map(x => `- ${x.symbol}: ${x.error}`),
    "", "Open positions are marked to their realized partial R only; unrealized P&L and funding are excluded."
  ];
  await writeFile("artifacts/pa-v22-30-symbols-1y.md", lines.join("\n"));
  console.log("\\nAGGREGATE SUMMARY");
  console.log(JSON.stringify(summary, null, 2));
}
main().catch(e => { console.error(e); process.exitCode = 1; });

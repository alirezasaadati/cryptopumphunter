const BASE = "https://futures.kraken.com";
const MIN = 60_000, FIFTEEN = 15 * MIN, DAYS = 30;
const END = Date.now(), START = END - DAYS * 86_400_000, WARMUP = START - 20 * 86_400_000;
const SYMBOL = "PI_XBTUSD"; // Kraken Futures BTC perpetual, same venue family used by the live signal engine.
const FEE = Number(process.env.FEE_RATE ?? 0.0005);
const SLIP = Number(process.env.SLIPPAGE ?? 0.0002);
const INITIAL = 10_000, SIZE = 0.10;

async function getJson(url) {
  const response = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
  const body = await response.text();
  if (!response.ok) throw new Error("Kraken HTTP " + response.status + " " + body.slice(0, 180));
  let data;
  try { data = JSON.parse(body); } catch { throw new Error("Invalid JSON from Kraken: " + url); }
  if (data?.result === "error" || (Array.isArray(data?.errors) && data.errors.length)) throw new Error("Kraken API error: " + JSON.stringify(data.errors || data.error));
  return data;
}

async function fetchChunk(fromMs, toMs) {
  const url = new URL(BASE + "/api/charts/v1/trade/" + SYMBOL + "/1m");
  url.searchParams.set("from", String(Math.floor(fromMs / 1000)));
  url.searchParams.set("to", String(Math.floor(toMs / 1000)));
  url.searchParams.set("count", "1900");
  const data = await getJson(url);
  if (!Array.isArray(data?.candles)) throw new Error("Kraken response has no candles array: " + JSON.stringify(data).slice(0, 300));
  if (data.more_candles === true) throw new Error("Kraken returned more candles than requested for chunk " + new Date(fromMs).toISOString());
  return data.candles.map(c => ({
    time: Number(c.time), open: Number(c.open), high: Number(c.high),
    low: Number(c.low), close: Number(c.close), volume: Number(c.volume)
  })).filter(c => Number.isFinite(c.time) && Number.isFinite(c.open) && Number.isFinite(c.high) &&
    Number.isFinite(c.low) && Number.isFinite(c.close) && Number.isFinite(c.volume) &&
    c.open > 0 && c.close > 0 && c.low > 0 && c.high >= c.low && c.volume >= 0 &&
    c.time + MIN <= END);
}

async function load() {
  const byTime = new Map();
  const chunkMs = 1800 * MIN;
  let pages = 0;
  for (let from = WARMUP; from < END; from += chunkMs) {
    const to = Math.min(END, from + chunkMs);
    const rows = await fetchChunk(from, to);
    for (const candle of rows) byTime.set(candle.time, candle);
    pages++;
    await new Promise(resolve => setTimeout(resolve, 120));
  }
  const rows = [...byTime.values()].sort((a, b) => a.time - b.time);
  const testRows = rows.filter(c => c.time >= START);
  if (testRows.length < 40_000) throw new Error("Insufficient Kraken 1m history: " + testRows.length + " candles in test window; expected at least 40,000.");
  return { rows, pages, testRows: testRows.length };
}

function ema(a, n) {
  const o = Array(a.length).fill(null);
  if (a.length < n) return o;
  let value = a.slice(0, n).reduce((x, y) => x + y, 0) / n;
  o[n - 1] = value;
  const k = 2 / (n + 1);
  for (let i = n; i < a.length; i++) { value = a[i] * k + o[i - 1] * (1 - k); o[i] = value; }
  return o;
}
function sma(a, n) {
  const o = Array(a.length).fill(null); let sum = 0;
  for (let i = 0; i < a.length; i++) { sum += a[i]; if (i >= n) sum -= a[i - n]; if (i >= n - 1) o[i] = sum / n; }
  return o;
}
function pivots(a, n) {
  const hi = Array(a.length).fill(null), lo = Array(a.length).fill(null);
  for (let i = 2 * n; i < a.length; i++) {
    const j = i - n, h = a[j].high, l = a[j].low; let isHigh = true, isLow = true;
    for (let k = j - n; k <= j + n; k++) { if (k === j) continue; if (a[k].high >= h) isHigh = false; if (a[k].low <= l) isLow = false; }
    if (isHigh) hi[i] = h; if (isLow) lo[i] = l;
  }
  return { hi, lo };
}
function aggregate15(a) {
  const map = new Map();
  for (const c of a) {
    const time = Math.floor(c.time / FIFTEEN) * FIFTEEN;
    let item = map.get(time);
    if (!item) { item = { time, close: c.close, count: 0 }; map.set(time, item); }
    item.close = c.close; item.count++;
  }
  return [...map.values()].filter(x => x.count === 15).sort((a, b) => a.time - b.time);
}
function stats(trades) {
  let equity = INITIAL, peak = INITIAL, maxDD = 0, grossWin = 0, grossLoss = 0;
  for (const trade of trades) { equity += trade.net; peak = Math.max(peak, equity); maxDD = Math.max(maxDD, (peak - equity) / peak); if (trade.net > 0) grossWin += trade.net; else grossLoss -= trade.net; }
  const wins = trades.filter(t => t.net > 0).length;
  return { trades: trades.length, wins, losses: trades.length - wins, winRate: trades.length ? wins / trades.length * 100 : 0,
    profitFactor: grossLoss ? grossWin / grossLoss : grossWin ? null : 0, netPnl: equity - INITIAL,
    returnPct: (equity / INITIAL - 1) * 100, maxDrawdownPct: maxDD * 100, endingEquity: equity };
}
function runTest(a, improved) {
  const close = a.map(x => x.close), ema20 = ema(close, 20), avgVol = sma(a.map(x => x.volume), 20), pv = pivots(a, 10);
  const htf = aggregate15(a), ema50 = ema(htf.map(x => x.close), 50);
  let resistance = null, support = null, htfIndex = -1, position = null;
  const trades = [], first = a.findIndex(x => x.time >= START);
  function closePosition(candle, rawPrice, reason) {
    const p = position;
    const entryFill = p.entry * (p.side === "LONG" ? 1 + SLIP : 1 - SLIP);
    const exitFill = rawPrice * (p.side === "LONG" ? 1 - SLIP : 1 + SLIP);
    const qty = p.equity * SIZE / p.entry;
    const gross = p.side === "LONG" ? (exitFill - entryFill) * qty : (entryFill - exitFill) * qty;
    const fees = (entryFill + exitFill) * qty * FEE;
    trades.push({ side: p.side, signalTime: p.signalTime, entryTime: p.entryTime, exitTime: candle.time,
      entry: p.entry, exit: rawPrice, stop: p.stop, target: p.target, reason, gross, fees, net: gross - fees });
    position = null;
  }
  for (let i = 0; i < a.length; i++) {
    const c = a[i];
    while (htfIndex + 1 < htf.length && htf[htfIndex + 1].time + FIFTEEN <= c.time + MIN) htfIndex++;
    if (pv.hi[i] !== null) resistance = pv.hi[i];
    if (pv.lo[i] !== null) support = pv.lo[i];
    if (position) {
      const stopHit = position.side === "LONG" ? c.low <= position.stop : c.high >= position.stop;
      const targetHit = position.side === "LONG" ? c.high >= position.target : c.low <= position.target;
      if (stopHit) {
        const gap = position.side === "LONG" ? c.open <= position.stop : c.open >= position.stop;
        closePosition(c, gap ? c.open : position.stop, "STOP");
      } else if (targetHit) {
        const gap = position.side === "LONG" ? c.open >= position.target : c.open <= position.target;
        closePosition(c, gap ? c.open : position.target, "TARGET");
      }
    }
    if (i < first || i >= a.length - 1 || position || ema20[i] === null || avgVol[i] === null || htfIndex < 0 || ema50[htfIndex] === null) continue;
    const range = c.high - c.low, body = c.close - c.open, volumeOK = c.volume > avgVol[i] * (improved ? 2 : 1.5);
    const bullish = body > 0 && c.close > ema20[i] && body > range * 0.6;
    const bearish = body < 0 && c.close < ema20[i] && -body > range * 0.6;
    const nearSupport = support !== null && c.low <= support * 1.001 && c.close > support;
    const nearResistance = resistance !== null && c.high >= resistance * 0.999 && c.close < resistance;
    const longSignal = nearSupport && c.close > ema20[i] && (!improved || c.close > ema50[htfIndex]) && bullish && volumeOK;
    const shortSignal = nearResistance && c.close < ema20[i] && (!improved || c.close < ema50[htfIndex]) && bearish && volumeOK;
    const buffer = improved ? 0.002 : 0.001, rr = improved ? 2.5 : 2, next = a[i + 1];
    if (longSignal) {
      const stop = support * (1 - buffer), risk = c.close - stop;
      if (risk > 0) position = { side: "LONG", signalTime: c.time, entryTime: next.time, entry: next.open, stop, target: c.close + risk * rr, equity: stats(trades).endingEquity };
    } else if (shortSignal) {
      const stop = resistance * (1 + buffer), risk = stop - c.close;
      if (risk > 0) position = { side: "SHORT", signalTime: c.time, entryTime: next.time, entry: next.open, stop, target: c.close - risk * rr, equity: stats(trades).endingEquity };
    }
  }
  if (position) closePosition(a[a.length - 1], a[a.length - 1].close, "END_OF_DATA");
  return { combined: stats(trades), long: stats(trades.filter(t => t.side === "LONG")), short: stats(trades.filter(t => t.side === "SHORT")), trades };
}
async function main() {
  const loaded = await load(), candles = loaded.rows;
  const baseline = runTest(candles, false), improved = runTest(candles, true);
  const period = { from: new Date(START).toISOString(), to: new Date(END).toISOString(), days: DAYS };
  const report = {
    venue: "Kraken Futures", symbol: SYMBOL, timeframe: "1m", priceFeed: "trade candles",
    period, data: { candlesInTestWindow: loaded.testRows, totalWithWarmup: candles.length, chunks: loaded.pages },
    assumptions: { entry: "next 1m candle open", stopTarget: "levels calculated from signal candle close",
      sizing: "10% equity notional", feePerSide: FEE, slippagePerSide: SLIP, funding: "excluded",
      intrabar: "stop-first if stop and target both touched in one candle",
      htf: "latest fully closed 15m EMA50; no lookahead" },
    baseline: { settings: { volumeMultiplier: 1.5, rr: 2, slBuffer: 0.001, htf: false },
      combined: baseline.combined, long: baseline.long, short: baseline.short },
    improved: { settings: { volumeMultiplier: 2, rr: 2.5, slBuffer: 0.002, htf: "15m EMA50" },
      combined: improved.combined, long: improved.long, short: improved.short,
      breakEven: "not implemented in supplied Pine code" },
    trades: { baseline: baseline.trades, improved: improved.trades }
  };
  const { mkdir, writeFile } = await import("node:fs/promises");
  await mkdir("artifacts", { recursive: true });
  await writeFile("artifacts/pine-btcusdt-1m-improved-30d.json", JSON.stringify(report, null, 2));
  const lines = ["# BTC 1m Pine backtest: baseline vs improved", "",
    "Venue: Kraken Futures (" + SYMBOL + "), trade candles", "Period: " + period.from + " to " + period.to,
    "Test candles: " + loaded.testRows, "Fees/slippage included as stated assumptions; funding excluded.",
    "Stop-first intrabar assumption. Break-even excluded because it is not implemented in supplied Pine code.", "",
    "| Variant | Side | Trades | Win rate | PF | Net PnL | Return | Max DD |",
    "|---|---|---:|---:|---:|---:|---:|---:|"];
  for (const variant of ["baseline", "improved"]) for (const side of ["combined", "long", "short"]) {
    const x = report[variant][side];
    lines.push("| " + variant + " | " + side + " | " + x.trades + " | " + x.winRate.toFixed(2) + "% | " +
      (x.profitFactor === null ? "∞" : x.profitFactor.toFixed(3)) + " | $" + x.netPnl.toFixed(2) + " | " +
      x.returnPct.toFixed(3) + "% | " + x.maxDrawdownPct.toFixed(3) + "% |");
  }
  await writeFile("artifacts/pine-btcusdt-1m-improved-30d.md", lines.join("\n"));
  console.log(JSON.stringify({ ok: true, venue: report.venue, symbol: SYMBOL, period, data: report.data,
    baseline: { combined: baseline.combined, long: baseline.long, short: baseline.short },
    improved: { combined: improved.combined, long: improved.long, short: improved.short } }, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; });

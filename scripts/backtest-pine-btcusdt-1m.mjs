import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = "https://data.binance.vision/data/futures/um/daily/klines";
const MIN = 60_000, FIFTEEN = 15 * MIN, DAY = 86_400_000, DAYS = 30;
const END = Math.floor(Date.now() / DAY) * DAY - DAY; // latest fully published UTC archive boundary
const START = END - DAYS * DAY, WARMUP = START - 20 * DAY;
const SYMBOL = "BTCUSDT"; // Binance USDⓈ-M perpetual historical archive.
const FEE = Number(process.env.FEE_RATE ?? 0.0004);
const SLIP = Number(process.env.SLIPPAGE ?? 0.0002);
const INITIAL = 10_000, SIZE = 0.10;

async function getJson(url) {
  const response = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
  const body = await response.text();
  if (!response.ok) throw new Error("Historical data HTTP " + response.status + " " + body.slice(0, 180));
  let data;
  try { data = JSON.parse(body); } catch { throw new Error("Invalid JSON from historical data source: " + url); }
  if (data?.result === "error" || (Array.isArray(data?.errors) && data.errors.length)) throw new Error("Historical data API error: " + JSON.stringify(data.errors || data.error));
  return data;
}

function utcDate(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

async function fetchDay(dayMs, tempDir) {
  const date = utcDate(dayMs);
  const filename = `${SYMBOL}-1m-${date}.zip`;
  const url = `${BASE}/${SYMBOL}/1m/${filename}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`Binance historical archive unavailable: ${filename} (HTTP ${response.status})`);
  const bytes = Buffer.from(await response.arrayBuffer());

  const checksumResponse = await fetch(url + ".CHECKSUM", { signal: AbortSignal.timeout(30_000) });
  if (!checksumResponse.ok) throw new Error(`Binance checksum unavailable for ${filename} (HTTP ${checksumResponse.status})`);
  const checksumText = await checksumResponse.text();
  const expectedHash = checksumText.match(/[a-f0-9]{64}/i)?.[0]?.toLowerCase();
  const actualHash = createHash("sha256").update(bytes).digest("hex");
  if (!/^[a-f0-9]{64}$/.test(expectedHash) || actualHash !== expectedHash) {
    throw new Error(`SHA-256 checksum mismatch for ${filename}`);
  }

  const zipPath = join(tempDir, filename);
  await writeFile(zipPath, bytes);
  let csv;
  try {
    csv = execFileSync("unzip", ["-p", zipPath], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  } catch (error) {
    throw new Error(`Could not extract ${filename}: ${error.message}`);
  }
  const rows = [];
  for (const line of csv.split(/\r?\n/)) {
    if (!line || !/^\d/.test(line)) continue; // skip the USD-M CSV header
    const fields = line.split(",");
    if (fields.length < 6) continue;
    const c = { time: Number(fields[0]), open: Number(fields[1]), high: Number(fields[2]),
      low: Number(fields[3]), close: Number(fields[4]), volume: Number(fields[5]) };
    if (Number.isFinite(c.time) && Number.isFinite(c.open) && Number.isFinite(c.high) &&
        Number.isFinite(c.low) && Number.isFinite(c.close) && Number.isFinite(c.volume) &&
        c.open > 0 && c.close > 0 && c.low > 0 && c.high >= c.low && c.volume >= 0 &&
        c.time >= dayMs && c.time < dayMs + DAY) rows.push(c);
  }
  rows.sort((a, b) => a.time - b.time);
  if (rows.length !== 1440) {
    throw new Error(`Incomplete ${date} archive: received ${rows.length}/1440 one-minute candles`);
  }
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].time - rows[i - 1].time !== MIN) {
      throw new Error(`Missing/duplicate minute in ${date} archive near ${new Date(rows[i - 1].time).toISOString()}`);
    }
  }
  console.log(`Historical archive ${date}: ${rows.length} candles; SHA-256 verified`);
  return rows;
}

async function load() {
  const tempDir = await mkdtemp(join(tmpdir(), "btc-historical-"));
  try {
    const rows = [];
    let days = 0;
    for (let day = WARMUP; day < END; day += DAY) {
      rows.push(...await fetchDay(day, tempDir));
      days++;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const testRows = rows.filter(c => c.time >= START && c.time < END);
    if (testRows.length !== DAYS * 1440) {
      throw new Error(`Historical test window incomplete: ${testRows.length}/${DAYS * 1440} candles`);
    }
    return { rows, days, testRows: testRows.length };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
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
function runTest(a, improved, v2 = false) {
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
    const range = c.high - c.low, body = c.close - c.open, volumeOK = c.volume > avgVol[i] * (improved || v2 ? 2 : 1.5);
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
  const baseline = runTest(candles, false), improved = runTest(candles, true), v2 = runTest(candles, false, true);
  const period = { from: new Date(START).toISOString(), to: new Date(END).toISOString(), days: DAYS };
  const report = {
    venue: "Binance USDⓈ-M Futures", symbol: SYMBOL, timeframe: "1m", priceFeed: "official daily historical kline archives",
    period, data: { candlesInTestWindow: loaded.testRows, totalWithWarmup: candles.length, dailyArchives: loaded.days, archiveIntegrity: "SHA-256 verified; 1440 contiguous candles required per UTC day" },
    assumptions: { entry: "next 1m candle open", stopTarget: "levels calculated from signal candle close",
      sizing: "10% equity notional", feePerSide: FEE, slippagePerSide: SLIP, funding: "excluded", commissionPolicy: "0.04% per side applied uniformly to all three variants for fair comparison",
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
  const lines = ["# BTC 1m Pine backtest: baseline vs improved vs supplied v2", "",
    "Venue: Binance USDⓈ-M Futures (" + SYMBOL + "), official historical 1m kline archives", "Period: " + period.from + " to " + period.to,
    "Test candles: " + loaded.testRows + " across " + loaded.days + " verified UTC daily archives", "Fees/slippage included as stated assumptions; funding excluded.",
    "Stop-first intrabar assumption. Break-even excluded because it is not implemented in supplied Pine code.", "",
    "| Variant | Side | Trades | Win rate | PF | Net PnL | Return | Max DD |",
    "|---|---|---:|---:|---:|---:|---:|---:|"];
  for (const variant of ["baseline", "improved", "v2"]) for (const side of ["combined", "long", "short"]) {
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

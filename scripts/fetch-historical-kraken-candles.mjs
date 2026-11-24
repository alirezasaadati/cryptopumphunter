import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const BASE = "https://futures.kraken.com";
const FROM = Math.floor(Date.parse("2026-11-10T00:00:00Z") / 1000);
const TO = Math.floor(Date.parse("2026-11-24T03:00:00Z") / 1000);
const INTERVALS = ["15m", "1h", "4h"];
const REQUESTED = ["BTC", "AAVE", "CRV", "ONDO", "ZEC", "INJ", "SOL", "NEAR", "ETH", "XRP", "ADA", "PUMP"];
const OUT = "data/historical-kraken";

function underlying(symbol) {
  return String(symbol || "").toUpperCase().replace(/^(PF|PI)_/, "").replace(/USD$/, "").replace(/^XBT$/, "BTC");
}

async function getJson(url) {
  const response = await fetch(url, { headers: { accept: "application/json", "user-agent": "Aurum-Historical-Backtest/1.0" } });
  const body = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}: ${body.slice(0, 250)}`);
  try { return JSON.parse(body); }
  catch { throw new Error(`Invalid JSON from ${url}: ${body.slice(0, 250)}`); }
}

const tickerData = await getJson(`${BASE}/derivatives/api/v3/tickers`);
const tickers = Array.isArray(tickerData?.tickers) ? tickerData.tickers : [];
if (!tickers.length) throw new Error("Kraken returned no futures tickers.");

const selected = [];
for (const asset of REQUESTED) {
  const matches = tickers.filter(t =>
    t?.tag === "perpetual" &&
    underlying(t.symbol) === asset &&
    t.suspended !== true
  );
  matches.sort((a, b) => String(a.symbol).startsWith("PF_") ? -1 : String(b.symbol).startsWith("PF_") ? 1 : 0);
  if (!matches.length) {
    selected.push({ asset, available: false, reason: "No active Kraken perpetual ticker found" });
    continue;
  }
  selected.push({ asset, symbol: matches[0].symbol, available: true });
}

await mkdir(OUT, { recursive: true });
const manifest = {
  exchange: "Kraken Futures",
  endpoint: "/api/charts/v1/trade/{symbol}/{resolution}",
  from: new Date(FROM * 1000).toISOString(),
  to: new Date(TO * 1000).toISOString(),
  fromEpochSeconds: FROM,
  toEpochSeconds: TO,
  intervals: INTERVALS,
  instruments: [],
  errors: []
};

for (const item of selected) {
  if (!item.available) {
    manifest.instruments.push(item);
    continue;
  }
  const record = { ...item, candles: {} };
  for (const interval of INTERVALS) {
    const url = new URL(`${BASE}/api/charts/v1/trade/${encodeURIComponent(item.symbol)}/${interval}`);
    url.searchParams.set("from", String(FROM));
    url.searchParams.set("to", String(TO));
    url.searchParams.set("count", "5000");
    try {
      const payload = await getJson(url);
      const candles = Array.isArray(payload?.candles) ? payload.candles : [];
      const normalized = candles.map(c => ({
        time: Number(c.time),
        open: Number(c.open),
        high: Number(c.high),
        low: Number(c.low),
        close: Number(c.close),
        volume: Number(c.volume)
      })).filter(c =>
        Number.isFinite(c.time) && c.time >= FROM * 1000 && c.time <= TO * 1000 &&
        [c.open,c.high,c.low,c.close,c.volume].every(Number.isFinite) &&
        c.open > 0 && c.high >= c.low && c.low > 0 && c.close > 0 && c.volume >= 0
      ).sort((a,b) => a.time-b.time);
      const file = join(OUT, `${item.symbol.replace(/[^A-Z0-9_-]/g,"_")}-${interval}.json`);
      await writeFile(file, JSON.stringify({ symbol: item.symbol, interval, from: FROM, to: TO, moreCandles: Boolean(payload.more_candles), candles: normalized }, null, 2));
      record.candles[interval] = { file, count: normalized.length, moreCandles: Boolean(payload.more_candles), first: normalized[0]?.time ?? null, last: normalized.at(-1)?.time ?? null };
      console.log(`OK ${item.symbol} ${interval}: ${normalized.length} candles`);
    } catch (error) {
      const message = String(error?.message || error);
      manifest.errors.push({ symbol: item.symbol, interval, error: message });
      record.candles[interval] = { error: message };
      console.error(`FAILED ${item.symbol} ${interval}: ${message}`);
    }
  }
  manifest.instruments.push(record);
}

await writeFile(join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2));
const successes = manifest.instruments.reduce((sum, x) => sum + Object.values(x.candles || {}).filter(c => Number.isInteger(c.count) && c.count > 0).length, 0);
console.log(JSON.stringify({ output: OUT, instruments: manifest.instruments.length, successfulSeries: successes, errors: manifest.errors.length, manifest: join(OUT, "manifest.json") }, null, 2));
if (!successes) process.exitCode = 1;

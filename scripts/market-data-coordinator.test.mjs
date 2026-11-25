import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../src/index.js", import.meta.url), "utf8");

test("Kraken candle network I/O is outside Durable Objects", () => {
  const coordinatorStart = source.indexOf("export class SignalDeliveryCoordinator");
  const coordinatorEnd = source.indexOf("async function showRecentFuturesSignalReport", coordinatorStart);
  assert.ok(coordinatorStart >= 0 && coordinatorEnd > coordinatorStart);
  const coordinator = source.slice(coordinatorStart, coordinatorEnd);
  assert.doesNotMatch(coordinator, /market-data\/candles/);
  assert.doesNotMatch(coordinator, /getKrakenFuturesCandles\(/);
});

test("Worker market-data adapter fetches candles directly and keeps the existing response shape", () => {
  const start = source.indexOf("async function getKrakenFuturesCandlesViaCoordinator");
  const end = source.indexOf("\n\nfunction normalizeKrakenFuturesUnderlying", start);
  assert.ok(start >= 0 && end > start);
  const adapter = source.slice(start, end);
  assert.match(adapter, /await getKrakenFuturesCandles\(normalizedSymbol, interval\)/);
  assert.match(adapter, /return \{ ok: true, symbol: normalizedSymbol, candles, errors, cacheStats \}/);
  assert.doesNotMatch(adapter, /env\.SIGNAL_DELIVERY/);
});

test("market-data cache is in-memory, isolated by symbol/interval, and expires at the next candle boundary", () => {
  const start = source.indexOf("async function getKrakenFuturesCandlesViaCoordinator");
  const end = source.indexOf("\n\nfunction normalizeKrakenFuturesUnderlying", start);
  const adapter = source.slice(start, end);
  assert.match(source, /const FUTURES_MARKET_DATA_MEMORY_CACHE = new Map\(\)/);
  assert.match(adapter, /normalizedSymbol \+ "\\|" \+ interval/);
  assert.match(adapter, /Math\.floor\(now \/ intervalMsMap\[interval\]\)/);
  assert.match(adapter, /FUTURES_MARKET_DATA_MEMORY_CACHE\.get\(cacheKey\)/);
  assert.match(adapter, /FUTURES_MARKET_DATA_MEMORY_CACHE\.set\(cacheKey/);
  assert.doesNotMatch(adapter, /caches\?\.default|cache\.match\(|cache\.put\(/);
});

test("existing market-data interval and symbol validation remains enforced", () => {
  const start = source.indexOf("async function getKrakenFuturesCandlesViaCoordinator");
  const end = source.indexOf("\n\nfunction normalizeKrakenFuturesUnderlying", start);
  const adapter = source.slice(start, end);
  assert.match(adapter, /\^\(PI\|PF\)_\[A-Z0-9\]\+USD\$/);
  assert.ok(adapter.includes('"5m": 300000, "15m": 900000, "1h": 3600000, "4h": 14400000'));
});


test("futures scan fetches 15m only after the unchanged 1h/4h preflight passes", () => {
  const start = source.indexOf("async function runFuturesSignalScan");
  const end = source.indexOf("\nasync function runFuturesSignalsForChat", start);
  assert.ok(start >= 0 && end > start);
  const scan = source.slice(start, end);
  assert.match(scan, /\[\s*FUTURES_CONFIG\.INTERVAL,\s*FUTURES_CONFIG\.CONFIRM_INTERVAL\s*\]/);
  assert.match(scan, /skipEntryFilters: true/);
  assert.match(scan, /preflight\?\.eligible !== true && preflight\?\.highRiskEligible !== true/);
  assert.match(scan, /\[FUTURES_CONFIG\.ENTRY_CONFIRM_INTERVAL\]/);
  assert.match(scan, /return analyzeFuturesSymbol\(ticker, oneHour, fourHour, fifteenMinute, analysisOptions\)/);
});

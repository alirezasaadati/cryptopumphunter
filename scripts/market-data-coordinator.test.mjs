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

test("market-data cache is isolated by symbol and interval and expires at the next candle boundary", () => {
  const start = source.indexOf("async function getKrakenFuturesCandlesViaCoordinator");
  const end = source.indexOf("\n\nfunction normalizeKrakenFuturesUnderlying", start);
  const adapter = source.slice(start, end);
  assert.match(adapter, /encodeURIComponent\(normalizedSymbol\).*encodeURIComponent\(interval\)/s);
  assert.match(adapter, /Math\.floor\(now \/ intervalMsMap\[interval\]\)/);
  assert.match(adapter, /cache\.match\(cacheRequest\)/);
  assert.match(adapter, /cache\.put\(cacheRequest, response\)/);
});

test("existing market-data interval and symbol validation remains enforced", () => {
  const start = source.indexOf("async function getKrakenFuturesCandlesViaCoordinator");
  const end = source.indexOf("\n\nfunction normalizeKrakenFuturesUnderlying", start);
  const adapter = source.slice(start, end);
  assert.match(adapter, /\^\(PI\|PF\)_\[A-Z0-9\]\+USD\$/);
  assert.ok(adapter.includes('"5m": 300000, "15m": 900000, "1h": 3600000, "4h": 14400000'));
});

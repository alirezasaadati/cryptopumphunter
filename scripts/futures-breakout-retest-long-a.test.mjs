import test from "node:test";
import assert from "node:assert/strict";
import { analyzeBreakoutRetestLongA, BREAKOUT_RETEST_LONG_A_VERSION } from "../src/futures-breakout-retest-long-a.js";

function risingCandles(count = 100) {
  return Array.from({ length: count }, (_, i) => {
    const close = 100 + i * 0.01;
    return { time: i, open: close - 0.03, high: close + 0.06, low: close - 0.06, close, volume: 100 };
  });
}
function validSetup() {
  const rows = risingCandles();
  rows[96] = { ...rows[96], open: 100.99, high: 101.06, low: 100.95, close: 101.02, volume: 100 };
  rows[97] = { ...rows[97], open: 100.98, high: 101.04, low: 100.94, close: 101.00, volume: 100 };
  rows[98] = { ...rows[98], open: 100.95, high: 101.38, low: 100.93, close: 101.30, volume: 200 };
  rows[99] = { ...rows[99], open: 101.20, high: 101.45, low: 101.00, close: 101.40, volume: 120 };
  return rows;
}

test("baseline A version is explicit", () => {
  assert.equal(BREAKOUT_RETEST_LONG_A_VERSION, "1.0.0");
});
test("baseline A accepts the Python strategy's BTC-filtered breakout and retest", () => {
  const candles = validSetup();
  const result = analyzeBreakoutRetestLongA({
    symbol: "TEST/USDT", candles15m: candles, candlesBtc15m: risingCandles()
  });
  assert.equal(result.eligible, true, JSON.stringify(result));
  assert.ok(result.stop < result.entry);
  assert.ok(result.tp1 > result.entry && result.tp2 > result.tp1);
  assert.ok(result.breakout.volumeRatio > 1.5);
});
test("baseline A rejects when BTC is below EMA50", () => {
  const btc = risingCandles();
  for (let i = 0; i < btc.length; i++) {
    const close = 110 - i * 0.1;
    btc[i] = { time: i, open: close + 0.02, high: close + 0.05, low: close - 0.05, close, volume: 100 };
  }
  const result = analyzeBreakoutRetestLongA({
    symbol: "TEST/USDT", candles15m: validSetup(), candlesBtc15m: btc
  });
  assert.equal(result.reason, "btc_below_ema50");
});
test("baseline A rejects a breakout without 1.5x prior volume", () => {
  const candles = validSetup();
  candles[98] = { ...candles[98], volume: 149 };
  const result = analyzeBreakoutRetestLongA({
    symbol: "TEST/USDT", candles15m: candles, candlesBtc15m: risingCandles()
  });
  assert.equal(result.eligible, false);
});
test("baseline A rejects an invalid or unfinished-data shape", () => {
  const candles = validSetup();
  candles[99] = { ...candles[99], low: 0 };
  const result = analyzeBreakoutRetestLongA({
    symbol: "TEST/USDT", candles15m: candles, candlesBtc15m: risingCandles()
  });
  assert.equal(result.reason, "invalid_or_missing_candles");
});

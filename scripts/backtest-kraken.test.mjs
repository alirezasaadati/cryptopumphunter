import test from "node:test";
import assert from "node:assert/strict";
import { calculateEntryFill, simulateTrade } from "./backtest-kraken.mjs";

test("entry fill applies adverse slippage once for long and short", () => {
  assert.equal(calculateEntryFill("LONG", 100, 0.001), 100.1);
  assert.equal(calculateEntryFill("SHORT", 100, 0.001), 99.9);
});

test("entry fill rejects invalid inputs", () => {
  assert.throws(() => calculateEntryFill("BUY", 100, 0.001));
  assert.throws(() => calculateEntryFill("LONG", 0, 0.001));
  assert.throws(() => calculateEntryFill("SHORT", 100, -0.001));
});

test("long simulation prioritizes stop when stop and target are touched in same candle", () => {
  const result = simulateTrade({
    side: "LONG", entry: 100, stop: 98, targets: [103, 105, 107],
    candles: [{ time: 1, open: 100, high: 104, low: 97, close: 101 }],
    startIndex: 0, fee: 0, slippage: 0, maxHoldHours: 1
  });
  assert.equal(result.exitReason, "STOP");
  assert.equal(result.targetHits, 0);
  assert.equal(result.netR, -1);
});

test("short simulation records partial target exits", () => {
  const result = simulateTrade({
    side: "SHORT", entry: 100, stop: 102, targets: [97, 95, 93],
    candles: [{ time: 1, open: 100, high: 100.5, low: 92, close: 94 }],
    startIndex: 0, fee: 0, slippage: 0, maxHoldHours: 1
  });
  assert.equal(result.exitReason, "TARGETS");
  assert.equal(result.targetHits, 3);
  assert.equal(result.netR, 2.5);
});

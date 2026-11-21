import test from "node:test";
import assert from "node:assert/strict";
import { passesLongDistanceThreshold } from "../src/index.js";

const candles = close => [
  { high: 100, low: 98, close: 99 },
  { high: 100, low: 98, close: 99.2 },
  { high: 100, low: 98, close }
];

test("LONG passes at exactly 0.5% below the last-three-candle maximum high", () => {
  assert.equal(passesLongDistanceThreshold("LONG", candles(99.5)), true);
});

test("LONG is rejected when distance is below 0.5%", () => {
  assert.equal(passesLongDistanceThreshold("LONG", candles(99.6)), false);
});

test("SHORT behavior is unchanged by the LONG-only threshold", () => {
  assert.equal(passesLongDistanceThreshold("SHORT", candles(100)), true);
});

test("LONG fails closed when three completed candles are unavailable", () => {
  assert.equal(passesLongDistanceThreshold("LONG", candles(99.5).slice(0, 2)), false);
});

import test from "node:test";
import assert from "node:assert/strict";
import {
  ema,
  calculateRsiSeries,
  calculateMacdHistogramSeries,
  calculateAwesomeOscillator,
  findConfirmedPivots,
  findPullbackEntry,
  analyzeFibonacciSetup
} from "../src/fibonacci-engine.js";

function candle(time, open, high, low, close) {
  return { time, open, high, low, close, volume: 1 };
}

test("EMA returns null when history is too short and calculates a seeded EMA", () => {
  assert.equal(ema([1, 2], 3), null);
  assert.equal(ema([1, 2, 3], 3), 2);
});

test("RSI is 100 for a strictly rising close series", () => {
  const values = calculateRsiSeries(Array.from({ length: 25 }, (_, i) => 100 + i));
  assert.equal(values.at(-1), 100);
});

test("MACD histogram returns a finite value after warm-up", () => {
  const closes = Array.from({ length: 80 }, (_, i) => 100 + i * 0.7 + Math.sin(i / 3));
  const histogram = calculateMacdHistogramSeries(closes);
  assert.ok(Number.isFinite(histogram.at(-1)));
});

test("Awesome Oscillator is zero for a flat market", () => {
  const candles = Array.from({ length: 40 }, (_, i) => candle(i, 100, 101, 99, 100));
  const ao = calculateAwesomeOscillator(candles);
  assert.equal(ao.at(-1), 0);
});

test("confirmed pivot detection excludes unconfirmed right-edge candles", () => {
  const candles = [
    candle(0, 10, 11, 9, 10),
    candle(1, 10, 10.5, 8, 9),
    candle(2, 9, 9.5, 7, 8),
    candle(3, 8, 9, 6, 7),
    candle(4, 7, 8, 7, 7.5),
    candle(5, 7.5, 9, 7.2, 8),
    candle(6, 8, 10, 7.5, 9),
    candle(7, 9, 11, 8, 10)
  ];
  const pivots = findConfirmedPivots(candles, "low", 2, 2);
  assert.deepEqual(pivots.map(p => p.index), [3]);
});

test("LONG entry requires touch, bullish reaction, then a later bullish pullback", () => {
  const candles = Array.from({ length: 30 }, (_, i) => candle(i, 101, 102, 100.5, 101));
  candles[26] = candle(26, 101, 101.5, 99.9, 100.05); // first touch
  candles[27] = candle(27, 100.2, 101.6, 100.1, 101.4); // reaction
  candles[28] = candle(28, 101.2, 101.4, 100.8, 101.0); // no pullback to level
  candles[29] = candle(29, 100.1, 100.8, 99.95, 100.5); // pullback + confirmation
  const result = findPullbackEntry(candles, "BULLISH", 100);
  assert.equal(result.confirmed, true);
  assert.equal(result.entry, 100.5);
  assert.equal(result.touchIndex, 26);
  assert.equal(result.reactionIndex, 27);
});

test("SHORT entry requires touch, bearish reaction, then a later bearish pullback", () => {
  const candles = Array.from({ length: 30 }, (_, i) => candle(i, 99, 99.5, 98, 99));
  candles[26] = candle(26, 99, 100.1, 98.8, 99.95); // first touch from below
  candles[27] = candle(27, 99.8, 99.9, 98.4, 98.5); // reaction
  candles[28] = candle(28, 98.7, 99.2, 98.6, 99.0); // no pullback to level
  candles[29] = candle(29, 99.8, 100.05, 99.2, 99.5); // pullback + confirmation
  const result = findPullbackEntry(candles, "BEARISH", 100);
  assert.equal(result.confirmed, true);
  assert.equal(result.entry, 99.5);
  assert.equal(result.touchIndex, 26);
  assert.equal(result.reactionIndex, 27);
});

test("full analyzer safely rejects insufficient candle history", () => {
  const result = analyzeFibonacciSetup({ fourHour: [], oneHour: [], fifteenMin: [] });
  assert.equal(result.status, "INVALID_DATA");
  assert.equal(result.signal, null);
});

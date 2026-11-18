import test from "node:test";
import assert from "node:assert/strict";
import {
  entryDriftPercent, passesEntryFreshness, passesVolumeThreshold,
  isLateEntry, hasPullbackOrBreakout
} from "../src/futures-entry-experiments.js";

test("entry freshness measures absolute deviation and rejects stale quotes", () => {
  assert.equal(entryDriftPercent(64600, 64970), 370 / 64600 * 100);
  assert.equal(passesEntryFreshness(64600, 64970, 0.20), false);
  assert.equal(passesEntryFreshness(64600, 64650, 0.20), true);
  assert.equal(passesEntryFreshness(0, 100, 0.20), false);
});

test("volume thresholds distinguish baseline, 1.2x and 1.5x", () => {
  assert.equal(passesVolumeThreshold(0.9, 0.75), true);
  assert.equal(passesVolumeThreshold(1.19, 1.2), false);
  assert.equal(passesVolumeThreshold(1.5, 1.5), true);
});

test("late-entry guard is directional and uses ATR distance", () => {
  assert.equal(isLateEntry({ side: "LONG", entry: 103, ema20: 100, atr: 2, maxExtensionAtr: 1.5 }), false);
  assert.equal(isLateEntry({ side: "LONG", entry: 104, ema20: 100, atr: 2, maxExtensionAtr: 1.5 }), true);
  assert.equal(isLateEntry({ side: "SHORT", entry: 96, ema20: 100, atr: 2, maxExtensionAtr: 1.5 }), true);
});

test("pullback/retest confirmation recognizes a bullish EMA retest", () => {
  const candles = Array.from({ length: 21 }, (_, i) => ({
    open: 101, high: 102, low: 100.5, close: 101.5, volume: 100
  }));
  candles[20] = { open: 100.8, high: 102, low: 100.2, close: 101.7, volume: 120 };
  assert.equal(hasPullbackOrBreakout({ side: "LONG", candles, ema20: 101, atr: 2, lookback: 20 }), true);
});

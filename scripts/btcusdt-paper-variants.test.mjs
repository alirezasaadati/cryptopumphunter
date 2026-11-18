import test from "node:test";
import assert from "node:assert/strict";
import { analyzeFuturesSymbol } from "../src/index.js";
import { passesVolumeThreshold, isLateEntry } from "../src/futures-entry-experiments.js";
import { passesAtrCap } from "../src/futures-filter-experiments.js";

test("existing multi-timeframe analyzer is exposed for isolated research", () => {
  assert.equal(typeof analyzeFuturesSymbol, "function");
});

test("paper variant volume gates preserve the intended thresholds", () => {
  assert.equal(passesVolumeThreshold(1.19, 1.2), false);
  assert.equal(passesVolumeThreshold(1.2, 1.2), true);
});

test("avoid-late-entry rejects extended entries but accepts non-extended ones", () => {
  assert.equal(isLateEntry({side:"LONG",entry:103,ema20:100,atr:2}), false);
  assert.equal(isLateEntry({side:"LONG",entry:104,ema20:100,atr:2}), true);
});

test("ATR cap is calculated as a percentage of entry price", () => {
  assert.equal(passesAtrCap(50,1000,5), true);
  assert.equal(passesAtrCap(51,1000,5), false);
});

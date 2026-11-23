import test from "node:test";
import assert from "node:assert/strict";
import { simulateChannelExit } from "../src/channel-structure-exits.js";

const bar = (time, open, high, low, close) => ({ time, open, high, low, close });
const entry = 100, stop = 98;

test("breakout takes half at 1.5R and trails the remainder", () => {
  const bars = [
    bar(0, 100, 103.2, 99.5, 103),
    bar(300000, 103, 104, 102.2, 103.5),
    bar(600000, 103.5, 103.6, 101.8, 102.8)
  ];
  const result = simulateChannelExit({ side:"LONG", setup:"UPPER_CHANNEL_BREAKOUT", entry, stop, target:105, bars, startIndex:0 });
  assert.equal(result.partialTaken, true);
  assert.equal(result.trailingActivated, true);
  assert.equal(result.exitReason, "PARTIAL_TP1+TRAILING_STOP");
  assert.ok(result.netR > 0);
});

test("reversal moves stop to break-even after +1R, effective next candle", () => {
  const bars = [
    bar(0, 100, 102.2, 99.2, 101.5),
    bar(300000, 101.5, 101.6, 99.8, 100.2)
  ];
  const result = simulateChannelExit({ side:"LONG", setup:"CHANNEL_FLOOR_REVERSAL", entry, stop, target:103, bars, startIndex:0 });
  assert.equal(result.breakEvenActivated, true);
  assert.equal(result.exitReason, "BREAK_EVEN");
  assert.ok(result.netR < 0.1 && result.netR > -0.1);
});

test("stop wins when stop and reversal target are both touched in one candle", () => {
  const bars = [bar(0, 100, 104, 97, 101)];
  const result = simulateChannelExit({ side:"LONG", setup:"CHANNEL_FLOOR_REVERSAL", entry, stop, target:103, bars, startIndex:0 });
  assert.equal(result.exitReason, "STOP");
});

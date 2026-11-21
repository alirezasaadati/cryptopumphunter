import test from "node:test";
import assert from "node:assert/strict";
import { resolveLongTrade } from "./backtest-breakout-retest-long.mjs";

test("counts a +30% margin ROI target hit before stop as a win", () => {
  const candles = [
    { time: 0, open: 100, high: 104, low: 99, close: 103 }
  ];
  const result = resolveLongTrade({ candles, entryIndex: 0, stopPrice: 98 });
  assert.equal(result.status, "PROFIT_30");
  assert.equal(result.marginRoiPct, 30);
});
test("counts a same-candle stop and target touch as stop-first", () => {
  const candles = [
    { time: 0, open: 100, high: 104, low: 97, close: 102 }
  ];
  const result = resolveLongTrade({ candles, entryIndex: 0, stopPrice: 98 });
  assert.equal(result.status, "STOP");
  assert.equal(result.ambiguousCandles, 1);
});
test("uses an opening gap below stop as the stop exit price", () => {
  const candles = [
    { time: 0, open: 97, high: 99, low: 96, close: 98 }
  ];
  const result = resolveLongTrade({ candles, entryIndex: 0, stopPrice: 98 });
  assert.equal(result.status, "STOP");
  assert.equal(result.exitPrice, 97);
});

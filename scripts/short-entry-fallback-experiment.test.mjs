import test from "node:test";
import assert from "node:assert/strict";
import { selectShortFallbackOrder, resolveShortFallbackFill } from "../src/short-entry-fallback-experiment.js";

const bar = (open, high, low, close) => ({ open, high, low, close });

test("bearish 5m candle selects market fallback at the next 5m open", () => {
  const decision = bar(100, 101, 98, 99);
  assert.deepEqual(selectShortFallbackOrder(decision), {
    type: "MARKET", reason: "BEARISH_5M", limitPrice: null
  });
  const result = resolveShortFallbackFill({
    decisionCandle: decision,
    followingCandles: [bar(98.5, 99, 97, 97.5)],
    marketSlippage: 0.001
  });
  assert.equal(result.filled, true);
  assert.equal(result.fillPrice, 98.5 * 0.999);
  assert.equal(result.reason, "MARKET_NEXT_5M_OPEN");
});

test("bullish 5m candle selects a sell limit at its observed high", () => {
  const decision = bar(100, 103, 99, 102);
  const result = resolveShortFallbackFill({
    decisionCandle: decision,
    followingCandles: [bar(101, 102, 100, 101), bar(101, 103, 100, 102)]
  });
  assert.equal(result.type, "LIMIT");
  assert.equal(result.limitPrice, 103);
  assert.equal(result.filled, true);
  assert.equal(result.fillPrice, 103);
  assert.equal(result.fillIndex, 1);
  assert.equal(result.reason, "LIMIT_TOUCH_FILL");
});

test("Doji is handled like bullish candle and places a limit at the observed high", () => {
  const decision = bar(100, 101.5, 99, 100);
  const result = resolveShortFallbackFill({
    decisionCandle: decision,
    followingCandles: [bar(100, 101, 99, 100), bar(100, 101.5, 99, 100)]
  });
  assert.equal(result.type, "LIMIT");
  assert.equal(result.decisionReason, "DOJI_5M");
  assert.equal(result.reason, "LIMIT_TOUCH_FILL");
  assert.equal(result.limitPrice, 101.5);
  assert.equal(result.filled, true);
  assert.equal(result.fillPrice, 101.5);
});

test("unfilled bullish or Doji limit expires without suppressing the originating signal", () => {
  const result = resolveShortFallbackFill({
    decisionCandle: bar(100, 102, 99, 101),
    followingCandles: Array.from({ length: 12 }, () => bar(100, 101, 99, 100))
  });
  assert.equal(result.type, "LIMIT");
  assert.equal(result.filled, false);
  assert.equal(result.reason, "BULLISH_5M_LIMIT_EXPIRED");
});

test("invalid 5m OHLC data is rejected by the research helper", () => {
  assert.throws(() => selectShortFallbackOrder(bar(100, 99, 98, 101)), /Invalid completed 5m candle/);
});

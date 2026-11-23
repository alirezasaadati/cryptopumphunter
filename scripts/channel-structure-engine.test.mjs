import test from "node:test";
import assert from "node:assert/strict";
import { calculateAtr, detectPriceChannel, generateChannelSignal, scoreChannelSignal } from "../src/channel-structure-engine.js";

function syntheticChannel({ slope = 0, count = 100, width = 20 } = {}) {
  const candles = [];
  for (let i = 0; i < count; i++) {
    const mid = 100 + slope * i;
    const phase = i % 20;
    const wave = Math.sin(phase / 20 * Math.PI * 2) * (width / 2 - 1);
    const close = mid + wave;
    candles.push({ time: i * 14400000, open: close - 0.2, high: close + 1, low: close - 1, close, volume: 1000 });
  }
  return candles;
}

test("ATR returns a positive value for valid candles", () => {
  const candles = syntheticChannel();
  assert.ok(calculateAtr(candles) > 0);
});

test("channel detector returns a structured horizontal channel when pivots confirm", () => {
  const result = detectPriceChannel(syntheticChannel());
  assert.ok(result);
  assert.equal(result.type, "HORIZONTAL");
  assert.ok(result.upper > result.lower);
  assert.ok(result.upperTouches >= 2 && result.lowerTouches >= 2);
});

test("channel detector rejects insufficient history", () => {
  assert.equal(detectPriceChannel(syntheticChannel().slice(0, 20)), null);
});

test("signal score is bounded and null-safe", () => {
  assert.equal(scoreChannelSignal(null), 0);
  const channel = { upperTouches: 3, lowerTouches: 3, width: 20, lower: 90, upper: 110, widthAtr: 4 };
  const score = scoreChannelSignal({ channel, referenceEntry: 91, setup: "CHANNEL_FLOOR_REVERSAL", targetR: 1.5 });
  assert.ok(score >= 0 && score <= 100);
});

test("signal generator does not emit without confirmed channel", () => {
  const candles = syntheticChannel().slice(0, 20);
  assert.equal(generateChannelSignal({ candles4h: candles, candles1h: candles, candles15m: candles }), null);
});

import test from "node:test";
import assert from "node:assert/strict";
import { classifyMarketRegime, combineMarketRegimes, isSideAllowedByRegime } from "./futures-market-regime.mjs";

function trendCandles(direction = 1, count = 100) {
  return Array.from({ length: count }, (_, i) => {
    const close = 100 + direction * i * 1.1;
    return { time: i * 3600000, open: close - direction * 0.25, high: close + 0.5, low: close - 0.5, close, volume: 100 };
  });
}
function flatCandles(count = 100) {
  return Array.from({ length: count }, (_, i) => ({ time: i * 3600000, open: 100, high: 100.2, low: 99.8, close: 100, volume: 100 }));
}

test("classifier labels sustained bullish and bearish trends using closed candles", () => {
  assert.equal(classifyMarketRegime(trendCandles(1)).direction, "BULL");
  assert.equal(classifyMarketRegime(trendCandles(-1)).direction, "BEAR");
});
test("classifier abstains on flat, conflicting, or insufficient histories", () => {
  assert.equal(classifyMarketRegime(flatCandles()).regime, "NEUTRAL");
  assert.equal(classifyMarketRegime([]).regime, "INSUFFICIENT");
});
test("combined timeframe regime requires directional agreement", () => {
  const bull = classifyMarketRegime(trendCandles(1));
  const bear = classifyMarketRegime(trendCandles(-1));
  assert.equal(combineMarketRegimes(bull, bear).direction, "NEUTRAL");
  assert.equal(combineMarketRegimes(bull, bull).direction, "BULL");
});
test("BTC direction gate never permits counter-trend or neutral signals", () => {
  const bull = classifyMarketRegime(trendCandles(1));
  const bear = classifyMarketRegime(trendCandles(-1));
  const neutral = classifyMarketRegime(flatCandles());
  assert.equal(isSideAllowedByRegime("LONG", bull), true);
  assert.equal(isSideAllowedByRegime("SHORT", bull), false);
  assert.equal(isSideAllowedByRegime("SHORT", bear), true);
  assert.equal(isSideAllowedByRegime("LONG", bear), false);
  assert.equal(isSideAllowedByRegime("LONG", neutral), false);
  assert.equal(isSideAllowedByRegime("SHORT", neutral), false);
});

import test from "node:test";
import assert from "node:assert/strict";
import { analyzeMarketStructure } from "../src/engines/market-structure.js";

const candle = (i, high, low, close = (high + low) / 2) =>
  ({ time:i*900000, open:close, high, low, close, volume:100 });

test("confirmed pivots are withheld until right-side candles have closed", () => {
  const bars = [candle(0,9,7),candle(1,10,8),candle(2,15,9),candle(3,11,8),candle(4,10,7)];
  const early = analyzeMarketStructure(bars.slice(0,4), {leftBars:2,rightBars:2});
  const confirmed = analyzeMarketStructure(bars, {leftBars:2,rightBars:2});
  assert.equal(early.confirmedHighs.some(p=>p.index===2), false);
  assert.equal(confirmed.confirmedHighs.some(p=>p.index===2), true);
});

test("BOS and CHoCH use only the last confirmed swing levels", () => {
  const bars = [];
  for(let i=0;i<30;i++) bars.push(candle(i, 100+(i%5), 90+(i%5), 95+(i%5)));
  bars.push(candle(30,96,80,82));
  const result = analyzeMarketStructure(bars, {leftBars:2,rightBars:2,atr:2});
  assert.equal(result.bosDown, true);
});

test("invalid/insufficient history returns null", () => {
  assert.equal(analyzeMarketStructure([]), null);
});

import test from "node:test";
import assert from "node:assert/strict";
import { evaluateTradeCandle } from "../src/futures-trade-lifecycle.js";

const longTrade = {
  id:"L1", symbol:"BTC", side:"LONG", actualEntry:100,
  currentStop:95, target1:107.5, target2:111, target3:115,
  status:"OPEN", tpHits:[]
};
const shortTrade = {
  id:"S1", symbol:"BTC", side:"SHORT", actualEntry:100,
  currentStop:105, target1:92.5, target2:89, target3:85,
  status:"OPEN", tpHits:[]
};

test("LONG remains open before signal TP1 and closes at TP1", () => {
  assert.equal(evaluateTradeCandle(longTrade, {open:100, high:107.4, low:99, time:1}).changed, false);
  const result = evaluateTradeCandle(longTrade, {open:107, high:108, low:106, time:2});
  assert.equal(result.reason, "CLOSED_PROFIT");
  assert.equal(result.trade.exitPrice, 107.5);
  assert.deepEqual(result.trade.tpHits, ["TP1"]);
  assert.equal(result.trade.marginReturnPercent, null);
  assert.equal(result.trade.lockReleaseEligible, true);
});

test("SHORT closes at its signal TP1", () => {
  const result = evaluateTradeCandle(shortTrade, {open:93, high:94, low:91.8, time:3});
  assert.equal(result.reason, "CLOSED_PROFIT");
  assert.equal(result.trade.exitPrice, 92.5);
  assert.equal(result.trade.marginReturnPercent, null);
});

test("stop closes the signal when stop is reached before TP1", () => {
  const result = evaluateTradeCandle(longTrade, {open:97, high:99, low:94, time:4});
  assert.equal(result.reason, "CLOSED_STOP");
  assert.equal(result.trade.exitPrice, 95);
  assert.equal(result.trade.marginReturnPercent, null);
});

test("ambiguous candle touching both stop and TP1 is resolved as stop", () => {
  const result = evaluateTradeCandle(longTrade, {open:100, high:108, low:94, time:5});
  assert.equal(result.reason, "CLOSED_STOP");
  assert.equal(result.trade.exitPrice, 95);
});

test("a candle opening beyond TP1 closes at the known opening price", () => {
  const result = evaluateTradeCandle(longTrade, {open:108, high:109, low:94, time:6});
  assert.equal(result.reason, "CLOSED_PROFIT");
  assert.equal(result.trade.exitPrice, 108);
});

test("TP2 and TP3 do not change the signal's TP1 closure rule", () => {
  const result = evaluateTradeCandle(longTrade, {open:100, high:116, low:99, time:7});
  assert.equal(result.reason, "CLOSED_PROFIT");
  assert.equal(result.trade.exitPrice, 107.5);
});

test("closed trades and candles touching neither boundary are unchanged", () => {
  const closed = {...longTrade, status:"CLOSED_PROFIT"};
  assert.equal(evaluateTradeCandle(closed, {open:100, high:120, low:90}).changed, false);
  assert.equal(evaluateTradeCandle(longTrade, {open:100, high:104, low:96}).changed, false);
});

test("invalid inputs do not create a close event", () => {
  assert.equal(evaluateTradeCandle(longTrade, {open:100, high:99, low:101}).changed, false);
  assert.equal(evaluateTradeCandle(longTrade, {open:100, high:108, low:94, time:8}).reason, "CLOSED_STOP");
});

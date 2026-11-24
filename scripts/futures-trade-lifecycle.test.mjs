import test from "node:test";
import assert from "node:assert/strict";
import {
  FUTURES_TRADE_LEVERAGE,
  FUTURES_MARGIN_PROFIT_TARGET_PERCENT,
  FUTURES_PRICE_MOVE_TARGET_PERCENT,
  marginReturnPercent,
  profitTargetPrice,
  evaluateTradeCandle
} from "../src/futures-trade-lifecycle.js";

const longTrade = { id:"L1", symbol:"BTC", side:"LONG", actualEntry:100, currentStop:95, status:"OPEN", tpHits:["TP1"] };
const shortTrade = { id:"S1", symbol:"BTC", side:"SHORT", actualEntry:100, currentStop:105, status:"OPEN", tpHits:["TP1","TP2"] };

test("10x leverage converts 3% favorable price movement into 30% margin return", () => {
  assert.equal(FUTURES_TRADE_LEVERAGE, 10);
  assert.equal(FUTURES_MARGIN_PROFIT_TARGET_PERCENT, 30);
  assert.equal(FUTURES_PRICE_MOVE_TARGET_PERCENT, 3);
  assert.equal(profitTargetPrice("LONG", 100), 103);
  assert.equal(profitTargetPrice("SHORT", 100), 97);
  assert.equal(marginReturnPercent("LONG", 100, 103), 30);
  assert.equal(marginReturnPercent("SHORT", 100, 97), 30);
});

test("LONG closes only when 30% margin target or stop is reached", () => {
  assert.equal(evaluateTradeCandle(longTrade, {open:100, high:102.9, low:99, time:1}).changed, false);
  const result = evaluateTradeCandle(longTrade, {open:102, high:103.2, low:101, time:2});
  assert.equal(result.reason, "CLOSED_PROFIT");
  assert.equal(result.trade.exitPrice, 103);
  assert.equal(result.trade.marginReturnPercent, 30);
  assert.equal(result.trade.lockReleaseEligible, true);
});

test("SHORT closes only when 30% margin target or stop is reached", () => {
  const result = evaluateTradeCandle(shortTrade, {open:98, high:99, low:96.8, time:3});
  assert.equal(result.reason, "CLOSED_PROFIT");
  assert.equal(result.trade.exitPrice, 97);
  assert.equal(result.trade.marginReturnPercent, 30);
});

test("stop closes the trade even if TP milestones were previously reached", () => {
  const result = evaluateTradeCandle(longTrade, {open:97, high:99, low:94, time:4});
  assert.equal(result.reason, "CLOSED_STOP");
  assert.equal(result.trade.exitPrice, 95);
  assert.equal(result.trade.marginReturnPercent, -50);
});

test("ambiguous candle touching both stop and profit is resolved as stop", () => {
  const result = evaluateTradeCandle(longTrade, {open:100, high:104, low:94, time:5});
  assert.equal(result.reason, "CLOSED_STOP");
  assert.equal(result.trade.exitPrice, 95);
});

test("a candle opening beyond profit closes at the known opening price even if it later reaches stop", () => {
  const result = evaluateTradeCandle(longTrade, {open:104, high:105, low:94, time:6});
  assert.equal(result.reason, "CLOSED_PROFIT");
  assert.equal(result.trade.exitPrice, 104);
  assert.ok(Math.abs(result.trade.marginReturnPercent - 40) < 1e-9);
});

test("closed trades and candles that touch neither boundary are unchanged", () => {
  const closed = {...longTrade, status:"CLOSED_PROFIT"};
  assert.equal(evaluateTradeCandle(closed, {open:100, high:110, low:90}).changed, false);
  assert.equal(evaluateTradeCandle(longTrade, {open:100, high:102, low:96}).changed, false);
});

test("invalid inputs do not create a close event", () => {
  assert.equal(evaluateTradeCandle(longTrade, {open:100, high:99, low:101}).changed, false);
  assert.equal(profitTargetPrice("BUY", 100), null);
});


test("LONG moves stop to fee-buffered break-even after +1R and persists the protected level", () => {
  const trade = { id:"L-BE", side:"LONG", actualEntry:100, initialStop:99, currentStop:99, status:"OPEN" };
  const moved = evaluateTradeCandle(trade, {open:100, high:101.2, low:100.2, time:10});
  assert.equal(moved.changed, false);
  assert.equal(moved.stopMoved, true);
  assert.equal(moved.trade.currentStop, 100.12);
  assert.equal(moved.trade.breakEvenActivated, true);
  const stopped = evaluateTradeCandle(moved.trade, {open:100.5, high:100.6, low:100.1, time:11});
  assert.equal(stopped.reason, "CLOSED_STOP");
  assert.equal(stopped.trade.exitPrice, 100.12);
  assert.ok(stopped.trade.marginReturnPercent > 0);
});

test("SHORT moves stop to fee-buffered break-even after +1R", () => {
  const trade = { id:"S-BE", side:"SHORT", actualEntry:100, initialStop:101, currentStop:101, status:"OPEN" };
  const moved = evaluateTradeCandle(trade, {open:100, high:99.8, low:98.8, time:12});
  assert.equal(moved.changed, false);
  assert.equal(moved.stopMoved, true);
  assert.equal(moved.trade.currentStop, 99.88);
  assert.equal(moved.trade.breakEvenActivated, true);
  const stopped = evaluateTradeCandle(moved.trade, {open:99.5, high:99.9, low:99.4, time:13});
  assert.equal(stopped.reason, "CLOSED_STOP");
  assert.equal(stopped.trade.exitPrice, 99.88);
  assert.ok(stopped.trade.marginReturnPercent > 0);
});

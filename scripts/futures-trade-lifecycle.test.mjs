import test from "node:test";
import assert from "node:assert/strict";
import {
  FUTURES_TRADE_LEVERAGE,
  FUTURES_MARGIN_PROFIT_TARGET_PERCENT,
  FUTURES_PRICE_MOVE_TARGET_PERCENT,
  marginReturnPercent,
  profitTargetPrice,
  evaluateStagedTradeCandle
} from "../src/futures-trade-lifecycle.js";

const longTrade = {
  id: "L1", symbol: "BTC", side: "LONG", actualEntry: 100,
  initialStop: 95, currentStop: 95, status: "OPEN",
  tpHits: [], remainingFraction: 1, realizedMarginReturnPct: 0
};
const shortTrade = {
  id: "S1", symbol: "BTC", side: "SHORT", actualEntry: 100,
  initialStop: 105, currentStop: 105, status: "OPEN",
  tpHits: [], remainingFraction: 1, realizedMarginReturnPct: 0
};

test("10x leverage converts 3% favorable price movement into 30% margin return", () => {
  assert.equal(FUTURES_TRADE_LEVERAGE, 10);
  assert.equal(FUTURES_MARGIN_PROFIT_TARGET_PERCENT, 30);
  assert.equal(FUTURES_PRICE_MOVE_TARGET_PERCENT, 3);
  assert.equal(profitTargetPrice("LONG", 100), 103);
  assert.equal(profitTargetPrice("SHORT", 100), 97);
  assert.equal(marginReturnPercent("LONG", 100, 103), 30);
  assert.equal(marginReturnPercent("SHORT", 100, 97), 30);
});

test("active staged lifecycle does not move the internal stop at 1R without owner confirmation", () => {
  const result = evaluateStagedTradeCandle(longTrade, {open: 100, high: 106, low: 101, close: 105, time: 1});
  assert.equal(result.closed, false);
  assert.equal(result.trade.currentStop, 95);
  assert.equal(result.trade.breakEvenActivated, undefined);
  const next = evaluateStagedTradeCandle(result.trade, {open: 102, high: 104, low: 99.5, close: 103, time: 2});
  assert.equal(next.closed, false);
  assert.equal(next.trade.status, "OPEN");
  assert.equal(next.trade.currentStop, 95);
});

test("an owner-confirmed exchange stop is used by the active lifecycle", () => {
  const confirmedTrade = {...longTrade, currentStop: 100.12, breakEvenActivated: true};
  const result = evaluateStagedTradeCandle(confirmedTrade, {open: 100.5, high: 101, low: 100.05, close: 100.4, time: 3});
  assert.equal(result.closed, true);
  assert.equal(result.reason, "CLOSED_STOP");
  assert.equal(result.trade.exitPrice, 100.12);
  assert.equal(result.trade.lockReleaseEligible, true);
});

test("LONG staged exits use 1.5R, 2.5R and 3.5R with one-third partials", () => {
  const first = evaluateStagedTradeCandle(longTrade, {open: 106, high: 108, low: 101, close: 107.5, time: 4});
  assert.equal(first.trade.tpHits.join(","), "TP1");
  assert.equal(first.trade.remainingFraction, 2 / 3);
  assert.equal(first.trade.currentStop, 95);
  assert.ok(Math.abs(first.trade.realizedMarginReturnPct - 25) < 1e-9);

  const second = evaluateStagedTradeCandle(first.trade, {open: 110, high: 113, low: 109, close: 112.5, time: 5});
  assert.equal(second.trade.tpHits.join(","), "TP1,TP2");
  assert.ok(Math.abs(second.trade.remainingFraction - 1 / 3) < 1e-9);
  assert.ok(Math.abs(second.trade.realizedMarginReturnPct - 66.6666666667) < 1e-8);

  const third = evaluateStagedTradeCandle(second.trade, {open: 115, high: 118, low: 114, close: 117.5, time: 6});
  assert.equal(third.closed, true);
  assert.equal(third.reason, "CLOSED_PROFIT");
  assert.equal(third.trade.remainingFraction, 0);
  assert.equal(third.trade.tpHits.join(","), "TP1,TP2,TP3");
  assert.ok(Math.abs(third.trade.realizedMarginReturnPct - 125) < 1e-9);
  assert.equal(third.trade.lockReleaseEligible, true);
});

test("SHORT staged targets mirror LONG targets", () => {
  const first = evaluateStagedTradeCandle(shortTrade, {open: 94, high: 99, low: 92, close: 92.5, time: 7});
  assert.equal(first.trade.tpHits.join(","), "TP1");
  assert.ok(Math.abs(first.trade.remainingFraction - 2 / 3) < 1e-9);
  assert.ok(Math.abs(first.trade.realizedMarginReturnPct - 25) < 1e-9);
});

test("active stop is evaluated conservatively before profit when both are touched", () => {
  const result = evaluateStagedTradeCandle(longTrade, {open: 100, high: 108, low: 94, close: 103, time: 8});
  assert.equal(result.closed, true);
  assert.equal(result.reason, "CLOSED_STOP");
  assert.equal(result.trade.exitPrice, 95);
  assert.equal(result.trade.remainingFraction, 0);
  assert.equal(result.trade.tpHits.length, 0);
});

test("a gap through the active stop exits at the candle open", () => {
  const result = evaluateStagedTradeCandle(longTrade, {open: 93, high: 96, low: 92, close: 94, time: 9});
  assert.equal(result.reason, "CLOSED_STOP");
  assert.equal(result.trade.exitPrice, 93);
});

test("closed trades and candles that touch no active level remain unchanged", () => {
  const closed = {...longTrade, status: "CLOSED_PROFIT"};
  assert.equal(evaluateStagedTradeCandle(closed, {open: 100, high: 120, low: 90, close: 110}).changed, false);
  const unchanged = evaluateStagedTradeCandle(longTrade, {open: 100, high: 104, low: 96, close: 102});
  assert.equal(unchanged.changed, false);
  assert.equal(unchanged.trade.status, "OPEN");
});

test("invalid candles and invalid trade levels do not create close events", () => {
  assert.equal(evaluateStagedTradeCandle(longTrade, {open: 100, high: 99, low: 101, close: 100}).changed, false);
  const invalid = evaluateStagedTradeCandle({...longTrade, initialStop: 100, currentStop: 100}, {open: 100, high: 101, low: 99, close: 100});
  assert.equal(invalid.error, "INVALID_TRADE_LEVELS");
});

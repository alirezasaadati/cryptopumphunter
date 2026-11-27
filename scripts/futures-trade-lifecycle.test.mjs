import test from "node:test";
import assert from "node:assert/strict";
import { evaluateStagedTradeCandle, validateConfirmedStopPrice } from "../src/futures-trade-lifecycle.js";

const longTrade = {
  id: "L1", symbol: "BTC", side: "LONG", actualEntry: 100,
  initialStop: 95, currentStop: 95, status: "OPEN",
  remainingFraction: 1, tpHits: []
};
const shortTrade = {
  id: "S1", symbol: "BTC", side: "SHORT", actualEntry: 100,
  initialStop: 105, currentStop: 105, status: "OPEN",
  remainingFraction: 1, tpHits: []
};

test("active LONG lifecycle takes one third at 1.5R and only suggests break-even", () => {
  const result = evaluateStagedTradeCandle(longTrade, { open: 100, high: 108, low: 99, close: 106, time: 1 });
  assert.equal(result.changed, true);
  assert.equal(result.closed, false);
  assert.deepEqual(result.trade.tpHits, ["TP1"]);
  assert.ok(Math.abs(result.trade.remainingFraction - 2 / 3) < 1e-9);
  assert.equal(result.trade.currentStop, 95);
  assert.equal(result.trade.breakEvenActivated, false);
  assert.equal(result.trade.breakEvenSuggested, true);
  assert.ok(Math.abs(result.trade.suggestedStopPrice - 100.12) < 1e-9);
  assert.ok(Math.abs(result.trade.realizedMarginReturnPct - 25) < 1e-9);
});

test("active SHORT lifecycle suggests a fee-buffered stop without moving the tracked stop", () => {
  const result = evaluateStagedTradeCandle(shortTrade, { open: 100, high: 101, low: 92, close: 93, time: 2 });
  assert.equal(result.trade.currentStop, 105);
  assert.equal(result.trade.breakEvenActivated, false);
  assert.equal(result.trade.breakEvenSuggested, true);
  assert.ok(Math.abs(result.trade.suggestedStopPrice - 99.88) < 1e-9);
  assert.deepEqual(result.trade.tpHits, ["TP1"]);
  assert.ok(Math.abs(result.trade.remainingFraction - 2 / 3) < 1e-9);
});

test("staged exits use 1.5R, 2.5R and 3.5R with one-third portions", () => {
  const first = evaluateStagedTradeCandle(longTrade, { open: 100, high: 108, low: 99, close: 106, time: 3 }).trade;
  const second = evaluateStagedTradeCandle(first, { open: 108, high: 113, low: 107, close: 112, time: 4 }).trade;
  assert.deepEqual(second.tpHits, ["TP1", "TP2"]);
  assert.ok(Math.abs(second.remainingFraction - 1 / 3) < 1e-9);
  const third = evaluateStagedTradeCandle(second, { open: 113, high: 118, low: 112, close: 117, time: 5 });
  assert.equal(third.closed, true);
  assert.equal(third.reason, "CLOSED_PROFIT");
  assert.deepEqual(third.trade.tpHits, ["TP1", "TP2", "TP3"]);
  assert.equal(third.trade.remainingFraction, 0);
  assert.equal(third.trade.lockReleaseEligible, true);
});

test("the active stop is evaluated conservatively before targets", () => {
  const result = evaluateStagedTradeCandle(longTrade, { open: 100, high: 120, low: 94, close: 110, time: 6 });
  assert.equal(result.closed, true);
  assert.equal(result.reason, "CLOSED_STOP");
  assert.equal(result.trade.exitPrice, 95);
  assert.equal(result.trade.currentStop, 95);
});

test("a manually confirmed stop is the stop used by the active lifecycle", () => {
  const confirmed = { ...longTrade, currentStop: 100.12, breakEvenActivated: true };
  const result = evaluateStagedTradeCandle(confirmed, { open: 101, high: 102, low: 100, close: 101, time: 7 });
  assert.equal(result.closed, true);
  assert.equal(result.reason, "CLOSED_STOP");
  assert.equal(result.trade.exitPrice, 100.12);
});

test("invalid levels and closed trades are not processed", () => {
  const invalid = { ...longTrade, initialStop: 0 };
  assert.equal(evaluateStagedTradeCandle(invalid, { open: 100, high: 101, low: 99, close: 100 }).error, "INVALID_TRADE_LEVELS");
  assert.equal(evaluateStagedTradeCandle({ ...longTrade, status: "CLOSED_STOP" }, { open: 100, high: 101, low: 99, close: 100 }).changed, false);
});

test("confirmed stop synchronization validates LONG and SHORT against latest tracked price", () => {
  const long = { ...longTrade, lastPrice: 103 };
  const short = { ...shortTrade, lastPrice: 97 };
  assert.deepEqual(validateConfirmedStopPrice(long, 100.12), {
    ok: true, stopPrice: 100.12, breakEvenActivated: true
  });
  assert.equal(validateConfirmedStopPrice(long, 103).ok, false);
  assert.deepEqual(validateConfirmedStopPrice(short, 99.88), {
    ok: true, stopPrice: 99.88, breakEvenActivated: true
  });
  assert.equal(validateConfirmedStopPrice(short, 97).ok, false);
  assert.equal(validateConfirmedStopPrice({ ...long, status: "CLOSED_STOP" }, 100).ok, false);
});

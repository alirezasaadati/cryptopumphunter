import test from "node:test";
import assert from "node:assert/strict";
import { evaluateStagedTradeCandle } from "../src/futures-trade-lifecycle.js";

function trade() {
  return {
    id: "staged-test", status: "OPEN", side: "LONG",
    actualEntry: 100, initialStop: 98, currentStop: 98,
    tpHits: [], remainingFraction: 1, realizedMarginReturnPct: 0
  };
}

test("staged lifecycle takes one third at TP1 and TP2, then remainder at TP3", () => {
  let current = trade();
  let result = evaluateStagedTradeCandle(current, { open: 100.5, high: 103.2, low: 100.5, close: 103, time: "2026-01-01T00:05:00Z" });
  assert.equal(result.closed, false);
  current = result.trade;
  assert.deepEqual(current.tpHits, ["TP1"]);
  assert.ok(Math.abs(current.remainingFraction - 2/3) < 1e-9);

  result = evaluateStagedTradeCandle(current, { open: 103.2, high: 105.2, low: 103.1, close: 105, time: "2026-01-01T00:10:00Z" });
  assert.equal(result.closed, false);
  current = result.trade;
  assert.deepEqual(current.tpHits, ["TP1", "TP2"]);
  assert.ok(Math.abs(current.remainingFraction - 1/3) < 1e-9);

  result = evaluateStagedTradeCandle(current, { open: 105.2, high: 107.2, low: 105.1, close: 107, time: "2026-01-01T00:15:00Z" });
  assert.equal(result.closed, true);
  assert.equal(result.trade.status, "CLOSED_PROFIT");
  assert.deepEqual(result.trade.tpHits, ["TP1", "TP2", "TP3"]);
  assert.equal(result.trade.remainingFraction, 0);
  assert.ok(Math.abs(result.trade.marginReturnPercent - 50) < 1e-8);
});

test("at +1R the lifecycle suggests break-even but waits for confirmed exchange stop", () => {
  let current = trade();
  let result = evaluateStagedTradeCandle(current, { open: 100, high: 102.1, low: 100.5, close: 101.8, time: "2026-01-01T00:05:00Z" });
  current = result.trade;
  assert.equal(current.breakEvenActivated, false);
  assert.equal(current.breakEvenSuggested, true);
  assert.equal(current.currentStop, 98);
  assert.ok(Math.abs(current.suggestedStopPrice - 100.12) < 1e-9);

  // Simulate the owner manually changing the exchange stop and confirming it to the bot.
  current = { ...current, currentStop: current.suggestedStopPrice, breakEvenActivated: true };
  result = evaluateStagedTradeCandle(current, { open: 101, high: 101.2, low: 100.1, close: 100.2, time: "2026-01-01T00:10:00Z" });
  assert.equal(result.closed, true);
  assert.equal(result.trade.status, "CLOSED_STOP");
  assert.ok(result.trade.marginReturnPercent > 0);
});

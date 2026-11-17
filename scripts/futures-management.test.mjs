import test from "node:test";
import assert from "node:assert/strict";
import {
  calculateTradeProgress,
  evaluateTradeManagement,
  formatManagementAlert
} from "../src/futures-management.js";

const longTrade = {
  symbol: "BTCUSDT", side: "LONG", actualEntry: 100,
  initialRisk: 10, initialStop: 90, currentStop: 90,
  managementStages: []
};

test("calculates leveraged ROI and R progress for a long", () => {
  const p = calculateTradeProgress(longTrade, 107.5, 10);
  assert.equal(p.favorableR, 0.75);
  assert.equal(p.priceReturnPct, 7.5);
  assert.equal(p.leveragedRoiPct, 75);
});

test("recommends a protective stop at the first reached stage", () => {
  const result = evaluateTradeManagement(longTrade, 107.5);
  assert.equal(result.alert, true);
  assert.equal(result.stageId, "protect_075R");
  assert.equal(result.recommendedStop, 101);
});

test("calculates short stop in the correct direction", () => {
  const trade = {
    symbol: "ZEC", side: "SHORT", actualEntry: 100,
    initialRisk: 10, initialStop: 110, currentStop: 110,
    managementStages: []
  };
  const result = evaluateTradeManagement(trade, 92.5);
  assert.equal(result.stageId, "protect_075R");
  assert.equal(result.recommendedStop, 99);
});

test("never recommends loosening a tighter existing stop", () => {
  const trade = { ...longTrade, currentStop: 102 };
  const result = evaluateTradeManagement(trade, 107.5);
  assert.equal(result.alert, false);
  assert.equal(result.reason, "stop_already_tighter");
});

test("does not repeat an already completed stage", () => {
  const trade = { ...longTrade, managementStages: ["protect_075R"] };
  const result = evaluateTradeManagement(trade, 107.5);
  assert.equal(result.alert, false);
  assert.equal(result.reason, "no_new_stage");
});

test("formats a user-facing manual action alert", () => {
  const result = evaluateTradeManagement(longTrade, 107.5);
  const message = formatManagementAlert(longTrade, result, n => Number(n).toFixed(2));
  assert.match(message, /حد ضرر پیشنهادی جدید: 101.00/);
  assert.match(message, /دستی/);
  assert.match(message, /سفارش/);
});

test("rejects invalid trade data", () => {
  assert.equal(evaluateTradeManagement({ ...longTrade, side: "SIDEWAYS" }, 107.5).valid, false);
});

import test from "node:test";
import assert from "node:assert/strict";
import { simulateManagedTrade, summarizeManagementComparison } from "../src/futures-management-backtest.js";

test("managed backtest locks part of profit after first stage", () => {
  const candles = [
    {time:1,open:100,high:108,low:102,close:106},
    {time:2,open:106,high:107,low:100.5,close:102}
  ];
  const result = simulateManagedTrade({
    side:"LONG",entry:100,stop:90,targets:[115,122,130],
    candles,fee:0,slippage:0,maxHoldHours:10
  });
  assert.equal(result.exitReason,"MANAGEMENT_STOP");
  assert.equal(result.finalStop,101);
  assert.ok(result.netR > 0);
  assert.deepEqual(result.stagesHit,["protect_075R"]);
});

test("existing stop is checked before any stage in the same candle", () => {
  const candles = [{time:1,open:100,high:110,low:89,close:105}];
  const result = simulateManagedTrade({
    side:"LONG",entry:100,stop:90,targets:[115,122,130],
    candles,fee:0,slippage:0
  });
  assert.equal(result.exitReason,"STOP");
  assert.equal(result.netR,-1);
  assert.equal(result.stagesHit.length,0);
});

test("short trade management locks gains in the correct direction", () => {
  const candles = [
    {time:1,open:100,high:98,low:92,close:94},
    {time:2,open:94,high:99.5,low:93,close:98}
  ];
  const result = simulateManagedTrade({
    side:"SHORT",entry:100,stop:110,targets:[85,78,70],
    candles,fee:0,slippage:0
  });
  assert.equal(result.exitReason,"MANAGEMENT_STOP");
  assert.equal(result.finalStop,99);
  assert.ok(result.netR > 0);
});

test("comparison summary reports net expectancy and drawdown", () => {
  const summary = summarizeManagementComparison([{netR:1,targetHits:1,exitReason:"TARGETS"},{netR:-1,targetHits:0,exitReason:"STOP"}]);
  assert.equal(summary.trades,2);
  assert.equal(summary.netR,0);
  assert.equal(summary.expectancyR,0);
  assert.equal(summary.maxDrawdownR,1);
});

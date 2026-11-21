import test from "node:test";
import assert from "node:assert/strict";
import { createChannelPosition, processChannelCandle, EXIT_ALLOCATIONS } from "../src/channel-controller.js";

test("five exit allocations each sum to 100%", () => {
  for (const weights of Object.values(EXIT_ALLOCATIONS)) assert.ok(Math.abs(weights.reduce((a,b)=>a+b,0)-1)<1e-9);
});
test("second entry is added at 2.8% adverse and targets reset from blended entry", () => {
  const p=createChannelPosition({symbol:"PF_XBTUSD",side:"LONG",entry:100,stop:95});
  processChannelCandle(p,{time:1,high:100,low:97.2,close:98});
  assert.equal(p.entry2,97.2);
  assert.equal(p.averageEntry,98.6);
  assert.equal(p.targets[0],99.586);
});
test("TP1 before entry two cancels the pending second entry", () => {
  const p=createChannelPosition({side:"LONG",entry:100,stop:95});
  processChannelCandle(p,{time:1,high:101.1,low:99.8,close:101});
  assert.equal(p.entry2Cancelled,true);
  assert.equal(p.targetHits[0],1);
});
test("stop wins when stop and second-entry trigger are both inside one candle", () => {
  const p=createChannelPosition({side:"LONG",entry:100,stop:97});
  processChannelCandle(p,{time:1,high:100,low:96,close:98});
  assert.equal(p.exitReason,"STOP");
  assert.equal(p.entry2,null);
});

import test from "node:test";
import assert from "node:assert/strict";
import {buildShadowLevels,advanceShadowTrade,summarizeShadowRecords,shadowSetupId} from "../src/entry-shadow.js";

test("creates unique setup identity per closed hourly candle",()=>{
 assert.equal(shadowSetupId("PF_BTCUSD","LONG",123),"PF_BTCUSD|LONG|123");
 assert.notEqual(shadowSetupId("PF_BTCUSD","LONG",123),shadowSetupId("PF_BTCUSD","LONG",124));
});
test("builds one-entry risk levels and rejects invalid risk",()=>{
 const candles=Array.from({length:8},(_,i)=>({low:99-i*.01,high:101+i*.01}));
 const levels=buildShadowLevels({side:"LONG",atr:1},candles,100);
 assert.ok(levels&&levels.stop<100&&levels.target1>100&&levels.target3>levels.target2);
 assert.equal(buildShadowLevels({side:"LONG",atr:0},candles,100),null);
});
test("tracks closed-candle stop-first outcome and MAE",()=>{
 const trade={status:"OPEN",side:"LONG",entry:100,stop:98,risk:2,target1:103,target2:105,target3:107,
  entryTime:0,remaining:1,realizedR:0,targetHits:[],maxMaeR:0,lastProcessedCandleTime:0};
 const next=advanceShadowTrade(trade,[{time:0,open:100,high:102,low:97,close:101}],120000);
 assert.equal(next.status,"CLOSED");
 assert.equal(next.exitReason,"STOP");
 assert.equal(next.maxMaeR,1.5);
});
test("summarizes LONG and SHORT independently",()=>{
 const s=summarizeShadowRecords([
  {status:"CLOSED",side:"LONG",realizedR:1,maxMaeR:.4,timeToProfitMin:5},
  {status:"CLOSED",side:"SHORT",realizedR:-1,maxMaeR:1.2,timeToProfitMin:null}
 ]);
 assert.equal(s.closedTrades,2);
 assert.equal(s.bySide.LONG.trades,1);
 assert.equal(s.bySide.SHORT.trades,1);
});

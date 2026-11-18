import test from "node:test";
import assert from "node:assert/strict";
import { replayPortfolio } from "../src/engines/portfolio-replay.js";
const trade=(symbol,candleTime,closedAt,netPnl,status="closed")=>({symbol,side:"SHORT",candleTime,closedAt,netPnl,status});
test("reserves margin and enforces two concurrent positions",()=>{const r=replayPortfolio([trade("BTC",0,2700000,2),trade("ETH",0,3600000,-1),trade("SOL",0,4500000,4)]);assert.equal(r.accepted,2);assert.equal(r.closed,2);assert.equal(r.rejected,1);assert.equal(r.rejectionReasons.max_concurrent_reached,1);assert.equal(r.netPnlUsd,0.5);assert.equal(r.endingCashUsd,10.5);});
test("blocks new positions when realized cash is below margin",()=>{const r=replayPortfolio([trade("BTC",0,1800000,-12),trade("ETH",2700000,4500000,1)]);assert.equal(r.accepted,1);assert.equal(r.rejectionReasons.insufficient_free_margin,1);assert.equal(r.endingCashUsd,4);});
test("does not realize open trade mark-to-market PnL",()=>{const r=replayPortfolio([trade("BTC",0,null,99,"open")]);assert.equal(r.accepted,1);assert.equal(r.closed,0);assert.equal(r.openAtEnd,1);assert.equal(r.endingCashUsd,10);});
test("rejects invalid config",()=>assert.throws(()=>replayPortfolio([],{marginPerTradeUsd:0}),/Invalid marginPerTradeUsd/));

import test from "node:test";
import assert from "node:assert/strict";
import { resolveExclusiveDirectionalTrades } from "../src/engines/directional-coordinator.js";

const trade=(engine,symbol,candleTime,closedAt,score=70,status="closed")=>({engine,symbol,candleTime,closedAt,score,status});

test("same symbol cannot hold simultaneous LONG and SHORT positions",()=>{
  const result=resolveExclusiveDirectionalTrades(
    [trade("A","PF_XBTUSD",100,500)],
    [trade("B","PF_XBTUSD",200,400)]
  );
  assert.equal(result.longTrades.length,1);
  assert.equal(result.shortTrades.length,0);
  assert.equal(result.rejected.length,1);
  assert.equal(result.rejected[0].status,"symbol_direction_conflict");
});

test("opposite direction is allowed after the previous trade has closed",()=>{
  const result=resolveExclusiveDirectionalTrades(
    [trade("A","PF_XBTUSD",100,200)],
    [trade("B","PF_XBTUSD",201,400)]
  );
  assert.equal(result.longTrades.length,1);
  assert.equal(result.shortTrades.length,1);
});

test("same-candle conflict is resolved by stronger score, with deterministic LONG tie-break",()=>{
  const strongerShort=resolveExclusiveDirectionalTrades(
    [trade("A","PF_ETHUSD",100,300,75)],
    [trade("B","PF_ETHUSD",100,250,80)]
  );
  assert.equal(strongerShort.longTrades.length,0);
  assert.equal(strongerShort.shortTrades.length,1);
  const tie=resolveExclusiveDirectionalTrades(
    [trade("A","PF_SOLUSD",100,300,80)],
    [trade("B","PF_SOLUSD",100,250,80)]
  );
  assert.equal(tie.longTrades.length,1);
  assert.equal(tie.shortTrades.length,0);
});

test("open trade reserves its symbol until the end of the tested window",()=>{
  const result=resolveExclusiveDirectionalTrades(
    [trade("A","PF_DOGEUSD",100,null,70,"open")],
    [trade("B","PF_DOGEUSD",900,1200)]
  );
  assert.equal(result.shortTrades.length,0);
  assert.equal(result.rejected.length,1);
});

test("different symbols remain independent",()=>{
  const result=resolveExclusiveDirectionalTrades(
    [trade("A","PF_XBTUSD",100,500)],
    [trade("B","PF_ETHUSD",200,400)]
  );
  assert.equal(result.longTrades.length,1);
  assert.equal(result.shortTrades.length,1);
});

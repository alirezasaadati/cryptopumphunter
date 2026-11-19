import test from "node:test";
import assert from "node:assert/strict";
import { ema, atr, confirmedPivots, evaluateEmaPullback } from "../src/ema-pullback-volume-engine.js";

test("EMA returns null warmup and a finite value after its period",()=>{
  const out=ema([1,2,3,4,5],3);
  assert.equal(out[0],null);assert.equal(out[1],null);assert.equal(out[2],2);
  assert.ok(Number.isFinite(out[4]));
});
test("ATR aligns output to candle indexes",()=>{
  const bars=Array.from({length:20},(_,i)=>({time:i,open:10+i,high:12+i,low:9+i,close:11+i,volume:100}));
  const out=atr(bars,14);assert.equal(out.length,20);assert.equal(out[13],null);assert.ok(out[14]>0);
});
test("confirmed pivots are not exposed before right-side confirmation",()=>{
  const bars=[
    {low:5,high:10},{low:4,high:11},{low:2,high:9},{low:4,high:10},{low:5,high:12},
    {low:6,high:11},{low:7,high:10}
  ];
  const p=confirmedPivots(bars,2,2);
  assert.equal(p.lows[0].index,2);assert.equal(p.lows[0].confirmedAt,4);
});
test("engine rejects insufficient history without throwing",()=>{
  const result=evaluateEmaPullback({higherTimeframe:[],entryTimeframe:[]});
  assert.equal(result.eligible,false);assert.equal(result.rejected,"INSUFFICIENT_OR_INVALID_CANDLES");
});

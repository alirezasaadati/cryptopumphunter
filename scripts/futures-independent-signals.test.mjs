import test from "node:test";
import assert from "node:assert/strict";
import { analyzeIndependentSignal, INDEPENDENT_SIGNAL_ENGINE_VERSION } from "../src/futures-independent-signals.js";

test("independent engine is versioned and rejects invalid input",()=>{
  assert.equal(INDEPENDENT_SIGNAL_ENGINE_VERSION,"1.0.0");
  assert.equal(analyzeIndependentSignal({side:"BUY",candles4h:[],candles15m:[]}),null);
});
test("independent engine never emits a signal without sufficient confirmed structure",()=>{
  const candles=Array.from({length:80},(_,i)=>({time:i*900000,open:100+i*.1,high:101+i*.1,low:99+i*.1,close:100.5+i*.1,volume:10}));
  assert.equal(analyzeIndependentSignal({side:"LONG",candles4h:candles,candles15m:candles}),null);
  assert.equal(analyzeIndependentSignal({side:"SHORT",candles4h:candles,candles15m:candles}),null);
});

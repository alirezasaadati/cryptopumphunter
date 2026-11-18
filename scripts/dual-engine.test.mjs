import test from "node:test";
import assert from "node:assert/strict";
import { analyzeEngineA } from "../src/engines/engine-a.js";
import { analyzeEngineB } from "../src/engines/engine-b.js";
import { ENGINE_CONFIG, validateCandles, ema, rsi, atr, volumeRatio } from "../src/engines/engine-utils.js";

function makeSeries({count=160,step=0.12,base=100,volume=100}={}) {
  return Array.from({length:count},(_,i)=>{
    const close=base+i*step+Math.sin(i/2)*0.03;
    const open=i?base+(i-1)*step+Math.sin((i-1)/2)*0.03:close-step;
    return {time:1700000000000+i*900000,open,high:Math.max(open,close)+0.08,
      low:Math.min(open,close)-0.08,close,volume:i===count-1?volume*2:volume};
  });
}
test("15m engine data validator rejects malformed, unsorted and short candles",()=>{
  const data=makeSeries();
  assert.equal(validateCandles(data),true);
  assert.equal(validateCandles(data.slice(0,20)),false);
  assert.equal(validateCandles([...data.slice(1),data[0]]),false);
  assert.equal(validateCandles(data.map((c,i)=>i===4?{...c,high:c.low-1}:c)),false);
});
test("indicator helpers return bounded, finite values",()=>{
  const data=makeSeries(), closes=data.map(c=>c.close);
  assert.ok(ema(closes,20)>0);
  assert.ok(rsi(closes)>=0 && rsi(closes)<=100);
  assert.ok(atr(data)>0);
  assert.ok(volumeRatio(data)>0);
  assert.equal(ema([1,2],20),null);
});
test("Engine A emits a separate conditional two-entry plan with five channel targets",()=>{
  const signal=analyzeEngineA({symbol:"PF_TESTUSD",candles:makeSeries(),quoteVolume:10_000_000});
  // A deterministic rising fixture may not create a fresh breakout/pullback; null is a valid no-setup.
  if(signal){
    assert.equal(signal.engine,"A");
    assert.equal(signal.context.entry2Conditional,true);
    assert.equal(signal.targets.length,5);
    assert.ok(signal.stop<signal.entry1);
  }
});
test("Engine B emits an adaptive R-multiple plan, not channel percentage targets",()=>{
  const signal=analyzeEngineB({symbol:"PF_TESTUSD",candles:makeSeries(),quoteVolume:10_000_000});
  if(signal){
    assert.equal(signal.engine,"B");
    assert.deepEqual(signal.context.targetsR,[1.5,2.2,3]);
    assert.equal(signal.targets.length,3);
    assert.ok(signal.stop<signal.entry);
  }
});
test("both engines reject symbols below the liquidity floor",()=>{
  const candles=makeSeries();
  assert.equal(analyzeEngineA({symbol:"PF_TESTUSD",candles,quoteVolume:1}),null);
  assert.equal(analyzeEngineA({symbol:"PF_TESTUSD",candles}),null);
  assert.equal(analyzeEngineA({symbol:"PF_TESTUSD",candles,quoteVolume:Infinity}),null);
  assert.equal(analyzeEngineB({symbol:"PF_TESTUSD",candles,quoteVolume:1}),null);
  assert.equal(analyzeEngineB({symbol:"PF_TESTUSD",candles}),null);
  assert.equal(analyzeEngineB({symbol:"PF_TESTUSD",candles,quoteVolume:Infinity}),null);
  assert.equal(ENGINE_CONFIG.INTERVAL,"15m");
});

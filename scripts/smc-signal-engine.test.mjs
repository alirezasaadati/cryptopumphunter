import test from "node:test";
import assert from "node:assert/strict";
import {
  SMC_CONFIG, validateOHLC, calculateATR, confirmedPivots,
  classifyStructure, evaluateDecisionMatrix, analyzeSMCSignal
} from "../src/smc-signal-engine.js";

function candles(n=100,base=100,step=900000){
  return Array.from({length:n},(_,i)=>({
    time:i*step,open:base,high:base+0.5,low:base-0.5,close:base,volume:100
  }));
}
function risingStructure(n=100,step=3600000){
  const a=candles(n,100,step);
  for(let i=0;i<n;i++){
    const center=100+i*0.025;
    a[i]={time:i*step,open:center-0.08,high:center+0.25,low:center-0.25,close:center+0.08,volume:100};
  }
  // Confirmed higher highs and higher lows.
  for(const [i,h,l] of [[10,102,99],[20,101.5,99.8],[30,103,100.5],[40,102.5,101],[50,104,101.5],[60,103.5,102],[70,105,102.5],[80,104.5,103],[90,106,103.5]]){
    a[i]={time:i*step,open:(h+l)/2-0.1,high:h,low:l,close:(h+l)/2+0.1,volume:100};
  }
  return a;
}

test("validates OHLC and rejects malformed candles",()=>{
  assert.equal(validateOHLC(candles()),true);
  const bad=candles();bad[4].low=999;
  assert.equal(validateOHLC(bad),false);
  assert.equal(validateOHLC(candles(10)),false);
});
test("ATR returns null warmup then finite Wilder values",()=>{
  const a=calculateATR(candles(40),14);
  assert.equal(a[14]!==null,true);
  assert.ok(a.at(-1)>0);
  assert.equal(a[13],null);
});
test("confirmed pivots require right-side candles",()=>{
  const a=candles(20);
  a[10].high=110;
  const p=confirmedPivots(a,2,2);
  const hit=p.highs.find(x=>x.index===10);
  assert.ok(hit);
  assert.equal(hit.confirmedAt,12);
});
test("classifies a clear higher-high / higher-low market as bullish",()=>{
  const s=classifyStructure(risingStructure());
  assert.equal(s.direction,"BULLISH");
});
test("decision matrix fails closed when news status is unknown",()=>{
  const m=evaluateDecisionMatrix({
    trend:true,liquidity:{price:100},structure:{kind:"BOS"},
    news:{status:"UNKNOWN"},risk:{valid:true}
  });
  assert.equal(m.approved,false);
  assert.match(m.rejected,/اخبار نامشخص/);
});
test("decision matrix blocks high-impact news even if other layers pass",()=>{
  const m=evaluateDecisionMatrix({
    trend:true,liquidity:{price:100},structure:{kind:"BOS"},
    news:{status:"CLEAR",highImpact:true},risk:{valid:true}
  });
  assert.equal(m.approved,false);
});
test("signal engine refuses to invent a signal without all required timeframe data",()=>{
  const result=analyzeSMCSignal({
    symbol:"PF_TESTUSD",higherTimeframe:candles(20),structureTimeframe:candles(20),
    entryTimeframe:candles(20),news:{status:"CLEAR"},riskConfig:{}
  });
  assert.equal(result.eligible,false);
  assert.equal(result.signal,null);
  assert.ok(result.rejected);
});
test("matrix score cannot exceed 100",()=>{
  const m=evaluateDecisionMatrix({
    trend:true,liquidity:{price:100},structure:{kind:"BOS"},
    news:{status:"CLEAR"},risk:{valid:true}
  });
  assert.equal(m.score,100);
  assert.equal(m.approved,true);
  assert.equal(SMC_CONFIG.MIN_MATRIX_SCORE,75);
});

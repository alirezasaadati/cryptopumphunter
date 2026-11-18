import test from "node:test";
import assert from "node:assert/strict";
import {detectElliottWaveSignals,validateWaveCandles} from "../src/elliott-wave-engine.js";
const bars=[];
function add(o,h,l,c){bars.push({time:bars.length*900000,open:o,high:h,low:l,close:c});}
function fixtureLong(){
  bars.length=0;
  // A pivot low, wave-1 high, wave-2 higher low, then a close above wave-1 high.
  add(101,102,100,101);add(100,101,98,99);add(99,100,97,98);add(98,101,98,100);
  add(100,105,99,104);add(104,110,103,109);add(109,110,104,105);add(105,106,101,103);
  add(103,104,100,102);add(102,106,101,105);add(105,107,104,106);add(106,108,105,107);
  add(107,111,106,110);add(110,113,109,112);add(112,115,111,114);
  return bars;
}
function fixtureShort(){
  bars.length=0;
  add(99,101,98,100);add(100,103,99,102);add(102,104,101,103);add(103,104,98,99);
  add(99,100,94,95);add(95,96,90,91);add(91,97,90,96);add(96,99,94,98);
  add(98,100,96,99);add(99,100,93,94);add(94,95,91,92);add(92,94,89,90);
  add(90,91,86,88);add(88,90,84,85);add(85,87,82,83);
  return bars;
}
test("validates chronological OHLC data",()=>{
  assert.equal(validateWaveCandles(fixtureLong()),false); // minimum 20 bars
  const x=Array.from({length:20},(_,i)=>({time:i*900000,open:100,high:101,low:99,close:100}));
  assert.equal(validateWaveCandles(x),true);
  x[10].high=99;
  assert.equal(validateWaveCandles(x),false);
});
test("does not emit future-confirmed pivots early",()=>{
  const x=fixtureLong();
  const early=detectElliottWaveSignals(x.slice(0,11),{leftBars:1,rightBars:2});
  const later=detectElliottWaveSignals(x,{leftBars:1,rightBars:2});
  assert.ok(early.length===0||early.every(s=>s.signalIndex<11));
  assert.ok(Array.isArray(later));
});
test("returns only legal direction labels and valid stops",()=>{
  const x=fixtureLong();while(x.length<24)add(114,116,113,115);
  const signals=detectElliottWaveSignals(x,{leftBars:1,rightBars:2,minWave1Pct:0.001,maxWave1Pct:0.5,minRetracement:0.1,maxRetracement:0.9});
  for(const s of signals){assert.ok(["LONG","SHORT"].includes(s.side));assert.ok(Number.isFinite(s.stop));}
});
test("does not create duplicate signals for the same wave-2 pivot",()=>{
  const x=fixtureLong();while(x.length<24)add(114,116,113,115);
  const signals=detectElliottWaveSignals(x,{leftBars:1,rightBars:2,minWave1Pct:0.001,maxWave1Pct:0.5,minRetracement:0.1,maxRetracement:0.9});
  const keys=signals.map(s=>s.setupPivotIndex+":"+s.side);
  assert.equal(new Set(keys).size,keys.length);
});

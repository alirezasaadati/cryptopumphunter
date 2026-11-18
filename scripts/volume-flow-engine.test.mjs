import test from "node:test";
import assert from "node:assert/strict";
import { analyzeVolumeFlow } from "../src/volume-flow-engine.js";
function candles(n,tf,base,step,volume=100){
  return Array.from({length:n},(_,i)=>{
    const close=base+i*step, open=close-step*0.2;
    return {time:(i+1)*tf,open,high:Math.max(open,close)+0.15,low:Math.min(open,close)-0.15,close,volume};
  });
}
function fixture(){
  const fourHour=candles(80,14400000,100,0.1);
  const oneHour=candles(100,3600000,100,0.1);
  const fifteenMin=candles(80,900000,100,0.08);
  const prev=fifteenMin.slice(-21,-1);
  const high=Math.max(...prev.map(c=>c.high));
  const last=fifteenMin.at(-1);
  last.open=high+0.02; last.low=high-0.08; last.close=high+0.45;
  last.high=last.close+0.08; last.volume=220;
  return {symbol:"PF_XBTUSD",fourHour,oneHour,fifteenMin};
}
test("accepts aligned trend, confirmed breakout and relative volume",()=>{
 const r=analyzeVolumeFlow(fixture()); assert.ok(r.signal); assert.equal(r.signal.side,"LONG");
 assert.ok(r.signal.relativeVolume>=1.5); assert.ok(r.signal.target1>r.signal.entry);
});
test("rejects weak relative volume",()=>{
 const x=fixture(); x.fifteenMin.at(-1).volume=110;
 assert.equal(analyzeVolumeFlow(x).rejected,"weak_relative_volume");
});
test("fails closed when volume is missing",()=>{
 const x=fixture(); x.fifteenMin.at(-1).volume=0;
 assert.equal(analyzeVolumeFlow(x).rejected,"volume_unavailable");
});
test("rejects insufficient candles",()=>{
 const x=fixture(); x.oneHour=x.oneHour.slice(0,30);
 assert.equal(analyzeVolumeFlow(x).rejected,"invalid_or_insufficient_candles");
});
test("does not treat candle volume as buyer/seller delta",()=>{
 const r=analyzeVolumeFlow(fixture()); assert.ok(r.signal);
 assert.match(r.signal.reason,/حجم نسبی/);
 assert.equal("buySellDelta" in r.signal,false);
});

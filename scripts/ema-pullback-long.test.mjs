import test from "node:test";
import assert from "node:assert/strict";
import { analyzeEmaPullbackLong } from "../src/ema-pullback-long.js";

function fixture({n=260,trend=1,finalBull=true}={}){
  const rows=[];let p=100;
  for(let i=0;i<n;i++){
    const drift=trend===1?0.22:trend===-1?-0.22:0;
    const open=p,close=p+drift+(i%7===0?0.04:0);
    rows.push({open,high:Math.max(open,close)+0.25,low:Math.min(open,close)-0.25,close,volume:100});
    p=close;
  }
  if(finalBull){const x=rows.at(-1);x.open=x.close-0.2;x.high=x.close+0.3;x.low=x.close-0.3;x.volume=120;}
  return rows;
}
test("rejects insufficient history",()=>assert.equal(analyzeEmaPullbackLong({symbol:"T",candles:fixture({n:100})}).reason,"insufficient_history"));
test("rejects candles without volume",()=>{const c=fixture();delete c.at(-1).volume;assert.equal(analyzeEmaPullbackLong({symbol:"T",candles:c}).reason,"invalid_ohlcv");});
test("returns a structured result for a long bullish history",()=>{const r=analyzeEmaPullbackLong({symbol:"T",candles:fixture()});assert.equal(r.side,"LONG");assert.ok(typeof r.eligible==="boolean");if(r.eligible){assert.ok(r.stop<r.entry);assert.ok(r.tp1>r.entry);assert.ok(r.tp2>r.tp1);assert.ok(r.confidence>=55);}});
test("does not emit a signal in a sustained downtrend",()=>{const r=analyzeEmaPullbackLong({symbol:"T",candles:fixture({trend:-1})});assert.equal(r.eligible,false);});

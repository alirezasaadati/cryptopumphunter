import test from "node:test";
import assert from "node:assert/strict";
import {detectCandlestickSignals,validateOhlc} from "../src/candlestick-engine.js";
const c=(i,o,h,l,cl)=>({time:i*900000,open:o,high:h,low:l,close:cl,volume:100});

test("validates ordered OHLC candles",()=>{
  assert.equal(validateOhlc([c(0,10,11,9,10),c(1,10,11,9,10),c(2,10,11,9,10)]),true);
  assert.equal(validateOhlc([c(0,10,9,8,10),c(1,10,11,9,10),c(2,10,11,9,10)]),false);
});
test("detects bullish and bearish engulfing symmetrically",()=>{
  const bull=[c(0,10,10.03,9.97,10),c(1,10.02,10.03,9.95,9.97),c(2,9.96,10.04,9.94,10.03)];
  const bear=[c(0,10,10.03,9.97,10),c(1,9.97,10.05,9.96,10.03),c(2,10.04,10.06,9.94,9.95)];
  assert.ok(detectCandlestickSignals(bull,2).some(x=>x.pattern==="bullish_engulfing"&&x.side==="LONG"));
  assert.ok(detectCandlestickSignals(bear,2).some(x=>x.pattern==="bearish_engulfing"&&x.side==="SHORT"));
});
test("detects bullish and bearish pin bars",()=>{
  const bull=[c(0,10,10.05,9.95,10),c(1,10,10.08,9.75,10.07),c(2,10.07,10.1,10.05,10.08)];
  const bear=[c(0,10,10.05,9.95,10),c(1,10.08,10.35,10,10.01),c(2,10.01,10.04,9.98,10)];
  assert.ok(detectCandlestickSignals(bull,1).some(x=>x.pattern==="bullish_pin_bar"));
  assert.ok(detectCandlestickSignals(bear,1).some(x=>x.pattern==="bearish_pin_bar"));
});
test("does not emit a signal before enough closed candles exist",()=>{
  assert.deepEqual(detectCandlestickSignals([c(0,10,11,9,10),c(1,10,11,9,10)],1),[]);
});
test("signal formation ends at the evaluated candle and never reads later candles",()=>{
  const bars=[c(0,10,10.03,9.97,10),c(1,10.02,10.03,9.95,9.97),c(2,9.96,10.04,9.94,10.03)];
  const before=detectCandlestickSignals(bars,2);
  bars.push(c(3,10.03,10.08,10,10.06));
  const after=detectCandlestickSignals(bars,2);
  assert.deepEqual(after,before);
});

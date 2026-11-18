import test from "node:test";
import assert from "node:assert/strict";
import {detectCandlestickSignals,validateOhlc} from "../src/candlestick-engine.js";
const c=(i,o,h,l,cl)=>({time:i*900000,open:o,high:h,low:l,close:cl,volume:100});

test("validates ordered OHLC candles",()=>{
  assert.equal(validateOhlc([c(0,10,11,9,10),c(1,10,11,9,10),c(2,10,11,9,10)]),true);
  assert.equal(validateOhlc([c(0,10,9,8,10),c(1,10,11,9,10),c(2,10,11,9,10)]),false);
});
test("detects bullish and bearish engulfing symmetrically",()=>{
  const bull=[c(0,10,10.2,8.8,9),c(1,8.9,10.4,8.7,10.2),c(2,10.2,10.3,10,10.1)];
  const bear=[c(0,9,10.2,8.8,10),c(1,10.1,10.3,8.6,8.8),c(2,8.8,9,8.7,8.9)];
  assert.ok(detectCandlestickSignals(bull,1).some(x=>x.pattern==="bullish_engulfing"&&x.side==="LONG"));
  assert.ok(detectCandlestickSignals(bear,1).some(x=>x.pattern==="bearish_engulfing"&&x.side==="SHORT"));
});
test("detects bullish and bearish pin bars",()=>{
  const bull=[c(0,10,10.1,8.8,10.02),c(1,10,10.2,8.5,10.1),c(2,10.1,10.2,10,10.15)];
  const bear=[c(0,10,11.2,9.9,10.02),c(1,10.1,11.5,10,10),c(2,10,10.1,9.9,10.05)];
  assert.ok(detectCandlestickSignals(bull,1).some(x=>x.pattern==="bullish_pin_bar"));
  assert.ok(detectCandlestickSignals(bear,1).some(x=>x.pattern==="bearish_pin_bar"));
});
test("does not emit a signal before enough closed candles exist",()=>{
  assert.deepEqual(detectCandlestickSignals([c(0,10,11,9,10),c(1,10,11,9,10)],1),[]);
});
test("signal formation ends at the evaluated candle and never reads later candles",()=>{
  const bars=[c(0,10,10.2,8.8,9),c(1,8.9,10.4,8.7,10.2),c(2,10.2,10.3,10,10.1)];
  const before=detectCandlestickSignals(bars,1);
  bars.push(c(3,10.1,10.5,10,10.4));
  const after=detectCandlestickSignals(bars,1);
  assert.deepEqual(after,before);
});

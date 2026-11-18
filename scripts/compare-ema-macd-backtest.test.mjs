import test from "node:test";
import assert from "node:assert/strict";
import { emaSeries, rsiSeries, atrSeries, candidateSignal } from "./compare-ema-macd-backtest.mjs";

function candles(n, closeFn = i => 100 + i * 0.1) {
  return Array.from({length:n},(_,i)=>{
    const close=closeFn(i);
    return {time:i*3600000,open:close-0.05,high:close+0.2,low:close-0.2,close,volume:100};
  });
}

test("EMA series returns a finite aligned series",()=>{
  const values=[1,2,3,4,5];
  const result=emaSeries(values,3);
  assert.equal(result.length,values.length);
  assert.ok(result.every(Number.isFinite));
  assert.ok(result.at(-1)>result[0]);
});

test("RSI uses Wilder smoothing and remains in its valid range",()=>{
  const rising=Array.from({length:40},(_,i)=>i+1);
  const result=rsiSeries(rising,14);
  assert.equal(result[13],null);
  assert.equal(result[39],100);
  assert.ok(result.slice(14).every(x=>x>=0&&x<=100));
});

test("ATR series is positive and aligned to candles",()=>{
  const data=candles(40);
  const result=atrSeries(data,14);
  assert.equal(result.length,data.length);
  assert.equal(result[13],null);
  assert.ok(result[14]>0);
});

test("candidate model requires 200 completed candles",()=>{
  assert.equal(candidateSignal(candles(199)),null);
  assert.ok(candidateSignal(candles(240))===null || ["LONG","SHORT"].includes(candidateSignal(candles(240)).side));
});

test("candidate model identifies a sustained bullish trend only when its filters align",()=>{
  const data=candles(260,i=>100*Math.pow(1.002,i));
  const signal=candidateSignal(data);
  assert.equal(signal?.side,"LONG");
  assert.ok(signal.atr>0);
  assert.ok(signal.rsi>50);
});

test("candidate model identifies a sustained bearish trend only when its filters align",()=>{
  const data=candles(260,i=>i<240?200-0.1*i:176-0.5*(i-240));
  const signal=candidateSignal(data);
  assert.equal(signal?.side,"SHORT");
  assert.ok(signal.atr>0);
  assert.ok(signal.rsi<50);
});

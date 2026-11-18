import test from "node:test";
import assert from "node:assert/strict";
import {
  confirmedPivots, detectFourHourTrend, detectOneHourBOS,
  detectLiquiditySweep15m, buildPriceActionSignal
} from "./btcusdt-price-action.mjs";

function candles(n, base=100) {
  return Array.from({length:n},(_,i)=>({
    time:i*900000, open:base, high:base+5, low:base-5, close:base, volume:1
  }));
}
function bullishH4() {
  const x=candles(36,100);
  for (const [i,v] of [[5,110],[15,112],[25,114]]) x[i].high=v;
  for (const [i,v] of [[9,90],[19,92],[29,94]]) x[i].low=v;
  return x;
}
function bearishH4() {
  const x=candles(36,100);
  for (const [i,v] of [[5,114],[15,112],[25,110]]) x[i].high=v;
  for (const [i,v] of [[9,90],[19,88],[29,86]]) x[i].low=v;
  return x;
}

test("confirmed pivots exclude unconfirmed right-edge candles",()=>{
  const x=candles(12);
  x[6].high=120;
  const p=confirmedPivots(x,2,2);
  assert.ok(p.highs.some(v=>v.index===6));
  assert.ok(!p.highs.some(v=>v.index>=10));
});

test("4H structure detects higher highs and higher lows",()=>{
  assert.equal(detectFourHourTrend(bullishH4()),"LONG");
  assert.equal(detectFourHourTrend(bearishH4()),"SHORT");
  assert.equal(detectFourHourTrend(candles(36)),"NEUTRAL");
});

test("1H BOS must agree with the 4H structure",()=>{
  const h1=candles(30,100);
  h1[10].high=112;
  h1[28].close=111;
  h1[28].high=113;
  h1[29].close=113;
  h1[29].high=114;
  const long=detectOneHourBOS(bullishH4(),h1);
  assert.equal(long?.side,"LONG");
  assert.equal(detectOneHourBOS(bearishH4(),h1),null);
});

test("15m bullish liquidity sweep requires reclaim and close above prior bar high",()=>{
  const x=candles(10,105);
  for (const c of x) { c.low=105; c.high=110; }
  x[8]={...x[8],open:105.2,high:105.8,low:105.1,close:105.5};
  x[9]={...x[9],open:105.5,high:108,low:104.5,close:106.5};
  const sweep=detectLiquiditySweep15m(x,8);
  assert.equal(sweep?.side,"LONG");
  assert.equal(sweep?.sweepLevel,105);
  assert.equal(buildPriceActionSignal({side:"LONG"},x,8)?.target3>106.5,true);
  assert.equal(buildPriceActionSignal({side:"SHORT"},x,8),null);
});

test("15m sweep without a close through the prior candle extreme is rejected",()=>{
  const x=candles(10,105);
  for (const c of x) { c.low=105; c.high=110; }
  x[8]={...x[8],open:105.2,high:105.8,low:105.1,close:105.5};
  x[9]={...x[9],open:105.5,high:105.8,low:104.5,close:105.4};
  assert.equal(detectLiquiditySweep15m(x,8),null);
});

import test from "node:test";
import assert from "node:assert/strict";
import { evaluateLongSetup, validateLongCandles, LONG_CONFIG } from "./long-engine.js";

function risingCandles(count, interval, start=100, step=0.08) {
  return Array.from({length:count},(_,i)=>{
    const close=start+i*step;
    return {time:(i+1)*interval,open:close-step*0.35,high:close+step*0.3,low:close-step*0.55,close,volume:1000+i*2};
  });
}

test("validates monotonic OHLC candles",()=>{
  const good=risingCandles(90,300000);
  assert.equal(validateLongCandles(good,80),true);
  assert.equal(validateLongCandles(good.slice(1),90),false);
  const bad=[...good]; bad[4]={...bad[4],high:1};
  assert.equal(validateLongCandles(bad,80),false);
});

test("blocks LONG when BTC regime is not bullish",()=>{
  const result=evaluateLongSetup({
    fiveMin:risingCandles(100,300000),
    fifteenMin:risingCandles(100,900000),
    btcRegimeBullish:false
  });
  assert.equal(result.candidate,null);
  assert.ok(result.diagnostics.some(x=>x.status==="rejected_btc"));
});

test("requires both 15m regime and BTC confirmation",()=>{
  const flat=Array.from({length:100},(_,i)=>({time:(i+1)*900000,open:100,high:100.2,low:99.8,close:100,volume:1000}));
  const result=evaluateLongSetup({fiveMin:risingCandles(100,300000),fifteenMin:flat,btcRegimeBullish:true});
  assert.equal(result.candidate,null);
  assert.ok(result.diagnostics.some(x=>x.status==="rejected_regime"));
});

test("configuration remains conservative",()=>{
  assert.equal(LONG_CONFIG.MIN_SCORE,85);
  assert.equal(LONG_CONFIG.MIN_RR,1.5);
  assert.equal(LONG_CONFIG.MAX_RISK_PCT,0.025);
});

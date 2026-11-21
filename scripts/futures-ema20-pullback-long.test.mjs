import test from "node:test";
import assert from "node:assert/strict";
import {analyzeEma20PullbackLong,EMA20_PULLBACK_LONG_VERSION} from "../src/futures-ema20-pullback-long.js";

function rising(n=100,start=100,step=.12){
  return Array.from({length:n},(_,i)=>{const c=start+i*step;return{time:i*900000,open:c-.03,high:c+.12,low:c-.12,close:c,volume:100};});
}
function fixture(){
  const candles=rising(80,100,.15);
  const p=candles.at(-1);
  p.open=p.close-.12;p.low=p.close-.18;p.high=p.close+.05;
  const btcCandles=rising(80,300,.2);
  return {symbol:"TEST-PERP",candles,btcCandles};
}
test("engine is independently versioned",()=>assert.equal(EMA20_PULLBACK_LONG_VERSION,"1.0.0"));
test("requires sufficient symbol and BTC candle history",()=>{
  assert.equal(analyzeEma20PullbackLong({symbol:"X",candles:[],btcCandles:[]}).eligible,false);
});
test("accepts an EMA20 bullish pullback with BTC above its EMA20",()=>{
  const r=analyzeEma20PullbackLong(fixture());
  assert.equal(r.eligible,true,JSON.stringify(r));
  assert.equal(r.rewardRisk,2);
  assert.ok(r.stop<r.entry&&r.target>r.entry);
});
test("rejects when BTC is below EMA20",()=>{
  const f=fixture();f.btcCandles=f.btcCandles.map(c=>({...c,close:500-c.time/900000*.2,open:500-c.time/900000*.2-.02,high:501,low:490}));
  const r=analyzeEma20PullbackLong(f);
  assert.equal(r.eligible,false);
  assert.match(r.rejected,/بیت‌کوین/);
});
test("does not mutate market candles",()=>{
  const f=fixture(),before=JSON.stringify(f);
  analyzeEma20PullbackLong(f);
  assert.equal(JSON.stringify(f),before);
});

import test from "node:test";
import assert from "node:assert/strict";
import { analyzeBreakoutRetestLong, BREAKOUT_RETEST_LONG_VERSION } from "../src/futures-breakout-retest-long.js";

function trendCandles(count=80, step=0.08) {
  return Array.from({length:count},(_,i)=>{
    const close=100+i*step;
    return {time:i,open:close-0.03,high:close+0.08,low:close-0.08,close,volume:100};
  });
}
function validFixture() {
  const c=trendCandles(80,0.08);
  // Confirmed resistance pivot, followed by a close above it.
  const p=65, level=106.0;
  c[p]={...c[p],open:105.7,high:level,low:105.6,close:105.8};
  for(let i=p-3;i<=p+3;i++) if(i!==p) c[i]={...c[i],high:105.85};
  c[70]={...c[70],open:105.9,high:106.35,low:105.85,close:106.3,volume:150};
  // Keep the intervening closes above the broken level.
  for(let i=71;i<79;i++) c[i]={...c[i],open:106.1,high:106.3,low:106.0,close:106.15};
  c[79]={...c[79],open:105.9,high:106.3,low:105.5,close:106.2,volume:120};
  return c;
}
test("version is explicit",()=>assert.equal(BREAKOUT_RETEST_LONG_VERSION,"1.0.0"));
test("rejects insufficient history",()=>{
  const short=trendCandles(20);
  assert.equal(analyzeBreakoutRetestLong({symbol:"T",candles15m:short,candles1h:short,candles4h:short}).eligible,false);
});
test("accepts confirmed resistance breakout and bullish retest",()=>{
  const r=analyzeBreakoutRetestLong({symbol:"T",candles15m:validFixture(),candles1h:trendCandles(),candles4h:trendCandles()});
  assert.equal(r.eligible,true,JSON.stringify(r));
  assert.ok(r.target>r.entry&&r.stop<r.entry);
});
test("rejects when higher timeframe trend is not aligned",()=>{
  const down=trendCandles(80,-0.08);
  const r=analyzeBreakoutRetestLong({symbol:"T",candles15m:validFixture(),candles1h:down,candles4h:down});
  assert.equal(r.eligible,false);
});
test("does not mutate candle inputs",()=>{
  const a=validFixture(),b=trendCandles(),c=trendCandles();
  const before=JSON.stringify([a,b,c]);
  analyzeBreakoutRetestLong({symbol:"T",candles15m:a,candles1h:b,candles4h:c});
  assert.equal(JSON.stringify([a,b,c]),before);
});

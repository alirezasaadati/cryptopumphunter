import test from "node:test";
import assert from "node:assert/strict";
import { analyzeRabbitCorrection, RABBIT_DEFAULTS } from "../src/rabbit-engine.js";

const BASE_TIME = 1700000000000;
const STEP = 900000;
function mkCandles(n, base=100, step=0, volume=1000, interval=STEP, start=BASE_TIME) {
  const out=[]; let p=base;
  for(let i=0;i<n;i++){
    const open=p,close=p+step;
    out.push({time:start+i*interval,open,close,high:Math.max(open,close)+0.02,low:Math.min(open,close)-0.02,volume});
    p=close;
  }
  return out;
}
function appendSurge(candles,count=8,increment=0.4,volume=2000){
  for(let i=0;i<count;i++){
    const open=candles.at(-1).close,close=open+increment;
    candles.push({time:candles.at(-1).time+STEP,open,close,high:close+0.02,low:open-0.02,volume});
  }
}
function appendCorrection(candles,volume=2500){
  const p=candles.at(-1),open=p.high-0.03,close=open-2.2;
  candles.push({time:p.time+STEP,open,close,high:open+0.02,low:close-0.03,volume});
}
function context(){
  const one=mkCandles(120,100,0.5,1000,3600000);
  const four=mkCandles(120,90,0.6,1000,14400000);
  const fifteen=mkCandles(60,100,0,1000);
  appendSurge(fifteen);
  return {symbol:"TESTUSDT",candles1h:one,candles4h:four,candles15m:fifteen,
    btcRegime:{ok:true,longAllowed:true},state:{}};
}
function run(ctx,overrides){
  ctx.price=ctx.candles15m.at(-1).close;
  return analyzeRabbitCorrection(ctx,overrides);
}

test("T1: valid impulse and real bearish breakdown emit one SHORT",()=>{
  const x=context();appendCorrection(x.candles15m);
  const r=run(x);
  assert.equal(r.eligible,true,JSON.stringify(r));
  assert.equal(r.side,"SHORT");
  assert.equal(r.nextState.TESTUSDT.consumed,true);
  assert.ok(r.stop>r.entry && r.target1<r.entry);
  assert.ok(Number.isFinite(r.ema20PreSurge));
});
test("T2: impulse without correction is stored as pending",()=>{
  const x=context(),p=x.candles15m.at(-1);
  x.candles15m.push({time:p.time+STEP,open:p.close,close:p.close,high:p.close+0.02,low:p.close-0.02,volume:900});
  const r=run(x);
  assert.equal(r.eligible,false);
  assert.equal(r.nextState.TESTUSDT.consumed,false);
});
test("T3: consumed impulse cannot emit a duplicate signal",()=>{
  const x=context();appendCorrection(x.candles15m);
  const first=run(x);assert.equal(first.eligible,true);
  const second=analyzeRabbitCorrection({...x,state:first.nextState});
  assert.equal(second.eligible,false);
  assert.match(second.rejected,/قبلاً مصرف شده/);
});
test("T4: state expires by timestamp after the configured delay",()=>{
  const x=context(),p=x.candles15m.at(-1);
  x.candles15m.push({time:p.time+STEP,open:p.close,close:p.close,high:p.close+0.02,low:p.close-0.02,volume:900});
  const first=run(x);
  for(let i=0;i<6;i++){
    const q=x.candles15m.at(-1);
    x.candles15m.push({time:q.time+STEP,open:q.close,close:q.close,high:q.close+0.02,low:q.close-0.02,volume:800});
  }
  const expired=analyzeRabbitCorrection({...x,state:first.nextState});
  assert.equal(expired.nextState.TESTUSDT,null);
});
test("T5: a newer lower-high impulse replaces a consumed old setup",()=>{
  const x=context();appendCorrection(x.candles15m);
  const first=run(x);assert.equal(first.eligible,true);
  const oldHigh=first.nextState.TESTUSDT.surgeHigh;
  for(let i=0;i<20;i++){
    const p=x.candles15m.at(-1),close=p.close-0.2;
    x.candles15m.push({time:p.time+STEP,open:p.close,close,high:p.close+0.02,low:close-0.02,volume:1000});
  }
  appendSurge(x.candles15m,8,0.4,2200);appendCorrection(x.candles15m,2600);
  const second=analyzeRabbitCorrection({...x,state:first.nextState});
  assert.ok(second.nextState.TESTUSDT);
  assert.ok(second.nextState.TESTUSDT.peakTime>first.nextState.TESTUSDT.peakTime);
  assert.ok(second.nextState.TESTUSDT.surgeHigh<oldHigh);
  assert.equal(second.eligible,true,JSON.stringify(second));
});
test("T6: rolling candle arrays preserve state through absolute timestamps",()=>{
  const x=context(),p=x.candles15m.at(-1);
  x.candles15m.push({time:p.time+STEP,open:p.close,close:p.close,high:p.close+0.02,low:p.close-0.02,volume:900});
  const first=run(x),peakTime=first.nextState.TESTUSDT.peakTime;
  const q=x.candles15m.at(-1);
  x.candles15m.push({time:q.time+STEP,open:q.close,close:q.close,high:q.close+0.02,low:q.close-0.02,volume:900});
  const second=analyzeRabbitCorrection({...x,candles15m:x.candles15m.slice(-50),state:first.nextState});
  assert.equal(second.nextState.TESTUSDT.peakTime,peakTime);
  assert.equal(second.nextState.TESTUSDT.consumed,false);
});
test("T7: BTC bullish regime gate remains mandatory",()=>{
  const x=context();appendCorrection(x.candles15m);x.btcRegime={ok:true,longAllowed:false};
  assert.equal(run(x).eligible,false);
});
test("T8: a weak impulse does not arm a setup",()=>{
  const x=context(),flat=mkCandles(60,100,0,1000);
  appendSurge(flat,8,0.05,900);
  const p=flat.at(-1);
  flat.push({time:p.time+STEP,open:p.close,close:p.close,high:p.close+0.02,low:p.close-0.02,volume:900});
  x.candles15m=flat;
  const r=run(x);
  assert.equal(r.eligible,false);
  assert.equal(r.nextState.TESTUSDT,null);
});
test("T9: invalid OHLCV is rejected before indicator calculations",()=>{
  const x=context();appendCorrection(x.candles15m);
  x.candles15m.at(-1).low=x.candles15m.at(-1).high+1;
  const r=run(x);
  assert.equal(r.eligible,false);
  assert.match(r.rejected,/OHLCV/);
});
test("T10: prior-low requirement can be isolated from the EMA9 breakdown",()=>{
  assert.equal(RABBIT_DEFAULTS.requirePriorLowBreakdown,true);
  const x=context();appendCorrection(x.candles15m);
  const c=x.candles15m.at(-1);
  x.candles15m.at(-2).low=99.5;
  x.candles15m.at(-3).low=99.5;
  c.close=101.5;
  c.low=101.45;
  const strict=run(x);
  assert.equal(strict.eligible,false);
  assert.match(strict.rejected,/اصلاح هنوز تأیید نشده/);
  const soft=analyzeRabbitCorrection({...x,price:c.close},{requirePriorLowBreakdown:false});
  assert.equal(soft.eligible,true,JSON.stringify(soft));
});

import test from "node:test";
import assert from "node:assert/strict";
import { evaluateShortTfConfirmation } from "../src/short-tf-confirmation.js";

const M1=60_000, M5=300_000, M15=900_000;

function trend(interval,count,{base=100,step=0.04,side="LONG",range=0.02}={}) {
  return Array.from({length:count},(_,i)=>{
    const raw=base+i*step;
    return {time:i*interval,open:raw-step*0.15,high:raw+range,low:raw-range,close:raw,volume:100+i};
  });
}

function fixture(side) {
  const sign=side==="LONG"?1:-1;
  const m15=trend(M15,45,{base:100,step:sign*0.2,side,range:0.04});
  const closes=m15.slice(0,44).map(c=>c.close);
  let e=closes.slice(0,21).reduce((a,b)=>a+b,0)/21;
  const k=2/(21+1);
  for(let i=21;i<44;i++) e=closes[i]*k+e*(1-k);
  const last=m15[44], pbClose=e+sign*0.03;
  m15[44]={...last,open:pbClose-sign*0.01,high:pbClose+sign*0.02,low:e+sign*0.005,close:pbClose};
  if(side==="SHORT") m15[44]={...last,open:pbClose+0.01,high:e-0.005,low:pbClose-0.02,close:pbClose};

  const m5=trend(M5,140,{base:100,step:sign*0.04,side,range:0.025});
  const confirmIndex=135;
  const conf=m5[confirmIndex], confClose=conf.close+sign*0.02;
  m5[confirmIndex]={...conf,open:conf.close-sign*0.005,high:confClose+0.01,low:conf.close-0.01,close:confClose};

  const m1=trend(M1,700,{base:100,step:sign*0.001,side,range:0.02});
  const triggerIndex=680;
  const prev=m1[triggerIndex-1], t=m1[triggerIndex];
  m1[triggerIndex-1]={...prev,high:side==="LONG"?prev.close+0.002:prev.high,low:side==="SHORT"?prev.close-0.002:prev.low};
  const triggerClose=prev.close+sign*0.006;
  m1[triggerIndex]={...t,open:prev.close-sign*0.001,high:Math.max(triggerClose,prev.close)+0.005,low:Math.min(triggerClose,prev.close)-0.015,close:triggerClose};

  return {m1,m5,m15,setupTime:43*M15+1,now:Math.max(m1[triggerIndex].time+M1,m5[confirmIndex].time+M5,m15[44].time+M15)+1};
}

test("rejects invalid direction",()=>{
  assert.equal(evaluateShortTfConfirmation({side:"SIDEWAYS"}).status,"INVALID");
});

test("requires an explicit valid setup timestamp in Unix milliseconds",()=>{
  assert.equal(evaluateShortTfConfirmation({side:"LONG"}).reason,"INVALID_SETUP_TIME");
  assert.equal(evaluateShortTfConfirmation({side:"LONG",setupTime:Date.now()+1000}).reason,"INVALID_SETUP_TIME");
});

test("does not use candles that are still forming",()=>{
  const now=10*M1;
  const m1=trend(M1,50),m5=trend(M5,50),m15=trend(M15,50);
  const result=evaluateShortTfConfirmation({side:"LONG",candles1m:m1,candles5m:m5,candles15m:m15,setupTime:0,now});
  assert.equal(result.status,"WAIT");
  assert.equal(result.reason,"INSUFFICIENT_CLOSED_CANDLES");
});

test("requires enough fully closed history before confirming",()=>{
  const now=100*M1;
  const result=evaluateShortTfConfirmation({side:"LONG",candles1m:trend(M1,20),candles5m:trend(M5,20),candles15m:trend(M15,20),setupTime:0,now});
  assert.equal(result.reason,"INSUFFICIENT_CLOSED_CANDLES");
});

for (const side of ["LONG","SHORT"]) {
  test(`confirms the complete 15m → 5m → 1m sequence for ${side}`,()=>{
    const f=fixture(side);
    const result=evaluateShortTfConfirmation({side,candles1m:f.m1,candles5m:f.m5,candles15m:f.m15,setupTime:f.setupTime,now:f.now});
    assert.equal(result.status,"CONFIRMED",JSON.stringify(result));
    assert.equal(result.side,side);
    assert.equal(result.pullback15mTime,44*M15);
    assert.ok(result.confirmation5mTime>=45*M15);
    assert.ok(result.triggerTime>=result.confirmation5mTime+M5);
  });
}

test("does not accept a pullback candle that predates the signal setup",()=>{
  const f=fixture("LONG");
  const result=evaluateShortTfConfirmation({side:"LONG",candles1m:f.m1,candles5m:f.m5,candles15m:f.m15,setupTime:45*M15,now:f.now});
  assert.equal(result.reason,"NO_POST_SETUP_15M_CANDLES");
});

test("expires instead of chasing when live price drifts too far",()=>{
  const f=fixture("LONG");
  const first=evaluateShortTfConfirmation({side:"LONG",candles1m:f.m1,candles5m:f.m5,candles15m:f.m15,setupTime:f.setupTime,now:f.now});
  assert.equal(first.status,"CONFIRMED",JSON.stringify(first));
  const chased=evaluateShortTfConfirmation({side:"LONG",candles1m:f.m1,candles5m:f.m5,candles15m:f.m15,setupTime:f.setupTime,now:f.now,referencePrice:first.entryReference*1.01});
  assert.equal(chased.status,"EXPIRED");
  assert.equal(chased.reason,"ENTRY_TOO_FAR_NO_CHASE");
});

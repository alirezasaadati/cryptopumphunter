import test from "node:test";
import assert from "node:assert/strict";
import { evaluateShortTfConfirmation } from "../src/short-tf-confirmation.js";

function series(interval,count,base=100) {
  return Array.from({length:count},(_,i)=>{const close=base+i*0.04;return {time:i*interval,open:close-0.01,high:close+0.03,low:close-0.03,close,volume:100+i};});
}

test("rejects invalid direction",()=>{
  assert.equal(evaluateShortTfConfirmation({side:"SIDEWAYS"}).status,"INVALID");
});

test("does not use candles that are still forming",()=>{
  const now=10*60_000;
  const m1=series(60_000,50),m5=series(300_000,50),m15=series(900_000,50);
  const result=evaluateShortTfConfirmation({side:"LONG",candles1m:m1,candles5m:m5,candles15m:m15,now});
  assert.equal(result.status,"WAIT");
  assert.equal(result.reason,"INSUFFICIENT_CLOSED_CANDLES");
});

test("requires enough fully closed history before confirming",()=>{
  const now=100*60_000;
  const result=evaluateShortTfConfirmation({side:"LONG",candles1m:series(60_000,20),candles5m:series(300_000,20),candles15m:series(900_000,20),now});
  assert.equal(result.status,"WAIT");
  assert.equal(result.reason,"INSUFFICIENT_CLOSED_CANDLES");
});

import assert from "node:assert/strict";
import { ema, getFourHourConfirmation, getMtfAlignment } from "../src/channel-structure-mtf.js";

assert.equal(ema(Array.from({length:20},(_,i)=>i+1),20),10.5);
const candles4h=[{time:0,open:100,high:115,low:99,close:112}];
const longSignal={side:"LONG",channel:{upper:110,lower:90},channelType:"ASCENDING"};
const fourHour=getFourHourConfirmation(candles4h,longSignal,14400000);
assert.equal(fourHour.directional,true);
assert.equal(fourHour.outsideBoundary,true);
assert.equal(fourHour.closedAtSignal,true);
const candles1h=Array.from({length:25},(_,i)=>({close:100+i,open:99+i}));
const candles15m=[{open:120,close:121}];
const alignment=getMtfAlignment({signal:longSignal,candles1h,candles15m,fourHour});
assert.equal(alignment.allAligned,true);
const shortSignal={side:"SHORT",channel:{upper:110,lower:90},channelType:"DESCENDING"};
assert.equal(getFourHourConfirmation(candles4h,shortSignal,14400000).directional,false);
console.log("channel MTF helper tests passed");

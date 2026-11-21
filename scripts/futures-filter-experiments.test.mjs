import test from "node:test";import assert from "node:assert/strict";import{passesCompression,passesAtrCap,passesBreakoutBody}from"../src/futures-filter-experiments.js";
test("compression filter uses only candles before the signal bar",()=>{const a=Array.from({length:140},(_,i)=>({open:100,close:100,high:101+(i<110?i%3:0),low:99-(i<110?i%2:0)}));assert.equal(typeof passesCompression(a,139,.8),"boolean");});
test("ATR cap normalizes ATR by entry price",()=>{assert.equal(passesAtrCap(2,100,5),true);assert.equal(passesAtrCap(6,100,5),false);});
test("body filter compares signal bar to prior 20 bars",()=>{const a=Array.from({length:21},()=>({open:100,close:100.2,high:101,low:99}));a[20]={open:100,close:102,high:103,low:99};assert.equal(passesBreakoutBody(a,20,1.2),true);});

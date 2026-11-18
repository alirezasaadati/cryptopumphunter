import test from "node:test";
import assert from "node:assert/strict";
import { classifyMarket, classifySymbol1h, findEntry15m } from "../src/mtf-futures-engine.js";
function rising4h(n=100,base=100){return Array.from({length:n},(_,i)=>({time:i*14400000,open:base+i,high:base+i+1,low:base+i-.2,close:base+i+.7,volume:100}));}
function falling4h(n=100,base=200){return Array.from({length:n},(_,i)=>({time:i*14400000,open:base-i,high:base-i+.2,low:base-i-1,close:base-i-.7,volume:100}));}
function trend1h(n=100,base=100,up=true){let p=base;return Array.from({length:n},(_,i)=>{if(i)p+=up?(i%2?.6:-.4):(i%2?-.6:.4);return{time:i*3600000,open:p-.05,high:p+.2,low:p-.2,close:p,volume:100};});}
test("4H market regime requires BTC direction and at least 55% breadth",()=>{const m=classifyMarket(rising4h(),Array.from({length:10},()=>({candles:rising4h()})));assert.equal(m.regime,"BULL");assert.equal(m.bullish,10);});
test("4H market becomes mixed when BTC conflicts with breadth",()=>{const m=classifyMarket(rising4h(),Array.from({length:10},()=>({candles:falling4h()})));assert.notEqual(m.regime,"BULL");});
test("1H live-bot direction is constrained by market regime",()=>{assert.equal(classifySymbol1h(trend1h(), "BULL"),"LONG");assert.equal(classifySymbol1h(trend1h(100,200,false),"BULL"),null);});
test("15m live-bot plan uses fixed stop and 1.5R/2.5R/3.5R targets",()=>{const c=Array.from({length:50},(_,i)=>({time:i*900000,open:100+i*.1,high:101+i*.1,low:99+i*.1,close:100.5+i*.1,volume:100}));const p=findEntry15m(c,"LONG");assert.ok(p);assert.ok(p.stop<p.entry);assert.ok(Math.abs(p.target1-(p.entry+p.risk*1.5))<1e-9);assert.ok(Math.abs(p.target2-(p.entry+p.risk*2.5))<1e-9);assert.ok(Math.abs(p.target3-(p.entry+p.risk*3.5))<1e-9);});

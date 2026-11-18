import test from "node:test";
import assert from "node:assert/strict";
import { classifyMarket, classifySymbol1h, findEntry15m } from "../src/mtf-futures-engine.js";
function rising(n=100,base=100){return Array.from({length:n},(_,i)=>({time:i*900000,open:base+i,high:base+i+1,low:base+i-.2,close:base+i+.7,volume:100}));}
function falling(n=100,base=200){return Array.from({length:n},(_,i)=>({time:i*900000,open:base-i,high:base-i+.2,low:base-i-1,close:base-i-.7,volume:100}));}
test("market direction requires BTC agreement and 55 percent breadth",()=>{const m=classifyMarket(rising(),Array.from({length:10},()=>({candles:rising()})));assert.equal(m.regime,"BULL");assert.equal(m.bullish,10);});
test("market becomes mixed when BTC conflicts with breadth",()=>{const m=classifyMarket(rising(),Array.from({length:10},()=>({candles:falling()})));assert.equal(m.regime,"MIXED");});
test("1h symbol direction must agree with market regime",()=>{assert.equal(classifySymbol1h(rising(),"BULL"),"LONG");assert.equal(classifySymbol1h(falling(),"BULL"),null);});
test("15m entry rejects insufficient candle history",()=>{assert.equal(findEntry15m(rising(20),"LONG"),null);});

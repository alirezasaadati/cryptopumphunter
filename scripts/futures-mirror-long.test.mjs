import test from "node:test";
import assert from "node:assert/strict";
import {analyzeMirrorLongSymbol,MIRROR_LONG_ENGINE_VERSION} from "../src/futures-mirror-long.js";
const make=(n,ms,start,step)=>Array.from({length:n},(_,i)=>{const close=start+i*step;return{time:i*ms,open:close-step*.2,high:close+Math.abs(step)*.5,low:close-Math.abs(step)*.5,close,volume:100};});
test("mirror engine is independently versioned",()=>{assert.equal(MIRROR_LONG_ENGINE_VERSION,"1.0.0");});
test("rejects insufficient history safely",()=>{const r=analyzeMirrorLongSymbol({symbol:"T"},[],[],[]);assert.equal(r.side,"LONG");assert.ok(r.rejected);});
test("does not mutate input market data",()=>{const a=make(100,3600000,100,.3),b=make(100,14400000,100,.8),c=make(80,900000,100,.05),t={symbol:"T",last:a.at(-1).close,priceChangePercent:2,premium:{lastFundingRate:0}};const before=JSON.stringify([a,b,c,t]);analyzeMirrorLongSymbol(t,a,b,c,{skipBreakoutFilter:true});assert.equal(JSON.stringify([a,b,c,t]),before);});
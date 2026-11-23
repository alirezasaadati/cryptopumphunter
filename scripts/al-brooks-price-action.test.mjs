import test from "node:test";
import assert from "node:assert/strict";
import {BROOKS_CONFIG,analyzeBrooksPriceAction,atr,classifyBar,ema,marketContext} from "../src/al-brooks-price-action.js";

function series(count=100,trend=0.2){
 const a=[];let p=100;
 for(let i=0;i<count;i++){const o=p,c=o+trend+(i%7===0?-0.12:0.08),h=Math.max(o,c)+0.18,l=Math.min(o,c)-0.18;a.push({time:i*900000,open:o,high:h,low:l,close:c,volume:1000});p=c;}
 return a;
}
test("EMA and ATR return finite values on valid history",()=>{const c=series();assert.ok(Number.isFinite(ema(c.map(x=>x.close),20)));assert.ok(atr(c)>0);});
test("bar classification measures direction and close location",()=>{const b=classifyBar({open:10,high:12,low:9,close:11.8});assert.equal(b.direction,"BULL");assert.ok(b.closeLocation>0.9);assert.equal(b.strongBull,true);});
test("market context is explicit and does not infer trend from one candle",()=>{const c=marketContext(series());assert.ok(["BULL","BEAR","RANGE"].includes(c.trend));assert.ok(c.atr>0);});
test("engine rejects malformed or insufficient history",()=>{assert.equal(analyzeBrooksPriceAction([]),null);assert.equal(analyzeBrooksPriceAction(series(30)),null);});
test("config exposes conservative, explicit risk and target assumptions",()=>{assert.equal(BROOKS_CONFIG.targetR,1.5);assert.ok(BROOKS_CONFIG.minScore>=50);});

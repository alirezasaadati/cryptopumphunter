import test from "node:test";
import assert from "node:assert/strict";
import {detectFibIchimokuSignals,ichimokuAt,validateFibIchimokuCandles} from "../src/fibonacci-ichimoku-engine.js";
function bars(n=180){const a=[];let p=100;for(let i=0;i<n;i++){const drift=i<100?.12:i<125?-.08:.1;p+=drift+Math.sin(i/3)*.22;const o=p-.1,c=p+.1;a.push({time:i*900000,open:o,high:Math.max(o,c)+.25,low:Math.min(o,c)-.25,close:c});}return a;}
test("validates chronological OHLC data",()=>{const x=bars();assert.equal(validateFibIchimokuCandles(x),true);x[5].time=x[4].time;assert.equal(validateFibIchimokuCandles(x),false);});
test("Ichimoku cloud uses only data available at the candle",()=>{const x=bars(),i=130,v=ichimokuAt(x,i);assert.ok(v&&Number.isFinite(v.tenkan)&&Number.isFinite(v.kijun));const changed=x.slice();changed[131]={...changed[131],high:9999,low:1};assert.deepEqual(ichimokuAt(changed,i),v);});
test("does not emit signals before enough Ichimoku history exists",()=>{const x=bars(70);assert.deepEqual(detectFibIchimokuSignals(x),[]);});
test("signals have valid direction, fib levels and stop if produced",()=>{const x=bars(),s=detectFibIchimokuSignals(x);for(const q of s){assert.ok(["LONG","SHORT"].includes(q.side));assert.ok(q.fibRetracement>=.382&&q.fibRetracement<=.618);assert.ok(Number.isFinite(q.stop));assert.ok(q.signalIndex>=q.confirmedAt);}});
test("does not produce duplicate entries from one pullback pivot",()=>{const s=detectFibIchimokuSignals(bars());const ids=s.map(x=>x.setupPivotIndex+":"+x.side);assert.equal(new Set(ids).size,ids.length);});

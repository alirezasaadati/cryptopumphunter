import test from "node:test";
import assert from "node:assert/strict";
import { analyzeRabbitCorrection } from "../src/rabbit-engine.js";
function rising(count,slope,base,interval,volume=100){return Array.from({length:count},(_,i)=>{const close=base+i*slope,open=i?base+(i-1)*slope:close-slope*.5;return {time:i*interval,open,high:Math.max(open,close)+.05,low:Math.min(open,close)-.05,close,volume};});}
function setup(){
 const one=rising(120,.25,100,3600000),four=rising(120,1,100,14400000),fifteen=rising(100,.025,100,900000,100);
 for(let i=8;i>=2;i--){const ix=fifteen.length-i,prev=fifteen[ix-1].close,close=prev+.8;fifteen[ix]={...fifteen[ix],open:prev,high:close+.08,low:prev-.03,close,volume:180};}
 const p1=fifteen.at(-2).close,priorLow=Math.min(fifteen.at(-2).low,fifteen.at(-3).low),close=priorLow-1.0;
 fifteen[fifteen.length-1]={...fifteen.at(-1),open:p1+.02,high:p1+.1,low:close-.05,close,volume:220};
 return {candles1h:one,candles4h:four,candles15m:fifteen,price:close,btcRegime:{ok:true,longAllowed:true}};
}
test("Rabbit issues SHORT only after bull trend, extension and confirmed 15m breakdown",()=>{const r=analyzeRabbitCorrection(setup(),{minRsi15m:60});assert.equal(r.eligible,true,JSON.stringify(r));assert.equal(r.engine,"Rabbit");assert.equal(r.side,"SHORT");assert.ok(r.stop>r.entry);assert.ok(r.target1<r.entry);});
test("Rabbit refuses non-bullish 4h regime",()=>{const x=setup();x.candles4h=rising(120,-.5,180,14400000);const r=analyzeRabbitCorrection(x);assert.equal(r.eligible,false);assert.match(r.rejected,/صعودی هم‌جهت/);});
test("Rabbit refuses rally without bearish breakdown",()=>{const x=setup(),c=x.candles15m.at(-1);x.candles15m[x.candles15m.length-1]={...c,open:c.close-.2,close:c.close+.2,high:c.close+.25,low:c.close-.05};const r=analyzeRabbitCorrection(x);assert.equal(r.eligible,false);assert.match(r.rejected,/اصلاح هنوز تأیید نشده/);});
test("Rabbit rejects late entries with excessive drift",()=>{const x=setup();x.price*=1.03;const r=analyzeRabbitCorrection(x,{minRsi15m:60});assert.equal(r.eligible,false);assert.match(r.rejected,/بیش از حد فاصله/);});
test("Rabbit never treats overbought RSI alone as a short signal",()=>{const x=setup();x.candles15m=rising(100,.2,100,900000,200);const r=analyzeRabbitCorrection(x);assert.equal(r.eligible,false);});

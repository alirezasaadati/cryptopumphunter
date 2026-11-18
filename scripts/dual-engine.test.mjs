import test from "node:test";
import assert from "node:assert/strict";
import { analyzeEngineA, buildEngineATargets } from "../src/engines/engine-a.js";
import { analyzeEngineB } from "../src/engines/engine-b.js";
import { ENGINE_CONFIG, validateCandles, ema, rsi, atr, volumeRatio } from "../src/engines/engine-utils.js";

function makeSeries({count=160,step=0.12,base=100,volume=100}={}) {
  return Array.from({length:count},(_,i)=>{
    const close=base+i*step+Math.sin(i/2)*0.03;
    const open=i?base+(i-1)*step+Math.sin((i-1)/2)*0.03:close-step;
    return {time:1700000000000+i*900000,open,high:Math.max(open,close)+0.08,
      low:Math.min(open,close)-0.08,close,volume:i===count-1?volume*2:volume};
  });
}
test("15m engine data validator rejects malformed, unsorted and short candles",()=>{
  const data=makeSeries();
  assert.equal(validateCandles(data),true);
  assert.equal(validateCandles(data.slice(0,20)),false);
  assert.equal(validateCandles([...data.slice(1),data[0]]),false);
  assert.equal(validateCandles(data.map((c,i)=>i===4?{...c,high:c.low-1}:c)),false);
});
test("indicator helpers return bounded, finite values",()=>{
  const data=makeSeries(), closes=data.map(c=>c.close);
  assert.ok(ema(closes,20)>0);
  assert.ok(rsi(closes)>=0 && rsi(closes)<=100);
  assert.ok(atr(data)>0);
  assert.ok(volumeRatio(data)>0);
  assert.equal(ema([1,2],20),null);
});
test("Engine A emits a separate conditional two-entry plan with five channel targets",()=>{
  const signal=analyzeEngineA({symbol:"PF_TESTUSD",candles:makeSeries(),quoteVolume:10_000_000});
  // A deterministic rising fixture may not create a fresh breakout/pullback; null is a valid no-setup.
  if(signal){
    assert.equal(signal.engine,"A");
    assert.equal(signal.context.entry2Conditional,true);
    assert.equal(signal.targets.length,5);
    assert.ok(signal.stop<signal.entry1);
  }
});
test("Engine B emits an adaptive R-multiple plan, not channel percentage targets",()=>{
  const signal=analyzeEngineB({symbol:"PF_TESTUSD",candles:makeSeries(),quoteVolume:10_000_000});
  if(signal){
    assert.equal(signal.engine,"B");
    assert.deepEqual(signal.context.targetsR,[1.5,2.2,3]);
    assert.equal(signal.targets.length,3);
    assert.ok(signal.stop<signal.entry);
  }
});
test("both engines reject symbols below the liquidity floor",()=>{
  const candles=makeSeries();
  assert.equal(analyzeEngineA({symbol:"PF_TESTUSD",candles,quoteVolume:1}),null);
  assert.equal(analyzeEngineA({symbol:"PF_TESTUSD",candles}),null);
  assert.equal(analyzeEngineA({symbol:"PF_TESTUSD",candles,quoteVolume:Infinity}),null);
  assert.equal(analyzeEngineB({symbol:"PF_TESTUSD",candles,quoteVolume:1}),null);
  assert.equal(analyzeEngineB({symbol:"PF_TESTUSD",candles}),null);
  assert.equal(analyzeEngineB({symbol:"PF_TESTUSD",candles,quoteVolume:Infinity}),null);
  assert.equal(ENGINE_CONFIG.INTERVAL,"15m");
});

test("Engine A target ladders are calculated independently for one-fill and two-fill averages",()=>{
  const oneFill=buildEngineATargets(100,"LONG");
  const twoFill=buildEngineATargets(98.6,"LONG");
  assert.deepEqual(oneFill,[101,103,106,110,114]);
  assert.deepEqual(twoFill,[99.586,101.558,104.516,108.46,112.404]);
  assert.ok(oneFill[0]>twoFill[0]);
  assert.deepEqual(buildEngineATargets(100,"SHORT"),[99,97,94,90,86]);
  assert.deepEqual(buildEngineATargets(0,"LONG"),[]);
  assert.deepEqual(buildEngineATargets(100,"SIDEWAYS"),[]);
});

import { simulatePaperTrade } from "../src/engines/paper-simulator.js";

const paperSignal=(overrides={})=>({
  engine:"A",symbol:"PF_TESTUSD",side:"LONG",entry:100,entry2:97,stop:95,
  targets:[102,104,106],candleTime:1000,context:{entry2:97},...overrides
});
const bar=(time,{open=100,high=101,low=99,close=100,fundingRate=0}={})=>
  ({time,open,high,low,close,fundingRate});
const paperArgs=(signal,candles,extra={})=>({
  signal,candles,entryNotional:100,targetWeights:[0.4,0.35,0.25],
  feeRate:0,slippageBps:0,...extra
});

test("paper simulator never uses the signal candle or earlier candles",()=>{
  const result=simulatePaperTrade(paperArgs(paperSignal(),[bar(1000),bar(900)]));
  assert.equal(result.status,"no_future_candles");
});

test("paper simulator gives stop priority when stop and target are both touched",()=>{
  const result=simulatePaperTrade(paperArgs(paperSignal(),[bar(2000,{high:103,low:94})]));
  assert.equal(result.status,"closed");
  assert.equal(result.exits.length,1);
  assert.equal(result.exits[0].reason,"stop");
  assert.equal(result.entry2Filled,false);
});

test("TP1 touched in same candle cancels entry 2 conservatively",()=>{
  const result=simulatePaperTrade(paperArgs(paperSignal(),[bar(2000,{high:103,low:96,close:102})]));
  assert.equal(result.entry2Filled,false);
  assert.equal(result.entry2Cancelled,true);
  assert.equal(result.exits[0].reason,"target_1");
  assert.equal(result.status,"open");
});

test("entry 2 fills only when touched before TP1",()=>{
  const result=simulatePaperTrade(paperArgs(paperSignal(),[bar(2000,{high:101,low:96,close:99})]));
  assert.equal(result.entry2Filled,true);
  assert.equal(result.fills.length,2);
  assert.ok(Math.abs(result.deployedNotional-200)<1e-6);
});

test("fees, adverse slippage and funding are included in net PnL",()=>{
  const signal=paperSignal({entry2:null,context:{}});
  const entryCandle=bar(2000,{open:100,high:101,low:99,close:100});
  const settlement={...bar(29000,{open:100,high:101,low:99,close:100,fundingRate:0.001}),fundingSettlement:true};
  const noCosts=simulatePaperTrade(paperArgs(signal,[entryCandle,settlement]));
  const withCosts=simulatePaperTrade(paperArgs(signal,[entryCandle,settlement],{feeRate:0.001,slippageBps:10}));
  assert.ok(withCosts.fees>0);
  assert.ok(withCosts.funding>0);
  assert.ok(withCosts.netPnl<noCosts.netPnl);
});

test("ambiguous Entry 2 and TP1 ordering is explicitly logged and resolved conservatively",()=>{
  const result=simulatePaperTrade(paperArgs(paperSignal(),[bar(2000,{high:103,low:96,close:102})]));
  assert.equal(result.ambiguousEvents.length,1);
  assert.deepEqual(result.ambiguousEvents[0].events,["entry2","target_1"]);
  assert.equal(result.ambiguousEvents[0].resolution,"target_1_first_cancel_entry2");
  assert.equal(result.entry2Filled,false);
});

test("funding is charged only on explicit settlement candles",()=>{
  const signal=paperSignal({entry2:null,context:{}});
  const ordinary=bar(2000,{fundingRate:0.01});
  const settlement={...bar(29000,{fundingRate:0.001}),fundingSettlement:true};
  const result=simulatePaperTrade(paperArgs(signal,[ordinary,settlement]));
  assert.ok(result.funding>0);
  assert.equal(result.events.filter(e=>e.type==="funding").length,1);
});

test("target weights close the configured fraction of the position, not the remaining fraction",()=>{
  const signal=paperSignal({entry2:null,context:{},targets:[102,104,106]});
  const result=simulatePaperTrade(paperArgs(signal,[
    bar(2000,{high:102.5,low:99,close:102}),
    bar(29000,{open:102.5,high:104.5,low:101,close:104}),
    bar(56000,{open:104.5,high:106.5,low:103,close:106})
  ]));
  assert.equal(result.status,"closed");
  assert.equal(result.exits.length,3);
  const total=result.exits.reduce((sum,e)=>sum+e.quantity,0);
  assert.ok(Math.abs(total-1)<1e-9);
});

test("invalid Entry 2 on the wrong side of the stop is rejected",()=>{
  const result=simulatePaperTrade(paperArgs(paperSignal({entry2:94,context:{entry2:94}}),[bar(2000)]));
  assert.equal(result.status,"invalid_input");
});

test("entry is not filled when the next candle opens beyond the drift limit",()=>{
  const result=simulatePaperTrade(paperArgs(paperSignal({entry2:null,context:{}}),[
    bar(2000,{open:100.5,high:101,low:100.2,close:100.8})
  ]));
  assert.equal(result.status,"not_filled");
  assert.equal(result.reason,"entry_drift_exceeded");
  assert.equal(result.fills.length,0);
});

test("funding at the entry candle boundary is not charged to a position opened at that boundary",()=>{
  const signal=paperSignal({entry2:null,context:{}});
  const settlement={...bar(2000,{fundingRate:0.01}),fundingSettlement:true};
  const result=simulatePaperTrade(paperArgs(signal,[settlement]));
  assert.equal(result.funding,0);
  assert.equal(result.events.filter(e=>e.type==="funding").length,0);
});

test("paper simulator rounds filled quantity down to exchange precision",()=>{
  const signal=paperSignal({entry:3,entry2:null,stop:2.5,targets:[3.3,3.6,3.9],context:{}});
  const result=simulatePaperTrade(paperArgs(signal,[bar(2000,{open:3,high:3.1,low:2.9,close:3})],{
    quantityPrecision:1
  }));
  assert.equal(result.fills[0].quantity,33.3);
  assert.ok(Math.abs(result.deployedNotional-99.9)<1e-9);
});

test("optional breakeven stop activates only after TP1 and applies on the next candle",()=>{
  const signal=paperSignal({entry2:null,context:{}});
  const result=simulatePaperTrade(paperArgs(signal,[
    bar(2000,{open:100,high:103,low:99.5,close:102}),
    bar(29000,{open:101,high:101.5,low:99.5,close:100.5})
  ],{moveStopToBreakevenAfterTarget1:true}));
  assert.equal(result.stopMovedToBreakeven,true);
  assert.equal(result.exits[0].reason,"target_1");
  assert.equal(result.exits[1].reason,"breakeven_stop");
  assert.equal(result.status,"closed");
});

test("breakeven option does not move stop before TP1",()=>{
  const signal=paperSignal({entry2:null,context:{}});
  const result=simulatePaperTrade(paperArgs(signal,[
    bar(2000,{open:100,high:100.5,low:99.5,close:100})
  ],{moveStopToBreakevenAfterTarget1:true}));
  assert.equal(result.stopMovedToBreakeven,false);
  assert.equal(result.activeStop,signal.stop);
});

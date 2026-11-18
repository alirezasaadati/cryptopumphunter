import test from "node:test";
import assert from "node:assert/strict";
import {
  PA_CONFIG, validateCandles, findSwings, describeStructure, analyzePriceAction, resolvePriceActionSignals, calculateATR, volumeConfirmed
} from "../src/price-action-engine.js";

function flatCandles(n=100, price=100, step=900000) {
  return Array.from({length:n},(_,i)=>({
    time:i*step, open:price, high:price+0.2, low:price-0.2, close:price, volume:100
  }));
}

function structuralCandles({breakout=false}={}) {
  const data=flatCandles(40,100,3600000);
  const set=(i,{open=100,high=100.2,low=99.8,close=100}={})=>{
    data[i]={time:i*3600000,open,high,low,close,volume:100};
  };
  // Three confirmed pivot highs and lows: HH + HL structure.
  set(10,{open:100,high:101,low:99.9,close:100.4});
  set(15,{open:99.8,high:100.1,low:99,close:100});
  set(20,{open:100,high:100.8,low:99.9,close:100.3});
  set(25,{open:99.9,high:100.1,low:99.2,close:100});
  set(30,{open:100,high:101.2,low:99.9,close:100.5});
  set(35,{open:99.9,high:100.1,low:99.4,close:100});
  set(38,{open:100.8,high:101.1,low:100.6,close:breakout?101.1:101});
  set(39,{open:breakout?101.4:101,high:breakout?101.8:101.5,low:100.9,close:breakout?101.6:101.4});
  return data;
}

function triggerCandles(last, previous={open:100,high:100.1,low:99.9,close:100}) {
  const data=flatCandles(40,100,900000);
  data[38]={time:38*900000,...previous,volume:100};
  data[39]={time:39*900000,...last,volume:100};
  return data;
}
const fourHour=flatCandles(40,100,14400000);

test("validates OHLC data and rejects malformed or non-finite candles",()=>{
  assert.equal(validateCandles(flatCandles(50)),true);
  const bad=flatCandles(50); bad[3].low=999;
  assert.equal(validateCandles(bad),false);
  const missingTime=flatCandles(50); delete missingTime[4].time;
  assert.equal(validateCandles(missingTime),false);
  const nonFinite=flatCandles(50); nonFinite[5].close=Number.NaN;
  assert.equal(validateCandles(nonFinite),false);
});

test("finds confirmed swing highs and lows at the expected indexes",()=>{
  const data=[
    {time:0,open:5,high:6,low:4,close:5},
    {time:1,open:5,high:7,low:4.5,close:6},
    {time:2,open:6,high:10,low:5,close:7},
    {time:3,open:7,high:8,low:3,close:5},
    {time:4,open:5,high:7,low:4,close:6},
    {time:5,open:6,high:7,low:4,close:6},
    {time:6,open:6,high:7,low:4,close:6}
  ];
  const s=findSwings(data,2,2);
  assert.deepEqual(s.highs.map(x=>x.index),[2]);
  assert.deepEqual(s.lows.map(x=>x.index),[3]);
});

test("classifies an explicitly constructed higher-high / higher-low structure as bullish",()=>{
  const s=describeStructure(structuralCandles());
  assert.equal(s.direction,"BULLISH");
  assert.equal(s.higherHigh,true);
  assert.equal(s.higherLow,true);
});

test("market-structure strategy emits a confirmed LONG after a 1H swing-high break",()=>{
  const oneHour=structuralCandles();
  const fifteenMin=triggerCandles({open:101.1,high:101.6,low:101,close:101.4});
  const result=analyzePriceAction({symbol:"PF_TESTUSD",oneHour,fourHour,fifteenMin,livePrice:101.4});
  assert.ok(result.signals.some(s=>s.strategyId==="market_structure"&&s.side==="LONG"),JSON.stringify(result));
});

test("support rejection strategy recognizes a bullish rejection candle",()=>{
  const oneHour=structuralCandles();
  const fifteenMin=triggerCandles({open:99.8,high:100.05,low:99.4,close:99.9});
  const result=analyzePriceAction({symbol:"PF_TESTUSD",oneHour,fourHour,fifteenMin,livePrice:99.9});
  assert.ok(result.signals.some(s=>s.strategyId==="sr_rejection"&&s.side==="LONG"),JSON.stringify(result));
});

test("breakout-and-retest strategy recognizes a successful bullish retest",()=>{
  const oneHour=structuralCandles({breakout:true});
  const fifteenMin=triggerCandles({open:101.25,high:101.55,low:101.1,close:101.4});
  const result=analyzePriceAction({symbol:"PF_TESTUSD",oneHour,fourHour,fifteenMin,livePrice:101.4});
  assert.ok(result.signals.some(s=>s.strategyId==="breakout_retest"&&s.side==="LONG"),JSON.stringify(result));
});

test("candlestick strategy recognizes a bullish pin bar at structural support",()=>{
  const oneHour=structuralCandles();
  const fifteenMin=triggerCandles({open:99.8,high:100,low:99.4,close:99.9});
  const result=analyzePriceAction({symbol:"PF_TESTUSD",oneHour,fourHour,fifteenMin,livePrice:99.9});
  assert.ok(result.signals.some(s=>s.strategyId==="candlestick"&&s.side==="LONG"),JSON.stringify(result));
});

test("rejects insufficient history before strategy evaluation",()=>{
  const result=analyzePriceAction({
    symbol:"PF_TESTUSD",oneHour:flatCandles(20),fourHour:flatCandles(20),
    fifteenMin:flatCandles(20),livePrice:100
  });
  assert.deepEqual(result.signals,[]);
  assert.ok(result.rejected);
});

test("rejects entries that have drifted beyond the configured late-entry limit",()=>{
  const oneHour=structuralCandles();
  const fifteenMin=triggerCandles({open:101.1,high:101.6,low:101,close:101.4});
  const result=analyzePriceAction({symbol:"PF_TESTUSD",oneHour,fourHour,fifteenMin,livePrice:102});
  assert.deepEqual(result.signals,[]);
  assert.equal(PA_CONFIG.MIN_SCORE,80);
});

test("every emitted plan has correctly ordered risk and reward levels",()=>{
  const oneHour=structuralCandles();
  const fifteenMin=triggerCandles({open:99.8,high:100.05,low:99.4,close:99.9});
  const result=analyzePriceAction({symbol:"PF_TESTUSD",oneHour,fourHour,fifteenMin,livePrice:99.9});
  for (const signal of result.signals) {
    assert.ok(signal.entry>0 && signal.stop>0);
    if(signal.side==="LONG") {
      assert.ok(signal.stop<signal.entry);
      assert.ok(signal.target1>signal.entry && signal.target2>signal.target1 && signal.target3>signal.target2);
    } else {
      assert.ok(signal.stop>signal.entry);
      assert.ok(signal.target1<signal.entry && signal.target2<signal.target1 && signal.target3<signal.target2);
    }
    assert.equal(signal.timeframes.join(","),"4h,1h,15m");
  }
});


function mirrorCandles(data) {
  return data.map(c=>({
    ...c, open:200-c.open, high:200-c.low, low:200-c.high, close:200-c.close
  }));
}

test("market-structure strategy emits a confirmed SHORT after a 1H swing-low break",()=>{
  const oneHour=mirrorCandles(structuralCandles());
  const fifteenMin=mirrorCandles(triggerCandles({open:101.1,high:101.6,low:101,close:101.4}));
  const result=analyzePriceAction({symbol:"PF_TESTUSD",oneHour,fourHour,fifteenMin,livePrice:98.6});
  assert.ok(result.signals.some(s=>s.strategyId==="market_structure"&&s.side==="SHORT"),JSON.stringify(result));
});

test("resistance rejection strategy recognizes a bearish rejection candle",()=>{
  const oneHour=mirrorCandles(structuralCandles());
  const fifteenMin=mirrorCandles(triggerCandles({open:99.8,high:100.05,low:99.4,close:99.9}));
  const result=analyzePriceAction({symbol:"PF_TESTUSD",oneHour,fourHour,fifteenMin,livePrice:100.1});
  assert.ok(result.signals.some(s=>s.strategyId==="sr_rejection"&&s.side==="SHORT"),JSON.stringify(result));
});

test("breakout-and-retest strategy recognizes a successful bearish retest",()=>{
  const oneHour=mirrorCandles(structuralCandles({breakout:true}));
  const fifteenMin=mirrorCandles(triggerCandles({open:101.25,high:101.55,low:101.1,close:101.4}));
  const result=analyzePriceAction({symbol:"PF_TESTUSD",oneHour,fourHour,fifteenMin,livePrice:98.6});
  assert.ok(result.signals.some(s=>s.strategyId==="breakout_retest"&&s.side==="SHORT"),JSON.stringify(result));
});

test("candlestick strategy recognizes a bearish pin bar at structural resistance",()=>{
  const oneHour=mirrorCandles(structuralCandles());
  const fifteenMin=mirrorCandles(triggerCandles({open:99.8,high:100,low:99.4,close:99.9}));
  const result=analyzePriceAction({symbol:"PF_TESTUSD",oneHour,fourHour,fifteenMin,livePrice:100.1});
  assert.ok(result.signals.some(s=>s.strategyId==="candlestick"&&s.side==="SHORT"),JSON.stringify(result));
});

test("rejects candles whose timestamps are duplicated or out of order",()=>{
  const duplicate=flatCandles(50); duplicate[20].time=duplicate[19].time;
  assert.equal(validateCandles(duplicate),false);
  const reversed=flatCandles(50); reversed[25].time=reversed[24].time-1;
  assert.equal(validateCandles(reversed),false);
});

test("blocks a continuation signal against a confirmed opposing 4H trend",()=>{
  const oneHour=structuralCandles();
  const fifteenMin=triggerCandles({open:101.1,high:101.6,low:101,close:101.4});
  const bearishFourHour=mirrorCandles(structuralCandles());
  const result=analyzePriceAction({symbol:"PF_TESTUSD",oneHour,fourHour:bearishFourHour,fifteenMin,livePrice:101.4});
  assert.deepEqual(result.signals,[]);
  assert.ok(result.diagnostics.some(x=>x.status==="direction_conflict"),JSON.stringify(result));
});

test("allows a strong 1H-confirmed support reversal against the 4H trend",()=>{
  const oneHour=structuralCandles();
  const fifteenMin=triggerCandles(
    {open:99.8,high:100.05,low:99.4,close:99.9},
    {open:99.9,high:100.05,low:99.8,close:100}
  );
  const bearishFourHour=mirrorCandles(structuralCandles());
  const result=analyzePriceAction({symbol:"PF_TESTUSD",oneHour,fourHour:bearishFourHour,fifteenMin,livePrice:99.9});
  assert.ok(result.signals.some(s=>s.strategyId==="sr_rejection"&&s.side==="LONG"&&s.score>=90),JSON.stringify(result));
});

test("suppresses a symbol when qualified LONG and SHORT strategies conflict",()=>{
  const result=resolvePriceActionSignals([
    {side:"LONG",entry:100,score:82,strategyId:"market_structure"},
    {side:"SHORT",entry:100.1,score:88,strategyId:"sr_rejection"}
  ],100.05);
  assert.equal(result.conflict,true);
  assert.deepEqual(result.signals,[]);
  assert.equal(result.candidates.length,2);
});

test("late-entry filtering happens before conflict resolution",()=>{
  const result=resolvePriceActionSignals([
    {side:"LONG",entry:100,score:82,strategyId:"market_structure"},
    {side:"SHORT",entry:101,score:88,strategyId:"sr_rejection"}
  ],100.05);
  assert.equal(result.conflict,false);
  assert.equal(result.signals.length,1);
  assert.equal(result.signals[0].side,"LONG");
});

test("isolated strategy mode evaluates only the requested Price Action strategy",()=>{
  const oneHour=structuralCandles();
  const fifteenMin=triggerCandles({open:101.1,high:101.6,low:101,close:101.4});
  const result=analyzePriceAction({
    symbol:"PF_TESTUSD",oneHour,fourHour,fifteenMin,livePrice:101.4,
    strategyIds:["market_structure"]
  });
  assert.deepEqual(result.diagnostics.map(x=>x.strategyId),["market_structure"]);
  assert.ok(result.signals.length>0);
  assert.ok(result.signals.every(x=>x.strategyId==="market_structure"));
});


test("Wilder ATR returns a positive smoothed true range",()=>{
  const data=flatCandles(30,100);
  assert.ok(calculateATR(data,14)>0);
  assert.equal(calculateATR(data,40),null);
});

test("volume confirmation rejects materially weak trigger volume but allows unavailable volume",()=>{
  const data=flatCandles(25,100);
  data[24].volume=50;
  assert.equal(volumeConfirmed(data),false);
  data[24].volume=100;
  assert.equal(volumeConfirmed(data),true);
  data.forEach(c=>{delete c.volume;});
  assert.equal(volumeConfirmed(data),true);
});

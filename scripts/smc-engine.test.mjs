import test from "node:test";
import assert from "node:assert/strict";
import { simulate, getBacktestWindow } from "./backtest-smc-comparison.mjs";
import {
  SMC_CONFIG, validateSMCCandles, findConfirmedSMCSwings,
  detectLiquiditySweep, findFairValueGaps, findOrderBlock,
  calculatePremiumDiscount, analyzeSMC
} from "../src/smc-engine.js";

function flatCandles(n=50,price=100,step=900000) {
  return Array.from({length:n},(_,i)=>({
    time:i*step,open:price,high:price+0.2,low:price-0.2,close:price,volume:100
  }));
}

test("validates SMC OHLC data and rejects invalid timestamps or ranges",()=>{
  assert.equal(validateSMCCandles(flatCandles()),true);
  const bad=flatCandles(); bad[4].low=999;
  assert.equal(validateSMCCandles(bad),false);
  const unordered=flatCandles(); unordered[5].time=unordered[4].time;
  assert.equal(validateSMCCandles(unordered),false);
});

test("finds only confirmed swing highs and lows",()=>{
  const candles=[
    {time:0,open:5,high:6,low:4,close:5},
    {time:1,open:5,high:7,low:4.5,close:6},
    {time:2,open:6,high:10,low:5,close:7},
    {time:3,open:7,high:8,low:3,close:5},
    {time:4,open:5,high:7,low:4,close:6},
    {time:5,open:6,high:7,low:4,close:6},
    {time:6,open:6,high:7,low:4,close:6}
  ];
  const swings=findConfirmedSMCSwings(candles,2,2);
  assert.deepEqual(swings.highs.map(x=>x.index),[2]);
  assert.deepEqual(swings.lows.map(x=>x.index),[3]);
});

test("detects a sell-side liquidity sweep only after price reclaims the swing low",()=>{
  const candles=flatCandles(20,100);
  candles[10]={time:10*900000,open:100,high:100.2,low:98,close:99.8,volume:100};
  candles[15]={time:15*900000,open:99.7,high:100,low:97.5,close:99.6,volume:100};
  candles[16]={time:16*900000,open:99.6,high:100,low:99.4,close:99.8,volume:100};
  const sweep=detectLiquiditySweep(candles,"LONG");
  assert.ok(sweep);
  assert.equal(sweep.index,15);
  assert.equal(sweep.level,98);
  assert.equal(sweep.reclaimed,true);
});

test("does not classify a break-and-hold below liquidity as a sweep",()=>{
  const candles=flatCandles(20,100);
  candles[10]={time:10*900000,open:100,high:100.2,low:98,close:99.8,volume:100};
  candles[15]={time:15*900000,open:98.1,high:98.2,low:97.5,close:97.7,volume:100};
  candles[16]={time:16*900000,open:97.7,high:97.9,low:97.4,close:97.6,volume:100};
  assert.equal(detectLiquiditySweep(candles,"LONG"),null);
});

test("detects bullish and bearish three-candle fair value gaps",()=>{
  const bullishGap=flatCandles(5,100);
  bullishGap[0].high=101;
  bullishGap[2]={time:1800000,open:102.2,high:103,low:102,close:102.8,volume:100};
  const up=findFairValueGaps(bullishGap,"LONG");
  assert.ok(up.some(x=>x.lower===101&&x.upper===102));

  const bearishGap=flatCandles(5,100);
  bearishGap[0].low=99;
  bearishGap[2]={time:1800000,open:97.8,high:98,low:97,close:97.2,volume:100};
  const down=findFairValueGaps(bearishGap,"SHORT");
  assert.ok(down.some(x=>x.lower===98&&x.upper===99));
});

test("finds the last opposing candle as a candidate order block",()=>{
  const candles=flatCandles(8,100);
  candles[5]={time:4500000,open:100.5,high:101,low:99.5,close:99.7,volume:100};
  const ob=findOrderBlock(candles,"LONG",7,4);
  assert.equal(ob.index,5);
  assert.equal(ob.low,99.5);
  assert.equal(ob.high,101);
});

test("classifies premium and discount around the dealing-range equilibrium",()=>{
  const candles=flatCandles(10,100);
  candles[0].low=90;
  candles[1].high=110;
  assert.equal(calculatePremiumDiscount(candles,95).zone,"DISCOUNT");
  assert.equal(calculatePremiumDiscount(candles,105).zone,"PREMIUM");
  assert.equal(calculatePremiumDiscount(candles,100).zone,"PREMIUM");
});

test("does not emit signals when multi-timeframe closed-candle history is insufficient",()=>{
  const result=analyzeSMC({
    symbol:"PF_TESTUSD",
    oneHour:flatCandles(20,100,3600000),
    fourHour:flatCandles(20,100,14400000),
    fifteenMin:flatCandles(20,100,900000),
    livePrice:100
  });
  assert.deepEqual(result.signals,[]);
  assert.ok(result.rejected);
});

test("SMC configuration uses structure/liquidity/FVG logic and fixed staged R targets",()=>{
  assert.equal(SMC_CONFIG.MIN_SCORE,80);
  assert.deepEqual(SMC_CONFIG.TARGET_R_MULTIPLES,[1.5,2.2,3]);
  assert.equal(SMC_CONFIG.SWEEP_LOOKBACK,8);
});


test("backtest simulator executes each partial target only once",()=>{
  const trade=simulate({side:"LONG",entry:100,stop:99,risk:1,targets:[101.5,102.2,103]},[
    {time:900000,open:100,high:101.6,low:99.8,close:101.4},
    {time:1800000,open:101.4,high:101.6,low:100.5,close:101}
  ],0);
  assert.equal(trade.targetHits,1);
  assert.equal(trade.exitReason,"TIME_EXIT");
  assert.ok(trade.netR>0.9 && trade.netR<1.2);
});


test("backtest evaluation excludes warmup and splits exactly 70/30",()=>{
  const now=Date.UTC(2026,10,17);
  const window=getBacktestWindow(now,90,20);
  const day=24*3600000;
  assert.equal(window.evaluationEnd,now);
  assert.equal(window.evaluationStart,now-90*day);
  assert.equal(window.from,now-110*day);
  assert.equal(window.splitTime,now-27*day);
  assert.equal(window.evaluationStart-window.from,20*day);
});

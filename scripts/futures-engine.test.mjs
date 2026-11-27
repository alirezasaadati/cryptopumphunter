import test from "node:test";
import assert from "node:assert/strict";
import {
  FUTURES_CONFIG,
  SignalDeliveryCoordinator,
  isKrakenPerpetualTicker,
  calculateAtr,
  evaluateFuturesEntryFilters,
  analyzeFuturesSymbol,
  getKrakenFuturesCandles,
  getKrakenFuturesUniverse,
  mapLimit
} from "../src/index.js";

function makeCandles({count=120,slope=0.015,base=100,volume=100}={}) {
  const closes=Array.from({length:count},(_,i)=>base+i*slope+(i%2?0.12:-0.12));
  return closes.map((close,i)=>{
    const open=i?closes[i-1]:close-0.1;
    const last=i===count-1;
    return {
      time:Date.now()-(count-i)*60*60*1000,
      open,
      high:last?close+0.05:Math.max(open,close)+0.08,
      low:last?open-0.05:Math.min(open,close)-0.08,
      close,
      volume:last?volume*2:volume
    };
  });
}

function testEma(values,period) {
  const multiplier=2/(period+1);
  let value=values.slice(0,period).reduce((a,b)=>a+b,0)/period;
  for(let i=period;i<values.length;i++)value=values[i]*multiplier+value*(1-multiplier);
  return value;
}

function makeSetup(side="LONG") {
  const direction=side==="LONG"?1:-1;
  const oneHour=makeCandles({slope:0.015*direction,base:100});
  const fourHour=makeCandles({slope:0.04*direction,base:100});
  const fifteenMinute=makeCandles({count:120,slope:0.004*direction,base:oneHour.at(-1).close-0.8*direction,volume:100});
  const closes=fifteenMinute.map(c=>c.close);
  const ema21=closes.slice(-21).reduce((a,b)=>a+b,0)/21;
  for(const c of fifteenMinute.slice(-9,-1)){
    if(direction>0)c.low=Math.min(c.low,ema21-0.1);
    else c.high=Math.max(c.high,ema21+0.1);
  }
  const last15=fifteenMinute.at(-1);
  last15.open=last15.close-0.05*direction;
  last15.close=oneHour.at(-1).close;
  const previous15=fifteenMinute.at(-2);
  if(direction>0)previous15.high=Math.min(previous15.high,last15.close-0.002);
  else previous15.low=Math.max(previous15.low,last15.close+0.002);
  last15.high=Math.max(last15.high,last15.close+0.05);
  last15.low=Math.min(last15.low,last15.open-0.05);
  return {
    ticker:{
      symbol:"PF_TESTUSD",last:oneHour.at(-1).close,quoteVolume:12_000_000,
      priceChangePercent:2*direction,premium:{lastFundingRate:0.0001*direction}
    },
    oneHour,fourHour,fifteenMinute
  };
}

test("admin signal listing returns recent unexpired signals from Durable Object without writes",async()=>{
  const now=Date.now();
  const stored=[
    {id:"old",symbol:"PF_OLDUSD",side:"SHORT",score:80,createdAt:now-5000,expiresAt:now+60000},
    {id:"new",symbol:"PF_NEWUSD",side:"LONG",score:91,createdAt:now-1000,expiresAt:now+60000},
    {id:"expired",symbol:"PF_EXPIREDUSD",side:"SHORT",score:99,createdAt:now,expiresAt:now-1}
  ];
  const writes=[];
  const ctx={storage:{
    get:async key=>key==="active-futures-pending"?stored:undefined,
    put:async(...args)=>writes.push(args),
    delete:async()=>{}
  }};
  const env={SIGNAL_DELIVERY_AUTH_SECRET:"test-secret"};
  const coordinator=new SignalDeliveryCoordinator(ctx,env);
  const response=await coordinator.fetch(new Request("https://signal-delivery.internal/signals/list",{
    method:"POST",
    headers:{"content-type":"application/json","x-signal-delivery-secret":"test-secret"},
    body:JSON.stringify({limit:10})
  }));
  const result=await response.json();
  assert.equal(response.status,200);
  assert.deepEqual(result.signals.map(x=>x.id),["new","old"]);
  assert.equal(result.signals[0].score,91);
  assert.equal(writes.length,0);
});

test("Durable Object supplies the 60-minute expiry when a new signal omits expiresAt",async()=>{
  const state=new Map([["active-futures-pending",[]],["active-futures-trades",[]]]);
  const ctx={storage:{
    get:async key=>state.get(key),
    put:async(key,value)=>state.set(key,value),
    delete:async key=>state.delete(key),
    transaction:async callback=>{
      const draft=new Map(state);
      const tx={get:async key=>draft.get(key),put:async(key,value)=>draft.set(key,value),delete:async key=>draft.delete(key)};
      const result=await callback(tx);
      state.clear();for(const [key,value] of draft)state.set(key,value);
      return result;
    }
  }};
  const coordinator=new SignalDeliveryCoordinator(ctx,{SIGNAL_DELIVERY_AUTH_SECRET:"test-secret"});
  const now=Date.now();
  const signal={id:"missing-expiry",symbol:"PF_TESTUSD",side:"LONG",entry:100,stop:98,target1:103,target2:105,target3:107,score:68,createdAt:now};
  const response=await coordinator.fetch(new Request("https://signal-delivery.internal/signals/register",{
    method:"POST",headers:{"content-type":"application/json","x-signal-delivery-secret":"test-secret"},
    body:JSON.stringify({signals:[signal]})
  }));
  const result=await response.json();
  assert.equal(response.status,200);
  assert.equal(result.signals.length,1);
  assert.ok(result.signals[0].expiresAt>now);
  assert.ok(result.signals[0].expiresAt<=now+61*60*1000);
  const list=await coordinator.fetch(new Request("https://signal-delivery.internal/signals/list",{
    method:"POST",headers:{"content-type":"application/json","x-signal-delivery-secret":"test-secret"},body:"{}"
  }));
  assert.deepEqual((await list.json()).signals.map(x=>x.id),["missing-expiry"]);
});

test("open trade older than four hours still blocks a fresh signal for the same symbol and side",async()=>{
  const oldTrade={id:"old-trade",signalId:"old-signal",symbol:"PF_TESTUSD",side:"LONG",status:"OPEN",
    createdAt:new Date(Date.now()-5*60*60*1000).toISOString()};
  const state=new Map([["active-futures-pending",[]],["active-futures-trades",[oldTrade]]]);
  const ctx={storage:{
    get:async key=>state.get(key),
    put:async(key,value)=>state.set(key,value),
    delete:async key=>state.delete(key),
    transaction:async callback=>{
      const draft=new Map(state);
      const tx={get:async key=>draft.get(key),put:async(key,value)=>draft.set(key,value),delete:async key=>draft.delete(key)};
      const result=await callback(tx);
      state.clear();for(const [key,value] of draft)state.set(key,value);
      return result;
    }
  }};
  const coordinator=new SignalDeliveryCoordinator(ctx,{SIGNAL_DELIVERY_AUTH_SECRET:"test-secret"});
  const now=Date.now();
  const signal={id:"fresh-after-old-trade",symbol:"PF_TESTUSD",side:"LONG",entry:100,stop:98,target1:103,target2:105,target3:107,score:68,createdAt:now,expiresAt:now+3600000};
  const response=await coordinator.fetch(new Request("https://signal-delivery.internal/signals/register",{
    method:"POST",headers:{"content-type":"application/json","x-signal-delivery-secret":"test-secret"},
    body:JSON.stringify({signals:[signal]})
  }));
  const result=await response.json();
  assert.equal(response.status,200);
  assert.equal(result.signals.length,0);
});

test("flat 1h and 4h conditions are rejected by the 11.2.0 trend/RSI setup",()=>{
  const {ticker}=makeSetup("LONG");
  const flat=Array.from({length:120},(_,i)=>({
    time:Date.now()-(120-i)*60*60*1000,open:100,high:100.1,low:99.9,close:100,volume:100
  }));
  const result=analyzeFuturesSymbol({...ticker,last:100},flat,flat,[]);
  assert.equal(result.eligible,undefined);
  assert.match(result.rejected,/trend and optimal RSI zone/);
});
test("admin signal listing endpoint rejects requests without the Durable Object secret",async()=>{
  const coordinator=new SignalDeliveryCoordinator({storage:{get:async()=>[]}}, {SIGNAL_DELIVERY_AUTH_SECRET:"test-secret"});
  const response=await coordinator.fetch(new Request("https://signal-delivery.internal/signals/list",{
    method:"POST",
    headers:{"content-type":"application/json"},
    body:"{}"
  }));
  assert.equal(response.status,401);
});

test("11.2.0 analysis thresholds match the uploaded source",()=>{
  assert.equal(FUTURES_CONFIG.MAX_SIGNALS_PER_SCAN,20);
  assert.equal(FUTURES_CONFIG.MIN_QUOTE_VOLUME,5_000_000);
  assert.equal(FUTURES_CONFIG.HIGH_RISK_MIN_QUOTE_VOLUME,2_500_000);
  assert.equal(FUTURES_CONFIG.MIN_SCORE,70);
  assert.equal(FUTURES_CONFIG.MAX_ENTRY_DRIFT_PCT,0.45);
  assert.equal(FUTURES_CONFIG.MAX_ENTRY_EMA_DISTANCE_ATR,2.0);
  assert.equal(FUTURES_CONFIG.MAX_PULLBACK_DISTANCE_ATR,0.45);
  assert.equal(FUTURES_CONFIG.MAX_RECLAIM_EXTENSION_ATR,1.5);
  assert.equal(FUTURES_CONFIG.HIGH_RISK_MIN_SCORE,62);
  assert.equal(FUTURES_CONFIG.HIGH_RISK_MIN_VOLUME_RATIO,0.65);
  assert.equal(FUTURES_CONFIG.HIGH_RISK_LONG_RSI_MIN,45);
  assert.equal(FUTURES_CONFIG.HIGH_RISK_LONG_RSI_MAX,68);
  assert.equal(FUTURES_CONFIG.HIGH_RISK_SHORT_RSI_MIN,32);
  assert.equal(FUTURES_CONFIG.HIGH_RISK_SHORT_RSI_MAX,55);
  assert.equal(FUTURES_CONFIG.HIGH_RISK_MAX_ENTRY_DRIFT_PCT,0.6);
  assert.equal(FUTURES_CONFIG.HIGH_RISK_MAX_ENTRY_EMA_DISTANCE_ATR,2.4);
  assert.equal(FUTURES_CONFIG.HIGH_RISK_MAX_RECLAIM_EXTENSION_ATR,1.8);
});
test("11.2.0 standard LONG and SHORT setups require aligned 4H and confirmed 15m entries",()=>{
  for(const side of ["LONG","SHORT"]){
    const {ticker,oneHour,fourHour,fifteenMinute}=makeSetup(side);
    const result=analyzeFuturesSymbol(ticker,oneHour,fourHour,fifteenMinute);
    assert.equal(result.side,side,JSON.stringify(result));
    assert.equal(result.eligible,true,JSON.stringify(result));
    assert.equal(result.riskLevel,"STANDARD");
    assert.ok(result.score>=70);
    assert.equal(result.momentumConfirmed,true);
    assert.equal(result.pullbackConfirmed,true);
  }
});
test("15m momentum breakout is a required entry gate",()=>{
  const {ticker,oneHour,fourHour,fifteenMinute}=makeSetup("LONG");
  fifteenMinute.at(-1).open=fifteenMinute.at(-1).close+0.5;
  const result=analyzeFuturesSymbol(ticker,oneHour,fourHour,fifteenMinute);
  assert.equal(result.eligible,undefined,JSON.stringify(result));
  assert.match(result.rejected,/15-minute momentum trigger/);
});
test("15m pullback to EMA21 is a required entry gate",()=>{
  const {ticker,oneHour,fourHour,fifteenMinute}=makeSetup("LONG");
  const ema21=testEma(fifteenMinute.map(c=>c.close),21);
  for(const candle of fifteenMinute.slice(-10,-2)){
    candle.low=ema21+0.4;
    candle.high=Math.max(candle.high,candle.low+0.1);
  }
  const result=analyzeFuturesSymbol(ticker,oneHour,fourHour,fifteenMinute);
  assert.equal(result.eligible,undefined,JSON.stringify(result));
  assert.match(result.rejected,/No 15-minute pullback to the EMA21 zone/);
});

test("11.2.0 rejects candidates when 15m entry data is unavailable",()=>{
  const {ticker,oneHour,fourHour}=makeSetup("LONG");
  const result=analyzeFuturesSymbol(ticker,oneHour,fourHour,[]);
  assert.equal(result.eligible,undefined,JSON.stringify(result));
  assert.match(result.rejected,/Insufficient 15-minute data/);
});
test("11.2.0 high-risk path also requires 15m entry confirmation",()=>{
  const {ticker,oneHour}=makeSetup("LONG");
  const alignedFourHour=makeCandles({slope:0.04,base:100});
  const result=analyzeFuturesSymbol(ticker,oneHour,alignedFourHour,[]);
  assert.equal(result.eligible,undefined,JSON.stringify(result));
  assert.match(result.rejected,/Insufficient 15-minute data/);
});
test("11.2.0 rejects both standard and high-risk candidates when symbol 4H opposes",()=>{
  const {ticker,oneHour,fifteenMinute}=makeSetup("LONG");
  const opposingFourHour=makeCandles({slope:-0.04,base:100});
  const noMomentum=fifteenMinute.map(c=>({...c}));
  noMomentum.at(-1).open=noMomentum.at(-1).close+0.5;
  const rejectedNoMomentum=analyzeFuturesSymbol(ticker,oneHour,opposingFourHour,noMomentum);
  const rejectedWithMomentum=analyzeFuturesSymbol(ticker,oneHour,opposingFourHour,fifteenMinute);
  assert.equal(rejectedNoMomentum.eligible,undefined,JSON.stringify(rejectedNoMomentum));
  assert.equal(rejectedWithMomentum.eligible,undefined,JSON.stringify(rejectedWithMomentum));
  assert.match(rejectedWithMomentum.rejected,/4H trend is not aligned/);
});
test("BTC 4h alignment is a required direction confirmation when enabled",()=>{
  const {ticker,oneHour,fourHour,fifteenMinute}=makeSetup("LONG");
  const result=analyzeFuturesSymbol(ticker,oneHour,fourHour,fifteenMinute,{
    requireBtcFourHourAlignment:true,btcFourHourTrend:"BEARISH"
  });
  assert.equal(result.eligible,undefined,JSON.stringify(result));
  assert.match(result.rejected,/Bitcoin's 4H trend is not aligned/);
});
test("11.2.0 volume priority bonus tiers are 0, 5, and 10 points",()=>{
  const scoreAt=ratio=>{
    const {ticker,oneHour,fourHour,fifteenMinute}=makeSetup("LONG");
    const averageVolume=oneHour.slice(-21,-1).reduce((sum,c)=>sum+c.volume,0)/20;
    oneHour.at(-1).volume=averageVolume*ratio;
    return analyzeFuturesSymbol(ticker,oneHour,fourHour,fifteenMinute);
  };
  const high=scoreAt(1.5), medium=scoreAt(1.0), low=scoreAt(0.7);
  assert.equal(high.score,medium.score);
  assert.equal(medium.score,low.score);
  assert.equal(high.volumePriorityBonus,10);
  assert.equal(medium.volumePriorityBonus,5);
  assert.equal(low.volumePriorityBonus,0);
  assert.equal(high.priorityScore-medium.priorityScore,5);
  assert.equal(medium.priorityScore-low.priorityScore,5);
});
test("11.2.0 funding crowding penalty is six points above the 0.0008 threshold",()=>{
  const evaluate=funding=>{
    const {ticker,oneHour,fourHour,fifteenMinute}=makeSetup("LONG");
    ticker.premium.lastFundingRate=funding;
    return analyzeFuturesSymbol(ticker,oneHour,fourHour,fifteenMinute);
  };
  const normal=evaluate(0.0007), crowded=evaluate(0.0009);
  assert.equal(normal.eligible,true);
  assert.equal(crowded.eligible,true);
  assert.equal(normal.score-crowded.score,6);
});
test("3.8.2 keeps the 1.5R, 2.5R, and 3.5R target structure",()=>{
  const {ticker,oneHour,fourHour,fifteenMinute}=makeSetup("LONG");
  const result=analyzeFuturesSymbol(ticker,oneHour,fourHour,fifteenMinute);
  const risk=result.entry-result.stop;
  assert.equal(result.eligible,true,JSON.stringify(result));
  assert.ok(Math.abs((result.target1-result.entry)/risk-1.5)<1e-9);
  assert.ok(Math.abs((result.target2-result.entry)/risk-2.5)<1e-9);
  assert.ok(Math.abs((result.target3-result.entry)/risk-3.5)<1e-9);
});

test("Kraken perpetual filter uses the 2.5M high-risk quote-volume floor",()=>{
  assert.equal(isKrakenPerpetualTicker({tag:"perpetual",symbol:"PF_XBTUSD",volumeQuote:2_500_000,last:50_000}),true);
  assert.equal(isKrakenPerpetualTicker({tag:"perpetual",symbol:"PF_XBTUSD",volumeQuote:2_499_999,last:50_000}),false);
});
test("11.2.0 high-risk LONG path respects the 0.7 relative-volume direction guard",()=>{
  const {ticker,oneHour,fourHour,fifteenMinute}=makeSetup("LONG");
  const averageVolume=oneHour.slice(-21,-1).reduce((sum,c)=>sum+c.volume,0)/20;
  oneHour.at(-1).volume=averageVolume*0.7;
  ticker.priceChangePercent=0;
  const result=analyzeFuturesSymbol(ticker,oneHour,fourHour,fifteenMinute);
  assert.equal(result.eligible,true,JSON.stringify(result));
  assert.equal(result.riskLevel,"HIGH_RISK");
  assert.ok(result.score>=62);
  assert.ok(result.volumeRatio>=0.7);
});
test("entry drift filter keeps the 0.45 percent standard limit",()=>{
  const {ticker,oneHour,fifteenMinute}=makeSetup("LONG");
  const ema20=oneHour.slice(-20).reduce((a,c)=>a+c.close,0)/20;
  const atr=calculateAtr(oneHour,14);
  const result=evaluateFuturesEntryFilters({
    ticker:{...ticker,last:ticker.last*1.005},candles1h:oneHour,candles15m:fifteenMinute,
    side:"LONG",referencePrice:oneHour.at(-1).close,ema20,atr
  });
  assert.equal(result.ok,false);
  assert.match(result.rejected,/Live price is too far/);
});
test("opposite 15m momentum blocks the 11.2.0 entry",()=>{
  const {ticker,oneHour,fourHour,fifteenMinute}=makeSetup("LONG");
  const altered=fifteenMinute.map(c=>({...c}));
  altered.at(-1).open=altered.at(-1).close+0.5;
  const result=analyzeFuturesSymbol(ticker,oneHour,fourHour,altered);
  assert.equal(result.eligible,undefined,JSON.stringify(result));
  assert.match(result.rejected,/15-minute momentum trigger/);
});
test("Kraken candle loader excludes the currently forming candle",async()=>{
  const originalFetch=globalThis.fetch;
  const now=Date.now(),hour=60*60*1000;
  globalThis.fetch=async url=>{
    assert.match(String(url),/api\/charts\/v1\/trade\/PF_TESTUSD\/1h/);
    return new Response(JSON.stringify({candles:[
      {time:now-3*hour,open:100,high:102,low:99,close:101,volume:20},
      {time:now-2*hour,open:101,high:103,low:100,close:102,volume:30},
      {time:now-hour/2,open:102,high:104,low:101,close:103,volume:40}
    ]}),{status:200});
  };
  try{
    const candles=await getKrakenFuturesCandles("PF_TESTUSD","1h");
    assert.deepEqual(candles.map(x=>x.close),[101,102]);
  }finally{globalThis.fetch=originalFetch;}
});

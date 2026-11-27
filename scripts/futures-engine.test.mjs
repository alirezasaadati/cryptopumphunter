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

test("flat 1h and 4h conditions are rejected by the 3.8.2 trend/RSI setup",()=>{
  const {ticker}=makeSetup("LONG");
  const flat=Array.from({length:120},(_,i)=>({
    time:Date.now()-(120-i)*60*60*1000,open:100,high:100.1,low:99.9,close:100,volume:100
  }));
  const result=analyzeFuturesSymbol({...ticker,last:100},flat,flat,[]);
  assert.equal(result.eligible,undefined);
  assert.match(result.rejected,/شرایط منعطف آزمایشی روند و RSI/);
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

test("3.8.2 strategy configuration matches the uploaded source",()=>{
  assert.equal(FUTURES_CONFIG.MAX_SIGNALS_PER_SCAN,20);
  assert.equal(FUTURES_CONFIG.MIN_QUOTE_VOLUME,5_000_000);
  assert.equal(FUTURES_CONFIG.MIN_SCORE,72);
  assert.equal(FUTURES_CONFIG.MAX_ENTRY_DRIFT_PCT,0.35);
  assert.equal(FUTURES_CONFIG.MAX_ENTRY_EMA_DISTANCE_ATR,3.0);
  assert.equal(FUTURES_CONFIG.MAX_PULLBACK_DISTANCE_ATR,0.35);
  assert.equal(FUTURES_CONFIG.MAX_RECLAIM_EXTENSION_ATR,3.0);
  assert.equal(FUTURES_CONFIG.HIGH_RISK_MIN_SCORE,55);
  assert.equal(FUTURES_CONFIG.HIGH_RISK_MIN_VOLUME_RATIO,0.5);
  assert.equal(FUTURES_CONFIG.HIGH_RISK_LONG_RSI_MIN,35);
  assert.equal(FUTURES_CONFIG.HIGH_RISK_LONG_RSI_MAX,78);
  assert.equal(FUTURES_CONFIG.HIGH_RISK_SHORT_RSI_MIN,22);
  assert.equal(FUTURES_CONFIG.HIGH_RISK_SHORT_RSI_MAX,65);
  assert.equal(FUTURES_CONFIG.HIGH_RISK_MAX_ENTRY_DRIFT_PCT,0.75);
  assert.equal(FUTURES_CONFIG.HIGH_RISK_MAX_ENTRY_EMA_DISTANCE_ATR,4.0);
  assert.equal(FUTURES_CONFIG.HIGH_RISK_MAX_RECLAIM_EXTENSION_ATR,4.0);
});

test("3.8.2 standard LONG and SHORT setups are eligible with their source RSI bands",()=>{
  for(const side of ["LONG","SHORT"]){
    const {ticker,oneHour,fourHour,fifteenMinute}=makeSetup(side);
    const result=analyzeFuturesSymbol(ticker,oneHour,fourHour,fifteenMinute);
    assert.equal(result.side,side,JSON.stringify(result));
    assert.equal(result.eligible,true,JSON.stringify(result));
    assert.equal(result.riskLevel,"STANDARD");
    assert.ok(result.score>=72);
  }
});

test("15m momentum and pullback are diagnostic and not universal hard gates",()=>{
  const {ticker,oneHour,fourHour,fifteenMinute}=makeSetup("LONG");
  fifteenMinute.at(-1).open=fifteenMinute.at(-1).close+0.5;
  const result=analyzeFuturesSymbol(ticker,oneHour,fourHour,fifteenMinute);
  assert.equal(result.eligible,true,JSON.stringify(result));
  assert.equal(result.momentumConfirmed,false);
  assert.equal(result.entryDiagnostics.ok,true);
});

test("3.8.2 standard path may pass when 15m data is unavailable",()=>{
  const {ticker,oneHour,fourHour}=makeSetup("LONG");
  const result=analyzeFuturesSymbol(ticker,oneHour,fourHour,[]);
  assert.equal(result.eligible,true,JSON.stringify(result));
  assert.equal(result.entryDiagnostics.confirmationUnavailable,true);
});

test("3.8.2 high-risk path allows missing 15m only when symbol 4h is not opposing",()=>{
  const {ticker,oneHour}=makeSetup("LONG");
  const alignedFourHour=makeCandles({slope:0.04,base:100});
  const opposingFourHour=makeCandles({slope:-0.04,base:100});
  const allowed=analyzeFuturesSymbol(ticker,oneHour,alignedFourHour,[]);
  const rejected=analyzeFuturesSymbol(ticker,oneHour,opposingFourHour,[]);
  assert.equal(allowed.eligible,true,JSON.stringify(allowed));
  assert.equal(allowed.riskLevel,"STANDARD");
  assert.equal(rejected.eligible,undefined,JSON.stringify(rejected));
  assert.match(rejected.rejected,/۱۵دقیقه‌ای/);
});

test("3.8.2 high-risk path requires 15m momentum when symbol 4h trend opposes",()=>{
  const {ticker,oneHour,fifteenMinute}=makeSetup("LONG");
  const opposingFourHour=makeCandles({slope:-0.04,base:100});
  const noMomentum=fifteenMinute.map(c=>({...c}));
  noMomentum.at(-1).open=noMomentum.at(-1).close+0.5;
  const rejected=analyzeFuturesSymbol(ticker,oneHour,opposingFourHour,noMomentum);
  const accepted=analyzeFuturesSymbol(ticker,oneHour,opposingFourHour,fifteenMinute);
  assert.equal(rejected.eligible,undefined,JSON.stringify(rejected));
  assert.equal(accepted.eligible,true,JSON.stringify(accepted));
  assert.equal(accepted.riskLevel,"HIGH_RISK");
});

test("BTC 4h alignment is not part of the 3.8.2 signal decision",()=>{
  const {ticker,oneHour,fourHour,fifteenMinute}=makeSetup("LONG");
  const result=analyzeFuturesSymbol(ticker,oneHour,fourHour,fifteenMinute,{
    requireBtcFourHourAlignment:true,btcFourHourTrend:"BEARISH"
  });
  assert.equal(result.eligible,true,JSON.stringify(result));
});

test("3.8.2 volume scoring adds 18, 12, or 4 points",()=>{
  const scoreAt=ratio=>{
    const {ticker,oneHour,fourHour,fifteenMinute}=makeSetup("LONG");
    const averageVolume=oneHour.slice(-21,-1).reduce((sum,c)=>sum+c.volume,0)/20;
    oneHour.at(-1).volume=averageVolume*ratio;
    return analyzeFuturesSymbol(ticker,oneHour,fourHour,fifteenMinute).score;
  };
  const high=scoreAt(1.5), medium=scoreAt(1.0), low=scoreAt(0.5);
  assert.equal(high-medium,6);
  assert.equal(medium-low,8);
});

test("3.8.2 funding crowding penalty is five points above the 0.001 threshold",()=>{
  const evaluate=funding=>{
    const {ticker,oneHour,fourHour,fifteenMinute}=makeSetup("LONG");
    ticker.premium.lastFundingRate=funding;
    return analyzeFuturesSymbol(ticker,oneHour,fourHour,fifteenMinute);
  };
  const normal=evaluate(0.0009), crowded=evaluate(0.0011);
  assert.equal(normal.eligible,true);
  assert.equal(crowded.eligible,true);
  assert.equal(normal.score-crowded.score,5);
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

test("Kraken perpetual filter uses the 5M quote-volume floor",()=>{
  assert.equal(isKrakenPerpetualTicker({tag:"perpetual",symbol:"PF_XBTUSD",volumeQuote:5_000_000,last:50_000}),true);
  assert.equal(isKrakenPerpetualTicker({tag:"perpetual",symbol:"PF_XBTUSD",volumeQuote:4_999_999,last:50_000}),false);
});

test("3.8.2 high-risk path accepts 0.5 relative volume when score threshold passes",()=>{
  const {ticker,oneHour,fourHour,fifteenMinute}=makeSetup("LONG");
  const averageVolume=oneHour.slice(-21,-1).reduce((sum,c)=>sum+c.volume,0)/20;
  oneHour.at(-1).volume=averageVolume*0.5;
  ticker.priceChangePercent=0;
  const result=analyzeFuturesSymbol(ticker,oneHour,fourHour,fifteenMinute);
  assert.equal(result.eligible,true,JSON.stringify(result));
  assert.equal(result.riskLevel,"HIGH_RISK");
  assert.ok(result.score>=55);
  assert.ok(result.volumeRatio>=0.5);
});

test("entry drift filter keeps the 0.35 percent standard limit",()=>{
  const {ticker,oneHour,fifteenMinute}=makeSetup("LONG");
  const ema20=oneHour.slice(-20).reduce((a,c)=>a+c.close,0)/20;
  const atr=calculateAtr(oneHour,14);
  const result=evaluateFuturesEntryFilters({
    ticker:{...ticker,last:ticker.last*1.01},candles1h:oneHour,candles15m:fifteenMinute,
    side:"LONG",referencePrice:oneHour.at(-1).close,ema20,atr
  });
  assert.equal(result.ok,false);
  assert.match(result.rejected,/فاصله قیمت لحظه‌ای/);
});

test("opposite 15m momentum is reported but does not block the standard 3.8.2 path",()=>{
  const {ticker,oneHour,fourHour,fifteenMinute}=makeSetup("LONG");
  const altered=fifteenMinute.map(c=>({...c}));
  altered.at(-1).open=altered.at(-1).close+0.5;
  const result=analyzeFuturesSymbol(ticker,oneHour,fourHour,altered);
  assert.equal(result.eligible,true,JSON.stringify(result));
  assert.equal(result.momentumConfirmed,false);
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


test("entry drift filter rejects a stale candle-close entry",()=>{
  const {ticker,oneHour,fifteenMinute}=makeSetup("LONG");
  const ema20=oneHour.slice(-20).reduce((a,c)=>a+c.close,0)/20;
  const atr=calculateAtr(oneHour,14);
  const result=evaluateFuturesEntryFilters({
    ticker:{...ticker,last:ticker.last*1.01},candles1h:oneHour,candles15m:fifteenMinute,
    side:"LONG",referencePrice:oneHour.at(-1).close,ema20,atr
  });
  assert.equal(result.ok,false);
  assert.match(result.rejected,/Live price is too far from the analytical reference/);
});

test("late-entry filter rejects an overextended price versus hourly EMA20",()=>{
  const {ticker,oneHour,fifteenMinute}=makeSetup("LONG");
  const ema20=oneHour.slice(-20).reduce((a,c)=>a+c.close,0)/20;
  const atr=calculateAtr(oneHour,14);
  const result=evaluateFuturesEntryFilters({
    ticker:{...ticker,last:ema20+atr*4.5},candles1h:oneHour,candles15m:fifteenMinute,
    side:"LONG",referencePrice:ema20+atr*4,ema20,atr
  });
  assert.equal(result.ok,false);
  assert.match(result.rejected,/Entry is too late; price is too far from EMA20/);
});

test("opposite 15m momentum blocks an entry and is returned as a rejection",()=>{
  const {ticker,oneHour,fifteenMinute}=makeSetup("LONG");
  const altered=fifteenMinute.map(c=>({...c}));
  altered[altered.length-1].open=altered.at(-1).close+0.5;
  const ema20=oneHour.slice(-20).reduce((a,c)=>a+c.close,0)/20;
  const atr=calculateAtr(oneHour,14);
  const result=evaluateFuturesEntryFilters({
    ticker,candles1h:oneHour,candles15m:altered,side:"LONG",
    referencePrice:oneHour.at(-1).close,ema20,atr
  });
  assert.equal(result.ok,false);
  assert.match(result.rejected,/momentum trigger has not fired/i);
});

test("15m rising-candle fixture confirms the pullback zone",()=>{
  const {ticker,oneHour}=makeSetup("LONG");
  const altered=makeCandles({count:120,slope:0.1,base:100}).map(c=>({...c,low:c.close-0.001}));
  const priorEma9=testEma(altered.slice(0,-1).map(c=>c.close),9);
  altered.at(-1).close=priorEma9+0.05;
  altered.at(-1).open=priorEma9+0.02;
  const ema20=oneHour.slice(-20).reduce((a,c)=>a+c.close,0)/20;
  const atr=calculateAtr(oneHour,14);
  const result=evaluateFuturesEntryFilters({
    ticker,candles1h:oneHour,candles15m:altered,side:"LONG",
    referencePrice:oneHour.at(-1).close,ema20,atr
  });
  assert.equal(result.ok,true);
  assert.equal(result.pullbackConfirmed,true);
});

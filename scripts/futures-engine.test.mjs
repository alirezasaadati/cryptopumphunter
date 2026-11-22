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
  const env={SIGNAL_DELIVERY_SECRET:"test-secret"};
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
  const ctx={storage:{get:async key=>state.get(key),put:async(key,value)=>state.set(key,value),delete:async key=>state.delete(key)}};
  const coordinator=new SignalDeliveryCoordinator(ctx,{SIGNAL_DELIVERY_SECRET:"test-secret"});
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

test("open trade older than four hours does not block a fresh signal for the same symbol and side",async()=>{
  const oldTrade={id:"old-trade",signalId:"old-signal",symbol:"PF_TESTUSD",side:"LONG",status:"OPEN",
    createdAt:new Date(Date.now()-5*60*60*1000).toISOString()};
  const state=new Map([["active-futures-pending",[]],["active-futures-trades",[oldTrade]]]);
  const ctx={storage:{get:async key=>state.get(key),put:async(key,value)=>state.set(key,value),delete:async key=>state.delete(key)}};
  const coordinator=new SignalDeliveryCoordinator(ctx,{SIGNAL_DELIVERY_SECRET:"test-secret"});
  const now=Date.now();
  const signal={id:"fresh-after-old-trade",symbol:"PF_TESTUSD",side:"LONG",entry:100,stop:98,target1:103,target2:105,target3:107,score:68,createdAt:now,expiresAt:now+3600000};
  const response=await coordinator.fetch(new Request("https://signal-delivery.internal/signals/register",{
    method:"POST",headers:{"content-type":"application/json","x-signal-delivery-secret":"test-secret"},
    body:JSON.stringify({signals:[signal]})
  }));
  const result=await response.json();
  assert.equal(response.status,200);
  assert.equal(result.signals.length,1);
  assert.equal(result.signals[0].id,signal.id);
});

test("flat 1h and 4h conditions expose indicator-level rejection diagnostics",()=>{
  const {ticker,oneHour}=makeSetup("LONG");
  const flat=Array.from({length:120},(_,i)=>({
    time:Date.now()-(120-i)*60*60*1000,open:100,high:100.1,low:99.9,close:100,volume:100
  }));
  const result=analyzeFuturesSymbol({...ticker,last:100},flat,flat,[]);
  assert.equal(result.eligible,undefined);
  assert.equal(result.entryDiagnostics.stage,"trend_rsi");
  assert.equal(result.entryDiagnostics.up1h,false);
  assert.equal(result.entryDiagnostics.up4h,false);
  assert.match(result.rejected,/روند/);
});

test("admin signal listing endpoint rejects requests without the Durable Object secret",async()=>{
  const coordinator=new SignalDeliveryCoordinator({storage:{get:async()=>[]}}, {SIGNAL_DELIVERY_SECRET:"test-secret"});
  const response=await coordinator.fetch(new Request("https://signal-delivery.internal/signals/list",{
    method:"POST",
    headers:{"content-type":"application/json"},
    body:"{}"
  }));
  assert.equal(response.status,401);
});

test("v3.8.2 configuration is preserved",()=>{
  assert.equal("MAX_SYMBOLS" in FUTURES_CONFIG,false);
  assert.equal(FUTURES_CONFIG.CONCURRENCY,5);
  assert.equal(FUTURES_CONFIG.MAX_SCAN_DURATION_MS,180000);
  assert.equal(FUTURES_CONFIG.SCAN_FINALIZATION_RESERVE_MS,45000);
  assert.equal(FUTURES_CONFIG.REQUEST_TIMEOUT_MS,12000);
  assert.equal(FUTURES_CONFIG.MAX_SIGNALS_PER_SCAN,20);
  assert.equal(FUTURES_CONFIG.MIN_QUOTE_VOLUME,5_000_000);
  assert.equal(FUTURES_CONFIG.MIN_CANDLES,60);
  assert.equal(FUTURES_CONFIG.MIN_SCORE,65);
  assert.equal(FUTURES_CONFIG.INTERVAL,"1h");
  assert.equal(FUTURES_CONFIG.CONFIRM_INTERVAL,"4h");
  assert.equal(FUTURES_CONFIG.ENTRY_CONFIRM_INTERVAL,"15m");
  assert.equal(FUTURES_CONFIG.MAX_ENTRY_DRIFT_PCT,0.7);
  assert.equal(FUTURES_CONFIG.MAX_ENTRY_EMA_DISTANCE_ATR,4.0);
  assert.equal("ENTRY_INTERVAL" in FUTURES_CONFIG,false);
});


test("Kraken universe is not truncated by a fixed symbol count",async()=>{
  const originalFetch=globalThis.fetch;
  const tickers=Array.from({length: 30},(_,i)=>({
    tag:"perpetual",symbol:`PF_TEST${String(i).padStart(2,"0")}USD`,
    volumeQuote:10_000_000+i,last:100+i,suspended:false
  }));
  globalThis.fetch=async url=>{
    assert.match(String(url),/derivatives\/api\/v3\/tickers/);
    return new Response(JSON.stringify({tickers}),{status:200});
  };
  try{
    const universe=await getKrakenFuturesUniverse();
    assert.equal(universe.length,30);
    assert.equal(universe[0].symbol,"PF_TEST29USD");
  }finally{globalThis.fetch=originalFetch;}
});

test("mapLimit stops assigning new symbols when the safe time budget ends",async()=>{
  const processed=[];
  const results=await mapLimit([1,2,3,4],1,async value=>{
    processed.push(value);
    return value;
  },()=>processed.length<2);
  assert.deepEqual(processed,[1,2]);
  assert.deepEqual(results.slice(0,2),[1,2]);
  assert.equal(results[2],undefined);
  assert.equal(results[3],undefined);
});

test("Kraken perpetual filter accepts only liquid PI/PF USD perpetuals",()=>{
  assert.equal(isKrakenPerpetualTicker({tag:"perpetual",symbol:"PF_XBTUSD",volumeQuote:8_000_000,last:50_000}),true);
  assert.equal(isKrakenPerpetualTicker({tag:"month",symbol:"PF_XBTUSD",volumeQuote:8_000_000,last:50_000}),false);
  assert.equal(isKrakenPerpetualTicker({tag:"perpetual",symbol:"BTC/USD",volumeQuote:8_000_000,last:50_000}),false);
  assert.equal(isKrakenPerpetualTicker({tag:"perpetual",symbol:"PF_XBTUSD",volumeQuote:1_000,last:50_000}),false);
});

test("ATR rejects insufficient candles and calculates positive volatility",()=>{
  assert.equal(calculateAtr(makeCandles().slice(0,10),14),null);
  assert.ok(calculateAtr(makeCandles(),14)>0);
});

test("trend-aligned setup with confirmed 15m pullback generates a LONG",()=>{
  const {ticker,oneHour,fourHour,fifteenMinute}=makeSetup("LONG");
  const result=analyzeFuturesSymbol(ticker,oneHour,fourHour,fifteenMinute);
  assert.equal(result.side,"LONG");
  assert.equal(result.eligible,true,JSON.stringify(result));
  assert.ok(result.score>=65);
  assert.ok(result.stop<result.entry);
  assert.ok(result.target1>result.entry);
  assert.ok(result.target2>result.target1);
  assert.ok(result.target3>result.target2);
  assert.equal(result.rewardRisk,1.5);
  assert.equal(result.candleTime,oneHour.at(-1).time);
});

test("trend-aligned setup with confirmed 15m pullback generates a SHORT",()=>{
  const {ticker,oneHour,fourHour,fifteenMinute}=makeSetup("SHORT");
  const result=analyzeFuturesSymbol(ticker,oneHour,fourHour,fifteenMinute);
  assert.equal(result.side,"SHORT");
  assert.equal(result.eligible,true);
  assert.ok(result.stop>result.entry);
  assert.ok(result.target1<result.entry);
  assert.ok(result.target2<result.target1);
  assert.ok(result.target3<result.target2);
});


test("standard LONG path accepts aligned 1h with neutral 4h context",()=>{
  const {ticker,oneHour,fifteenMinute}=makeSetup("LONG");
  const neutralFourHour=Array.from({length:120},(_,i)=>({
    time:Date.now()-(120-i)*4*60*60*1000,
    open:100,high:100.1,low:99.9,close:100,volume:100
  }));
  const result=analyzeFuturesSymbol(ticker,oneHour,neutralFourHour,fifteenMinute);
  assert.equal(result.eligible,true,JSON.stringify(result));
  assert.equal(result.highRiskEligible,false);
  assert.equal(result.riskLevel,"STANDARD");
  assert.ok(result.score>=FUTURES_CONFIG.MIN_SCORE);
});

test("separate high-risk SHORT path can pass with opposing 4h only when 15m momentum confirms",()=>{
  const {ticker,oneHour,fifteenMinute}=makeSetup("SHORT");
  const opposingFourHour=makeCandles({slope:0.04,base:100});
  const result=analyzeFuturesSymbol(ticker,oneHour,opposingFourHour,fifteenMinute);
  assert.equal(result.eligible,true,JSON.stringify(result));
  assert.equal(result.highRiskEligible,true);
  assert.equal(result.riskLevel,"HIGH_RISK");
  assert.equal(result.entryDiagnostics.fourHourOpposes,true);
  assert.equal(result.entryDiagnostics.momentumConfirmed,true);
});

test("strict LONG setup below standard score/volume falls back to HIGH_RISK",()=>{
  const {ticker,oneHour,fourHour,fifteenMinute}=makeSetup("LONG");
  const avg=oneHour.slice(-21,-1).reduce((sum,c)=>sum+c.volume,0)/20;
  oneHour.at(-1).volume=avg*0.6;
  ticker.priceChangePercent=0;
  const result=analyzeFuturesSymbol(ticker,oneHour,fourHour,fifteenMinute);
  assert.equal(result.side,"LONG");
  assert.equal(result.eligible,true,JSON.stringify(result));
  assert.equal(result.highRiskEligible,true);
  assert.equal(result.riskLevel,"HIGH_RISK");
  assert.ok(result.score>=FUTURES_CONFIG.HIGH_RISK_MIN_SCORE);
  assert.ok(result.volumeRatio>=FUTURES_CONFIG.HIGH_RISK_MIN_VOLUME_RATIO);
});

test("strict SHORT setup below standard score/volume falls back to HIGH_RISK",()=>{
  const {ticker,oneHour,fourHour,fifteenMinute}=makeSetup("SHORT");
  const avg=oneHour.slice(-21,-1).reduce((sum,c)=>sum+c.volume,0)/20;
  oneHour.at(-1).volume=avg*0.6;
  ticker.priceChangePercent=0;
  const result=analyzeFuturesSymbol(ticker,oneHour,fourHour,fifteenMinute);
  assert.equal(result.side,"SHORT");
  assert.equal(result.eligible,true,JSON.stringify(result));
  assert.equal(result.highRiskEligible,true);
  assert.equal(result.riskLevel,"HIGH_RISK");
  assert.ok(result.score>=FUTURES_CONFIG.HIGH_RISK_MIN_SCORE);
  assert.ok(result.volumeRatio>=FUTURES_CONFIG.HIGH_RISK_MIN_VOLUME_RATIO);
});

test("risk distance outside the original 0.2%-8% band is rejected",()=>{
  const {ticker,oneHour,fourHour,fifteenMinute}=makeSetup("LONG");
  const altered=oneHour.map(x=>({...x}));
  // Widen the last 14 true ranges enough to exceed the original 8% risk ceiling.
  for(let i=altered.length-14;i<altered.length;i++) {
    altered[i].high=altered[i].close+10;
    altered[i].low=altered[i].close-10;
  }
  const result=analyzeFuturesSymbol(ticker,altered,fourHour,fifteenMinute);
  assert.ok(result.rejected || result.eligible===false);
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
  assert.match(result.rejected,/فاصله قیمت لحظه‌ای/);
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
  assert.match(result.rejected,/ورود دیرهنگام/);
});

test("opposite 15m momentum is diagnostic and does not suppress a candidate",()=>{
  const {ticker,oneHour,fifteenMinute}=makeSetup("LONG");
  const altered=fifteenMinute.map(c=>({...c}));
  altered[altered.length-1].open=altered.at(-1).close+0.5;
  const ema20=oneHour.slice(-20).reduce((a,c)=>a+c.close,0)/20;
  const atr=calculateAtr(oneHour,14);
  const result=evaluateFuturesEntryFilters({
    ticker,candles1h:oneHour,candles15m:altered,side:"LONG",
    referencePrice:oneHour.at(-1).close,ema20,atr
  });
  assert.equal(result.ok,true);
  assert.equal(result.momentumConfirmed,false);
});

test("missing 15m pullback is diagnostic and does not suppress a candidate",()=>{
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
  assert.equal(result.pullbackConfirmed,false);
});

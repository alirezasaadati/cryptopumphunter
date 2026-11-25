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
  const coordinator=new SignalDeliveryCoordinator({storage:{get:async()=>[]}}, {SIGNAL_DELIVERY_AUTH_SECRET:"test-secret"});
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
  assert.equal(FUTURES_CONFIG.HIGH_RISK_MIN_QUOTE_VOLUME,1_000_000);
  assert.equal(FUTURES_CONFIG.MIN_CANDLES,60);
  assert.equal(FUTURES_CONFIG.MIN_SCORE,65);
  assert.equal(FUTURES_CONFIG.HIGH_RISK_MIN_VOLUME_RATIO,0.3);
  assert.equal(FUTURES_CONFIG.VOLUME_PRIORITY_TIER_1,0.5);
  assert.equal(FUTURES_CONFIG.VOLUME_PRIORITY_TIER_2,1.0);
  assert.equal(FUTURES_CONFIG.VOLUME_PRIORITY_BONUS_TIER_1,5);
  assert.equal(FUTURES_CONFIG.VOLUME_PRIORITY_BONUS_TIER_2,10);
  assert.equal(FUTURES_CONFIG.CONFIRMATION_PRIORITY_BONUS_ONE,7);
  assert.equal(FUTURES_CONFIG.CONFIRMATION_PRIORITY_BONUS_BOTH,15);
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
  assert.equal(isKrakenPerpetualTicker({tag:"perpetual",symbol:"PF_XBTUSD",volumeQuote:1_000_000,last:50_000}),true);
  assert.equal(isKrakenPerpetualTicker({tag:"perpetual",symbol:"PF_XBTUSD",volumeQuote:999_999,last:50_000}),false);
});

test("ATR rejects insufficient candles and calculates positive volatility",()=>{
  assert.equal(calculateAtr(makeCandles().slice(0,10),14),null);
  assert.ok(calculateAtr(makeCandles(),14)>0);
});

test("momentum and pullback provide 0/7/15 priority bonuses without changing qualification score",()=>{
  const evaluate=mode=>{
    const {ticker,oneHour,fourHour,fifteenMinute}=makeSetup("LONG");
    const last=fifteenMinute.at(-1);
    if(mode==="pullback_only") {
      last.open=last.close+0.05;
    } else if(mode==="momentum_only" || mode==="neither") {
      const current=oneHour.at(-1).close;
      const count=120, slope=0.02, base=current-slope*(count-1);
      const rebuilt=Array.from({length:count},(_,i)=>{
        const close=base+i*slope;
        return {time:Date.now()-(count-i)*15*60*1000,open:close-0.005,high:close+0.02,low:close-0.02,close,volume:100};
      });
      fifteenMinute.splice(0,fifteenMinute.length,...rebuilt);
      if(mode==="neither") fifteenMinute.at(-1).open=fifteenMinute.at(-1).close+0.005;
      const closes=fifteenMinute.map(c=>c.close);
      const ema21=testEma(closes,21);
      const atr15=calculateAtr(fifteenMinute,14);
      assert.ok(fifteenMinute.slice(-9,-1).every(c=>c.low>ema21+atr15*0.35),
        JSON.stringify({ema21,atr15,recent:fifteenMinute.slice(-9,-1).map(c=>({low:c.low,close:c.close}))}));
    }
    return analyzeFuturesSymbol(ticker,oneHour,fourHour,fifteenMinute);
  };
  const both=evaluate("both"), one=evaluate("pullback_only"), none=evaluate("neither");
  assert.equal(both.confirmationCount,2,JSON.stringify(both.entryDiagnostics));
  assert.equal(both.confirmationPriorityBonus,15);
  assert.equal(one.confirmationCount,1,JSON.stringify(one.entryDiagnostics));
  assert.equal(one.confirmationPriorityBonus,7);
  assert.equal(none.confirmationCount,0,JSON.stringify(none.entryDiagnostics));
  assert.equal(none.confirmationPriorityBonus,0);
  assert.equal(both.score,both.baseScore);
  assert.equal(one.score,one.baseScore);
  assert.equal(none.score,none.baseScore);
  assert.equal(both.priorityScore,both.baseScore+both.volumePriorityBonus+15);
  assert.equal(one.priorityScore,one.baseScore+one.volumePriorityBonus+7);
  assert.equal(none.priorityScore,none.baseScore+none.volumePriorityBonus);
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


test("mandatory BTC 4h alignment blocks LONG when BTC 4h is bearish",()=>{
  const {ticker,oneHour,fourHour,fifteenMinute}=makeSetup("LONG");
  const result=analyzeFuturesSymbol(ticker,oneHour,fourHour,fifteenMinute,{
    requireBtcFourHourAlignment:true,btcFourHourTrend:"BEARISH"
  });
  assert.equal(result.eligible,undefined);
  assert.equal(result.side,"LONG");
  assert.equal(result.entryDiagnostics.stage,"btc_4h_alignment");
  assert.equal(result.entryDiagnostics.passed,false);
  assert.match(result.rejected,/بیت‌کوین/);
});

test("staged 15m preflight is a superset of standard and high-risk eligible signals",()=>{
  for(const side of ["LONG","SHORT"]){
    const {ticker,oneHour,fourHour,fifteenMinute}=makeSetup(side);
    const options={requireBtcFourHourAlignment:true,btcFourHourTrend:side==="LONG"?"BULLISH":"BEARISH"};
    const preflight=analyzeFuturesSymbol(ticker,oneHour,fourHour,[],{...options,skipEntryFilters:true});
    const complete=analyzeFuturesSymbol(ticker,oneHour,fourHour,fifteenMinute,options);
    assert.equal(complete.eligible,true,JSON.stringify(complete));
    assert.ok(preflight.eligible===true||preflight.highRiskEligible===true,JSON.stringify(preflight));
  }
});

test("staged 15m preflight preserves the high-risk candidate path",()=>{
  const {ticker,oneHour,fourHour,fifteenMinute}=makeSetup("LONG");
  const averageVolume=oneHour.slice(-21,-1).reduce((sum,c)=>sum+c.volume,0)/20;
  oneHour.at(-1).volume=averageVolume*0.8;
  ticker.priceChangePercent=0;
  ticker.quoteVolume=3_000_000;
  const options={requireBtcFourHourAlignment:true,btcFourHourTrend:"BULLISH"};
  const preflight=analyzeFuturesSymbol(ticker,oneHour,fourHour,[],{...options,skipEntryFilters:true});
  const complete=analyzeFuturesSymbol(ticker,oneHour,fourHour,fifteenMinute,options);
  assert.equal(complete.eligible,true,JSON.stringify(complete));
  assert.equal(complete.riskLevel,"HIGH_RISK");
  assert.equal(preflight.eligible,false);
  assert.equal(preflight.highRiskEligible,true,JSON.stringify(preflight));
});

test("mandatory BTC and symbol 4h trends must both match the signal direction",()=>{
  const long=makeSetup("LONG");
  const longOk=analyzeFuturesSymbol(long.ticker,long.oneHour,long.fourHour,long.fifteenMinute,{
    requireBtcFourHourAlignment:true,btcFourHourTrend:"BULLISH"
  });
  assert.equal(longOk.eligible,true,JSON.stringify(longOk));
  assert.equal(longOk.btcFourHourTrend,"BULLISH");

  const short=makeSetup("SHORT");
  const shortOk=analyzeFuturesSymbol(short.ticker,short.oneHour,short.fourHour,short.fifteenMinute,{
    requireBtcFourHourAlignment:true,btcFourHourTrend:"BEARISH"
  });
  assert.equal(shortOk.eligible,true,JSON.stringify(shortOk));

  const opposingSymbol4h=makeCandles({slope:-0.04,base:100});
  const mismatch=analyzeFuturesSymbol(long.ticker,long.oneHour,opposingSymbol4h,long.fifteenMinute,{
    requireBtcFourHourAlignment:true,btcFourHourTrend:"BULLISH"
  });
  assert.equal(mismatch.eligible,undefined);
  assert.equal(mismatch.entryDiagnostics.stage,"btc_4h_alignment");
});

test("15m momentum and pullback remain optional under mandatory BTC alignment",()=>{
  const {ticker,oneHour,fourHour,fifteenMinute}=makeSetup("LONG");
  const altered=fifteenMinute.map(c=>({...c}));
  altered.at(-1).open=altered.at(-1).close+0.5;
  const result=analyzeFuturesSymbol(ticker,oneHour,fourHour,altered,{
    requireBtcFourHourAlignment:true,btcFourHourTrend:"BULLISH"
  });
  assert.equal(result.eligible,true,JSON.stringify(result));
  assert.equal(result.momentumConfirmed,false);
  assert.equal(result.pullbackConfirmed,true);
  assert.equal(result.confirmationCount,1);
});

test("neutral 4h trend does not block a valid LONG and adds no 4h score",()=>{
  const {ticker,oneHour,fifteenMinute}=makeSetup("LONG");
  const neutralFourHour=Array.from({length:120},(_,i)=>({
    time:Date.now()-(120-i)*4*60*60*1000,
    open:100,high:100.1,low:99.9,close:100,volume:100
  }));
  const result=analyzeFuturesSymbol(ticker,oneHour,neutralFourHour,fifteenMinute);
  assert.equal(result.side,"LONG",JSON.stringify(result));
  assert.equal(result.eligible,true,JSON.stringify(result));
  assert.equal(result.fourHourTrend,"NEUTRAL");
  assert.equal(result.fourHourScoreAdjustment,0);
});

test("opposing 4h trend reduces SHORT score but does not block even HIGH_RISK",()=>{
  const {ticker,oneHour,fifteenMinute}=makeSetup("SHORT");
  const opposingFourHour=makeCandles({slope:0.04,base:100});
  fifteenMinute.at(-1).open=fifteenMinute.at(-1).close-0.05;
  const result=analyzeFuturesSymbol(ticker,oneHour,opposingFourHour,fifteenMinute);
  assert.equal(result.side,"SHORT",JSON.stringify(result));
  assert.equal(result.eligible,true,JSON.stringify(result));
  assert.equal(result.riskLevel,"HIGH_RISK");
  assert.equal(result.fourHourTrend,"BULLISH");
  assert.equal(result.fourHourScoreAdjustment,-8);
});

test("opposing 4h trend does not block HIGH_RISK when 15m data is unavailable",()=>{
  const {ticker,oneHour}=makeSetup("SHORT");
  const opposingFourHour=makeCandles({slope:0.04,base:100});
  const result=analyzeFuturesSymbol(ticker,oneHour,opposingFourHour,[]);
  assert.equal(result.side,"SHORT",JSON.stringify(result));
  assert.equal(result.eligible,true,JSON.stringify(result));
  assert.equal(result.riskLevel,"HIGH_RISK");
  assert.equal(result.fourHourScoreAdjustment,-8);
});


test("strict LONG setup below standard score/volume falls back to HIGH_RISK",()=>{
  const {ticker,oneHour,fourHour,fifteenMinute}=makeSetup("LONG");
  const avg=oneHour.slice(-21,-1).reduce((sum,c)=>sum+c.volume,0)/20;
  oneHour.at(-1).volume=avg*0.6;
  ticker.priceChangePercent=0;
  ticker.quoteVolume=2_000_000;
  const result=analyzeFuturesSymbol(ticker,oneHour,fourHour,fifteenMinute);
  assert.equal(result.side,"LONG");
  assert.equal(result.eligible,true,JSON.stringify(result));
  assert.equal(result.highRiskEligible,true);
  assert.equal(result.riskLevel,"HIGH_RISK");
  assert.ok(result.score>=FUTURES_CONFIG.HIGH_RISK_MIN_SCORE);
  assert.ok(result.volumeRatio>=FUTURES_CONFIG.HIGH_RISK_MIN_VOLUME_RATIO);
  assert.equal(result.quoteVolume,2_000_000);
});

test("HIGH_RISK accepts quote volume exactly at the 1M USD floor when relative volume passes",()=>{
  const {ticker,oneHour,fourHour,fifteenMinute}=makeSetup("LONG");
  ticker.quoteVolume=1_000_000;
  const avg=oneHour.slice(-21,-1).reduce((sum,c)=>sum+c.volume,0)/20;
  oneHour.at(-1).volume=avg*0.6;
  ticker.priceChangePercent=0;
  const result=analyzeFuturesSymbol(ticker,oneHour,fourHour,fifteenMinute);
  assert.equal(result.eligible,true,JSON.stringify(result));
  assert.equal(result.highRiskEligible,true);
  assert.equal(result.riskLevel,"HIGH_RISK");
  assert.equal(result.quoteVolume,1_000_000);
  assert.ok(result.volumeRatio>=0.5);
});

test("HIGH_RISK rejects quote volume below the 1M USD safety floor",()=>{
  const {ticker,oneHour,fourHour,fifteenMinute}=makeSetup("LONG");
  ticker.quoteVolume=999_999;
  oneHour.at(-1).volume=oneHour.slice(-21,-1).reduce((sum,c)=>sum+c.volume,0)/20;
  ticker.priceChangePercent=0;
  const result=analyzeFuturesSymbol(ticker,oneHour,fourHour,fifteenMinute);
  assert.equal(result.eligible,undefined);
  assert.match(result.rejected,/کف ایمنی مسیر پرریسک/);
  assert.equal(result.entryDiagnostics.minimumHighRiskQuoteVolume,1_000_000);
});

test("Kraken universe includes symbols above 1M USD for HIGH_RISK evaluation",async()=>{
  const originalFetch=globalThis.fetch;
  const tickers=[
    {tag:"perpetual",symbol:"PF_TESTLOWUSD",volumeQuote:2_000_000,last:10,suspended:false},
    {tag:"perpetual",symbol:"PF_TESTDEADUSD",volumeQuote:999_999,last:10,suspended:false}
  ];
  globalThis.fetch=async()=>new Response(JSON.stringify({tickers}),{status:200});
  try {
    const universe=await getKrakenFuturesUniverse();
    assert.deepEqual(universe.map(x=>x.symbol),["PF_TESTLOWUSD"]);
  } finally { globalThis.fetch=originalFetch; }
});

test("HIGH_RISK rejects relative volume below 0.3x",()=>{
  const {ticker,oneHour,fourHour,fifteenMinute}=makeSetup("LONG");
  const avg=oneHour.slice(-21,-1).reduce((sum,c)=>sum+c.volume,0)/20;
  oneHour.at(-1).volume=avg*0.299;
  ticker.priceChangePercent=0;
  const result=analyzeFuturesSymbol(ticker,oneHour,fourHour,fifteenMinute);
  assert.equal(result.eligible,undefined);
  assert.match(result.rejected,/کمتر از حداقل مسیر پرریسک/);
  assert.equal(result.entryDiagnostics.minimumHighRiskVolumeRatio,0.3);
  assert.ok(result.entryDiagnostics.volumeRatio<0.3);
});

test("HIGH_RISK accepts relative volume exactly at the 0.3x floor without a priority bonus",()=>{
  const {ticker,oneHour,fourHour,fifteenMinute}=makeSetup("LONG");
  const avg=oneHour.slice(-21,-1).reduce((sum,c)=>sum+c.volume,0)/20;
  oneHour.at(-1).volume=avg*0.3;
  ticker.quoteVolume=2_000_000;
  ticker.priceChangePercent=0;
  const result=analyzeFuturesSymbol(ticker,oneHour,fourHour,fifteenMinute);
  assert.equal(result.eligible,true,JSON.stringify(result));
  assert.equal(result.highRiskEligible,true);
  assert.equal(result.volumePriorityBonus,0);
});

test("volume priority bonus tiers are 0, 5, and 10 without changing qualification score",()=>{
  const evaluate=ratio=>{
    const {ticker,oneHour,fourHour,fifteenMinute}=makeSetup("LONG");
    const avg=oneHour.slice(-21,-1).reduce((sum,c)=>sum+c.volume,0)/20;
    oneHour.at(-1).volume=avg*ratio;
    ticker.quoteVolume=2_000_000;
    ticker.priceChangePercent=0;
    return analyzeFuturesSymbol(ticker,oneHour,fourHour,fifteenMinute);
  };
  const low=evaluate(0.4), medium=evaluate(0.75), high=evaluate(1.0);
  assert.equal(low.volumePriorityBonus,0);
  assert.equal(medium.volumePriorityBonus,5);
  assert.equal(high.volumePriorityBonus,10);
  assert.equal(low.priorityScore,low.baseScore+low.confirmationPriorityBonus);
  assert.equal(medium.priorityScore,medium.baseScore+5+medium.confirmationPriorityBonus);
  assert.equal(high.priorityScore,high.baseScore+10+high.confirmationPriorityBonus);
  assert.equal(low.score,medium.score);
  assert.equal(medium.score,high.score);
  assert.equal(low.score,low.baseScore);
  assert.equal(medium.score,medium.baseScore);
  assert.equal(high.score,high.baseScore);
  assert.equal(low.score>=FUTURES_CONFIG.HIGH_RISK_MIN_SCORE,true);
  assert.equal(medium.score>=FUTURES_CONFIG.HIGH_RISK_MIN_SCORE,true);
  assert.equal(high.score>=FUTURES_CONFIG.HIGH_RISK_MIN_SCORE,true);
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

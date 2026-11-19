import test from "node:test";
import assert from "node:assert/strict";
import {
  FUTURES_CONFIG,
  isKrakenPerpetualTicker,
  calculateAtr,
  evaluateFuturesEntryFilters,
  analyzeFuturesSymbol,
  getKrakenFuturesCandles
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

test("v3.8.2 configuration is preserved",()=>{
  assert.equal(FUTURES_CONFIG.MAX_SYMBOLS,24);
  assert.equal(FUTURES_CONFIG.CONCURRENCY,3);
  assert.equal(FUTURES_CONFIG.MIN_QUOTE_VOLUME,5_000_000);
  assert.equal(FUTURES_CONFIG.MIN_CANDLES,60);
  assert.equal(FUTURES_CONFIG.MIN_SCORE,72);
  assert.equal(FUTURES_CONFIG.INTERVAL,"1h");
  assert.equal(FUTURES_CONFIG.CONFIRM_INTERVAL,"4h");
  assert.equal(FUTURES_CONFIG.ENTRY_CONFIRM_INTERVAL,"15m");
  assert.equal(FUTURES_CONFIG.MAX_ENTRY_DRIFT_PCT,0.35);
  assert.equal("ENTRY_INTERVAL" in FUTURES_CONFIG,false);
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
  assert.ok(result.score>=72);
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


test("relaxed 1h trend with neutral 4h context is tracked as experimental, never production",()=>{
  const {ticker,oneHour,fifteenMinute}=makeSetup("LONG");
  const neutralFourHour=Array.from({length:120},(_,i)=>({
    time:Date.now()-(120-i)*4*60*60*1000,
    open:100,high:100.1,low:99.9,close:100,volume:100
  }));
  const result=analyzeFuturesSymbol(ticker,oneHour,neutralFourHour,fifteenMinute);
  assert.equal(result.eligible,false);
  assert.equal(result.experimentalEligible,true,JSON.stringify(result));
  assert.ok(result.score>=55);
  assert.ok(result.stop<result.entry && result.target1>result.entry);
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
    ticker:{...ticker,last:ema20+atr*2},candles1h:oneHour,candles15m:fifteenMinute,
    side:"LONG",referencePrice:ema20+atr*2,ema20,atr
  });
  assert.equal(result.ok,false);
  assert.match(result.rejected,/ورود دیرهنگام/);
});

test("15m confirmation rejects opposite momentum",()=>{
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
  assert.match(result.rejected,/۱۵دقیقه‌ای/);
});

test("15m pullback filter rejects a trend continuation without a pullback touch",()=>{
  const {ticker,oneHour,fifteenMinute}=makeSetup("LONG");
  const altered=fifteenMinute.map(c=>({...c,low:c.close-0.001}));
  const ema20=oneHour.slice(-20).reduce((a,c)=>a+c.close,0)/20;
  const atr=calculateAtr(oneHour,14);
  const result=evaluateFuturesEntryFilters({
    ticker,candles1h:oneHour,candles15m:altered,side:"LONG",
    referencePrice:oneHour.at(-1).close,ema20,atr
  });
  assert.equal(result.ok,false);
  assert.match(result.rejected,/پولبک معتبر/);
});

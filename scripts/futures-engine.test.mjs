import test from "node:test";
import assert from "node:assert/strict";
import {
  FUTURES_CONFIG,
  isKrakenPerpetualTicker,
  calculateAtr,
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
  return {
    ticker:{
      symbol:"PF_TESTUSD",last:oneHour.at(-1).close,quoteVolume:12_000_000,
      priceChangePercent:2*direction,premium:{lastFundingRate:0.0001*direction}
    },
    oneHour,fourHour
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

test("legacy 1h/4h strategy generates a LONG without 15m input",()=>{
  const {ticker,oneHour,fourHour}=makeSetup("LONG");
  const result=analyzeFuturesSymbol(ticker,oneHour,fourHour);
  assert.equal(result.side,"LONG");
  assert.equal(result.eligible,true);
  assert.ok(result.score>=72);
  assert.ok(result.stop<result.entry);
  assert.ok(result.target1>result.entry);
  assert.ok(result.target2>result.target1);
  assert.ok(result.target3>result.target2);
  assert.equal(result.rewardRisk,1.5);
  assert.equal(result.candleTime,oneHour.at(-1).time);
});

test("legacy 1h/4h strategy can generate a SHORT",()=>{
  const {ticker,oneHour,fourHour}=makeSetup("SHORT");
  const result=analyzeFuturesSymbol(ticker,oneHour,fourHour);
  assert.equal(result.side,"SHORT");
  assert.equal(result.eligible,true);
  assert.ok(result.stop>result.entry);
  assert.ok(result.target1<result.entry);
  assert.ok(result.target2<result.target1);
  assert.ok(result.target3<result.target2);
});

test("risk distance outside the original 0.2%-8% band is rejected",()=>{
  const {ticker,oneHour,fourHour}=makeSetup("LONG");
  const altered=oneHour.map(x=>({...x}));
  for(let i=altered.length-7;i<altered.length;i++) altered[i].low=altered.at(-1).close-0.01;
  const result=analyzeFuturesSymbol(ticker,altered,fourHour);
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

import test from "node:test";
import assert from "node:assert/strict";
import {
  FUTURES_CONFIG,
  SignalDeliveryCoordinator,
  isKrakenPerpetualTicker,
  calculateAtr,
  analyzeFuturesSymbol,
  getKrakenFuturesCandles,
  getKrakenFuturesUniverse,
  mapLimit
} from "../src/index.js";

function makeTrendShortCandles(count=120) {
  return Array.from({length:count},(_,i)=>{
    const close=160-i*0.12;
    const open=i===0?close+0.1:160-(i-1)*0.12;
    return {
      time:Date.now()-(count-i)*60*60*1000,
      open,
      high:Math.max(open,close)+0.5,
      low:Math.min(open,close)-0.5,
      close,
      volume:100
    };
  });
}

function makeRallyFadeCandles(count=120) {
  const candles=Array.from({length:count},(_,i)=>{
    const close=80+i*0.10;
    const open=i===0?close-0.05:80+(i-1)*0.10;
    return {
      time:Date.now()-(count-i)*60*60*1000,
      open,
      high:Math.max(open,close)+0.2,
      low:Math.min(open,close)-0.2,
      close,
      volume:100
    };
  });
  const last=candles.at(-1);
  const previous=candles.at(-2);
  last.open=last.close+0.8;
  last.high=Math.max(last.open,previous.high+0.25);
  last.low=last.close-0.1;
  return candles;
}

function ticker(symbol="PF_XBTUSD",last=null) {
  return {symbol,last:last??100,volumeQuote:20_000_000,change24h:-2,fundingRate:0};
}

test("admin signal listing returns recent unexpired signals from Durable Object without writes",async()=>{
  const now=Date.now();
  const stored=[
    {id:"old",symbol:"PF_OLDUSD",side:"SHORT",score:80,createdAt:now-5000,expiresAt:now+60000},
    {id:"new",symbol:"PF_NEWUSD",side:"SHORT",score:91,createdAt:now-1000,expiresAt:now+60000},
    {id:"expired",symbol:"PF_EXPIREDUSD",side:"SHORT",score:99,createdAt:now,expiresAt:now-1}
  ];
  const writes=[];
  const ctx={storage:{
    get:async key=>key==="active-futures-pending"?stored:undefined,
    put:async(...args)=>writes.push(args),
    delete:async()=>{}
  }};
  const coordinator=new SignalDeliveryCoordinator(ctx,{SIGNAL_DELIVERY_SECRET:"test-secret"});
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

test("admin signal listing endpoint rejects requests without the Durable Object secret",async()=>{
  const coordinator=new SignalDeliveryCoordinator({storage:{get:async()=>[]}},{SIGNAL_DELIVERY_SECRET:"test-secret"});
  const response=await coordinator.fetch(new Request("https://signal-delivery.internal/signals/list",{
    method:"POST",headers:{"content-type":"application/json"},body:"{}"
  }));
  assert.equal(response.status,401);
});

test("v10.6 SHORT-only configuration is active",()=>{
  assert.equal(FUTURES_CONFIG.CONCURRENCY,3);
  assert.equal(FUTURES_CONFIG.MAX_SIGNALS_PER_SCAN,10);
  assert.equal(FUTURES_CONFIG.MIN_CANDLES,100);
  assert.equal(FUTURES_CONFIG.TARGET_1_R,1.5);
  assert.equal(FUTURES_CONFIG.STOP_BUFFER_ATR,0.2);
  assert.equal(FUTURES_CONFIG.MIN_RISK_PCT,0.5);
  assert.equal(FUTURES_CONFIG.MAX_RISK_PCT,2.0);
  assert.equal(FUTURES_CONFIG.MAX_ATR_PCT,2.0);
  assert.equal(FUTURES_CONFIG.MIN_QUOTE_VOLUME,5_000_000);
  assert.equal("ALLOWED_SYMBOLS" in FUTURES_CONFIG,false);
});

test("Kraken universe remains exchange-wide and is sorted by descending quote volume",async()=>{
  const originalFetch=globalThis.fetch;
  const tickers=Array.from({length:30},(_,i)=>({
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
  const results=await mapLimit([1,2,3,4],1,async value=>{processed.push(value);return value;},()=>processed.length<2);
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
  assert.equal(calculateAtr(makeTrendShortCandles(10),14),null);
  assert.ok(calculateAtr(makeTrendShortCandles(),14)>0);
});

test("v10.6 trend-following setup generates only TREND_SHORT with 1.5R target",()=>{
  const candles=makeTrendShortCandles();
  const result=analyzeFuturesSymbol(ticker("PF_XBTUSD",candles.at(-1).close),candles);
  assert.equal(result.side,"SHORT");
  assert.equal(result.mode,"TREND_SHORT");
  assert.equal(result.strategyId,"v10.6-short-hybrid");
  assert.equal(result.score,80);
  assert.equal(result.eligible,true,JSON.stringify(result));
  assert.ok(result.stop>result.entry);
  assert.ok(result.target1<result.entry);
  assert.ok(Math.abs((result.entry-result.target1)/(result.stop-result.entry)-1.5)<1e-9);
  assert.ok(result.riskPct>=0.5&&result.riskPct<=2.0);
});

test("v10.6 rally-fade setup generates a higher-score RALLY_FADE SHORT",()=>{
  const candles=makeRallyFadeCandles();
  const result=analyzeFuturesSymbol(ticker("PF_ETHUSD",candles.at(-1).close),candles);
  assert.equal(result.side,"SHORT");
  assert.equal(result.mode,"RALLY_FADE");
  assert.equal(result.score,90);
  assert.equal(result.eligible,true,JSON.stringify(result));
  assert.ok(result.stop>result.entry);
  assert.ok(result.target1<result.entry);
  assert.ok(result.target2<result.target1);
  assert.ok(result.target3<result.target2);
});

test("v10.6 analyzes eligible high-volume symbols outside the former hard-coded ten",()=>{
  const candles=makeTrendShortCandles();
  const result=analyzeFuturesSymbol(ticker("PF_TESTUSD",candles.at(-1).close),candles);
  assert.equal(result.symbol,"PF_TESTUSD");
  assert.equal(result.side,"SHORT");
  assert.equal(result.eligible,true,JSON.stringify(result));
});

test("v10.6 rejects fewer than 100 hourly candles",()=>{
  assert.throws(()=>analyzeFuturesSymbol(ticker("PF_XBTUSD",100),makeTrendShortCandles(99)),/کافی نیست/);
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

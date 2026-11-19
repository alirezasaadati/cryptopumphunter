import test from "node:test";
import assert from "node:assert/strict";
import { aggregateCandles, runHistoricalComparison } from "../src/backtest/replay.js";
import { fetchBinanceKlines } from "../src/backtest/binance-history.js";

test("aggregates 5m candles into completed 1h buckets",()=>{
  const rows=Array.from({length:12},(_,i)=>({openTime:i*300000,closeTime:(i+1)*300000-1,open:100+i,high:102+i,low:99+i,close:101+i,volume:2}));
  const out=aggregateCandles(rows,3600000);
  assert.equal(out.length,1);
  assert.equal(out[0].open,100);
  assert.equal(out[0].close,112);
  assert.equal(out[0].volume,24);
});

test("historical downloader paginates and normalizes Binance klines",async()=>{
  const rows=Array.from({length:2},(_,i)=>[i*300000,"1","2","0.5","1.5","10",(i+1)*300000-1,"15",4,"6","9","0"]);
  const fetchImpl=async()=>new Response(JSON.stringify(rows),{status:200});
  const out=await fetchBinanceKlines({symbol:"BTCUSDT",interval:"5m",days:1,endTime:86400000,fetchImpl});
  assert.ok(Array.isArray(out));
  assert.equal(out[0].close,1.5);
});

test("comparison returns both independent model summaries",()=>{
  const candles=[];
  for(let i=0;i<1200;i++){
    const p=100+i*0.01+Math.sin(i/7);
    candles.push({openTime:i*300000,closeTime:(i+1)*300000-1,open:p,high:p+0.2,low:p-0.2,close:p+0.05,volume:100+i%9});
  }
  const result=runHistoricalComparison({BTCUSDT:candles});
  assert.deepEqual(result.models.map(x=>x.model),["A","B"]);
  assert.equal(result.candleInterval,"5m");
  assert.equal(result.assumptions.stopWinsWhenStopAndTargetTouchSameCandle,true);
});

test("does not promote incomplete higher-timeframe candles",()=>{
  const rows=Array.from({length:11},(_,i)=>({openTime:i*300000,closeTime:(i+1)*300000-1,open:100,high:102,low:99,close:101,volume:1}));
  assert.equal(aggregateCandles(rows,3600000).length,0);
});

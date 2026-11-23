import test from "node:test";
import assert from "node:assert/strict";
import { analyzeFuturesSymbol, computeBtcRegime, FUTURES_CONFIG, tradeResultR } from "../src/index.js";
import { evaluateTradeCandleR } from "../src/futures-trade-lifecycle.js";

function makeCandles({count=120,slope=0.015,base=100,volume=100}={}) {
  const closes=Array.from({length:count},(_,i)=>base+i*slope+(i%2?0.12:-0.12));
  return closes.map((close,i)=>{
    const open=i?closes[i-1]:close-0.1, last=i===count-1;
    return {time:Date.now()-(count-i)*3600000,open,
      high:last?close+0.05:Math.max(open,close)+0.08,
      low:last?open-0.05:Math.min(open,close)-0.08,close,volume:last?volume*2:volume};
  });
}
function setup(side){
  const d=side==="LONG"?1:-1;
  const one=makeCandles({slope:0.015*d}), four=makeCandles({slope:0.04*d});
  return {one,four,ticker:{symbol:"PF_TESTUSD",last:one.at(-1).close,quoteVolume:12e6,
    priceChangePercent:2*d,premium:{lastFundingRate:0.0001*d}}};
}
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-9,`${a} != ${b}`);
const longTrade=()=>({side:"LONG",status:"OPEN",entry:100,actualEntry:100,initialStop:98,currentStop:98,
  target1:103,target2:104.4,target3:106,tpHits:[],realizedR:0,remainingFraction:1});
const shortTrade=()=>({side:"SHORT",status:"OPEN",entry:100,actualEntry:100,initialStop:102,currentStop:102,
  target1:97,target2:95.6,target3:94,tpHits:[],realizedR:0,remainingFraction:1});

test("BTC regime", () => {
  const up=Array.from({length:80},(_,i)=>({close:100+i*0.5}));
  const dn=Array.from({length:80},(_,i)=>({close:200-i*0.5}));
  assert.equal(computeBtcRegime(up).longAllowed,true);
  assert.equal(computeBtcRegime(dn).longAllowed,false);
  assert.equal(computeBtcRegime(up.slice(0,10)).ok,false);
});

test("LONG is blocked by a bearish BTC regime while SHORT is not BTC-blocked", () => {
  const L=setup("LONG");
  const blocked=analyzeFuturesSymbol(L.ticker,L.one,L.four,[],{btcRegime:{ok:true,longAllowed:false,reason:"BTC-BLOCK"}});
  assert.equal(blocked.rejected,"BTC-BLOCK");
  const S=setup("SHORT");
  const short=analyzeFuturesSymbol(S.ticker,S.one,S.four,[],{btcRegime:{ok:true,longAllowed:false,reason:"BTC-BLOCK"}});
  assert.notEqual(short.rejected,"BTC-BLOCK");
});

test("LONG requires 15m momentum and pullback confirmation", () => {
  const L=setup("LONG");
  const r=analyzeFuturesSymbol(L.ticker,L.one,L.four,[],{btcRegime:{ok:true,longAllowed:true}});
  assert.match(r.rejected,/الزامی/);
  assert.equal(FUTURES_CONFIG.LONG_RSI_MAX,62);
});

test("scaled exits realize 2.12R at the three configured targets", () => {
  let trade=longTrade();
  for (const c of [{open:101,high:103.1,low:100.5},{open:103.5,high:104.5,low:103},{open:105,high:106.2,low:104}]) {
    const result=evaluateTradeCandleR(trade,{...c,time:1});
    trade=result.trade;
  }
  assert.equal(trade.status,"CLOSED_PROFIT");
  near(trade.outcomeR,2.12);
});

test("TP1 realizes 0.6R, moves stop to breakeven, and then closes remaining size at breakeven", () => {
  const first=evaluateTradeCandleR(longTrade(),{open:101,high:103.1,low:100.5,time:1});
  assert.equal(first.closed,false);
  near(first.trade.realizedR,0.6);
  assert.equal(first.trade.currentStop,100);
  const second=evaluateTradeCandleR(first.trade,{open:101,high:101.5,low:99.9,time:2});
  assert.equal(second.closed,true);
  assert.equal(second.trade.status,"CLOSED_PROFIT");
  near(second.trade.outcomeR,0.6);
});

test("SHORT scaled exits also realize 2.12R", () => {
  let trade=shortTrade();
  for (const c of [{open:99,high:99.5,low:96.9},{open:96.5,high:97,low:95.5},{open:95,high:96,low:93.9}]) {
    trade=evaluateTradeCandleR(trade,{...c,time:1}).trade;
  }
  near(trade.outcomeR,2.12);
});

test("gap through initial stop uses the opening price", () => {
  const result=evaluateTradeCandleR(longTrade(),{open:96,high:97,low:95,time:1});
  assert.equal(result.trade.status,"CLOSED_STOP");
  near(result.trade.outcomeR,-2);
});

test("R reporting prefers the stored realized outcome", () => {
  near(tradeResultR({outcomeR:0.6,initialRisk:2,actualEntry:100,target1:103,tpHits:["TP1"]}),0.6);
});

test("invalid TP weights are rejected without changing the trade", () => {
  const trade=longTrade();
  const result=evaluateTradeCandleR(trade,{open:100,high:104,low:99,time:1},{weights:[0.4,0.4,0.4]});
  assert.equal(result.error,"INVALID_TP_WEIGHTS");
  assert.equal(result.trade,trade);
});

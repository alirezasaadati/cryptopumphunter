import test from "node:test";
import assert from "node:assert/strict";
import { analyzeFuturesSymbol, computeBtcRegime, FUTURES_CONFIG, tradeResultR } from "../src/index.js";
import { evaluateTradeCandleR, TP_WEIGHTS } from "../src/futures-trade-lifecycle.js";

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
  target1:103,target2:104.4,target3:106,tpHits:[]});
const shortTrade=()=>({side:"SHORT",status:"OPEN",entry:100,actualEntry:100,initialStop:102,currentStop:102,
  target1:97,target2:95.6,target3:94,tpHits:[]});

test("BTC regime uses only sufficiently long 4h history", () => {
  const up=Array.from({length:80},(_,i)=>({close:100+i*0.5}));
  const dn=Array.from({length:80},(_,i)=>({close:200-i*0.5}));
  assert.equal(computeBtcRegime(up).longAllowed,true);
  assert.equal(computeBtcRegime(dn).longAllowed,false);
  assert.equal(computeBtcRegime(up.slice(0,10)).ok,false);
});

test("BTC bearish regime blocks LONG but does not apply the BTC gate to SHORT", () => {
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
  assert.deepEqual(FUTURES_CONFIG.ENFORCE_15M_CONFIRM_SIDES,["LONG"]);
});

test("scaled exit weights and target R produce 2.12R at full target", () => {
  assert.deepEqual(TP_WEIGHTS,[0.40,0.35,0.25]);
  let t=longTrade();
  for (const c of [{open:101,high:103.1,low:100.5},{open:102,high:104.5,low:101},{open:105,high:106.2,low:104}]) {
    const result=evaluateTradeCandleR(t,{...c,time:1});
    t=result.trade;
  }
  assert.equal(t.status,"CLOSED_PROFIT");
  near(t.outcomeR,2.12);
});

test("TP1 partial close then breakeven stop closes the remainder at 0R", () => {
  const a=evaluateTradeCandleR(longTrade(),{open:101,high:103.1,low:100.5,time:1});
  assert.equal(a.closed,false);
  near(a.trade.realizedR,0.6);
  assert.equal(a.trade.currentStop,100);
  const b=evaluateTradeCandleR(a.trade,{open:101,high:101.5,low:99.9,time:2});
  assert.equal(b.trade.status,"CLOSED_PROFIT");
  near(b.trade.outcomeR,0.6);
});

test("initial stop is evaluated conservatively before targets", () => {
  const result=evaluateTradeCandleR(longTrade(),{open:100,high:103.2,low:97.9,time:1});
  assert.equal(result.trade.status,"CLOSED_STOP");
  near(result.trade.outcomeR,-1);
});

test("SHORT scaled exits produce the same 2.12R profile", () => {
  let t=shortTrade();
  for (const c of [{open:99,high:99.5,low:96.9},{open:98,high:99,low:95.5},{open:95,high:96,low:93.9}]) {
    t=evaluateTradeCandleR(t,{...c,time:1}).trade;
  }
  near(t.outcomeR,2.12);
});

test("R result prefers persisted outcomeR over legacy TP1-only estimate", () => {
  near(tradeResultR({outcomeR:0.6,initialRisk:2,actualEntry:100,target1:103,tpHits:["TP1"]}),0.6);
});

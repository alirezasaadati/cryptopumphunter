import test from "node:test";
import assert from "node:assert/strict";
import { issuedSignalKey, saveIssuedSignal, updateIssuedSignal, listIssuedSignals, issuedSignalSymbols } from "../src/signal-ledger.js";
import { signalOutboxKey, signalOutboxAction } from "../src/signal-outbox.js";

function memoryKV() {
  const data = new Map();
  return {
    async get(key, type) { const value=data.get(key); if(value===undefined)return null; return type==="json"?JSON.parse(value):value; },
    async put(key,value) { data.set(key,String(value)); },
    async list({prefix="",limit=1000}={}) { return {keys:[...data.keys()].filter(k=>k.startsWith(prefix)).slice(0,limit).map(name=>({name})),list_complete:true}; }
  };
}
const signal={id:"sig-1",symbol:"BTC-PERP",side:"LONG",entry:100,stop:95,target1:105,target2:110,target3:115,createdAt:Date.now(),score:85};

test("published signals are archived once and retained without TTL",async()=>{
  const kv=memoryKV();
  assert.equal(await saveIssuedSignal(kv,123,signal,{id:"trade-1"}),true);
  assert.equal(await saveIssuedSignal(kv,123,signal,{id:"trade-1"}),false);
  const rows=await listIssuedSignals(kv,123);
  assert.equal(rows.length,1);
  assert.equal(rows[0].status,"OPEN");
  assert.equal(rows[0].tradeId,"trade-1");
  assert.ok(await kv.get(issuedSignalKey(123,signal.symbol,signal.id)));
});

test("archive updates preserve TP milestones and final stop result",async()=>{
  const kv=memoryKV();
  await saveIssuedSignal(kv,123,signal);
  await updateIssuedSignal(kv,123,{signalId:"sig-1",symbol:"BTC-PERP",status:"CLOSED_STOP",tpHits:["TP1","TP2"],closeReason:"STOP_LOSS",exitPrice:99,outcomePercent:2.1});
  const [row]=await listIssuedSignals(kv,123,{symbol:"BTC-PERP"});
  assert.deepEqual(row.tpHits,["TP1","TP2"]);
  assert.equal(row.status,"CLOSED_STOP");
  assert.equal(row.closeReason,"STOP_LOSS");
  assert.deepEqual(issuedSignalSymbols([row]),["BTC-PERP"]);
});

test("history filtering can isolate completed signals",async()=>{
  const kv=memoryKV();
  await saveIssuedSignal(kv,123,signal);
  await saveIssuedSignal(kv,123,{...signal,id:"sig-2",symbol:"ETH-PERP"});
  await updateIssuedSignal(kv,123,{signalId:"sig-2",symbol:"ETH-PERP",status:"CLOSED_TARGETS",closeReason:"TP3",tpHits:["TP1","TP2","TP3"]});
  const all=await listIssuedSignals(kv,123);
  assert.equal(all.length,2);
  assert.equal(all.filter(x=>String(x.status).startsWith("CLOSED")).length,1);
});


test("archive updates never erase earlier TP milestones or coerce null prices to zero",async()=>{
  const kv=memoryKV();
  await saveIssuedSignal(kv,123,signal);
  await updateIssuedSignal(kv,123,{signalId:"sig-1",symbol:"BTC-PERP",status:"OPEN",tpHits:["TP1","TP2"],exitPrice:null,outcomePercent:null,outcomeR:null});
  await updateIssuedSignal(kv,123,{signalId:"sig-1",symbol:"BTC-PERP",status:"CLOSED_STOP",tpHits:[],exitPrice:99,outcomePercent:1.25,outcomeR:0.25});
  const [row]=await listIssuedSignals(kv,123);
  assert.deepEqual(row.tpHits,["TP1","TP2"]);
  assert.equal(row.exitPrice,99);
  assert.equal(row.outcomePercent,1.25);
});

test("archive rejects malformed signal prices instead of storing zero-valued levels",async()=>{
  const kv=memoryKV();
  await assert.rejects(
    saveIssuedSignal(kv,123,{...signal,entry:null}),
    /invalid price levels/
  );
});


test("outbox sends only queued work and resumes archive after confirmed Telegram delivery",()=>{
  assert.equal(signalOutboxKey(123,"sig-1"),"futures:signal-outbox:v1:123:sig-1");
  assert.equal(signalOutboxAction(null),"send");
  assert.equal(signalOutboxAction({status:"QUEUED"}),"send");
  assert.equal(signalOutboxAction({status:"SENT",telegramMessageId:42}),"archive");
  assert.equal(signalOutboxAction({status:"ARCHIVED"}),"done");
});

test("outbox never blindly resends ambiguous in-flight or uncertain Telegram deliveries",()=>{
  assert.equal(signalOutboxAction({status:"SENDING"}),"reconcile");
  assert.equal(signalOutboxAction({status:"UNCERTAIN"}),"reconcile");
});

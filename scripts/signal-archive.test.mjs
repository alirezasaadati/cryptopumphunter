import test from "node:test";
import assert from "node:assert/strict";
import {
  archivePublishedSignal, updateArchivedSignal, listArchivedSymbols,
  listArchivedSignals, signalArchiveKeyForTest
} from "../src/signal-archive.js";

class MemoryKV {
  constructor(){ this.data=new Map(); }
  async get(key){ return this.data.get(key) ?? null; }
  async put(key,value){ this.data.set(key,String(value)); }
  async delete(key){ this.data.delete(key); }
  async list({prefix="",limit=1000,cursor}={}){
    const all=[...this.data.keys()].filter(k=>k.startsWith(prefix)).sort();
    const start=cursor ? Math.max(0,all.findIndex(k=>k>cursor)) : 0;
    const keys=all.slice(start,start+limit).map(name=>({name}));
    const complete=start+limit>=all.length;
    return {keys,list_complete:complete,cursor:complete?undefined:keys.at(-1)?.name};
  }
}

test("published signals are archived idempotently without TTL and indexed by symbol",async()=>{
  const env={APP_KV:new MemoryKV()};
  const signal={id:"sig-1",symbol:"BTCUSDT",side:"LONG",entry:100,stop:95,target1:105,target2:110,target3:115};
  const first=await archivePublishedSignal(env,123,signal,{id:"trade-1"},"2026-11-18T08:00:00.000Z");
  const second=await archivePublishedSignal(env,123,signal,{id:"trade-1"},"2026-11-18T08:00:00.000Z");
  assert.equal(first.created,true);
  assert.equal(second.created,false);
  assert.equal(await env.APP_KV.get(signalArchiveKeyForTest(123,"sig-1"))!==null,true);
  assert.deepEqual(await listArchivedSymbols(env,123,"archive"),["BTC"]);
  const listed=await listArchivedSignals(env,123,"BTC","archive");
  assert.equal(listed.records.length,1);
  assert.equal(listed.records[0].tradeId,"trade-1");
});

test("closing removes only open index and preserves archive plus completed history",async()=>{
  const env={APP_KV:new MemoryKV()};
  const signal={id:"sig-2",symbol:"BTCUSDT",side:"SHORT",entry:100,stop:105,target1:95,target2:90,target3:85};
  await archivePublishedSignal(env,456,signal,null,"2026-11-18T08:00:00.000Z");
  const updated=await updateArchivedSignal(env,456,"sig-2",{
    milestones:["TP1","TP2"],status:"CLOSED_STOP",finalResult:"STOP",
    closedAt:"2026-11-18T09:00:00.000Z",exitPrice:105,outcomePercent:1
  });
  assert.deepEqual(updated.milestones,["TP1","TP2"]);
  assert.equal((await listArchivedSignals(env,456,"BTC","open")).records.length,0);
  assert.equal((await listArchivedSignals(env,456,"BTC","history")).records.length,1);
  assert.equal((await listArchivedSignals(env,456,"BTC","archive")).records.length,1);
  assert.deepEqual(await listArchivedSymbols(env,456,"history"),["BTC"]);
});

test("archive supports multiple symbols without cross-contaminating symbol history",async()=>{
  const env={APP_KV:new MemoryKV()};
  for(const [id,symbol] of [["a","BTCUSDT"],["b","ETHUSDT"]]){
    await archivePublishedSignal(env,789,{id,symbol,side:"LONG",entry:1,stop:.9,target1:1.1,target2:1.2,target3:1.3});
  }
  assert.deepEqual(await listArchivedSymbols(env,789),["BTC","ETH"]);
  assert.equal((await listArchivedSignals(env,789,"ETH","archive")).records[0].signalId,"b");
});

test("archive pagination returns newest signals first and isolates each page",async()=>{
  const env={APP_KV:new MemoryKV()};
  for(let i=1;i<=4;i++){
    await archivePublishedSignal(env,111,{id:"p"+i,symbol:"BTCUSDT",side:"LONG",entry:100,stop:95,target1:105,target2:110,target3:115},null,`2026-11-18T0${i}:00:00.000Z`);
  }
  const first=await listArchivedSignals(env,111,"BTC","archive",2);
  assert.deepEqual(first.records.map(x=>x.signalId),["p4","p3"]);
  assert.ok(first.cursor);
  const second=await listArchivedSignals(env,111,"BTC","archive",2,first.cursor);
  assert.deepEqual(second.records.map(x=>x.signalId),["p2","p1"]);
  assert.equal(second.cursor,null);
});

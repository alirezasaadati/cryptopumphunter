import test from "node:test";
import assert from "node:assert/strict";
import { saveIssuedSignal, updateIssuedSignal, listIssuedSignals } from "../src/signal-ledger.js";
import { signalOutboxAction } from "../src/signal-outbox.js";

function memoryKV({ pageSize = 1000, failNextPut = false } = {}) {
  const data = new Map();
  let shouldFailPut = failNextPut;
  return {
    data,
    async get(key, type) {
      const value = data.get(key);
      if (value === undefined) return null;
      return type === "json" ? JSON.parse(value) : value;
    },
    async put(key, value) {
      if (shouldFailPut) { shouldFailPut = false; throw new Error("simulated KV write failure"); }
      data.set(key, String(value));
    },
    async list({ prefix = "", limit = pageSize, cursor } = {}) {
      const keys = [...data.keys()].filter(k => k.startsWith(prefix)).sort();
      const offset = cursor ? Number(cursor) : 0;
      const page = keys.slice(offset, offset + Math.min(limit, pageSize));
      const next = offset + page.length;
      return { keys: page.map(name => ({ name })), list_complete: next >= keys.length, cursor: next < keys.length ? String(next) : undefined };
    }
  };
}

const signal = (id, symbol = "BTC-PERP") => ({
  id, symbol, side: "LONG", entry: 100, stop: 95,
  target1: 105, target2: 110, target3: 115, createdAt: Date.now()
});

test("archive listing paginates across KV pages and remains isolated by chat", async () => {
  const kv = memoryKV({ pageSize: 2 });
  for (let i = 0; i < 5; i++) await saveIssuedSignal(kv, 101, signal("btc-" + i, i % 2 ? "ETH-PERP" : "BTC-PERP"));
  await saveIssuedSignal(kv, 202, signal("private-user-signal"));
  const rows = await listIssuedSignals(kv, 101);
  assert.equal(rows.length, 5);
  assert.ok(rows.every(x => x.chatId === "101"));
  assert.equal((await listIssuedSignals(kv, 202)).length, 1);
  assert.equal((await listIssuedSignals(kv, 101, { symbol: "BTC-PERP" })).length, 3);
});

test("failed archive write can be retried without losing the signal", async () => {
  const kv = memoryKV({ failNextPut: true });
  await assert.rejects(saveIssuedSignal(kv, 303, signal("retry-me")), /simulated KV write failure/);
  assert.equal((await listIssuedSignals(kv, 303)).length, 0);
  assert.equal(await saveIssuedSignal(kv, 303, signal("retry-me")), true);
  assert.equal((await listIssuedSignals(kv, 303)).length, 1);
});

test("archive keeps closed outcomes and open signals independently queryable", async () => {
  const kv = memoryKV();
  await saveIssuedSignal(kv, 404, signal("open"));
  await saveIssuedSignal(kv, 404, signal("closed", "ETH-PERP"));
  await updateIssuedSignal(kv, 404, {
    signalId: "closed", symbol: "ETH-PERP", status: "CLOSED_STOP",
    tpHits: ["TP1", "TP2"], closeReason: "STOP_LOSS",
    exitPrice: 99, outcomePercent: 2.1, outcomeR: 0.42
  });
  assert.equal((await listIssuedSignals(kv, 404)).length, 2);
  assert.equal((await listIssuedSignals(kv, 404, { status: "OPEN" })).length, 1);
  const [closed] = await listIssuedSignals(kv, 404, { symbol: "ETH-PERP" });
  assert.equal(closed.status, "CLOSED_STOP");
  assert.deepEqual(closed.tpHits, ["TP1", "TP2"]);
  assert.equal(closed.outcomeR, 0.42);
});

test("outbox recovery policy distinguishes safe resume from ambiguous delivery", () => {
  assert.equal(signalOutboxAction({ status: "QUEUED" }), "send");
  assert.equal(signalOutboxAction({ status: "SENT", telegramMessageId: 77 }), "archive");
  assert.equal(signalOutboxAction({ status: "ARCHIVED" }), "done");
  assert.equal(signalOutboxAction({ status: "SENDING" }), "reconcile");
  assert.equal(signalOutboxAction({ status: "UNCERTAIN" }), "reconcile");
});


test("repeated sequential registration is idempotent and does not overwrite the first snapshot", async () => {
  const kv = memoryKV();
  assert.equal(await saveIssuedSignal(kv, 505, signal("same")), true);
  const changed = { ...signal("same"), entry: 101, score: 99 };
  assert.equal(await saveIssuedSignal(kv, 505, changed), false);
  const [saved] = await listIssuedSignals(kv, 505);
  assert.equal(saved.entry, 100);
});

test("same signal id in different chats and symbols has separate archive keys", async () => {
  const kv = memoryKV();
  await saveIssuedSignal(kv, 11, signal("collision", "BTC-PERP"));
  await saveIssuedSignal(kv, 11, signal("collision", "ETH-PERP"));
  await saveIssuedSignal(kv, 22, signal("collision", "BTC-PERP"));
  assert.equal((await listIssuedSignals(kv, 11)).length, 2);
  assert.equal((await listIssuedSignals(kv, 22)).length, 1);
  assert.equal((await listIssuedSignals(kv, 11, { symbol: "BTC-PERP" })).length, 1);
});

test("archive preserves completed result when later update omits close fields", async () => {
  const kv = memoryKV();
  await saveIssuedSignal(kv, 606, signal("closed"));
  await updateIssuedSignal(kv, 606, {
    signalId: "closed", symbol: "BTC-PERP", status: "CLOSED_STOP",
    tpHits: ["TP1"], closeReason: "STOP_LOSS", exitPrice: 95,
    outcomePercent: -1.25, outcomeR: -0.25
  });
  await updateIssuedSignal(kv, 606, {
    signalId: "closed", symbol: "BTC-PERP", status: "CLOSED_STOP",
    tpHits: ["TP2"]
  });
  const [saved] = await listIssuedSignals(kv, 606);
  assert.equal(saved.status, "CLOSED_STOP");
  assert.equal(saved.closeReason, "STOP_LOSS");
  assert.equal(saved.exitPrice, 95);
  assert.equal(saved.outcomeR, -0.25);
  assert.deepEqual(saved.tpHits, ["TP1", "TP2"]);
});

test("archive listing returns newest published signals first", async () => {
  const kv = memoryKV();
  await saveIssuedSignal(kv, 707, signal("older"));
  await new Promise(resolve => setTimeout(resolve, 3));
  await saveIssuedSignal(kv, 707, signal("newer"));
  const rows = await listIssuedSignals(kv, 707);
  assert.equal(rows[0].id, "newer");
  assert.equal(rows[1].id, "older");
});

test("outbox keys are isolated by chat and signal identity", async () => {
  const { signalOutboxKey } = await import("../src/signal-outbox.js");
  assert.notEqual(signalOutboxKey(1, "abc"), signalOutboxKey(2, "abc"));
  assert.notEqual(signalOutboxKey(1, "abc"), signalOutboxKey(1, "def"));
});

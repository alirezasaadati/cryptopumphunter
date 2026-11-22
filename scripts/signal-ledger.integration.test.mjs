import test from "node:test";
import assert from "node:assert/strict";
import { saveIssuedSignal, updateIssuedSignal, listIssuedSignals } from "../src/signal-ledger.js";
import { signalOutboxAction } from "../src/signal-outbox.js";
import { createSerialExecutor } from "../src/serial-executor.js";
import { SignalDeliveryCoordinator } from "../src/index.js";

const TEST_DELIVERY_SECRET = "unit-test-delivery-secret";

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

function memoryStorage() {
  const data = new Map();
  return {
    data,
    async get(key) { const value = data.get(key); return value === undefined ? undefined : structuredClone(value); },
    async put(key, value) { data.set(key, structuredClone(value)); },
    async delete(key) { return data.delete(key); },
    async transaction(callback) {
      const draft = new Map([...data.entries()].map(([key, value]) => [key, structuredClone(value)]));
      const tx = {
        async get(key) { const value = draft.get(key); return value === undefined ? undefined : structuredClone(value); },
        async put(key, value) { draft.set(key, structuredClone(value)); },
        async delete(key) { return draft.delete(key); }
      };
      const result = await callback(tx);
      data.clear();
      for (const [key, value] of draft) data.set(key, value);
      return result;
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
  assert.equal(signalOutboxAction({ status: "ARCHIVE_PENDING", telegramMessageId: 77 }), "archive");
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


test("durable-object serial executor prevents overlapping deliveries for one signal key", async () => {
  const run = createSerialExecutor();
  let active = 0;
  let maxActive = 0;
  const order = [];
  const task = (name) => run(async () => {
    active++;
    maxActive = Math.max(maxActive, active);
    order.push("start:" + name);
    await new Promise(resolve => setTimeout(resolve, 5));
    order.push("end:" + name);
    active--;
    return name;
  });
  const results = await Promise.all([task("first"), task("second"), task("third")]);
  assert.deepEqual(results, ["first", "second", "third"]);
  assert.equal(maxActive, 1);
  assert.deepEqual(order, [
    "start:first", "end:first",
    "start:second", "end:second",
    "start:third", "end:third"
  ]);
});

test("serial executor continues processing after an earlier delivery fails", async () => {
  const run = createSerialExecutor();
  await assert.rejects(run(async () => { throw new Error("simulated delivery failure"); }), /simulated delivery failure/);
  assert.equal(await run(async () => "next delivery"), "next delivery");
});


test("coordinator rejects missing or incorrect internal authentication secret", async () => {
  const coordinator = new SignalDeliveryCoordinator({}, { APP_KV: memoryKV(), SIGNAL_DELIVERY_SECRET: TEST_DELIVERY_SECRET });
  const response = await coordinator.fetch(new Request("https://signal-delivery.internal/deliver", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chatId: "1", signal: { id: "unauthorized", symbol: "BTC-PERP", side: "LONG" }, messageText: "no" })
  }));
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error, "Unauthorized.");
});

test("owner reconciliation confirms uncertain delivery without creating a duplicate KV ledger entry", async () => {
  const kv = memoryKV();
  const pending = signal("uncertain-confirm");
  const key = "futures:signal-outbox:v1:909:uncertain-confirm";
  await kv.put(key, JSON.stringify({
    version: 1, chatId: "909", signalId: pending.id, symbol: pending.symbol,
    status: "UNCERTAIN", signal: pending, messageText: "test signal",
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
  }));
  const coordinator = new SignalDeliveryCoordinator({}, { APP_KV: kv, SIGNAL_DELIVERY_SECRET: TEST_DELIVERY_SECRET });
  const request = () => new Request("https://signal-delivery.internal/reconcile", {
    method: "POST", headers: { "content-type": "application/json", "x-signal-delivery-secret": TEST_DELIVERY_SECRET },
    body: JSON.stringify({ action: "confirm_delivered", chatId: "909", signalId: pending.id })
  });
  const first = await coordinator.fetch(request());
  assert.equal(first.status, 200);
  assert.equal((await first.json()).result.confirmed, true);
  const saved = await kv.get(key, "json");
  assert.equal(saved.status, "ARCHIVED");
  assert.ok(saved.manualConfirmedAt);
  assert.equal((await listIssuedSignals(kv, "909")).length, 0);
  const second = await coordinator.fetch(request());
  assert.equal(second.status, 200);
  assert.equal((await second.json()).result.alreadyArchived, true);
  assert.equal((await listIssuedSignals(kv, "909")).length, 0);
});

test("owner reconciliation refuses to auto-archive legacy uncertain records without a signal snapshot", async () => {
  const kv = memoryKV();
  await kv.put("futures:signal-outbox:v1:910:legacy", JSON.stringify({
    chatId: "910", signalId: "legacy", symbol: "BTC-PERP", status: "UNCERTAIN"
  }));
  const coordinator = new SignalDeliveryCoordinator({}, { APP_KV: kv, SIGNAL_DELIVERY_SECRET: TEST_DELIVERY_SECRET });
  const response = await coordinator.fetch(new Request("https://signal-delivery.internal/reconcile", {
    method: "POST", headers: { "content-type": "application/json", "x-signal-delivery-secret": TEST_DELIVERY_SECRET },
    body: JSON.stringify({ action: "confirm_delivered", chatId: "910", signalId: "legacy" })
  }));
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /no signal snapshot/);
  assert.equal((await kv.get("futures:signal-outbox:v1:910:legacy", "json")).status, "UNCERTAIN");
});


test("concurrent duplicate deliveries use durable storage and send one Telegram message", async () => {
  const storage = memoryStorage();
  const coordinator = new SignalDeliveryCoordinator({ storage }, { BOT_TOKEN: "test-token", SIGNAL_DELIVERY_SECRET: TEST_DELIVERY_SECRET });
  const originalFetch = globalThis.fetch;
  let sendCalls = 0;
  globalThis.fetch = async () => {
    sendCalls++;
    await new Promise(resolve => setTimeout(resolve, 5));
    return new Response(JSON.stringify({ ok: true, result: { message_id: 321 } }), { status: 200 });
  };
  const pending = signal("concurrent-once");
  const request = () => new Request("https://signal-delivery.internal/deliver", {
    method: "POST", headers: { "content-type": "application/json", "x-signal-delivery-secret": TEST_DELIVERY_SECRET },
    body: JSON.stringify({ chatId: "911", signal: pending, messageText: "test signal" })
  });
  try {
    const responses = await Promise.all([coordinator.fetch(request()), coordinator.fetch(request())]);
    const results = await Promise.all(responses.map(x => x.json()));
    assert.equal(sendCalls, 1);
    assert.equal(results.filter(x => x.ok && x.result.duplicate === false).length, 1);
    assert.equal(results.filter(x => x.ok && x.result.duplicate === true).length, 1);
    assert.equal((await storage.get("signal-outbox:futures:signal-outbox:v1:911:concurrent-once")).status, "ARCHIVED");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("legacy owner-authorized retry is transferred to durable storage before sending", async () => {
  const kv = memoryKV(), storage = memoryStorage();
  const pending = signal("uncertain-retry");
  const key = "futures:signal-outbox:v1:912:uncertain-retry";
  await kv.put(key, JSON.stringify({
    version: 1, chatId: "912", signalId: pending.id, symbol: pending.symbol,
    status: "UNCERTAIN", signal: pending, messageText: "retry signal",
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
  }));
  const coordinator = new SignalDeliveryCoordinator({ storage }, { APP_KV: kv, BOT_TOKEN: "test-token", SIGNAL_DELIVERY_SECRET: TEST_DELIVERY_SECRET });
  const originalFetch = globalThis.fetch;
  let sendCalls = 0;
  globalThis.fetch = async (_url, options) => {
    sendCalls++;
    const body = JSON.parse(options.body);
    assert.equal(body.text, "retry signal");
    return new Response(JSON.stringify({ ok: true, result: { message_id: 654 } }), { status: 200 });
  };
  try {
    const response = await coordinator.fetch(new Request("https://signal-delivery.internal/reconcile", {
      method: "POST", headers: { "content-type": "application/json", "x-signal-delivery-secret": TEST_DELIVERY_SECRET },
      body: JSON.stringify({ action: "retry", chatId: "912", signalId: pending.id })
    }));
    assert.equal(response.status, 200);
    assert.equal((await response.json()).ok, true);
    assert.equal(sendCalls, 1);
    assert.equal((await storage.get("signal-outbox:"+key)).status, "ARCHIVED");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("network timeout is persisted as UNCERTAIN in Durable Object storage and never auto-resends", async () => {
  const storage = memoryStorage();
  const pending = signal("timeout-ambiguous");
  const coordinator = new SignalDeliveryCoordinator({ storage }, { BOT_TOKEN: "test-token", SIGNAL_DELIVERY_SECRET: TEST_DELIVERY_SECRET });
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    throw new Error("simulated socket timeout after request dispatch");
  };
  try {
    const request = () => new Request("https://signal-delivery.internal/deliver", {
      method: "POST", headers: { "content-type": "application/json", "x-signal-delivery-secret": TEST_DELIVERY_SECRET },
      body: JSON.stringify({ chatId: "913", signal: pending, messageText: "timeout test" })
    });
    const first = await coordinator.fetch(request());
    assert.equal(first.status, 409);
    assert.equal((await storage.get("signal-outbox:futures:signal-outbox:v1:913:timeout-ambiguous")).status, "UNCERTAIN");
    const second = await new SignalDeliveryCoordinator({ storage }, { BOT_TOKEN: "test-token", SIGNAL_DELIVERY_SECRET: TEST_DELIVERY_SECRET }).fetch(request());
    assert.equal(second.status, 409);
    assert.equal(calls, 1);
  } finally { globalThis.fetch = originalFetch; }
});

test("worker interruption leaves SENDING durable state and restart blocks duplicate send", async () => {
  const base = memoryStorage();
  const storage = {
    get: (...args) => base.get(...args),
    async put(key, value) {
      if (value.status === "UNCERTAIN") throw new Error("simulated interruption before recovery write");
      return base.put(key, value);
    },
    delete: (...args) => base.delete(...args)
  };
  const pending = signal("worker-interruption");
  const coordinator = new SignalDeliveryCoordinator({ storage }, { BOT_TOKEN: "test-token", SIGNAL_DELIVERY_SECRET: TEST_DELIVERY_SECRET });
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error("simulated interrupted request"); };
  try {
    const request = () => new Request("https://signal-delivery.internal/deliver", {
      method: "POST", headers: { "content-type": "application/json", "x-signal-delivery-secret": TEST_DELIVERY_SECRET },
      body: JSON.stringify({ chatId: "914", signal: pending, messageText: "restart test" })
    });
    const interrupted = await coordinator.fetch(request());
    assert.equal(interrupted.status, 409);
    assert.equal((await base.get("signal-outbox:futures:signal-outbox:v1:914:worker-interruption")).status, "SENDING");
    const restarted = new SignalDeliveryCoordinator({ storage: base }, { BOT_TOKEN: "test-token", SIGNAL_DELIVERY_SECRET: TEST_DELIVERY_SECRET });
    const response = await restarted.fetch(request());
    assert.equal(response.status, 409);
    assert.equal(calls, 1);
    assert.equal((await base.get("signal-outbox:futures:signal-outbox:v1:914:worker-interruption")).status, "SENDING");
  } finally { globalThis.fetch = originalFetch; }
});

test("KV write quota exhaustion does not block validated signal delivery", async () => {
  const storage = memoryStorage();
  const kv = {
    async get() { throw new Error("KV daily write quota is paused"); },
    async put() { throw new Error("KV daily write quota is paused"); },
    async delete() { throw new Error("KV daily write quota is paused"); },
    async list() { throw new Error("KV daily write quota is paused"); }
  };
  const coordinator = new SignalDeliveryCoordinator({ storage }, { APP_KV: kv, BOT_TOKEN: "test-token", SIGNAL_DELIVERY_SECRET: TEST_DELIVERY_SECRET });
  const originalFetch = globalThis.fetch;
  let sends = 0;
  globalThis.fetch = async () => {
    sends++;
    return new Response(JSON.stringify({ ok: true, result: { message_id: 765 } }), { status: 200 });
  };
  try {
    const pending = signal("kv-quota-does-not-block");
    const response = await coordinator.fetch(new Request("https://signal-delivery.internal/deliver", {
      method: "POST", headers: { "content-type": "application/json", "x-signal-delivery-secret": TEST_DELIVERY_SECRET },
      body: JSON.stringify({ chatId: "915", signal: pending, messageText: "quota test" })
    }));
    assert.equal(response.status, 200);
    assert.equal((await response.json()).result.delivered, true);
    assert.equal(sends, 1);
    assert.equal((await storage.get("signal-outbox:futures:signal-outbox:v1:915:kv-quota-does-not-block")).status, "ARCHIVED");
  } finally { globalThis.fetch = originalFetch; }
});

test("signal registration deduplicates active symbol and side in Durable Object storage", async () => {
  const storage = memoryStorage();
  const coordinator = new SignalDeliveryCoordinator({ storage }, { SIGNAL_DELIVERY_SECRET: TEST_DELIVERY_SECRET });
  const request = (signals) => new Request("https://signal-delivery.internal/signals/register", {
    method: "POST", headers: { "content-type": "application/json", "x-signal-delivery-secret": TEST_DELIVERY_SECRET },
    body: JSON.stringify({ signals })
  });
  const firstSignal = { ...signal("first"), expiresAt: Date.now() + 60_000 };
  const secondSignal = { ...signal("second"), symbol: "BTC-PERP", expiresAt: Date.now() + 60_000 };
  const first = await coordinator.fetch(request([firstSignal]));
  assert.equal(first.status, 200);
  assert.equal((await first.json()).signals.length, 1);
  const second = await coordinator.fetch(request([secondSignal]));
  assert.equal(second.status, 200);
  assert.equal((await second.json()).signals.length, 0);
});

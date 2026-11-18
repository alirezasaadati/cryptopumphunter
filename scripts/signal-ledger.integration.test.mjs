import test from "node:test";
import assert from "node:assert/strict";
import { saveIssuedSignal, updateIssuedSignal, listIssuedSignals } from "../src/signal-ledger.js";
import { signalOutboxAction } from "../src/signal-outbox.js";
import { createSerialExecutor } from "../src/serial-executor.js";
import { SignalDeliveryCoordinator } from "../src/index.js";

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


test("owner reconciliation confirms uncertain delivery and archives the signal idempotently", async () => {
  const kv = memoryKV();
  const pending = signal("uncertain-confirm");
  const key = "futures:signal-outbox:v1:909:uncertain-confirm";
  await kv.put(key, JSON.stringify({
    version: 1, chatId: "909", signalId: pending.id, symbol: pending.symbol,
    status: "UNCERTAIN", signal: pending, messageText: "test signal",
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
  }));
  const coordinator = new SignalDeliveryCoordinator({}, { APP_KV: kv });
  const request = () => new Request("https://signal-delivery.internal/reconcile", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "confirm_delivered", chatId: "909", signalId: pending.id })
  });
  const first = await coordinator.fetch(request());
  assert.equal(first.status, 200);
  assert.equal((await first.json()).result.confirmed, true);
  const saved = await kv.get(key, "json");
  assert.equal(saved.status, "ARCHIVED");
  assert.ok(saved.manualConfirmedAt);
  assert.equal((await listIssuedSignals(kv, "909")).length, 1);
  const second = await coordinator.fetch(request());
  assert.equal(second.status, 200);
  assert.equal((await second.json()).result.alreadyArchived, true);
  assert.equal((await listIssuedSignals(kv, "909")).length, 1);
});

test("owner reconciliation refuses to auto-archive legacy uncertain records without a signal snapshot", async () => {
  const kv = memoryKV();
  await kv.put("futures:signal-outbox:v1:910:legacy", JSON.stringify({
    chatId: "910", signalId: "legacy", symbol: "BTC-PERP", status: "UNCERTAIN"
  }));
  const coordinator = new SignalDeliveryCoordinator({}, { APP_KV: kv });
  const response = await coordinator.fetch(new Request("https://signal-delivery.internal/reconcile", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "confirm_delivered", chatId: "910", signalId: "legacy" })
  }));
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /no signal snapshot/);
  assert.equal((await kv.get("futures:signal-outbox:v1:910:legacy", "json")).status, "UNCERTAIN");
});


test("concurrent duplicate deliveries through the coordinator send one Telegram message", async () => {
  const kv = memoryKV();
  const coordinator = new SignalDeliveryCoordinator({}, { APP_KV: kv, BOT_TOKEN: "test-token" });
  const originalFetch = globalThis.fetch;
  let sendCalls = 0;
  globalThis.fetch = async () => {
    sendCalls++;
    await new Promise(resolve => setTimeout(resolve, 5));
    return new Response(JSON.stringify({ ok: true, result: { message_id: 321 } }), { status: 200 });
  };
  const pending = signal("concurrent-once");
  const request = () => new Request("https://signal-delivery.internal/deliver", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ chatId: "911", signal: pending, messageText: "test signal" })
  });
  try {
    const responses = await Promise.all([coordinator.fetch(request()), coordinator.fetch(request())]);
    const results = await Promise.all(responses.map(x => x.json()));
    assert.equal(sendCalls, 1);
    assert.equal(results.filter(x => x.ok && x.result.duplicate === false).length, 1);
    assert.equal(results.filter(x => x.ok && x.result.duplicate === true).length, 1);
    assert.equal((await listIssuedSignals(kv, "911")).length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("owner-authorized retry sends an uncertain signal once and archives it", async () => {
  const kv = memoryKV();
  const pending = signal("uncertain-retry");
  const key = "futures:signal-outbox:v1:912:uncertain-retry";
  await kv.put(key, JSON.stringify({
    version: 1, chatId: "912", signalId: pending.id, symbol: pending.symbol,
    status: "UNCERTAIN", signal: pending, messageText: "retry signal",
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
  }));
  const coordinator = new SignalDeliveryCoordinator({}, { APP_KV: kv, BOT_TOKEN: "test-token" });
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
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "retry", chatId: "912", signalId: pending.id })
    }));
    assert.equal(response.status, 200);
    assert.equal((await response.json()).ok, true);
    assert.equal(sendCalls, 1);
    assert.equal((await kv.get(key, "json")).status, "ARCHIVED");
    assert.equal((await listIssuedSignals(kv, "912")).length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});


test("network timeout after request starts is marked UNCERTAIN and never auto-resends", async () => {
  const kv = memoryKV();
  const pending = signal("timeout-ambiguous");
  const coordinator = new SignalDeliveryCoordinator({}, { APP_KV: kv, BOT_TOKEN: "test-token" });
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    throw new Error("simulated socket timeout after request dispatch");
  };
  try {
    const request = () => new Request("https://signal-delivery.internal/deliver", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ chatId: "913", signal: pending, messageText: "timeout test" })
    });
    const first = await coordinator.fetch(request());
    assert.equal(first.status, 409);
    assert.equal((await kv.get("futures:signal-outbox:v1:913:timeout-ambiguous", "json")).status, "UNCERTAIN");
    const second = await new SignalDeliveryCoordinator({}, { APP_KV: kv, BOT_TOKEN: "test-token" }).fetch(request());
    assert.equal(second.status, 409);
    assert.equal(calls, 1);
  } finally { globalThis.fetch = originalFetch; }
});

test("worker interruption with an unfinalized SENDING record requires reconciliation after restart", async () => {
  const base = memoryKV();
  const kv = {
    get: (...args) => base.get(...args),
    list: (...args) => base.list(...args),
    async put(key, value, options) {
      const record = JSON.parse(String(value));
      if (record.status === "UNCERTAIN") throw new Error("simulated worker termination before recovery write");
      return base.put(key, value, options);
    }
  };
  const pending = signal("worker-interruption");
  const coordinator = new SignalDeliveryCoordinator({}, { APP_KV: kv, BOT_TOKEN: "test-token" });
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error("simulated interrupted request"); };
  try {
    const request = () => new Request("https://signal-delivery.internal/deliver", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ chatId: "914", signal: pending, messageText: "restart test" })
    });
    const interrupted = await coordinator.fetch(request());
    assert.equal(interrupted.status, 409);
    assert.equal((await base.get("futures:signal-outbox:v1:914:worker-interruption", "json")).status, "SENDING");
    const restarted = new SignalDeliveryCoordinator({}, { APP_KV: base, BOT_TOKEN: "test-token" });
    const response = await restarted.fetch(request());
    assert.equal(response.status, 409);
    assert.equal(calls, 1);
    assert.equal((await base.get("futures:signal-outbox:v1:914:worker-interruption", "json")).status, "SENDING");
  } finally { globalThis.fetch = originalFetch; }
});

test("Telegram acceptance followed by a failed SENT-state KV write becomes UNCERTAIN, not an automatic retry", async () => {
  const base = memoryKV();
  let puts = 0;
  const kv = {
    get: (...args) => base.get(...args),
    list: (...args) => base.list(...args),
    async put(key, value, options) {
      puts++;
      const record = JSON.parse(String(value));
      if (record.status === "SENT") throw new Error("simulated KV failure after Telegram accepted message");
      return base.put(key, value, options);
    }
  };
  const pending = signal("accepted-kv-failure");
  const coordinator = new SignalDeliveryCoordinator({}, { APP_KV: kv, BOT_TOKEN: "test-token" });
  const originalFetch = globalThis.fetch;
  let sends = 0;
  globalThis.fetch = async () => {
    sends++;
    return new Response(JSON.stringify({ ok: true, result: { message_id: 765 } }), { status: 200 });
  };
  try {
    const request = () => new Request("https://signal-delivery.internal/deliver", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ chatId: "915", signal: pending, messageText: "accepted test" })
    });
    const first = await coordinator.fetch(request());
    assert.equal(first.status, 409);
    assert.equal((await base.get("futures:signal-outbox:v1:915:accepted-kv-failure", "json")).status, "UNCERTAIN");
    const second = await new SignalDeliveryCoordinator({}, { APP_KV: base, BOT_TOKEN: "test-token" }).fetch(request());
    assert.equal(second.status, 409);
    assert.equal(sends, 1);
  } finally { globalThis.fetch = originalFetch; }
});

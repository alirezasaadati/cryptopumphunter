import test from "node:test";
import assert from "node:assert/strict";
import { saveIssuedSignal, updateIssuedSignal, listIssuedSignals } from "../src/signal-ledger.js";
import { signalOutboxAction } from "../src/signal-outbox.js";
import { createSerialExecutor } from "../src/serial-executor.js";
import { SignalDeliveryCoordinator, sendAndArchiveFuturesSignal, deliverFuturesSignalAlerts, canManuallyConfirmOutboxDelivery } from "../src/index.js";

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

test("manual confirmation is available for archive-pending records without triggering a resend", () => {
  const signalPayload = signal("manual-archive-confirm");
  for (const status of ["SENDING", "UNCERTAIN", "SENT", "ARCHIVE_PENDING"]) {
    assert.equal(canManuallyConfirmOutboxDelivery({ status, signal: signalPayload }), true, status);
  }
  assert.equal(canManuallyConfirmOutboxDelivery({ status: "ARCHIVED", signal: signalPayload }), false);
  assert.equal(canManuallyConfirmOutboxDelivery({ status: "ARCHIVE_PENDING" }), false);
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


function deliveryEnvironment({ failComplete = 0, archive = false, kv = null } = {}) {
  const storages = new Map();
  const coordinators = new Map();
  let remainingCompleteFailures = failComplete;
  const namespace = {
    idFromName(name) { return String(name); },
    get(id) {
      const key = String(id);
      if (!coordinators.has(key)) {
        const storage = memoryStorage();
        storages.set(key, storage);
        coordinators.set(key, new SignalDeliveryCoordinator(
          { storage },
          {
            SIGNAL_DELIVERY_AUTH_SECRET: TEST_DELIVERY_SECRET,
            ...(archive ? { SIGNAL_ARCHIVE_CHANNEL_ID: "-1001234567890" } : {})
          }
        ));
      }
      const coordinator = coordinators.get(key);
      return {
        async fetch(url, init = {}) {
          const path = new URL(url).pathname;
          if (path === "/deliver/complete" && remainingCompleteFailures > 0) {
            remainingCompleteFailures--;
            return Response.json({ ok: false, error: "simulated DO state write interruption" }, { status: 409 });
          }
          return coordinator.fetch(new Request(url, init));
        }
      };
    }
  };
  return {
    env: {
      BOT_TOKEN: "test-token",
      SIGNAL_DELIVERY_AUTH_SECRET: TEST_DELIVERY_SECRET,
      SIGNAL_DELIVERY: namespace,
      APP_KV: kv || memoryKV(),
      ...(archive ? { SIGNAL_ARCHIVE_CHANNEL_ID: "-1001234567890" } : {})
    },
    storages
  };
}

async function withTelegramFetch(handler, callback) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = handler;
  try { return await callback(); }
  finally { globalThis.fetch = originalFetch; }
}

test("coordinator rejects missing or incorrect internal authentication secret", async () => {
  const coordinator = new SignalDeliveryCoordinator({ storage: memoryStorage() }, {
    SIGNAL_DELIVERY_AUTH_SECRET: TEST_DELIVERY_SECRET
  });
  const response = await coordinator.fetch(new Request("https://signal-delivery.internal/deliver/reserve", {
    method: "POST",
    headers: { "content-type": "application/json", "x-signal-delivery-secret": "wrong" },
    body: JSON.stringify({ chatId: "1", signal: signal("unauthorized"), messageText: "no" })
  }));
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error, "Unauthorized.");
});

test("Durable Object reserve/complete state machine blocks duplicate delivery without network I/O", async () => {
  const storage = memoryStorage();
  const coordinator = new SignalDeliveryCoordinator({ storage }, {
    SIGNAL_DELIVERY_AUTH_SECRET: TEST_DELIVERY_SECRET
  });
  const pending = signal("reserve-complete");
  const post = async (path, payload) => {
    const response = await coordinator.fetch(new Request("https://signal-delivery.internal" + path, {
      method: "POST",
      headers: { "content-type": "application/json", "x-signal-delivery-secret": TEST_DELIVERY_SECRET },
      body: JSON.stringify(payload)
    }));
    return { status: response.status, body: await response.json() };
  };

  const reserved = await post("/deliver/reserve", {
    chatId: "909", signal: pending, messageText: "test signal"
  });
  assert.equal(reserved.status, 200);
  assert.equal(reserved.body.result.reserved, true);
  assert.equal((await storage.get("signal-outbox:futures:signal-outbox:v1:909:reserve-complete")).status, "SENDING");

  const completed = await post("/deliver/complete", {
    chatId: "909", signalId: pending.id, status: "SENT", telegramMessageId: 77
  });
  assert.equal(completed.status, 200);
  assert.equal(completed.body.result.record.status, "SENT");
  assert.equal(completed.body.result.record.telegramMessageId, 77);

  const duplicate = await post("/deliver/reserve", {
    chatId: "909", signal: pending, messageText: "test signal"
  });
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.body.result.duplicate, true);
  const legacyReconcile = await coordinator.fetch(new Request("https://signal-delivery.internal/reconcile", { method: "POST", headers: { "content-type": "application/json", "x-signal-delivery-secret": TEST_DELIVERY_SECRET }, body: "{}" }));
  assert.equal(legacyReconcile.status, 404);
});

test("concurrent duplicate Worker deliveries use durable reservations and send one Telegram message", async () => {
  const { env, storages } = deliveryEnvironment();
  let sendCalls = 0;
  await withTelegramFetch(async () => {
    sendCalls++;
    await new Promise(resolve => setTimeout(resolve, 5));
    return Response.json({ ok: true, result: { message_id: 321 } });
  }, async () => {
    const pending = signal("concurrent-once");
    const results = await Promise.allSettled([
      sendAndArchiveFuturesSignal(env, "911", pending, "test signal"),
      sendAndArchiveFuturesSignal(env, "911", pending, "test signal")
    ]);
    assert.equal(results.filter(x => x.status === "fulfilled").length, 1);
    assert.equal(results.filter(x => x.status === "rejected").length, 1);
    assert.equal(sendCalls, 1);
    const storage = storages.get("futures:signal-outbox:v1:911:concurrent-once");
    assert.equal((await storage.get("signal-outbox:futures:signal-outbox:v1:911:concurrent-once")).status, "ARCHIVED");
  });
});

test("Worker network timeout is persisted as UNCERTAIN and never auto-resends", async () => {
  const { env, storages } = deliveryEnvironment();
  let calls = 0;
  await withTelegramFetch(async () => {
    calls++;
    throw new Error("simulated socket timeout after request dispatch");
  }, async () => {
    const pending = signal("timeout-ambiguous");
    await assert.rejects(sendAndArchiveFuturesSignal(env, "913", pending, "timeout test"), /simulated socket timeout/);
    const storage = storages.get("futures:signal-outbox:v1:913:timeout-ambiguous");
    assert.equal((await storage.get("signal-outbox:futures:signal-outbox:v1:913:timeout-ambiguous")).status, "UNCERTAIN");
    await assert.rejects(sendAndArchiveFuturesSignal(env, "913", pending, "timeout test"), /uncertain and requires manual reconciliation/);
    assert.equal(calls, 1);
  });
});

test("Worker interruption after Telegram acceptance leaves a durable SENDING record and blocks duplicate send", async () => {
  const { env, storages } = deliveryEnvironment({ failComplete: 1 });
  let calls = 0;
  await withTelegramFetch(async () => {
    calls++;
    return Response.json({ ok: true, result: { message_id: 654 } });
  }, async () => {
    const pending = signal("worker-interruption");
    await assert.rejects(sendAndArchiveFuturesSignal(env, "914", pending, "restart test"), /durable delivery state confirmation failed/);
    const storage = storages.get("futures:signal-outbox:v1:914:worker-interruption");
    assert.equal((await storage.get("signal-outbox:futures:signal-outbox:v1:914:worker-interruption")).status, "SENDING");
    await assert.rejects(sendAndArchiveFuturesSignal(env, "914", pending, "restart test"), /uncertain and requires manual reconciliation/);
    assert.equal(calls, 1);
  });
});

test("KV write quota exhaustion does not block validated Worker delivery", async () => {
  const kv = {
    async get() { throw new Error("KV daily write quota is paused"); },
    async put() { throw new Error("KV daily write quota is paused"); },
    async delete() { throw new Error("KV daily write quota is paused"); },
    async list() { throw new Error("KV daily write quota is paused"); }
  };
  const { env, storages } = deliveryEnvironment({ kv });
  let sends = 0;
  await withTelegramFetch(async () => {
    sends++;
    return Response.json({ ok: true, result: { message_id: 765 } });
  }, async () => {
    const pending = signal("kv-quota-does-not-block");
    const result = await sendAndArchiveFuturesSignal(env, "915", pending, "quota test");
    assert.equal(result.delivered, true);
    assert.equal(sends, 1);
    const storage = storages.get("futures:signal-outbox:v1:915:kv-quota-does-not-block");
    assert.equal((await storage.get("signal-outbox:futures:signal-outbox:v1:915:kv-quota-does-not-block")).status, "ARCHIVED");
  });
});

test("archive Telegram network I/O runs in the Worker and remains idempotent", async () => {
  const { env, storages } = deliveryEnvironment({ archive: true });
  const calls = [];
  await withTelegramFetch(async (_url, options) => {
    const body = options.body instanceof FormData ? { chat_id: options.body.get("chat_id") } : JSON.parse(options.body);
    calls.push(String(body.chat_id));
    return Response.json({ ok: true, result: { message_id: 900 + calls.length } });
  }, async () => {
    const pending = signal("archive-from-worker");
    const first = await sendAndArchiveFuturesSignal(env, "916", pending, "archive test");
    assert.equal(first.delivered, true);
    assert.equal(first.archivePending, false);
    const second = await sendAndArchiveFuturesSignal(env, "916", pending, "archive test");
    assert.equal(second.duplicate, true);
    assert.equal(calls.length, 2);
    assert.equal(calls[0], "916");
    assert.equal(calls[1], "-1001234567890");
    const archiveStorage = storages.get("global:signal-archive-publisher");
    assert.equal((await archiveStorage.get("published-signal:archive-from-worker")).status, "PUBLISHED");
  });
});

test("Worker can seed a queued durable record before an explicitly authorized retry", async () => {
  const { env, storages } = deliveryEnvironment();
  let sends = 0;
  await withTelegramFetch(async () => {
    sends++;
    return Response.json({ ok: true, result: { message_id: 990 } });
  }, async () => {
    const pending = signal("queued-retry");
    const key = "futures:signal-outbox:v1:917:queued-retry";
    const queued = {
      version: 2, chatId: "917", signalId: pending.id, symbol: pending.symbol,
      signal: pending, messageText: "retry signal", status: "QUEUED",
      createdAt: new Date().toISOString(), retryAuthorizedAt: new Date().toISOString()
    };
    const stub = env.SIGNAL_DELIVERY.get(env.SIGNAL_DELIVERY.idFromName(key));
    const seeded = await stub.fetch("https://signal-delivery.internal/deliver/complete", {
      method: "POST",
      headers: { "content-type": "application/json", "x-signal-delivery-secret": TEST_DELIVERY_SECRET },
      body: JSON.stringify({ chatId: "917", signalId: pending.id, status: "QUEUED", seed: queued })
    });
    assert.equal(seeded.status, 200);
    const result = await sendAndArchiveFuturesSignal(env, "917", pending, "retry signal");
    assert.equal(result.delivered, true);
    assert.equal(sends, 1);
    const storage = storages.get(key);
    assert.equal((await storage.get("signal-outbox:" + key)).status, "ARCHIVED");
  });
});

test("legacy DO delivery and reconciliation routes are no longer exposed", async () => {
  const coordinator = new SignalDeliveryCoordinator({ storage: memoryStorage() }, {
    SIGNAL_DELIVERY_AUTH_SECRET: TEST_DELIVERY_SECRET
  });
  for (const path of ["/deliver", "/archive-publish", "/reconcile"]) {
    const response = await coordinator.fetch(new Request("https://signal-delivery.internal" + path, {
      method: "POST",
      headers: { "content-type": "application/json", "x-signal-delivery-secret": TEST_DELIVERY_SECRET },
      body: "{}"
    }));
    assert.equal(response.status, 404);
  }
});


test("automated fan-out publishes each signal to the archive exactly once", async () => {
  const { env, storages } = deliveryEnvironment({ archive: true });
  for (const chatId of ["921", "922", "923"]) {
    await env.APP_KV.put("member:" + chatId, JSON.stringify({ approved: true }));
  }
  const telegramChats = [];
  await withTelegramFetch(async (_url, options) => {
    const body = options.body instanceof FormData ? { chat_id: options.body.get("chat_id") } : JSON.parse(options.body);
    telegramChats.push(String(body.chat_id));
    await new Promise(resolve => setTimeout(resolve, 2));
    return Response.json({ ok: true, result: { message_id: 1200 + telegramChats.length } });
  }, async () => {
    const pending = signal("fanout-archive-once", "ETH-PERP");
    const result = await deliverFuturesSignalAlerts(env, [pending]);
    assert.equal(result.recipients, 3);
    assert.equal(result.delivered, 3);
    assert.equal(result.failed, 0);
    assert.equal(telegramChats.filter(id => id === "-1001234567890").length, 1);
    assert.equal(telegramChats.filter(id => ["921", "922", "923"].includes(id)).length, 3);
    for (const chatId of ["921", "922", "923"]) {
      const key = "futures:signal-outbox:v1:" + chatId + ":fanout-archive-once";
      const storage = storages.get(key);
      const record = await storage.get("signal-outbox:" + key);
      assert.equal(record.status, "ARCHIVED");
      assert.equal(record.archivePublished, true);
    }
    const archiveStorage = storages.get("global:signal-archive-publisher");
    assert.equal((await archiveStorage.get("published-signal:fanout-archive-once")).status, "PUBLISHED");
  });
});

test("a concurrent archive reservation is reported as in-progress, not uncertain", async () => {
  const storage = memoryStorage();
  const coordinator = new SignalDeliveryCoordinator({ storage }, {
    SIGNAL_DELIVERY_AUTH_SECRET: TEST_DELIVERY_SECRET,
    SIGNAL_ARCHIVE_CHANNEL_ID: "-1001234567890"
  });
  const post = async (path, payload) => {
    const response = await coordinator.fetch(new Request("https://signal-delivery.internal" + path, {
      method: "POST",
      headers: { "content-type": "application/json", "x-signal-delivery-secret": TEST_DELIVERY_SECRET },
      body: JSON.stringify(payload)
    }));
    return response.json();
  };
  const first = await post("/archive-publish/reserve", {
    channelId: "-1001234567890", signalId: "archive-reservation-race"
  });
  assert.equal(first.result.reserved, true);
  const second = await post("/archive-publish/reserve", {
    channelId: "-1001234567890", signalId: "archive-reservation-race"
  });
  assert.equal(second.result.duplicate, true);
  assert.equal(second.result.pending, true);
  assert.equal(second.result.uncertain, undefined);
});

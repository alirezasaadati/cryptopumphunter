import test from "node:test";
import assert from "node:assert/strict";
import { SignalDeliveryCoordinator } from "../src/index.js";

function createCoordinator(options = {}) {
  const data = new Map();
  const storage = {
    async get(key) { return data.get(key); },
    async put(key, value) { data.set(key, structuredClone(value)); },
    async delete(key) { data.delete(key); },
    async transaction(callback) {
      const draft = new Map([...data.entries()].map(([key, value]) => [key, structuredClone(value)]));
      const transaction = {
        async get(key) { return draft.get(key); },
        async put(key, value) {
          if (options.failTransactionOnPutKey === key) throw new Error("simulated transaction write failure");
          draft.set(key, structuredClone(value));
        },
        async delete(key) { draft.delete(key); }
      };
      const result = await callback(transaction);
      data.clear();
      for (const [key, value] of draft) data.set(key, value);
      return result;
    }
  };
  const coordinator = new SignalDeliveryCoordinator({ storage }, { SIGNAL_DELIVERY_SECRET: "test-secret" });
  async function post(path, payload = {}) {
    const response = await coordinator.fetch(new Request("https://do.test" + path, {
      method: "POST",
      headers: { "content-type": "application/json", "x-signal-delivery-secret": "test-secret" },
      body: JSON.stringify(payload)
    }));
    return { status: response.status, body: await response.json() };
  }
  return { post, data };
}

function signal(id, overrides = {}) {
  return {
    id, symbol: "PF_XBTUSD", side: "LONG",
    entry: 100, stop: 95, target1: 107.5, target2: 111, target3: 115,
    createdAt: Date.now(), expiresAt: Date.now() + 60_000,
    ...overrides
  };
}

test("registration atomically creates an open signal-evaluation trade", async () => {
  const { post } = createCoordinator();
  const registered = await post("/signals/register", { signals: [signal("sig-1")] });
  assert.equal(registered.body.signals.length, 1);
  assert.equal(registered.body.trackedTrades, 1);
  const listed = await post("/trades/list");
  assert.equal(listed.body.trades.length, 1);
  assert.equal(listed.body.trades[0].status, "OPEN");
  assert.equal(listed.body.trades[0].trackingMode, "SIGNAL_EVALUATION");
  assert.equal(listed.body.trades[0].actualEntry, 100);
});

test("expired candidates are ignored and do not create orphaned tracking trades", async () => {
  const { post } = createCoordinator();
  const expired = await post("/signals/register", { signals: [signal("sig-expired", { expiresAt: Date.now() - 1 })] });
  assert.equal(expired.body.signals.length, 0);
  assert.equal(expired.body.trackedTrades, 0);
  assert.equal((await post("/trades/list")).body.trades.length, 0);

  const next = await post("/signals/register", { signals: [signal("sig-2")] });
  assert.equal(next.body.signals.length, 1);
  assert.equal(next.body.trackedTrades, 1);
});

test("same symbol and side can signal again while a prior tracked trade remains OPEN", async () => {
  const { post } = createCoordinator();
  const first = await post("/signals/register", { signals: [signal("sig-first")] });
  assert.equal(first.body.signals.length, 1);
  // Simulate the first pending alert reaching its TTL; the tracked OPEN
  // evaluation record must not continue suppressing this symbol-side forever.
  const pending = data.get("active-futures-pending") || [];
  data.set("active-futures-pending", pending.map(item => ({ ...item, expiresAt: Date.now() - 1 })));
  const second = await post("/signals/register", { signals: [signal("sig-second")] });
  assert.equal(second.body.signals.length, 1);
  assert.equal(second.body.trackedTrades, 1);
  assert.equal((await post("/trades/list")).body.trades.length, 2);
});

test("unexpired pending signals still suppress duplicate symbol-side registrations", async () => {
  const { post } = createCoordinator();
  await post("/signals/register", { signals: [signal("sig-pending")] });
  const duplicate = await post("/signals/register", { signals: [signal("sig-duplicate")] });
  assert.equal(duplicate.body.signals.length, 0);
  assert.equal(duplicate.body.trackedTrades, 0);
  assert.equal((await post("/trades/list")).body.trades.length, 1);
});

test("legacy OPEN trade records, including invalid timestamps, do not block new signals", async () => {
  const { post, data } = createCoordinator();
  data.set("active-futures-trades", [{
    id: "legacy-open", signalId: "old-signal", symbol: "PF_XBTUSD",
    side: "LONG", status: "OPEN", createdAt: "not-a-date"
  }]);
  const registered = await post("/signals/register", { signals: [signal("sig-new")] });
  assert.equal(registered.body.signals.length, 1);
  assert.equal(registered.body.trackedTrades, 1);
  assert.equal((await post("/trades/list")).body.trades.length, 2);
});

test("signal and trade registration rolls back atomically when either write fails", async () => {
  const { post, data } = createCoordinator({ failTransactionOnPutKey: "active-futures-pending" });
  const result = await post("/signals/register", { signals: [signal("sig-atomic")] });
  assert.equal(result.status, 409);
  assert.match(result.body.error, /simulated transaction write failure/);
  assert.equal(data.has("active-futures-trades"), false);
  assert.equal(data.has("active-futures-pending"), false);
});

test("closing a trade releases only its symbol-side lock and permits a new signal", async () => {
  const { post } = createCoordinator();
  await post("/signals/register", { signals: [signal("sig-1")] });
  const trade = (await post("/trades/list")).body.trades[0];
  const close = await post("/trades/update", {
    trades: [{
      id: trade.id, status: "CLOSED_PROFIT", closeReason: "CLOSED_PROFIT",
      exitPrice: 103, closePriceChangePercent: 3, marginReturnPercent: 30,
      closedAt: new Date().toISOString(), lastPrice: 103,
      lastCheckedCandleTime: Date.now()
    }]
  });
  assert.equal(close.body.closed, 1);
  assert.equal((await post("/trades/list")).body.trades.length, 0);
  const next = await post("/signals/register", { signals: [signal("sig-2")] });
  assert.equal(next.body.signals.length, 1);
  assert.equal(next.body.trackedTrades, 1);
});

test("same symbol in opposite direction has an independent lock", async () => {
  const { post } = createCoordinator();
  await post("/signals/register", { signals: [signal("long-1")] });
  const short = signal("short-1", {
    side: "SHORT", entry: 100, stop: 105, target1: 92.5, target2: 89, target3: 85
  });
  const registered = await post("/signals/register", { signals: [short] });
  assert.equal(registered.body.signals.length, 1);
  assert.equal((await post("/trades/list")).body.trades.length, 2);
});

test("closed historical trade cannot be reopened by a stale update", async () => {
  const { post } = createCoordinator();
  await post("/signals/register", { signals: [signal("sig-1")] });
  const trade = (await post("/trades/list")).body.trades[0];
  await post("/trades/update", { trades: [{
    id: trade.id, status: "CLOSED_STOP", exitPrice: 95,
    closePriceChangePercent: -5, marginReturnPercent: -50
  }] });
  const stale = await post("/trades/update", { trades: [{
    id: trade.id, status: "OPEN", lastPrice: 101, lastCheckedCandleTime: Date.now() + 1000
  }] });
  assert.equal(stale.body.updated, 0);
  assert.equal((await post("/trades/list")).body.trades.length, 0);
});

test("scan lock lease tokens prevent stale workers from releasing a newer lock", async () => {
  const { post, data } = createCoordinator();
  const first = await post("/scan-lock/acquire", { token: "first-token" });
  assert.equal(first.body.acquired, true);
  const blocked = await post("/scan-lock/acquire", { token: "blocked-token" });
  assert.equal(blocked.body.acquired, false);

  const old = data.get("automatic-futures-scan-lock");
  data.set("automatic-futures-scan-lock", { ...old, expiresAt: Date.now() - 1 });
  const second = await post("/scan-lock/acquire", { token: "second-token" });
  assert.equal(second.body.acquired, true);
  assert.equal(second.body.expiresAt - data.get("automatic-futures-scan-lock").acquiredAt, 600000);

  const staleRelease = await post("/scan-lock/release", { token: "first-token" });
  assert.equal(staleRelease.body.released, false);
  const stillLocked = await post("/scan-lock/acquire", { token: "third-token" });
  assert.equal(stillLocked.body.acquired, false);

  const release = await post("/scan-lock/release", { token: "second-token" });
  assert.equal(release.body.released, true);
  assert.equal((await post("/scan-lock/acquire", { token: "third-token" })).body.acquired, true);
});

test("unauthorized lifecycle requests are rejected", async () => {
  const data = new Map();
  const coordinator = new SignalDeliveryCoordinator({
    storage: { async get(k) { return data.get(k); }, async put(k,v) { data.set(k,v); } }
  }, { SIGNAL_DELIVERY_SECRET: "secret" });
  const response = await coordinator.fetch(new Request("https://do.test/trades/list", {
    method: "POST", headers: { "content-type": "application/json", "x-signal-delivery-secret": "wrong" }, body: "{}"
  }));
  assert.equal(response.status, 401);
});

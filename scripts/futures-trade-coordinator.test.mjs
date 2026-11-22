import test from "node:test";
import assert from "node:assert/strict";
import { SignalDeliveryCoordinator } from "../src/index.js";

function createCoordinator() {
  const data = new Map();
  const storage = {
    async get(key) { return data.get(key); },
    async put(key, value) { data.set(key, structuredClone(value)); },
    async delete(key) { data.delete(key); }
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

test("open trade lock survives pending signal TTL expiry and blocks same symbol and side", async () => {
  const { post } = createCoordinator();
  await post("/signals/register", { signals: [signal("sig-expired", { expiresAt: Date.now() - 1 })] });
  const pending = await post("/signals/list");
  assert.equal(pending.body.signals.length, 0);
  const duplicate = await post("/signals/register", { signals: [signal("sig-2")] });
  assert.equal(duplicate.body.signals.length, 0);
  assert.equal((await post("/trades/list")).body.trades.length, 1);
});

test("closing a trade releases only its symbol-side lock and permits a new signal", async () => {
  const { post } = createCoordinator();
  await post("/signals/register", { signals: [signal("sig-1")] });
  const trade = (await post("/trades/list")).body.trades[0];
  const close = await post("/trades/update", {
    trades: [{
      id: trade.id, status: "CLOSED_PROFIT", closeReason: "CLOSED_PROFIT",
      exitPrice: 107.5, closePriceChangePercent: 7.5, marginReturnPercent: null,
      closedAt: new Date().toISOString(), lastPrice: 107.5,
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
    closePriceChangePercent: -5, marginReturnPercent: null
  }] });
  const stale = await post("/trades/update", { trades: [{
    id: trade.id, status: "OPEN", lastPrice: 101, lastCheckedCandleTime: Date.now() + 1000
  }] });
  assert.equal(stale.body.updated, 0);
  assert.equal((await post("/trades/list")).body.trades.length, 0);
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

import test from "node:test";
import assert from "node:assert/strict";
import { SignalDeliveryCoordinator } from "../src/index.js";

function createCoordinator() {
  const ctx = { storage: { get: async () => undefined, put: async () => {}, delete: async () => {} } };
  return new SignalDeliveryCoordinator(ctx, { SIGNAL_DELIVERY_AUTH_SECRET: "test-secret" });
}

function makeRequest(payload) {
  return new Request("https://signal-delivery.internal/market-data/candles", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-signal-delivery-secret": "test-secret"
    },
    body: JSON.stringify(payload)
  });
}

function makeKrakenResponse() {
  const time = Math.floor((Date.now() - 10 * 24 * 60 * 60 * 1000) / 1000);
  return new Response(JSON.stringify({
    candles: [
      { time, open: 100, high: 102, low: 99, close: 101, volume: 10 },
      { time: time + 60, open: 101, high: 103, low: 100, close: 102, volume: 12 }
    ]
  }), { status: 200, headers: { "content-type": "application/json" } });
}

test("market-data coordinator fetches all requested intervals inside its own invocation", async () => {
  const originalFetch = globalThis.fetch;
  const requested = [];
  globalThis.fetch = async url => {
    requested.push(String(url));
    return makeKrakenResponse();
  };
  try {
    const response = await createCoordinator().fetch(makeRequest({
      symbol: "PF_XBTUSD",
      intervals: ["1h", "4h", "15m"]
    }));
    const result = await response.json();
    assert.equal(response.status, 200);
    assert.equal(result.ok, true);
    assert.deepEqual(requested.map(url => new URL(url).pathname.split("/").at(-1)).sort(), ["15m", "1h", "4h"]);
    assert.deepEqual(Object.keys(result.candles).sort(), ["15m", "1h", "4h"]);
    assert.deepEqual(result.errors, {});
    for (const interval of ["1h", "4h", "15m"]) {
      assert.equal(result.candles[interval].length, 2);
      assert.ok(result.candles[interval].every(candle => candle.time > 0));
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a failed optional interval is isolated and does not discard required candle data", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async url => {
    if (String(url).endsWith("/15m?count=120")) {
      return new Response("bad request", { status: 400 });
    }
    return makeKrakenResponse();
  };
  try {
    const response = await createCoordinator().fetch(makeRequest({
      symbol: "PI_ETHUSD",
      intervals: ["1h", "4h", "15m"]
    }));
    const result = await response.json();
    assert.equal(response.status, 200);
    assert.equal(result.candles["1h"].length, 2);
    assert.equal(result.candles["4h"].length, 2);
    assert.equal(result.candles["15m"], undefined);
    assert.match(result.errors["15m"], /HTTP 400/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("market-data coordinator rejects invalid symbols and intervals before making external requests", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return makeKrakenResponse();
  };
  try {
    const coordinator = createCoordinator();
    const badSymbol = await coordinator.fetch(makeRequest({ symbol: "BTCUSD", intervals: ["1h"] }));
    const badInterval = await coordinator.fetch(makeRequest({ symbol: "PF_BTCUSD", intervals: ["1d"] }));
    assert.equal(badSymbol.status, 409);
    assert.equal(badInterval.status, 409);
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("market-data coordinator requires the internal authentication secret", async () => {
  const response = await new SignalDeliveryCoordinator(
    { storage: { get: async () => undefined, put: async () => {}, delete: async () => {} } },
    { SIGNAL_DELIVERY_AUTH_SECRET: "different-secret" }
  ).fetch(makeRequest({ symbol: "PF_BTCUSD", intervals: ["1h"] }));
  assert.equal(response.status, 401);
});

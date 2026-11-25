import test from "node:test";
import assert from "node:assert/strict";
import { SignalDeliveryCoordinator } from "../src/index.js";

const SECRET = "archive-concurrency-test-secret";
function memoryStorage() {
  const data = new Map();
  return {
    async get(key) { return data.get(key); },
    async put(key, value) { data.set(key, structuredClone(value)); },
    async delete(key) { return data.delete(key); }
  };
}

test("parallel reservations for one signal have one publisher and in-progress followers", async () => {
  const storage = memoryStorage();
  const coordinator = new SignalDeliveryCoordinator({ storage }, {
    SIGNAL_DELIVERY_AUTH_SECRET: SECRET,
    SIGNAL_ARCHIVE_CHANNEL_ID: "-1001234567890"
  });
  const reserve = async () => {
    const response = await coordinator.fetch(new Request("https://signal-delivery.internal/archive-publish/reserve", {
      method: "POST",
      headers: { "content-type": "application/json", "x-signal-delivery-secret": SECRET },
      body: JSON.stringify({ channelId: "-1001234567890", signalId: "same-signal" })
    }));
    return response.json();
  };
  const results = await Promise.all([reserve(), reserve(), reserve(), reserve()]);
  assert.equal(results.filter(x => x.result?.reserved === true).length, 1);
  assert.equal(results.filter(x => x.result?.pending === true).length, 3);
  assert.equal(results.some(x => x.result?.uncertain === true), false);
});

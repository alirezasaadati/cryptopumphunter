import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";

test("health endpoint reports isolated paper-only foundation", async () => {
  const response = await worker.fetch(
    new Request("https://engine.example/health"),
    {
      ENGINE_STAGE: "foundation-only",
      ENGINE_MODE: "paper",
      ENGINE_DB: {},
      ENGINE_ARCHIVE: {}
    }
  );

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.service, "Crypto Pump Hunter Engine V5");
  assert.equal(body.storage.d1Configured, true);
  assert.equal(body.storage.r2Configured, true);
  assert.equal(body.storage.kvDependency, false);
  assert.equal(body.marketScanning, false);
  assert.equal(body.liveTrading, false);
});

test("unknown routes return 404", async () => {
  const response = await worker.fetch(
    new Request("https://engine.example/not-found"),
    {}
  );
  assert.equal(response.status, 404);
});

import test from "node:test";
import assert from "node:assert/strict";
import { isKvDailyWriteQuotaError, quotaDayKey, withQuotaAwareKV } from "../src/index.js";

function makeEnv({ quotaOnFirstPut = false } = {}) {
  const today = quotaDayKey();
  let pausedDay = null;
  let puts = 0;
  let deletes = 0;
  const kv = {
    async get(key) { return "stored:" + key; },
    async put() {
      puts += 1;
      if (quotaOnFirstPut && puts === 1) throw new Error("KV put() limit exceeded for the day.");
    },
    async delete() { deletes += 1; }
  };
  const stub = {
    async fetch(url) {
      const path = new URL(url).pathname;
      if (path === "/kv-write/allow") {
        if (pausedDay && pausedDay !== today) pausedDay = null;
        return Response.json({ ok: true, allowed: pausedDay !== today });
      }
      if (path === "/kv-write/pause") {
        pausedDay = today;
        return Response.json({ ok: true, allowed: false });
      }
      return new Response("Not found", { status: 404 });
    }
  };
  const env = {
    APP_KV: kv,
    SIGNAL_DELIVERY_AUTH_SECRET: "test-secret",
    SIGNAL_DELIVERY: {
      idFromName() { return "global-kv-write-quota"; },
      get() { return stub; }
    }
  };
  return { env: withQuotaAwareKV(env), counts: () => ({ puts, deletes }), kv };
}

test("recognizes Cloudflare daily KV write quota errors only", () => {
  assert.equal(isKvDailyWriteQuotaError(new Error("KV put() limit exceeded for the day.")), true);
  assert.equal(isKvDailyWriteQuotaError(new Error("KV delete() limit exceeded for the day.")), true);
  assert.equal(isKvDailyWriteQuotaError(new Error("network timeout")), false);
});

test("reads remain available while writes are paused after quota exhaustion", async () => {
  const mock = makeEnv({ quotaOnFirstPut: true });
  await assert.rejects(
    mock.env.APP_KV.put("a", "1"),
    /limit exceeded for the day/
  );
  assert.equal(await mock.env.APP_KV.get("a"), "stored:a");
  await assert.rejects(
    mock.env.APP_KV.put("b", "2"),
    /paused until the next UTC day/
  );
  await assert.rejects(
    mock.env.APP_KV.delete("a"),
    /paused until the next UTC day/
  );
  assert.deepEqual(mock.counts(), { puts: 1, deletes: 0 });
});

test("quota day key is based on UTC date", () => {
  assert.equal(quotaDayKey(Date.parse("2026-11-18T23:59:59.000Z")), "2026-11-18");
  assert.equal(quotaDayKey(Date.parse("2026-11-19T00:00:00.000Z")), "2026-11-19");
});

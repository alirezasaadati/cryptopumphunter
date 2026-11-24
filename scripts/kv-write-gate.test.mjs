import test from "node:test";
import assert from "node:assert/strict";
import { withQuotaAwareKV } from "../src/index.js";

test("KV writes continue when the Durable Object quota gate is unavailable, then pause locally on the actual KV daily quota error", async () => {
  let gateCalls = 0;
  let successfulWrites = 0;
  let attemptedWrites = 0;
  const env = {
    APP_KV: {
      async put() {
        attemptedWrites++;
        if (attemptedWrites === 1) {
          successfulWrites++;
          return;
        }
        throw new Error("KV put limit exceeded for the day");
      },
      async delete() {
        successfulWrites++;
      },
      async get(key) { return key; }
    },
    SIGNAL_DELIVERY: {
      idFromName(name) { return name; },
      get() {
        return {
          async fetch() {
            gateCalls++;
            throw new Error("Exceeded allowed duration in Durable Objects free tier.");
          }
        };
      }
    }
  };

  const originalWarn = console.warn;
  const originalError = console.error;
  console.warn = () => {};
  console.error = () => {};
  try {
    const guarded = withQuotaAwareKV(env);

    await guarded.APP_KV.put("telegram-update:1", "seen");
    assert.equal(successfulWrites, 1, "a DO outage must not block a KV write");
    assert.equal(gateCalls, 1, "the failed gate check should be cached briefly");

    await assert.rejects(
      guarded.APP_KV.put("telegram-update:2", "seen"),
      /limit exceeded for the day/i
    );
    assert.equal(attemptedWrites, 2, "the KV namespace remains the authority on its actual daily write quota");

    await assert.rejects(
      guarded.APP_KV.put("telegram-update:3", "seen"),
      /paused until the next UTC day/i
    );
    assert.equal(attemptedWrites, 2, "after a real quota error, this isolate must stop retrying writes");
  } finally {
    console.warn = originalWarn;
    console.error = originalError;
  }
});

test("KV quota guard works without a Durable Object binding", async () => {
  let writes = 0;
  const env = {
    APP_KV: {
      async put() { writes++; },
      async delete() { writes++; },
      async get(key) { return key; }
    }
  };
  const guarded = withQuotaAwareKV(env);
  await guarded.APP_KV.put("without-do", "ok");
  assert.equal(writes, 1);
});

import test from "node:test";
import assert from "node:assert/strict";
import { getJson, numberOrNull, withQuery } from "../src/exchanges/http.js";

test("getJson parses a successful public JSON response", async () => {
  const result = await getJson("https://api.example/test", async () =>
    new Response(JSON.stringify({ ok: true }), { status: 200 })
  );
  assert.equal(result.ok, true);
});

test("getJson classifies HTTP 429 without retrying", async () => {
  await assert.rejects(
    getJson("https://api.example/test", async () =>
      new Response("rate limited", { status: 429, headers: { "retry-after": "3" } })
    ),
    error => error.code === "RATE_LIMITED" && error.retryAfter === "3"
  );
});

test("getJson rejects exchange-level errors", async () => {
  await assert.rejects(
    getJson("https://api.example/test", async () =>
      new Response(JSON.stringify({ error: ["EAPI:Invalid key"] }), { status: 200 })
    ),
    /EAPI:Invalid key/
  );
});

test("normalization helpers handle missing and invalid numbers", () => {
  assert.equal(numberOrNull("12.5"), 12.5);
  assert.equal(numberOrNull("not-a-number"), null);
  assert.equal(numberOrNull(null), null);
  const url = new URL(withQuery("https://api.example/path", { symbol: "BTCUSDT", empty: null }));
  assert.equal(url.searchParams.get("symbol"), "BTCUSDT");
  assert.equal(url.searchParams.has("empty"), false);
});

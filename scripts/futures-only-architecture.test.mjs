import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../src/index.js", import.meta.url), "utf8");
const researchEngine = await readFile(new URL("../src/price-action-engine.js", import.meta.url), "utf8");

test("bot exposes only the Kraken Futures signal engine", () => {
  assert.match(source, /mode: "Kraken Derivatives Futures signals only"/);
  assert.match(source, /async function runFuturesSignalScan\(/);
  assert.match(source, /function analyzeFuturesSymbol\(/);
  assert.doesNotMatch(source, /function analyzeCoin\(/);
  assert.doesNotMatch(source, /async function runScan\(/);
  assert.doesNotMatch(source, /async function runScanForChat\(/);
  assert.doesNotMatch(source, /fetchCoinLore\(/);
  assert.doesNotMatch(source, /getKrakenPairs\(/);
  assert.doesNotMatch(source, /Price Action/i);
  assert.doesNotMatch(source, /callback_data: "scan"/);
  assert.doesNotMatch(source, /callback_data: "analysis"/);
  assert.doesNotMatch(source, /callback_data: "watchlist"/);
  assert.doesNotMatch(source, /command: "scan"/);
});

test("manual and scheduled alerts both use the same futures scan", () => {
  assert.match(source, /const result = await runFuturesSignalScan\(env\);/);
  assert.match(source, /async scheduled\(event, env, ctx\)\s*\{\s*env = withQuotaAwareKV\(env\);\s*ctx\.waitUntil\(runAutomaticFuturesAlertScan\(env\)\);/);
});


test("the live scan is explicitly routed through the Kraken Futures analyzer", () => {
  assert.match(source, /return analyzeFuturesSymbol\(ticker, oneHour, fourHour, fifteenMinute, options\);/);
  assert.doesNotMatch(source, /analyzePriceAction|TREND_SHORT|RALLY_FADE/);
  assert.doesNotMatch(source, /from ["\']\.\/price-action-engine\.js["\']/);
});

test("the separate Price Action module is clearly marked inactive", () => {
  assert.match(researchEngine, /^\/\/ STATUS: INACTIVE \/ RESEARCH-ONLY\./);
});

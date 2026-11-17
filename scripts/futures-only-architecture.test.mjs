import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../src/index.js", import.meta.url), "utf8");

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
  assert.match(source, /async scheduled\(event, env, ctx\)\s*\{\s*ctx\.waitUntil\(runAutomaticFuturesAlertScan\(env\)\);/);
});

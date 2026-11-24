import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../src/index.js", import.meta.url), "utf8");
const researchEngine = await readFile(new URL("../src/price-action-engine.js", import.meta.url), "utf8");

test("bot exposes separate Kraken Spot and Futures signal engines", () => {
  assert.match(source, /mode: "Kraken Spot and Derivatives Futures signals"/);
  assert.match(source, /import \{ runSpotScan, runSpotAssetDetail, testSpotDataSources \} from "\.\/spot-engine\.js"/);
  assert.match(source, /if \(command === "\/scan"\)/);
  assert.match(source, /async function runSpotMarketScanForChat/);
  assert.match(source, /async function runFuturesSignalScan/);
  assert.match(source, /function analyzeFuturesSymbol\(/);
  assert.match(source, /testSpotDataSources\(\)/);
  assert.match(source, /testDataSources\(\)/);
  assert.match(source, /global:manual-spot-scan-lock/);
  assert.match(source, /spot-scan-lock\/acquire/);
  assert.match(source, /spot-scan-lock\/release/);
  assert.doesNotMatch(source, /callback_data: "analysis"/);
  assert.doesNotMatch(source, /callback_data: "watchlist"/);
});

test("manual and scheduled Futures alerts both use the same Futures scan", () => {
  assert.match(source, /const result = await runFuturesSignalScan\(env\);/);
  assert.match(source, /async scheduled\(event, env, ctx\)\s*\{\s*env = withQuotaAwareKV\(env\);\s*ctx\.waitUntil\(runAutomaticFuturesAlertScan\(env\)\);/);
});

test("the live Futures scan is routed through the Kraken Futures analyzer", () => {
  assert.ok(source.includes("return analyzeFuturesSymbol(ticker, oneHour, fourHour, fifteenMinute, {"));
  assert.ok(source.includes("...options, btcFourHourTrend, requireBtcFourHourAlignment: true"));
  assert.ok(source.includes("function calculateFourHourTrend("));
  assert.doesNotMatch(source, /analyzePriceAction|TREND_SHORT|RALLY_FADE/);
  assert.doesNotMatch(source, /from ["']\.\/price-action-engine\.js["']/);
});

test("the separate Price Action module is clearly marked inactive", () => {
  assert.match(researchEngine, /^\/\/ STATUS: INACTIVE \/ RESEARCH-ONLY\./);
});

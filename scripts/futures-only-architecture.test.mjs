import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../src/index.js", import.meta.url), "utf8");
const researchEngine = await readFile(new URL("../src/price-action-engine.js", import.meta.url), "utf8");

test("bot exposes the Kraken Futures signal engine only", () => {
  assert.match(source, /async function runFuturesSignalScan/);
  assert.match(source, /function analyzeFuturesSymbol\(/);
  assert.match(source, /testDataSources\(\)/);
  assert.doesNotMatch(source, /callback_data: "analysis"/);
  assert.doesNotMatch(source, /callback_data: "watchlist"/);
  assert.doesNotMatch(source, /spot-engine|runSpotScan|runSpotAssetDetail|testSpotDataSources|spot-scan-lock|spotd:|command === "\/scan"/i);
});

test("manual and scheduled Futures alerts both use the same Futures scan", () => {
  assert.match(source, /const result = await runFuturesSignalScan\(env\);/);
  assert.match(source, /async scheduled\(event, env, ctx\)\s*\{\s*env = withQuotaAwareKV\(env\);\s*ctx\.waitUntil\(runAutomaticFuturesAlertScan\(env\)\);/);
});

test("the live Futures scan is routed through the Kraken Futures analyzer", () => {
  assert.ok(source.includes("return analyzeFuturesSymbol(ticker, oneHour, fourHour, fifteenMinute, analysisOptions)"));
  assert.ok(source.includes("const analysisOptions = {"));
  assert.ok(source.includes("...options, btcFourHourTrend, requireBtcFourHourAlignment: true"));
  assert.ok(source.includes("skipEntryFilters: true"));
  assert.ok(source.includes("preflight?.eligible !== true && preflight?.highRiskEligible !== true"));
  assert.ok(source.includes("function calculateFourHourTrend("));
  assert.doesNotMatch(source, /analyzePriceAction|TREND_SHORT|RALLY_FADE/);
  assert.doesNotMatch(source, /from ["']\.\/price-action-engine\.js["']/);
});

test("the separate Price Action module is clearly marked inactive", () => {
  assert.match(researchEngine, /^\/\/ STATUS: INACTIVE \/ RESEARCH-ONLY\./);
});

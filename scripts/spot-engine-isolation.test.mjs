import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { findSpotPairs, selectBestSpotPair, formatSpotPrice } from "../src/spot-engine.js";

const source = await readFile(new URL("../src/index.js", import.meta.url), "utf8");
const engine = await readFile(new URL("../src/spot-engine.js", import.meta.url), "utf8");

test("Spot scanner is isolated from shared futures storage and scheduled futures delivery", () => {
  assert.doesNotMatch(engine, /APP_KV|SIGNAL_DELIVERY|sendAndArchiveFuturesSignal|global:automatic-futures-scan-lock/);
  assert.match(engine, /روند بیت‌کوین تأیید صعودی نمی‌دهد/);
  assert.match(engine, /قدرت نسبی ارز نسبت به بیت‌کوین مثبت نیست/);
  assert.match(source, /if \(action === "spot"\) return runSpotMarketScanForChat\(env, chatId\);/);
  assert.match(source, /if \(action\.startsWith\("spotd:"\)\)/);
  assert.match(source, /const scan = await runSpotScan\(\);/);
  assert.match(engine, /export async function testSpotDataSources\(\)/);
  assert.match(engine, /coin\.percent_change_24h = assetChange24Pct/);
  assert.match(engine, /dataFailures\.length/);
  assert.match(source, /runSpotAssetDetail\(symbol, quote\)/);
  const spotStart = source.indexOf("async function runSpotMarketScanForChat");
  const spotEnd = source.indexOf("async function showStatus", spotStart);
  assert.ok(spotStart >= 0 && spotEnd > spotStart);
  assert.match(source, /global:manual-spot-scan-lock/);
  assert.match(source, /spot-scan-lock\/acquire/);
  assert.match(source, /spot-scan-lock\/release/);
  assert.doesNotMatch(source.slice(spotStart, spotEnd), /global:automatic-futures-scan-lock/);
  assert.doesNotMatch(source.slice(spotStart, spotEnd), /sendAndArchiveFuturesSignal/);
});

test("Spot scanner considers both USD and USDT Kraken pairs for the same asset", () => {
  const coin = { symbol: "ABC" };
  const pairs = [
    { key: "ABCUSD", altname: "ABCUSD", wsname: "ABC/USD", status: "online" },
    { key: "ABCUSDT", altname: "ABCUSDT", wsname: "ABC/USDT", status: "online" },
    { key: "ABC/EUR", altname: "ABCEUR", wsname: "ABC/EUR", status: "online" }
  ];
  const matches = findSpotPairs(coin, pairs);
  assert.deepEqual(matches.map(pair => pair.wsname), ["ABC/USD", "ABC/USDT"]);
});

test("Best pair selection ranks usable liquidity and spread rather than first match", () => {
  const usd = { key: "ABCUSD", altname: "ABCUSD", wsname: "ABC/USD" };
  const usdt = { key: "ABCUSDT", altname: "ABCUSDT", wsname: "ABC/USDT" };
  const ticker = {
    ABCUSD: { a: ["10.05"], b: ["9.95"], c: ["10.00"], v: ["100", "1000"] },
    ABCUSDT: { a: ["10.01"], b: ["9.99"], c: ["10.00"], v: ["100", "5000"] }
  };
  const selected = selectBestSpotPair([usd, usdt], ticker);
  assert.equal(selected.pair.wsname, "ABC/USDT");
  assert.ok(selected.spreadPct < 0.8);
  assert.equal(selected.quoteVolumeUsd, 50_000);
});

test("illiquid or wide-spread quote pair is rejected", () => {
  const pair = { key: "XYZUSD", altname: "XYZUSD", wsname: "XYZ/USD" };
  const ticker = {
    XYZUSD: { a: ["10.20"], b: ["9.80"], c: ["10.00"], v: ["1", "100"] }
  };
  assert.equal(selectBestSpotPair([pair], ticker), null);
});

test("price formatting remains finite and stable for low-priced assets", () => {
  assert.equal(formatSpotPrice(0.000012345), "1.234e-5");
  assert.equal(formatSpotPrice(12.34567), "12.3457");
  assert.equal(formatSpotPrice(Number.NaN), "—");
});

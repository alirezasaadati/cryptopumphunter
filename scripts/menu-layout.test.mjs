import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../src/index.js", import.meta.url), "utf8");
const start = source.indexOf("function mainMenuForChat(env, chatId) {");
const end = source.indexOf("\n}\n", start) + 2;
assert.ok(start >= 0 && end > start, "mainMenuForChat must exist");
const menu = source.slice(start, end);

test("main inline menu keeps the approved button order and row layout", () => {
  assert.ok(menu.includes('"📈 Futures Signals"'));
  assert.doesNotMatch(menu, /Spot Signals|callback_data: "spot"/);
  assert.match(menu, /\[\s*\{ text: "🛡️ Risk Management Guide"/);
  assert.ok(menu.indexOf('"🗂 Signal Archive"') < menu.indexOf('"📊 Recent Signal Report"'));
  assert.ok(menu.indexOf('"👥 Member Management"') < menu.lastIndexOf('"🔍 User Trade Monitor"'));
  assert.ok(menu.indexOf('"📡 Bot Status"') < menu.indexOf('"🔌 Connection Test"'));
  assert.ok(menu.indexOf('"⚠️ Uncertain Deliveries"') < menu.indexOf('"ℹ️ About"'));
  assert.match(menu, /return \{ inline_keyboard: keyboard \}/);
  const callbackActions = [...menu.matchAll(/callback_data: "([^"]+)"/g)].map((match) => match[1]);
  const callbackHandler = source.slice(source.indexOf("async function handleCallback"));
  for (const action of callbackActions) {
    const isRouted = action === "members:0"
      ? callbackHandler.includes('action.startsWith("members:")')
      : action === "admin:signals"
        ? callbackHandler.includes('action==="admin:signals"') || callbackHandler.includes('action === "admin:signals"')
        : action === "outbox:review"
          ? callbackHandler.includes('action==="outbox:review"') || callbackHandler.includes('action === "outbox:review"')
          : callbackHandler.includes(`action === "${action}"`) || callbackHandler.includes(`action==="${action}"`);
    assert.ok(isRouted, `inline callback "${action}" must have a handler`);
  }
  assert.match(source, /\["⚠️ Uncertain Deliveries", "outbox:review"\]/);
});

test("reply menu keeps the original layout but hides after selection and is not reattached to every response", () => {
  const start = source.indexOf("function replyMenuForChat(env, chatId) {");
  const end = source.indexOf("\n}\n", start) + 2;
  assert.ok(start >= 0 && end > start, "replyMenuForChat must exist");
  const menu = source.slice(start, end);
  assert.match(menu, /resize_keyboard:\s*true/);
  assert.match(menu, /one_time_keyboard:\s*true/);
  assert.doesNotMatch(menu, /is_persistent:\s*true/);
  assert.match(menu, /"📈 Futures Signals"/);
  assert.doesNotMatch(menu, /Spot Signals/);
  assert.match(menu, /"🛡️ Risk Management Guide"/);
  assert.match(menu, /"👥 Member Management"/);
  assert.match(source, /function menuForChat\(env, chatId\)\s*\{\s*return null;/);
  assert.doesNotMatch(source, /remove_keyboard:\s*true/);
  assert.match(source, /replyMenuForChat\(env, chatId\)/);
});


test("capital guide is delivered through one shared HTML-safe path from both menu types", () => {
  assert.match(source, /async function sendCapitalManagementGuide\(env, chatId\)\s*\{\s*return sendMessage\(env, chatId, CAPITAL_MANAGEMENT_TEXT, null, "HTML"\);/);
  assert.equal((source.match(/sendCapitalManagementGuide\(env, chatId\)/g) || []).length, 3);
  assert.match(source, /if \(action === "capital_guide"\) \{\s*await sendCapitalManagementGuide\(env, chatId\);/);
  assert.match(source, /if \(action === "capital_guide"\) \{\s*await sendCapitalManagementGuide\(env, chatId\);/);
  assert.match(source, /3️⃣ SCALED ENTRIES/);
  assert.match(source, /enter \$5 at the first level and \$5 at the second/);
  assert.match(source, /Scaling in does not eliminate risk/);
  assert.match(source, /4️⃣ LEVERAGE & EXECUTION/);
  assert.match(source, /5️⃣ LATE ENTRIES/);
  assert.match(source, /6️⃣ PROFIT & STOP MANAGEMENT/);
});


test("all user-facing Spot scan entry points are removed from the Worker", () => {
  assert.doesNotMatch(source, /runSpotScan|runSpotAssetDetail|testSpotDataSources|runSpotMarketScanForChat|showSpotAssetDetailForChat|spotd:|spot-scan-lock|command === "\/scan"/i);
  assert.doesNotMatch(source, /krakenSpot|Kraken Spot|سیگنال اسپات/);
});

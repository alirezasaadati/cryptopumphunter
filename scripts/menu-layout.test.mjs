import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../src/index.js", import.meta.url), "utf8");
const start = source.indexOf("function mainMenuForChat(env, chatId) {");
const end = source.indexOf("\n}\n", start) + 2;
assert.ok(start >= 0 && end > start, "mainMenuForChat must exist");
const menu = source.slice(start, end);

test("main inline menu keeps the approved button order and row layout", () => {
  assert.ok(menu.includes('"📈 سیگنال فیوچرز"'));
  assert.doesNotMatch(menu, /سیگنال اسپات|callback_data: "spot"/);
  assert.match(menu, /\[\s*\{ text: "🛡️ راهنمای مدیریت سرمایه"/);
  assert.ok(menu.indexOf('"🗂 سیگنال‌های صادرشده"') < menu.indexOf('"📊 گزارش سیگنال‌های اخیر"'));
  assert.ok(menu.indexOf('"👥 مدیریت اعضا"') < menu.lastIndexOf('"🔍 پایش معاملات کاربران"'));
  assert.ok(menu.indexOf('"📡 وضعیت ربات"') < menu.indexOf('"🔌 تست اتصال"'));
  assert.ok(menu.indexOf('"⚠️ ارسال‌های نامشخص"') < menu.indexOf('"ℹ️ درباره"'));
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
  assert.match(source, /\["⚠️ ارسال‌های نامشخص", "outbox:review"\]/);
});

test("reply menu keeps the original layout but hides after selection and is not reattached to every response", () => {
  const start = source.indexOf("function replyMenuForChat(env, chatId) {");
  const end = source.indexOf("\n}\n", start) + 2;
  assert.ok(start >= 0 && end > start, "replyMenuForChat must exist");
  const menu = source.slice(start, end);
  assert.match(menu, /resize_keyboard:\s*true/);
  assert.match(menu, /one_time_keyboard:\s*true/);
  assert.doesNotMatch(menu, /is_persistent:\s*true/);
  assert.match(menu, /"📈 سیگنال فیوچرز"/);
  assert.doesNotMatch(menu, /سیگنال اسپات/);
  assert.match(menu, /"🛡️ راهنمای مدیریت سرمایه"/);
  assert.match(menu, /"👥 مدیریت اعضا"/);
  assert.match(source, /function menuForChat\(env, chatId\)\s*\{\s*return null;/);
  assert.doesNotMatch(source, /remove_keyboard:\s*true/);
  assert.match(source, /replyMenuForChat\(env, chatId\)/);
});


test("capital guide is delivered through one shared HTML-safe path from both menu types", () => {
  assert.match(source, /async function sendCapitalManagementGuide\(env, chatId\)\s*\{\s*return sendMessage\(env, chatId, CAPITAL_MANAGEMENT_TEXT, null, "HTML"\);/);
  assert.equal((source.match(/sendCapitalManagementGuide\(env, chatId\)/g) || []).length, 3);
  assert.match(source, /if \(action === "capital_guide"\) \{\s*await sendCapitalManagementGuide\(env, chatId\);/);
  assert.match(source, /if \(action === "capital_guide"\) \{\s*await sendCapitalManagementGuide\(env, chatId\);/);
  assert.match(source, /3️⃣ ورود پله‌ای به معامله/);
  assert.match(source, /۵ دلار را در نقطه ورود اول و ۵ دلار باقی‌مانده را در نقطه ورود دوم/);
  assert.match(source, /ورود پله‌ای به معنی جلوگیری قطعی از ضرر نیست/);
  assert.match(source, /4️⃣ اهرم و نحوه انجام معامله/);
  assert.match(source, /5️⃣ ورود بعد از تارگت اول/);
  assert.match(source, /6️⃣ سیو سود و مدیریت حد ضرر/);
});


test("all user-facing Spot scan entry points are removed from the Worker", () => {
  assert.doesNotMatch(source, /runSpotScan|runSpotAssetDetail|testSpotDataSources|runSpotMarketScanForChat|showSpotAssetDetailForChat|spotd:|spot-scan-lock|command === "\/scan"/i);
  assert.doesNotMatch(source, /krakenSpot|Kraken Spot|سیگنال اسپات/);
});

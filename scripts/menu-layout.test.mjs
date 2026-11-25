import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../src/index.js", import.meta.url), "utf8");
const start = source.indexOf("function mainMenuForChat(env, chatId) {");
const end = source.indexOf("\n}\n", start) + 2;
assert.ok(start >= 0 && end > start, "mainMenuForChat must exist");
const menu = source.slice(start, end);

test("main inline menu keeps the approved Futures-only button order and row layout", () => {
  assert.match(menu, /"📈 سیگنال فیوچرز"/);
  assert.doesNotMatch(menu, /سیگنال اسپات/);
  assert.match(menu, /\[\s*\{ text: "🛡️ راهنمای مدیریت سرمایه"/);
  assert.ok(menu.indexOf('"🗂 سیگنال‌های صادرشده"') < menu.indexOf('"📊 گزارش سیگنال‌های اخیر"'));
  assert.ok(menu.indexOf('"👥 مدیریت اعضا"') < menu.lastIndexOf('"🔍 پایش معاملات کاربران"'));
  assert.ok(menu.indexOf('"📡 وضعیت ربات"') < menu.indexOf('"🔌 تست اتصال"'));
  assert.ok(menu.indexOf('"⚠️ ارسال‌های نامشخص"') < menu.indexOf('"ℹ️ درباره"'));
  assert.match(menu, /return \{ inline_keyboard: keyboard \}/);
  assert.match(source, /\["⚠️ ارسال‌های نامشخص", "outbox:review"\]/);
});

test("reply menu keeps the approved Futures-only layout and is not reattached to every response", () => {
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

test("capital guide callback sends a message without an invalid null reply_markup", () => {
  const callbackStart = source.indexOf('if (action === "capital_guide") {');
  const callbackEnd = source.indexOf('\n    }', callbackStart) + 6;
  assert.ok(callbackStart >= 0 && callbackEnd > callbackStart);
  const callback = source.slice(callbackStart, callbackEnd);
  assert.match(callback, /telegram\("sendMessage", env, \{/);
  assert.match(callback, /text: CAPITAL_MANAGEMENT_TEXT/);
  assert.doesNotMatch(callback, /reply_markup/);

  const replyStart = source.indexOf('if (action === "capital_guide") {', callbackEnd);
  const replyEnd = source.indexOf('\n  }', replyStart) + 4;
  assert.ok(replyStart >= 0 && replyEnd > replyStart);
  const reply = source.slice(replyStart, replyEnd);
  assert.match(reply, /sendMessage\(env, chatId, CAPITAL_MANAGEMENT_TEXT, null, "HTML"\)/);
});

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

test("capital guide callback and reply-menu action omit null reply_markup", () => {
  const marker = 'if (action === "capital_guide") {';
  const firstStart = source.indexOf(marker);
  const secondStart = source.indexOf(marker, firstStart + marker.length);
  assert.ok(firstStart >= 0 && secondStart > firstStart);

  const firstEnd = source.indexOf('\n    return;\n  }', firstStart) + '\n    return;\n  }'.length;
  const first = source.slice(firstStart, firstEnd);
  assert.match(first, /sendMessage\(env, chatId, CAPITAL_MANAGEMENT_TEXT, null, "HTML"\)/);
  assert.doesNotMatch(first, /reply_markup/);

  const secondEnd = source.indexOf('\n    }', secondStart) + 6;
  const second = source.slice(secondStart, secondEnd);
  assert.match(second, /telegram\("sendMessage", env, \{/);
  assert.match(second, /text: CAPITAL_MANAGEMENT_TEXT/);
  assert.doesNotMatch(second, /reply_markup/);
});

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../src/index.js", import.meta.url), "utf8");
const start = source.indexOf("function replyMenuForChat(env, chatId) {");
const end = source.indexOf("\n}\n", start) + 2;
assert.ok(start >= 0 && end > start, "replyMenuForChat must exist");
const menu = source.slice(start, end);

test("main menu keeps the approved button order and row layout", () => {
  assert.ok(menu.indexOf('"📈 سیگنال فیوچرز"') < menu.indexOf('"📊 سیگنال اسپات"'));
  assert.match(menu, /\[\s*\{ text: "🛡️ راهنمای مدیریت سرمایه" \}\s*\]/);
  assert.ok(menu.indexOf('"🗂 سیگنال‌های صادرشده"') < menu.indexOf('"📊 گزارش سیگنال‌های اخیر"'));
  assert.ok(menu.indexOf('"👥 مدیریت اعضا"') < menu.lastIndexOf('"🔍 پایش معاملات کاربران"'));
  assert.ok(menu.indexOf('"📡 وضعیت ربات"') < menu.indexOf('"🔌 تست اتصال"'));
  assert.ok(menu.indexOf('"⚠️ ارسال‌های نامشخص"') < menu.indexOf('"ℹ️ درباره"'));
  assert.match(source, /\["⚠️ ارسال‌های نامشخص", "outbox:review"\]/);
});

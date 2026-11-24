import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../src/index.js", import.meta.url), "utf8");
const coordinatorStart = source.indexOf("export class SignalDeliveryCoordinator");
const coordinatorEnd = source.indexOf("async function showRecentFuturesSignalReport", coordinatorStart);
assert.ok(coordinatorStart >= 0 && coordinatorEnd > coordinatorStart);
const coordinator = source.slice(coordinatorStart, coordinatorEnd);

test("Durable Object coordinator performs no Telegram network I/O", () => {
  assert.doesNotMatch(coordinator, /\btelegram\s*\(/);
  assert.doesNotMatch(coordinator, /APP_KV/);
  assert.doesNotMatch(coordinator, /await\s+fetch\s*\(/);
  assert.doesNotMatch(coordinator, /\bsendMessage\s*\(/);
  assert.doesNotMatch(coordinator, /sendAndArchiveFuturesSignalUnlocked/);
  assert.doesNotMatch(coordinator, /publishSignalToArchive\s*\(/);
});

test("signal delivery uses short reserve/complete Durable Object calls and sends Telegram from the Worker", () => {
  const start = source.indexOf("async function sendAndArchiveFuturesSignal(env");
  const end = source.indexOf("export class SignalDeliveryCoordinator", start);
  assert.ok(start >= 0 && end > start);
  const workerDelivery = source.slice(start, end);
  assert.match(workerDelivery, /\/deliver\/reserve/);
  assert.match(workerDelivery, /\/deliver\/complete/);
  assert.match(workerDelivery, /await sendMessage\(env, chatId/);
  assert.match(workerDelivery, /await publishSignalToArchive\(/);
});

test("archive publishing reserves idempotency in the DO but sends Telegram from the Worker", () => {
  const start = source.indexOf("async function publishSignalToArchive");
  const end = source.indexOf("async function sendAndArchiveFuturesSignal", start);
  assert.ok(start >= 0 && end > start);
  const archive = source.slice(start, end);
  assert.match(archive, /\/archive-publish\/reserve/);
  assert.match(archive, /\/archive-publish\/complete/);
  assert.match(archive, /await telegram\("sendMessage", env/);
  assert.doesNotMatch(coordinator, /await telegram\(/);
});

test("legacy long-running DO delivery routes are removed", () => {
  assert.doesNotMatch(coordinator, /url\.pathname===["']\/deliver["']/);
  assert.doesNotMatch(coordinator, /url\.pathname===["']\/archive-publish["']/);
  assert.match(coordinator, /\/deliver\/reserve/);
  assert.match(coordinator, /\/deliver\/complete/);
  assert.match(coordinator, /\/archive-publish\/reserve/);
  assert.match(coordinator, /\/archive-publish\/complete/);
});

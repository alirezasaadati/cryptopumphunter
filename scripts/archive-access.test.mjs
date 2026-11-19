import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../src/index.js", import.meta.url), "utf8");

test("owner bot messages are copyable while regular-user messages remain protected", () => {
  assert.match(
    source,
    /method === "sendMessage" && !isOwner\(body\.chat_id, env\)[\s\S]*?protect_content: true/
  );
  assert.match(source, /function isOwner\(chatId, env\)/);
});

test("archive invite creation continues when KV cache read or write fails", () => {
  const start = source.indexOf("async function sendArchiveAccessLink");
  const end = source.indexOf("async function handleArchiveJoinRequest", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const fn = source.slice(start, end);
  assert.match(fn, /Archive invite cache read failed/);
  assert.match(fn, /Archive invite cache write failed/);
  assert.match(fn, /createChatInviteLink/);
  assert.match(fn, /sendMessage\(env,userId/);
});

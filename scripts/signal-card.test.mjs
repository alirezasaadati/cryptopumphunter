import test from "node:test";
import assert from "node:assert/strict";
import { inflateSync } from "node:zlib";
import { readFile } from "node:fs/promises";
import { renderSignalCardPng, getSignalCardDisplayData } from "../src/signal-card.js";

function readPngChunks(png) {
  const chunks = [];
  let offset = 8;
  while (offset < png.length) {
    const length = new DataView(png.buffer, png.byteOffset + offset, 4).getUint32(0);
    const type = new TextDecoder().decode(png.subarray(offset + 4, offset + 8));
    chunks.push({ type, data: png.subarray(offset + 8, offset + 8 + length) });
    offset += length + 12;
  }
  return chunks;
}

test("signal card renderer produces a valid compact indexed PNG", () => {
  const png = renderSignalCardPng({
    symbol: "PF_XBTUSD", side: "LONG", entry: 65000, stop: 64000,
    target1: 66000, target2: 67000, target3: 68000, riskLevel: "STANDARD", score: 82
  });
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.ok(png.length < 200_000, "signal card should remain small enough for Telegram photo upload");
  const chunks = readPngChunks(png);
  const header = chunks.find(chunk => chunk.type === "IHDR").data;
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  assert.equal(view.getUint32(0), 560);
  assert.equal(view.getUint32(4), 397);
  assert.equal(header[8], 4);
  assert.equal(header[9], 3);
  assert.equal(chunks.find(chunk => chunk.type === "PLTE").data.length, 24);
  const imageData = Buffer.concat(chunks.filter(chunk => chunk.type === "IDAT").map(chunk => Buffer.from(chunk.data)));
  assert.equal(inflateSync(imageData).length, 397 * (1 + 560 / 2));
});

test("signal card labels Kraken XBT as BTC and uses the real USD quote", () => {
  const display = getSignalCardDisplayData({ symbol: "PF_XBTUSD", side: "LONG" });
  assert.equal(display.symbol, "BTC");
  assert.equal(display.assetName, "BITCOIN");
  assert.equal(display.side, "LONG");
});

test("short signals render a distinct card and high risk is represented without invented leverage", async () => {
  const long = renderSignalCardPng({ symbol: "PF_XBTUSD", side: "LONG", entry: 65000, stop: 64000, target1: 66000, target2: 67000, target3: 68000, riskLevel: "STANDARD" });
  const short = renderSignalCardPng({ symbol: "PF_ETHUSD", side: "SHORT", entry: 3000, stop: 3100, target1: 2900, target2: 2800, target3: 2700, riskLevel: "HIGH_RISK" });
  assert.notDeepEqual(long, short);
  assert.equal(getSignalCardDisplayData({ symbol: "PF_ETHUSD", side: "SHORT", riskLevel: "HIGH_RISK" }).risk, "HIGH RISK");
  const rendererSource = await readFile(new URL("../src/signal-card.js", import.meta.url), "utf8");
  assert.doesNotMatch(rendererSource, /LEVERAGE|10x/);
});

test("Telegram delivery uses one photo upload with a full-text fallback", async () => {
  const source = await readFile(new URL("../src/index.js", import.meta.url), "utf8");
  assert.match(source, /async function telegramPhoto[\s\S]*?\/sendPhoto/);
  assert.match(source, /async function sendSignalCardOrText[\s\S]*?Telegram rejected the signal image[\s\S]*?sendMessage/);
  assert.match(source, /renderSignalCardPng\(signal\)/);
  assert.match(source, /cardPng, skipCardRender: true/);
});

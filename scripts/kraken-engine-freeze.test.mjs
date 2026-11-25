import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// Freeze the live Kraken signal engine while maintenance work is performed.
// FNV-1a is intentionally implemented over UTF-16 code units for deterministic
// hashing in both Node and the test runner.
function fingerprint(value) {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < value.length; i++) {
    hash ^= BigInt(value.charCodeAt(i));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
}

function extract(source, start, end) {
  const from = source.indexOf(start);
  assert.notEqual(from, -1, `Missing engine section: ${start}`);
  const to = end === "\n};"
    ? source.indexOf(end, from) + end.length
    : source.indexOf(end, from);
  assert.ok(to > from, `Could not locate end of engine section: ${end}`);
  return source.slice(from, to);
}

test("live Kraken engine configuration and signal logic remain unchanged", async () => {
  const source = await readFile(new URL("../src/index.js", import.meta.url), "utf8");
  const frozen = [
    [ "FUTURES_CONFIG", extract(source, "const FUTURES_CONFIG = {", "\n};"), "fca782b0ea13c5a4" ],
    [ "entry filters", extract(source, "function evaluateFuturesEntryFilters(", "function analyzeFuturesSymbol("), "7aa415766e056238" ],
    [ "signal analysis", extract(source, "function analyzeFuturesSymbol(", "function formatPrice("), "ccea59307f5d4a03" ],
    [ "Kraken scan pipeline", extract(source, "async function runFuturesSignalScan(", "async function runFuturesSignalsForChat("), "ceda8e6251d2bfe4" ]
  ];
  for (const [name, block, expected] of frozen) {
    assert.equal(fingerprint(block), expected, `${name} changed; do not modify the profitable Kraken engine as part of maintenance.`);
  }
});

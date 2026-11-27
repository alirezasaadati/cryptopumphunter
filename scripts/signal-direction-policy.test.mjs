import test from "node:test";
import assert from "node:assert/strict";
import { filterAllowedSignals, isAllowedSignalDirection } from "../src/signal-direction-policy.js";

const make = (side, riskLevel = "STANDARD") => ({ id: side + riskLevel, side, riskLevel });

test("SHORT-only policy blocks both standard and high-risk LONG candidates", () => {
  assert.equal(isAllowedSignalDirection(make("LONG")), false);
  assert.equal(isAllowedSignalDirection(make("LONG", "HIGH_RISK")), false);
});

test("SHORT-only policy preserves standard and high-risk SHORT candidates", () => {
  assert.equal(isAllowedSignalDirection(make("SHORT")), true);
  assert.equal(isAllowedSignalDirection(make("SHORT", "HIGH_RISK")), true);
});

test("filter removes LONG and malformed candidates without changing SHORT objects", () => {
  const standardShort = make("SHORT");
  const riskyShort = make("SHORT", "HIGH_RISK");
  const result = filterAllowedSignals([make("LONG"), make("LONG", "HIGH_RISK"), standardShort, riskyShort, null]);
  assert.deepEqual(result, [standardShort, riskyShort]);
  assert.equal(filterAllowedSignals(null).length, 0);
});

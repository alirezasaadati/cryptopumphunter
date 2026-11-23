import test from "node:test";
import assert from "node:assert/strict";
import { profitTargetPrice } from "../src/futures-trade-lifecycle.js";
const entry=100, longStop=98, longTarget=profitTargetPrice("LONG",entry,10,30);
assert.equal(longTarget,103);
const inverseStop=longTarget, inverseTarget=longStop;
assert.equal(inverseStop,103);
assert.equal(inverseTarget,98);
test("reversed LONG swaps original stop and target",()=>{
 assert.ok(inverseStop>entry);
 assert.ok(inverseTarget<entry);
});

import test from "node:test";
import assert from "node:assert/strict";
import {
  priceChangePercent,
  tradeResultR,
  tradeOutcomePercent,
  targetReached,
  stopReached,
  getNewClosedFuturesCandles,
  ensureTradeTrackingCheckpoint,
  isValidFuturesSignalLevels
} from "../src/index.js";

test("LONG and SHORT price returns use the correct direction", () => {
  assert.equal(priceChangePercent("LONG", 100, 105), 5);
  assert.equal(priceChangePercent("SHORT", 100, 95), 5);
  assert.equal(priceChangePercent("SHORT", 100, 105), -5);
});

test("TP/SL predicates respect trade direction", () => {
  assert.equal(targetReached("LONG", 110, 105), true);
  assert.equal(targetReached("SHORT", 95, 100), true);
  assert.equal(stopReached("LONG", 95, 100), true);
  assert.equal(stopReached("SHORT", 105, 100), true);
});

test("partial TP outcome includes the remaining position at the stop", () => {
  const trade = {
    side: "SHORT",
    actualEntry: 100,
    target1: 95,
    target2: 90,
    target3: 85,
    tpHits: ["TP1"]
  };
  const result = tradeOutcomePercent(trade, 105);
  // 40% at +5%, remaining 60% at -5% = -1%.
  assert.equal(Number(result.toFixed(8)), -1);
});

test("full TP3 outcome is the weighted result of all targets", () => {
  const trade = {
    side: "LONG",
    actualEntry: 100,
    target1: 105,
    target2: 110,
    target3: 120,
    tpHits: ["TP1", "TP2", "TP3"]
  };
  const result = tradeOutcomePercent(trade, 120);
  // 40%*5 + 35%*10 + 25%*20 = 10.5%.
  assert.equal(Number(result.toFixed(8)), 10.5);
});

test("signal tracking accepts correctly ordered LONG and SHORT levels", () => {
  assert.equal(isValidFuturesSignalLevels({id:"l1",symbol:"PI_ETHUSD",side:"LONG",entry:100,stop:95,target1:105,target2:110,target3:120}), true);
  assert.equal(isValidFuturesSignalLevels({id:"s1",symbol:"PI_ETHUSD",side:"SHORT",entry:100,stop:105,target1:95,target2:90,target3:80}), true);
});

test("signal tracking rejects missing, non-positive, and misordered levels", () => {
  const base = {id:"x1",symbol:"PI_ETHUSD",side:"LONG",entry:100,stop:95,target1:105,target2:110,target3:120};
  assert.equal(isValidFuturesSignalLevels({...base,target2:104}), false);
  assert.equal(isValidFuturesSignalLevels({...base,stop:101}), false);
  assert.equal(isValidFuturesSignalLevels({...base,target3:0}), false);
  assert.equal(isValidFuturesSignalLevels({...base,side:"SHORT"}), false);
  assert.equal(isValidFuturesSignalLevels({...base,id:""}), false);
});


test("tracking only processes candles newer than the last checked candle", () => {
  const candles = [
    { time: 60000, close: 100 },
    { time: 120000, close: 101 },
    { time: 180000, close: 102 }
  ];
  assert.deepEqual(
    getNewClosedFuturesCandles(candles, 120000).map(c => c.time),
    [180000]
  );
});

test("tracking does not fall back to an old candle when no new candle exists", () => {
  const candles = [
    { time: 60000, close: 100 },
    { time: 120000, close: 101 }
  ];
  assert.deepEqual(getNewClosedFuturesCandles(candles, 120000), []);
  assert.deepEqual(getNewClosedFuturesCandles([], 120000), []);
});


test("R accounting uses actual signal target distances and staged exits", () => {
  const base = {
    side: "LONG", actualEntry: 100, initialRisk: 5, currentStop: 95,
    target1: 107.5, target2: 112.5, target3: 117.5
  };
  assert.ok(Math.abs(tradeResultR({ ...base, tpHits: [] }, true) - (-1)) < 1e-9);
  assert.ok(Math.abs(tradeResultR({ ...base, tpHits: ["TP1"] }, true)) < 1e-9);
  // 40% at 1.5R + 35% at 2.5R + 25% remainder at -1R = 1.225R.
  assert.ok(Math.abs(tradeResultR({ ...base, tpHits: ["TP1", "TP2"] }, true) - 1.225) < 1e-9);
  // 40%*1.5R + 35%*2.5R + 25%*3.5R = 2.35R.
  assert.ok(Math.abs(tradeResultR({ ...base, tpHits: ["TP1", "TP2", "TP3"] }, false) - 2.35) < 1e-9);
});

test("R accounting is directionally correct for SHORT stop-outs", () => {
  const trade = {
    side: "SHORT", actualEntry: 100, initialRisk: 5, currentStop: 105,
    target1: 92.5, target2: 87.5, target3: 82.5, tpHits: ["TP1"]
  };
  assert.ok(Math.abs(tradeResultR(trade, true)) < 1e-9);
});

test("a candle spanning both stop and target is identifiable as ambiguous", () => {
  // The tracker resolves this ambiguity conservatively by checking stop first.
  const high = 106, low = 94;
  assert.equal(stopReached("LONG", low, 95), true);
  assert.equal(targetReached("LONG", high, 105), true);
  assert.equal(stopReached("SHORT", high, 105), true);
  assert.equal(targetReached("SHORT", low, 95), true);
});

test("legacy open trades start tracking from now instead of replaying old candles", () => {
  const trade = { id: "legacy-1", actualEntry: 100 };
  const now = 1801234567890;
  assert.equal(ensureTradeTrackingCheckpoint(trade, now), true);
  assert.equal(trade.lastCheckedCandleTime, Math.floor(now / 60000) * 60000);
  assert.equal(trade.trackingMode, "LEGACY_CONTINUED");
  assert.equal(ensureTradeTrackingCheckpoint(trade, now + 60000), false);
});

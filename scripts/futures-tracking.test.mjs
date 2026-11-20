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

test("single TP1 closes the full position; no second or third target is used", () => {
  const trade = {side:"SHORT",actualEntry:100,target1:97,tpHits:["TP1"]};
  assert.equal(Number(tradeOutcomePercent(trade,105).toFixed(8)),30);
  assert.equal(Number(tradeResultR({side:"SHORT",actualEntry:100,initialRisk:5,currentStop:105,target1:97,tpHits:["TP1"]},true).toFixed(8)),0.6);
});

test("signal tracking accepts three correctly ordered LONG or SHORT targets", () => {
  assert.equal(isValidFuturesSignalLevels({id:"l1",symbol:"PI_ETHUSD",side:"LONG",entry:100,stop:95,target1:107.5,target2:111,target3:115}), true);
  assert.equal(isValidFuturesSignalLevels({id:"s1",symbol:"PI_ETHUSD",side:"SHORT",entry:100,stop:105,target1:92.5,target2:89,target3:85}), true);
});

test("signal tracking rejects missing, non-positive, and misordered levels", () => {
  const base = {id:"x1",symbol:"PI_ETHUSD",side:"LONG",entry:100,stop:95,target1:107.5,target2:111,target3:115};
  assert.equal(isValidFuturesSignalLevels({...base,stop:101}), false);
  assert.equal(isValidFuturesSignalLevels({...base,target1:0}), false);
  assert.equal(isValidFuturesSignalLevels({...base,target2:106}), false);
  assert.equal(isValidFuturesSignalLevels({...base,target3:110}), false);
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


test("single-target R accounting uses the full position at 0.6R", () => {
  const base = {side:"LONG",actualEntry:100,initialRisk:5,currentStop:95,target1:103,tpHits:[]};
  assert.equal(tradeResultR(base,true),-1);
  assert.ok(Math.abs(tradeResultR({...base,tpHits:["TP1"]},true)-0.6)<1e-9);
  const short = {side:"SHORT",actualEntry:100,initialRisk:5,currentStop:105,target1:97,tpHits:["TP1"]};
  assert.ok(Math.abs(tradeResultR(short,true)-0.6)<1e-9);
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

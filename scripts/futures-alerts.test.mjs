import test from "node:test";
import assert from "node:assert/strict";
import {
  futuresSignalFingerprint,
  selectUnnotifiedFuturesSignals,
  futuresAlertStorageKey,
  formatFuturesSignalAlert
} from "../src/futures-alerts.js";

const base = {
  symbol: "BTCUSDT",
  side: "SHORT",
  strategyId: "market_structure",
  candleTime: "2026-11-17T09:15:00.000Z"
};

test("signal fingerprint is stable across repeated scans with different generated ids", () => {
  assert.equal(futuresSignalFingerprint({...base, id:"one"}), futuresSignalFingerprint({...base, id:"two"}));
});

test("different candle, side, symbol or strategy creates a distinct signal identity", () => {
  const first = futuresSignalFingerprint(base);
  assert.notEqual(first, futuresSignalFingerprint({...base, candleTime:"2026-11-17T09:30:00.000Z"}));
  assert.notEqual(first, futuresSignalFingerprint({...base, side:"LONG"}));
  assert.notEqual(first, futuresSignalFingerprint({...base, symbol:"ETHUSDT"}));
  assert.notEqual(first, futuresSignalFingerprint({...base, strategyId:"sr_rejection"}));
});

test("Kraken Futures engine signals without strategy metadata receive a stable fingerprint", () => {\n  const engineSignal = { symbol: "XRPUSDT", side: "LONG", candleTime: "2026-11-17T09:15:00.000Z" };\n  assert.ok(futuresSignalFingerprint(engineSignal));\n  assert.equal(futuresSignalFingerprint(engineSignal), futuresSignalFingerprint({...engineSignal, id: "new-generated-id"}));\n});\n\ntest("invalid signal identity is rejected", () => {
  assert.equal(futuresSignalFingerprint({...base, candleTime:null}), null);
  assert.equal(futuresSignalFingerprint({...base, side:"BUY"}), null);
});

test("only unseen unique signals are selected", () => {
  const repeated = {...base, id:"different"};
  const next = {...base, symbol:"ETHUSDT"};
  const seen = new Set([futuresSignalFingerprint(base)]);
  const selected = selectUnnotifiedFuturesSignals([base, repeated, next], seen);
  assert.equal(selected.length, 1);
  assert.equal(selected[0].signal.symbol, "ETHUSDT");
});

test("per-chat storage keys are distinct and stable", () => {
  const fp = futuresSignalFingerprint(base);
  assert.equal(futuresAlertStorageKey("123", fp), futuresAlertStorageKey("123", fp));
  assert.notEqual(futuresAlertStorageKey("123", fp), futuresAlertStorageKey("456", fp));
});

test("each alert is numbered simply, strips USDT, and shows Persian direction with colored emoji", () => {
  const signal = {...base, entry: 65000, stop: 66000, target1: 63500, target2: 62800, target3: 62000};
  const first = formatFuturesSignalAlert(signal, 1);
  const second = formatFuturesSignalAlert({...signal, symbol:"ETH-USDT", side:"LONG"}, 2);
  assert.match(first, /^🎯 سیگنال ۱/);
  assert.doesNotMatch(first, /سیگنال جدیدی شکل گرفته|از 2/);
  assert.match(first, /نماد: BTC/);
  assert.match(first, /جهت معامله: 🔴 شورت/);
  assert.match(first, /📍 ورود: 65000/);
  assert.match(first, /🛑 حد ضرر: 66000/);
  assert.match(first, /🎯 تارگت ۱: 63500/);
  assert.match(first, /🎯 تارگت ۲: 62800/);
  assert.match(first, /🎯 تارگت ۳: 62000/);
  assert.doesNotMatch(first, /نقطه ورود/);
  assert.equal(first.split("\n").filter(line => /^(📍 ورود|🛑 حد ضرر|🎯 تارگت)/.test(line)).length, 5);
  assert.match(second, /^🎯 سیگنال ۲/);
  assert.match(second, /نماد: ETH/);
  assert.match(second, /جهت معامله: 🟢 لانگ/);
  assert.doesNotMatch(first, /ETH/);
});
test("numeric candle timestamps in seconds and milliseconds produce the same identity", () => {
  const seconds = 1794906900;
  const milliseconds = seconds * 1000;
  assert.equal(
    futuresSignalFingerprint({...base, candleTime: seconds}),
    futuresSignalFingerprint({...base, candleTime: milliseconds})
  );
});

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

test("Kraken Futures engine signals without strategy metadata receive a stable fingerprint", () => {
  const engineSignal = { symbol: "XRPUSDT", side: "LONG", candleTime: "2026-11-17T09:15:00.000Z" };
  assert.ok(futuresSignalFingerprint(engineSignal));
  assert.equal(futuresSignalFingerprint(engineSignal), futuresSignalFingerprint({...engineSignal, id: "new-generated-id"}));
});

test("invalid signal identity is rejected", () => {
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

test("signal alert uses the approved HTML layout, bold prices, spacing and direction label", () => {
  const signal = {...base, symbol:"PF_BTCUSD", entry: 65000, stop: 66000, target1: 63500, target2: 62800, target3: 62000};
  const short = formatFuturesSignalAlert(signal, 1);
  const long = formatFuturesSignalAlert({...signal, symbol:"PF_ETHUSD", side:"LONG"}, 2);
  assert.match(short, /^⚪ سیگنال معتبر\n\n/);
  assert.match(short, /نماد: <b>BTC<\/b>/);
  assert.match(short, /جهت معامله: 🔴 شورت \/ Short/);
  assert.match(short, /جهت معامله: 🔴 شورت \/ Short\n\nقیمت ورود:/);
  assert.match(short, /قیمت ورود: <b>65,000\.00<\/b>\n\n🎯 تارگت اول \(1\.5R\): <b>63,500\.00<\/b>/);
  assert.ok(short.includes("🎯 تارگت اول (1.5R): <b>63,500.00</b>\n\n🎯 تارگت دوم (2.2R): <b>62,800.00</b>\n\n🎯 تارگت سوم (3R): <b>62,000.00</b>\n\n⛔ حد ضرر: <b>66,000.00</b>"));
  assert.match(short, /تارگت دوم \(2\.2R\)/);
  assert.match(short, /تارگت سوم \(3R\)/);
  assert.match(long, /^⚪ سیگنال معتبر/);
  assert.match(long, /نماد: <b>ETH<\/b>/);
  assert.match(long, /جهت معامله: 🟢 لانگ \/ Long/);
  const formerlyRisky = formatFuturesSignalAlert({...signal, tier:"EXPERIMENTAL"}, 3);
  assert.match(formerlyRisky, /^⚪ سیگنال معتبر/);
  assert.match(formerlyRisky, /⛔ حد ضرر:/);
  assert.doesNotMatch(short, /PF_|BTCUSD/);
  const krakenXbt = formatFuturesSignalAlert({...signal, symbol:"PF_XBTUSD"}, 4);
  const krakenNvdx = formatFuturesSignalAlert({...signal, symbol:"PF_NVDXUSD"}, 5);
  const lowercase = formatFuturesSignalAlert({...signal, symbol:"pf_adausd"}, 6);
  assert.match(krakenXbt, /نماد: <b>BTC<\/b>/);
  assert.match(krakenNvdx, /نماد: <b>NVDA<\/b>/);
  assert.match(lowercase, /نماد: <b>ADA<\/b>/);
});
test("numeric candle timestamps in seconds and milliseconds produce the same identity", () => {
  const seconds = 1794906900;
  const milliseconds = seconds * 1000;
  assert.equal(
    futuresSignalFingerprint({...base, candleTime: seconds}),
    futuresSignalFingerprint({...base, candleTime: milliseconds})
  );
});

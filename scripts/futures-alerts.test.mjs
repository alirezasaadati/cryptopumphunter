import test from "node:test";
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import {
  futuresSignalFingerprint,
  selectUnnotifiedFuturesSignals,
  futuresAlertStorageKey,
  formatFuturesSignalAlert,
  displayEntryPrice
} from "../src/futures-alerts.js";

const base = {
  symbol: "BTCUSDT",
  side: "SHORT",
  strategyId: "market_structure",
  candleTime: "2026-11-17T09:15:00.000Z"
};

test("display entry price is 1% higher for SHORT and 1.5% lower for LONG", () => {
  assert.equal(displayEntryPrice(65000, "SHORT"), 65650);
  assert.equal(displayEntryPrice(65000, "LONG"), 64025);
  assert.equal(displayEntryPrice(0.5, "SHORT"), 0.505);
  assert.equal(displayEntryPrice(0.5, "LONG"), 0.4925);
  assert.ok(Number.isNaN(displayEntryPrice(undefined, "LONG")));
  assert.ok(Number.isNaN(displayEntryPrice(65000, "UNKNOWN")));
});

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

test("signal alert matches the current Persian production template", () => {
  const signal = {...base, symbol:"PF_BTCUSD", entry:65000, stop:64500, target1:65800, target2:66400, target3:67200, score:82};
  const short = formatFuturesSignalAlert(signal, 1);
  const long = formatFuturesSignalAlert({...signal, symbol:"PF_ETHUSD", side:"LONG"}, 2);
  assert.equal(short, [
    "⚪ <b>سیگنال معتبر</b>",
    "⭐ امتیاز سیگنال: <b>82/100</b>",
    "نماد: <b>BTC</b>",
    "جهت معامله: 🔴 شورت / Short",
    "قیمت ورود: <b>65,000</b>",
    "🎯 تارگت اول (1.5R): <b>65,800</b>",
    "🎯 تارگت دوم (2.5R): <b>66,400</b>",
    "🎯 تارگت سوم (3.5R): <b>67,200</b>",
    "⛔ حد ضرر: <b>64,500</b>"
  ].join("\n\n"));
  assert.ok(long.includes("جهت معامله: 🟢 لانگ / Long"));
  assert.ok(formatFuturesSignalAlert({...signal, riskLevel:"HIGH_RISK"}).includes("⚠️ <b>سیگنال پر ریسک</b>"));
  assert.doesNotMatch(short, /PREMIUM SIGNALS|RISK|Entry Zone|LEVERAGE|10x/);
  assert.doesNotMatch(short, /PF_|BTCUSD/);
});

test("numeric candle timestamps in seconds and milliseconds produce the same identity", () => {
  const seconds = 1794906900;
  const milliseconds = seconds * 1000;
  assert.equal(
    futuresSignalFingerprint({...base, candleTime: seconds}),
    futuresSignalFingerprint({...base, candleTime: milliseconds})
  );
});


test("manual Futures signal formatter matches the approved plain-text layout", async () => {
  const source = await readFile(new URL("../src/index.js", import.meta.url), "utf8");
  assert.ok(source.includes("`Entry Zone 1 : ${formatSignalDisplayPrice(item.entry)}`"));
  assert.ok(source.includes("`Entry Zone 2 : ${formatSignalDisplayPrice(displayEntryPrice(item.entry, item.side))}`"));
  assert.ok(source.includes("`⛔ SL : ${formatSignalDisplayPrice(item.stop)}`"));
  assert.ok(source.includes('lines.map(line => `\\u200E${line}`).join("\\n")'));
});

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

test("signal alert uses the premium English TRADEYAR layout and preserves price calculations", () => {
  const signal = {...base, symbol:"PF_BTCUSD", entry:65000, stop:66000, target1:63500, target2:62800, target3:62000, score:82};
  const short = formatFuturesSignalAlert(signal, 1);
  const long = formatFuturesSignalAlert({...signal, symbol:"PF_ETHUSD", side:"LONG"}, 2);
  assert.match(short, /^<b>PREMIUM SIGNALS<\/b>  •  <b>TRADEYAR<\/b>/);
  assert.match(short, /<b>🔴 SHORT ↘<\/b>  •  <b>BTC\/USD<\/b>/);\n  assert.match(short, /<i>Bitcoin Perpetual<\/i>/);
  assert.match(short, /<b>STOP LOSS<\/b>  <code>66,000\.00<\/code>\s+\|\s+<b>ENTRY PRICE<\/b>  <code>65,000\.00<\/code>/);
  assert.match(short, /Entry 2: <code>65,650\.00<\/code>/);
  assert.match(short, /🎯 TP1  <code>63,500\.00<\/code>/);
  assert.match(short, /🎯 TP2  <code>62,800\.00<\/code>/);
  assert.match(short, /🎯 TP3  <code>62,000\.00<\/code>/);
  assert.match(short, /<b>RISK<\/b>  STANDARD/);
  assert.doesNotMatch(short, /LEVERAGE|10x/);
  assert.match(short, /Score: <b>82\/100<\/b>/);
  assert.match(long, /<b>🟢 LONG ↗<\/b>  •  <b>ETH\/USD<\/b>/);
  assert.match(long, /Entry 2: <code>64,025\.00<\/code>/);
  assert.match(formatFuturesSignalAlert({...signal, riskLevel:"HIGH_RISK"}), /<b>RISK<\/b>  HIGH RISK/);
  assert.doesNotMatch(short, /[\u0600-\u06FF]/);
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


test("manual Futures signal formatter uses the premium layout and keeps the display-only entry adjustment", async () => {
  const source = await readFile(new URL("../src/index.js", import.meta.url), "utf8");
  assert.ok(source.includes("`<b>PREMIUM SIGNALS</b>  •  <b>TRADEYAR</b>\\n` +"));
  assert.ok(source.includes("`<b>STOP LOSS</b>  <code>${stop}</code>   |   <b>ENTRY PRICE</b>  <code>${entry}</code>\\n` +"));
  assert.ok(source.includes("formatSignalPrice(displayEntryPrice(item.entry, item.side))"));
});

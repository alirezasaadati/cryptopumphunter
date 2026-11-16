import test from "node:test";
import assert from "node:assert/strict";
import { simulateTrade } from "./backtest-kraken.mjs";
import {
  FUTURES_CONFIG,
  isKrakenPerpetualTicker,
  calculateAtr,
  analyzeFuturesSymbol,
  getKrakenFuturesCandles
} from "../src/index.js";

function makeCandles({ count = 120, slope = 0.015, base = 100, volume = 100 } = {}) {
  const closes = Array.from({ length: count }, (_, i) =>
    base + i * slope + (i % 2 ? 0.12 : -0.12)
  );
  return closes.map((close, i) => {
    const open = i ? closes[i - 1] : close - 0.1;
    const last = i === count - 1;
    return {
      time: Date.now() - (count - i) * 60 * 60 * 1000,
      open,
      high: last ? close + 0.05 : Math.max(open, close) + 0.08,
      low: last ? open - 0.05 : Math.min(open, close) - 0.08,
      close,
      volume: last ? volume * 2 : volume
    };
  });
}

function makeValidSetup() {
  const oneHour = makeCandles();
  const fourHour = makeCandles({ slope: 0.04, base: 100 });
  const ticker = {
    symbol: "PF_TESTUSD",
    last: oneHour.at(-1).close + 0.02,
    quoteVolume: 12_000_000,
    priceChangePercent: 2,
    premium: { lastFundingRate: 0.0001 }
  };
  return { ticker, oneHour, fourHour };
}

test("Kraken perpetual filter accepts liquid PI/PF USD perpetuals only", () => {
  assert.equal(isKrakenPerpetualTicker({
    tag: "perpetual", symbol: "PF_XBTUSD", volumeQuote: 8_000_000, last: 50_000
  }), true);
  assert.equal(isKrakenPerpetualTicker({
    tag: "futures", symbol: "PF_XBTUSD", volumeQuote: 8_000_000, last: 50_000
  }), false);
  assert.equal(isKrakenPerpetualTicker({
    tag: "perpetual", symbol: "BTC/USD", volumeQuote: 8_000_000, last: 50_000
  }), false);
  assert.equal(isKrakenPerpetualTicker({
    tag: "perpetual", symbol: "PF_XBTUSD", volumeQuote: 1_000, last: 50_000
  }), false);
});

test("ATR rejects insufficient candles and calculates positive volatility", () => {
  assert.equal(calculateAtr(makeCandles().slice(0, 10), 14), null);
  assert.ok(calculateAtr(makeCandles(), 14) > 0);
});

test("strong aligned 1h/4h setup produces a bounded LONG plan", () => {
  const { ticker, oneHour, fourHour } = makeValidSetup();
  const result = analyzeFuturesSymbol(ticker, oneHour, fourHour);
  assert.equal(result.side, "LONG");
  assert.equal(result.eligible, true);
  assert.ok(result.score >= FUTURES_CONFIG.MIN_SCORE);
  assert.ok(result.stop < result.entry);
  assert.ok(result.target1 > result.entry);
  assert.ok(result.target2 > result.target1);
  assert.ok(result.target3 > result.target2);
  assert.ok(result.rewardRisk >= 2);
});

test("excessive live-price drift from the confirmed candle is rejected", () => {
  const { ticker, oneHour, fourHour } = makeValidSetup();
  const atr = calculateAtr(oneHour, 14);
  ticker.last = oneHour.at(-1).close + atr * 0.6;
  const result = analyzeFuturesSymbol(ticker, oneHour, fourHour);
  assert.match(result.rejected, /فاصله گرفته است/);
});

test("weak confirmation volume is rejected", () => {
  const { ticker, oneHour, fourHour } = makeValidSetup();
  oneHour.at(-1).volume = 100;
  const result = analyzeFuturesSymbol(ticker, oneHour, fourHour);
  assert.match(result.rejected, /حجم کندل/);
});

test("insufficient candle history is rejected", () => {
  const { ticker, oneHour, fourHour } = makeValidSetup();
  assert.throws(
    () => analyzeFuturesSymbol(ticker, oneHour.slice(0, 30), fourHour),
    /تعداد کندل بسته‌شده/
  );
});

test("chart loader sorts candles, filters malformed rows and excludes the forming candle", async () => {
  const originalFetch = globalThis.fetch;
  const now = Date.now();
  const validOld = {
    time: now - 3 * 60 * 60 * 1000,
    open: 100, high: 102, low: 99, close: 101, volume: 20
  };
  const validRecent = {
    time: now - 2 * 60 * 60 * 1000,
    open: 101, high: 103, low: 100, close: 102, volume: 30
  };
  const forming = {
    time: now - 30 * 60 * 1000,
    open: 102, high: 104, low: 101, close: 103, volume: 40
  };
  globalThis.fetch = async () => new Response(JSON.stringify({
    candles: [validRecent, { ...validOld, close: "bad" }, forming, validOld]
  }), { status: 200, headers: { "Content-Type": "application/json" } });
  try {
    const candles = await getKrakenFuturesCandles("PF_TESTUSD", "1h");
    assert.deepEqual(candles.map(c => c.close), [101, 102]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("paper exit simulation scales out 40/35/25 at the three targets", () => {
  const candles = [
    { time: 1, open: 100, high: 101.6, low: 100.1, close: 101.4 },
    { time: 2, open: 101.4, high: 102.3, low: 101.2, close: 102.2 },
    { time: 3, open: 102.2, high: 103.1, low: 102.0, close: 103.0 }
  ];
  const trade = simulateTrade({
    side: "LONG", entry: 100, stop: 99, targets: [101.5, 102.2, 103],
    candles, startIndex: 0, fee: 0, slippage: 0
  });
  assert.equal(trade.targetHits, 3);
  assert.equal(trade.exitReason, "TARGETS");
  assert.ok(Math.abs(trade.netR - 2.13) < 1e-9);
});

test("paper exit simulation resolves same-candle stop and target as stop first", () => {
  const trade = simulateTrade({
    side: "LONG", entry: 100, stop: 99, targets: [101.5, 102.2, 103],
    candles: [{ time: 1, open: 100, high: 102.5, low: 98.5, close: 101 }],
    startIndex: 0, fee: 0, slippage: 0
  });
  assert.equal(trade.targetHits, 0);
  assert.equal(trade.exitReason, "STOP");
  assert.equal(trade.netR, -1);
});

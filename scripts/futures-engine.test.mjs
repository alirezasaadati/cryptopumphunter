import test from "node:test";
import assert from "node:assert/strict";
import { simulateTrade, repriceSignalForExecution } from "./backtest-kraken.mjs";
import {
  FUTURES_CONFIG,
  FUTURES_PROVIDER_ORDER,
  isKrakenFuturesPerpetual,
  normalizeKrakenFuturesUnderlying,
  getKrakenFuturesUniverse,
  getKrakenFuturesCandles,
  calculateAtr,
  analyzeFuturesSymbol,
  getFuturesUniverse,
  tradeResultR,
  calculateTradeEconomics,
  qualifyTradeEconomics,
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
  const oneHour = Array.from({length:40},(_,i)=>({
    time:i*3600000,open:100,high:100.2,low:99.8,close:100,volume:100
  }));
  const set1h=(i,c)=>{oneHour[i]={time:i*3600000,volume:100,...c};};
  set1h(10,{open:100,high:101,low:99.9,close:100.4});
  set1h(15,{open:99.8,high:100.1,low:99,close:100});
  set1h(20,{open:100,high:100.8,low:99.9,close:100.3});
  set1h(25,{open:99.9,high:100.1,low:99.2,close:100});
  set1h(30,{open:100,high:101.2,low:99.9,close:100.5});
  set1h(35,{open:99.9,high:100.1,low:99.6,close:100});
  set1h(38,{open:100.8,high:101.1,low:100.6,close:101});
  set1h(39,{open:101,high:101.5,low:100.9,close:101.4});
  const fourHour=Array.from({length:40},(_,i)=>({
    time:i*14400000,open:100,high:100.2,low:99.8,close:100,volume:100
  }));
  const fifteenMin=Array.from({length:40},(_,i)=>({
    time:i*900000,open:100,high:100.2,low:99.8,close:100,volume:100
  }));
  fifteenMin[38]={time:38*900000,open:100,high:100.1,low:99.9,close:100,volume:100};
  fifteenMin[39]={time:39*900000,open:101.1,high:101.6,low:101,close:101.4,volume:100};
  const ticker = {
    symbol: "PF_TESTUSD", last: 101.4,
    quoteVolume: 12_000_000, priceChangePercent: 2,
    premium: { lastFundingRate: 0.0001 }
  };
  return { ticker, oneHour, fourHour, fifteenMin };
}

test("Futures provider order is Kraken only", () => {
  assert.deepEqual(FUTURES_PROVIDER_ORDER, ["Kraken"]);
  assert.equal(FUTURES_CONFIG.MAX_SYMBOLS, 32);
  assert.equal(FUTURES_CONFIG.CONCURRENCY, 2);
  assert.equal(FUTURES_CONFIG.MIN_QUOTE_VOLUME, 3_000_000);
  assert.equal(FUTURES_CONFIG.PREFERRED_MIN_QUOTE_VOLUME, 5_000_000);
  assert.equal(FUTURES_CONFIG.REFERENCE_MARGIN_USD, 10);
  assert.equal(FUTURES_CONFIG.REFERENCE_LEVERAGE, 10);
  assert.equal(FUTURES_CONFIG.MIN_PROJECTED_PROFIT_USD, 2);
  assert.equal(FUTURES_CONFIG.MAX_STOP_LOSS_USD, 2);
});

test("Kraken Futures accepts liquid perpetual contracts and normalizes XBT", () => {
  assert.equal(isKrakenFuturesPerpetual({ symbol: "PF_XBTUSD", tag: "perpetual", volumeQuote: 8_000_000, last: 67000 }), true);
  assert.equal(isKrakenFuturesPerpetual({ symbol: "PF_XBTUSD", tag: "month", volumeQuote: 8_000_000, last: 67000 }), false);
  assert.equal(isKrakenFuturesPerpetual({ symbol: "PF_XBTUSD", tag: "perpetual", volumeQuote: 100, last: 67000 }), false);
  for (const symbol of ["PF_NVDAXUSD", "PF_AAPLXUSD", "PF_TSLAXUSD", "PF_SPYXUSD", "PF_AMZNXUSD"]) {
    assert.equal(isKrakenFuturesPerpetual({ symbol, tag: "perpetual", volumeQuote: 8_000_000, last: 100 }), false, symbol);
  }
  assert.equal(isKrakenFuturesPerpetual({ symbol: "PF_APEXUSD", tag: "perpetual", volumeQuote: 8_000_000, last: 100 }), true);
  assert.equal(normalizeKrakenFuturesUnderlying("PF_XBTUSD"), "BTC");
  assert.equal(normalizeKrakenFuturesUnderlying("PI_ETHUSD"), "ETH");
});

test("Kraken Futures universe uses public Derivatives tickers", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async url => {
    assert.match(String(url), /futures\.kraken\.com\/derivatives\/api\/v3\/tickers/);
    return new Response(JSON.stringify({ result: "success", tickers: [
      { symbol: "PF_XBTUSD", tag: "perpetual", volumeQuote: 12_000_000, last: 67000, fundingRate: 0.0001 },
      { symbol: "PF_ETHUSD", tag: "perpetual", volumeQuote: 8_000_000, last: 3500 }
    ] }), { status: 200 });
  };
  try {
    const tickers = await getKrakenFuturesUniverse();
    assert.equal(tickers.length, 2);
    assert.equal(tickers[0].exchange, "Kraken");
    assert.equal(tickers[0].underlying, "BTC");
    assert.equal(tickers[0].last, 67000);
  } finally { globalThis.fetch = originalFetch; }
});

test("Kraken Futures candles normalize chart data and exclude the forming candle", async () => {
  const originalFetch = globalThis.fetch;
  const now = Date.now(), interval = 60 * 60 * 1000;
  globalThis.fetch = async url => {
    assert.match(String(url), /api\/charts\/v1\/trade\/PF_XBTUSD\/1h\?count=/);
    return new Response(JSON.stringify({ candles: [
      { time: now - 3 * interval, open: 100, high: 102, low: 99, close: 101, volume: 20 },
      { time: now - 2 * interval, open: 101, high: 103, low: 100, close: 102, volume: 30 },
      { time: now - interval / 2, open: 102, high: 104, low: 101, close: 103, volume: 40 }
    ] }), { status: 200 });
  };
  try {
    const candles = await getKrakenFuturesCandles("PF_XBTUSD", "1h");
    assert.deepEqual(candles.map(c => c.close), [101, 102]);
    assert.equal(candles[0].volume, 20);
  } finally { globalThis.fetch = originalFetch; }
});

test("ATR rejects insufficient candles and calculates positive volatility", () => {
  assert.equal(calculateAtr(makeCandles().slice(0, 10), 14), null);
  assert.ok(calculateAtr(makeCandles(), 14) > 0);
});

test("strong aligned 1h/4h setup produces a bounded LONG plan", () => {
  const { ticker, oneHour, fourHour, fifteenMin } = makeValidSetup();
  const result = analyzeFuturesSymbol(ticker, oneHour, fourHour, fifteenMin);
  assert.equal(result.side, "LONG");
  assert.equal(result.eligible, true);
  assert.ok(result.score >= FUTURES_CONFIG.MIN_SCORE);
  assert.ok(result.stop < result.entry);
  assert.ok(result.target1 > result.entry);
  assert.ok(result.target2 > result.target1);
  assert.ok(result.target3 > result.target2);
  assert.equal(result.rewardRisk, 1.5);
});

test("strategy diagnostics expose all four strategies without changing signal eligibility", () => {
  const { ticker, oneHour, fourHour, fifteenMin } = makeValidSetup();
  const result = analyzeFuturesSymbol(ticker, oneHour, fourHour, fifteenMin);
  assert.equal(result.eligible, true);
  assert.equal(result.diagnostics.length, 4);
  assert.deepEqual(
    result.diagnostics.map(x => x.strategyId).sort(),
    ["breakout_retest", "candlestick", "market_structure", "sr_rejection"].sort()
  );
  assert.ok(result.diagnostics.every(x => x.status && x.statusLabel && x.reason));
  assert.ok(result.diagnostics.some(x => x.status === "accepted"));
});

test("insufficient candle history is rejected", () => {
  const { ticker, oneHour, fourHour, fifteenMin } = makeValidSetup();
  const result = analyzeFuturesSymbol(ticker, oneHour.slice(0, 30), fourHour, fifteenMin);
  assert.ok(result.rejected);
});

test("backtest trade simulation scales out 20/20/60 at the three targets", () => {
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
  assert.ok(Math.abs(trade.netR - 2.54) < 1e-9);
});

test("backtest trade simulation resolves same-candle stop and target as stop first", () => {
  const trade = simulateTrade({
    side: "LONG", entry: 100, stop: 99, targets: [101.5, 102.2, 103],
    candles: [{ time: 1, open: 100, high: 102.5, low: 98.5, close: 101 }],
    startIndex: 0, fee: 0, slippage: 0
  });
  assert.equal(trade.targetHits, 0);
  assert.equal(trade.exitReason, "STOP");
  assert.equal(trade.netR, -1);
});


test("late entry is rejected when live price has moved beyond the allowed band", () => {
  const { ticker, oneHour, fourHour, fifteenMin } = makeValidSetup();
  ticker.last = oneHour.at(-1).close * 1.01;
  const result = analyzeFuturesSymbol(ticker, oneHour, fourHour, fifteenMin);
  assert.match(result.rejected, /ورود دیرهنگام/);
});

test("partial TP1 locks 0.6R if break-even is confirmed, but not before", () => {
  const trade = { side: "LONG", actualEntry: 100, initialRisk: 10, currentStop: 100, tpHits: ["TP1"] };
  assert.ok(Math.abs(tradeResultR(trade, true) - 0.6) < 1e-9);
  trade.currentStop = 90;
  assert.ok(Math.abs(tradeResultR(trade, true)) < 1e-9);
});

test("full 40/35/25 target plan matches the 2.12R backtest model", () => {
  const trade = { side: "LONG", actualEntry: 100, initialRisk: 10, currentStop: 100, tpHits: ["TP1", "TP2", "TP3"] };
  assert.ok(Math.abs(tradeResultR(trade, false) - 2.12) < 1e-9);
});



test("new staged exits use 20/20/60 and realize 2.54R at all targets", () => {
  const trade = { side:"LONG", actualEntry:100, initialRisk:10, currentStop:100,
    tpHits:["TP1","TP2","TP3"], exitWeights:[.20,.20,.60] };
  assert.ok(Math.abs(tradeResultR(trade,false)-2.54)<1e-9);
});

test("ETH example is rejected because $10 margin at 10x projects less than $2 gross profit", () => {
  const signal = { side:"LONG", entry:1823.30, stop:1812.52,
    target1:1839.48, target2:1847.02, target3:1855.65 };
  const economics = calculateTradeEconomics(signal);
  assert.ok(Math.abs(economics.maxLossUsd-0.5912)<0.002);
  assert.ok(Math.abs(economics.projectedProfitUsd-1.5027)<0.003);
  assert.equal(qualifyTradeEconomics(economics).eligible,false);
});

test("economics filter accepts a sufficiently attractive trade and caps dollar stop risk", () => {
  const economics = calculateTradeEconomics({side:"LONG",entry:100,stop:99,target1:101.5,target2:102.2,target3:103});
  assert.equal(qualifyTradeEconomics(economics).eligible,true);
  assert.ok(economics.maxLossUsd<=2);
  assert.ok(economics.projectedProfitUsd>=2);
});

test("backtest reprices LONG and SHORT entries at executable fills and preserves target R multiples", () => {
  const long = repriceSignalForExecution({
    side:"LONG",entry:100,stop:99,target1:101.5,target2:102.2,target3:103
  },100.1);
  assert.ok(Math.abs(long.entry-100.1)<1e-9);
  assert.ok(Math.abs(long.target1-101.75)<1e-9);
  assert.ok(Math.abs(long.target2-102.3)<1e-9);
  assert.ok(Math.abs(long.target3-103.4)<1e-9);

  const short = repriceSignalForExecution({
    side:"SHORT",entry:100,stop:101,target1:98.5,target2:97.8,target3:97
  },99.9);
  assert.ok(Math.abs(short.entry-99.9)<1e-9);
  assert.ok(Math.abs(short.target1-98.4)<1e-9);
  assert.ok(Math.abs(short.target2-97.7)<1e-9);
  assert.ok(Math.abs(short.target3-96.9)<1e-9);
  assert.equal(repriceSignalForExecution({side:"LONG",entry:100,stop:99,target1:101.5,target2:102.2,target3:103},98.9),null);
});

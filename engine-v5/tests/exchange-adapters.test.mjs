import test from "node:test";
import assert from "node:assert/strict";
import { createBinanceAdapter } from "../src/exchanges/binance.js";
import { createBybitAdapter } from "../src/exchanges/bybit.js";
import { createOkxAdapter } from "../src/exchanges/okx.js";
import { createKrakenAdapter } from "../src/exchanges/kraken.js";
import { collectExchangeOverviews } from "../src/exchanges/index.js";

function mockFetch(routes) {
  return async input => {
    const url = new URL(String(input));
    const route = routes.find(([match]) => url.href.includes(match));
    if (!route) throw new Error(`Unexpected URL: ${url.href}`);
    return new Response(JSON.stringify(route[1]), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };
}

test("Binance adapter normalizes spot and perpetual tickers", async () => {
  const fetchImpl = mockFetch([
    ["/api/v3/exchangeInfo", { symbols: [{ symbol: "BTCUSDT", status: "TRADING", baseAsset: "BTC", quoteAsset: "USDT" }] }],
    ["/api/v3/ticker/24hr", [{ symbol: "BTCUSDT", lastPrice: "100", bidPrice: "99", askPrice: "101", volume: "10", quoteVolume: "1000", priceChangePercent: "2", highPrice: "105", lowPrice: "95", closeTime: 10 }]],
    ["/fapi/v1/exchangeInfo", { symbols: [{ symbol: "BTCUSDT", status: "TRADING", contractType: "PERPETUAL", baseAsset: "BTC", quoteAsset: "USDT" }] }],
    ["/fapi/v1/ticker/24hr", [{ symbol: "BTCUSDT", lastPrice: "100", bidPrice: "99", askPrice: "101", volume: "20", quoteVolume: "2000", priceChangePercent: "3", highPrice: "106", lowPrice: "94", closeTime: 11 }]],
    ["/fapi/v1/premiumIndex", [{ symbol: "BTCUSDT", lastFundingRate: "0.0001" }]]
  ]);
  const result = await createBinanceAdapter(fetchImpl).fetchOverview();
  assert.equal(result.instruments.length, 2);
  assert.equal(result.tickers.length, 2);
  assert.equal(result.tickers.find(x => x.marketType === "perpetual").fundingRate, 0.0001);
  assert.equal(result.tickers[0].spreadBps, 200);
});

test("Bybit adapter paginates linear instruments and normalizes tickers", async () => {
  const fetchImpl = async input => {
    const url = new URL(String(input));
    const category = url.searchParams.get("category");
    const path = url.pathname;
    let body;
    if (path.endsWith("instruments-info")) {
      body = { retCode: 0, result: { list: [{ symbol: category === "spot" ? "ETHUSDT" : "BTCUSDT", status: "Trading", baseCoin: category === "spot" ? "ETH" : "BTC", quoteCoin: "USDT", contractType: category === "linear" ? "LinearPerpetual" : undefined }], nextPageCursor: "" } };
    } else if (path.endsWith("tickers")) {
      body = { retCode: 0, result: { list: [{ symbol: category === "spot" ? "ETHUSDT" : "BTCUSDT", lastPrice: "10", bid1Price: "9", ask1Price: "11", volume24h: "5", turnover24h: "50", price24hPcnt: "0.01", openInterest: "100", fundingRate: "0.0002" }] } };
    } else throw new Error(`Unexpected Bybit URL: ${url.href}`);
    return new Response(JSON.stringify(body), { status: 200 });
  };
  const result = await createBybitAdapter(fetchImpl).fetchOverview();
  assert.equal(result.instruments.length, 2);
  assert.equal(result.tickers.find(x => x.marketType === "perpetual").openInterest, 100);
});

test("OKX adapter normalizes spot and swap instruments", async () => {
  const fetchImpl = async input => {
    const url = new URL(String(input));
    const instType = url.searchParams.get("instType");
    const isSwap = instType === "SWAP";
    const isTicker = url.pathname.includes("/market/tickers");
    const row = isSwap
      ? { instId: "BTC-USDT-SWAP", baseCcy: "BTC", quoteCcy: "", settleCcy: "USDT", state: "live" }
      : { instId: "ETH-USDT", baseCcy: "ETH", quoteCcy: "USDT", state: "live" };
    const ticker = isSwap
      ? { instId: "BTC-USDT-SWAP", last: "20", bidPx: "19", askPx: "21", vol24h: "4", volCcy24h: "80", ts: "100" }
      : { instId: "ETH-USDT", last: "10", bidPx: "9", askPx: "11", vol24h: "5", volCcy24h: "50", ts: "100" };
    return new Response(JSON.stringify({ code: "0", data: [isTicker ? ticker : row] }), { status: 200 });
  };
  const result = await createOkxAdapter(fetchImpl).fetchOverview();
  assert.equal(result.instruments.length, 2);
  assert.equal(result.tickers.length, 2);
  assert.ok(result.instruments.some(x => x.marketType === "perpetual"));
});

test("Kraken adapter normalizes spot and futures public market data", async () => {
  const fetchImpl = mockFetch([
    ["/0/public/AssetPairs", { error: [], result: { XXBTZUSD: { wsname: "XBT/USD", altname: "XBTUSD" } } }],
    ["/0/public/Ticker", { error: [], result: { XXBTZUSD: { a: ["101"], b: ["99"], c: ["100"], v: ["1", "2"], h: ["105", "110"], l: ["95", "90"] } } }],
    ["/derivatives/api/v3/instruments", { result: "success", instruments: [{ symbol: "PF_XBTUSD", pair: "XBT:USD", type: "perpetual", tradable: true }] }],
    ["/derivatives/api/v3/tickers", { result: "success", tickers: [{ symbol: "PF_XBTUSD", last: 100, bid: 99, ask: 101, volume: 5, openInterest: 50 }] }]
  ]);
  const result = await createKrakenAdapter(fetchImpl).fetchOverview();
  assert.equal(result.instruments.length, 2);
  assert.equal(result.tickers.length, 2);
  assert.equal(result.tickers.find(x => x.marketType === "perpetual").openInterest, 50);
});

test("one exchange failure does not discard healthy exchange data", async () => {
  const result = await collectExchangeOverviews([
    { id: "healthy", fetchOverview: async () => ({ instruments: [{ instrumentId: "x" }], tickers: [] }) },
    { id: "unavailable", fetchOverview: async () => { throw new Error("rate limited"); } }
  ]);
  assert.equal(result.healthyExchanges, 1);
  assert.equal(result.failedExchanges, 1);
  assert.equal(result.instruments.length, 1);
  assert.equal(result.exchanges.find(x => x.exchange === "unavailable").error, "rate limited");
});

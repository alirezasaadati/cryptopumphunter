import { getJson } from "./http.js";
import { normalizeInstrument, normalizeTicker } from "./normalize.js";

const SPOT = "https://api.kraken.com/0/public";
const FUTURES = "https://futures.kraken.com/derivatives/api/v3";

export function createKrakenAdapter(fetchImpl = fetch) {
  return {
    id: "kraken",
    async fetchOverview() {
      const [assetPairs, spotTickerBody, futuresInstruments, futuresTickerBody] = await Promise.all([
        getJson(`${SPOT}/AssetPairs`, fetchImpl),
        getJson(`${SPOT}/Ticker`, fetchImpl),
        getJson(`${FUTURES}/instruments`, fetchImpl),
        getJson(`${FUTURES}/tickers`, fetchImpl)
      ]);
      if (futuresInstruments.result && futuresInstruments.result !== "success") {
        throw new Error("Kraken Futures instruments request failed");
      }
      if (futuresTickerBody.result && futuresTickerBody.result !== "success") {
        throw new Error("Kraken Futures tickers request failed");
      }

      const instruments = [];
      const tickers = [];
      const spotRows = assetPairs.result || {};
      for (const [key, row] of Object.entries(spotRows)) {
        const pairName = row.wsname || row.altname || "";
        const [base, quote] = pairName.split("/");
        if (!base || !["USD", "USDT", "USDC", "EUR"].includes(quote)) continue;
        const symbol = row.altname || key;
        const instrument = normalizeInstrument({
          exchange: "kraken", symbol, unifiedSymbol: `${base}/${quote}`,
          marketType: "spot", base, quote, status: "online", raw: row
        });
        if (!instrument) continue;
        instruments.push(instrument);
        const tickerKey = key;
        const t = spotTickerBody.result?.[tickerKey] || spotTickerBody.result?.[symbol];
        if (!t) continue;
        tickers.push(normalizeTicker({
          instrument, last: t.c?.[0], bid: t.b?.[0], ask: t.a?.[0],
          baseVolume: t.v?.[1], high: t.h?.[1], low: t.l?.[1], timestamp: Date.now(), raw: t
        }));
      }

      const futureRows = futuresInstruments.instruments || futuresInstruments.data || [];
      const futureTickerRows = futuresTickerBody.tickers || futuresTickerBody.data || [];
      const futureTickerMap = new Map(futureTickerRows.map(t => [t.symbol || t.product_id || t.instrument, t]));
      for (const row of futureRows) {
        const symbol = row.symbol || row.instrumentName || row.product_id;
        const pair = row.pair || row.underlying || "";
        if (!symbol || !pair || !/perpetual/i.test(row.type || row.tag || symbol)) continue;
        const normalizedPair = String(pair).replace(/:/g, "/").replace(/-/g, "/");
        const [base, quoteRaw] = normalizedPair.split("/");
        const quote = quoteRaw || "USD";
        if (!base || !["USD", "USDT", "USDC"].includes(quote)) continue;
        const instrument = normalizeInstrument({
          exchange: "kraken", symbol, unifiedSymbol: `${base}/${quote}`,
          marketType: "perpetual", base, quote, status: row.tradable ? "online" : "unknown", raw: row
        });
        if (!instrument) continue;
        instruments.push(instrument);
        const t = futureTickerMap.get(symbol);
        if (!t) continue;
        tickers.push(normalizeTicker({
          instrument, last: t.last, bid: t.bid, ask: t.ask,
          baseVolume: t.volume, quoteVolume: t.volumeQuote, high: t.high, low: t.low,
          openInterest: t.openInterest, timestamp: Date.now(), raw: t
        }));
      }
      return { exchange: "kraken", instruments, tickers, fetchedAt: Date.now() };
    },
    async fetchSpotOrderBook(pair, count = 25) {
      const body = await getJson(`${SPOT}/Depth?pair=${encodeURIComponent(pair)}&count=${count}`, fetchImpl);
      const key = Object.keys(body.result || {}).find(k => k !== "last");
      const book = key ? body.result[key] : null;
      return { exchange: "kraken", symbol: pair, bids: book?.bids || [], asks: book?.asks || [], timestamp: Date.now() };
    }
  };
}

import { getJson, withQuery } from "./http.js";
import { normalizeInstrument, normalizeTicker } from "./normalize.js";

const SPOT = "https://data-api.binance.vision";
const FUTURES = "https://fapi.binance.com";

export function createBinanceAdapter(fetchImpl = fetch) {
  return {
    id: "binance",
    async fetchOverview() {
      const [spotInfo, spotTickers, futuresInfo, futuresTickers, premium] = await Promise.all([
        getJson(`${SPOT}/api/v3/exchangeInfo`, fetchImpl),
        getJson(`${SPOT}/api/v3/ticker/24hr`, fetchImpl),
        getJson(`${FUTURES}/fapi/v1/exchangeInfo`, fetchImpl),
        getJson(`${FUTURES}/fapi/v1/ticker/24hr`, fetchImpl),
        getJson(`${FUTURES}/fapi/v1/premiumIndex`, fetchImpl)
      ]);

      const instruments = [];
      const tickers = [];
      const premiumBySymbol = new Map((Array.isArray(premium) ? premium : [premium]).map(x => [x.symbol, x]));

      const addMarket = (info, tickerRows, marketType) => {
        const tickerMap = new Map((tickerRows || []).map(row => [row.symbol, row]));
        for (const row of info.symbols || []) {
          if (row.status !== "TRADING") continue;
          if (!["USDT", "USDC"].includes(row.quoteAsset)) continue;
          if (marketType === "perpetual" && row.contractType !== "PERPETUAL") continue;
          const instrument = normalizeInstrument({
            exchange: "binance", symbol: row.symbol, unifiedSymbol: `${row.baseAsset}/${row.quoteAsset}`,
            marketType, base: row.baseAsset, quote: row.quoteAsset, status: row.status, raw: row
          });
          if (!instrument) continue;
          instruments.push(instrument);
          const t = tickerMap.get(row.symbol);
          if (!t) continue;
          const p = premiumBySymbol.get(row.symbol);
          tickers.push(normalizeTicker({
            instrument, last: t.lastPrice, bid: t.bidPrice, ask: t.askPrice,
            baseVolume: t.volume, quoteVolume: t.quoteVolume, changePct: t.priceChangePercent,
            high: t.highPrice, low: t.lowPrice, fundingRate: marketType === "perpetual" ? p?.lastFundingRate : null,
            timestamp: t.closeTime || Date.now(), raw: t
          }));
        }
      };
      addMarket(spotInfo, spotTickers, "spot");
      addMarket(futuresInfo, futuresTickers, "perpetual");
      return { exchange: "binance", instruments, tickers, fetchedAt: Date.now() };
    },
    async fetchOpenInterest(symbol) {
      const data = await getJson(withQuery(`${FUTURES}/fapi/v1/openInterest`, { symbol }), fetchImpl);
      return { exchange: "binance", symbol, openInterest: Number(data.openInterest), timestamp: data.time || Date.now() };
    }
  };
}

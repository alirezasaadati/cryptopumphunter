import { getJson, withQuery } from "./http.js";
import { normalizeInstrument, normalizeTicker } from "./normalize.js";

const BASE = "https://api.bybit.com";

export function createBybitAdapter(fetchImpl = fetch) {
  async function instruments(category) {
    let cursor;
    const all = [];
    do {
      const body = await getJson(withQuery(`${BASE}/v5/market/instruments-info`, {
        category, limit: 1000, cursor
      }), fetchImpl);
      if (body.retCode !== 0) throw new Error(`Bybit ${category} instruments: ${body.retMsg}`);
      all.push(...(body.result?.list || []));
      cursor = body.result?.nextPageCursor || "";
    } while (cursor);
    return all;
  }

  async function tickers(category) {
    const body = await getJson(withQuery(`${BASE}/v5/market/tickers`, { category }), fetchImpl);
    if (body.retCode !== 0) throw new Error(`Bybit ${category} tickers: ${body.retMsg}`);
    return body.result?.list || [];
  }

  return {
    id: "bybit",
    async fetchOverview() {
      const [spotRows, spotTickerRows, linearRows, linearTickerRows] = await Promise.all([
        instruments("spot"), tickers("spot"), instruments("linear"), tickers("linear")
      ]);
      const allInstruments = [];
      const allTickers = [];
      const add = (rows, tickerRows, marketType) => {
        const tickerMap = new Map(tickerRows.map(x => [x.symbol, x]));
        for (const row of rows) {
          if (row.status !== "Trading") continue;
          if (!["USDT", "USDC"].includes(row.quoteCoin)) continue;
          if (marketType === "perpetual" && row.contractType && !String(row.contractType).includes("Perpetual")) continue;
          const instrument = normalizeInstrument({
            exchange: "bybit", symbol: row.symbol, unifiedSymbol: `${row.baseCoin}/${row.quoteCoin}`,
            marketType, base: row.baseCoin, quote: row.quoteCoin, status: row.status, raw: row
          });
          if (!instrument) continue;
          allInstruments.push(instrument);
          const t = tickerMap.get(row.symbol);
          if (!t) continue;
          allTickers.push(normalizeTicker({
            instrument, last: t.lastPrice, bid: t.bid1Price, ask: t.ask1Price,
            baseVolume: t.volume24h, quoteVolume: t.turnover24h, changePct: t.price24hPcnt,
            high: t.highPrice24h, low: t.lowPrice24h, openInterest: marketType === "perpetual" ? t.openInterest : null,
            fundingRate: marketType === "perpetual" ? t.fundingRate : null,
            timestamp: Date.now(), raw: t
          }));
        }
      };
      add(spotRows, spotTickerRows, "spot");
      add(linearRows, linearTickerRows, "perpetual");
      return { exchange: "bybit", instruments: allInstruments, tickers: allTickers, fetchedAt: Date.now() };
    },
    async fetchOrderBook(category, symbol, limit = 50) {
      const body = await getJson(withQuery(`${BASE}/v5/market/orderbook`, { category, symbol, limit }), fetchImpl);
      if (body.retCode !== 0) throw new Error(`Bybit orderbook: ${body.retMsg}`);
      return { exchange: "bybit", symbol, bids: body.result?.b || [], asks: body.result?.a || [], timestamp: body.time || Date.now() };
    }
  };
}

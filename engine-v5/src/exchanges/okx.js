import { getJson, withQuery } from "./http.js";
import { normalizeInstrument, normalizeTicker } from "./normalize.js";

const BASE = "https://www.okx.com";

export function createOkxAdapter(fetchImpl = fetch) {
  async function request(path, params) {
    const body = await getJson(withQuery(`${BASE}${path}`, params), fetchImpl);
    if (body.code !== "0") throw new Error(`OKX API error: ${body.msg || body.code}`);
    return body.data || [];
  }

  return {
    id: "okx",
    async fetchOverview() {
      const [spotInstruments, spotTickers, swapInstruments, swapTickers] = await Promise.all([
        request("/api/v5/public/instruments", { instType: "SPOT" }),
        request("/api/v5/market/tickers", { instType: "SPOT" }),
        request("/api/v5/public/instruments", { instType: "SWAP" }),
        request("/api/v5/market/tickers", { instType: "SWAP" })
      ]);
      const instruments = [];
      const tickers = [];
      const add = (rows, tickerRows, marketType) => {
        const tickerMap = new Map(tickerRows.map(x => [x.instId, x]));
        for (const row of rows) {
          if (row.state !== "live") continue;
          if (!["USDT", "USDC"].includes(row.quoteCcy || row.settleCcy)) continue;
          if (marketType === "perpetual" && !String(row.instId).endsWith("-SWAP")) continue;
          const quote = row.quoteCcy || row.settleCcy;
          const instrument = normalizeInstrument({
            exchange: "okx", symbol: row.instId, unifiedSymbol: `${row.baseCcy}/${quote}`,
            marketType, base: row.baseCcy, quote, status: row.state, raw: row
          });
          if (!instrument) continue;
          instruments.push(instrument);
          const t = tickerMap.get(row.instId);
          if (!t) continue;
          tickers.push(normalizeTicker({
            instrument, last: t.last, bid: t.bidPx, ask: t.askPx,
            baseVolume: t.vol24h, quoteVolume: t.volCcy24h,
            high: t.high24h, low: t.low24h, timestamp: t.ts, raw: t
          }));
        }
      };
      add(spotInstruments, spotTickers, "spot");
      add(swapInstruments, swapTickers, "perpetual");
      return { exchange: "okx", instruments, tickers, fetchedAt: Date.now() };
    },
    async fetchDerivativesMetrics(instId) {
      const [oi, funding] = await Promise.all([
        request("/api/v5/public/open-interest", { instType: "SWAP", instId }),
        request("/api/v5/public/funding-rate", { instId })
      ]);
      return {
        exchange: "okx", symbol: instId,
        openInterest: oi[0]?.oi ? Number(oi[0].oi) : null,
        fundingRate: funding[0]?.fundingRate ? Number(funding[0].fundingRate) : null,
        timestamp: Date.now()
      };
    }
  };
}

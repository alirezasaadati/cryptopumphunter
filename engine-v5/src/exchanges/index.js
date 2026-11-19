import { createBinanceAdapter } from "./binance.js";
import { createBybitAdapter } from "./bybit.js";
import { createOkxAdapter } from "./okx.js";
import { createKrakenAdapter } from "./kraken.js";

export function createExchangeAdapters(fetchImpl = fetch) {
  return [
    createBinanceAdapter(fetchImpl),
    createBybitAdapter(fetchImpl),
    createOkxAdapter(fetchImpl),
    createKrakenAdapter(fetchImpl)
  ];
}

export async function collectExchangeOverviews(adapters = createExchangeAdapters()) {
  const results = await Promise.all(adapters.map(async adapter => {
    try {
      return { ok: true, ...await adapter.fetchOverview() };
    } catch (error) {
      return {
        ok: false,
        exchange: adapter.id,
        error: String(error?.message || error),
        fetchedAt: Date.now()
      };
    }
  }));
  return {
    fetchedAt: Date.now(),
    exchanges: results,
    healthyExchanges: results.filter(x => x.ok).length,
    failedExchanges: results.filter(x => !x.ok).length,
    instruments: results.flatMap(x => x.ok ? x.instruments : []),
    tickers: results.flatMap(x => x.ok ? x.tickers : [])
  };
}

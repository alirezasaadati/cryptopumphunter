import { createExchangeAdapters } from "../src/exchanges/index.js";

const adapters = createExchangeAdapters();
const startedAt = Date.now();
const results = await Promise.all(adapters.map(async adapter => {
  const started = Date.now();
  try {
    const result = await adapter.fetchOverview();
    const validInstruments = (result.instruments || []).filter(x => x && x.nativeSymbol && x.exchange);
    const validTickers = (result.tickers || []).filter(x => x && x.nativeSymbol && Number.isFinite(x.last) && x.last > 0);
    return {
      exchange: adapter.id,
      status: validInstruments.length && validTickers.length ? "PASS" : "WARN",
      instruments: validInstruments.length, tickers: validTickers.length,
      elapsedMs: Date.now() - started,
      note: validInstruments.length && validTickers.length ? undefined : "No usable instrument/ticker rows returned"
    };
  } catch (error) {
    return { exchange: adapter.id, status: "FAIL", elapsedMs: Date.now() - started, error: String(error?.message || error).slice(0, 240) };
  }
}));
for (const result of results) console.log(JSON.stringify(result));
const passed = results.filter(x => x.status === "PASS").length;
const failed = results.filter(x => x.status === "FAIL").length;
console.log(JSON.stringify({ summary: true, passed, failed, warnings: results.length - passed - failed, totalElapsedMs: Date.now() - startedAt }));
if (failed > 0 || passed === 0) process.exitCode = 1;

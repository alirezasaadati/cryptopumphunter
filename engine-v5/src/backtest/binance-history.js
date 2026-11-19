const BASE = "https://data-api.binance.vision";

export async function fetchBinanceKlines({ symbol, interval = "5m", days = 90, endTime = Date.now(), fetchImpl = fetch, onPage = () => {} }) {
  if (!/^[A-Z0-9]{3,30}$/.test(symbol)) throw new Error("Invalid Binance symbol");
  if (!["1m","3m","5m","15m","30m","1h","2h","4h"].includes(interval)) throw new Error("Unsupported interval");
  if (!Number.isInteger(days) || days < 1 || days > 180) throw new Error("days must be between 1 and 180");
  const intervalMs = intervalMilliseconds(interval);
  const start = endTime - days * 86400000;
  let cursor = start;
  const rows = [];
  while (cursor < endTime) {
    const url = new URL("/api/v3/klines", BASE);
    url.searchParams.set("symbol", symbol);
    url.searchParams.set("interval", interval);
    url.searchParams.set("startTime", String(cursor));
    url.searchParams.set("endTime", String(endTime));
    url.searchParams.set("limit", "1000");
    const response = await fetchImpl(url, { headers: { accept: "application/json" } });
    if (!response.ok) throw new Error(`Binance historical klines ${response.status} for ${symbol}`);
    const batch = await response.json();
    if (!Array.isArray(batch)) throw new Error(`Unexpected Binance kline response for ${symbol}`);
    if (!batch.length) break;
    for (const k of batch) {
      if (!Array.isArray(k) || k.length < 11) continue;
      rows.push({
        openTime: Number(k[0]), open: Number(k[1]), high: Number(k[2]), low: Number(k[3]),
        close: Number(k[4]), volume: Number(k[5]), closeTime: Number(k[6]),
        quoteVolume: Number(k[7]), trades: Number(k[8]), takerBuyBase: Number(k[9]),
        takerBuyQuote: Number(k[10])
      });
    }
    const next = Number(batch[batch.length - 1][0]) + intervalMs;
    if (!Number.isFinite(next) || next <= cursor) throw new Error("Historical pagination stalled");
    cursor = next;
    onPage({ symbol, rows: rows.length, cursor });
    if (batch.length < 1000) break;
  }
  return rows.filter(x => x.openTime >= start && x.closeTime < endTime).sort((a,b) => a.openTime-b.openTime);
}

export function intervalMilliseconds(interval) {
  const m = /^(\d+)(m|h)$/.exec(interval);
  if (!m) throw new Error("Unsupported interval");
  return Number(m[1]) * (m[2] === "m" ? 60000 : 3600000);
}

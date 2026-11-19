const BASE = "https://www.okx.com";
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function fetchOkxKlines({ instId, bar = "5m", days = 90, endTime = Date.now(), fetchImpl = fetch, onPage = () => {}, requestDelayMs = 125 }) {
  if (!/^[A-Z0-9]+(?:-[A-Z0-9]+){1,3}$/.test(instId)) throw new Error("Invalid OKX instrument ID");
  if (bar !== "5m") throw new Error("Backtest downloader currently supports 5m candles only");
  if (!Number.isInteger(days) || days < 1 || days > 180) throw new Error("days must be between 1 and 180");
  const intervalMs = 300000;
  const start = endTime - days * 86400000;
  let after;
  let previousOldest = Infinity;
  const rows = [];
  while (true) {
    const url = new URL("/api/v5/market/history-candles", BASE);
    url.searchParams.set("instId", instId);
    url.searchParams.set("bar", bar);
    url.searchParams.set("limit", "100");
    if (after) url.searchParams.set("after", String(after));
    const response = await fetchImpl(url, { headers: { accept: "application/json" } });
    if (response.status === 429) {
      const retryAfter = Number(response.headers.get("retry-after"));
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2000);
      continue;
    }
    if (!response.ok) throw new Error(`OKX historical candles HTTP ${response.status} for ${instId}`);
    const body = await response.json();
    if (body.code !== "0" || !Array.isArray(body.data)) throw new Error(`OKX historical candles API error for ${instId}: ${body.msg || body.code}`);
    if (!body.data.length) break;
    let oldest = Infinity;
    for (const k of body.data) {
      if (!Array.isArray(k) || k.length < 9) continue;
      const ts = Number(k[0]);
      if (!Number.isFinite(ts)) continue;
      oldest = Math.min(oldest, ts);
      // OKX confirm=1 marks a completed candle; never include the still-forming bar.
      if (k[8] !== "1" || ts < start || ts + intervalMs > endTime) continue;
      rows.push({
        openTime: ts, open: Number(k[1]), high: Number(k[2]), low: Number(k[3]),
        close: Number(k[4]), volume: Number(k[7]), closeTime: ts + intervalMs - 1
      });
    }
    if (!Number.isFinite(oldest) || oldest >= previousOldest) throw new Error(`OKX historical pagination stalled for ${instId}`);
    previousOldest = oldest;
    onPage({ instId, rows: rows.length, oldest });
    if (oldest <= start) break;
    after = oldest;
    await sleep(requestDelayMs);
  }
  const unique = new Map(rows.map(row => [row.openTime, row]));
  return [...unique.values()].sort((a,b) => a.openTime-b.openTime);
}

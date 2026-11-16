const base = "https://futures.kraken.com";
const headers = { accept: "application/json" };

async function getJson(url) {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
  const body = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}: ${body.slice(0, 200)}`);
  try { return JSON.parse(body); }
  catch { throw new Error(`Invalid JSON from ${url}`); }
}

const tickerData = await getJson(`${base}/derivatives/api/v3/tickers`);
if (!Array.isArray(tickerData?.tickers)) {
  throw new Error("Kraken Futures /tickers response has no tickers array");
}

const candidates = tickerData.tickers.filter(item =>
  item?.tag === "perpetual" &&
  /^(PI|PF)_[A-Z0-9]+USD$/.test(String(item.symbol || "").toUpperCase()) &&
  Number(item.volumeQuote) >= 5_000_000 &&
  Number(item.last) > 0
);
if (!candidates.length) {
  throw new Error("No liquid PI_/PF_ USD perpetual matched the bot's current filters");
}

const ticker = candidates[0];

async function checkCandles(interval) {
  const url = `${base}/api/charts/v1/trade/${encodeURIComponent(ticker.symbol)}/${interval}?count=5`;
  const data = await getJson(url);
  if (!Array.isArray(data?.candles) || data.candles.length === 0) {
    throw new Error(`Kraken ${interval} chart response for ${ticker.symbol} has no candles array`);
  }

  const candle = data.candles.at(-1);
  for (const key of ["time", "open", "high", "low", "close", "volume"]) {
    if (!Number.isFinite(Number(candle[key]))) {
      throw new Error(`Invalid ${interval} candle field ${key} for ${ticker.symbol}`);
    }
  }
  return { count: data.candles.length, time: Number(candle.time) };
}

const [oneHour, fourHour] = await Promise.all([
  checkCandles("1h"),
  checkCandles("4h")
]);

console.log(JSON.stringify({
  ok: true,
  tickerCount: tickerData.tickers.length,
  qualifyingPerpetuals: candidates.length,
  sampleSymbol: ticker.symbol,
  sampleLast: Number(ticker.last),
  oneHourCandles: oneHour.count,
  oneHourLatestTime: oneHour.time,
  fourHourCandles: fourHour.count,
  fourHourLatestTime: fourHour.time
}, null, 2));

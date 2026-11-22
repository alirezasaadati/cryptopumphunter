import { analyzeFuturesSymbol, FUTURES_CONFIG } from "../src/index.js";

const SYMBOL = process.env.ZEC_KRAKEN_SYMBOL || "PF_ZECUSD";
const ENTRY = Number(process.env.ZEC_SIGNAL_ENTRY || "902.69");
const SIGNAL_TIME = Date.parse(process.env.ZEC_SIGNAL_TIME || "2026-11-19T20:00:00Z");
const BASE = "https://futures.kraken.com";
const HOUR = 60 * 60 * 1000;
const FOUR_HOURS = 4 * HOUR;
const FIFTEEN_MINUTES = 15 * 60 * 1000;

async function getJson(url) {
  const response = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(25000) });
  const body = await response.text();
  if (!response.ok) throw new Error("HTTP " + response.status + " for " + url + ": " + body.slice(0, 250));
  const data = JSON.parse(body);
  if (data?.result === "error" || (Array.isArray(data?.errors) && data.errors.length)) {
    throw new Error("Kraken API error: " + JSON.stringify(data.errors || data.error));
  }
  return data;
}

async function candles(resolution, intervalMs, hoursBack) {
  const from = SIGNAL_TIME - hoursBack * HOUR;
  const url = new URL(BASE + "/api/charts/v1/trade/" + encodeURIComponent(SYMBOL) + "/" + resolution);
  url.searchParams.set("from", String(Math.floor(from / 1000)));
  url.searchParams.set("to", String(Math.floor(SIGNAL_TIME / 1000)));
  url.searchParams.set("count", "1900");
  const data = await getJson(url);
  if (!Array.isArray(data.candles)) throw new Error("Kraken candle payload missing candles for " + resolution);
  const rows = data.candles.map(c => ({
    time: Number(c.time) < 1e12 ? Number(c.time) * 1000 : Number(c.time),
    open: Number(c.open), high: Number(c.high), low: Number(c.low),
    close: Number(c.close), volume: Number(c.volume)
  })).filter(c => Number.isFinite(c.time) && c.time + intervalMs <= SIGNAL_TIME &&
    [c.open,c.high,c.low,c.close,c.volume].every(Number.isFinite) &&
    c.open > 0 && c.close > 0 && c.low > 0 && c.high >= c.low && c.volume >= 0
  ).sort((a,b) => a.time-b.time);
  const unique = new Map(rows.map(c => [c.time,c]));
  return [...unique.values()];
}

function change24h(rows) {
  if (rows.length < 25) return 0;
  const old = rows[rows.length - 25].close;
  const last = rows[rows.length - 1].close;
  return old > 0 ? (last / old - 1) * 100 : 0;
}

const [oneHour, fourHour, fifteenMinute] = await Promise.all([
  candles("1h", HOUR, 140),
  candles("4h", FOUR_HOURS, 300),
  candles("15m", FIFTEEN_MINUTES, 36)
]);
const result = {
  symbol: SYMBOL,
  signalTimeUtc: new Date(SIGNAL_TIME).toISOString(),
  signalTimeIran: "2026-11-19 23:30 Asia/Tehran (reported message time)",
  reportedEntry: ENTRY,
  candleCounts: { "1h": oneHour.length, "4h": fourHour.length, "15m": fifteenMinute.length },
  lastClosedCandles: {
    "1h": oneHour.at(-1) && { time: new Date(oneHour.at(-1).time).toISOString(), close: oneHour.at(-1).close },
    "4h": fourHour.at(-1) && { time: new Date(fourHour.at(-1).time).toISOString(), close: fourHour.at(-1).close },
    "15m": fifteenMinute.at(-1) && { time: new Date(fifteenMinute.at(-1).time).toISOString(), close: fifteenMinute.at(-1).close }
  }
};
if (oneHour.length < FUTURES_CONFIG.MIN_CANDLES || fourHour.length < FUTURES_CONFIG.MIN_CANDLES) {
  throw new Error("Insufficient closed candles: " + JSON.stringify(result));
}
const ticker = {
  symbol: SYMBOL,
  last: ENTRY,
  // Historical 24h quote volume/funding snapshot was not preserved in the Telegram message.
  // The analyzer uses candle volume for volumeRatio; quoteVolume is informational here.
  quoteVolume: 0,
  priceChangePercent: change24h(oneHour),
  premium: { lastFundingRate: null }
};
const analysis = analyzeFuturesSymbol(ticker, oneHour, fourHour, fifteenMinute);
result.analysis = analysis;
result.entryVsLastClosed1hPct = oneHour.at(-1)?.close
  ? (ENTRY / oneHour.at(-1).close - 1) * 100 : null;
result.exactEntryMatch = Number.isFinite(analysis?.entry) && Math.abs(analysis.entry - ENTRY) < 1e-8;
result.eligible = analysis?.eligible === true;
console.log(JSON.stringify(result, null, 2));

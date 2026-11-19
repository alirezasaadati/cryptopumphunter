import { numberOrNull } from "./http.js";

export function normalizeInstrument({ exchange, symbol, unifiedSymbol, marketType, base, quote, status, raw }) {
  if (!symbol || !base || !quote) return null;
  return {
    instrumentId: `${exchange}:${marketType}:${symbol}`,
    exchange,
    nativeSymbol: symbol,
    unifiedSymbol: unifiedSymbol || `${base}/${quote}`,
    marketType,
    baseAsset: base,
    quoteAsset: quote,
    status: status || "unknown",
    raw
  };
}

export function normalizeTicker({ instrument, last, bid, ask, baseVolume, quoteVolume, changePct, high, low, openInterest, fundingRate, timestamp, raw }) {
  const normalizedLast = numberOrNull(last);
  const normalizedBid = numberOrNull(bid);
  const normalizedAsk = numberOrNull(ask);
  const spreadBps = normalizedBid > 0 && normalizedAsk >= normalizedBid
    ? ((normalizedAsk - normalizedBid) / ((normalizedAsk + normalizedBid) / 2)) * 10000
    : null;
  return {
    instrumentId: instrument.instrumentId,
    exchange: instrument.exchange,
    symbol: instrument.unifiedSymbol,
    nativeSymbol: instrument.nativeSymbol,
    marketType: instrument.marketType,
    last: normalizedLast,
    bid: normalizedBid,
    ask: normalizedAsk,
    spreadBps,
    baseVolume24h: numberOrNull(baseVolume),
    quoteVolume24h: numberOrNull(quoteVolume),
    changePct24h: numberOrNull(changePct),
    high24h: numberOrNull(high),
    low24h: numberOrNull(low),
    openInterest: numberOrNull(openInterest),
    fundingRate: numberOrNull(fundingRate),
    timestamp: numberOrNull(timestamp),
    raw
  };
}

export function splitUnifiedSymbol(value) {
  if (!value || typeof value !== "string") return [null, null];
  const parts = value.replace("-", "/").split("/");
  return parts.length === 2 ? parts : [null, null];
}

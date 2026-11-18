const PREFIX = "signal-ledger:v1:";

function cleanSymbol(value) {
  return String(value || "").trim().toUpperCase().replace(/[^A-Z0-9._-]/g, "_").slice(0, 32);
}

export function issuedSignalKey(chatId, symbol, signalId) {
  return PREFIX + String(chatId) + ":" + cleanSymbol(symbol) + ":" + encodeURIComponent(String(signalId));
}

export async function saveIssuedSignal(kv, chatId, signal, trade = null) {
  if (!kv || !chatId || !signal?.id || !signal?.symbol) return false;
  const key = issuedSignalKey(chatId, signal.symbol, signal.id);
  const existing = await kv.get(key);
  if (existing) return false;
  const record = {
    id: String(signal.id),
    chatId: String(chatId),
    symbol: cleanSymbol(signal.symbol),
    side: signal.side,
    exchange: signal.exchange || "Kraken",
    strategyId: signal.strategyId || "kraken-futures-engine",
    entry: Number(signal.entry),
    stop: Number(signal.stop),
    target1: Number(signal.target1),
    target2: Number(signal.target2),
    target3: Number(signal.target3),
    score: Number.isFinite(Number(signal.score)) ? Number(signal.score) : null,
    tier: signal.tier === "EXPERIMENTAL" ? "EXPERIMENTAL" : "STANDARD",
    status: "OPEN",
    tpHits: [],
    createdAt: new Date(Number(signal.createdAt) || Date.now()).toISOString(),
    publishedAt: new Date().toISOString(),
    tradeId: trade?.id || null,
    closedAt: null,
    closeReason: null,
    exitPrice: null,
    outcomePercent: null,
    outcomeR: null
  };
  await kv.put(key, JSON.stringify(record));
  return true;
}

export async function updateIssuedSignal(kv, chatId, trade) {
  if (!kv || !chatId || !trade?.signalId || !trade?.symbol) return false;
  const key = issuedSignalKey(chatId, trade.symbol, trade.signalId);
  const raw = await kv.get(key, "json");
  if (!raw) return false;
  const record = {
    ...raw,
    tpHits: [...new Set(Array.isArray(trade.tpHits) ? trade.tpHits : raw.tpHits || [])],
    status: String(trade.status || raw.status),
    lastPrice: Number.isFinite(Number(trade.lastPrice)) ? Number(trade.lastPrice) : raw.lastPrice ?? null,
    lastCheckedAt: trade.lastCheckedAt || raw.lastCheckedAt || null,
    closedAt: trade.closedAt || raw.closedAt || null,
    closeReason: trade.closeReason || raw.closeReason || null,
    exitPrice: Number.isFinite(Number(trade.exitPrice)) ? Number(trade.exitPrice) : raw.exitPrice ?? null,
    outcomePercent: Number.isFinite(Number(trade.outcomePercent)) ? Number(trade.outcomePercent) : raw.outcomePercent ?? null,
    outcomeR: Number.isFinite(Number(trade.outcomeR)) ? Number(trade.outcomeR) : raw.outcomeR ?? null
  };
  await kv.put(key, JSON.stringify(record));
  return true;
}

export async function listIssuedSignals(kv, chatId, { symbol = null, status = null } = {}) {
  if (!kv || !chatId) return [];
  const prefix = PREFIX + String(chatId) + ":";
  let cursor;
  const records = [];
  do {
    const page = await kv.list({ prefix, limit: 1000, ...(cursor ? { cursor } : {}) });
    for (const item of page.keys || []) {
      if (symbol && !item.name.startsWith(PREFIX + String(chatId) + ":" + cleanSymbol(symbol) + ":")) continue;
      const record = await kv.get(item.name, "json");
      if (record && (!status || record.status === status)) records.push(record);
    }
    cursor = page.list_complete === false ? page.cursor : null;
  } while (cursor);
  return records.sort((a, b) => String(b.publishedAt).localeCompare(String(a.publishedAt)));
}

export function issuedSignalSymbols(records) {
  return [...new Set((Array.isArray(records) ? records : []).map(x => cleanSymbol(x.symbol)).filter(Boolean))].sort();
}

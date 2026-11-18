const PREFIX = "signal-ledger:v1:";

function cleanSymbol(value) {
  return String(value || "").trim().toUpperCase().replace(/[^A-Z0-9._-]/g, "_").slice(0, 32);
}

export function issuedSignalKey(chatId, symbol, signalId) {
  return PREFIX + String(chatId) + ":" + cleanSymbol(symbol) + ":" + encodeURIComponent(String(signalId));
}

function finiteOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export async function saveIssuedSignal(kv, chatId, signal, trade = null) {
  if (!kv || !chatId || !signal?.id || !signal?.symbol) return false;
  const numericLevels = [signal.entry, signal.stop, signal.target1, signal.target2, signal.target3].map(finiteOrNull);
  if (numericLevels.some(value => value === null || value <= 0)) {
    throw new Error("Issued signal contains invalid price levels.");
  }
  if (!["LONG", "SHORT"].includes(signal.side)) {
    throw new Error("Issued signal direction must be LONG or SHORT.");
  }
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
    entry: numericLevels[0],
    stop: numericLevels[1],
    target1: numericLevels[2],
    target2: numericLevels[3],
    target3: numericLevels[4],
    score: finiteOrNull(signal.score),
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
    tpHits: [...new Set([...(Array.isArray(raw.tpHits) ? raw.tpHits : []), ...(Array.isArray(trade.tpHits) ? trade.tpHits : [])])],
    status: String(trade.status || raw.status),
    tradeId: trade.id || raw.tradeId || null,
    lastPrice: finiteOrNull(trade.lastPrice) ?? raw.lastPrice ?? null,
    lastCheckedAt: trade.lastCheckedAt || raw.lastCheckedAt || null,
    closedAt: trade.closedAt || raw.closedAt || null,
    closeReason: trade.closeReason || raw.closeReason || null,
    exitPrice: finiteOrNull(trade.exitPrice) ?? raw.exitPrice ?? null,
    outcomePercent: finiteOrNull(trade.outcomePercent) ?? raw.outcomePercent ?? null,
    outcomeR: finiteOrNull(trade.outcomeR) ?? raw.outcomeR ?? null
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

const ROOT = "signals:v1";

function cleanSymbol(value) {
  return String(value || "").trim().toUpperCase().replace(/\\.P$/, "").replace(/[-_/]?USDT$/, "");
}

function safePart(value) {
  return encodeURIComponent(String(value));
}

function timestampPart(value) {
  const time = new Date(value || Date.now()).toISOString();
  return time.replace(/[-:.]/g, "").replace("T", "").replace("Z", "");
}

function recordKey(chatId, signalId) {
  return `${ROOT}:record:${safePart(chatId)}:${safePart(signalId)}`;
}

function archiveIndexKey(chatId, symbol, publishedAt, signalId) {
  return `${ROOT}:archive-index:${safePart(chatId)}:${safePart(symbol)}:${timestampPart(publishedAt)}:${safePart(signalId)}`;
}

function openIndexKey(chatId, symbol, signalId) {
  return `${ROOT}:open-index:${safePart(chatId)}:${safePart(symbol)}:${safePart(signalId)}`;
}

function historyIndexKey(chatId, symbol, closedAt, signalId) {
  return `${ROOT}:history-index:${safePart(chatId)}:${safePart(symbol)}:${timestampPart(closedAt)}:${safePart(signalId)}`;
}

async function readJson(kv, key) {
  const raw = await kv.get(key);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

export async function archivePublishedSignal(env, chatId, signal, trade = null, publishedAt = new Date().toISOString()) {
  if (!env?.APP_KV) throw new Error("APP_KV binding is required for permanent signal archive.");
  if (!chatId || !signal?.id || !signal?.symbol) throw new Error("A chat ID, signal ID and symbol are required.");
  const symbol = cleanSymbol(signal.symbol);
  if (!symbol) throw new Error("Signal symbol is invalid.");
  const key = recordKey(chatId, signal.id);
  const existing = await readJson(env.APP_KV, key);
  if (existing) return { created: false, record: existing };

  const record = {
    schemaVersion: 1,
    signalId: String(signal.id),
    chatId: String(chatId),
    symbol,
    side: signal.side,
    strategyId: signal.strategyId || null,
    exchange: signal.exchange || "Kraken",
    publishedAt: new Date(publishedAt).toISOString(),
    status: "OPEN",
    milestones: [],
    finalResult: null,
    signal: { ...signal },
    tradeId: trade?.id || null,
    updatedAt: new Date(publishedAt).toISOString()
  };

  // Canonical record is written first. Indexes are derived and can be rebuilt.
  await env.APP_KV.put(key, JSON.stringify(record));
  await env.APP_KV.put(archiveIndexKey(chatId, symbol, record.publishedAt, signal.id), String(signal.id));
  if (record.status === "OPEN") {
    await env.APP_KV.put(openIndexKey(chatId, symbol, signal.id), String(signal.id));
  }
  return { created: true, record };
}

export async function updateArchivedSignal(env, chatId, signalId, patch = {}) {
  if (!env?.APP_KV) throw new Error("APP_KV binding is required for permanent signal archive.");
  const key = recordKey(chatId, signalId);
  const current = await readJson(env.APP_KV, key);
  if (!current) return null;
  const next = {
    ...current,
    milestones: Array.isArray(patch.milestones) ? [...new Set([...current.milestones, ...patch.milestones])] : current.milestones,
    status: patch.status || current.status,
    finalResult: patch.finalResult === undefined ? current.finalResult : patch.finalResult,
    closedAt: patch.closedAt || current.closedAt || null,
    exitPrice: patch.exitPrice === undefined ? current.exitPrice : patch.exitPrice,
    outcomeR: patch.outcomeR === undefined ? current.outcomeR : patch.outcomeR,
    outcomePercent: patch.outcomePercent === undefined ? current.outcomePercent : patch.outcomePercent,
    updatedAt: patch.updatedAt || new Date().toISOString()
  };
  await env.APP_KV.put(key, JSON.stringify(next));
  const symbol = current.symbol;
  if (next.status === "CLOSED_STOP" || next.status === "CLOSED_TARGETS") {
    await env.APP_KV.delete(openIndexKey(chatId, symbol, signalId));
    if (next.closedAt) {
      await env.APP_KV.put(historyIndexKey(chatId, symbol, next.closedAt, signalId), String(signalId));
    }
  } else {
    await env.APP_KV.put(openIndexKey(chatId, symbol, signalId), String(signalId));
  }
  return next;
}

export async function listArchivedSymbols(env, chatId, view = "archive") {
  const prefix = `${ROOT}:${view === "open" ? "open-index" : view === "history" ? "history-index" : "archive-index"}:${safePart(chatId)}:`;
  const symbols = new Set();
  let cursor;
  do {
    const page = await env.APP_KV.list({ prefix, limit: 1000, ...(cursor ? { cursor } : {}) });
    for (const item of page.keys || []) {
      const rest = item.name.slice(prefix.length);
      const symbolPart = rest.split(":")[0];
      try { symbols.add(decodeURIComponent(symbolPart)); } catch { /* malformed derived index */ }
    }
    cursor = page.list_complete === false ? page.cursor : null;
  } while (cursor);
  return [...symbols].sort();
}

export async function listArchivedSignals(env, chatId, symbol, view = "archive", limit = 20, cursor = undefined) {
  const viewName = view === "open" ? "open-index" : view === "history" ? "history-index" : "archive-index";
  const prefix = `${ROOT}:${viewName}:${safePart(chatId)}:${safePart(cleanSymbol(symbol))}:`;
  const page = await env.APP_KV.list({ prefix, limit: Math.max(1, Math.min(50, Number(limit) || 20)), ...(cursor ? { cursor } : {}) });
  const records = [];
  for (const item of page.keys || []) {
    const signalId = await env.APP_KV.get(item.name);
    if (!signalId) continue;
    const record = await readJson(env.APP_KV, recordKey(chatId, signalId));
    if (record) records.push(record);
  }
  records.sort((a, b) => String(b.publishedAt).localeCompare(String(a.publishedAt)));
  return { records, cursor: page.list_complete === false ? page.cursor : null };
}

export function signalArchiveKeyForTest(chatId, signalId) {
  return recordKey(chatId, signalId);
}

export { cleanSymbol };

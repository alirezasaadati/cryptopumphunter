const ALERT_TTL_SECONDS = 7 * 24 * 60 * 60;

export function futuresSignalFingerprint(signal) {
  if (!signal || typeof signal !== "object") return null;
  const symbol = String(signal.symbol || "").trim().toUpperCase();
  const side = String(signal.side || "").trim().toUpperCase();
  const strategy = String(signal.strategyId || signal.strategyName || "kraken-futures-engine").trim().toLowerCase();
  const rawTime = signal.candleTime ?? signal.setupTime;
  const numericTime = Number(rawTime);
  const time = rawTime instanceof Date ? rawTime.getTime()
    : rawTime !== null && rawTime !== "" && Number.isFinite(numericTime)
      ? (numericTime < 1e12 ? numericTime * 1000 : numericTime)
      : new Date(rawTime).getTime();
  if (!symbol || !["LONG", "SHORT"].includes(side) || !strategy || !Number.isFinite(time)) return null;
  return [symbol, side, strategy, time].join("|");
}

export function selectUnnotifiedFuturesSignals(signals, seenFingerprints = new Set()) {
  const unique = new Map();
  for (const signal of Array.isArray(signals) ? signals : []) {
    const fingerprint = futuresSignalFingerprint(signal);
    if (fingerprint && !seenFingerprints.has(fingerprint)) unique.set(fingerprint, signal);
  }
  return [...unique.entries()].map(([fingerprint, signal]) => ({ fingerprint, signal }));
}

export function futuresAlertStorageKey(chatId, fingerprint) {
  return `futures-alert:v1:${String(chatId)}:${encodeURIComponent(fingerprint)}`;
}

export function displayEntryPrice(value, side) {
  const price = Number(value);
  if (!Number.isFinite(price)) return NaN;
  if (side === "LONG") return price * 0.985;
  if (side === "SHORT") return price * 1.01;
  return NaN;
}

export function formatFuturesSignalAlert(signal, index = 1) {
  const side = signal?.side === "LONG" ? "🟢 LONG ↗" : "🔴 SHORT ↘";
  const risk = signal?.riskLevel === "HIGH_RISK" ? "HIGH RISK" : "STANDARD";
  const score = Number(signal?.score);
  const scoreLine = Number.isFinite(score) ? `\nScore: <b>${Math.round(score)}/100</b>` : "";
  const symbol = escapeTelegramHtml(formatFuturesSymbol(signal?.symbol) + "/USD");
  return `<b>PREMIUM SIGNALS</b>  •  <b>TRADEYAR</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `<b>${side}</b>  •  <b>${symbol}</b>\n` +
    `<i>${escapeTelegramHtml(formatPerpetualLabel(signal?.symbol))}</i>\n\n` +
    `<b>STOP LOSS</b>  <code>${formatSignalPrice(signal?.stop)}</code>   |   <b>ENTRY PRICE</b>  <code>${formatSignalPrice(signal?.entry)}</code>\n` +
    `Entry 2: <code>${formatSignalPrice(displayEntryPrice(signal?.entry, signal?.side))}</code>\n\n` +
    `<b>TAKE PROFIT TARGETS</b>\n` +
    `🎯 TP1  <code>${formatSignalPrice(signal?.target1)}</code>\n` +
    `🎯 TP2  <code>${formatSignalPrice(signal?.target2)}</code>\n` +
    `🎯 TP3  <code>${formatSignalPrice(signal?.target3)}</code>\n\n` +
    `<b>RISK</b>  ${risk}${scoreLine}`;
}
function formatFuturesSymbol(symbol) {
  const normalized = String(symbol || "—").trim().toUpperCase()
    .replace(/^PF_/, "")
    .replace(/\.P$/, "")
    .replace(/[-_/]?(?:USDT|USD)$/, "");
  if (normalized === "XBT") return "BTC";
  if (normalized === "NVDX") return "NVDA";
  return normalized;
}

function formatPerpetualLabel(symbol) {
  const base = formatFuturesSymbol(symbol);
  const names = { BTC: "Bitcoin", ETH: "Ethereum", SOL: "Solana", XRP: "XRP" };
  return `${names[base] || base} Perpetual`;
}

function escapeTelegramHtml(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function formatSignalPrice(value) {
  const price = Number(value);
  if (!Number.isFinite(price)) return "—";
  return price.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 8 });
}

export { ALERT_TTL_SECONDS };

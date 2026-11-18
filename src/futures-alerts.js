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

export function formatFuturesSignalAlert(signal, index = 1) {
  const side = signal?.side === "LONG" ? "🟢 لانگ" : "🔴 شورت";
  return `🎯 سیگنال ${Number(index).toLocaleString("fa-IR")}\n` +
    "━━━━━━━━━━━━━━━━━━\n" +
    `🪙 نماد: ${formatFuturesSymbol(signal?.symbol)}\n` +
    `🧭 جهت معامله: ${side}\n` +
    `📍 ورود: ${formatSignalPrice(signal?.entry)}\n` +
    (Number.isFinite(Number(signal?.livePrice)) ? `📡 قیمت بازار هنگام کنترل: ${formatSignalPrice(signal.livePrice)} | اختلاف: ${Number(signal.entryDriftPct).toFixed(3)}%\n` : "") +
    `🛑 حد ضرر: ${formatSignalPrice(signal?.stop)}\n` +
    `🎯 تارگت ۱: ${formatSignalPrice(signal?.target1)}\n` +
    `🎯 تارگت ۲: ${formatSignalPrice(signal?.target2)}\n` +
    `🎯 تارگت ۳: ${formatSignalPrice(signal?.target3)}\n\n` +
    "⚠️ سیگنال تحلیلی است؛ سفارش واقعی ثبت نمی‌شود.";
}

function formatFuturesSymbol(symbol) {
  return String(symbol || "—").toUpperCase().replace(/\.P$/, "").replace(/[-_/]?USDT$/, "");
}

function formatSignalPrice(value) {
  const price = Number(value);
  if (!Number.isFinite(price)) return "—";
  if (price >= 1000) return price.toFixed(2);
  if (price >= 1) return price.toFixed(4);
  if (price >= 0.01) return price.toFixed(5);
  if (price >= 0.0001) return price.toFixed(7);
  return price.toExponential(3);
}

export { ALERT_TTL_SECONDS };

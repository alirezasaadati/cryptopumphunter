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
  const isHighRisk = signal?.riskLevel === "HIGH_RISK" || signal?.highRiskEligible === true;
  const isLong = signal?.side === "LONG";
  const direction = isLong ? "🟢 لانگ / Long" : "🔴 شورت / Short";
  const symbol = escapeTelegramHtml(formatFuturesSymbol(signal?.symbol));
  const score = Number.isFinite(Number(signal?.score)) ? Math.round(Number(signal.score)) : "—";
  const lines = isHighRisk ? [
    "⚠️ <b>سیگنال پر ریسک</b>",
    "",
    `⭐ امتیاز سیگنال: <b>${score}/100</b>`,
    "",
    `نماد: <b>${symbol}</b>`,
    "",
    `جهت معامله: ${direction}`,
    "",
    `نقطه ورود یک: <b>${formatSignalPrice(signal?.entry)}</b>`,
    "",
    `نقطه ورود دو: <b>${formatSignalPrice(displayEntryPrice(signal?.entry, signal?.side))}</b>`,
    "",
    `🎯 تارگت اول: <b>${formatSignalPrice(signal?.target1)}</b>`,
    "",
    `🎯 تارگت دوم: <b>${formatSignalPrice(signal?.target2)}</b>`,
    "",
    `🎯 تارگت سوم: <b>${formatSignalPrice(signal?.target3)}</b>`,
    "",
    `⛔ حد ضرر: <b>${formatSignalPrice(signal?.stop)}</b>`
  ] : [
    "⚪ <b>سیگنال معتبر</b>",
    "",
    `⭐ امتیاز سیگنال: <b>${score}/100</b>`,
    "",
    `نماد: <b>${symbol}</b>`,
    "",
    `جهت معامله: ${direction}`,
    "",
    `قیمت ورود: <b>${formatSignalPrice(signal?.entry)}</b>`,
    "",
    `🎯 تارگت اول (1.5R): <b>${formatSignalPrice(signal?.target1)}</b>`,
    "",
    `🎯 تارگت دوم (2.5R): <b>${formatSignalPrice(signal?.target2)}</b>`,
    "",
    `🎯 تارگت سوم (3.5R): <b>${formatSignalPrice(signal?.target3)}</b>`,
    "",
    `⛔ حد ضرر: <b>${formatSignalPrice(signal?.stop)}</b>`
  ];
  return lines.map(line => `\\u200E${line}`).join("\\n");
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

function expandPriceExponent(value) {
  const text = String(value);
  if (!/[eE]/.test(text)) return text;
  const [coefficient, exponentText] = text.toLowerCase().split("e");
  const exponent = Number(exponentText);
  const negative = coefficient.startsWith("-");
  const unsigned = negative ? coefficient.slice(1) : coefficient;
  const [whole, fraction = ""] = unsigned.split(".");
  const digits = whole + fraction;
  const decimalPosition = whole.length + exponent;
  let expanded;
  if (decimalPosition <= 0) {
    expanded = "0." + "0".repeat(-decimalPosition) + digits;
  } else if (decimalPosition >= digits.length) {
    expanded = digits + "0".repeat(decimalPosition - digits.length);
  } else {
    expanded = digits.slice(0, decimalPosition) + "." + digits.slice(decimalPosition);
  }
  return (negative ? "-" : "") + expanded;
}

function formatSignalPrice(value) {
  const price = Number(value);
  if (!Number.isFinite(price)) return "—";

  // Truncate the display string only; never round or alter the underlying price.
  const decimals = price > 1000 ? 0 : price >= 1 ? 2 : price >= 0.01 ? 4 : 5;
  const expanded = expandPriceExponent(value);
  const negative = expanded.startsWith("-");
  const unsigned = negative ? expanded.slice(1) : expanded;
  const [wholePart, fractionPart = ""] = unsigned.split(".");
  const truncated = decimals === 0 ? "" : fractionPart.slice(0, decimals);
  const whole = wholePart.replace(/\\B(?=(\\d{3})+(?!\\d))/g, ",");
  const fraction = truncated.replace(/0+$/, "");
  return (negative ? "-" : "") + whole + (fraction ? "." + fraction : "");
}

export { ALERT_TTL_SECONDS };

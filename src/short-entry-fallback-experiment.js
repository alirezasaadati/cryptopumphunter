// Research-only SHORT fallback execution rules.
// This module is deliberately not imported by the production Worker: the bot
// publishes signals but does not place exchange orders.
export function selectShortFallbackOrder(candle) {
  const values = [candle?.open, candle?.high, candle?.low, candle?.close].map(Number);
  const [open, high, low, close] = values;
  if (!values.every(Number.isFinite) || open <= 0 || low <= 0 || high < low ||
      high < Math.max(open, close) || low > Math.min(open, close)) {
    throw new Error("Invalid completed 5m candle for SHORT fallback");
  }
  if (close < open) return { type: "MARKET", reason: "BEARISH_5M", limitPrice: null };
  return {
    type: "LIMIT",
    reason: close > open ? "BULLISH_5M" : "DOJI_5M",
    limitPrice: high
  };
}

export function resolveShortFallbackFill({
  decisionCandle,
  followingCandles,
  validBars = 12,
  marketSlippage = 0
}) {
  const decision = selectShortFallbackOrder(decisionCandle);
  if (!Array.isArray(followingCandles) || followingCandles.length === 0) {
    return { ...decision, decisionReason: decision.reason, filled: false, fillPrice: null, fillIndex: null, reason: decision.reason + "_NO_FOLLOWING_CANDLE" };
  }
  const window = followingCandles.slice(0, Math.max(1, validBars));
  if (decision.type === "MARKET") {
    const open = Number(window[0]?.open);
    if (!Number.isFinite(open) || open <= 0) {
      return { ...decision, decisionReason: decision.reason, filled: false, fillPrice: null, fillIndex: null, reason: "INVALID_MARKET_OPEN" };
    }
    return {
      ...decision, decisionReason: decision.reason, filled: true,
      fillPrice: open * (1 - Math.max(0, Number(marketSlippage) || 0)),
      fillIndex: 0, reason: "MARKET_NEXT_5M_OPEN"
    };
  }
  for (let i = 0; i < window.length; i++) {
    const bar = window[i];
    const open = Number(bar?.open), high = Number(bar?.high);
    if (!Number.isFinite(open) || !Number.isFinite(high)) continue;
    if (open >= decision.limitPrice) {
      return { ...decision, decisionReason: decision.reason, filled: true, fillPrice: open, fillIndex: i, reason: "LIMIT_GAP_FILL" };
    }
    if (high >= decision.limitPrice) {
      return { ...decision, decisionReason: decision.reason, filled: true, fillPrice: decision.limitPrice, fillIndex: i, reason: "LIMIT_TOUCH_FILL" };
    }
  }
  return {
    ...decision, decisionReason: decision.reason, filled: false, fillPrice: null, fillIndex: null,
    reason: decision.reason + "_LIMIT_EXPIRED"
  };
}

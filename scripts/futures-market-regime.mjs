// Historical market-regime classifier. Every input candle must already be closed.
// No future bars, pivots, or forward-filled values are consulted.
export const MARKET_REGIME_VERSION = "1.0.0";

const PERIOD = 14;
const EMA_FAST = 20;
const EMA_SLOW = 50;

function ema(values, period) {
  if (values.length < period) return null;
  const alpha = 2 / (period + 1);
  let value = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) value = values[i] * alpha + value * (1 - alpha);
  return value;
}

// ADX-style directional strength proxy from the last 14 confirmed movements.
function directionalStrength(candles) {
  if (candles.length < PERIOD + 1) return null;
  let plus = 0, minus = 0, tr = 0;
  const start = candles.length - PERIOD;
  for (let i = start; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    const up = Number(c.high) - Number(p.high);
    const down = Number(p.low) - Number(c.low);
    plus += up > down && up > 0 ? up : 0;
    minus += down > up && down > 0 ? down : 0;
    tr += Math.max(Number(c.high) - Number(c.low),
      Math.abs(Number(c.high) - Number(p.close)),
      Math.abs(Number(c.low) - Number(p.close)));
  }
  if (!(tr > 0) || !Number.isFinite(tr)) return null;
  const pdi = plus / tr * 100, mdi = minus / tr * 100;
  const denominator = pdi + mdi;
  return denominator > 0 ? Math.abs(pdi - mdi) / denominator * 100 : 0;
}

export function classifyMarketRegime(candles) {
  if (!Array.isArray(candles) || candles.length < 60) {
    return { regime: "INSUFFICIENT", direction: "NEUTRAL", strength: "UNKNOWN", adxProxy: null, emaSpreadPct: null, ema50SlopePct: null };
  }
  const closes = candles.map(c => Number(c.close));
  if (closes.some(x => !Number.isFinite(x) || x <= 0)) {
    return { regime: "INSUFFICIENT", direction: "NEUTRAL", strength: "UNKNOWN", adxProxy: null, emaSpreadPct: null, ema50SlopePct: null };
  }
  const fast = ema(closes, EMA_FAST), slow = ema(closes, EMA_SLOW);
  const slowPrevious = ema(closes.slice(0, -5), EMA_SLOW);
  const price = closes.at(-1);
  const slope = slowPrevious > 0 ? (slow / slowPrevious - 1) * 100 : 0;
  const spread = (fast / slow - 1) * 100;
  const up = fast > slow && price > fast && slope > 0;
  const down = fast < slow && price < fast && slope < 0;
  const direction = up ? "BULL" : down ? "BEAR" : "NEUTRAL";
  const adxProxy = directionalStrength(candles);
  const strong = direction !== "NEUTRAL" && adxProxy !== null &&
    adxProxy >= 22 && Math.abs(spread) >= 0.35 && Math.abs(slope) >= 0.08;
  const strength = direction === "NEUTRAL" ? "NEUTRAL" : strong ? "STRONG" : "WEAK";
  return {
    regime: direction === "NEUTRAL" ? "NEUTRAL" : direction + "_" + strength,
    direction, strength, adxProxy,
    emaSpreadPct: spread, ema50SlopePct: slope
  };
}

export function combineMarketRegimes(left, right) {
  if (!left || !right || left.direction === "NEUTRAL" || right.direction === "NEUTRAL" ||
      left.direction !== right.direction) {
    return { regime: "NEUTRAL", direction: "NEUTRAL", strength: "NEUTRAL" };
  }
  const strength = left.strength === "STRONG" && right.strength === "STRONG" ? "STRONG" : "WEAK";
  return { regime: left.direction + "_" + strength, direction: left.direction, strength };
}

export function classifyRegimeSet(candlesByTimeframe) {
  const oneHour = classifyMarketRegime(candlesByTimeframe["1h"] || []);
  const fourHour = classifyMarketRegime(candlesByTimeframe["4h"] || []);
  const oneDay = classifyMarketRegime(candlesByTimeframe["1d"] || []);
  return {
    "1h": oneHour, "4h": fourHour, "1d": oneDay,
    "1h+4h": combineMarketRegimes(oneHour, fourHour),
    "4h+1d": combineMarketRegimes(fourHour, oneDay)
  };
}

export function isSideAllowedByRegime(side, regime) {
  if (!regime || (regime.direction !== "BULL" && regime.direction !== "BEAR")) return false;
  return (side === "LONG" && regime.direction === "BULL") ||
    (side === "SHORT" && regime.direction === "BEAR");
}

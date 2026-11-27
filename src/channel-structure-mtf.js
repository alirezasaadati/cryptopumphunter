import { detectPriceChannel } from "./channel-structure-engine.js";

const DAY = 86400000;

export function ema(values, period = 20) {
  if (!Array.isArray(values) || values.length < period) return null;
  const k = 2 / (period + 1);
  let value = values.slice(0, period).reduce((sum, n) => sum + Number(n), 0) / period;
  for (let i = period; i < values.length; i++) value = Number(values[i]) * k + value * (1 - k);
  return value;
}

export function getDailyChannelContext(dailyCandles, signalTime, side, price) {
  const closed = (dailyCandles || []).filter(c => Number(c.time) + DAY <= signalTime).slice(-120);
  const channel = detectPriceChannel(closed);
  if (!channel) return { channel: null, multiplier: 1, state: "NO_DAILY_CHANNEL" };
  const barsForward = Math.max(0, (signalTime - (Number(closed.at(-1).time) + DAY)) / DAY);
  const upper = channel.upper + channel.slopePerBar * barsForward;
  const lower = channel.lower + channel.slopePerBar * barsForward;
  const width = upper - lower;
  const nearOpposingBoundary = side === "SHORT"
    ? price <= lower + width * 0.2
    : price >= upper - width * 0.2;
  if (nearOpposingBoundary) return { channel: { ...channel, upper, lower }, multiplier: 0.5, state: "NEAR_DAILY_OPPOSING_BOUNDARY" };
  const aligned = (side === "LONG" && channel.type === "ASCENDING") ||
    (side === "SHORT" && channel.type === "DESCENDING");
  return { channel: { ...channel, upper, lower }, multiplier: aligned ? 1.5 : 1, state: aligned ? "DAILY_CHANNEL_ALIGNED" : "DAILY_CHANNEL_NEUTRAL" };
}

export function getFourHourConfirmation(candles4h, signal, signalTime) {
  const candle = (candles4h || []).filter(c => Number(c.time) + 4 * 3600000 <= signalTime).at(-1);
  if (!candle) return { directional: false, closedAtSignal: false };
  const directional = signal.side === "LONG"
    ? Number(candle.close) > Number(candle.open)
    : Number(candle.close) < Number(candle.open);
  const outsideBoundary = signal.side === "LONG"
    ? Number(candle.close) > Number(signal.channel.upper)
    : Number(candle.close) < Number(signal.channel.lower);
  return {
    directional,
    outsideBoundary,
    closedAtSignal: Number(candle.time) + 4 * 3600000 === signalTime,
    candle
  };
}

export function getMtfAlignment({ signal, candles1h, candles15m, fourHour }) {
  const closes = (candles1h || []).map(c => Number(c.close));
  const ema20 = ema(closes, 20);
  const lastClose = closes.at(-1);
  const oneHourAligned = Number.isFinite(ema20) && (signal.side === "LONG" ? lastClose > ema20 : lastClose < ema20);
  const m = candles15m?.at(-1);
  const fifteenMinuteAligned = !!m && (signal.side === "LONG"
    ? Number(m.close) > Number(m.open)
    : Number(m.close) < Number(m.open));
  const channelAligned = (signal.side === "LONG" && signal.channelType === "ASCENDING") ||
    (signal.side === "SHORT" && signal.channelType === "DESCENDING");
  return {
    oneHourAligned,
    fifteenMinuteAligned,
    channelAligned,
    fourHourAligned: !!fourHour?.directional,
    allAligned: oneHourAligned && fifteenMinuteAligned && channelAligned && !!fourHour?.directional
  };
}

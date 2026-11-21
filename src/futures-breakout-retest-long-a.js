// Version A: faithful baseline of the user's Python breakout-retest scanner.
// Experimental only. Inputs must contain closed candles, oldest first.
export const BREAKOUT_RETEST_LONG_A_VERSION = "1.0.0";

const num = value => Number.isFinite(Number(value)) ? Number(value) : null;

function validCandles(rows, requireVolume = false) {
  return Array.isArray(rows) && rows.every(c =>
    [c.open, c.high, c.low, c.close, ...(requireVolume ? [c.volume] : [])].every(v => num(v) !== null) &&
    num(c.open) > 0 && num(c.close) > 0 && num(c.low) > 0 &&
    num(c.high) >= Math.max(num(c.open), num(c.close), num(c.low)) &&
    (!requireVolume || num(c.volume) >= 0)
  );
}

// Matches pandas ewm(span=period, adjust=False): seed with the first value.
function emaPandas(values, period) {
  if (!Array.isArray(values) || !values.length) return null;
  const alpha = 2 / (period + 1);
  let value = num(values[0]);
  if (value === null) return null;
  for (let i = 1; i < values.length; i++) {
    const next = num(values[i]);
    if (next === null) return null;
    value = next * alpha + value * (1 - alpha);
  }
  return value;
}

function averagePreviousVolume(candles, breakoutIndex, period = 20) {
  const start = breakoutIndex - period;
  if (start < 0) return null;
  const values = candles.slice(start, breakoutIndex).map(c => num(c.volume));
  if (values.length !== period || values.some(v => v === null || v < 0)) return null;
  return values.reduce((sum, value) => sum + value, 0) / period;
}

/**
 * Reproduces the Python scanner's strategy:
 * - BTC 15m close above EMA50
 * - symbol 15m close above EMA50
 * - resistance = max high in the equivalent of df.iloc[-25:-4]
 * - one of the three candles before the retest breaks resistance with >1.5x volume
 * - retest candle low is within 0.3% of resistance and closes bullish above it
 * - stop formula and 0.3%-1.6% stop-distance limits retained
 * - targets at 1.5R and 2.5R
 *
 * Technical correction: breakout volume is compared with the 20 fully prior
 * candles, excluding the breakout candle itself (avoids self-inflating average).
 */
export function analyzeBreakoutRetestLongA({
  symbol, candles15m, candlesBtc15m, options = {}
}) {
  const cfg = {
    emaPeriod: 50,
    resistanceWindow: 21,
    breakoutVolumeRatio: 1.5,
    retestTolerancePct: 0.003,
    minStopPct: 0.3,
    maxStopPct: 1.6,
    stopLowBufferPct: 0.003,
    stopResistanceBufferPct: 0.005,
    tp1R: 1.5,
    tp2R: 2.5,
    ...options
  };
  const reject = reason => ({ symbol, side: "LONG", eligible: false, reason });

  if (!validCandles(candles15m, true) || !validCandles(candlesBtc15m, true)) {
    return reject("invalid_or_missing_candles");
  }
  if (candles15m.length < 60 || candlesBtc15m.length < 60) {
    return reject("insufficient_history");
  }

  const symbolCloses = candles15m.map(c => num(c.close));
  const btcCloses = candlesBtc15m.map(c => num(c.close));
  const symbolEma50 = emaPandas(symbolCloses, cfg.emaPeriod);
  const btcEma50 = emaPandas(btcCloses, cfg.emaPeriod);
  const current = candles15m.at(-1);
  const entry = num(current.close);

  if (!(num(btcCloses.at(-1)) > btcEma50)) return reject("btc_below_ema50");
  if (!(entry > symbolEma50)) return reject("symbol_below_ema50");

  // Equivalent to the source's [-25:-4] slice when the unfinished final
  // exchange candle is omitted from this closed-candle input.
  const resistanceRows = candles15m.slice(-(cfg.resistanceWindow + 3), -3);
  if (resistanceRows.length !== cfg.resistanceWindow) return reject("resistance_history_unavailable");
  const resistance = Math.max(...resistanceRows.map(c => num(c.high)));

  // Equivalent to source indices -5, -4 and -3; current retest is the last row.
  const breakoutCandidates = candles15m.slice(-4, -1);
  let breakout = null;
  for (let offset = 0; offset < breakoutCandidates.length; offset++) {
    const candle = breakoutCandidates[offset];
    const index = candles15m.length - 4 + offset;
    const open = num(candle.open), close = num(candle.close), volume = num(candle.volume);
    const averageVolume = averagePreviousVolume(candles15m, index, 20);
    if (close > resistance && open < resistance &&
        averageVolume !== null && volume > averageVolume * cfg.breakoutVolumeRatio) {
      breakout = { index, open, close, volume, averageVolume, volumeRatio: volume / averageVolume };
      break;
    }
  }
  if (!breakout) return reject("no_volume_confirmed_breakout");

  const low = num(current.low);
  const touched = Math.abs(low - resistance) / resistance <= cfg.retestTolerancePct;
  const bullish = entry > num(current.open) && entry > resistance;
  if (!touched) return reject("retest_did_not_touch_resistance_zone");
  if (!bullish) return reject("retest_confirmation_not_bullish");

  const stop = Math.min(
    low * (1 - cfg.stopLowBufferPct),
    resistance * (1 - cfg.stopResistanceBufferPct)
  );
  const stopPct = (entry - stop) / entry * 100;
  if (!(stopPct >= cfg.minStopPct && stopPct <= cfg.maxStopPct)) {
    return reject("stop_distance_out_of_range");
  }

  const risk = entry - stop;
  return {
    symbol, side: "LONG", eligible: true,
    version: BREAKOUT_RETEST_LONG_A_VERSION,
    entry, stop, stopPct,
    tp1: entry + risk * cfg.tp1R,
    tp2: entry + risk * cfg.tp2R,
    resistance,
    breakout: {
      candleIndex: breakout.index,
      volumeRatio: breakout.volumeRatio,
      volume: breakout.volume,
      averagePriorVolume: breakout.averageVolume
    },
    trend: { symbolEma50, btcEma50 }
  };
}

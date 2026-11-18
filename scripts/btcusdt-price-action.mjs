// Pure price-action helpers for the isolated BTCUSDT paper experiment.
// No EMA, RSI, MACD, ATR, volume, or other indicator dependencies.

function valid(c) {
  return c && [c.time,c.open,c.high,c.low,c.close].every(Number.isFinite) &&
    c.low > 0 && c.high >= c.low && c.open > 0 && c.close > 0;
}

export function confirmedPivots(candles, left = 2, right = 2) {
  if (!Array.isArray(candles) || candles.length < left + right + 3) return { highs: [], lows: [] };
  const highs = [], lows = [];
  for (let i = left; i < candles.length - right; i++) {
    const c = candles[i];
    if (!valid(c)) continue;
    const before = candles.slice(i-left, i);
    const after = candles.slice(i+1, i+right+1);
    if (before.every(x => valid(x) && c.high > x.high) && after.every(x => valid(x) && c.high >= x.high)) {
      highs.push({ index:i, time:c.time, price:c.high });
    }
    if (before.every(x => valid(x) && c.low < x.low) && after.every(x => valid(x) && c.low <= x.low)) {
      lows.push({ index:i, time:c.time, price:c.low });
    }
  }
  return { highs, lows };
}

export function detectFourHourTrend(h4) {
  const p = confirmedPivots(h4, 2, 2);
  const highs = p.highs.slice(-2), lows = p.lows.slice(-2);
  if (highs.length < 2 || lows.length < 2) return "NEUTRAL";
  const higherHighs = highs[1].price > highs[0].price;
  const higherLows = lows[1].price > lows[0].price;
  const lowerHighs = highs[1].price < highs[0].price;
  const lowerLows = lows[1].price < lows[0].price;
  if (higherHighs && higherLows) return "LONG";
  if (lowerHighs && lowerLows) return "SHORT";
  return "NEUTRAL";
}

export function detectOneHourBOS(h4, h1) {
  const trend = detectFourHourTrend(h4);
  if (trend === "NEUTRAL" || !Array.isArray(h1) || h1.length < 12) return null;
  const p = confirmedPivots(h1, 2, 2);
  const last = h1.at(-1), prev = h1.at(-2);
  if (!valid(last) || !valid(prev)) return null;
  if (trend === "LONG") {
    const pivot = p.highs.filter(x => x.index < h1.length - 3).at(-1);
    if (pivot && prev.close <= pivot.price && last.close > pivot.price) {
      return { side:"LONG", bosLevel:pivot.price, bosTime:last.time, trend4h:trend };
    }
  } else {
    const pivot = p.lows.filter(x => x.index < h1.length - 3).at(-1);
    if (pivot && prev.close >= pivot.price && last.close < pivot.price) {
      return { side:"SHORT", bosLevel:pivot.price, bosTime:last.time, trend4h:trend };
    }
  }
  return null;
}

export function detectLiquiditySweep15m(candles, lookback = 8) {
  if (!Array.isArray(candles) || candles.length < lookback + 2) return null;
  const bar = candles.at(-1), prev = candles.at(-2);
  const prior = candles.slice(-lookback-1, -1);
  if (!valid(bar) || !valid(prev) || prior.some(x => !valid(x))) return null;
  const priorLow = Math.min(...prior.map(x => x.low));
  const priorHigh = Math.max(...prior.map(x => x.high));
  const bullishSweep = bar.low < priorLow && bar.close > priorLow &&
    bar.close > bar.open && bar.close > prev.high;
  const bearishSweep = bar.high > priorHigh && bar.close < priorHigh &&
    bar.close < bar.open && bar.close < prev.low;
  if (bullishSweep) return { side:"LONG", entry:bar.close, stop:bar.low, sweepLevel:priorLow, candleTime:bar.time };
  if (bearishSweep) return { side:"SHORT", entry:bar.close, stop:bar.high, sweepLevel:priorHigh, candleTime:bar.time };
  return null;
}

export function buildPriceActionSignal(direction, candles15m, lookback = 8) {
  const sweep = detectLiquiditySweep15m(candles15m, lookback);
  if (!sweep || sweep.side !== direction?.side) return null;
  const entry = sweep.entry;
  const risk = direction.side === "LONG" ? entry - sweep.stop : sweep.stop - entry;
  if (!(risk > 0) || risk / entry > 0.02) return null;
  const sign = direction.side === "LONG" ? 1 : -1;
  return {
    ...sweep,
    side:direction.side,
    entry,
    stop:sweep.stop,
    target1:entry + sign * risk,
    target2:entry + sign * risk * 1.75,
    target3:entry + sign * risk * 2.5,
    risk,
    setup:"4H structure + 1H BOS + 15M liquidity sweep/reclaim"
  };
}

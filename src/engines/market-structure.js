// Causal 15m market-structure features. Pivots are only exposed after rightBars
// candles have closed, so no future candle can leak into a signal decision.
export function analyzeMarketStructure(candles, {
  leftBars = 3, rightBars = 3, atr = null,
  equalHighAtr = 0.2, trendlineAtr = 0.25, bosAtr = 0.05
} = {}) {
  if (!Array.isArray(candles) || candles.length < leftBars + rightBars + 1) return null;
  const n = candles.length;
  const confirmed = [];
  for (let i = leftBars; i < n - rightBars; i++) {
    const p = candles[i];
    const left = candles.slice(i - leftBars, i);
    const right = candles.slice(i + 1, i + rightBars + 1);
    const isHigh = left.every(c => p.high > c.high) && right.every(c => p.high >= c.high);
    const isLow = left.every(c => p.low < c.low) && right.every(c => p.low <= c.low);
    if (isHigh) confirmed.push({ type: "high", index: i, time: p.time, price: p.high });
    if (isLow) confirmed.push({ type: "low", index: i, time: p.time, price: p.low });
  }
  const highs = confirmed.filter(p => p.type === "high");
  const lows = confirmed.filter(p => p.type === "low");
  const last = candles[n - 1];
  const lastHighs = highs.slice(-2), lastLows = lows.slice(-2);
  const lowerHighs = lastHighs.length === 2 && lastHighs[1].price < lastHighs[0].price;
  const lowerLows = lastLows.length === 2 && lastLows[1].price < lastLows[0].price;
  const bearishStructure = lowerHighs && lowerLows;
  const priorLow = lows.at(-1);
  const priorHigh = highs.at(-1);
  const bosDown = Boolean(priorLow && last.close < priorLow.price - (Number.isFinite(atr) ? atr * bosAtr : 0));
  const chochUp = Boolean(priorHigh && last.close > priorHigh.price + (Number.isFinite(atr) ? atr * bosAtr : 0));

  // A descending resistance line is extrapolated only from already confirmed highs.
  let trendlineReject = false, trendlinePrice = null;
  if (lastHighs.length === 2 && lastHighs[1].index > lastHighs[0].index) {
    const [a, b] = lastHighs;
    const slope = (b.price - a.price) / (b.index - a.index);
    trendlinePrice = b.price + slope * ((n - 1) - b.index);
    const tolerance = Number.isFinite(atr) ? atr * trendlineAtr : last.close * 0.001;
    trendlineReject = slope < 0 && last.high >= trendlinePrice - tolerance &&
      last.close < trendlinePrice && last.close < last.open;
  }

  // Equal-high liquidity pools use only confirmed highs that predate this candle.
  const poolTolerance = Number.isFinite(atr) ? atr * equalHighAtr : last.close * 0.001;
  const pools = [];
  for (let i = 0; i < highs.length; i++) {
    for (let j = i + 1; j < highs.length; j++) {
      if (Math.abs(highs[i].price - highs[j].price) <= poolTolerance) {
        const level = (highs[i].price + highs[j].price) / 2;
        if (!pools.some(p => Math.abs(p.level - level) <= poolTolerance)) {
          pools.push({ level, firstIndex: highs[i].index, lastIndex: highs[j].index });
        }
      }
    }
  }
  const activePools = pools.filter(p => p.lastIndex < n - 1);
  const sweptHigh = activePools.find(p => last.high > p.level && last.close < p.level);
  return {
    confirmedHighs: highs, confirmedLows: lows,
    lowerHighs, lowerLows, bearishStructure, bosDown, chochUp,
    trendlineReject, trendlinePrice,
    equalHighPool: activePools.length > 0,
    sweptHigh: Boolean(sweptHigh), sweptLevel: sweptHigh?.level ?? null,
    lastSwingHigh: priorHigh?.price ?? null, lastSwingLow: priorLow?.price ?? null
  };
}

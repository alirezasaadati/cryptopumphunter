// Experimental Smart Money Concepts engine.
// Pure price/structure logic only: no RSI, MACD, moving averages, or external indicators.
// All pivots are confirmed using closed candles; no order execution is performed.

export const SMC_CONFIG = Object.freeze({
  MIN_4H_CANDLES: 30,
  MIN_1H_CANDLES: 30,
  MIN_15M_CANDLES: 40,
  PIVOT_LEFT: 2,
  PIVOT_RIGHT: 2,
  SWEEP_LOOKBACK: 8,
  FVG_LOOKBACK: 10,
  ORDER_BLOCK_LOOKBACK: 12,
  MIN_RISK_PCT: 0.0015,
  MAX_RISK_PCT: 0.06,
  TARGET_R_MULTIPLES: Object.freeze([1.5, 2.2, 3]),
  MIN_SCORE: 80,
  SWEEP_TOLERANCE_PCT: 0.0002
});

const finite = value => Number.isFinite(Number(value));
const body = candle => Math.abs(candle.close - candle.open);
const bullish = candle => candle.close > candle.open;
const bearish = candle => candle.close < candle.open;

export function validateSMCCandles(candles, minimum = 1) {
  if (!Array.isArray(candles) || candles.length < minimum) return false;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    if (!c || ![c.time,c.open,c.high,c.low,c.close].every(finite) ||
        c.open <= 0 || c.low <= 0 ||
        c.high < Math.max(c.open,c.close) ||
        c.low > Math.min(c.open,c.close) ||
        (i > 0 && c.time <= candles[i-1].time)) return false;
  }
  return true;
}

export function findConfirmedSMCSwings(candles, left = SMC_CONFIG.PIVOT_LEFT, right = SMC_CONFIG.PIVOT_RIGHT) {
  if (!validateSMCCandles(candles, left + right + 3)) return { highs: [], lows: [] };
  const highs = [], lows = [];
  for (let i = left; i < candles.length - right; i++) {
    const current = candles[i];
    const before = candles.slice(i-left,i);
    const after = candles.slice(i+1,i+right+1);
    if (before.every(x => current.high > x.high) && after.every(x => current.high >= x.high))
      highs.push({ index:i, time:current.time, price:current.high });
    if (before.every(x => current.low < x.low) && after.every(x => current.low <= x.low))
      lows.push({ index:i, time:current.time, price:current.low });
  }
  return { highs, lows };
}

export function describeSMCStructure(candles) {
  const swings = findConfirmedSMCSwings(candles);
  const highs = swings.highs.slice(-2), lows = swings.lows.slice(-2);
  if (highs.length < 2 || lows.length < 2) return { bias:"NEUTRAL", swings };
  const higherHigh = highs[1].price > highs[0].price;
  const higherLow = lows[1].price > lows[0].price;
  const lowerHigh = highs[1].price < highs[0].price;
  const lowerLow = lows[1].price < lows[0].price;
  return {
    bias: higherHigh && higherLow ? "BULLISH" :
      lowerHigh && lowerLow ? "BEARISH" : "NEUTRAL",
    higherHigh,higherLow,lowerHigh,lowerLow,swings
  };
}

// A sweep requires price to trade through a confirmed swing and close back inside.
export function detectLiquiditySweep(candles, side, lookback = SMC_CONFIG.SWEEP_LOOKBACK) {
  if (!validateSMCCandles(candles, 8)) return null;
  const swings = findConfirmedSMCSwings(candles.slice(0,-1));
  const lastIndex = candles.length - 1;
  const start = Math.max(0,lastIndex-lookback);
  if (side === "LONG") {
    const levels = swings.lows.filter(x => x.index + SMC_CONFIG.PIVOT_RIGHT < lastIndex-1);
    for (let i = lastIndex-1; i >= start; i--) {
      const c = candles[i];
      const level = [...levels].reverse().find(x => x.index < i && c.low < x.price*(1-SMC_CONFIG.SWEEP_TOLERANCE_PCT) && c.close > x.price);
      if (level) return { side, index:i, time:c.time, level:level.price, extreme:c.low, reclaimed:true };
    }
  } else if (side === "SHORT") {
    const levels = swings.highs.filter(x => x.index + SMC_CONFIG.PIVOT_RIGHT < lastIndex-1);
    for (let i = lastIndex-1; i >= start; i--) {
      const c = candles[i];
      const level = [...levels].reverse().find(x => x.index < i && c.high > x.price*(1+SMC_CONFIG.SWEEP_TOLERANCE_PCT) && c.close < x.price);
      if (level) return { side, index:i, time:c.time, level:level.price, extreme:c.high, reclaimed:true };
    }
  }
  return null;
}

// Three-candle imbalance. Bullish zone = [older high, newer low].
export function findFairValueGaps(candles, side, lookback = SMC_CONFIG.FVG_LOOKBACK) {
  if (!validateSMCCandles(candles, 3)) return [];
  const start = Math.max(2,candles.length-lookback);
  const gaps = [];
  for (let i=start; i<candles.length; i++) {
    const older = candles[i-2], newer = candles[i];
    if (side === "LONG" && newer.low > older.high) {
      gaps.push({ side, index:i, lower:older.high, upper:newer.low, midpoint:(older.high+newer.low)/2 });
    }
    if (side === "SHORT" && newer.high < older.low) {
      gaps.push({ side, index:i, lower:newer.high, upper:older.low, midpoint:(newer.high+older.low)/2 });
    }
  }
  return gaps;
}

export function findOrderBlock(candles, side, beforeIndex = candles.length-1, lookback = SMC_CONFIG.ORDER_BLOCK_LOOKBACK) {
  if (!validateSMCCandles(candles, 4)) return null;
  const start = Math.max(0,beforeIndex-lookback);
  for (let i=beforeIndex-1; i>=start; i--) {
    const c = candles[i];
    if ((side === "LONG" && bearish(c)) || (side === "SHORT" && bullish(c))) {
      return { side, index:i, time:c.time, low:c.low, high:c.high, open:c.open, close:c.close };
    }
  }
  return null;
}

export function calculatePremiumDiscount(candles, price) {
  if (!validateSMCCandles(candles, 5) || !finite(price) || Number(price)<=0) return null;
  const range = candles.slice(-40);
  const high = Math.max(...range.map(c=>c.high));
  const low = Math.min(...range.map(c=>c.low));
  if (!(high>low)) return null;
  const equilibrium = (high+low)/2;
  return {
    high,low,equilibrium,
    zone:Number(price)<equilibrium ? "DISCOUNT" : "PREMIUM",
    positionPct:(Number(price)-low)/(high-low)*100
  };
}

function intersects(candle, zone) {
  return candle.low <= zone.upper && candle.high >= zone.lower;
}

function buildPlan({symbol,side,entry,stop,score,reason,sweep,fvg,orderBlock,range}) {
  const risk = side === "LONG" ? entry-stop : stop-entry;
  const riskPct = risk/entry;
  if (!(risk>0) || riskPct<SMC_CONFIG.MIN_RISK_PCT || riskPct>SMC_CONFIG.MAX_RISK_PCT) return null;
  const direction = side === "LONG" ? 1 : -1;
  const targets = SMC_CONFIG.TARGET_R_MULTIPLES.map(r=>entry+direction*risk*r);
  return {
    symbol,side,strategyId:"smc_liquidity_choch_fvg",strategyName:"Smart Money Concepts",
    score,entry,stop,target1:targets[0],target2:targets[1],target3:targets[2],
    rewardRisk:3,reason,
    context:{
      sweepLevel:sweep.level,sweepExtreme:sweep.extreme,
      fvg:{lower:fvg.lower,upper:fvg.upper},
      orderBlock:orderBlock?{low:orderBlock.low,high:orderBlock.high}:null,
      dealingRange:{low:range.low,high:range.high,equilibrium:range.equilibrium,zone:range.zone}
    },
    timeframes:["4h","1h","15m"],setupTime:sweep.time
  };
}

/**
 * Strict sequence:
 * 1) confirmed 15m liquidity sweep in the prior bars;
 * 2) subsequent 15m close crosses the last confirmed opposing swing (CHoCH);
 * 3) a same-direction FVG exists after the sweep and the latest candle retests it;
 * 4) entry must be in discount for LONG or premium for SHORT;
 * 5) 4H bias may be neutral or aligned, never clearly opposed.
 */
export function analyzeSMC({symbol,oneHour,fourHour,fifteenMin,livePrice}) {
  if (!validateSMCCandles(oneHour,SMC_CONFIG.MIN_1H_CANDLES) ||
      !validateSMCCandles(fourHour,SMC_CONFIG.MIN_4H_CANDLES) ||
      !validateSMCCandles(fifteenMin,SMC_CONFIG.MIN_15M_CANDLES)) {
    return { signals:[], rejected:"داده کندلی بسته‌شده برای تحلیل SMC کافی یا معتبر نیست.", diagnostics:[] };
  }
  const price = Number(livePrice);
  if (!Number.isFinite(price) || price<=0) return {signals:[],rejected:"قیمت لحظه‌ای معتبر نیست.",diagnostics:[]};

  const last = fifteenMin.at(-1);
  const previousBars = fifteenMin.slice(0,-1);
  const swings = findConfirmedSMCSwings(previousBars);
  const structure4h = describeSMCStructure(fourHour);
  const structure1h = describeSMCStructure(oneHour);
  const candidates = [];

  for (const side of ["LONG","SHORT"]) {
    const sweep = detectLiquiditySweep(fifteenMin,side);
    if (!sweep || sweep.index >= fifteenMin.length-1) continue;

    const opposingSwings = side === "LONG" ? swings.highs : swings.lows;
    const breakLevel = [...opposingSwings].reverse().find(x=>x.index>sweep.index);
    if (!breakLevel) continue;
    const choch = side === "LONG"
      ? last.close > breakLevel.price && previousBars.at(-1).close <= breakLevel.price
      : last.close < breakLevel.price && previousBars.at(-1).close >= breakLevel.price;
    if (!choch) continue;

    const gaps = findFairValueGaps(fifteenMin.slice(sweep.index+1),side);
    const lastLocalIndex = fifteenMin.length-sweep.index-2;
    const gap = [...gaps].reverse().find(x=>x.index>=2 && x.index<lastLocalIndex && intersects(last,x));
    if (!gap) continue;

    const range = calculatePremiumDiscount(fifteenMin,price);
    if (!range || (side==="LONG" && range.zone!=="DISCOUNT") || (side==="SHORT" && range.zone!=="PREMIUM")) continue;
    if (structure4h.bias!=="NEUTRAL" &&
        ((side==="LONG" && structure4h.bias==="BEARISH") || (side==="SHORT" && structure4h.bias==="BULLISH"))) continue;

    const postSweepBars = fifteenMin.slice(sweep.index+1,-1);
    const orderBlock = postSweepBars.length>=2 ? findOrderBlock(postSweepBars,side,postSweepBars.length) : null;
    const stop = side==="LONG"
      ? Math.min(sweep.extreme,orderBlock?.low??sweep.extreme)-price*0.0005
      : Math.max(sweep.extreme,orderBlock?.high??sweep.extreme)+price*0.0005;
    const score = Math.min(98,80+(orderBlock&&intersects(last,orderBlock)?8:0)+
      (structure1h.bias===(side==="LONG"?"BULLISH":"BEARISH")?5:0));
    const plan = buildPlan({
      symbol,side,entry:price,stop,score,
      reason:"جمع‌آوری نقدینگی، تغییر ساختار CHoCH، بازگشت به FVG و ورود در ناحیه "+range.zone,
      sweep,fvg:gap,orderBlock,range
    });
    if (plan && score>=SMC_CONFIG.MIN_SCORE) candidates.push(plan);
  }

  const sides = new Set(candidates.map(x=>x.side));
  if (sides.size>1) return {signals:[],conflict:true,rejected:"تعارض جهت در ستاپ‌های SMC؛ سیگنال صادر نشد.",diagnostics:[]};
  const valid = candidates.filter(x=>Math.abs(price-x.entry)/x.entry*100<=0.35);
  return {
    signals:valid.sort((a,b)=>b.score-a.score),
    conflict:false,
    rejected:valid.length?undefined:"تمام شروط ساختاری SMC هم‌زمان برقرار نبودند.",
    diagnostics:[{
      strategyId:"smc_liquidity_choch_fvg",
      strategyName:"Smart Money Concepts",
      status:valid.length?"accepted":"no_setup",
      score:valid[0]?.score??null,
      side:valid[0]?.side??null
    }]
  };
}

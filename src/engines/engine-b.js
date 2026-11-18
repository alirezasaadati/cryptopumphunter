import { ENGINE_CONFIG, validateCandles, ema, rsi, atr, volumeRatio, swings, scoreSignal, makeSignalBase, roundPrice } from "./engine-utils.js";

// Independent adaptive trend/momentum/volatility model. Targets are risk multiples.
export function analyzeEngineB({symbol,candles,quoteVolume,skipLiquidityCheck=false}) {
  if(!validateCandles(candles) || (!skipLiquidityCheck && (!Number.isFinite(Number(quoteVolume)) || Number(quoteVolume)<ENGINE_CONFIG.MIN_QUOTE_VOLUME))) return null;
  const closes=candles.map(c=>c.close), last=candles.at(-1), prev=candles.at(-2);
  const fast=ema(closes,20), slow=ema(closes,50), momentum=rsi(closes,14);
  const volatility=atr(candles,14), vol=volumeRatio(candles,20), levels=swings(candles,20);
  if(![fast,slow,momentum,volatility,vol,levels.high,levels.low].every(Number.isFinite) || volatility<=0) return null;
  const longTrend=fast>slow && last.close>slow, shortTrend=fast<slow && last.close<slow;
  const longTrigger=last.close>prev.high || (last.low<=fast && last.close>fast && last.close>last.open);
  const shortTrigger=last.close<prev.low || (last.high>=fast && last.close<fast && last.close<last.open);
  let side=null;
  if(longTrend && longTrigger && momentum>=48 && momentum<=78) side="LONG";
  if(shortTrend && shortTrigger && momentum<=52 && momentum>=22) side="SHORT";
  if(!side) return null;
  const trend=side==="LONG"?longTrend:shortTrend;
  const momentumOk=side==="LONG"?momentum>50:momentum<50;
  const entry=last.close, buffer=Math.max(volatility*0.65,entry*0.0015);
  const stop=side==="LONG"?Math.min(levels.low,last.low)-buffer:Math.max(levels.high,last.high)+buffer;
  const risk=side==="LONG"?entry-stop:stop-entry;
  if(!(risk>0 && risk/entry>=0.001 && risk/entry<=0.08)) return null;
  const score=scoreSignal({trend,momentum:momentumOk,volume:vol>=1.05,
    entry:Math.abs(entry-fast)<=volatility*1.8,context:Math.abs(entry-slow)/entry<0.04});
  if(score<ENGINE_CONFIG.MIN_SCORE) return null;
  const direction=side==="LONG"?1:-1;
  const targets=[1.5,2.2,3].map(r=>roundPrice(entry+direction*risk*r));
  return {
    ...makeSignalBase({engine:"B",symbol,side,entry,stop,score,
      reason:"Adaptive 15m trend/momentum/volume trigger with ATR and swing invalidation",
      candleTime:last.time,context:{ema20:roundPrice(fast),ema50:roundPrice(slow),rsi:roundPrice(momentum),
        atr:roundPrice(volatility),volumeRatio:roundPrice(vol),targetsR:[1.5,2.2,3]}}),
    targets
  };
}

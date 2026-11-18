import { ENGINE_CONFIG, validateCandles, ema, rsi, atr, volumeRatio, swings, scoreSignal, makeSignalBase, roundPrice } from "./engine-utils.js";

export function buildEngineATargets(reference, side) {\n  if (!(Number.isFinite(reference) && reference > 0) || !["LONG", "SHORT"].includes(side)) return [];\n  const direction=side==="LONG"?1:-1;\n  return ENGINE_CONFIG.A_TARGETS_PCT.map(p=>roundPrice(reference*(1+direction*p/100)));\n}\n\n// Channel-inspired model. Entry 2 is conditional; all price plans expose
// separate levels for the one-fill and two-fill scenarios.
export function analyzeEngineA({symbol,candles,quoteVolume}) {
  if (!validateCandles(candles) || !Number.isFinite(Number(quoteVolume)) || Number(quoteVolume)<ENGINE_CONFIG.MIN_QUOTE_VOLUME) return null;
  const closes=candles.map(c=>c.close), last=candles.at(-1), prior=candles.at(-2);
  const fast=ema(closes,20), slow=ema(closes,50), momentum=rsi(closes,14);
  const volatility=atr(candles,14), vol=volumeRatio(candles,20), levels=swings(candles,20);
  if (![fast,slow,momentum,volatility,vol,levels.high,levels.low].every(Number.isFinite) || volatility<=0) return null;
  const trendUp=fast>slow, trendDown=fast<slow;
  const bullish=last.close>last.open && last.close>prior.close;
  const bearish=last.close<last.open && last.close<prior.close;
  const breakoutLong=last.close>levels.high && prior.close<=levels.high;
  const breakoutShort=last.close<levels.low && prior.close>=levels.low;
  const pullbackLong=trendUp && last.low<=fast*1.002 && last.close>fast;
  const pullbackShort=trendDown && last.high>=fast*0.998 && last.close<fast;
  let side=null, setup="";
  if(trendUp && momentum>=50 && momentum<=75 && bullish && (breakoutLong||pullbackLong)){side="LONG";setup=breakoutLong?"breakout":"pullback";}
  if(trendDown && momentum<=50 && momentum>=25 && bearish && (breakoutShort||pullbackShort)){side="SHORT";setup=breakoutShort?"breakout":"pullback";}
  if(!side) return null;
  const score=scoreSignal({trend:true,momentum:true,volume:vol>=1.15,entry:true,context:Math.abs(last.close-fast)/last.close<0.025});
  if(score<ENGINE_CONFIG.MIN_SCORE) return null;

  const entry1=last.close, offset=ENGINE_CONFIG.ENTRY2_OFFSET_PCT/100;
  const entry2=side==="LONG"?entry1*(1-offset):entry1*(1+offset);
  const bothFilledAverage=(entry1+entry2)/2;
  const buffer=Math.max(volatility*0.8,entry1*0.002);
  const stop=side==="LONG"?Math.min(levels.low,last.low)-buffer:Math.max(levels.high,last.high)+buffer;
  // Validate risk against the less favorable one-fill case. Entry 2 is not
  // assumed filled when sizing or publishing the primary plan.
  const risk=side==="LONG"?entry1-stop:stop-entry1;
  if(!(risk>0 && risk/entry1<=0.12)) return null;
  const direction=side==="LONG"?1:-1;
  const targetsFor=reference=>ENGINE_CONFIG.A_TARGETS_PCT.map(p=>roundPrice(reference*(1+direction*p/100)));
  const targets=targetsFor(entry1);
  const targetsIfBothFilled=targetsFor(bothFilledAverage);
  const base=makeSignalBase({engine:"A",symbol,side,entry:entry1,stop,score,
    reason:`15m ${setup}; EMA20/50, RSI, volume and structure aligned`,
    candleTime:last.time,context:{setup,entry2:roundPrice(entry2),averageEntryIfBothFilled:roundPrice(bothFilledAverage),
      entry2OffsetPct:ENGINE_CONFIG.ENTRY2_OFFSET_PCT,targets,targetsIfBothFilled,
      entry2Conditional:true,cancelEntry2IfTarget1BeforeFill:true}});
  if(!base) return null;
  return {...base,entry1:roundPrice(entry1),entry2:roundPrice(entry2),
    averageEntryIfBothFilled:roundPrice(bothFilledAverage),targets,targetsIfBothFilled};
}

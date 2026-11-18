// Standalone candlestick-pattern signal engine. No indicators or trend filters.
export const CANDLE_CONFIG = Object.freeze({
  MIN_RISK_PCT: 0.0015,
  MAX_RISK_PCT: 0.035,
  TARGET_R_MULTIPLES: [1, 1.5, 2],
  TARGET_WEIGHTS: [0.40, 0.35, 0.25],
  MAX_HOLD_BARS: 96
});

const valid = c => c && [c.time,c.open,c.high,c.low,c.close].every(x => Number.isFinite(Number(x))) &&
  c.open > 0 && c.close > 0 && c.low > 0 && c.high >= Math.max(c.open,c.close) &&
  c.low <= Math.min(c.open,c.close);
const body = c => Math.abs(c.close-c.open);
const range = c => c.high-c.low;
const upper = c => c.high-Math.max(c.open,c.close);
const lower = c => Math.min(c.open,c.close)-c.low;
const bullish = c => c.close>c.open;
const bearish = c => c.close<c.open;

function makeSignal(candles, pattern, side, start, end) {
  const formation=candles.slice(start,end+1);
  const stop=side==="LONG" ? Math.min(...formation.map(c=>c.low)) : Math.max(...formation.map(c=>c.high));
  const trigger=candles[end];
  const reference=trigger.close;
  const risk=side==="LONG" ? reference-stop : stop-reference;
  const riskPct=risk/reference;
  if (!(risk>0) || riskPct<CANDLE_CONFIG.MIN_RISK_PCT || riskPct>CANDLE_CONFIG.MAX_RISK_PCT) return null;
  return {pattern,side,signalIndex:end,signalTime:trigger.time,stop,formationStart:start,formationEnd:end};
}

function detectEngulfing(c,i) {
  if(i<1) return [];
  const p=c[i-1], x=c[i];
  if(bearish(p)&&bullish(x)&&x.open<=p.close&&x.close>=p.open)
    return [makeSignal(c,"bullish_engulfing","LONG",i-1,i)].filter(Boolean);
  if(bullish(p)&&bearish(x)&&x.open>=p.close&&x.close<=p.open)
    return [makeSignal(c,"bearish_engulfing","SHORT",i-1,i)].filter(Boolean);
  return [];
}
function detectPinBar(c,i) {
  const x=c[i], r=range(x), b=body(x);
  if(!(r>0)||b/r>0.35) return [];
  if(lower(x)>=Math.max(b*2, r*0.5) && x.close>=x.low+r*0.68)
    return [makeSignal(c,"bullish_pin_bar","LONG",i,i)].filter(Boolean);
  if(upper(x)>=Math.max(b*2, r*0.5) && x.close<=x.low+r*0.32)
    return [makeSignal(c,"bearish_pin_bar","SHORT",i,i)].filter(Boolean);
  return [];
}
function detectStars(c,i) {
  if(i<2) return [];
  const a=c[i-2], m=c[i-1], z=c[i];
  const small=body(m)<=Math.max(body(a)*0.35,range(m)*0.25);
  if(bearish(a)&&small&&bullish(z)&&body(z)>=range(z)*0.4&&z.close>(a.open+a.close)/2)
    return [makeSignal(c,"morning_star","LONG",i-2,i)].filter(Boolean);
  if(bullish(a)&&small&&bearish(z)&&body(z)>=range(z)*0.4&&z.close<(a.open+a.close)/2)
    return [makeSignal(c,"evening_star","SHORT",i-2,i)].filter(Boolean);
  return [];
}
function detectPiercing(c,i) {
  if(i<1) return [];
  const p=c[i-1], x=c[i], mid=(p.open+p.close)/2;
  if(bearish(p)&&bullish(x)&&x.open<=p.close&&x.close>mid&&x.close<p.open)
    return [makeSignal(c,"piercing_line","LONG",i-1,i)].filter(Boolean);
  if(bullish(p)&&bearish(x)&&x.open>=p.close&&x.close<mid&&x.close>p.open)
    return [makeSignal(c,"dark_cloud_cover","SHORT",i-1,i)].filter(Boolean);
  return [];
}
function detectThreeSoldiers(c,i) {
  if(i<2) return [];
  const a=c[i-2],b=c[i-1],z=c[i];
  const strong=x=>range(x)>0&&body(x)/range(x)>=0.45;
  if([a,b,z].every(bullish)&&[a,b,z].every(strong)&&b.close>a.close&&z.close>b.close)
    return [makeSignal(c,"three_white_soldiers","LONG",i-2,i)].filter(Boolean);
  if([a,b,z].every(bearish)&&[a,b,z].every(strong)&&b.close<a.close&&z.close<b.close)
    return [makeSignal(c,"three_black_crows","SHORT",i-2,i)].filter(Boolean);
  return [];
}
function detectInsideBreakout(c,i) {
  if(i<2) return [];
  const mother=c[i-2], inside=c[i-1], x=c[i];
  if(inside.high<mother.high&&inside.low>mother.low&&x.close>mother.high&&bullish(x))
    return [makeSignal(c,"inside_bar_breakout_long","LONG",i-2,i)].filter(Boolean);
  if(inside.high<mother.high&&inside.low>mother.low&&x.close<mother.low&&bearish(x))
    return [makeSignal(c,"inside_bar_breakout_short","SHORT",i-2,i)].filter(Boolean);
  return [];
}

const DETECTORS=[detectEngulfing,detectPinBar,detectStars,detectPiercing,detectThreeSoldiers,detectInsideBreakout];
export const CANDLE_PATTERNS=Object.freeze([
  "bullish_engulfing","bearish_engulfing","bullish_pin_bar","bearish_pin_bar",
  "morning_star","evening_star","piercing_line","dark_cloud_cover",
  "three_white_soldiers","three_black_crows",
  "inside_bar_breakout_long","inside_bar_breakout_short"
]);

export function validateOhlc(candles) {
  if(!Array.isArray(candles)||candles.length<3) return false;
  for(let i=0;i<candles.length;i++){
    if(!valid(candles[i])) return false;
    if(i&&Number(candles[i].time)<=Number(candles[i-1].time)) return false;
  }
  return true;
}
export function detectCandlestickSignals(candles,index=candles?.length-1) {
  if(!Array.isArray(candles)||!Number.isInteger(index)||index<0||index>=candles.length) return [];
  const start=Math.max(0,index-2), window=candles.slice(start,index+1);
  if(window.length<3||window.some((x,i)=>!valid(x)||(i&&x.time<=window[i-1].time))) return [];
  return DETECTORS.flatMap(fn=>fn(candles,index)).filter(Boolean);
}

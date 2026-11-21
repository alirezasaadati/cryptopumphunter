// Independent volume-flow futures signal engine.
// Volume is quote/base traded volume from the venue; it is NOT buyer/seller delta.
export const VOLUME_FLOW_CONFIG = Object.freeze({
  MIN_4H: 60, MIN_1H: 80, MIN_15M: 80,
  VOLUME_LOOKBACK: 20, MIN_RELATIVE_VOLUME: 1.5,
  BREAKOUT_LOOKBACK: 20, MIN_BODY_TO_RANGE: 0.55,
  MIN_CLOSE_LOCATION: 0.72, MIN_RISK_PCT: 0.0015,
  MAX_RISK_PCT: 0.04, STOP_ATR_BUFFER: 0.2,
  TARGET_R: [1.5, 2.2, 3]
});
const finite = n => Number.isFinite(Number(n));
const mean = xs => xs.length ? xs.reduce((a,b)=>a+b,0)/xs.length : 0;
function valid(candles, min) {
  return Array.isArray(candles) && candles.length >= min &&
    candles.every((c,i)=>c && [c.time,c.open,c.high,c.low,c.close,c.volume].every(finite) &&
      c.open>0 && c.low>0 && c.volume>=0 && c.high>=Math.max(c.open,c.close) &&
      c.low<=Math.min(c.open,c.close) && (!i || c.time>candles[i-1].time));
}
function ema(values, period) {
  if(values.length<period) return null;
  const k=2/(period+1); let v=mean(values.slice(0,period));
  for(let i=period;i<values.length;i++) v=values[i]*k+v*(1-k);
  return v;
}
function atr(candles, period=14) {
  const tr=[];
  for(let i=1;i<candles.length;i++){
    const c=candles[i], p=candles[i-1].close;
    tr.push(Math.max(c.high-c.low,Math.abs(c.high-p),Math.abs(c.low-p)));
  }
  return mean(tr.slice(-period));
}
function trend(candles) {
  const closes=candles.map(c=>c.close), fast=ema(closes,20), slow=ema(closes,50);
  const last=closes.at(-1);
  if(!finite(fast)||!finite(slow)) return "UNKNOWN";
  return fast>slow && last>fast ? "LONG" : fast<slow && last<fast ? "SHORT" : "RANGE";
}
export function analyzeVolumeFlow({symbol,fourHour,oneHour,fifteenMin}) {
  const cfg=VOLUME_FLOW_CONFIG;
  if(!valid(fourHour,cfg.MIN_4H)||!valid(oneHour,cfg.MIN_1H)||!valid(fifteenMin,cfg.MIN_15M))
    return {signal:null,rejected:"invalid_or_insufficient_candles"};
  const t4=trend(fourHour), t1=trend(oneHour);
  if(t4!==t1 || !["LONG","SHORT"].includes(t1))
    return {signal:null,rejected:"timeframe_trend_mismatch"};
  const trigger=fifteenMin.at(-1), prior=fifteenMin.slice(-(cfg.BREAKOUT_LOOKBACK+1),-1);
  if(prior.length<cfg.BREAKOUT_LOOKBACK) return {signal:null,rejected:"insufficient_breakout_history"};
  const baseline=mean(fifteenMin.slice(-(cfg.VOLUME_LOOKBACK+1),-1).map(c=>c.volume));
  if(!(baseline>0) || !(trigger.volume>0)) return {signal:null,rejected:"volume_unavailable"};
  const relativeVolume=trigger.volume/baseline;
  if(relativeVolume<cfg.MIN_RELATIVE_VOLUME) return {signal:null,rejected:"weak_relative_volume"};
  const candleRange=trigger.high-trigger.low;
  if(!(candleRange>0)) return {signal:null,rejected:"zero_range"};
  const bodyRatio=Math.abs(trigger.close-trigger.open)/candleRange;
  const closeLocation=(trigger.close-trigger.low)/candleRange;
  if(bodyRatio<cfg.MIN_BODY_TO_RANGE) return {signal:null,rejected:"weak_candle_body"};
  const highest=Math.max(...prior.map(c=>c.high)), lowest=Math.min(...prior.map(c=>c.low));
  let side=null;
  if(t1==="LONG" && trigger.close>highest && trigger.close>trigger.open &&
      closeLocation>=cfg.MIN_CLOSE_LOCATION) side="LONG";
  if(t1==="SHORT" && trigger.close<lowest && trigger.close<trigger.open &&
      closeLocation<=1-cfg.MIN_CLOSE_LOCATION) side="SHORT";
  if(!side) return {signal:null,rejected:"no_confirmed_directional_breakout"};
  const volatility=atr(fifteenMin);
  if(!(volatility>0)) return {signal:null,rejected:"invalid_atr"};
  const entry=trigger.close;
  const stop=side==="LONG" ? trigger.low-volatility*cfg.STOP_ATR_BUFFER : trigger.high+volatility*cfg.STOP_ATR_BUFFER;
  const risk=side==="LONG" ? entry-stop : stop-entry;
  const riskPct=risk/entry;
  if(!(risk>0)||riskPct<cfg.MIN_RISK_PCT||riskPct>cfg.MAX_RISK_PCT)
    return {signal:null,rejected:"risk_out_of_bounds"};
  const sign=side==="LONG"?1:-1;
  const targets=cfg.TARGET_R.map(r=>entry+sign*risk*r);
  return {signal:{
    symbol,side,entry,stop,target1:targets[0],target2:targets[1],target3:targets[2],
    relativeVolume:Number(relativeVolume.toFixed(3)),bodyRatio:Number(bodyRatio.toFixed(3)),
    closeLocation:Number(closeLocation.toFixed(3)),riskPct:Number((riskPct*100).toFixed(3)),
    strategyId:"volume_flow_breakout",score:Math.min(98,70+Math.min(20,(relativeVolume-1)*12)),
    reason:"هم‌جهتی روند 1H/4H + شکست 15M + حجم نسبی تأییدشده",
    triggerTime:trigger.time
  },rejected:null};
}

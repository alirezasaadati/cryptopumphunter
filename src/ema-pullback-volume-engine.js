// Experimental EMA pullback + volume confirmation engine.
// Pure deterministic logic; consumes CLOSED candles only. No network or order execution.
export const EMA_PULLBACK_CONFIG = Object.freeze({
  EMA_FAST: 20,
  EMA_SLOW: 50,
  ATR_PERIOD: 14,
  PIVOT_LEFT: 3,
  PIVOT_RIGHT: 3,
  ZONE_ATR_TOLERANCE: 0.25,
  STOP_ATR_BUFFER: 0.15,
  PULLBACK_VOLUME_BARS: 3,
  BASE_VOLUME_BARS: 10,
  PULLBACK_VOLUME_MAX_RATIO: 0.85,
  TRIGGER_VOLUME_BARS: 20,
  TRIGGER_VOLUME_MIN_RATIO: 1.5,
  MIN_TRIGGER_BODY_RATIO: 0.55,
  PINBAR_WICK_BODY_RATIO: 2.0,
  MIN_RR: 2,
  TARGET_R: [2, 3],
  MIN_CANDLES: 60
});

const mean = xs => xs.length ? xs.reduce((a,b)=>a+b,0)/xs.length : null;
const valid = c => c && ["time","open","high","low","close","volume"].every(k => Number.isFinite(Number(c[k]))) &&
  c.low > 0 && c.high >= Math.max(c.open,c.close) && c.low <= Math.min(c.open,c.close) && c.volume >= 0;
const clamp = (x,a,b) => Math.max(a,Math.min(b,x));

export function ema(values, period) {
  if (!Array.isArray(values) || values.length < period) return [];
  const out = new Array(values.length).fill(null);
  let v = mean(values.slice(0,period));
  out[period-1] = v;
  const alpha = 2/(period+1);
  for (let i=period;i<values.length;i++) { v = values[i]*alpha + v*(1-alpha); out[i]=v; }
  return out;
}

export function atr(candles, period=EMA_PULLBACK_CONFIG.ATR_PERIOD) {
  if (!Array.isArray(candles) || candles.length < period+1) return [];
  const tr=[];
  for(let i=1;i<candles.length;i++) {
    const c=candles[i], p=candles[i-1];
    tr.push(Math.max(c.high-c.low,Math.abs(c.high-p.close),Math.abs(c.low-p.close)));
  }
  const out=new Array(candles.length).fill(null);
  let v=mean(tr.slice(0,period)); out[period]=v;
  for(let i=period+1;i<candles.length;i++) { v=(v*(period-1)+tr[i-1])/period; out[i]=v; }
  return out;
}

// Pivot points are only returned after PIVOT_RIGHT candles have closed.
export function confirmedPivots(candles,left=EMA_PULLBACK_CONFIG.PIVOT_LEFT,right=EMA_PULLBACK_CONFIG.PIVOT_RIGHT) {
  const lows=[], highs=[];
  for(let i=left;i<candles.length-right;i++) {
    const c=candles[i], before=candles.slice(i-left,i), after=candles.slice(i+1,i+right+1);
    if(before.every(x=>c.low<x.low)&&after.every(x=>c.low<=x.low)) lows.push({index:i,confirmedAt:i+right,price:c.low});
    if(before.every(x=>c.high>x.high)&&after.every(x=>c.high>=x.high)) highs.push({index:i,confirmedAt:i+right,price:c.high});
  }
  return {lows,highs};
}

function trendState(candles) {
  if(candles.length<EMA_PULLBACK_CONFIG.MIN_CANDLES) return {direction:"UNKNOWN"};
  const closes=candles.map(c=>c.close), fast=ema(closes,20), slow=ema(closes,50), i=candles.length-1;
  if(fast[i]==null||slow[i]==null) return {direction:"UNKNOWN"};
  if(closes[i]>slow[i]&&fast[i]>slow[i]) return {direction:"LONG",ema20:fast[i],ema50:slow[i]};
  if(closes[i]<slow[i]&&fast[i]<slow[i]) return {direction:"SHORT",ema20:fast[i],ema50:slow[i]};
  return {direction:"NEUTRAL",ema20:fast[i],ema50:slow[i]};
}

function isBullEngulf(prev,c) {
  return prev.close<prev.open && c.close>c.open && c.open<=prev.close && c.close>=prev.open;
}
function isBearEngulf(prev,c) {
  return prev.close>prev.open && c.close<c.open && c.open>=prev.close && c.close<=prev.open;
}
function isBullPin(c,ratio) {
  const body=Math.max(Math.abs(c.close-c.open),1e-12), lower=Math.min(c.open,c.close)-c.low;
  return lower/body>=ratio && (c.high-Math.max(c.open,c.close))<=body && c.close>c.open;
}
function isBearPin(c,ratio) {
  const body=Math.max(Math.abs(c.close-c.open),1e-12), upper=c.high-Math.max(c.open,c.close);
  return upper/body>=ratio && (Math.min(c.open,c.close)-c.low)<=body && c.close<c.open;
}

export function evaluateEmaPullback({higherTimeframe,entryTimeframe,symbol="BTCUSDT",config={}}) {
  const cfg={...EMA_PULLBACK_CONFIG,...config};
  const reject=(reason,diagnostics={})=>({eligible:false,rejected:reason,diagnostics});
  if(!Array.isArray(higherTimeframe)||!Array.isArray(entryTimeframe)||
     higherTimeframe.some(c=>!valid(c))||entryTimeframe.some(c=>!valid(c))||
     higherTimeframe.length<cfg.MIN_CANDLES||entryTimeframe.length<cfg.MIN_CANDLES)
    return reject("INSUFFICIENT_OR_INVALID_CANDLES");
  const trend=trendState(higherTimeframe);
  if(trend.direction!=="LONG"&&trend.direction!=="SHORT") return reject("HTF_TREND_NOT_ALIGNED",{trend});
  const bars=entryTimeframe, i=bars.length-1, c=bars[i], prev=bars[i-1];
  const atrs=atr(bars,cfg.ATR_PERIOD), a=atrs[i];
  if(!a||!Number.isFinite(a)) return reject("ATR_UNAVAILABLE",{trend});
  const fast=ema(bars.map(x=>x.close),cfg.EMA_FAST), slow=ema(bars.map(x=>x.close),cfg.EMA_SLOW);
  const pivots=confirmedPivots(bars,cfg.PIVOT_LEFT,cfg.PIVOT_RIGHT);
  const side=trend.direction, bullish=side==="LONG";
  const pullback=bars.slice(i-cfg.PULLBACK_VOLUME_BARS,i);
  const baseline=bars.slice(i-cfg.PULLBACK_VOLUME_BARS-cfg.BASE_VOLUME_BARS,i-cfg.PULLBACK_VOLUME_BARS);
  if(pullback.length!==cfg.PULLBACK_VOLUME_BARS||baseline.length!==cfg.BASE_VOLUME_BARS) return reject("VOLUME_HISTORY_UNAVAILABLE",{trend});
  const pullVol=mean(pullback.map(x=>x.volume)), baseVol=mean(baseline.map(x=>x.volume));
  if(!(baseVol>0)||pullVol>baseVol*cfg.PULLBACK_VOLUME_MAX_RATIO)
    return reject("PULLBACK_VOLUME_NOT_CONTRACTING",{trend,pullbackVolume:pullVol,baselineVolume:baseVol});
  const emaLow=Math.min(fast[i],slow[i]), emaHigh=Math.max(fast[i],slow[i]);
  const latestPivot=(bullish?pivots.lows:pivots.highs).filter(p=>p.confirmedAt<i).at(-1);
  const pivotTouched=latestPivot && (bullish
    ? c.low<=latestPivot.price+a*cfg.ZONE_ATR_TOLERANCE && c.high>=latestPivot.price-a*cfg.ZONE_ATR_TOLERANCE
    : c.high>=latestPivot.price-a*cfg.ZONE_ATR_TOLERANCE && c.low<=latestPivot.price+a*cfg.ZONE_ATR_TOLERANCE);
  const emaTouched=bullish
    ? c.low<=emaHigh+a*cfg.ZONE_ATR_TOLERANCE && c.high>=emaLow-a*cfg.ZONE_ATR_TOLERANCE
    : c.high>=emaLow-a*cfg.ZONE_ATR_TOLERANCE && c.low<=emaHigh+a*cfg.ZONE_ATR_TOLERANCE;
  if(!pivotTouched&&!emaTouched) return reject("NO_SUPPORT_RESISTANCE_OR_EMA_ZONE_TOUCH",{trend,ema20:fast[i],ema50:slow[i],pivot:latestPivot});
  const range=c.high-c.low, body=range>0?Math.abs(c.close-c.open)/range:0;
  const trigger=bullish?(isBullEngulf(prev,c)||isBullPin(c,cfg.PINBAR_WICK_BODY_RATIO)):
    (isBearEngulf(prev,c)||isBearPin(c,cfg.PINBAR_WICK_BODY_RATIO));
  const strongClose=bullish?(c.close>=c.low+range*0.75):(c.close<=c.high-range*0.75);
  if(!trigger||body<cfg.MIN_TRIGGER_BODY_RATIO||!strongClose)
    return reject("REVERSAL_TRIGGER_NOT_STRONG",{trend,body,strongClose,trigger});
  const volumeBase=mean(bars.slice(i-cfg.TRIGGER_VOLUME_BARS,i).map(x=>x.volume));
  if(!(volumeBase>0)||c.volume<volumeBase*cfg.TRIGGER_VOLUME_MIN_RATIO)
    return reject("TRIGGER_VOLUME_NOT_EXPANDING",{trend,triggerVolume:c.volume,baselineVolume:volumeBase});
  const entry=c.close, direction=bullish?1:-1;
  const zoneExtreme=bullish
    ? Math.min(c.low,latestPivot?.price??c.low,emaLow)
    : Math.max(c.high,latestPivot?.price??c.high,emaHigh);
  const stop=bullish?zoneExtreme-a*cfg.STOP_ATR_BUFFER:zoneExtreme+a*cfg.STOP_ATR_BUFFER;
  const risk=direction*(entry-stop);
  if(!(risk>0)) return reject("INVALID_STOP_DISTANCE",{entry,stop});
  const targets=cfg.TARGET_R.map(r=>entry+direction*risk*r);
  if(targets[0] && direction*(targets[0]-entry)/risk<cfg.MIN_RR) return reject("RR_BELOW_MINIMUM");
  return {eligible:true,signal:{symbol,side,entry,stop,target1:targets[0],target2:targets[1],risk,riskReward:targets[0]?direction*(targets[0]-entry)/risk:null,time:c.time,score:100},
    diagnostics:{trend,ema20:fast[i],ema50:slow[i],atr:a,pullbackVolume:pullVol,baselinePullbackVolume:baseVol,
      triggerVolume:c.volume,triggerVolumeBaseline:volumeBase,zone:pivotTouched?"PIVOT":"EMA_BAND",pivot:latestPivot,
      trigger:isBullEngulf(prev,c)?"ENGULFING":isBullPin(c,cfg.PINBAR_WICK_BODY_RATIO)?"PIN_BAR":"UNKNOWN",bodyRatio:body}};
}

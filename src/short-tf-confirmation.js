const INTERVALS = { "1m": 60_000, "5m": 300_000, "15m": 900_000 };

function closedCandles(rows, interval, now) {
  if (!Array.isArray(rows)) return [];
  const seen = new Set();
  return rows
    .map(c => ({ time: Number(c.time), open: Number(c.open), high: Number(c.high), low: Number(c.low), close: Number(c.close), volume: Number(c.volume ?? 0) }))
    .filter(c => Number.isFinite(c.time) && [c.open,c.high,c.low,c.close,c.volume].every(Number.isFinite) &&
      c.open > 0 && c.low > 0 && c.high >= c.low && c.close > 0 && c.volume >= 0 &&
      c.time + interval <= now && !seen.has(c.time) && seen.add(c.time))
    .sort((a,b) => a.time-b.time);
}

function ema(values, period) {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let out = values.slice(0, period).reduce((s,v) => s+v, 0) / period;
  for (let i=period; i<values.length; i++) out = values[i]*k + out*(1-k);
  return out;
}

function atr(candles, period=14) {
  if (candles.length < period+1) return null;
  const tr=[];
  for (let i=1;i<candles.length;i++) {
    const c=candles[i], p=candles[i-1].close;
    tr.push(Math.max(c.high-c.low,Math.abs(c.high-p),Math.abs(c.low-p)));
  }
  return tr.slice(-period).reduce((s,v)=>s+v,0)/period;
}

function indicators(candles) {
  const closes=candles.map(c=>c.close);
  return { ema9:ema(closes,9), ema21:ema(closes,21), atr:atr(candles) };
}

function fail(reason, extra={}) { return { status:"WAIT", reason, ...extra }; }

/**
 * Research-only sequential entry confirmation.
 * 15m identifies a pullback zone, 5m confirms directional recovery,
 * and 1m triggers a non-chasing break. Only fully closed candles are used.
 */
export function evaluateShortTfConfirmation({
  side, candles1m, candles5m, candles15m, now=Date.now(), referencePrice=null,
  max15mAge=4, max5mWait=6, max1mWait=5, maxDriftPct=0.35
}={}) {
  if (side !== "LONG" && side !== "SHORT") return { status:"INVALID", reason:"INVALID_SIDE" };
  const c1=closedCandles(candles1m,INTERVALS["1m"],now);
  const c5=closedCandles(candles5m,INTERVALS["5m"],now);
  const c15=closedCandles(candles15m,INTERVALS["15m"],now);
  if (c15.length<40 || c5.length<40 || c1.length<40) return fail("INSUFFICIENT_CLOSED_CANDLES",{required:40,available:{m1:c1.length,m5:c5.length,m15:c15.length}});

  const last15=c15.length-1, from15=Math.max(30,last15-max15mAge+1);
  let pullback=null;
  for(let i=from15;i<=last15;i++) {
    const hist=c15.slice(0,i+1), ind=indicators(hist), c=c15[i];
    if(!ind.ema21 || !ind.atr || ind.atr<=0) continue;
    const trend=side==="LONG" ? ind.ema9>ind.ema21 : ind.ema9<ind.ema21;
    const touched=side==="LONG" ? c.low<=ind.ema21+ind.atr*0.15 : c.high>=ind.ema21-ind.atr*0.15;
    const held=side==="LONG" ? c.close>=ind.ema21-ind.atr*0.35 : c.close<=ind.ema21+ind.atr*0.35;
    if(trend&&touched&&held) pullback={index:i,time:c.time,closeTime:c.time+INTERVALS["15m"],ema21:ind.ema21,atr:ind.atr};
  }
  if(!pullback) return fail("NO_15M_PULLBACK_ZONE");

  const eligible5=c5.filter(c=>c.time>=pullback.closeTime);
  if(!eligible5.length) return fail("WAITING_5M_CONFIRMATION",{stage:"15M_PULLBACK_CONFIRMED",pullbackTime:pullback.time});
  const fiveWindow=eligible5.slice(0,max5mWait);
  let confirm5=null;
  for(const c of fiveWindow) {
    const i=c5.indexOf(c), ind=indicators(c5.slice(0,i+1));
    if(!ind.ema9||!ind.ema21) continue;
    const aligned=side==="LONG"?ind.ema9>ind.ema21:ind.ema9<ind.ema21;
    const candle=side==="LONG"?c.close>ind.ema9&&c.close>c.open:c.close<ind.ema9&&c.close<c.open;
    if(aligned&&candle) confirm5={time:c.time,closeTime:c.time+INTERVALS["5m"],close:c.close};
  }
  if(!confirm5) {
    const expired=c5[c5.length-1].time+INTERVALS["5m"] >= pullback.closeTime+max5mWait*INTERVALS["5m"];
    return fail(expired?"EXPIRED_5M_CONFIRMATION":"WAITING_5M_CONFIRMATION",{stage:"15M_PULLBACK_CONFIRMED",pullbackTime:pullback.time});
  }

  const eligible1=c1.filter(c=>c.time>=confirm5.closeTime);
  if(!eligible1.length) return fail("WAITING_1M_TRIGGER",{stage:"5M_CONFIRMED",confirmationTime:confirm5.time});
  const oneWindow=eligible1.slice(0,max1mWait);
  let trigger=null;
  for(let j=0;j<oneWindow.length;j++) {
    const c=oneWindow[j], i=c1.indexOf(c);
    if(i<1) continue;
    const ind=indicators(c1.slice(0,i+1)), prev=c1[i-1];
    if(!ind.ema9||!ind.ema21||!ind.atr||ind.atr<=0) continue;
    const aligned=side==="LONG"?ind.ema9>ind.ema21:ind.ema9<ind.ema21;
    const breakout=side==="LONG"?c.close>prev.high&&c.close>c.open:c.close<prev.low&&c.close<c.open;
    const extension=side==="LONG"?(c.close-ind.ema9)/ind.atr:(ind.ema9-c.close)/ind.atr;
    if(aligned&&breakout&&extension>=0&&extension<=0.45) trigger={time:c.time,closeTime:c.time+INTERVALS["1m"],close:c.close,atr:ind.atr,extensionAtr:extension};
  }
  if(!trigger) {
    const expired=c1[c1.length-1].time+INTERVALS["1m"] >= confirm5.closeTime+max1mWait*INTERVALS["1m"];
    return fail(expired?"EXPIRED_1M_TRIGGER":"WAITING_1M_TRIGGER",{stage:"5M_CONFIRMED",confirmationTime:confirm5.time});
  }
  const live=Number(referencePrice);
  const drift=Number.isFinite(live)&&live>0?Math.abs(live-trigger.close)/trigger.close*100:0;
  if(drift>maxDriftPct) return {status:"EXPIRED",reason:"ENTRY_TOO_FAR_NO_CHASE",driftPct:drift,triggerTime:trigger.time};
  return {status:"CONFIRMED",reason:"ALL_TIMEFRAMES_CONFIRMED",side,entryReference:trigger.close,triggerTime:trigger.time,
    pullback15mTime:pullback.time,confirmation5mTime:confirm5.time,confirmation1mTime:trigger.time,
    driftPct:drift,extensionAtr:trigger.extensionAtr,diagnostics:{closedCandles:{m1:c1.length,m5:c5.length,m15:c15.length}}};
}

export const SHORT_TF_CONFIRMATION_DEFAULTS = Object.freeze({max15mAge:4,max5mWait:6,max1mWait:5,maxDriftPct:0.35});

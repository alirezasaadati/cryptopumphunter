// Independent LONG engine: confirmed resistance breakout + retest. Experimental only.
export const BREAKOUT_RETEST_LONG_VERSION = "1.0.0";

const n = v => Number.isFinite(Number(v)) ? Number(v) : null;
function ema(values, period) {
  if (!Array.isArray(values) || values.length < period) return null;
  const k = 2 / (period + 1);
  let out = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) out = values[i] * k + out * (1 - k);
  return out;
}
function atr(candles, period = 14) {
  if (!Array.isArray(candles) || candles.length < period + 1) return null;
  const tr = [];
  for (let i = 1; i < candles.length; i++) {
    const h=n(candles[i].high), l=n(candles[i].low), pc=n(candles[i-1].close);
    if ([h,l,pc].some(x => x === null)) return null;
    tr.push(Math.max(h-l, Math.abs(h-pc), Math.abs(l-pc)));
  }
  const tail=tr.slice(-period);
  return tail.reduce((a,b)=>a+b,0)/period;
}
function validCandles(candles) {
  return Array.isArray(candles) && candles.every(c =>
    [c.open,c.high,c.low,c.close].every(v => n(v) !== null) &&
    n(c.high) >= n(c.low)
  );
}
function confirmedPivotHigh(candles, index, left=3, right=3) {
  const p=n(candles[index]?.high);
  if (p===null || index<left || index+right>=candles.length) return false;
  for(let j=index-left;j<=index+right;j++) {
    if(j!==index && n(candles[j].high)>=p) return false;
  }
  return true;
}
function avgVolume(candles, endExclusive, period=20) {
  const rows=candles.slice(Math.max(0,endExclusive-period),endExclusive);
  const vals=rows.map(c=>n(c.volume)).filter(v=>v!==null && v>=0);
  return vals.length===period ? vals.reduce((a,b)=>a+b,0)/period : null;
}

/**
 * candles15m must contain CLOSED candles only, oldest first.
 * Trend confirmation uses closed 1h and 4h candles.
 */
export function analyzeBreakoutRetestLong({symbol,candles15m,candles1h,candles4h,options={}}) {
  const cfg={
    pivotLeft:3,pivotRight:3,maxRetestBars:8,breakoutLookback:16,
    breakoutBufferAtr:0.10,retestToleranceAtr:0.25,
    maxExtensionAtr:0.75,minVolumeRatio:1.0,
    stopBufferAtr:0.10,minStopPct:0.20,maxStopPct:1.50,
    rewardRisk:2,...options
  };
  const reject=(reason,extra={})=>({symbol,side:"LONG",eligible:false,reason,...extra});
  if(!validCandles(candles15m)||!validCandles(candles1h)||!validCandles(candles4h))
    return reject("invalid_or_missing_candles");
  if(candles15m.length<60||candles1h.length<60||candles4h.length<60)
    return reject("insufficient_history");
  const closes1h=candles1h.map(c=>n(c.close));
  const closes4h=candles4h.map(c=>n(c.close));
  const e20_1h=ema(closes1h,20),e50_1h=ema(closes1h,50);
  const e20_4h=ema(closes4h,20),e50_4h=ema(closes4h,50);
  if(![e20_1h,e50_1h,e20_4h,e50_4h].every(Number.isFinite))
    return reject("trend_data_unavailable");
  if(!(e20_1h>e50_1h && closes1h.at(-1)>e20_1h && e20_4h>e50_4h))
    return reject("higher_timeframe_uptrend_not_confirmed",{trend:{e20_1h,e50_1h,e20_4h,e50_4h}});
  const a=atr(candles15m,14);
  if(!Number.isFinite(a)||a<=0) return reject("atr_unavailable");
  const last=candles15m.at(-1), entry=n(last.close), lastIndex=candles15m.length-1;
  if(!(entry>n(last.open))) return reject("retest_confirmation_not_bullish");
  const start=Math.max(cfg.pivotLeft+cfg.pivotRight+1,lastIndex-cfg.breakoutLookback-cfg.maxRetestBars-2);
  let setup=null;
  // Search chronologically; the latest valid breakout followed by a retest wins.
  for(let p=start;p<lastIndex-cfg.pivotRight-1;p++) {
    if(!confirmedPivotHigh(candles15m,p,cfg.pivotLeft,cfg.pivotRight)) continue;
    const level=n(candles15m[p].high);
    const breakoutStart=p+cfg.pivotRight+1;
    const breakoutEnd=Math.min(lastIndex-1,breakoutStart+cfg.breakoutLookback);
    for(let b=breakoutStart;b<=breakoutEnd;b++) {
      const bc=candles15m[b], bclose=n(bc.close);
      if(!(bclose>level+a*cfg.breakoutBufferAtr)) continue;
      const av=avgVolume(candles15m,b,20), bv=n(bc.volume);
      const vr=av>0&&bv!==null?bv/av:null;
      if(vr!==null && vr<cfg.minVolumeRatio) continue;
      const retestIndex=lastIndex;
      const barsAfter=retestIndex-b;
      if(barsAfter<1||barsAfter>cfg.maxRetestBars) continue;
      const tol=a*cfg.retestToleranceAtr;
      if(n(last.low)>level+tol || entry<level || entry-level>a*cfg.maxExtensionAtr) continue;
      // No intervening close may invalidate the broken resistance before the final retest.
      let invalid=false;
      for(let k=b+1;k<lastIndex;k++) if(n(candles15m[k].close)<level-tol){invalid=true;break;}
      if(invalid) continue;
      setup={level,pivotIndex:p,breakoutIndex:b,barsAfter,volumeRatio:vr};
    }
  }
  if(!setup) return reject("no_confirmed_breakout_retest");
  const stopBase=Math.min(n(last.low),setup.level);
  const stop=stopBase-a*cfg.stopBufferAtr;
  const riskPct=(entry-stop)/entry*100;
  if(!(riskPct>=cfg.minStopPct&&riskPct<=cfg.maxStopPct))
    return reject("stop_distance_out_of_range",{setup,riskPct,entry,stop});
  const target=entry+(entry-stop)*cfg.rewardRisk;
  return {
    symbol,side:"LONG",eligible:true,version:BREAKOUT_RETEST_LONG_VERSION,
    entry,stop,target,rewardRisk:cfg.rewardRisk,riskPct,
    score:100,setup:{
      resistance:setup.level,pivotIndex:setup.pivotIndex,breakoutIndex:setup.breakoutIndex,
      barsFromBreakout:setup.barsAfter,volumeRatio:setup.volumeRatio,
      atr:a,confirmationClose:entry
    },
    trend:{e20_1h,e50_1h,e20_4h,e50_4h}
  };
}

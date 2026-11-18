// Causal Elliott-style wave-3 breakout detector.
// Only confirmed swing pivots are used; a pivot is unavailable until rightBars close.
export const ELLIOTT_DEFAULTS=Object.freeze({
  leftBars:3,rightBars:3,minRetracement:0.236,maxRetracement:0.786,
  maxBarsAfterWave2:48,minWave1Pct:0.003,maxWave1Pct:0.12,
  targetsR:[1,1.618,2.618],targetWeights:[0.4,0.35,0.25],maxHoldBars:192
});
const valid=c=>c&&[c.time,c.open,c.high,c.low,c.close].every(Number.isFinite)&&c.open>0&&c.low>0&&c.high>=Math.max(c.open,c.close)&&c.low<=Math.min(c.open,c.close);
function pivotAt(candles,center,left,right){
  const p=candles[center];let isHigh=true,isLow=true;
  for(let j=center-left;j<=center+right;j++){
    if(j===center)continue;
    if(candles[j].high>=p.high)isHigh=false;
    if(candles[j].low<=p.low)isLow=false;
  }
  if(isHigh===isLow)return null;
  return {type:isHigh?"H":"L",index:center,price:isHigh?p.high:p.low,time:p.time,confirmedAt:center+right};
}
function appendPivot(pivots,p){
  if(!p)return;
  const last=pivots.at(-1);
  if(last&&last.type===p.type){
    const moreExtreme=p.type==="H"?p.price>last.price:p.price<last.price;
    if(moreExtreme)pivots[pivots.length-1]=p;
    return;
  }
  pivots.push(p);
  if(pivots.length>12)pivots.shift();
}
function setupFromLastThree(pivots,opts){
  if(pivots.length<3)return null;
  const [a,b,c]=pivots.slice(-3);
  if(!(a.index<b.index&&b.index<c.index))return null;
  if(a.type==="L"&&b.type==="H"&&c.type==="L"){
    const wave1=b.price-a.price, retrace=(b.price-c.price)/wave1;
    if(wave1<=0||c.price<=a.price||wave1/a.price<opts.minWave1Pct||wave1/a.price>opts.maxWave1Pct||
      retrace<opts.minRetracement||retrace>opts.maxRetracement)return null;
    return {side:"LONG",wave1Start:a.price,wave1End:b.price,wave2End:c.price,trigger:b.price,stop:c.price,
      wave1Pct:wave1/a.price,retracement,setupPivotIndex:c.index,confirmedAt:c.confirmedAt};
  }
  if(a.type==="H"&&b.type==="L"&&c.type==="H"){
    const wave1=a.price-b.price, retrace=(c.price-b.price)/wave1;
    if(wave1<=0||c.price>=a.price||wave1/a.price<opts.minWave1Pct||wave1/a.price>opts.maxWave1Pct||
      retrace<opts.minRetracement||retrace>opts.maxRetracement)return null;
    return {side:"SHORT",wave1Start:a.price,wave1End:b.price,wave2End:c.price,trigger:b.price,stop:c.price,
      wave1Pct:wave1/a.price,retracement,setupPivotIndex:c.index,confirmedAt:c.confirmedAt};
  }
  return null;
}
export function validateWaveCandles(candles){
  if(!Array.isArray(candles)||candles.length<20)return false;
  for(let i=0;i<candles.length;i++)if(!valid(candles[i])||(i&&candles[i].time<=candles[i-1].time))return false;
  return true;
}
export function detectElliottWaveSignals(candles,options={}){
  const opts={...ELLIOTT_DEFAULTS,...options};
  const {leftBars,rightBars}=opts;
  if(!Array.isArray(candles)||leftBars<1||rightBars<1||candles.length<leftBars+rightBars+5)return [];
  const pivots=[],signals=[],usedSetups=new Set();
  for(let i=leftBars+rightBars;i<candles.length;i++){
    const center=i-rightBars;
    const p=pivotAt(candles,center,leftBars,rightBars);
    appendPivot(pivots,p);
    const setup=setupFromLastThree(pivots,opts);
    if(!setup||i<setup.confirmedAt||i-setup.confirmedAt>opts.maxBarsAfterWave2)continue;
    if(usedSetups.has(setup.setupPivotIndex))continue;
    const bar=candles[i];
    const broke=setup.side==="LONG"?bar.close>setup.trigger:bar.close<setup.trigger;
    if(!broke)continue;
    const risk=setup.side==="LONG"?bar.close-setup.stop:setup.stop-bar.close;
    const riskPct=risk/bar.close;
    if(!(risk>0)||riskPct<opts.minWave1Pct/3||riskPct>0.06)continue;
    signals.push({side:setup.side,pattern:"wave3_breakout",signalIndex:i,signalTime:bar.time,
      stop:setup.stop,trigger:setup.trigger,setupPivotIndex:setup.setupPivotIndex,
      wave1Pct:setup.wave1Pct,retracement:setup.retracement,confirmedAt:setup.confirmedAt});
    usedSetups.add(setup.setupPivotIndex);
  }
  return signals;
}

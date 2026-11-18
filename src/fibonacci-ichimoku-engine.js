// Fibonacci pullback + Ichimoku trend-confirmation signal engine.
// All pivots are confirmed only after rightBars candles close. Cloud values are
// aligned to the cloud visible at the current candle (26-bar displacement).
export const FIB_ICHIMOKU_DEFAULTS=Object.freeze({
  leftBars:3,rightBars:3,
  fibMin:0.382,fibMax:0.618,
  tenkanPeriod:9,kijunPeriod:26,senkouBPeriod:52,displacement:26,
  minImpulsePct:0.004,maxImpulsePct:0.15,
  maxBarsAfterPullback:32,
  targetsR:[1,1.5,2.5],targetWeights:[0.4,0.35,0.25],
  maxHoldBars:192
});
const valid=c=>c&&[c.time,c.open,c.high,c.low,c.close].every(Number.isFinite)&&c.open>0&&c.low>0&&c.high>=Math.max(c.open,c.close)&&c.low<=Math.min(c.open,c.close);
export function validateFibIchimokuCandles(bars){
  if(!Array.isArray(bars)||bars.length<80)return false;
  for(let i=0;i<bars.length;i++)if(!valid(bars[i])||(i&&bars[i].time<=bars[i-1].time))return false;
  return true;
}
function midRange(bars,end,period){
  if(end-period+1<0)return null;
  let hi=-Infinity,lo=Infinity;
  for(let i=end-period+1;i<=end;i++){hi=Math.max(hi,bars[i].high);lo=Math.min(lo,bars[i].low);}
  return (hi+lo)/2;
}
export function ichimokuAt(bars,index,opts={}){
  const p={...FIB_ICHIMOKU_DEFAULTS,...opts};
  const tenkan=midRange(bars,index,p.tenkanPeriod),kijun=midRange(bars,index,p.kijunPeriod);
  const source=index-p.displacement;
  if(tenkan===null||kijun===null||source<0)return null;
  const spanA=(midRange(bars,source,p.tenkanPeriod)+midRange(bars,source,p.kijunPeriod))/2;
  const spanB=midRange(bars,source,p.senkouBPeriod);
  if(!Number.isFinite(spanA)||!Number.isFinite(spanB))return null;
  return {tenkan,kijun,spanA,spanB,cloudTop:Math.max(spanA,spanB),cloudBottom:Math.min(spanA,spanB)};
}
function pivotAt(bars,center,left,right){
  const c=bars[center];let high=true,low=true;
  for(let j=center-left;j<=center+right;j++){if(j===center)continue;if(bars[j].high>=c.high)high=false;if(bars[j].low<=c.low)low=false;}
  if(high===low)return null;
  return {type:high?"H":"L",index:center,price:high?c.high:c.low,confirmedAt:center+right};
}
function appendPivot(list,p){
  if(!p)return;
  const last=list.at(-1);
  if(last&&last.type===p.type){if(p.type==="H"?p.price>last.price:p.price<last.price)list[list.length-1]=p;return;}
  list.push(p);if(list.length>10)list.shift();
}
function fibSetup(pivots,opts){
  if(pivots.length<3)return null;
  const [a,b,c]=pivots.slice(-3);
  if(!(a.index<b.index&&b.index<c.index))return null;
  if(a.type==="L"&&b.type==="H"&&c.type==="L"){
    const impulse=b.price-a.price,retrace=(b.price-c.price)/impulse;
    if(impulse<=0||c.price<=a.price||impulse/a.price<opts.minImpulsePct||impulse/a.price>opts.maxImpulsePct||retrace<opts.fibMin||retrace>opts.fibMax)return null;
    return {side:"LONG",start:a.price,end:b.price,pullback:c.price,stop:c.price,impulse,retrace,pivotIndex:c.index,confirmedAt:c.confirmedAt,fib382:b.price-impulse*.382,fib50:b.price-impulse*.5,fib618:b.price-impulse*.618};
  }
  if(a.type==="H"&&b.type==="L"&&c.type==="H"){
    const impulse=a.price-b.price,retrace=(c.price-b.price)/impulse;
    if(impulse<=0||c.price>=a.price||impulse/a.price<opts.minImpulsePct||impulse/a.price>opts.maxImpulsePct||retrace<opts.fibMin||retrace>opts.fibMax)return null;
    return {side:"SHORT",start:a.price,end:b.price,pullback:c.price,stop:c.price,impulse,retrace,pivotIndex:c.index,confirmedAt:c.confirmedAt,fib382:b.price+impulse*.382,fib50:b.price+impulse*.5,fib618:b.price+impulse*.618};
  }
  return null;
}
export function detectFibIchimokuSignals(bars,options={}){
  const o={...FIB_ICHIMOKU_DEFAULTS,...options};
  if(!Array.isArray(bars)||bars.length<Math.max(o.senkouBPeriod+o.displacement,o.leftBars+o.rightBars+10))return [];
  const pivots=[],signals=[],used=new Set();
  for(let i=o.leftBars+o.rightBars;i<bars.length;i++){
    const p=pivotAt(bars,i-o.rightBars,o.leftBars,o.rightBars);appendPivot(pivots,p);
    const s=fibSetup(pivots,o);
    if(!s||i<s.confirmedAt||i-s.confirmedAt>o.maxBarsAfterPullback||used.has(s.pivotIndex))continue;
    const ichi=ichimokuAt(bars,i,o),prev=ichimokuAt(bars,i-1,o);
    if(!ichi||!prev)continue;
    const bar=bars[i],prior=bars[i-1];
    const cloudBull=bar.close>ichi.cloudTop&&ichi.tenkan>ichi.kijun;
    const cloudBear=bar.close<ichi.cloudBottom&&ichi.tenkan<ichi.kijun;
    const triggerBull=prior.close<=prev.tenkan&&bar.close>ichi.tenkan&&bar.close>bar.open;
    const triggerBear=prior.close>=prev.tenkan&&bar.close<ichi.tenkan&&bar.close<bar.open;
    const ok=s.side==="LONG"?cloudBull&&triggerBull:cloudBear&&triggerBear;
    if(!ok)continue;
    const risk=s.side==="LONG"?bar.close-s.stop:s.stop-bar.close,riskPct=risk/bar.close;
    if(!(risk>0)||riskPct<0.001||riskPct>0.06)continue;
    signals.push({side:s.side,pattern:"fib_ichimoku_pullback",signalIndex:i,signalTime:bar.time,entryReference:bar.close,stop:s.stop,
      fibRetracement:s.retrace,fib382:s.fib382,fib50:s.fib50,fib618:s.fib618,
      tenkan:ichi.tenkan,kijun:ichi.kijun,cloudTop:ichi.cloudTop,cloudBottom:ichi.cloudBottom,
      setupPivotIndex:s.pivotIndex,confirmedAt:s.confirmedAt});
    used.add(s.pivotIndex);
  }
  return signals;
}

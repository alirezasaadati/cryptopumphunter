// Independent LONG/SHORT signal engines for experimental historical testing.
// Uses only candles supplied by the caller; callers must pass completed candles only.
// Structure pivots are confirmed with right-side bars, preventing look-ahead.
function finite(n) { return Number.isFinite(Number(n)); }
function pivotAt(candles, index, field, left=2, right=2) {
  if (index < left || index + right >= candles.length) return false;
  const v=Number(candles[index]?.[field]);
  if(!finite(v)) return false;
  for(let j=index-left;j<=index+right;j++){
    if(j===index)continue;
    const x=Number(candles[j]?.[field]);
    if(!finite(x) || (field==="high" ? x>=v : x<=v)) return false;
  }
  return true;
}
function confirmedPivots(candles, field, left=2, right=2) {
  const out=[];
  for(let i=left;i<candles.length-right;i++) if(pivotAt(candles,i,field,left,right)) out.push({index:i,price:Number(candles[i][field]),time:candles[i].time});
  return out;
}
function atr(candles, period=14) {
  if(candles.length<period+1)return null;
  const ranges=[];
  for(let i=1;i<candles.length;i++){
    const c=candles[i],p=candles[i-1];
    ranges.push(Math.max(Number(c.high)-Number(c.low),Math.abs(Number(c.high)-Number(p.close)),Math.abs(Number(c.low)-Number(p.close))));
  }
  const tail=ranges.slice(-period);
  return tail.reduce((a,b)=>a+b,0)/tail.length;
}
function dmi(candles, period=14) {
  if(candles.length<period*2+1)return null;
  const tr=[], plus=[], minus=[];
  for(let i=1;i<candles.length;i++){
    const c=candles[i],p=candles[i-1],up=Number(c.high)-Number(p.high),down=Number(p.low)-Number(c.low);
    tr.push(Math.max(Number(c.high)-Number(c.low),Math.abs(Number(c.high)-Number(p.close)),Math.abs(Number(c.low)-Number(p.close))));
    plus.push(up>down&&up>0?up:0); minus.push(down>up&&down>0?down:0);
  }
  const smooth=a=>{let s=a.slice(0,period).reduce((x,y)=>x+y,0);const out=[s];for(let i=period;i<a.length;i++){s=s-s/period+a[i];out.push(s);}return out;};
  const t=smooth(tr),p=smooth(plus),m=smooth(minus),dx=[];
  for(let i=0;i<t.length;i++){const pd=t[i]?100*p[i]/t[i]:0,md=t[i]?100*m[i]/t[i]:0;dx.push(pd+md?100*Math.abs(pd-md)/(pd+md):0);}
  const adx=dx.slice(-period).reduce((a,b)=>a+b,0)/Math.min(period,dx.length);
  const last=t.length-1;
  return {adx,plusDI:t[last]?100*p[last]/t[last]:0,minusDI:t[last]?100*m[last]/t[last]:0};
}
function structureTrend(candles, side) {
  const highs=confirmedPivots(candles,"high").slice(-2), lows=confirmedPivots(candles,"low").slice(-2);
  if(highs.length<2||lows.length<2)return false;
  const hh=highs[1].price>highs[0].price, hl=lows[1].price>lows[0].price;
  const lh=highs[1].price<highs[0].price, ll=lows[1].price<lows[0].price;
  const strength=dmi(candles);
  if(!strength||strength.adx<16)return false;
  return side==="LONG" ? hh&&hl&&strength.plusDI>strength.minusDI : lh&&ll&&strength.minusDI>strength.plusDI;
}
function detectSweepReclaim(candles, side, lookback=12) {
  if(candles.length<lookback+10)return null;
  const lastIndex=candles.length-1,last=candles[lastIndex];
  // A sweep/reclaim may happen first; the structure break is allowed to confirm
  // on a later completed candle (within the following eight bars).
  const firstSweep=Math.max(lookback,lastIndex-8);
  let setup=null;
  for(let k=firstSweep;k<lastIndex;k++){
    const sweptBar=candles[k],prior=candles.slice(Math.max(0,k-lookback),k);
    if(prior.length<lookback)continue;
    const level=side==="LONG"?Math.min(...prior.map(c=>Number(c.low))):Math.max(...prior.map(c=>Number(c.high)));
    const swept=side==="LONG"?Number(sweptBar.low)<level&&Number(sweptBar.close)>level:Number(sweptBar.high)>level&&Number(sweptBar.close)<level;
    if(!swept)continue;
    const pivots=confirmedPivots(candles.slice(0,k),side==="LONG"?"high":"low");
    const pivot=pivots.at(-1);
    if(!pivot)continue;
    const structureBreak=side==="LONG"?Number(last.close)>pivot.price:Number(last.close)<pivot.price;
    if(!structureBreak)continue;
    const range=Number(last.high)-Number(last.low),body=Math.abs(Number(last.close)-Number(last.open));
    const directionalClose=side==="LONG"
      ? Number(last.close)>=Number(last.low)+range*0.60
      : Number(last.close)<=Number(last.high)-range*0.60;
    if(!directionalClose||!range||body/range<0.30)continue;
    setup={level,sweepExtreme:side==="LONG"?Number(sweptBar.low):Number(sweptBar.high),pivotPrice:pivot.price,sweepTime:sweptBar.time,confirmationTime:last.time};
  }
  return setup;
}
export function analyzeIndependentSignal({side,candles4h,candles15m}) {
  if(!["LONG","SHORT"].includes(side)||!Array.isArray(candles4h)||!Array.isArray(candles15m))return null;
  if(!structureTrend(candles4h,side))return null;
  const setup=detectSweepReclaim(candles15m,side);
  if(!setup)return null;
  const volatility=atr(candles15m);
  const entry=Number(candles15m.at(-1).close);
  if(!finite(volatility)||volatility<=0||!finite(entry)||entry<=0)return null;
  const buffer=volatility*0.2;
  const stop=side==="LONG"?setup.sweepExtreme-buffer:setup.sweepExtreme+buffer;
  const stopDistancePct=Math.abs((entry-stop)/entry)*100;
  if((side==="LONG"&&stop>=entry)||(side==="SHORT"&&stop<=entry)||stopDistancePct<=0||stopDistancePct>8)return null;
  return {side,entry,stop,score:70,stopDistancePct,engine:"independent-structure-sweep-v1",setup};
}
export const INDEPENDENT_SIGNAL_ENGINE_VERSION="1.0.0";

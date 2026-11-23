// Independent, testable Al Brooks-inspired price-action engine.
// This is an operational approximation of publicly described concepts, not a claim
// to reproduce proprietary course material or discretionary human judgment.
export const BROOKS_CONFIG = Object.freeze({
  emaFast: 20, emaSlow: 50, atrPeriod: 14, trendLookback: 8,
  pivotLeft: 2, pivotRight: 2, setupLookback: 18,
  minSignalBodyPct: 0.42, closeExtremePct: 0.28,
  stopAtrBuffer: 0.12, minRiskAtr: 0.15, maxRiskAtr: 2.5,
  minScore: 58, targetR: 1.5, failedBreakoutLookback: 20
});

const n = v => Number(v);
const valid = c => c && [c.open,c.high,c.low,c.close].every(v=>Number.isFinite(n(v))) &&
  n(c.high)>=Math.max(n(c.open),n(c.close),n(c.low)) && n(c.low)<=Math.min(n(c.open),n(c.close));
export function ema(values, period) {
  if(!Array.isArray(values)||values.length<period||!values.every(Number.isFinite))return null;
  const k=2/(period+1); let v=values.slice(0,period).reduce((a,b)=>a+b,0)/period;
  for(let i=period;i<values.length;i++)v=values[i]*k+v*(1-k);
  return v;
}
export function atr(candles, period=BROOKS_CONFIG.atrPeriod) {
  if(!Array.isArray(candles)||candles.length<period+1)return null;
  const tr=[];
  for(let i=1;i<candles.length;i++){
    const c=candles[i],p=candles[i-1];
    tr.push(Math.max(n(c.high)-n(c.low),Math.abs(n(c.high)-n(p.close)),Math.abs(n(c.low)-n(p.close))));
  }
  const tail=tr.slice(-period); return tail.reduce((a,b)=>a+b,0)/tail.length;
}
export function classifyBar(c) {
  if(!valid(c))return null;
  const range=n(c.high)-n(c.low), body=Math.abs(n(c.close)-n(c.open));
  if(range<=0)return {direction:"DOJI",bodyPct:0,closeLocation:0.5,upperTail:0,lowerTail:0};
  const closeLocation=(n(c.close)-n(c.low))/range;
  const upperTail=(n(c.high)-Math.max(n(c.open),n(c.close)))/range;
  const lowerTail=(Math.min(n(c.open),n(c.close))-n(c.low))/range;
  const bodyPct=body/range;
  return {direction:n(c.close)>n(c.open)?"BULL":n(c.close)<n(c.open)?"BEAR":"DOJI",bodyPct,closeLocation,upperTail,lowerTail,
    strongBull:n(c.close)>n(c.open)&&bodyPct>=BROOKS_CONFIG.minSignalBodyPct&&closeLocation>=1-BROOKS_CONFIG.closeExtremePct,
    strongBear:n(c.close)<n(c.open)&&bodyPct>=BROOKS_CONFIG.minSignalBodyPct&&closeLocation<=BROOKS_CONFIG.closeExtremePct};
}
function pivotIndices(candles,kind,left=2,right=2) {
  const out=[];
  for(let i=left;i<candles.length-right;i++){
    const v=n(candles[i][kind]); let ok=true;
    for(let j=i-left;j<=i+right;j++){if(j===i)continue;const x=n(candles[j][kind]);if(kind==="low"?x<v:x>v){ok=false;break;}}
    if(ok)out.push(i);
  }
  return out;
}
export function marketContext(candles) {
  if(!Array.isArray(candles)||candles.length<60)return {state:"UNKNOWN",trend:"UNKNOWN",ema20:null,ema50:null,atr:null};
  const closes=candles.map(c=>n(c.close)), e20=ema(closes.slice(-100),20), e50=ema(closes.slice(-120),50), a=atr(candles);
  const prev20=ema(closes.slice(-100,-8),20);
  const slope=e20&&prev20?(e20-prev20)/prev20:0;
  const highs=pivotIndices(candles.slice(-30),"high",2,2), lows=pivotIndices(candles.slice(-30),"low",2,2);
  const hh=highs.length>=2&&n(candles.slice(-30)[highs.at(-1)].high)>n(candles.slice(-30)[highs.at(-2)].high);
  const hl=lows.length>=2&&n(candles.slice(-30)[lows.at(-1)].low)>n(candles.slice(-30)[lows.at(-2)].low);
  const lh=highs.length>=2&&n(candles.slice(-30)[highs.at(-1)].high)<n(candles.slice(-30)[highs.at(-2)].high);
  const ll=lows.length>=2&&n(candles.slice(-30)[lows.at(-1)].low)<n(candles.slice(-30)[lows.at(-2)].low);
  let trend="RANGE";
  if(n(candles.at(-1).close)>e20&&e20>e50&&slope>0&&hh&&hl)trend="BULL";
  if(n(candles.at(-1).close)<e20&&e20<e50&&slope<0&&lh&&ll)trend="BEAR";
  return {state:trend==="RANGE"?"TRADING_RANGE":"TREND",trend,ema20:e20,ema50:e50,ema20SlopePct:slope*100,atr:a,higherHighs:hh,higherLows:hl,lowerHighs:lh,lowerLows:ll};
}
function recentPullbackLegs(candles,trend) {
  const start=Math.max(0,candles.length-BROOKS_CONFIG.setupLookback), sample=candles.slice(start,-1);
  const pivots=pivotIndices(sample,trend==="BULL"?"low":"high",2,2);
  if(!pivots.length)return 0;
  // Count distinct pullback pivots; the last confirmed pivot is the most recent completed leg.
  return Math.min(3,pivots.filter(i=>i>=sample.length-14).length);
}
function findSetup(candles,ctx) {
  const last=candles.at(-1), prev=candles.at(-2), bar=classifyBar(last);
  const sideTrend=ctx.trend;
  const prior=candles.slice(-BROOKS_CONFIG.failedBreakoutLookback-1,-1);
  const priorHigh=Math.max(...prior.map(c=>n(c.high))), priorLow=Math.min(...prior.map(c=>n(c.low)));
  // Failed breakout: excursion beyond a well-defined recent extreme, then close back inside.
  if(n(last.high)>priorHigh&&n(last.close)<priorHigh&&bar.direction==="BEAR"&&bar.closeLocation<0.45)
    return {side:"SHORT",setup:"FAILED_BREAKOUT_HIGH",bar,reference:priorHigh,context:"REVERSAL"};
  if(n(last.low)<priorLow&&n(last.close)>priorLow&&bar.direction==="BULL"&&bar.closeLocation>0.55)
    return {side:"LONG",setup:"FAILED_BREAKOUT_LOW",bar,reference:priorLow,context:"REVERSAL"};
  if(sideTrend==="BULL"&&bar.strongBull&&n(last.close)>n(prev.high)){
    const legs=recentPullbackLegs(candles,"BULL");
    if(legs>=2)return {side:"LONG",setup:"H2_CONTINUATION",bar,reference:n(prev.high),context:"WITH_TREND"};
    if(legs===1)return {side:"LONG",setup:"H1_CONTINUATION",bar,reference:n(prev.high),context:"WITH_TREND"};
  }
  if(sideTrend==="BEAR"&&bar.strongBear&&n(last.close)<n(prev.low)){
    const legs=recentPullbackLegs(candles,"BEAR");
    if(legs>=2)return {side:"SHORT",setup:"L2_CONTINUATION",bar,reference:n(prev.low),context:"WITH_TREND"};
    if(legs===1)return {side:"SHORT",setup:"L1_CONTINUATION",bar,reference:n(prev.low),context:"WITH_TREND"};
  }
  // Three-push wedge approximation: three successively more extreme confirmed pivots.
  const highs=pivotIndices(candles.slice(-30),"high",2,2), lows=pivotIndices(candles.slice(-30),"low",2,2);
  if(bar.direction==="BEAR"&&highs.length>=3){
    const p=highs.slice(-3).map(i=>n(candles.slice(-30)[i].high));
    if(p[1]>p[0]&&p[2]>p[1]&&(p[2]-p[1])<(p[1]-p[0])*1.35)
      return {side:"SHORT",setup:"WEDGE_TOP",bar,reference:p[2],context:"REVERSAL"};
  }
  if(bar.direction==="BULL"&&lows.length>=3){
    const p=lows.slice(-3).map(i=>n(candles.slice(-30)[i].low));
    if(p[1]<p[0]&&p[2]<p[1]&&(p[1]-p[2])<(p[0]-p[1])*1.35)
      return {side:"LONG",setup:"WEDGE_BOTTOM",bar,reference:p[2],context:"REVERSAL"};
  }
  return null;
}
export function scoreSetup(setup,context) {
  if(!setup||!context)return 0;
  let score=35;
  if(setup.context==="WITH_TREND"&&((setup.side==="LONG"&&context.trend==="BULL")||(setup.side==="SHORT"&&context.trend==="BEAR")))score+=25;
  if(setup.context==="REVERSAL")score+=context.trend==="RANGE"?12:8;
  if(setup.bar?.bodyPct>=0.6)score+=12;
  if(setup.side==="LONG"&&setup.bar?.closeLocation>=0.8)score+=8;
  if(setup.side==="SHORT"&&setup.bar?.closeLocation<=0.2)score+=8;
  if(context.atr&&setup.riskDistance) {
    const rr=setup.riskDistance/context.atr;
    if(rr>=0.25&&rr<=1.5)score+=8;
  }
  return Math.min(100,score);
}
export function analyzeBrooksPriceAction(candles,options={}) {
  const cfg={...BROOKS_CONFIG,...options};
  if(!Array.isArray(candles)||candles.length<Math.max(60,cfg.emaSlow+10)||!candles.every(valid))return null;
  const context=marketContext(candles), raw=findSetup(candles,context);
  if(!raw||!context.atr||context.atr<=0)return null;
  const last=candles.at(-1), side=raw.side;
  const entryTrigger=side==="LONG"?n(last.high):n(last.low);
  const stop=side==="LONG"?n(last.low)-cfg.stopAtrBuffer*context.atr:n(last.high)+cfg.stopAtrBuffer*context.atr;
  const riskDistance=side==="LONG"?entryTrigger-stop:stop-entryTrigger;
  const riskAtr=riskDistance/context.atr;
  if(!(riskDistance>0)||riskAtr<cfg.minRiskAtr||riskAtr>cfg.maxRiskAtr)return null;
  const setup={...raw,entryTrigger,stop,riskDistance};
  const score=scoreSetup(setup,context);
  if(score<cfg.minScore)return null;
  const target=side==="LONG"?entryTrigger+cfg.targetR*riskDistance:entryTrigger-cfg.targetR*riskDistance;
  return {engine:"AL_BROOKS_INSPIRED_V1",side,setup:raw.setup,context:context.trend,contextState:context.state,
    signalTime:last.time??null,signalHigh:n(last.high),signalLow:n(last.low),entryTrigger,stop,target,targetR:cfg.targetR,
    riskDistance,riskAtr,score,bar:raw.bar,marketContext:context};
}

import {detectFibIchimokuSignals,ichimokuAt} from "./fibonacci-ichimoku-engine.js";

export function aggregateCandles(bars, minutes) {
  const span=minutes*60_000, groups=new Map();
  for(const b of bars){
    const t=Math.floor(b.time/span)*span;
    let g=groups.get(t);
    if(!g){g={time:t,open:b.open,high:b.high,low:b.low,close:b.close,volume:b.volume||0,count:0};groups.set(t,g);}
    else {g.high=Math.max(g.high,b.high);g.low=Math.min(g.low,b.low);g.close=b.close;g.volume+=(b.volume||0);}
    g.count++;
  }
  return [...groups.values()].sort((a,b)=>a.time-b.time).filter(g=>g.count===minutes/15);
}
function alignedHigherTrend(htf, time, side, minutes) {
  let lo=0,hi=htf.length-1,idx=-1;
  while(lo<=hi){const m=(lo+hi)>>1;if(htf[m].time+minutes*60_000<=time){idx=m;lo=m+1;}else hi=m-1;}
  if(idx<80)return false;
  const v=ichimokuAt(htf,idx),b=htf[idx];
  if(!v)return false;
  return side==="LONG"?b.close>v.cloudTop&&v.tenkan>v.kijun:b.close<v.cloudBottom&&v.tenkan<v.kijun;
}
function strongCloud(bars, signal, side) {
  const i=signal.signalIndex,cur=ichimokuAt(bars,i),old=ichimokuAt(bars,i-5);
  if(!cur||!old)return false;
  const price=bars[i].close,thickness=(cur.cloudTop-cur.cloudBottom)/price;
  const kijunSlope=(cur.kijun-old.kijun)/old.kijun;
  const cloudSlope=(cur.spanA-old.spanA)/old.spanA;
  return thickness>=0.0015 && (side==="LONG"
    ? kijunSlope>0.001&&cloudSlope>0&&cur.spanA>cur.spanB
    : kijunSlope<-.001&&cloudSlope<0&&cur.spanA<cur.spanB);
}
function priorCloudBreakout(bars, signal, side) {
  const pivot=signal.setupPivotIndex, end=signal.signalIndex;
  let found=-1;
  for(let i=Math.max(80,pivot+1);i<end;i++){
    const now=ichimokuAt(bars,i),prev=ichimokuAt(bars,i-1);
    if(!now||!prev)continue;
    const broke=side==="LONG"
      ? bars[i].close>now.cloudTop&&bars[i-1].close<=prev.cloudTop
      : bars[i].close<now.cloudBottom&&bars[i-1].close>=prev.cloudBottom;
    if(broke)found=i;
  }
  return found>pivot && found<end && end-found<=64;
}
export function detectFibIchimokuStrategySignals(bars, mode="A", options={}) {
  const base=detectFibIchimokuSignals(bars,options);
  if(mode==="A")return base.filter(s=>strongCloud(bars,s,s.side));
  if(mode==="B")return base.filter(s=>priorCloudBreakout(bars,s,s.side));
  if(mode==="C"){
    const h1=aggregateCandles(bars,60),h4=aggregateCandles(bars,240);
    return base.filter(s=>alignedHigherTrend(h1,s.signalTime,s.side,60)&&alignedHigherTrend(h4,s.signalTime,s.side,240));
  }
  throw new Error("Unknown strategy mode: "+mode);
}

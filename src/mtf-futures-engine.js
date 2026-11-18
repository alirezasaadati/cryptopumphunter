// Independent 4H / 1H / 15m futures signal engine. Closed candles only.
export function ema(values, period) {
  if (!Array.isArray(values) || values.length < period) return null;
  const k=2/(period+1); let v=values.slice(0,period).reduce((a,b)=>a+b,0)/period;
  for(let i=period;i<values.length;i++) v=values[i]*k+v*(1-k);
  return v;
}
export function atr(candles,period=14){
  if(!Array.isArray(candles)||candles.length<=period)return null;
  const r=[];for(let i=1;i<candles.length;i++){const c=candles[i],p=candles[i-1].close;r.push(Math.max(c.high-c.low,Math.abs(c.high-p),Math.abs(c.low-p)));}
  const x=r.slice(-period);return x.length===period?x.reduce((a,b)=>a+b,0)/period:null;
}
function trend(c){
  if(!Array.isArray(c)||c.length<55)return "NEUTRAL";
  const x=c.map(v=>v.close),a=ema(x,20),b=ema(x,50),p=x.at(-1);
  if(p>a&&a>b)return "BULL";if(p<a&&a<b)return "BEAR";return "NEUTRAL";
}
export function classifyMarket(btc4h,universe4h){
  const btcTrend=trend(btc4h),items=(universe4h||[]).filter(x=>Array.isArray(x.candles)&&x.candles.length>=55);
  const states=items.map(x=>trend(x.candles)),bullish=states.filter(x=>x==="BULL").length,bearish=states.filter(x=>x==="BEAR").length,total=items.length;
  const bullPct=total?100*bullish/total:0,bearPct=total?100*bearish/total:0;
  let regime="MIXED";
  if(btcTrend==="BULL"&&bullPct>=55)regime="BULL";
  else if(btcTrend==="BEAR"&&bearPct>=55)regime="BEAR";
  else if(btcTrend==="NEUTRAL"||Math.max(bullPct,bearPct)<55)regime="NEUTRAL";
  return {regime,btcTrend,bullish,bearish,neutral:total-bullish-bearish,total,bullPct:Number(bullPct.toFixed(2)),bearPct:Number(bearPct.toFixed(2))};
}
export function classifySymbol1h(candles,marketRegime){
  const d=trend(candles);if(marketRegime==="BULL"&&d==="BULL")return "LONG";if(marketRegime==="BEAR"&&d==="BEAR")return "SHORT";return null;
}
export function findEntry15m(candles,side,options={}){
  const minVolumeRatio=options.minVolumeRatio??1.15;\n  const minBodyRatio=options.minBodyRatio??0.45;\n  const breakoutLookback=options.breakoutLookback??8;\n  const breakoutCloseLocation=options.breakoutCloseLocation??0.72;\n  const reclaimCloseLocation=options.reclaimCloseLocation??0.65;\n  const entryMode=options.entryMode??"BOTH";
  if(!Array.isArray(candles)||candles.length<60||!["LONG","SHORT"].includes(side))return null;
  const c=candles.at(-1),prev=candles.at(-2),closes=candles.map(x=>x.close),e20=ema(closes,20),volatility=atr(candles,14);
  if(!(e20>0)||!(volatility>0))return null;
  const avgVol=candles.slice(-21,-1).reduce((s,x)=>s+x.volume,0)/20,volumeRatio=avgVol>0?c.volume/avgVol:0,range=c.high-c.low;
  if(!(range>0)||volumeRatio<minVolumeRatio)return null;
  const bodyRatio=Math.abs(c.close-c.open)/range,closeLocation=side==="LONG"?(c.close-c.low)/range:(c.high-c.close)/range;
  const recent=candles.slice(-(breakoutLookback+1),-1),swingHigh=Math.max(...recent.map(x=>x.high)),swingLow=Math.min(...recent.map(x=>x.low));
  const breakout=side==="LONG"?c.close>swingHigh&&c.close>c.open&&closeLocation>=breakoutCloseLocation:c.close<swingLow&&c.close<c.open&&closeLocation>=breakoutCloseLocation;
  const reclaim=side==="LONG"?prev.close<=e20&&c.close>e20&&c.close>c.open&&closeLocation>=reclaimCloseLocation:prev.close>=e20&&c.close<e20&&c.close<c.open&&closeLocation>=reclaimCloseLocation;
  if(bodyRatio<minBodyRatio)return null;\n  if(entryMode==="BREAKOUT"&&!breakout)return null;\n  if(entryMode==="RECLAIM"&&!reclaim)return null;\n  if(!["BOTH","BREAKOUT","RECLAIM"].includes(entryMode)||(!breakout&&!reclaim))return null;
  const entry=c.close,structural=side==="LONG"?Math.min(...candles.slice(-8).map(x=>x.low)):Math.max(...candles.slice(-8).map(x=>x.high));
  const atrStop=side==="LONG"?entry-1.4*volatility:entry+1.4*volatility,stop=side==="LONG"?Math.min(structural,atrStop):Math.max(structural,atrStop);
  const risk=side==="LONG"?entry-stop:stop-entry,riskPct=risk/entry;if(!(risk>0)||riskPct<.0015||riskPct>.04)return null;
  const sign=side==="LONG"?1:-1;
  return {side,entry,stop,risk,target1:entry+sign*risk*1.5,target2:entry+sign*risk*2.2,target3:entry+sign*risk*3,volumeRatio:Number(volumeRatio.toFixed(3)),setup:breakout?"BREAKOUT":"EMA20_RECLAIM",candleTime:c.time,ema20:e20,atr:volatility};
}
export function buildMtfSignal({symbol,market,candles1h,candles15m,options={}}){
  if(!market||!["BULL","BEAR"].includes(market.regime))return null;
  const side=classifySymbol1h(candles1h,market.regime);if(!side)return null;
  const entry=findEntry15m(candles15m,side,options);return entry?{symbol,side,marketRegime:market.regime,marketBreadth:market,trend1h:side,...entry}:null;
}

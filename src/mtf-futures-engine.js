// Experimental multi-timeframe engine: 4H market breadth, 1H symbol direction,
// and the live bot's original stop/target construction applied to a 15m entry.
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
// Direction logic mirrors the live bot's strict 1H EMA20/EMA50 + RSI + volume rules.
// 4H individual-coin trend is intentionally removed: 4H is the market-wide gate.
export function classifySymbol1h(candles,marketRegime){
  if(!Array.isArray(candles)||candles.length<60||!["BULL","BEAR"].includes(marketRegime))return null;
  const closes=candles.map(c=>c.close),last=candles.at(-1),e20=ema(closes,20),e50=ema(closes,50);
  const rsiValue=(()=>{let gains=0,losses=0;for(let i=closes.length-14;i<closes.length;i++){const d=closes[i]-closes[i-1];if(d>0)gains+=d;else losses-=d;}const ag=gains/14,al=losses/14;return al===0?100:100-100/(1+ag/al);})();
  const avgVol=candles.slice(-21,-1).reduce((s,c)=>s+c.volume,0)/20;
  const volumeRatio=avgVol>0?last.volume/avgVol:0;
  const up=e20>e50&&last.close>e20,down=e20<e50&&last.close<e20;
  if(marketRegime==="BULL"&&up&&rsiValue>=48&&rsiValue<=69&&volumeRatio>=.75)return "LONG";
  if(marketRegime==="BEAR"&&down&&rsiValue>=31&&rsiValue<=52&&volumeRatio>=.75)return "SHORT";
  return null;
}
// Live-bot plan logic transplanted to 15m: entry at closed candle close;
// stop = more conservative of 7-candle swing and 1.5*ATR(14);
// targets = 1.5R / 2.5R / 3.5R. No BE move or trailing stop.
export function findEntry15m(candles,side){
  if(!Array.isArray(candles)||candles.length<40||!["LONG","SHORT"].includes(side))return null;
  const c=candles.at(-1),entry=c.close,volatility=atr(candles,14);
  if(!(volatility>0))return null;
  const swing=candles.slice(-8,-1),swingLow=Math.min(...swing.map(x=>x.low)),swingHigh=Math.max(...swing.map(x=>x.high));
  const stop=side==="LONG"?Math.min(swingLow,entry-volatility*1.5):Math.max(swingHigh,entry+volatility*1.5);
  const risk=side==="LONG"?entry-stop:stop-entry,riskPct=risk/entry;
  if(!(risk>0)||riskPct<.002||riskPct>.08)return null;
  const dir=side==="LONG"?1:-1;
  return {side,entry,stop,risk,target1:entry+dir*risk*1.5,target2:entry+dir*risk*2.5,target3:entry+dir*risk*3.5,atr:volatility,candleTime:c.time};
}
export function buildMtfSignal({symbol,market,candles1h,candles15m}){
  if(!market||!["BULL","BEAR"].includes(market.regime))return null;
  const side=classifySymbol1h(candles1h,market.regime);if(!side)return null;
  const plan=findEntry15m(candles15m,side);
  return plan?{symbol,side,marketRegime:market.regime,marketBreadth:market,trend1h:side,...plan}:null;
}

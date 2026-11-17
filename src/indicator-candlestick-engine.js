// Independent indicator + Japanese candlestick research engine.
// Pure functions only: no network, exchange orders, Worker integration, or production side effects.
export const IC_CONFIG = Object.freeze({
  EMA_FAST: 20,
  EMA_MID: 50,
  EMA_SLOW: 200,
  RSI_PERIOD: 14,
  MACD_FAST: 12,
  MACD_SLOW: 26,
  MACD_SIGNAL: 9,
  ATR_PERIOD: 14,
  MIN_1H: 210,
  MIN_4H: 210,
  MIN_15M: 60,
  MIN_RISK_PCT: 0.0015,
  MAX_RISK_PCT: 0.06,
  TARGET_R_MULTIPLES: [1, 2, 3]
});

const num = x => Number.isFinite(Number(x));
const mean = xs => xs.length ? xs.reduce((a,b)=>a+b,0)/xs.length : null;

export function validOHLC(candles, min=1) {
  if (!Array.isArray(candles) || candles.length < min) return false;
  for (let i=0;i<candles.length;i++) {
    const c=candles[i];
    if (!c || ![c.time,c.open,c.high,c.low,c.close].every(num) ||
      Number(c.open)<=0 || Number(c.low)<=0 ||
      Number(c.high)<Math.max(Number(c.open),Number(c.close)) ||
      Number(c.low)>Math.min(Number(c.open),Number(c.close)) ||
      (i>0 && Number(c.time)<=Number(candles[i-1].time))) return false;
  }
  return true;
}

export function ema(values, period) {
  if (!Array.isArray(values) || values.length<period || period<1) return null;
  const k=2/(period+1);
  let value=mean(values.slice(0,period));
  for(let i=period;i<values.length;i++) value=values[i]*k+value*(1-k);
  return value;
}

export function calculateRSI(candles, period=IC_CONFIG.RSI_PERIOD) {
  if (!Array.isArray(candles) || candles.length<=period) return null;
  let gains=0,losses=0;
  for(let i=1;i<=period;i++) {
    const d=Number(candles[i].close)-Number(candles[i-1].close);
    if(d>0) gains+=d; else losses-=d;
  }
  let avgGain=gains/period,avgLoss=losses/period;
  for(let i=period+1;i<candles.length;i++) {
    const d=Number(candles[i].close)-Number(candles[i-1].close);
    avgGain=(avgGain*(period-1)+Math.max(0,d))/period;
    avgLoss=(avgLoss*(period-1)+Math.max(0,-d))/period;
  }
  if(avgLoss===0) return avgGain===0?50:100;
  return 100-(100/(1+avgGain/avgLoss));
}

export function calculateMACD(candles, fast=IC_CONFIG.MACD_FAST, slow=IC_CONFIG.MACD_SLOW, signal=IC_CONFIG.MACD_SIGNAL) {
  if (!Array.isArray(candles) || candles.length<slow+signal+2) return null;
  const closes=candles.map(c=>Number(c.close));
  const kf=2/(fast+1),ks=2/(slow+1);
  let fastEma=mean(closes.slice(0,fast)),slowEma=mean(closes.slice(0,slow));
  const line=[];
  for(let i=slow;i<closes.length;i++) {
    if(i>=fast) fastEma=closes[i]*kf+fastEma*(1-kf);
    if(i>slow) slowEma=closes[i]*ks+slowEma*(1-ks);
    line.push(fastEma-slowEma);
  }
  if(line.length<signal) return null;
  const signalLine=ema(line,signal);
  return {macd:line.at(-1),signal:signalLine,histogram:line.at(-1)-signalLine};
}

export function calculateATR(candles, period=IC_CONFIG.ATR_PERIOD) {
  if(!Array.isArray(candles)||candles.length<=period) return null;
  const tr=[];
  for(let i=1;i<candles.length;i++) {
    const c=candles[i],p=candles[i-1];
    tr.push(Math.max(c.high-c.low,Math.abs(c.high-p.close),Math.abs(c.low-p.close)));
  }
  return mean(tr.slice(-period));
}

export function detectCandlePattern(candles) {
  if(!Array.isArray(candles)||candles.length<2) return null;
  const c=candles.at(-1),p=candles.at(-2);
  const body=Math.abs(c.close-c.open);
  const total=c.high-c.low;
  const lower=Math.min(c.open,c.close)-c.low;
  const upper=c.high-Math.max(c.open,c.close);
  const bullEngulf=c.close>c.open&&p.close<p.open&&c.open<=p.close&&c.close>=p.open;
  const bearEngulf=c.close<c.open&&p.close>p.open&&c.open>=p.close&&c.close<=p.open;
  const bullPin=total>0&&lower>=Math.max(body*2,total*0.55)&&upper<=total*0.2&&c.close>c.open;
  const bearPin=total>0&&upper>=Math.max(body*2,total*0.55)&&lower<=total*0.2&&c.close<c.open;
  if(bullEngulf) return {side:"LONG",name:"BULLISH_ENGULFING"};
  if(bearEngulf) return {side:"SHORT",name:"BEARISH_ENGULFING"};
  if(bullPin) return {side:"LONG",name:"BULLISH_PIN_BAR"};
  if(bearPin) return {side:"SHORT",name:"BEARISH_PIN_BAR"};
  return null;
}

function trend(candles) {
  const closes=candles.map(c=>Number(c.close));
  const e20=ema(closes,20),e50=ema(closes,50),e200=ema(closes,200);
  if([e20,e50,e200].some(x=>x===null)) return {direction:"UNKNOWN",ema20:e20,ema50:e50,ema200:e200};
  const last=closes.at(-1);
  const direction=last>e20&&e20>e50&&e50>e200?"LONG":
    last<e20&&e20<e50&&e50<e200?"SHORT":"NEUTRAL";
  return {direction,ema20:e20,ema50:e50,ema200:e200};
}

function makeSignal({symbol,side,entry,stop,pattern,rsi,macd,t1,h1,h4,variant}) {
  const risk=side==="LONG"?entry-stop:stop-entry;
  const riskPct=risk/entry;
  if(!(risk>0)||riskPct<IC_CONFIG.MIN_RISK_PCT||riskPct>IC_CONFIG.MAX_RISK_PCT) return null;
  const d=side==="LONG"?1:-1;
  const targets=IC_CONFIG.TARGET_R_MULTIPLES.map(r=>entry+d*risk*r);
  return {
    symbol,side,strategyId:variant,strategyName:variant==="indicator_baseline"?"RSI + MACD + EMA baseline":"EMA + structure + candlestick",
    score:80,entry,stop,target1:targets[0],target2:targets[1],target3:targets[2],
    rewardRisk:3,reason:pattern?"تأیید الگوی "+pattern.name+" با روند و مومنتوم":"تأیید روند و مومنتوم RSI/MACD",
    context:{pattern:pattern?.name??null,rsi,macdHistogram:macd?.histogram??null,
      trend1h:t1.direction,trend4h:t4safe(h4).direction,atr:calculateATR(h1)},
    timeframes:["4h","1h","15m"],setupTime:h1.at(-1).time
  };
}
function t4safe(candles){return trend(candles);}

/**
 * Evaluate two independently identifiable entry variants on the same closed candles.
 * RSI/MACD baseline is intentionally kept separate from candlestick confirmation so
 * their incremental value can be measured rather than blended invisibly.
 */
export function analyzeIndicatorCandles({symbol,oneHour,fourHour,fifteenMin,livePrice,variant="BOTH"}) {
  if(!validOHLC(oneHour,IC_CONFIG.MIN_1H)||!validOHLC(fourHour,IC_CONFIG.MIN_4H)||
     !validOHLC(fifteenMin,IC_CONFIG.MIN_15M))
    return {signals:[],rejected:"داده کندلی بسته‌شده کافی یا معتبر نیست.",diagnostics:[]};
  const price=Number(livePrice);
  if(!Number.isFinite(price)||price<=0) return {signals:[],rejected:"قیمت معتبر نیست.",diagnostics:[]};
  const t1=trend(oneHour),t4=trend(fourHour);
  const rsi=calculateRSI(fifteenMin),macd=calculateMACD(fifteenMin),atr=calculateATR(oneHour);
  if(rsi===null||!macd||!atr||!(atr>0)) return {signals:[],rejected:"تاریخچه کافی برای محاسبه اندیکاتورها وجود ندارد.",diagnostics:[]};
  const candle=detectCandlePattern(fifteenMin);
  const results=[];
  const directional=(t1.direction===t4.direction&&(t1.direction==="LONG"||t1.direction==="SHORT"))?t1.direction:null;
  const momentumSide=macd.histogram>0&&macd.macd>macd.signal&&rsi>=50&&rsi<=72?"LONG":
    macd.histogram<0&&macd.macd<macd.signal&&rsi<=50&&rsi>=28?"SHORT":null;
  const stopFor=(side)=> {
    const recent=oneHour.slice(-8);
    const structural=side==="LONG"?Math.min(...recent.map(c=>c.low)):Math.max(...recent.map(c=>c.high));
    const volatility=price- (side==="LONG"?1:-1)*atr*1.5;
    return side==="LONG"?Math.min(structural,volatility):Math.max(structural,volatility);
  };
  if((variant==="BOTH"||variant==="INDICATOR")&&directional&&momentumSide===directional) {
    const signal=makeSignal({symbol,side:directional,entry:price,stop:stopFor(directional),pattern:null,rsi,macd,t1,h1:oneHour,h4:fourHour,variant:"indicator_baseline"});
    if(signal) results.push(signal);
  }
  if((variant==="BOTH"||variant==="CANDLE")&&directional&&candle?.side===directional&&momentumSide===directional) {
    const signal=makeSignal({symbol,side:directional,entry:price,stop:stopFor(directional),pattern:candle,rsi,macd,t1,h1:oneHour,h4:fourHour,variant:"ema_candlestick"});
    if(signal) results.push(signal);
  }
  return {signals:results.sort((a,b)=>a.strategyId.localeCompare(b.strategyId)),diagnostics:[
    {strategyId:"indicator_baseline",status:results.some(x=>x.strategyId==="indicator_baseline")?"accepted":"no_setup",side:directional,score:results.some(x=>x.strategyId==="indicator_baseline")?80:null},
    {strategyId:"ema_candlestick",status:results.some(x=>x.strategyId==="ema_candlestick")?"accepted":"no_setup",side:candle?.side??null,score:results.some(x=>x.strategyId==="ema_candlestick")?80:null}
  ]};
}

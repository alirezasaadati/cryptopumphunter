// Independent LONG engine derived from the user's long_engine.py (experimental only).
export const EMA_PULLBACK_LONG_VERSION = "1.1.0";

const finite = v => Number.isFinite(Number(v));
const num = v => finite(v) ? Number(v) : null;

function ema(values, length) {
  if (values.length < length) return values.map(() => null);
  const out = Array(values.length).fill(null);
  let value = values.slice(0,length).reduce((a,b)=>a+b,0)/length;
  out[length-1]=value;
  const alpha=2/(length+1);
  for(let i=length;i<values.length;i++){value=values[i]*alpha+value*(1-alpha);out[i]=value;}
  return out;
}
function rma(values,length) {
  const out=Array(values.length).fill(null);
  let seed=[];
  let value=null;
  for(let i=0;i<values.length;i++){
    const x=values[i];
    if(x===null||!Number.isFinite(x)){seed=[];value=null;continue;}
    if(value===null){
      seed.push(x);
      if(seed.length===length){value=seed.reduce((a,b)=>a+b,0)/length;out[i]=value;}
    } else {value=(value*(length-1)+x)/length;out[i]=value;}
  }
  return out;
}
function rsi(values,length) {
  const gains=Array(values.length).fill(null),losses=Array(values.length).fill(null);
  for(let i=1;i<values.length;i++){const d=values[i]-values[i-1];gains[i]=Math.max(d,0);losses[i]=Math.max(-d,0);}
  const ag=rma(gains,length),al=rma(losses,length);
  return values.map((_,i)=>ag[i]===null||al[i]===null?null:al[i]===0?100:100-100/(1+ag[i]/al[i]));
}
function indicators(candles,cfg){
  const c=candles.map(x=>num(x.close)),h=candles.map(x=>num(x.high)),l=candles.map(x=>num(x.low)),v=candles.map(x=>num(x.volume));
  const eFast=ema(c,cfg.emaFast),eMid=ema(c,cfg.emaMid),eSlow=ema(c,cfg.emaSlow),eTrend=ema(c,cfg.emaTrend);
  const tr=Array(c.length).fill(null),pdm=Array(c.length).fill(null),mdm=Array(c.length).fill(null);
  for(let i=1;i<c.length;i++){
    tr[i]=Math.max(h[i]-l[i],Math.abs(h[i]-c[i-1]),Math.abs(l[i]-c[i-1]));
    const up=h[i]-h[i-1],down=l[i-1]-l[i];
    pdm[i]=up>down&&up>0?up:0;
    mdm[i]=down>up&&down>0?down:0;
  }
  const atr=rma(tr,cfg.adxLen),pdmR=rma(pdm,cfg.adxLen),mdmR=rma(mdm,cfg.adxLen);
  const dmp=atr.map((x,i)=>x&&pdmR[i]!==null?pdmR[i]/x*100:null);
  const dmn=atr.map((x,i)=>x&&mdmR[i]!==null?mdmR[i]/x*100:null);
  const dx=dmp.map((x,i)=>x===null||dmn[i]===null||x+dmn[i]===0?null:Math.abs(x-dmn[i])/(x+dmn[i])*100);
  const adx=rma(dx,cfg.adxLen),rs=rsi(c,cfg.rsiLen);
  const volumeMa=Array(c.length).fill(null);
  for(let i=cfg.volMaLen-1;i<v.length;i++){
    const window=v.slice(i-cfg.volMaLen+1,i+1);
    if(window.every(x=>x!==null))volumeMa[i]=window.reduce((a,b)=>a+b,0)/cfg.volMaLen;
  }
  const slope=Array(c.length).fill(null);
  for(let i=5;i<c.length;i++)if(eSlow[i]!==null&&eSlow[i-5])slope[i]=(eSlow[i]-eSlow[i-5])/eSlow[i-5];
  return candles.map((_,i)=>({emaFast:eFast[i],emaMid:eMid[i],emaSlow:eSlow[i],emaTrend:eTrend[i],adx:adx[i],dmp:dmp[i],dmn:dmn[i],rsi:rs[i],atr:atr[i],volMa:volumeMa[i],emaSlowSlope:slope[i]}));
}
const DEFAULTS={emaFast:21,emaMid:50,emaSlow:100,emaTrend:200,adxLen:14,adxMinStrong:25,adxMinWeak:22,rsiLen:14,rsiMin:50,rsiMax:72,atrLen:14,atrSlMult:1.5,rrTp1:1.5,rrTp2:3,volMaLen:20,minBars:210,minConfidence:55};
function regimeOf(row,cfg){
  const price=row.close;
  if(price<row.emaTrend||row.emaSlowSlope<-.001)return "DOWNTREND";
  const strong=price>row.emaFast&&row.emaFast>row.emaMid&&row.emaMid>row.emaSlow;
  if(strong&&row.adx>=cfg.adxMinStrong&&row.rsi>=55&&row.emaSlowSlope>0)return "STRONG_UPTREND";
  if(price>row.emaTrend&&price>row.emaSlow&&row.adx>=cfg.adxMinWeak&&row.rsi>=cfg.rsiMin&&row.emaSlowSlope>=0)return "WEAK_UPTREND";
  return "NEUTRAL";
}
function confidenceOf(row,regime,cfg){
  let score=regime==="STRONG_UPTREND"?40:regime==="WEAK_UPTREND"?25:0;
  if(row.adx>=cfg.adxMinStrong)score+=15;else if(row.adx>=cfg.adxMinWeak)score+=8;
  if(row.rsi>=55&&row.rsi<=65)score+=15;else if(row.rsi>=50&&row.rsi<55)score+=8;else if(row.rsi>65&&row.rsi<=cfg.rsiMax)score+=5;
  if(row.dmp>row.dmn)score+=10;
  if(row.volume>row.volMa)score+=10;
  if(row.emaSlowSlope>.002)score+=10;else if(row.emaSlowSlope>0)score+=5;
  return Math.min(score,100);
}
/**
 * Input candles are CLOSED OHLCV candles, oldest first, on one timeframe.
 * This preserves the Python engine's rules and default parameters.
 */
export function analyzeEmaPullbackLong({symbol,candles,options={}}){
  const cfg={...DEFAULTS,...options};
  const reject=(reason,regime="UNKNOWN",extra={})=>({symbol,side:"LONG",eligible:false,reason,regime,...extra});
  if(!Array.isArray(candles)||candles.length<cfg.minBars)return reject("insufficient_history");
  if(!candles.every(x=>[x.open,x.high,x.low,x.close,x.volume].every(finite)&&num(x.open)>0&&num(x.low)>0&&num(x.high)>=Math.max(num(x.open),num(x.close),num(x.low))&&num(x.volume)>=0))return reject("invalid_ohlcv");
  const computed=indicators(candles,cfg),i=candles.length-1,raw=candles[i],ind=computed[i];
  const required=[ind.emaFast,ind.emaMid,ind.emaSlow,ind.emaTrend,ind.adx,ind.dmp,ind.dmn,ind.rsi,ind.atr,ind.volMa,ind.emaSlowSlope];
  if(required.some(x=>x===null||!Number.isFinite(x)))return reject("indicator_nan");
  const row={...ind,open:num(raw.open),high:num(raw.high),low:num(raw.low),close:num(raw.close),volume:num(raw.volume)};
  const regime=regimeOf(row,cfg);
  if(regime==="DOWNTREND"||regime==="NEUTRAL")return reject("unfavorable_market_regime",regime);
  const body=row.close-row.open,range=row.high-row.low;
  if(range<=0)return reject("zero_candle_range",regime);
  const closePosition=(row.close-row.low)/range;
  const bullish=body>0&&closePosition>=.6;
  const recent=candles.slice(-3);
  const pulled=recent.some(x=>num(x.low)<=row.emaFast*1.005)||recent.some(x=>num(x.low)<=row.emaMid*1.005);
  const volumeOk=row.volume>row.volMa;
  if(!bullish)return reject("confirmation_candle_not_bullish",regime);
  if(!pulled)return reject("no_ema_pullback",regime);
  if(!volumeOk)return reject("volume_below_threshold",regime);
  const entry=row.close,slAtr=entry-row.atr*cfg.atrSlMult,slEma=row.emaMid*.998;
  let stop=Math.max(slAtr,slEma),risk=entry-stop;
  if(risk<=0){risk=entry*.01;stop=entry-risk;}
  const tp1=entry+risk*cfg.rrTp1,tp2=entry+risk*cfg.rrTp2;
  const confidence=confidenceOf(row,regime,cfg);
  if(confidence<cfg.minConfidence)return reject("confidence_below_minimum",regime,{confidence});
  return {symbol,side:"LONG",eligible:true,version:EMA_PULLBACK_LONG_VERSION,regime,entry,stop,tp1,tp2,riskReward:(tp1-entry)/(entry-stop),confidence,
    reasons:[`regime:${regime}`,`ADX=${row.adx.toFixed(2)} RSI=${row.rsi.toFixed(2)}`,`DMP>DMN:${row.dmp>row.dmn}`,"pullback+bullish-candle+volume"],
    indicators:{emaFast:row.emaFast,emaMid:row.emaMid,emaSlow:row.emaSlow,emaTrend:row.emaTrend,adx:row.adx,dmp:row.dmp,dmn:row.dmn,rsi:row.rsi,atr:row.atr,volume:row.volume,volumeMa:row.volMa,emaSlowSlope:row.emaSlowSlope}};
}

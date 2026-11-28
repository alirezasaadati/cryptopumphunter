// Research-only LONG engine. Never imported by src/index.js or any live signal path.
export const LONG_CONFIG = Object.freeze({
  MIN_15M_CANDLES: 80,
  MIN_5M_CANDLES: 80,
  MIN_ADX: 18,
  MIN_VOLUME_RATIO: 1.15,
  MIN_SCORE: 85,
  MIN_RR: 1.5,
  MAX_RISK_PCT: 0.025,
  MAX_ENTRY_EXTENSION_ATR: 0.8,
  RESISTANCE_LOOKBACK: 20,
  SWING_LOOKBACK: 8
});

const finite = n => Number.isFinite(Number(n));
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

export function validateLongCandles(candles, min = 1) {
  if (!Array.isArray(candles) || candles.length < min) return false;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    if (!c || ![c.time,c.open,c.high,c.low,c.close,c.volume].every(finite) ||
        Number(c.open) <= 0 || Number(c.low) <= 0 || Number(c.close) <= 0 ||
        Number(c.high) < Math.max(Number(c.open),Number(c.close)) ||
        Number(c.low) > Math.min(Number(c.open),Number(c.close)) || Number(c.volume) < 0 ||
        (i && Number(c.time) <= Number(candles[i-1].time))) return false;
  }
  return true;
}

function ema(values, period) {
  if (values.length < period) return [];
  const out = Array(values.length).fill(null);
  const k = 2 / (period + 1);
  let seed = values.slice(0,period).reduce((a,b)=>a+b,0)/period;
  out[period-1] = seed;
  for (let i=period;i<values.length;i++) {
    seed = values[i]*k + seed*(1-k);
    out[i] = seed;
  }
  return out;
}

function rsi(values, period=14) {
  if (values.length <= period) return null;
  let gain=0, loss=0;
  for(let i=1;i<=period;i++) {
    const d=values[i]-values[i-1];
    gain+=Math.max(0,d); loss+=Math.max(0,-d);
  }
  let avgGain=gain/period, avgLoss=loss/period;
  for(let i=period+1;i<values.length;i++) {
    const d=values[i]-values[i-1];
    avgGain=(avgGain*(period-1)+Math.max(0,d))/period;
    avgLoss=(avgLoss*(period-1)+Math.max(0,-d))/period;
  }
  if(avgLoss===0) return 100;
  return 100-(100/(1+avgGain/avgLoss));
}

function atr(candles, period=14) {
  if(candles.length<=period) return null;
  const tr=[];
  for(let i=1;i<candles.length;i++) {
    const c=candles[i], p=candles[i-1];
    tr.push(Math.max(c.high-c.low,Math.abs(c.high-p.close),Math.abs(c.low-p.close)));
  }
  let value=tr.slice(0,period).reduce((a,b)=>a+b,0)/period;
  for(let i=period;i<tr.length;i++) value=(value*(period-1)+tr[i])/period;
  return value;
}

function adx(candles, period=14) {
  if(candles.length<period*2+1) return null;
  const tr=[], plus=[], minus=[];
  for(let i=1;i<candles.length;i++) {
    const c=candles[i], p=candles[i-1];
    const up=c.high-p.high, down=p.low-c.low;
    tr.push(Math.max(c.high-c.low,Math.abs(c.high-p.close),Math.abs(c.low-p.close)));
    plus.push(up>down&&up>0?up:0);
    minus.push(down>up&&down>0?down:0);
  }
  let sTR=tr.slice(0,period).reduce((a,b)=>a+b,0);
  let sP=plus.slice(0,period).reduce((a,b)=>a+b,0);
  let sM=minus.slice(0,period).reduce((a,b)=>a+b,0);
  const dx=[];
  const add=()=>{
    const pdi=sTR?100*sP/sTR:0, mdi=sTR?100*sM/sTR:0;
    dx.push(pdi+mdi?100*Math.abs(pdi-mdi)/(pdi+mdi):0);
  };
  add();
  for(let i=period;i<tr.length;i++) {
    sTR=sTR-sTR/period+tr[i];
    sP=sP-sP/period+plus[i];
    sM=sM-sM/period+minus[i];
    add();
  }
  if(dx.length<period) return null;
  let value=dx.slice(0,period).reduce((a,b)=>a+b,0)/period;
  for(let i=period;i<dx.length;i++) value=(value*(period-1)+dx[i])/period;
  const pdi=sTR?100*sP/sTR:0, mdi=sTR?100*sM/sTR:0;
  return {value,plus:pdi,minus:mdi};
}

function mean(xs) { return xs.length ? xs.reduce((a,b)=>a+b,0)/xs.length : 0; }

function buildCandidate({setupId,setupName,entryReference,stop,atr5,score,reason,context}) {
  const risk=entryReference-stop, riskPct=risk/entryReference;
  if(!(risk>0) || riskPct>LONG_CONFIG.MAX_RISK_PCT || !finite(riskPct)) return null;
  const target1=entryReference+risk*LONG_CONFIG.MIN_RR;
  return {
    side:"LONG",setupId,setupName,score,entryReference,stop,target1,
    rewardRisk:LONG_CONFIG.MIN_RR,riskPct,reason,context,
    execution:"NEXT_5M_OPEN",
    setupTime:context.triggerTime
  };
}

/**
 * Evaluates only fully closed candles. Call after each 5m close with the latest
 * fully closed 15m candle set. btcRegimeBullish must be computed from closed BTC data.
 */
export function evaluateLongSetup({fiveMin,fifteenMin,btcRegimeBullish=false}) {
  const diagnostics=[];
  if(!validateLongCandles(fiveMin,LONG_CONFIG.MIN_5M_CANDLES) ||
     !validateLongCandles(fifteenMin,LONG_CONFIG.MIN_15M_CANDLES)) {
    return {candidate:null,diagnostics:[{status:"invalid_data",reason:"Insufficient or invalid closed candles."}]};
  }
  const closes15=fifteenMin.map(c=>c.close);
  const e20=ema(closes15,20), e50=ema(closes15,50);
  const regimeAdx=adx(fifteenMin);
  const last15=fifteenMin.at(-1), prevE50=e50.at(-2);
  const trendOk=e20.at(-1)>e50.at(-1) && e50.at(-1)>prevE50 &&
    last15.close>e20.at(-1) && regimeAdx && regimeAdx.value>=LONG_CONFIG.MIN_ADX &&
    regimeAdx.plus>regimeAdx.minus;
  const hardGates={
    trend15m:!!trendOk,
    btc:btcRegimeBullish===true
  };
  if(!hardGates.trend15m) diagnostics.push({status:"rejected_regime",reason:"15m bullish trend/ADX/DI filter not satisfied."});
  if(!hardGates.btc) diagnostics.push({status:"rejected_btc",reason:"BTC regime is not confirmed bullish."});
  if(!hardGates.trend15m || !hardGates.btc) return {candidate:null,diagnostics,hardGates};

  const closes5=fiveMin.map(c=>c.close), e20_5=ema(closes5,20), e50_5=ema(closes5,50);
  const rsi5=rsi(closes5), atr5=atr(fiveMin);
  const last=fiveMin.at(-1), prev=fiveMin.at(-2);
  const avgVol=mean(fiveMin.slice(-21,-1).map(c=>c.volume));
  const volumeRatio=avgVol>0?last.volume/avgVol:0;
  const momentumOk=rsi5!==null && rsi5>=50 && rsi5<=70;
  const volumeOk=volumeRatio>=LONG_CONFIG.MIN_VOLUME_RATIO;
  if(!momentumOk) diagnostics.push({status:"rejected_momentum",reason:"5m RSI must be between 50 and 70."});
  if(!volumeOk) diagnostics.push({status:"rejected_volume",reason:"5m volume confirmation is below threshold."});
  if(!momentumOk || !volumeOk) return {candidate:null,diagnostics,hardGates};

  const prior=fiveMin.slice(-(LONG_CONFIG.RESISTANCE_LOOKBACK+2),-2);
  const resistance=Math.max(...prior.map(c=>c.high));
  const swingLow=Math.min(...fiveMin.slice(-LONG_CONFIG.SWING_LOOKBACK).map(c=>c.low));
  const pad=Math.max(atr5*0.15,last.close*0.0005);
  const breakout=prev.close<=resistance && last.close>resistance;
  const retest=prev.close>resistance && last.low<=resistance+atr5*0.15 && last.close>resistance;
  const pullback=last.close>e20_5.at(-1) && e20_5.at(-1)>e50_5.at(-1) &&
    last.low<=e20_5.at(-1)+atr5*0.15 && last.close>last.open && last.close>prev.close;
  const setups=[
    {ok:breakout,id:"breakout",name:"Breakout close",reason:"5m close above prior 20-candle resistance."},
    {ok:retest,id:"breakout_retest",name:"Breakout retest",reason:"Retest held above broken 5m resistance."},
    {ok:pullback,id:"trend_pullback",name:"Trend pullback",reason:"Bullish 5m EMA alignment and confirmed rebound."}
  ];
  const setup=setups.find(x=>x.ok);
  if(!setup) {
    diagnostics.push({status:"no_setup",reason:"No approved 5m entry setup."});
    return {candidate:null,diagnostics,hardGates};
  }
  const extension=(last.close-e20_5.at(-1))/atr5;
  if(!finite(extension)||extension>LONG_CONFIG.MAX_ENTRY_EXTENSION_ATR) {
    diagnostics.push({status:"late_entry",reason:"Price is too extended from 5m EMA20."});
    return {candidate:null,diagnostics,hardGates};
  }
  const stop=Math.min(swingLow,last.low)-pad;
  const score=85 + (volumeRatio>=1.5?5:0) + (rsi5>=53&&rsi5<=65?5:0);
  const candidate=buildCandidate({
    setupId:setup.id,setupName:setup.name,entryReference:last.close,stop,atr5,score:clamp(score,0,95),
    reason:setup.reason,
    context:{triggerTime:last.time,resistance,volumeRatio,rsi:rsi5,adx:regimeAdx.value,diPlus:regimeAdx.plus,diMinus:regimeAdx.minus,btcRegimeBullish:true}
  });
  if(!candidate) diagnostics.push({status:"rejected_risk",reason:"Structural stop risk exceeds configured limit."});
  else diagnostics.push({status:"candidate",reason:setup.reason,score:candidate.score});
  return {candidate,diagnostics,hardGates};
}

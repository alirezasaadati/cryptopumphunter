// Experimental, pure Smart Money signal engine. No network calls or order execution.
export const SMC_CONFIG = Object.freeze({
  MIN_CANDLES: 60,
  CHOCH_LOOKBACK: 12,
  PIVOT_LEFT: 3,
  PIVOT_RIGHT: 3,
  ATR_PERIOD: 14,
  CLOSE_BUFFER_ATR: 0.05,
  MIN_BODY_RANGE_RATIO: 0.45,
  DISPLACEMENT_ATR: 1.15,
  OB_LOOKBACK: 12,
  LIQUIDITY_LOOKBACK: 80,
  OB_MAX_DISTANCE_ATR: 1.25,
  ENTRY_BUFFER_ATR: 0.12,
  STOP_BUFFER_ATR: 0.25,
  MIN_RR_T1: 1.5,
  MIN_RR_T3: 2.5,
  MAX_RISK_PCT: 0.04,
  MIN_MATRIX_SCORE: 75,
  TARGET_R: [1.5, 2.2, 3.0]
});

const isNum = v => Number.isFinite(Number(v));
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const median = xs => {
  if (!xs.length) return 0;
  const a = [...xs].sort((x,y)=>x-y), m = Math.floor(a.length/2);
  return a.length % 2 ? a[m] : (a[m-1]+a[m])/2;
};

export function validateOHLC(candles, min = SMC_CONFIG.MIN_CANDLES) {
  if (!Array.isArray(candles) || candles.length < min) return false;
  for (let i=0;i<candles.length;i++) {
    const c=candles[i];
    if (!c || ![c.time,c.open,c.high,c.low,c.close].every(isNum)) return false;
    if (Number(c.time)<0 || Number(c.low)<=0 ||
        Number(c.high)<Math.max(Number(c.open),Number(c.close)) ||
        Number(c.low)>Math.min(Number(c.open),Number(c.close))) return false;
    if (i && Number(c.time)<=Number(candles[i-1].time)) return false;
  }
  return true;
}

export function calculateATR(candles, period=SMC_CONFIG.ATR_PERIOD) {
  if (!Array.isArray(candles) || candles.length < period+1) return [];
  const tr=[];
  for(let i=1;i<candles.length;i++){
    const c=candles[i], p=candles[i-1];
    tr.push(Math.max(c.high-c.low,Math.abs(c.high-p.close),Math.abs(c.low-p.close)));
  }
  const out=new Array(candles.length).fill(null);
  let value=tr.slice(0,period).reduce((a,b)=>a+b,0)/period;
  out[period]=value;
  for(let i=period+1;i<candles.length;i++){
    value=(value*(period-1)+tr[i-1])/period;
    out[i]=value;
  }
  return out;
}

// A pivot is exposed only after its right-hand confirmation candles have closed.
export function confirmedPivots(candles,left=SMC_CONFIG.PIVOT_LEFT,right=SMC_CONFIG.PIVOT_RIGHT){
  const highs=[],lows=[];
  if(!Array.isArray(candles)||candles.length<left+right+3)return{highs,lows};
  for(let i=left;i<candles.length-right;i++){
    const c=candles[i],before=candles.slice(i-left,i),after=candles.slice(i+1,i+right+1);
    if(before.every(x=>c.high>x.high)&&after.every(x=>c.high>=x.high))
      highs.push({index:i,confirmedAt:i+right,time:c.time,price:c.high});
    if(before.every(x=>c.low<x.low)&&after.every(x=>c.low<=x.low))
      lows.push({index:i,confirmedAt:i+right,time:c.time,price:c.low});
  }
  return{highs,lows};
}

export function classifyStructure(candles){
  const p=confirmedPivots(candles);
  const h=p.highs.slice(-3),l=p.lows.slice(-3);
  if(h.length<2||l.length<2)return{direction:"UNKNOWN",pivots:p};
  const hh=h.at(-1).price>h.at(-2).price,hl=l.at(-1).price>l.at(-2).price;
  const lh=h.at(-1).price<h.at(-2).price,ll=l.at(-1).price<l.at(-2).price;
  return{direction:hh&&hl?"BULLISH":lh&&ll?"BEARISH":"RANGE",hh,hl,lh,ll,pivots:p};
}

function bodyRatio(c){
  const range=c.high-c.low;
  return range>0?Math.abs(c.close-c.open)/range:0;
}
function bullish(c){return c.close>c.open;}
function bearish(c){return c.close<c.open;}
function last(xs){return xs.length?xs[xs.length-1]:null;}

function liquidityEvent(candles,side,pivots,atr){
  const c=candles.at(-1), pad=(atr||0)*SMC_CONFIG.CLOSE_BUFFER_ATR;
  const candidates=side==="LONG"?pivots.lows:pivots.highs;
  const pool=candidates.filter(p=>p.confirmedAt<candles.length-1&&candles.length-1-p.index<=SMC_CONFIG.LIQUIDITY_LOOKBACK);
  const swept=pool.filter(p=>side==="LONG"
    ? c.low<p.price-pad && c.close>p.price
    : c.high>p.price+pad && c.close<p.price);
  return last(swept);
}

// "Close high/low" means the candle BODY CLOSE is beyond the confirmed swing,
// not merely a wick excursion. A minimum body/range ratio and ATR displacement
// are required to reduce weak/false breaks.
function structureBreak(candles,side,pivots,atr){
  const c=candles.at(-1),prev=candles.at(-2);
  const levels=side==="LONG"?pivots.highs:pivots.lows;
  const level=last(levels.filter(p=>p.confirmedAt<candles.length-1));
  if(!level||!atr||atr<=0)return null;
  const pad=atr*SMC_CONFIG.CLOSE_BUFFER_ATR;
  const closeBeyond=side==="LONG"?c.close>level.price+pad:c.close<level.price-pad;
  const prevNotBeyond=side==="LONG"?prev.close<=level.price+pad:prev.close>=level.price-pad;
  const displacement=Math.abs(c.close-c.open)>=atr*SMC_CONFIG.DISPLACEMENT_ATR;
  if(!closeBeyond||!prevNotBeyond||bodyRatio(c)<SMC_CONFIG.MIN_BODY_RANGE_RATIO||!displacement)return null;
  return{level:level.price,pivotIndex:level.index,close:c.close,time:c.time,kind:"BOS"};
}

function findOrderBlock(candles,side,breakIndex){
  const start=Math.max(0,breakIndex-SMC_CONFIG.OB_LOOKBACK);
  for(let i=breakIndex-1;i>=start;i--){
    const c=candles[i];
    if(side==="LONG"?bearish(c):bullish(c)){
      return{index:i,time:c.time,low:c.low,high:c.high,mid:(c.low+c.high)/2};
    }
  }
  return null;
}
function overlaps(a,b){return a.low<=b.high&&b.low<=a.high;}
function structuralTargets(side,entry,risk,atr,pivots){
  const levels=side==="LONG"?pivots.highs:pivots.lows;
  const ordered=levels.map(x=>x.price).filter(p=>side==="LONG"?p>entry:p<entry)
    .sort((a,b)=>side==="LONG"?a-b:b-a);
  const dir=side==="LONG"?1:-1;
  const pad=atr*SMC_CONFIG.ENTRY_BUFFER_ATR;
  const poolTargets=ordered.map(p=>p-dir*pad).filter(p=>dir*(p-entry)>0);
  const targets=[];
  for(let i=0;i<3;i++){
    const minR=SMC_CONFIG.TARGET_R[i];
    const fallback=entry+dir*risk*minR;
    const structural=poolTargets[i];
    const previous=targets[i-1];
    const minimum=previous===undefined?entry+dir*risk*minR:previous+dir*risk*0.25;
    targets.push(structural!==undefined&&dir*(structural-minimum)>=0?structural:
      (previous===undefined?fallback:dir>0?Math.max(fallback,minimum):Math.min(fallback,minimum)));
  }
  return targets;
}
function fvgAfterChoch(candles,side,fromIndex){
  for(let i=Math.max(2,fromIndex);i<candles.length;i++){
    const a=candles[i-2],c=candles[i];
    if(side==="LONG"&&c.low>a.high)return{index:i,low:a.high,high:c.low,mid:(a.high+c.low)/2};
    if(side==="SHORT"&&c.high<a.low)return{index:i,low:c.high,high:a.low,mid:(c.high+a.low)/2};
  }
  return null;
}
function findLtfChoch(candles,side){
  // Search only closed prefixes; a later FVG must form after this CHOCH.
  for(let i=candles.length-1;i>=Math.max(SMC_CONFIG.MIN_CANDLES,candles.length-SMC_CONFIG.CHOCH_LOOKBACK);i--){
    const prefix=candles.slice(0,i+1);
    const pivots=confirmedPivots(prefix);
    const atr=calculateATR(prefix).at(-1);
    // A CHOCH must reverse the immediately preceding confirmed LTF structure,
    // not merely break structure in the already prevailing direction.
    const priorTrend=classifyStructure(prefix.slice(0,-1)).direction;
    const requiredPrior=side==="LONG"?"BEARISH":"BULLISH";
    if(priorTrend!==requiredPrior)continue;
    const event=structureBreak(prefix,side,pivots,atr);
    if(event)return{...event,index:i,pivots,atr,priorTrend};
  }
  return null;
}

function normalizeNews(news){
  if(!news||typeof news!=="object")return{status:"UNKNOWN",highImpact:false,score:0,reason:"داده اخبار ارائه نشده است."};
  const status=["CLEAR","CAUTION","BLOCK","UNKNOWN"].includes(news.status)?news.status:"UNKNOWN";
  return{status,highImpact:Boolean(news.highImpact),score:Number.isFinite(Number(news.score))?clamp(Number(news.score),0,100):0,reason:String(news.reason||"")};
}

export function evaluateDecisionMatrix({trend,liquidity,structure,entry,news,risk}){
  const n=normalizeNews(news);
  const layers={
    news:{pass:n.status==="CLEAR"||n.status==="CAUTION",score:n.status==="CLEAR"?100:n.status==="CAUTION"?55:0,reason:n.reason||n.status},
    liquidity:{pass:Boolean(liquidity),score:liquidity?100:0,reason:liquidity?"sweep confirmed":"no confirmed liquidity sweep"},
    structure:{pass:Boolean(trend&&structure),score:trend&&structure?100:0,reason:!trend?"trend not aligned":!structure?"no body-close BOS":"aligned"},
    risk:{pass:Boolean(risk?.valid),score:risk?.valid?100:0,reason:risk?.reason||"risk validation failed"}
  };
  const weights={news:20,liquidity:20,structure:35,risk:25};
  const score=Object.keys(weights).reduce((sum,k)=>sum+layers[k].score*weights[k]/100,0);
  const hardBlock=n.status==="BLOCK"||n.status==="UNKNOWN"||n.highImpact||!layers.liquidity.pass||!layers.structure.pass||!layers.risk.pass;
  return{score:Math.round(score),layers,approved:!hardBlock&&score>=SMC_CONFIG.MIN_MATRIX_SCORE,
    rejected:hardBlock?(n.status==="UNKNOWN"?"وضعیت اخبار نامشخص است؛ تا دریافت داده معتبر معامله مسدود است.":n.status==="BLOCK"||n.highImpact?"ریسک خبر بااهمیت؛ ورود مسدود است.":"حداقل یکی از لایه‌های نقدینگی، ساختار یا ریسک تأیید نشده است."):
    score<SMC_CONFIG.MIN_MATRIX_SCORE?"امتیاز ماتریس تصمیم کمتر از حد مجاز است.":null};
}

/**
 * Inputs must contain CLOSED candles only, ordered oldest -> newest.
 * news is supplied by a trusted upstream calendar/news adapter; this module
 * intentionally does not guess news state or make external network requests.
 */
export function analyzeSMCSignal({symbol,higherTimeframe,structureTimeframe,entryTimeframe,news,riskConfig={}}){
  const empty=(reason,diagnostics={})=>({eligible:false,signal:null,rejected:reason,diagnostics});
  for(const [name,data] of Object.entries({higherTimeframe,structureTimeframe,entryTimeframe})){
    if(!validateOHLC(data))return empty("داده کندلی نامعتبر یا ناکافی است.",{invalidTimeframe:name});
  }
  const ht=classifyStructure(higherTimeframe);
  const st=classifyStructure(structureTimeframe);
  if(!["BULLISH","BEARISH"].includes(ht.direction))return empty("روند تایم‌فریم بالاتر مشخص یا جهت‌دار نیست.",{higherTrend:ht.direction});
  if(st.direction!==ht.direction)return empty("ساختار تایم‌فریم میانی با روند اصلی هم‌جهت نیست.",{higherTrend:ht.direction,structure:st.direction});
  const side=ht.direction==="BULLISH"?"LONG":"SHORT";
  const sAtr=calculateATR(structureTimeframe).at(-1);
  const pivots=confirmedPivots(structureTimeframe);
  let sweep=null;
  // Keep the most recent valid sweep before the current structure candle.
  for(let i=Math.max(SMC_CONFIG.MIN_CANDLES,structureTimeframe.length-16);i<structureTimeframe.length-1;i++){
    const prefix=structureTimeframe.slice(0,i+1);
    const event=liquidityEvent(prefix,side,confirmedPivots(prefix),calculateATR(prefix).at(-1));
    if(event)sweep={...event,index:i};
  }
  if(!sweep)return empty("جمع‌آوری نقدینگی معتبر در تایم‌فریم ساختار مشاهده نشد.",{higherTrend:ht.direction});
  const bos=structureBreak(structureTimeframe,side,pivots,sAtr);
  if(!bos||sweep.index>=structureTimeframe.length-1)return empty("شکست ساختار با بسته‌شدن بدنه و جابه‌جایی ATR پس از sweep تأیید نشد.",{liquiditySweep:sweep});
  const ob=findOrderBlock(structureTimeframe,side,structureTimeframe.length-1);
  if(!ob)return empty("اردربلاک معتبر پیش از شکست ساختار پیدا نشد.",{bos});
  const distance=side==="LONG"?Math.max(0,ob.low-structureTimeframe.at(-1).close,structureTimeframe.at(-1).close-ob.high):
    Math.max(0,ob.low-structureTimeframe.at(-1).close,structureTimeframe.at(-1).close-ob.high);
  if(distance>sAtr*SMC_CONFIG.OB_MAX_DISTANCE_ATR)return empty("قیمت از محدوده اردربلاک بیش از حد فاصله گرفته است.",{ob,distanceAtr:distance/sAtr});
  const ltf=entryTimeframe;
  const choch=findLtfChoch(ltf,side);
  if(!choch)return empty("تغییر ساختار تایم پایین (LTF CHOCH) تأیید نشد.",{ob,liquiditySweep:sweep,bos});
  // The CHOCH candle itself may be the third candle of a valid three-candle FVG.
  const fvg=fvgAfterChoch(ltf,side,choch.index);
  if(!fvg)return empty("پس از CHOCH، شکاف ارزش منصفانه (FVG) معتبر تشکیل نشد.",{ob,choch});
  const obLtf={low:ob.low,high:ob.high};
  const fvgOverlapsOb=overlaps(fvg,obLtf);
  const lastPrice=ltf.at(-1).close;
  const obDistance=Math.max(0,ob.low-lastPrice,lastPrice-ob.high);
  if(!fvgOverlapsOb&&obDistance>sAtr*SMC_CONFIG.OB_MAX_DISTANCE_ATR)
    return empty("FVG با اردربلاک هم‌پوشانی ندارد و قیمت نیز نزدیک اردربلاک نیست.",{ob,fvg,choch});
  const entryZone={low:Math.max(ob.low,fvg.low),high:Math.min(ob.high,fvg.high)};
  const usableZone=entryZone.low<=entryZone.high?entryZone:fvg;
  const entry=(usableZone.low+usableZone.high)/2;
  const eAtr=calculateATR(ltf).at(-1);
  if(!eAtr||Math.abs(lastPrice-entry)>eAtr*SMC_CONFIG.OB_MAX_DISTANCE_ATR)
    return empty("قیمت فعلی بیش از حد از ناحیه ورود FVG/OB فاصله گرفته است.",{ob,fvg,choch,entryZone:usableZone});
  const pad=eAtr*SMC_CONFIG.STOP_BUFFER_ATR;
  const stop=side==="LONG"?Math.min(ob.low,ltf.at(-1).low)-pad:Math.max(ob.high,ltf.at(-1).high)+pad;
  const riskPerUnit=side==="LONG"?entry-stop:stop-entry;
  const riskPct=riskPerUnit/entry;
  const validRisk=Number.isFinite(riskPct)&&riskPerUnit>0&&riskPct<=Number(riskConfig.maxRiskPct??SMC_CONFIG.MAX_RISK_PCT);
  const targets=structuralTargets(side,entry,riskPerUnit,eAtr,pivots);
  const risk={valid:validRisk,reason:validRisk?"risk distance within configured limit":"stop distance invalid or exceeds maximum risk",riskPct};
  const matrix=evaluateDecisionMatrix({trend:true,liquidity:sweep,structure:bos,entry,news,risk});
  const diagnostics={higherTrend:ht.direction,structure:st.direction,liquiditySweep:sweep,bos,orderBlock:ob,choch:{level:choch.level,time:choch.time},fvg,entryZone:usableZone,news:normalizeNews(news),matrix};
  if(!matrix.approved)return empty(matrix.rejected,diagnostics);
  return{eligible:true,rejected:null,diagnostics,signal:{
    id:null,symbol,side,entry,entryZone:usableZone,stop,
    target1:targets[0],target2:targets[1],target3:targets[2],
    rewardRisk:SMC_CONFIG.TARGET_R,score:matrix.score,
    strategyId:"smc_liquidity_ob_choch_fvg",strategyName:"SMC Liquidity + OB + LTF CHOCH/FVG",
    reason:"هم‌جهتی ساختار، sweep نقدینگی، BOS با close بدنه، اردربلاک و تأیید CHOCH/FVG",
    context:{higherTrend:ht.direction,liquidityPrice:sweep.price,bosLevel:bos.level,orderBlock:ob,fvg,atr:eAtr,newsStatus:normalizeNews(news).status}
  }};
}

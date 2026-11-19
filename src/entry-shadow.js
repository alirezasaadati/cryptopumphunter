const HOUR=60*60_000;
const DAY=24*HOUR;
const dir=side=>side==="LONG"?1:-1;
const valid=(v)=>Number.isFinite(Number(v))&&Number(v)>0;

export const ENTRY_SHADOW_CONFIG=Object.freeze({
  durationMs:30*DAY,
  maxSymbols:3,
  maxSetupAgeMs:90*60_000,
  maxOpenTrades:100,
  retentionMs:45*DAY,
  feePerSide:0.0005,
  slippagePerSide:0.0003,
  maxHoldMs:72*HOUR
});

export function shadowSetupId(symbol,side,candleTime){
  return [String(symbol||"").toUpperCase(),side,Number(candleTime)].join("|");
}

export function buildShadowLevels(candidate,candles1h,entry){
  if(!candidate||!["LONG","SHORT"].includes(candidate.side)||!valid(entry)||!Array.isArray(candles1h)||candles1h.length<8)return null;
  const swing=candles1h.slice(-8,-1);
  const atr=Number(candidate.atr);
  if(!valid(atr))return null;
  const stop=candidate.side==="LONG"
    ?Math.min(...swing.map(c=>Number(c.low)),entry-atr*1.5)
    :Math.max(...swing.map(c=>Number(c.high)),entry+atr*1.5);
  const risk=candidate.side==="LONG"?entry-stop:stop-entry;
  const riskPct=risk/entry;
  if(!valid(risk)||riskPct<0.002||riskPct>0.08)return null;
  const d=dir(candidate.side);
  return {entry,stop,risk,target1:entry+d*risk*1.5,target2:entry+d*risk*2.5,target3:entry+d*risk*3.5};
}

/** Advance one shadow record using only closed 1m candles. Stop is conservatively first on ambiguous candles. */
export function advanceShadowTrade(record,candles,now=Date.now()){
  if(!record||record.status!=="OPEN"||!Array.isArray(candles))return record;
  const d=dir(record.side),entry=Number(record.entry),risk=Number(record.risk);
  if(!valid(entry)||!valid(risk))return {...record,status:"INVALID",updatedAt:now};
  let left=Number(record.remaining??1),realizedR=Number(record.realizedR??0);
  let targetHits=Array.isArray(record.targetHits)?[...record.targetHits]:[];
  let maxMaeR=Number(record.maxMaeR??0),timeToProfitMin=record.timeToProfitMin??null;
  let lastProcessed=Number(record.lastProcessedCandleTime??0),status="OPEN",exitReason=null,exitTime=null;
  const sorted=candles.filter(c=>Number(c.time)+60_000<=now&&Number(c.time)>lastProcessed)
    .sort((a,b)=>Number(a.time)-Number(b.time));
  for(const c of sorted){
    const high=Number(c.high),low=Number(c.low),open=Number(c.open),close=Number(c.close),time=Number(c.time);
    if(![high,low,open,close,time].every(Number.isFinite))continue;
    const adverse=d===1?Math.max(0,entry-low):Math.max(0,high-entry);
    maxMaeR=Math.max(maxMaeR,adverse/risk);
    if(timeToProfitMin===null&&(d===1?close>entry*(1+2*ENTRY_SHADOW_CONFIG.feePerSide+2*ENTRY_SHADOW_CONFIG.slippagePerSide):close<entry*(1-2*ENTRY_SHADOW_CONFIG.feePerSide-2*ENTRY_SHADOW_CONFIG.slippagePerSide)))timeToProfitMin=(time-Number(record.entryTime))/60_000;
    const stop=Number(record.stop);
    if(d===1?open<=stop||low<=stop:open>=stop||high>=stop){
      const px=d===1&&open<=stop||d===-1&&open>=stop?open:stop;
      const fill=px*(1-d*ENTRY_SHADOW_CONFIG.slippagePerSide);
      realizedR+=left*(d*(fill-entry)/risk-ENTRY_SHADOW_CONFIG.feePerSide*(entry+fill)/risk);
      left=0;status="CLOSED";exitReason="STOP";exitTime=time;lastProcessed=time;break;
    }
    const targets=[Number(record.target1),Number(record.target2),Number(record.target3)],weights=[0.4,0.35,0.25];
    for(let i=0;i<3&&left>1e-8;i++){
      if(targetHits.includes(i+1))continue;
      if(!(d===1?high>=targets[i]:low<=targets[i]))continue;
      const weight=Math.min(left,weights[i]),fill=targets[i]*(1-d*ENTRY_SHADOW_CONFIG.slippagePerSide);
      realizedR+=weight*(d*(fill-entry)/risk-ENTRY_SHADOW_CONFIG.feePerSide*(entry+fill)/risk);
      left-=weight;targetHits.push(i+1);
    }
    lastProcessed=time;
    if(left<=1e-8){left=0;status="CLOSED";exitReason="ALL_TARGETS";exitTime=time;break;}
    if(time-Number(record.entryTime)>=ENTRY_SHADOW_CONFIG.maxHoldMs){
      const fill=close*(1-d*ENTRY_SHADOW_CONFIG.slippagePerSide);
      realizedR+=left*(d*(fill-entry)/risk-ENTRY_SHADOW_CONFIG.feePerSide*(entry+fill)/risk);
      left=0;status="CLOSED";exitReason="TIME_EXIT";exitTime=time;break;
    }
  }
  return {...record,status,remaining:left,realizedR,targetHits,maxMaeR,timeToProfitMin,lastProcessedCandleTime:lastProcessed,
    exitReason,exitTime,updatedAt:now};
}

export function summarizeShadowRecords(records){
  const all=Array.isArray(records)?records:[];
  const trades=all.filter(x=>x.status==="CLOSED");
  const open=all.filter(x=>x.status==="OPEN");
  const bySide={};
  for(const side of ["LONG","SHORT"]){
    const rows=trades.filter(x=>x.side===side),wins=rows.filter(x=>Number(x.realizedR)>0);
    bySide[side]={trades:rows.length,wins:wins.length,winRatePct:rows.length?wins.length/rows.length*100:0,
      expectancyR:rows.length?rows.reduce((s,x)=>s+Number(x.realizedR||0),0)/rows.length:0,
      avgMAE_R:rows.length?rows.reduce((s,x)=>s+Number(x.maxMaeR||0),0)/rows.length:null,
      medianTimeToProfitMin:median(rows.map(x=>x.timeToProfitMin))};
  }
  const wins=trades.filter(x=>Number(x.realizedR)>0);
  return {totalRecords:all.length,closedTrades:trades.length,openTrades:open.length,
    waiting:all.filter(x=>x.status==="WAITING").length,expired:all.filter(x=>x.status==="EXPIRED").length,
    winRatePct:trades.length?wins.length/trades.length*100:0,
    expectancyR:trades.length?trades.reduce((s,x)=>s+Number(x.realizedR||0),0)/trades.length:0,
    avgMAE_R:trades.length?trades.reduce((s,x)=>s+Number(x.maxMaeR||0),0)/trades.length:null,
    medianTimeToProfitMin:median(trades.map(x=>x.timeToProfitMin)),bySide};
}
function median(values){const a=values.filter(Number.isFinite).sort((x,y)=>x-y);return a.length?(a.length%2?a[(a.length-1)/2]:(a[a.length/2-1]+a[a.length/2])/2):null;}

import { mkdir, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";

import { analyzeFuturesSymbol, FUTURES_CONFIG } from "../src/index.js";

const BASE = "https://futures.kraken.com";
const INTERVALS = { "5m": 300000, "15m": 900000, "1h": 3600000, "4h": 14400000 };
const DAYS = Math.max(7, Math.min(180, Number(process.env.EQS_BACKTEST_DAYS || 30)));
const SYMBOL_LIMIT = Math.max(1, Math.min(15, Number(process.env.EQS_BACKTEST_SYMBOLS || 10)));
const WARMUP_DAYS = 55;
const HORIZONS = [15, 30, 60];
const BASELINE_PATH = process.env.EQS_BASELINE_MODULE || "/tmp/eqs-baseline/src/index.js";
const baselineModule = await import(pathToFileURL(path.resolve(BASELINE_PATH)).href);
const baselineAnalyze = baselineModule.analyzeFuturesSymbol;
const baselineConfig = baselineModule.FUTURES_CONFIG;
if (typeof baselineAnalyze !== "function" || !baselineConfig) throw new Error("Baseline analyzer/config could not be loaded.");

async function getJson(url, attempt = 0) {
  const response = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(30000) });
  const body = await response.text();
  if (!response.ok) {
    if (attempt < 3 && (response.status === 429 || response.status >= 500)) {
      await new Promise(resolve => setTimeout(resolve, 800 * (attempt + 1)));
      return getJson(url, attempt + 1);
    }
    throw new Error("HTTP " + response.status + " for " + url + ": " + body.slice(0, 180));
  }
  const data = JSON.parse(body);
  if (data?.result === "error" || (Array.isArray(data?.errors) && data.errors.length)) throw new Error("Kraken API error: " + JSON.stringify(data.errors || data.error));
  return data;
}
function normalizeCandles(rows, intervalMs) {
  if (!Array.isArray(rows)) throw new Error("Kraken candles array missing");
  const seen = new Set();
  return rows.map(row => ({
    time: Number(row.time) < 1e12 ? Number(row.time) * 1000 : Number(row.time),
    open: Number(row.open), high: Number(row.high), low: Number(row.low),
    close: Number(row.close), volume: Number(row.volume)
  })).filter(c => Number.isFinite(c.time) &&
    [c.open,c.high,c.low,c.close,c.volume].every(Number.isFinite) &&
    c.open > 0 && c.close > 0 && c.low > 0 && c.high >= c.low && c.volume >= 0 &&
    c.time + intervalMs <= Date.now()).sort((a,b)=>a.time-b.time).filter(c => {
      if (seen.has(c.time)) return false; seen.add(c.time); return true;
    });
}
async function fetchCandles(symbol, resolution, fromMs, toMs) {
  const intervalMs = INTERVALS[resolution], chunkMs = intervalMs * 1700, all = [];
  for (let start = fromMs; start < toMs; start += chunkMs) {
    const end = Math.min(toMs, start + chunkMs);
    const url = new URL(BASE + "/api/charts/v1/trade/" + encodeURIComponent(symbol) + "/" + resolution);
    url.searchParams.set("from", String(Math.floor(start / 1000)));
    url.searchParams.set("to", String(Math.floor(end / 1000)));
    url.searchParams.set("count", "1800");
    const data = await getJson(url);
    if (data.more_candles === true) throw new Error(symbol + " " + resolution + ": Kraken returned incomplete candle chunk");
    all.push(...normalizeCandles(data.candles, intervalMs));
  }
  const byTime = new Map(all.map(c=>[c.time,c]));
  return [...byTime.values()].sort((a,b)=>a.time-b.time);
}
function lowerBound(xs, time) {
  let lo=0, hi=xs.length;
  while(lo<hi){const mid=(lo+hi)>>1;if(xs[mid].time<time)lo=mid+1;else hi=mid;}
  return lo;
}
function historicalChange(candles, i) {
  const old=candles[i-24], now=candles[i];
  return !old || old.close<=0 ? 0 : (now.close/old.close-1)*100;
}
// Kraken trade candles expose base-asset quantity. Estimate historical USD
// quote turnover from closed hourly volume * close, never today's ticker volume.
function historicalQuoteVolume(candles, i) {
  if (i < 23) return 0;
  let total = 0;
  for (let k=i-23;k<=i;k++) total += Number(candles[k].volume) * Number(candles[k].close);
  return Number.isFinite(total) ? total : 0;
}
function cleanLegacy(value) {
  if (Array.isArray(value)) return value.map(cleanLegacy);
  if (!value || typeof value !== "object") return value;
  const omit = new Set(["eqsMomentumState","eqsPullbackState","eqsMomentumStateV2","eqsPullbackStateV2","entryQualityScore","entryQualityRaw","entryQualityDetails","entryQualityAvailableFactors","entryQualityScoreV2","entryQualityRawV2","entryQualityDetailsV2","entryQualityAvailableFactorsV2","entryQualityScoreV3","entryQualityRawV3","entryQualityDetailsV3","entryQualityAvailableFactorsV3","entryTimingScore","entryTimingRaw","entryTimingDetails","entryTimingAvailableFactors"]);
  return Object.fromEntries(Object.entries(value).filter(([k])=>!omit.has(k)).map(([k,v])=>[k,cleanLegacy(v)]));
}
function stable(value) { return JSON.stringify(value, (_k,v)=>typeof v==="number" ? Number(v.toPrecision(12)) : v); }
function parityDiff(base, exp) {
  const fields=["side","eligible","highRiskEligible","riskLevel","price","entry","stop","target1","target2","target3",
    "rewardRisk","score","baseScore","priorityScore","volumePriorityBonus","fourHourScoreAdjustment",
    "confirmationPriorityBonus","confirmationCount","momentumConfirmed","pullbackConfirmed","rsi","ema20","ema50",
    "atr","volumeRatio","funding","quoteVolume","change24h","candleTime","entryDiagnostics"];
  const diffs=[];
  for(const field of fields){
    const a=cleanLegacy(base?.[field]), b=cleanLegacy(exp?.[field]);
    if(stable(a)!==stable(b)) diffs.push({field,base:a,experiment:b});
  }
  return diffs;
}
function measureExcursion(side, entry, bars, start, end) {
  const window=bars.slice(start,end);
  if(!window.length) return null;
  const highest=Math.max(...window.map(c=>c.high)), lowest=Math.min(...window.map(c=>c.low));
  const adversePct=side==="LONG" ? (entry-lowest)/entry*100 : (highest-entry)/entry*100;
  const favorablePct=side==="LONG" ? (highest-entry)/entry*100 : (entry-lowest)/entry*100;
  return {maePct:Math.max(0,adversePct),mfePct:Math.max(0,favorablePct)};
}
function measureEntryHeat(side, entry, bars, start, end, signalClose, thresholdPct=0.1) {
  let firstFavorableIndex=-1;
  const threshold=thresholdPct/100;
  for(let i=start;i<end;i++){
    const favorableClose=side==="LONG"
      ? bars[i].close>=entry*(1+threshold)
      : bars[i].close<=entry*(1-threshold);
    if(favorableClose){firstFavorableIndex=i;break;}
  }
  const lastExclusive=firstFavorableIndex>=0?firstFavorableIndex+1:end;
  const window=bars.slice(start,lastExclusive);
  if(!window.length)return null;
  const highest=Math.max(...window.map(x=>x.high)),lowest=Math.min(...window.map(x=>x.low));
  const maePct=Math.max(0,side==="LONG"?(entry-lowest)/entry*100:(highest-entry)/entry*100);
  return {maeBeforeFavorablePct:maePct,reached:firstFavorableIndex>=0,
    timeToFavorableCloseMinutes:firstFavorableIndex>=0
      ? (bars[firstFavorableIndex].time+INTERVALS["5m"]-signalClose)/60000 : null};
}
function simulateTradeLifecycle(side,entry,initialStop,targets,bars,start,end,moveStopToBreakeven=false){
  const risk=Math.abs(entry-initialStop);
  if(!(risk>0)||!targets.every(Number.isFinite))return null;
  const direction=side==="LONG"?1:-1;
  let remaining=1, realizedR=0, targetHits=0, activeStop=initialStop, exitReason="TIME_EXIT";
  let barsHeld=0;
  for(let i=start;i<end&&remaining>1e-9;i++){
    const bar=bars[i]; if(!bar)break;
    barsHeld++;
    const stopTouched=side==="LONG"?bar.low<=activeStop:bar.high>=activeStop;
    if(stopTouched){
      realizedR+=remaining*((activeStop-entry)*direction/risk);
      remaining=0;
      exitReason=moveStopToBreakeven&&targetHits>0?"BREAKEVEN_STOP":"STOP";
      break;
    }
    const target=targets[targetHits];
    if(target!==undefined){
      const targetTouched=side==="LONG"?bar.high>=target:bar.low<=target;
      if(targetTouched){
        realizedR+=(1/3)*((target-entry)*direction/risk);
        remaining-=1/3;
        targetHits++;
        if(targetHits===3){remaining=0;exitReason="ALL_TARGETS";}
        else if(moveStopToBreakeven&&targetHits>=1)activeStop=entry;
        // At most one target per 5m candle: intrabar ordering is unknown.
      }
    }
  }
  if(remaining>1e-9){
    const last=bars[Math.max(start,Math.min(end-1,bars.length-1))];
    if(!last)return null;
    realizedR+=remaining*((last.close-entry)*direction/risk);
  }
  return {netR:realizedR,targetHits,exitReason,barsHeld,remainingAtHorizon:remaining};
}
function summarizeTrades(rows,key){
  const xs=rows.map(x=>x[key]).filter(Boolean);
  if(!xs.length)return {trades:0};
  const rs=xs.map(x=>x.netR).filter(Number.isFinite);
  const wins=rs.filter(x=>x>0),losses=rs.filter(x=>x<0);
  const sumWin=wins.reduce((s,x)=>s+x,0),sumLoss=Math.abs(losses.reduce((s,x)=>s+x,0));
  const sorted=[...rs].sort((a,b)=>a-b);
  return {trades:rs.length,avgR:rs.reduce((s,x)=>s+x,0)/rs.length,
    medianR:sorted[Math.floor((sorted.length-1)/2)],
    winRatePct:wins.length/rs.length*100,lossRatePct:losses.length/rs.length*100,
    profitFactorR:sumLoss>0?sumWin/sumLoss:null,
    stopRatePct:xs.filter(x=>x.exitReason==="STOP").length/xs.length*100,
    breakevenStopRatePct:xs.filter(x=>x.exitReason==="BREAKEVEN_STOP").length/xs.length*100,
    allTargetsRatePct:xs.filter(x=>x.exitReason==="ALL_TARGETS").length/xs.length*100,
    timeExitRatePct:xs.filter(x=>x.exitReason==="TIME_EXIT").length/xs.length*100,
    tp1RatePct:xs.filter(x=>x.targetHits>=1).length/xs.length*100,
    tp2RatePct:xs.filter(x=>x.targetHits>=2).length/xs.length*100,
    tp3RatePct:xs.filter(x=>x.targetHits>=3).length/xs.length*100,
    avgBarsHeld:xs.reduce((s,x)=>s+x.barsHeld,0)/xs.length};
}
function summarize(rows) {
  const avg=(xs,key)=>{
    const vals=xs.map(x=>x[key]).filter(Number.isFinite);
    return vals.length?vals.reduce((s,x)=>s+x,0)/vals.length:null;
  };
  const p=(xs,key)=>{const vals=xs.map(x=>x[key]).filter(Number.isFinite).sort((a,b)=>a-b);
    return vals.length?vals[Math.floor((vals.length-1)*0.95)]:null;};
  const maeAvgPct=avg(rows,"maePct"), mfeAvgPct=avg(rows,"mfePct"), stopAvgPct=avg(rows,"stopDistancePct");
  return {count:rows.length,maeAvgPct,maeP95Pct:p(rows,"maePct"),
    mfeAvgPct,mfeP95Pct:p(rows,"mfePct"),stopDistanceAvgPct:stopAvgPct,
    maeToStopRatio:maeAvgPct!==null&&stopAvgPct>0?maeAvgPct/stopAvgPct:null,
    mfeMaeRatio:maeAvgPct>0&&mfeAvgPct!==null?mfeAvgPct/maeAvgPct:null,
    maeBeforeFavorableAvgPct:avg(rows,"maeBeforeFavorablePct"),
    maeBeforeFavorableP95Pct:p(rows,"maeBeforeFavorablePct"),
    maeBeforeFavorableToStopAvg:avg(rows,"maeBeforeFavorableToStopRatio"),
    favorableCloseRatePct:rows.length?rows.filter(x=>x.reachedFirstFavorableClose).length/rows.length*100:null,
    timeToFavorableCloseAvgMin:avg(rows,"timeToFirstFavorableCloseMinutes")};
}
async function main() {
  const endMs=Date.now(), startMs=endMs-DAYS*86400000, fromMs=startMs-WARMUP_DAYS*86400000;
  const tickerData=await getJson(BASE+"/derivatives/api/v3/tickers");
  if(!Array.isArray(tickerData?.tickers)) throw new Error("Kraken tickers response invalid");
  const universe=tickerData.tickers.filter(t=>t?.tag==="perpetual"&&t.suspended!==true&&
    /^PF_[A-Z0-9]+USD$/.test(String(t.symbol||""))&&
    Number(t.last)>0)
    .sort((a,b)=>Number(b.volumeQuote)-Number(a.volumeQuote)).slice(0,SYMBOL_LIMIT);
  if(!universe.length) throw new Error("No eligible Kraken perpetual contracts found");

  const records=[], symbolResults=[];
  for(const ticker of universe){
    try{
      const [h1,h4,m15,m5]=await Promise.all([
        fetchCandles(ticker.symbol,"1h",fromMs,endMs),fetchCandles(ticker.symbol,"4h",fromMs,endMs),
        fetchCandles(ticker.symbol,"15m",fromMs,endMs),fetchCandles(ticker.symbol,"5m",fromMs,endMs)
      ]);
      if(h1.length<100||h4.length<FUTURES_CONFIG.MIN_CANDLES||m15.length<120||m5.length<500)
        throw new Error("insufficient history: 1h="+h1.length+", 4h="+h4.length+", 15m="+m15.length+", 5m="+m5.length);
      let fourIndex=0, fifteenIndex=0, accepted=0, parityMismatches=0, eligibleBase=0, eligibleExp=0;
      const local=[];
      for(let i=60;i<h1.length-1;i++){
        const signalBar=h1[i], signalClose=signalBar.time+INTERVALS["1h"];
        if(signalClose<startMs||signalClose>=endMs) continue;
        while(fourIndex<h4.length&&h4[fourIndex].time+INTERVALS["4h"]<=signalClose)fourIndex++;
        while(fifteenIndex<m15.length&&m15[fifteenIndex].time+INTERVALS["15m"]<=signalClose)fifteenIndex++;
        const closed4h=h4.slice(0,fourIndex), closed15m=m15.slice(Math.max(0,fifteenIndex-120),fifteenIndex);
        if(closed4h.length<FUTURES_CONFIG.MIN_CANDLES||closed15m.length<40)continue;
        const next=h1[i+1], commonTicker={symbol:ticker.symbol,last:next.open,quoteVolume:historicalQuoteVolume(h1,i),
          priceChangePercent:historicalChange(h1,i),premium:{lastFundingRate:null}};
        let base,exp;
        try{
          base=baselineAnalyze(commonTicker,h1.slice(0,i+1),closed4h,closed15m);
          exp=analyzeFuturesSymbol(commonTicker,h1.slice(0,i+1),closed4h,closed15m);
        }catch{continue;}
        accepted++;
        const diffs=parityDiff(base,exp);
        if(diffs.length)parityMismatches++;
        if(base?.eligible===true)eligibleBase++;
        if(exp?.eligible===true)eligibleExp++;
        if(exp?.eligible!==true||!["LONG","SHORT"].includes(exp.side))continue;
        const entry=Number(exp.entry);
        if(!Number.isFinite(entry)||entry<=0)continue;
        const begin=lowerBound(m5,signalClose), horizons={};
        const maxEnd=signalClose+60*60000;
        const endIndex=lowerBound(m5,maxEnd);
        for(const mins of HORIZONS){
          const stopIndex=lowerBound(m5,signalClose+mins*60000);
          horizons[mins]=measureExcursion(exp.side,entry,m5,begin,stopIndex);
        }
        const full=measureExcursion(exp.side,entry,m5,begin,endIndex);
        if(!full)continue;
        const stopDistancePct=Math.abs(entry-Number(exp.stop))/entry*100;
        const entryHeat=measureEntryHeat(exp.side,entry,m5,begin,endIndex,signalClose,0.1);
        const lifecycleEnd=lowerBound(m5,signalClose+24*60*60000);
        const lifecycleComplete=lifecycleEnd>begin&&m5[lifecycleEnd-1]?.time+INTERVALS["5m"]>=signalClose+24*60*60000;
        const targets=[Number(exp.target1),Number(exp.target2),Number(exp.target3)];
        const tradeFixed=lifecycleComplete?simulateTradeLifecycle(exp.side,entry,Number(exp.stop),targets,m5,begin,lifecycleEnd,false):null;
        const tradeBreakeven=lifecycleComplete?simulateTradeLifecycle(exp.side,entry,Number(exp.stop),targets,m5,begin,lifecycleEnd,true):null;
        const row={symbol:ticker.symbol,side:exp.side,signalTime:signalClose,entry,score:exp.score,
          priorityScore:Number.isFinite(Number(exp.priorityScore))?Number(exp.priorityScore):null,
          entryQualityScore:exp.entryQualityScore??null,entryQualityRaw:exp.entryQualityRaw??null,
          entryQualityAvailableFactors:exp.entryQualityAvailableFactors??0,entryQualityDetails:exp.entryQualityDetails??null,
          entryQualityScoreV2:exp.entryQualityScoreV2??null,entryQualityRawV2:exp.entryQualityRawV2??null,
          entryQualityDetailsV2:exp.entryQualityDetailsV2??null,entryQualityScoreV3:exp.entryQualityScoreV3??null,entryQualityRawV3:exp.entryQualityRawV3??null,entryQualityDetailsV3:exp.entryQualityDetailsV3??null,entryTimingScore:exp.entryTimingScore??null,entryTimingRaw:exp.entryTimingRaw??null,entryTimingDetails:exp.entryTimingDetails??null,entryTimingRegimeScore:exp.entryTimingRegimeScore??null,entryTimingRegimeAdjustment:exp.entryTimingRegimeAdjustment??null,
          riskLevel:exp.riskLevel??null,stop:Number(exp.stop),target1:targets[0],target2:targets[1],target3:targets[2],stopDistancePct,
          tradeFixed,tradeBreakeven,lifecycleHorizonHours:24,
          historicalQuoteVolume:commonTicker.quoteVolume,horizons,maePct:full.maePct,mfePct:full.mfePct,
          maeBeforeFavorablePct:entryHeat?.maeBeforeFavorablePct??null,
          maeBeforeFavorableToStopRatio:entryHeat&&stopDistancePct>0?entryHeat.maeBeforeFavorablePct/stopDistancePct:null,
          reachedFirstFavorableClose:entryHeat?.reached??false,
          timeToFirstFavorableCloseMinutes:entryHeat?.timeToFavorableCloseMinutes??null,
          legacyParity:diffs.length===0,parityDiffs:diffs};
        local.push(row); records.push(row);
      }
      symbolResults.push({symbol:ticker.symbol,candles:{h1:h1.length,h4:h4.length,m15:m15.length,m5:m5.length},
        evaluatedOpportunities:accepted,eligibleBase,eligibleExperiment:eligibleExp,legacyParityMismatches:parityMismatches,
        measuredSignals:local.length});
    }catch(error){symbolResults.push({symbol:ticker.symbol,error:String(error?.message||error)});}
  }
  const parityRows=records.filter(r=>r.legacyParity), bySide={};
  for(const side of ["LONG","SHORT"]){
    const xs=records.filter(r=>r.side===side);
    bySide[side]={signals:xs.length,maeMfe60m:summarize(xs),
      mae15mAvgPct:xs.filter(x=>x.horizons[15]).length?xs.filter(x=>x.horizons[15]).reduce((s,x)=>s+x.horizons[15].maePct,0)/xs.filter(x=>x.horizons[15]).length:null,
      mae30mAvgPct:xs.filter(x=>x.horizons[30]).length?xs.filter(x=>x.horizons[30]).reduce((s,x)=>s+x.horizons[30].maePct,0)/xs.filter(x=>x.horizons[30]).length:null,
      mae60mAvgPct:xs.filter(x=>x.horizons[60]).length?xs.filter(x=>x.horizons[60]).reduce((s,x)=>s+x.horizons[60].maePct,0)/xs.filter(x=>x.horizons[60]).length:null};
  }
  const bucketFor = score => score==null ? "UNAVAILABLE" : score<40 ? "LOW_0_39" : score<70 ? "MID_40_69" : "HIGH_70_100";
  const bucketLabels=["LOW_0_39","MID_40_69","HIGH_70_100","UNAVAILABLE"];
  const byEqsBucket={}, byEqsBucketAndSide={}, byEqsV2Bucket={}, byEqsV2BucketAndSide={}, byEqsV3Bucket={}, byEqsV3BucketAndSide={}, byTimingBucket={}, byTimingBucketAndSide={}, byTimingRegimeBucket={}, byTimingRegimeBucketAndSide={};
  for(const label of bucketLabels){
    const xs=records.filter(r=>bucketFor(r.entryQualityScore)===label);
    byEqsBucket[label]={signals:xs.length,...summarize(xs)};
    const v2=records.filter(r=>bucketFor(r.entryQualityScoreV2)===label);
    byEqsV2Bucket[label]={signals:v2.length,...summarize(v2)};
    const v3=records.filter(r=>bucketFor(r.entryQualityScoreV3)===label);
    byEqsV3Bucket[label]={signals:v3.length,...summarize(v3)};
    const timing=records.filter(r=>bucketFor(r.entryTimingScore)===label);
    byTimingBucket[label]={signals:timing.length,...summarize(timing)};
    const regime=records.filter(r=>bucketFor(r.entryTimingRegimeScore)===label);
    byTimingRegimeBucket[label]={signals:regime.length,...summarize(regime)};
  }
  for(const side of ["LONG","SHORT"]){
    byEqsBucketAndSide[side]={}; byEqsV2BucketAndSide[side]={}; byEqsV3BucketAndSide[side]={}; byTimingBucketAndSide[side]={}; byTimingRegimeBucketAndSide[side]={};
    for(const label of bucketLabels){
      const xs=records.filter(r=>r.side===side&&bucketFor(r.entryQualityScore)===label);
      byEqsBucketAndSide[side][label]={signals:xs.length,...summarize(xs)};
      const v2=records.filter(r=>r.side===side&&bucketFor(r.entryQualityScoreV2)===label);
      byEqsV2BucketAndSide[side][label]={signals:v2.length,...summarize(v2)};
      const v3=records.filter(r=>r.side===side&&bucketFor(r.entryQualityScoreV3)===label);
      byEqsV3BucketAndSide[side][label]={signals:v3.length,...summarize(v3)};
      const timing=records.filter(r=>r.side===side&&bucketFor(r.entryTimingScore)===label);
      byTimingBucketAndSide[side][label]={signals:timing.length,...summarize(timing)};
      const regime=records.filter(r=>r.side===side&&bucketFor(r.entryTimingRegimeScore)===label);
      byTimingRegimeBucketAndSide[side][label]={signals:regime.length,...summarize(regime)};
    }
  }
  // Shadow ranking only: preserve the live priorityScore and simulate a small
  // side-specific adjustment for SHORT candidates. LONG candidates are unchanged.
  // No signal is rejected; this only changes ordering within the same scan timestamp.
  const clamp=(x,min,max)=>Math.max(min,Math.min(max,x));
  const shortTimingAdjustment=(score,strength)=>{
    if(!Number.isFinite(score)) return 0;
    if(score<40) return -strength*clamp((40-score)/40,0,1);
    if(score>=70) return strength*clamp((score-70)/30,0,1);
    return 0;
  };
  const rankingGroups=new Map();
  for(const row of records){
    if(!Number.isFinite(row.priorityScore)) continue;
    const key=row.signalTime;
    if(!rankingGroups.has(key)) rankingGroups.set(key,[]);
    rankingGroups.get(key).push(row);
  }
  const rankingVariants=[];
  for(const strength of [1.5,3]){
    for(const topN of [1,3,5]){
      const baselineSelected=[], shadowSelected=[]; let groupsWithEnough=0, changedGroups=0, changedSelections=0;
      for(const candidates of rankingGroups.values()){
        if(candidates.length<topN) continue;
        groupsWithEnough++;
        const baseline=[...candidates].sort((a,b)=>b.priorityScore-a.priorityScore||a.symbol.localeCompare(b.symbol)).slice(0,topN);
        const shadow=[...candidates].sort((a,b)=>{
          const as=a.priorityScore+(a.side==="SHORT"?shortTimingAdjustment(a.entryTimingRegimeScore,strength):0);
          const bs=b.priorityScore+(b.side==="SHORT"?shortTimingAdjustment(b.entryTimingRegimeScore,strength):0);
          return bs-as||a.symbol.localeCompare(b.symbol);
        }).slice(0,topN);
        const baselineIds=baseline.map(x=>x.symbol).sort().join("|");
        const shadowIds=shadow.map(x=>x.symbol).sort().join("|");
        if(baselineIds!==shadowIds){changedGroups++;changedSelections+=shadow.filter(x=>!baseline.some(y=>y.symbol===x.symbol)).length;}
        baselineSelected.push(...baseline); shadowSelected.push(...shadow);
      }
      const sideStats={};
      for(const side of ["LONG","SHORT"]){
        const baseSide=baselineSelected.filter(x=>x.side===side),shadowSide=shadowSelected.filter(x=>x.side===side);
        sideStats[side]={baseline:summarize(baseSide),shadow:summarize(shadowSide),
          fixedStopBaseline:summarizeTrades(baseSide,"tradeFixed"),fixedStopShadow:summarizeTrades(shadowSide,"tradeFixed"),
          breakevenBaseline:summarizeTrades(baseSide,"tradeBreakeven"),breakevenShadow:summarizeTrades(shadowSide,"tradeBreakeven")};
      }
      rankingVariants.push({strengthPoints:strength,topNPerTimestamp:topN,scanTimestampsWithEnoughCandidates:groupsWithEnough,
        baselineSelected:baselineSelected.length,shadowSelected:shadowSelected.length,changedGroups,
        changedSelectionCount:changedSelections,baseline:summarize(baselineSelected),shadow:summarize(shadowSelected),bySide:sideStats,
        fixedStopBaseline:summarizeTrades(baselineSelected,"tradeFixed"),fixedStopShadow:summarizeTrades(shadowSelected,"tradeFixed"),
        breakevenBaseline:summarizeTrades(baselineSelected,"tradeBreakeven"),breakevenShadow:summarizeTrades(shadowSelected,"tradeBreakeven")});
    }
  }
  const rankingSimulation={mode:"diagnostic_shadow_only",livePriorityScoreModified:false,signalsRejected:0,
    adjustment:"SHORT only: timing score <40 receives a proportional penalty up to strengthPoints; score >=70 receives a proportional bonus up to strengthPoints; 40-69 unchanged; LONG unchanged",
    tradeModel:{horizonHours:24,partialTargets:"one third at each of 1.5R, 2.5R, 3.5R",policies:["fixed original stop","move remaining stop to breakeven after TP1"],sameBarAmbiguity:"stop first; at most one target per 5m candle",timeExit:"mark remaining position to final 5m close",costs:"fees, funding, slippage excluded"},
    candidateTimestamps:rankingGroups.size,variants:rankingVariants};
  const report={generatedAt:new Date().toISOString(),venue:"Kraken Futures public historical OHLC",
    period:{from:new Date(startMs).toISOString(),to:new Date(endMs).toISOString(),days:DAYS,warmupDays:WARMUP_DAYS},
    methodology:{sameDataAndTimestamps:true,closedCandlesOnly:true,historicalQuoteVolume:"rolling 24h sum of hourly base volume * close (approximate USD turnover)",signalAt:"closed 1h candle",entry:"next 1h candle open",
      excursionResolution:"5m OHLC",horizonsMinutes:HORIZONS,mae:"maximum adverse price excursion from entry",entryHeat:"maximum adverse excursion until first 5m close at least 0.1% favorable; if not reached, through 60m",
      mfe:"maximum favorable price excursion from entry",legacyParityFields:"signal side, eligibility, entry/stop/targets, score/priority and legacy entry diagnostics",
      ambiguity:"MAE/MFE are range excursions, not simulated stop/target fills",universe:"top current Kraken PF linear perpetuals by current quote volume; current-listing/current-volume survivorship bias applies",
      costs:"fees, funding, slippage excluded",exitModel:"24h lifecycle: 1/3 at 1.5R, 1/3 at 2.5R, 1/3 at 3.5R; conservative stop-first same-candle ordering; two stop policies tested",rankingSimulation:"same-timestamp top-N shadow ranking; no live priorityScore mutation, no signal rejection; SHORT timing-only adjustment tested at +/-1.5 and +/-3 points; LONG unchanged",entryTimingScore:"RSI + 1h EMA20 distance + direction-specific pullback + inverse 15m momentum confirmation + 15m EMA9 extension; excludes 4h trend alignment"},
    symbolsRequested:SYMBOL_LIMIT,symbolsTested:symbolResults.filter(x=>!x.error).length,symbolResults,
    opportunitiesCompared:symbolResults.reduce((s,x)=>s+(x.evaluatedOpportunities||0),0),
    measuredSignals:records.length,legacyParityMismatches:symbolResults.reduce((s,x)=>s+(x.legacyParityMismatches||0),0),
    legacyParityMatchRatePct:symbolResults.reduce((s,x)=>s+(x.evaluatedOpportunities||0),0)?(1-symbolResults.reduce((s,x)=>s+(x.legacyParityMismatches||0),0)/symbolResults.reduce((s,x)=>s+(x.evaluatedOpportunities||0),0))*100:null,
    bySide,byEqsBucket,byEqsBucketAndSide,byEqsV2Bucket,byEqsV2BucketAndSide,byEqsV3Bucket,byEqsV3BucketAndSide,byTimingBucket,byTimingBucketAndSide,byTimingRegimeBucket,byTimingRegimeBucketAndSide,rankingSimulation,signals:records};
  await mkdir("artifacts",{recursive:true});
  await writeFile("artifacts/eqs-diagnostics.json",JSON.stringify(report,null,2));
  const md=["# EQS 5m diagnostic backtest","",
    "Period: "+report.period.from+" — "+report.period.to+" ("+DAYS+" days)",
    "Symbols tested: "+report.symbolsTested+"/"+SYMBOL_LIMIT,
    "Measured eligible experiment signals: "+report.measuredSignals,
    "Legacy parity mismatches: "+report.legacyParityMismatches,
    "Legacy parity match rate: "+(report.legacyParityMatchRatePct==null?"n/a":report.legacyParityMatchRatePct.toFixed(2)+"%"),"",
    "| Side | Signals | MAE avg 60m | MAE P95 60m | MFE avg 60m | MFE P95 60m | MAE avg 15m | MAE avg 30m | MAE avg 60m |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|",
    ...["LONG","SHORT"].map(s=>{const x=bySide[s],m=x.maeMfe60m;return "| "+s+" | "+x.signals+" | "+(m.maeAvgPct?.toFixed(3)??"n/a")+"% | "+(m.maeP95Pct?.toFixed(3)??"n/a")+"% | "+(m.mfeAvgPct?.toFixed(3)??"n/a")+"% | "+(m.mfeP95Pct?.toFixed(3)??"n/a")+"% | "+(x.mae15mAvgPct?.toFixed(3)??"n/a")+"% | "+(x.mae30mAvgPct?.toFixed(3)??"n/a")+"% | "+(x.mae60mAvgPct?.toFixed(3)??"n/a")+"% |";}),
    "","## EQS buckets","",
    "| Bucket | Signals | MAE avg | MAE P95 | MFE avg | MFE P95 | MAE / avg stop | avg MFE / avg MAE |",
    "|---|---:|---:|---:|---:|---:|---:|---:|",
    ...Object.entries(byEqsBucket).map(([k,x])=>"| "+k+" | "+x.count+" | "+(x.maeAvgPct?.toFixed(3)??"n/a")+"% | "+(x.maeP95Pct?.toFixed(3)??"n/a")+"% | "+(x.mfeAvgPct?.toFixed(3)??"n/a")+"% | "+(x.mfeP95Pct?.toFixed(3)??"n/a")+"% | "+(x.maeToStopRatio?.toFixed(3)??"n/a")+" | "+(x.mfeMaeRatio?.toFixed(3)??"n/a")+" |"),
    "","## EQS buckets by side (do not pool LONG and SHORT)","",
    "| Side | Bucket | Signals | MAE avg | MAE P95 | MFE avg | MFE P95 | MAE / avg stop | avg MFE / avg MAE |",
    "|---|---|---:|---:|---:|---:|---:|---:|---:|",
    ...["LONG","SHORT"].flatMap(side=>Object.entries(byEqsBucketAndSide[side]).map(([bucket,x])=>"| "+side+" | "+bucket+" | "+x.signals+" | "+(x.maeAvgPct?.toFixed(3)??"n/a")+"% | "+(x.maeP95Pct?.toFixed(3)??"n/a")+"% | "+(x.mfeAvgPct?.toFixed(3)??"n/a")+"% | "+(x.mfeP95Pct?.toFixed(3)??"n/a")+"% | "+(x.maeToStopRatio?.toFixed(3)??"n/a")+" | "+(x.mfeMaeRatio?.toFixed(3)??"n/a")+" |")),
    "","## EQS v2 buckets (strict EMA9 reclaim; diagnostic only)","",
    "| Bucket | Signals | MAE avg | MAE P95 | MFE avg | MFE P95 | MAE / avg stop | avg MFE / avg MAE |",
    "|---|---:|---:|---:|---:|---:|---:|---:|",
    ...Object.entries(byEqsV2Bucket).map(([k,x])=>"| "+k+" | "+x.signals+" | "+(x.maeAvgPct?.toFixed(3)??"n/a")+"% | "+(x.maeP95Pct?.toFixed(3)??"n/a")+"% | "+(x.mfeAvgPct?.toFixed(3)??"n/a")+"% | "+(x.mfeP95Pct?.toFixed(3)??"n/a")+"% | "+(x.maeToStopRatio?.toFixed(3)??"n/a")+" | "+(x.mfeMaeRatio?.toFixed(3)??"n/a")+" |"),
    "","## EQS v2 buckets by side","",
    "| Side | Bucket | Signals | MAE avg | MAE P95 | MFE avg | MFE P95 | MAE / avg stop | avg MFE / avg MAE |",
    "|---|---|---:|---:|---:|---:|---:|---:|---:|",
    ...["LONG","SHORT"].flatMap(side=>Object.entries(byEqsV2BucketAndSide[side]).map(([bucket,x])=>"| "+side+" | "+bucket+" | "+x.signals+" | "+(x.maeAvgPct?.toFixed(3)??"n/a")+"% | "+(x.maeP95Pct?.toFixed(3)??"n/a")+"% | "+(x.mfeAvgPct?.toFixed(3)??"n/a")+"% | "+(x.mfeP95Pct?.toFixed(3)??"n/a")+"% | "+(x.maeToStopRatio?.toFixed(3)??"n/a")+" | "+(x.mfeMaeRatio?.toFixed(3)??"n/a")+" |")),
    "","## EQS v3 buckets (direction-aware LONG adjustment; diagnostic only)","",
    "| Bucket | Signals | MAE avg | MAE P95 | MFE avg | MFE P95 | MAE / avg stop | avg MFE / avg MAE |",
    "|---|---:|---:|---:|---:|---:|---:|---:|",
    ...Object.entries(byEqsV3Bucket).map(([k,x])=>"| "+k+" | "+x.signals+" | "+(x.maeAvgPct?.toFixed(3)??"n/a")+"% | "+(x.maeP95Pct?.toFixed(3)??"n/a")+"% | "+(x.mfeAvgPct?.toFixed(3)??"n/a")+"% | "+(x.mfeP95Pct?.toFixed(3)??"n/a")+"% | "+(x.maeToStopRatio?.toFixed(3)??"n/a")+" | "+(x.mfeMaeRatio?.toFixed(3)??"n/a")+" |"),
    "","## EQS v3 buckets by side","",
    "| Side | Bucket | Signals | MAE avg | MAE P95 | MFE avg | MFE P95 | MAE / avg stop | avg MFE / avg MAE |",
    "|---|---|---:|---:|---:|---:|---:|---:|---:|",
    ...["LONG","SHORT"].flatMap(side=>Object.entries(byEqsV3BucketAndSide[side]).map(([bucket,x])=>"| "+side+" | "+bucket+" | "+x.signals+" | "+(x.maeAvgPct?.toFixed(3)??"n/a")+"% | "+(x.maeP95Pct?.toFixed(3)??"n/a")+"% | "+(x.mfeAvgPct?.toFixed(3)??"n/a")+"% | "+(x.mfeP95Pct?.toFixed(3)??"n/a")+"% | "+(x.maeToStopRatio?.toFixed(3)??"n/a")+" | "+(x.mfeMaeRatio?.toFixed(3)??"n/a")+" |")),
    "","## Entry timing score (MAE-oriented; no 4h trend bonus)","",
    "| Bucket | Signals | MAE before +0.1% close | 95p heat | Reach rate | Avg time | MAE / avg stop | MFE / MAE |",
    "|---|---:|---:|---:|---:|---:|---:|---:|",
    ...Object.entries(byTimingBucket).map(([k,x])=>"| "+k+" | "+x.signals+" | "+(x.maeBeforeFavorableAvgPct?.toFixed(3)??"n/a")+"% | "+(x.maeBeforeFavorableP95Pct?.toFixed(3)??"n/a")+"% | "+(x.favorableCloseRatePct?.toFixed(1)??"n/a")+"% | "+(x.timeToFavorableCloseAvgMin?.toFixed(1)??"n/a")+"m | "+(x.maeToStopRatio?.toFixed(3)??"n/a")+" | "+(x.mfeMaeRatio?.toFixed(3)??"n/a")+" |"),
    "","## Entry timing score by side","",
    "| Side | Bucket | Signals | MAE before +0.1% close | 95p heat | Reach rate | Avg time | MAE / avg stop | MFE / MAE |",
    "|---|---|---:|---:|---:|---:|---:|---:|---:|",
    ...["LONG","SHORT"].flatMap(side=>Object.entries(byTimingBucketAndSide[side]).map(([bucket,x])=>"| "+side+" | "+bucket+" | "+x.signals+" | "+(x.maeBeforeFavorableAvgPct?.toFixed(3)??"n/a")+"% | "+(x.maeBeforeFavorableP95Pct?.toFixed(3)??"n/a")+"% | "+(x.favorableCloseRatePct?.toFixed(1)??"n/a")+"% | "+(x.timeToFavorableCloseAvgMin?.toFixed(1)??"n/a")+"m | "+(x.maeToStopRatio?.toFixed(3)??"n/a")+" | "+(x.mfeMaeRatio?.toFixed(3)??"n/a")+" |")),
    "","## Regime-adjusted entry timing score (4h bearish +10 / bullish -10)","",
    "| Bucket | Signals | MAE before +0.1% close | 95p heat | Reach rate | Avg time | MAE / avg stop | MFE / MAE |",
    "|---|---:|---:|---:|---:|---:|---:|---:|",
    ...Object.entries(byTimingRegimeBucket).map(([k,x])=>"| "+k+" | "+x.signals+" | "+(x.maeBeforeFavorableAvgPct?.toFixed(3)??"n/a")+"% | "+(x.maeBeforeFavorableP95Pct?.toFixed(3)??"n/a")+"% | "+(x.favorableCloseRatePct?.toFixed(1)??"n/a")+"% | "+(x.timeToFavorableCloseAvgMin?.toFixed(1)??"n/a")+"m | "+(x.maeToStopRatio?.toFixed(3)??"n/a")+" | "+(x.mfeMaeRatio?.toFixed(3)??"n/a")+" |"),
    "","## Regime-adjusted timing by side","",
    "| Side | Bucket | Signals | MAE before +0.1% close | 95p heat | Reach rate | Avg time | MAE / avg stop | MFE / MAE |",
    "|---|---|---:|---:|---:|---:|---:|---:|---:|",
    ...["LONG","SHORT"].flatMap(side=>Object.entries(byTimingRegimeBucketAndSide[side]).map(([bucket,x])=>"| "+side+" | "+bucket+" | "+x.signals+" | "+(x.maeBeforeFavorableAvgPct?.toFixed(3)??"n/a")+"% | "+(x.maeBeforeFavorableP95Pct?.toFixed(3)??"n/a")+"% | "+(x.favorableCloseRatePct?.toFixed(1)??"n/a")+"% | "+(x.timeToFavorableCloseAvgMin?.toFixed(1)??"n/a")+"m | "+(x.maeToStopRatio?.toFixed(3)??"n/a")+" | "+(x.mfeMaeRatio?.toFixed(3)??"n/a")+" |")),
    "","## Shadow priority ranking simulation (diagnostic only)","",
    "SHORT-only adjustment; LONG is unchanged. No signals are removed and the live priorityScore is untouched.",
    "| Strength | Top N / scan | Eligible scan timestamps | Baseline picks | Shadow picks | Changed scans | Replaced picks | Baseline heat | Shadow heat | Baseline MFE/MAE | Shadow MFE/MAE |",
    "|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ...rankingVariants.map(x=>"| "+x.strengthPoints+" | "+x.topNPerTimestamp+" | "+x.scanTimestampsWithEnoughCandidates+" | "+x.baselineSelected+" | "+x.shadowSelected+" | "+x.changedGroups+" | "+x.changedSelectionCount+" | "+(x.baseline.maeBeforeFavorableAvgPct?.toFixed(3)??"n/a")+"% | "+(x.shadow.maeBeforeFavorableAvgPct?.toFixed(3)??"n/a")+"% | "+(x.baseline.mfeMaeRatio?.toFixed(3)??"n/a")+" | "+(x.shadow.mfeMaeRatio?.toFixed(3)??"n/a")+" |"),
    "","### 24h trade lifecycle (1/3 position at each 1.5R / 2.5R / 3.5R target)","",
    "Conservative OHLC convention: if stop and target are both inside one 5m candle, stop is assumed first; at most one target is credited per candle. Fees/funding/slippage are excluded. Two policies: fixed original stop and move remaining stop to breakeven after TP1.",
    "| Strength | Top N | Policy | Baseline trades | Shadow trades | Baseline avg R | Shadow avg R | Baseline win% | Shadow win% | Baseline stop% | Shadow stop% | Baseline TP3% | Shadow TP3% |",
    "|---:|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ...rankingVariants.flatMap(x=>[["Fixed stop","fixedStopBaseline","fixedStopShadow"],["Breakeven after TP1","breakevenBaseline","breakevenShadow"]].map(([label,bk,sk])=>{const a=x[bk],z=x[sk];return "| "+x.strengthPoints+" | "+x.topNPerTimestamp+" | "+label+" | "+(a.trades??0)+" | "+(z.trades??0)+" | "+(a.avgR?.toFixed(3)??"n/a")+" | "+(z.avgR?.toFixed(3)??"n/a")+" | "+(a.winRatePct?.toFixed(1)??"n/a")+"% | "+(z.winRatePct?.toFixed(1)??"n/a")+"% | "+(a.stopRatePct?.toFixed(1)??"n/a")+"% | "+(z.stopRatePct?.toFixed(1)??"n/a")+"% | "+(a.tp3RatePct?.toFixed(1)??"n/a")+"% | "+(z.tp3RatePct?.toFixed(1)??"n/a")+"% |";})),
    "","### Shadow ranking by side","",
    "| Strength | Top N | Side | Baseline picks | Shadow picks | Baseline early heat | Shadow early heat | Baseline MFE/MAE | Shadow MFE/MAE | Fixed-stop avg R base/shadow | BE avg R base/shadow |",
    "|---:|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|",
    ...rankingVariants.flatMap(x=>["LONG","SHORT"].map(side=>{const y=x.bySide[side];return "| "+x.strengthPoints+" | "+x.topNPerTimestamp+" | "+side+" | "+y.baseline.count+" | "+y.shadow.count+" | "+(y.baseline.maeBeforeFavorableAvgPct?.toFixed(3)??"n/a")+"% | "+(y.shadow.maeBeforeFavorableAvgPct?.toFixed(3)??"n/a")+"% | "+(y.baseline.mfeMaeRatio?.toFixed(3)??"n/a")+" | "+(y.shadow.mfeMaeRatio?.toFixed(3)??"n/a")+" | "+(y.fixedStopBaseline.avgR?.toFixed(3)??"n/a")+" / "+(y.fixedStopShadow.avgR?.toFixed(3)??"n/a")+" | "+(y.breakevenBaseline.avgR?.toFixed(3)??"n/a")+" / "+(y.breakevenShadow.avgR?.toFixed(3)??"n/a")+" |";})),
    "","## Method limitations","",
    "- This is an entry-quality diagnostic, not a PnL/exit backtest.",
    "- EQS buckets are descriptive; thresholds 40/70 are provisional.",
    "- 5m OHLC provides range excursions, not intrabar ordering.",
    "- Universe selection uses current PF listings/current ticker quote volume (survivorship bias); historical eligibility estimates rolling 24h USD turnover from closed hourly base-volume × close. This is an approximation, not an exchange-reported historical quoteVolume series.",
    "- No fees, funding, slippage, liquidation, or execution latency are modeled.",
    "- Parity is required before attributing any MAE/MFE change to EQS.",
    "","## Per-symbol results","",
    "| Symbol | Opportunities | Base eligible | Experiment eligible | Parity mismatches | Measured |",
    "|---|---:|---:|---:|---:|---:|",
    ...symbolResults.map(x=>"| "+x.symbol+" | "+(x.evaluatedOpportunities??"—")+" | "+(x.eligibleBase??"—")+" | "+(x.eligibleExperiment??"—")+" | "+(x.legacyParityMismatches??"—")+" | "+(x.measuredSignals??"—")+" |"),
    "","Errors:",...symbolResults.filter(x=>x.error).map(x=>"- "+x.symbol+": "+x.error)];
  await writeFile("artifacts/eqs-diagnostics.md",md.join("\n"));
  console.log(JSON.stringify({ok:report.symbolsTested>0,period:report.period,symbolsTested:report.symbolsTested,
    opportunitiesCompared:report.opportunitiesCompared,measuredSignals:report.measuredSignals,
    legacyParityMismatches:report.legacyParityMismatches,legacyParityMatchRatePct:report.legacyParityMatchRatePct,
    bySide,byEqsBucket,byEqsBucketAndSide,byEqsV2Bucket,byEqsV2BucketAndSide,byEqsV3Bucket,byEqsV3BucketAndSide,byTimingBucket,byTimingBucketAndSide,byTimingRegimeBucket,byTimingRegimeBucketAndSide,rankingSimulation,symbolResults},null,2));
  if(!report.symbolsTested)process.exitCode=1;
}
main().catch(error=>{console.error(error);process.exitCode=1;});

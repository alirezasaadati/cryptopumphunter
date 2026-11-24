import { mkdir, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";

import { analyzeFuturesSymbol, FUTURES_CONFIG } from "../src/index.js";

const BASE = "https://futures.kraken.com";
const INTERVALS = { "5m": 300000, "15m": 900000, "1h": 3600000, "4h": 14400000 };
const DAYS = Math.max(7, Math.min(90, Number(process.env.EQS_BACKTEST_DAYS || 30)));
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
function cleanLegacy(value) {
  if (Array.isArray(value)) return value.map(cleanLegacy);
  if (!value || typeof value !== "object") return value;
  const omit = new Set(["eqsMomentumState","eqsPullbackState","entryQualityScore","entryQualityRaw","entryQualityDetails","entryQualityAvailableFactors"]);
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
function summarize(rows) {
  const avg=(xs,key)=>xs.length?xs.reduce((s,x)=>s+x[key],0)/xs.length:null;
  const p=(xs,key)=>xs.length?xs.slice().sort((a,b)=>a[key]-b[key])[Math.floor((xs.length-1)*0.95)][key]:null;
  return {count:rows.length,maeAvgPct:avg(rows,"maePct"),maeP95Pct:p(rows,"maePct"),mfeAvgPct:avg(rows,"mfePct"),mfeP95Pct:p(rows,"mfePct")};
}
async function main() {
  const endMs=Date.now(), startMs=endMs-DAYS*86400000, fromMs=startMs-WARMUP_DAYS*86400000;
  const tickerData=await getJson(BASE+"/derivatives/api/v3/tickers");
  if(!Array.isArray(tickerData?.tickers)) throw new Error("Kraken tickers response invalid");
  const universe=tickerData.tickers.filter(t=>t?.tag==="perpetual"&&t.suspended!==true&&
    /^(PI|PF)_[A-Z0-9]+USD$/.test(String(t.symbol||""))&&
    Number(t.volumeQuote)>=FUTURES_CONFIG.MIN_QUOTE_VOLUME&&Number(t.last)>0)
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
        const next=h1[i+1], commonTicker={symbol:ticker.symbol,last:next.open,quoteVolume:Number(ticker.volumeQuote)||0,
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
        const row={symbol:ticker.symbol,side:exp.side,signalTime:signalClose,entry,score:exp.score,
          entryQualityScore:exp.entryQualityScore??null,entryQualityRaw:exp.entryQualityRaw??null,
          entryQualityAvailableFactors:exp.entryQualityAvailableFactors??0,
          riskLevel:exp.riskLevel??null,stop:Number(exp.stop),stopDistancePct:Math.abs(entry-Number(exp.stop))/entry*100,
          horizons,maePct:full.maePct,mfePct:full.mfePct,legacyParity:diffs.length===0,parityDiffs:diffs};
        local.push(row); records.push(row);
      }
      symbolResults.push({symbol:ticker.symbol,candles:{h1:h1.length,h4:h4.length,m15:m15.length,m5:m5.length},
        evaluatedOpportunities:accepted,eligibleBase,eligibleExperiment:eligibleExp,legacyParityMismatches:parityMismatches,
        measuredSignals:local.length});
    }catch(error){symbolResults.push({symbol:ticker.symbol,error:String(error?.message||error)});}
  }
  const parityRows=records.filter(r=>r.legacyParity), bySide={}, byEqsBucket={};
  for(const side of ["LONG","SHORT"]){
    const xs=records.filter(r=>r.side===side);
    bySide[side]={signals:xs.length,maeMfe60m:summarize(xs),
      mae15mAvgPct:xs.filter(x=>x.horizons[15]).length?xs.filter(x=>x.horizons[15]).reduce((s,x)=>s+x.horizons[15].maePct,0)/xs.filter(x=>x.horizons[15]).length:null,
      mae30mAvgPct:xs.filter(x=>x.horizons[30]).length?xs.filter(x=>x.horizons[30]).reduce((s,x)=>s+x.horizons[30].maePct,0)/xs.filter(x=>x.horizons[30]).length:null,
      mae60mAvgPct:xs.filter(x=>x.horizons[60]).length?xs.filter(x=>s+x.horizons[60].maePct,0)/xs.filter(x=>x.horizons[60]).length:null};
  }
  for(const label of ["LOW_0_39","MID_40_69","HIGH_70_100","UNAVAILABLE"]){
    const xs=records.filter(r=>label==="UNAVAILABLE"?r.entryQualityScore==null:
      r.entryQualityScore!=null&&(label==="LOW_0_39"?r.entryQualityScore<40:label==="MID_40_69"?r.entryQualityScore<70:r.entryQualityScore>=70));
    byEqsBucket[label]={signals:xs.length,...summarize(xs)};
  }
  const report={generatedAt:new Date().toISOString(),venue:"Kraken Futures public historical OHLC",
    period:{from:new Date(startMs).toISOString(),to:new Date(endMs).toISOString(),days:DAYS,warmupDays:WARMUP_DAYS},
    methodology:{sameDataAndTimestamps:true,closedCandlesOnly:true,signalAt:"closed 1h candle",entry:"next 1h candle open",
      excursionResolution:"5m OHLC",horizonsMinutes:HORIZONS,mae:"maximum adverse price excursion from entry",
      mfe:"maximum favorable price excursion from entry",legacyParityFields:"signal side, eligibility, entry/stop/targets, score/priority and legacy entry diagnostics",
      ambiguity:"MAE/MFE are range excursions, not simulated stop/target fills",universe:"top current Kraken perpetuals by current quote volume; survivorship bias applies",
      costs:"fees, funding, slippage excluded",exitModel:"none; diagnostic MAE/MFE only"},
    symbolsRequested:SYMBOL_LIMIT,symbolsTested:symbolResults.filter(x=>!x.error).length,symbolResults,
    opportunitiesCompared:symbolResults.reduce((s,x)=>s+(x.evaluatedOpportunities||0),0),
    measuredSignals:records.length,legacyParityMismatches:records.filter(x=>!x.legacyParity).length,
    legacyParityMatchRatePct:records.length?parityRows.length/records.length*100:null,
    bySide,byEqsBucket,signals:records};
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
    "| Bucket | Signals | MAE avg | MAE P95 | MFE avg | MFE P95 |",
    "|---|---:|---:|---:|---:|---:|",
    ...Object.entries(byEqsBucket).map(([k,x])=>"| "+k+" | "+x.count+" | "+(x.maeAvgPct?.toFixed(3)??"n/a")+"% | "+(x.maeP95Pct?.toFixed(3)??"n/a")+"% | "+(x.mfeAvgPct?.toFixed(3)??"n/a")+"% | "+(x.mfeP95Pct?.toFixed(3)??"n/a")+"% |"),
    "","## Method limitations","",
    "- This is an entry-quality diagnostic, not a PnL/exit backtest.",
    "- EQS buckets are descriptive; thresholds 40/70 are provisional.",
    "- 5m OHLC provides range excursions, not intrabar ordering.",
    "- Universe uses current volume and has survivorship bias.",
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
    bySide,byEqsBucket,symbolResults},null,2));
  if(!report.symbolsTested)process.exitCode=1;
}
main().catch(error=>{console.error(error);process.exitCode=1;});

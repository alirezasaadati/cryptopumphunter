import { mkdir, writeFile } from "node:fs/promises";

const BASE = "https://futures.kraken.com";
const HOUR = 60 * 60 * 1000;
const FOUR_HOURS = 4 * HOUR;
const DAY = 24 * HOUR;
const TEST_DAYS = 365;
const WARMUP_DAYS = 60;
const FORWARD_HOURS = 24;
const ATR_LABEL_MULTIPLIER = Math.max(0.1, Math.min(2, Number(process.env.ATR_LABEL_MULTIPLIER || 0.75));
const ADX_MIN = 20;
const PIVOT_LEFT = 2;
const PIVOT_RIGHT = 2;

async function getJson(url) {
  const response = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(30000)
  });
  const body = await response.text();
  if (!response.ok) throw new Error("HTTP " + response.status + " for " + url + ": " + body.slice(0, 200));
  let data;
  try { data = JSON.parse(body); } catch { throw new Error("Invalid JSON from " + url); }
  if (data?.result === "error" || (Array.isArray(data?.errors) && data.errors.length)) {
    throw new Error("Kraken API error: " + JSON.stringify(data.errors || data.error));
  }
  return data;
}

function normalizeCandles(rows) {
  if (!Array.isArray(rows)) throw new Error("Kraken candles array missing");
  const byTime = new Map();
  for (const row of rows) {
    const time = Number(row.time) < 1e12 ? Number(row.time) * 1000 : Number(row.time);
    const candle = {
      time, open: Number(row.open), high: Number(row.high), low: Number(row.low),
      close: Number(row.close), volume: Number(row.volume)
    };
    if ([candle.time,candle.open,candle.high,candle.low,candle.close,candle.volume].every(Number.isFinite) &&
        candle.open > 0 && candle.low > 0 && candle.close > 0 && candle.high >= candle.low) {
      byTime.set(time, candle);
    }
  }
  return [...byTime.values()].sort((a,b) => a.time-b.time);
}

async function fetchOneYear(symbol, fromMs, toMs) {
  const chunkMs = HOUR * 1600;
  const all = [];
  for (let from = fromMs; from < toMs; from += chunkMs) {
    const to = Math.min(toMs, from + chunkMs);
    const url = new URL(BASE + "/api/charts/v1/trade/" + encodeURIComponent(symbol) + "/1h");
    url.searchParams.set("from", String(Math.floor(from / 1000)));
    url.searchParams.set("to", String(Math.floor(to / 1000)));
    url.searchParams.set("count", "1800");
    const data = await getJson(url);
    if (data.more_candles === true) throw new Error("Kraken returned more than 1800 candles for a chunk; reduce chunk size.");
    all.push(...normalizeCandles(data.candles));
  }
  const cutoff = Date.now() - HOUR;
  return normalizeCandles(all).filter(c => c.time + HOUR <= cutoff);
}

function aggregate4h(hourly) {
  const groups = new Map();
  for (const c of hourly) {
    const key = Math.floor(c.time / FOUR_HOURS) * FOUR_HOURS;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }
  return [...groups.entries()].sort((a,b)=>a[0]-b[0]).flatMap(([time, bars]) => {
    bars.sort((a,b)=>a.time-b.time);
    if (bars.length !== 4 || bars[0].time !== time ||
        bars.some((bar,i)=>bar.time !== time + i*HOUR)) return [];
    return [{
      time, open: bars[0].open, high: Math.max(...bars.map(x=>x.high)),
      low: Math.min(...bars.map(x=>x.low)), close: bars[3].close,
      volume: bars.reduce((s,x)=>s+x.volume,0)
    }];
  });
}

function emaSeries(values, period) {
  const out = Array(values.length).fill(null);
  if (values.length < period) return out;
  const alpha = 2/(period+1);
  let value = values.slice(0,period).reduce((s,x)=>s+x,0)/period;
  out[period-1] = value;
  for (let i=period;i<values.length;i++) {
    value = values[i]*alpha + value*(1-alpha);
    out[i] = value;
  }
  return out;
}

function rsiSeries(values, period=14) {
  const out = Array(values.length).fill(null);
  if (values.length <= period) return out;
  let gain=0, loss=0;
  for(let i=1;i<=period;i++) {
    const d=values[i]-values[i-1]; gain+=Math.max(d,0); loss+=Math.max(-d,0);
  }
  let avgGain=gain/period, avgLoss=loss/period;
  out[period] = avgLoss===0 ? 100 : avgGain===0 ? 0 : 100-100/(1+avgGain/avgLoss);
  for(let i=period+1;i<values.length;i++) {
    const d=values[i]-values[i-1];
    avgGain=(avgGain*(period-1)+Math.max(d,0))/period;
    avgLoss=(avgLoss*(period-1)+Math.max(-d,0))/period;
    out[i]=avgLoss===0 ? 100 : avgGain===0 ? 0 : 100-100/(1+avgGain/avgLoss);
  }
  return out;
}

function volatilitySeries(candles, period=14) {
  const n=candles.length, tr=Array(n).fill(null), plus=Array(n).fill(0), minus=Array(n).fill(0);
  for(let i=1;i<n;i++) {
    const c=candles[i], p=candles[i-1];
    tr[i]=Math.max(c.high-c.low,Math.abs(c.high-p.close),Math.abs(c.low-p.close));
    const up=c.high-p.high, down=p.low-c.low;
    plus[i]=up>down && up>0 ? up : 0;
    minus[i]=down>up && down>0 ? down : 0;
  }
  const atr=Array(n).fill(null), adx=Array(n).fill(null);
  if(n<=period*2) return {atr,adx};
  let atrSum=0, plusSum=0, minusSum=0;
  for(let i=1;i<=period;i++){atrSum+=tr[i];plusSum+=plus[i];minusSum+=minus[i];}
  let smoothTR=atrSum, smoothPlus=plusSum, smoothMinus=minusSum;
  atr[period]=smoothTR/period;
  const dx=Array(n).fill(null);
  const calcDx= i => {
    const pdi=100*smoothPlus/smoothTR, mdi=100*smoothMinus/smoothTR;
    dx[i]=(pdi+mdi)===0 ? 0 : 100*Math.abs(pdi-mdi)/(pdi+mdi);
  };
  calcDx(period);
  for(let i=period+1;i<n;i++) {
    smoothTR=smoothTR-smoothTR/period+tr[i];
    smoothPlus=smoothPlus-smoothPlus/period+plus[i];
    smoothMinus=smoothMinus-smoothMinus/period+minus[i];
    atr[i]=smoothTR/period;
    calcDx(i);
  }
  if(n>period*2) {
    let seed=0, count=0;
    for(let i=period;i<=period*2-1;i++){if(dx[i]!==null){seed+=dx[i];count++;}}
    if(count===period) {
      adx[period*2-1]=seed/period;
      for(let i=period*2;i<n;i++) adx[i]=(adx[i-1]*(period-1)+dx[i])/period;
    }
  }
  return {atr,adx};
}

// A pivot is only made available after PIVOT_RIGHT later candles have closed.
function marketStructure(candles, index) {
  const highs=[], lows=[];
  const first=Math.max(PIVOT_LEFT,index-400);
  for(let p=index-PIVOT_RIGHT;p>=first+PIVOT_LEFT;p--) {
    const c=candles[p];
    let isHigh=true, isLow=true;
    for(let k=p-PIVOT_LEFT;k<=p+PIVOT_RIGHT;k++) {
      if(k===p) continue;
      if(candles[k].high>=c.high) isHigh=false;
      if(candles[k].low<=c.low) isLow=false;
      if(!isHigh && !isLow) break;
    }
    if(isHigh) highs.push(c.high);
    if(isLow) lows.push(c.low);
    if(highs.length>=2 && lows.length>=2) break;
  }
  if(highs.length<2 || lows.length<2) return "NEUTRAL";
  const higherHigh=highs[0]>highs[1], lowerHigh=highs[0]<highs[1];
  const higherLow=lows[0]>lows[1], lowerLow=lows[0]<lows[1];
  if(higherHigh && higherLow) return "BULL";
  if(lowerHigh && lowerLow) return "BEAR";
  return "NEUTRAL";
}

function addPrediction(metrics, predicted, actual) {
  metrics.total++;
  metrics.matrix[actual][predicted]++;
  if(predicted!=="NEUTRAL") metrics.directionalPredictions++;
  if(predicted!=="NEUTRAL" && predicted===actual) metrics.correctDirectional++;
  if(predicted!=="NEUTRAL" && actual==="NEUTRAL") metrics.predictedIntoNeutral++;
  if((predicted==="BULL"&&actual==="BEAR")||(predicted==="BEAR"&&actual==="BULL")) metrics.oppositeDirection++;
}

function summarizeMetrics(m) {
  const labels=["BULL","BEAR","NEUTRAL"];
  let correct=0, macroF1=0;
  for(const label of labels) correct+=m.matrix[label][label];
  for(const label of labels) {
    const tp=m.matrix[label][label];
    const fp=labels.reduce((s,a)=>s+m.matrix[a][label],0)-tp;
    const fn=labels.reduce((s,a)=>s+m.matrix[label][a],0)-tp;
    const precision=tp+fp ? tp/(tp+fp) : 0;
    const recall=tp+fn ? tp/(tp+fn) : 0;
    macroF1+=precision+recall ? 2*precision*recall/(precision+recall) : 0;
  }
  const n=m.total||1;
  return {
    observations:m.total,
    accuracyPct:100*correct/n,
    macroF1Pct:100*macroF1/3,
    directionalCoveragePct:100*m.directionalPredictions/n,
    directionalPrecisionPct:m.directionalPredictions ? 100*m.correctDirectional/m.directionalPredictions : 0,
    predictedIntoNeutralPct:m.directionalPredictions ? 100*m.predictedIntoNeutral/m.directionalPredictions : 0,
    oppositeDirectionPct:m.directionalPredictions ? 100*m.oppositeDirection/m.directionalPredictions : 0,
    confusionMatrix:m.matrix
  };
}

function freshMetrics() {
  const row=()=>({BULL:0,BEAR:0,NEUTRAL:0});
  return {total:0,directionalPredictions:0,correctDirectional:0,predictedIntoNeutral:0,oppositeDirection:0,
    matrix:{BULL:row(),BEAR:row(),NEUTRAL:row()}};
}

function main() {
  const now=Date.now();
  const testStart=now-TEST_DAYS*DAY;
  const fetchStart=testStart-WARMUP_DAYS*DAY;
  const fromMs=Math.floor(fetchStart/HOUR)*HOUR;
  const toMs=Math.floor(now/HOUR)*HOUR;
  return {now,testStart,fromMs,toMs};
}

async function run() {
  const dates=main();
  const tickerData=await getJson(BASE+"/derivatives/api/v3/tickers");
  const tickers=Array.isArray(tickerData?.tickers)?tickerData.tickers:[];
  const btc=tickers.find(t=>t.symbol==="PF_XBTUSD"&&t.tag==="perpetual") ||
    tickers.find(t=>t.symbol==="PI_XBTUSD"&&t.tag==="perpetual");
  if(!btc) throw new Error("No BTC perpetual contract found on Kraken.");
  const hourly=await fetchOneYear(btc.symbol,dates.fromMs,dates.toMs);
  const four=aggregate4h(hourly);
  if(hourly.length<TEST_DAYS*20 || four.length<TEST_DAYS*5) {
    throw new Error("Insufficient history for a one-year test: 1h="+hourly.length+", 4h="+four.length);
  }

  const hClose=hourly.map(c=>c.close), fClose=four.map(c=>c.close);
  const hE20=emaSeries(hClose,20), hE50=emaSeries(hClose,50), hRsi=rsiSeries(hClose,14);
  const fE20=emaSeries(fClose,20), fE50=emaSeries(fClose,50);
  const {atr:fAtr,adx:fAdx}=volatilitySeries(four,14);
  const fourIndexByHour=Array(hourly.length).fill(-1);
  let fi=0;
  for(let i=0;i<hourly.length;i++) {
    const signalClose=hourly[i].time+HOUR;
    while(fi+1<four.length && four[fi+1].time+FOUR_HOURS<=signalClose) fi++;
    if(four[fi] && four[fi].time+FOUR_HOURS<=signalClose) fourIndexByHour[i]=fi;
  }

  const models=["A_current_EMA_RSI","B_market_structure","C_structure_ADX","D_combined_MTF"];
  const metrics={};
  for(const name of models) metrics[name]={all:freshMetrics(),oos:freshMetrics(),flips:0,previous:null,transitions:0};
  let observations=0, testRows=0;
  const firstTestIndex=hourly.findIndex(c=>c.time>=dates.testStart);
  const splitIndex=firstTestIndex+Math.floor((hourly.length-firstTestIndex)*0.70);

  for(let i=Math.max(100,firstTestIndex);i<hourly.length-FORWARD_HOURS;i++) {
    if(hourly[i].time<dates.testStart) continue;
    const j=fourIndexByHour[i];
    if(j<0 || fAtr[j]==null || fAdx[j]==null || hE20[i]==null || hE50[i]==null || hRsi[i]==null ||
      fE20[j]==null || fE50[j]==null) continue;
    const threshold=fAtr[j]*Math.sqrt(6)*ATR_LABEL_MULTIPLIER;
    const futureReturn=hourly[i+FORWARD_HOURS].close-hourly[i].close;
    const actual=futureReturn>threshold ? "BULL" : futureReturn < -threshold ? "BEAR" : "NEUTRAL";
    const structure=marketStructure(hourly,i);
    const up1=hE20[i]>hE50[i] && hourly[i].close>hE20[i];
    const down1=hE20[i]<hE50[i] && hourly[i].close<hE20[i];
    const up4=fE20[j]>fE50[j], down4=fE20[j]<fE50[j];
    const adxStrong=fAdx[j]>=ADX_MIN;
    const predictions={
      A_current_EMA_RSI: up1&&up4&&hRsi[i]>=48&&hRsi[i]<=69 ? "BULL" :
        down1&&down4&&hRsi[i]>=31&&hRsi[i]<=52 ? "BEAR" : "NEUTRAL",
      B_market_structure: structure,
      C_structure_ADX: adxStrong ? structure : "NEUTRAL",
      D_combined_MTF: structure==="BULL"&&up1&&up4&&adxStrong ? "BULL" :
        structure==="BEAR"&&down1&&down4&&adxStrong ? "BEAR" : "NEUTRAL"
    };
    observations++;
    for(const name of models) {
      const m=metrics[name];
      addPrediction(m.all,predictions[name],actual);
      if(i>=splitIndex) addPrediction(m.oos,predictions[name],actual);
      if(m.previous!==null) {
        m.transitions++;
        if(m.previous!==predictions[name]) m.flips++;
      }
      m.previous=predictions[name];
    }
    testRows++;
  }

  const result={
    title:"BTC trend classifier benchmark",
    generatedAt:new Date().toISOString(),
    venue:"Kraken Futures public historical OHLC",
    symbol:btc.symbol,
    period:{testStart:new Date(dates.testStart).toISOString(),testEnd:new Date(dates.toMs).toISOString(),requestedDays:TEST_DAYS,
      oneHourCandles:hourly.length,fourHourCandles:four.length,scoredObservations:observations,
      split:"first 70% of scored chronological observations used as development period; final 30% reported as out-of-sample"},
    labelDefinition:{
      horizonHours:FORWARD_HOURS,
      bullish:"24h forward close-to-close gain exceeds 0.75 × ATR(4h,14) × sqrt(6)",
      bearish:"24h forward close-to-close loss exceeds the same volatility threshold",
      neutral:"forward move remains inside the volatility threshold",
      note:"Labels use future prices only for evaluation; model inputs at each timestamp use closed candles available at that timestamp."
    },
    modelDefinitions:{
      A_current_EMA_RSI:"Current engine strict trend rule: 1h EMA20/EMA50 plus 1h close vs EMA20; 4h EMA20/EMA50 agreement; 1h RSI LONG 48–69 / SHORT 31–52.",
      B_market_structure:"Last two confirmed 1h swing highs and lows (2 bars left/right): HH+HL bullish, LH+LL bearish, otherwise neutral.",
      C_structure_ADX:"Model B direction only when 4h ADX(14) >= 20; otherwise neutral.",
      D_combined_MTF:"Model B structure, 1h EMA direction and 4h EMA direction must agree, plus 4h ADX(14) >= 20."
    },
    methodology:{
      noLookahead:"Pivot points become available only after two right-side candles have closed; 4h indicators use only completed 4h candles.",
      parametersFixedBeforeTest:true,
      tuningOnTestSet:false,
      overlappingForecasts:"One forecast per eligible hourly candle; forecasts overlap by design.",
      costs:"Not applicable to trend classification; no trade PnL is simulated.",
      limitations:"The label is a 24h forward directional outcome, not a claim that a market regime can be known with certainty. Results depend on the stated ATR-scaled threshold."
    },
    models:Object.fromEntries(models.map(name=>[name,{
      all:summarizeMetrics(metrics[name].all),
      outOfSample:summarizeMetrics(metrics[name].oos),
      signalFlipRatePct:metrics[name].transitions?100*metrics[name].flips/metrics[name].transitions:0,
      signalTransitions:metrics[name].transitions,
      signalDirectionChanges:metrics[name].flips
    }]))
  };
  await mkdir("artifacts",{recursive:true});
  await writeFile("artifacts/btc-trend-benchmark.json",JSON.stringify(result,null,2));
  const lines=[
    "# BTC trend classifier benchmark",
    "",
    "- Symbol: "+btc.symbol,
    "- Period: "+result.period.testStart+" to "+result.period.testEnd,
    "- Scored hourly observations: "+observations,
    "- OOS split: final 30% of chronological observations",
    "- Label: "+result.labelDefinition.bullish+" / "+result.labelDefinition.bearish,
    "",
    "| Model | OOS accuracy | OOS macro-F1 | OOS directional precision | OOS coverage | Opposite-direction | Signal flip rate |",
    "|---|---:|---:|---:|---:|---:|---:|",
    ...models.map(name=>{
      const x=result.models[name];
      return "| "+name+" | "+x.outOfSample.accuracyPct.toFixed(2)+"% | "+x.outOfSample.macroF1Pct.toFixed(2)+"% | "+
        x.outOfSample.directionalPrecisionPct.toFixed(2)+"% | "+x.outOfSample.directionalCoveragePct.toFixed(2)+"% | "+
        x.outOfSample.oppositeDirectionPct.toFixed(2)+"% | "+x.signalFlipRatePct.toFixed(2)+"% |";
    }),
    "",
    "## Full-period metrics",
    "",
    ...models.flatMap(name=>[
      "### "+name,
      "",
      "- Accuracy: "+result.models[name].all.accuracyPct.toFixed(2)+"%",
      "- Macro-F1: "+result.models[name].all.macroF1Pct.toFixed(2)+"%",
      "- Directional precision: "+result.models[name].all.directionalPrecisionPct.toFixed(2)+"%",
      "- Directional coverage: "+result.models[name].all.directionalCoveragePct.toFixed(2)+"%",
      "- Opposite-direction rate: "+result.models[name].all.oppositeDirectionPct.toFixed(2)+"%",
      "- Confusion matrix: "+JSON.stringify(result.models[name].all.confusionMatrix),
      ""
    ])
  ];
  await writeFile("artifacts/btc-trend-benchmark.md",lines.join("\n"));
  console.log(JSON.stringify(result,null,2));
}

run().catch(error=>{console.error(error?.stack||error);process.exitCode=1;});

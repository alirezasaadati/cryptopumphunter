import { mkdir, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { analyzeBreakoutRetestLongA } from "../src/futures-breakout-retest-long-a.js";
import { analyzeBreakoutRetestLong } from "../src/futures-breakout-retest-long.js";
import { analyzeEmaPullbackLong } from "../src/ema-pullback-long.js";
import { analyzeEmaPullbackLong as analyzeEmaPullbackLongBaseline } from "../src/ema-pullback-long-baseline.js";

// Experimental comparison: C is the unchanged EMA-pullback baseline; D applies the requested filters.
const CHARTS_API = "https://futures.kraken.com/api/charts/v1";
const FUTURES_API = "https://futures.kraken.com/derivatives/api/v3";
const RESOLUTION_MS = { "5m": 300000, "15m": 900000, "1h": 3600000, "4h": 14400000, "1d": 86400000 };
const LEVERAGE = 10;
const MARGIN_TARGET_PCT = 30;
const WARMUP_DAYS = 100;
const MAX_CONTEXT_CANDLES = 100;
const SYMBOL_CANDIDATES = [
  "PF_XBTUSD", "PF_ETHUSD", "PF_SOLUSD", "PF_XRPUSD",
  "PF_ADAUSD", "PF_LINKUSD", "PF_AVAXUSD", "PF_DOTUSD"
];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function getJson(url, label) {
  let lastError;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const response = await fetch(url, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(30000)
      });
      const body = await response.text();
      if (!response.ok) {
        if (attempt < 4 && (response.status === 429 || response.status >= 500)) {
          await sleep(600 * (attempt + 1));
          continue;
        }
        throw new Error("Kraken HTTP " + response.status + " for " + label + ": " + body.slice(0, 200));
      }
      const parsed = JSON.parse(body);
      if (parsed.result && parsed.result !== "success") {
        throw new Error("Kraken API result " + parsed.result + " for " + label + ": " + (parsed.error || ""));
      }
      return parsed;
    } catch (error) {
      lastError = error;
      if (attempt < 4 && /fetch failed|timeout|ECONNRESET|429|5\d\d/i.test(String(error))) {
        await sleep(600 * (attempt + 1));
        continue;
      }
      throw error;
    }
  }
  throw lastError || new Error("Kraken retries exhausted for " + label);
}

async function fetchKrakenCandles(symbol, resolution, fromMs, toMs) {
  const intervalMs = RESOLUTION_MS[resolution];
  if (!intervalMs) throw new Error("Unsupported Kraken resolution " + resolution);
  const all = [];
  // Kraken Futures chart endpoint has a 5,000-candle maximum; fetch bounded chunks.
  const chunkMs = intervalMs * 4000;
  for (let start = fromMs; start < toMs; start += chunkMs) {
    const end = Math.min(toMs, start + chunkMs);
    const url = new URL(CHARTS_API + "/trade/" + encodeURIComponent(symbol) + "/" + resolution);
    url.searchParams.set("from", String(Math.floor(start / 1000)));
    url.searchParams.set("to", String(Math.floor(end / 1000)));
    const payload = await getJson(url, symbol + " " + resolution);
    if (!Array.isArray(payload.candles)) {
      throw new Error("Kraken candle response missing candles for " + symbol + " " + resolution);
    }
    for (const row of payload.candles) {
      const candle = {
        time: Number(row.time),
        open: Number(row.open), high: Number(row.high), low: Number(row.low),
        close: Number(row.close), volume: Number(row.volume)
      };
      if (Number.isFinite(candle.time) &&
          [candle.open,candle.high,candle.low,candle.close,candle.volume].every(Number.isFinite) &&
          candle.open > 0 && candle.low > 0 && candle.high >= Math.max(candle.open,candle.close,candle.low) &&
          candle.volume >= 0 && candle.time + intervalMs <= toMs) {
        all.push(candle);
      }
    }
    await sleep(180);
  }
  const unique = new Map(all.map(c => [c.time, c]));
  return [...unique.values()].sort((a,b) => a.time - b.time);
}

function ema(values, period) {
  if (values.length < period) return null;
  const alpha = 2 / (period + 1);
  let value = values.slice(0, period).reduce((a,b) => a+b, 0) / period;
  for (let i = period; i < values.length; i++) value = values[i] * alpha + value * (1-alpha);
  return value;
}

function selectBullishWindow(daily, preferredDays = 60) {
  if (daily.length < 90) throw new Error("BTC daily history is insufficient for independent market-regime selection");
  const closes = daily.map(c => c.close);
  const ema50 = [];
  const alpha = 2 / 51;
  let e = closes.slice(0,50).reduce((a,b)=>a+b,0)/50;
  for (let i=0;i<closes.length;i++) {
    if (i===49) ema50[i]=e;
    else if (i>49) { e=closes[i]*alpha+e*(1-alpha); ema50[i]=e; }
    else ema50[i]=null;
  }
  // Bullish regime is defined using BTC daily data only, not LONG-engine results:
  // every day in the selected window must close above EMA50, with EMA50 above
  // its value 10 days earlier. Select the most recent qualifying window.
  for (const days of [preferredDays, 45, 30]) {
    for (let end = daily.length - 1; end >= days + 10; end--) {
      const start = end - days + 1;
      let valid = true;
      for (let i=start;i<=end;i++) {
        if (!(closes[i] > ema50[i] && ema50[i] > ema50[i-10])) { valid=false; break; }
      }
      if (valid) {
        return {
          startMs: daily[start].time,
          endMs: daily[end].time + RESOLUTION_MS["1d"],
          days,
          btcCloseAboveEma50Pct: 100,
          btcEma50RisingPct: 100,
          btcStartClose: closes[start],
          btcEndClose: closes[end],
          btcStartEma50: ema50[start],
          btcEndEma50: ema50[end]
        };
      }
    }
  }
  throw new Error("No qualifying 30-day-or-longer BTC bullish window found; no bearish data will be substituted");
}

function countClosed(candles, intervalMs, cutoffMs) {
  let lo=0,hi=candles.length;
  while(lo<hi){const mid=(lo+hi)>>1;if(candles[mid].time+intervalMs<=cutoffMs)lo=mid+1;else hi=mid;}
  return lo;
}
function lowerBound(candles,time) {
  let lo=0,hi=candles.length;
  while(lo<hi){const mid=(lo+hi)>>1;if(candles[mid].time<time)lo=mid+1;else hi=mid;}
  return lo;
}
function recentClosed(candles,count) {
  return candles.slice(Math.max(0,count-MAX_CONTEXT_CANDLES),count);
}

export function resolveLongTrade({ candles, entryIndex, stopPrice, leverage=LEVERAGE, marginTargetPct=MARGIN_TARGET_PCT }) {
  const entryBar=candles[entryIndex];
  if(!entryBar)return{status:"NO_ENTRY_BAR",ambiguousCandles:0};
  const entryPrice=Number(entryBar.open),stop=Number(stopPrice);
  if(!(entryPrice>0)||!Number.isFinite(stop)||!(leverage>0))return{status:"INVALID_TRADE",ambiguousCandles:0};
  const targetPrice=entryPrice*(1+marginTargetPct/(leverage*100));
  let ambiguousCandles=0;
  for(let i=entryIndex;i<candles.length;i++){
    const bar=candles[i],open=Number(bar.open),high=Number(bar.high),low=Number(bar.low);
    if(open<=stop)return{status:"STOP",entryPrice,exitPrice:open,targetPrice,stopPrice:stop,exitTime:bar.time+RESOLUTION_MS["5m"],ambiguousCandles,marginRoiPct:(open/entryPrice-1)*leverage*100};
    if(open>=targetPrice)return{status:"PROFIT_30",entryPrice,exitPrice:open,targetPrice,stopPrice:stop,exitTime:bar.time+RESOLUTION_MS["5m"],ambiguousCandles,marginRoiPct:(open/entryPrice-1)*leverage*100};
    const stopHit=low<=stop,targetHit=high>=targetPrice;
    if(stopHit&&targetHit){ambiguousCandles++;return{status:"STOP",entryPrice,exitPrice:stop,targetPrice,stopPrice:stop,exitTime:bar.time+RESOLUTION_MS["5m"],ambiguousCandles,marginRoiPct:(stop/entryPrice-1)*leverage*100};}
    if(stopHit)return{status:"STOP",entryPrice,exitPrice:stop,targetPrice,stopPrice:stop,exitTime:bar.time+RESOLUTION_MS["5m"],ambiguousCandles,marginRoiPct:(stop/entryPrice-1)*leverage*100};
    if(targetHit)return{status:"PROFIT_30",entryPrice,exitPrice:targetPrice,targetPrice,stopPrice:stop,exitTime:bar.time+RESOLUTION_MS["5m"],ambiguousCandles,marginRoiPct:marginTargetPct};
  }
  const last=candles.at(-1);
  return{status:"OPEN_AT_END",entryPrice,targetPrice,stopPrice:stop,lastMark:last?last.close:null,exitTime:null,ambiguousCandles,marginRoiAtEndPct:last?(last.close/entryPrice-1)*leverage*100:null};
}

function runEmaPullbackEngine({symbol,data,testStartMs,testEndMs,engine="C",analyzer=analyzeEmaPullbackLong}) {
  const trades=[];let lockUntil=0;
  const startIndex=lowerBound(data.h4,testStartMs-RESOLUTION_MS["4h"]);
  for(let i=Math.max(startIndex,210);i<data.h4.length;i++){
    const signalCandle=data.h4[i],signalCloseTime=signalCandle.time+RESOLUTION_MS["4h"];
    if(signalCloseTime<testStartMs||signalCloseTime>=testEndMs||signalCloseTime<lockUntil)continue;
    const candles=data.h4.slice(Math.max(0,i+1-500),i+1);
    const candidate=analyzer({symbol,candles});
    if(!candidate||candidate.eligible!==true)continue;
    const entryIndex=lowerBound(data.m5,signalCloseTime),entryBar=data.m5[entryIndex];
    if(!entryBar||entryBar.time>=testEndMs||entryBar.time-signalCloseTime>RESOLUTION_MS["5m"])continue;
    const outcome=resolveLongTrade({candles:data.m5,entryIndex,stopPrice:candidate.stop});
    trades.push({engine,symbol,signalTime:signalCandle.time,signalCloseTime,plannedEntry:candidate.entry,
      entryPrice:outcome.entryPrice??null,stopPrice:candidate.stop,targetPrice:outcome.targetPrice??null,
      status:outcome.status,exitTime:outcome.exitTime??null,exitPrice:outcome.exitPrice??null,
      marginRoiPct:outcome.marginRoiPct??null,marginRoiAtEndPct:outcome.marginRoiAtEndPct??null,
      confidence:candidate.confidence,regime:candidate.regime,ambiguousCandles:outcome.ambiguousCandles||0});
    lockUntil=outcome.exitTime??testEndMs;
  }
  return{symbol,metrics:summarize(trades),trades};
}

function summarize(trades) {
  const closed=trades.filter(t=>t.status==="PROFIT_30"||t.status==="STOP");
  const wins=closed.filter(t=>t.status==="PROFIT_30"),stops=closed.filter(t=>t.status==="STOP");
  let equity=0,peak=0,maxDrawdown=0;
  for(const t of [...closed].sort((a,b)=>a.exitTime-b.exitTime)){
    equity+=Number(t.marginRoiPct||0);peak=Math.max(peak,equity);maxDrawdown=Math.max(maxDrawdown,peak-equity);
  }
  const total=closed.reduce((s,t)=>s+Number(t.marginRoiPct||0),0);
  return{
    signals:trades.length,closedTrades:closed.length,wins30PctBeforeStop:wins.length,stopFirst:stops.length,
    openAtEnd:trades.filter(t=>t.status==="OPEN_AT_END").length,
    winRatePct:closed.length?wins.length/closed.length*100:0,
    totalMarginRoiPct:total,averageMarginRoiPct:closed.length?total/closed.length:0,
    maxDrawdownMarginPoints:maxDrawdown,
    ambiguous5mCandles:trades.reduce((s,t)=>s+(t.ambiguousCandles||0),0)
  };
}

function runEngine({engine,symbol,data,testStartMs,testEndMs}) {
  const trades=[];let lockUntil=0;
  const startIndex=lowerBound(data.m15,testStartMs-RESOLUTION_MS["15m"]);
  for(let i=Math.max(startIndex,100);i<data.m15.length;i++){
    const signalCandle=data.m15[i],signalCloseTime=signalCandle.time+RESOLUTION_MS["15m"];
    if(signalCloseTime<testStartMs||signalCloseTime>=testEndMs||signalCloseTime<lockUntil)continue;
    const btcCount=countClosed(data.btc15,RESOLUTION_MS["15m"],signalCloseTime);
    const h1Count=countClosed(data.h1,RESOLUTION_MS["1h"],signalCloseTime);
    const h4Count=countClosed(data.h4,RESOLUTION_MS["4h"],signalCloseTime);
    const m15=recentClosed(data.m15,i+1);
    const candidate=engine==="A"
      ? analyzeBreakoutRetestLongA({symbol,candles15m:m15,candlesBtc15m:recentClosed(data.btc15,btcCount)})
      : analyzeBreakoutRetestLong({symbol,candles15m:m15,candles1h:recentClosed(data.h1,h1Count),candles4h:recentClosed(data.h4,h4Count)});
    if(!candidate||candidate.eligible!==true)continue;
    const entryIndex=lowerBound(data.m5,signalCloseTime),entryBar=data.m5[entryIndex];
    if(!entryBar||entryBar.time>=testEndMs||entryBar.time-signalCloseTime>RESOLUTION_MS["5m"])continue;
    const outcome=resolveLongTrade({candles:data.m5,entryIndex,stopPrice:candidate.stop});
    trades.push({
      engine,symbol,signalTime:signalCandle.time,signalCloseTime,plannedEntry:candidate.entry,
      entryPrice:outcome.entryPrice??null,stopPrice:candidate.stop,targetPrice:outcome.targetPrice??null,
      status:outcome.status,exitTime:outcome.exitTime??null,exitPrice:outcome.exitPrice??null,
      marginRoiPct:outcome.marginRoiPct??null,marginRoiAtEndPct:outcome.marginRoiAtEndPct??null,
      ambiguousCandles:outcome.ambiguousCandles||0
    });
    lockUntil=outcome.exitTime??testEndMs;
  }
  return{symbol,metrics:summarize(trades),trades};
}

async function main() {
  const nowMs=Date.now();
  const dailyFrom=nowMs-500*RESOLUTION_MS["1d"];
  console.log("Fetching Kraken Futures BTC daily data to select a bullish-only test window...");
  const btcDaily=await fetchKrakenCandles("PF_XBTUSD","1d",dailyFrom,nowMs);
  const regime=selectBullishWindow(btcDaily,Number(process.env.BREAKOUT_BACKTEST_DAYS||60));
  const testStartMs=regime.startMs,testEndMs=regime.endMs;
  const historyStartMs=testStartMs-WARMUP_DAYS*RESOLUTION_MS["1d"];
  console.log("Selected BTC bullish-only window: "+new Date(testStartMs).toISOString()+" -> "+new Date(testEndMs).toISOString()+" ("+regime.days+" days)");

  const tickerPayload=await getJson(FUTURES_API+"/tickers","Kraken Futures tickers");
  const tickers=Array.isArray(tickerPayload.tickers)?tickerPayload.tickers:[];
  const tickerBySymbol=new Map(tickers.map(t=>[String(t.symbol||"").toUpperCase(),t]));
  const symbols=SYMBOL_CANDIDATES
    .map(s=>tickerBySymbol.get(s))
    .filter(t=>t&&String(t.tag).toLowerCase()==="perpetual"&&!t.suspended&&!t.postOnly&&Number(t.volumeQuote||0)>0)
    .sort((a,b)=>Number(b.volumeQuote||0)-Number(a.volumeQuote||0))
    .map(t=>String(t.symbol).toUpperCase());
  if(!symbols.length)throw new Error("No active Kraken USD crypto perpetuals found in the candidate universe");
  console.log("Active Kraken perpetual symbols selected: "+symbols.join(", "));

  const btc15=await fetchKrakenCandles("PF_XBTUSD","15m",historyStartMs,testEndMs);
  const results=[];
  for(const symbol of symbols){
    try{
      console.log("Loading Kraken candles for "+symbol+"...");
      const [m15,h1,h4,m5]=await Promise.all([
        fetchKrakenCandles(symbol,"15m",historyStartMs,testEndMs),
        fetchKrakenCandles(symbol,"1h",historyStartMs,testEndMs),
        fetchKrakenCandles(symbol,"4h",historyStartMs,testEndMs),
        fetchKrakenCandles(symbol,"5m",testStartMs-RESOLUTION_MS["5m"],testEndMs)
      ]);
      if(m15.length<150||h1.length<60||h4.length<210||m5.length<100)throw new Error("Insufficient history: 15m="+m15.length+", 1h="+h1.length+", 4h="+h4.length+", 5m="+m5.length);
      const data={m15,h1,h4,m5,btc15};
      const A=runEngine({engine:"A",symbol,data,testStartMs,testEndMs});
      const B=runEngine({engine:"B",symbol,data,testStartMs,testEndMs});
      const C=runEmaPullbackEngine({symbol,data,testStartMs,testEndMs,engine:"C",analyzer:analyzeEmaPullbackLongBaseline});
      const D=runEmaPullbackEngine({symbol,data,testStartMs,testEndMs,engine:"D",analyzer:analyzeEmaPullbackLong});
      results.push({symbol,candles:{"15m":m15.length,"1h":h1.length,"4h":h4.length,"5m":m5.length},A,B,C,D});
    }catch(error){results.push({symbol,error:String(error?.message||error)});}
  }
  const good=results.filter(r=>!r.error);
  const aggregate=engine=>summarize(good.flatMap(r=>r[engine].trades));
  const report={
    generatedAt:new Date().toISOString(),
    venue:"Kraken Futures perpetuals; public trade OHLC candles",
    marketRegime:{
      benchmark:"PF_XBTUSD daily candles",
      definition:"Every daily BTC close in the selected window is above EMA50 and daily EMA50 is above its value 10 days earlier",
      ...regime,from:new Date(testStartMs).toISOString(),to:new Date(testEndMs).toISOString()
    },
    warmupDays:WARMUP_DAYS,symbolsTested:good.length,selectedSymbols:symbols,
    symbolErrors:results.filter(r=>r.error).map(r=>({symbol:r.symbol,error:r.error})),
    rules:{
      leverage:LEVERAGE,marginProfitTargetPct:MARGIN_TARGET_PCT,
      requiredFavorablePriceMovePct:MARGIN_TARGET_PCT/LEVERAGE,
      winDefinition:"5m Kraken Futures candles reach +30% gross ROI on margin before stop",
      lossDefinition:"fixed engine stop is reached before +30% margin ROI",
      execution:"signals use only closed candles; entry at next 5m candle open",
      ambiguousCandles:"if target and stop both occur inside one 5m candle, count stop-first",
      costs:"fees, funding and slippage excluded; gross results",
      sameSymbolConcurrency:"one open LONG per symbol at a time",
      dataSource:"Kraken Futures charts API only; no Bybit data or fallback",
      comparison:"A and B use identical 15m symbols, bullish window and execution rules; C and D use the same symbols and bullish window with 4h signal candles and 5m execution; C is the unchanged baseline and D applies the requested changes"
    },
    aggregate:{A:aggregate("A"),B:aggregate("B"),C:aggregate("C"),D:aggregate("D")},
    bySymbol:good.map(r=>({symbol:r.symbol,candles:r.candles,A:r.A.metrics,B:r.B.metrics,C:r.C.metrics,D:r.D.metrics})),
    trades:{
      A:good.flatMap(r=>r.A.trades).sort((a,b)=>a.signalCloseTime-b.signalCloseTime),
      B:good.flatMap(r=>r.B.trades).sort((a,b)=>a.signalCloseTime-b.signalCloseTime),
      C:good.flatMap(r=>r.C.trades).sort((a,b)=>a.signalCloseTime-b.signalCloseTime),
      D:good.flatMap(r=>r.D.trades).sort((a,b)=>a.signalCloseTime-b.signalCloseTime)
    }
  };
  await mkdir("artifacts",{recursive:true});
  await writeFile("artifacts/breakout-retest-long-comparison.json",JSON.stringify(report,null,2));
  const a=report.aggregate.A,b=report.aggregate.B,c=report.aggregate.C,d=report.aggregate.D;
  const md=[
    "# Kraken bullish-regime LONG comparison: A/B breakout-retest vs C EMA pullback","",
    "Period: "+report.marketRegime.from+" — "+report.marketRegime.to+" ("+regime.days+" days)",
    "BTC regime: daily close above EMA50 and EMA50 rising for every day in window.",
    "Symbols: "+symbols.join(", "),"",
    "| Metric | A: source baseline | B: breakout-retest | C: EMA pullback original | D: EMA pullback modified |",
    "|---|---:|---:|---:|",
    "| Signals | "+a.signals+" | "+b.signals+" | "+c.signals+" | "+d.signals+" |",
    "| Closed trades | "+a.closedTrades+" | "+b.closedTrades+" | "+c.closedTrades+" | "+d.closedTrades+" |",
    "| Wins (+30% margin ROI before stop) | "+a.wins30PctBeforeStop+" | "+b.wins30PctBeforeStop+" | "+c.wins30PctBeforeStop+" | "+d.wins30PctBeforeStop+" |",
    "| Stop-first losses | "+a.stopFirst+" | "+b.stopFirst+" | "+c.stopFirst+" | "+d.stopFirst+" |",
    "| Open at end | "+a.openAtEnd+" | "+b.openAtEnd+" | "+c.openAtEnd+" | "+d.openAtEnd+" |",
    "| Win rate | "+a.winRatePct.toFixed(2)+"% | "+b.winRatePct.toFixed(2)+"% | "+c.winRatePct.toFixed(2)+"% | "+d.winRatePct.toFixed(2)+"% |",
    "| Gross margin ROI points | "+a.totalMarginRoiPct.toFixed(2)+"% | "+b.totalMarginRoiPct.toFixed(2)+"% | "+c.totalMarginRoiPct.toFixed(2)+"% | "+d.totalMarginRoiPct.toFixed(2)+"% |",
    "| Average ROI / closed trade | "+a.averageMarginRoiPct.toFixed(2)+"% | "+b.averageMarginRoiPct.toFixed(2)+"% | "+c.averageMarginRoiPct.toFixed(2)+"% | "+d.averageMarginRoiPct.toFixed(2)+"% |",
    "| Max drawdown (additive ROI points) | "+a.maxDrawdownMarginPoints.toFixed(2)+"% | "+b.maxDrawdownMarginPoints.toFixed(2)+"% | "+c.maxDrawdownMarginPoints.toFixed(2)+"% | "+d.maxDrawdownMarginPoints.toFixed(2)+"% |",
    "| Ambiguous 5m candles | "+a.ambiguous5mCandles+" | "+b.ambiguous5mCandles+" | "+c.ambiguous5mCandles+" | "+d.ambiguous5mCandles+" |",
    "","| Symbol | A signals/win% | B signals/win% | C original | D modified |",
    "|---|---:|---:|---:|",
    ...report.bySymbol.map(r=>"| "+r.symbol+" | "+r.A.signals+" / "+r.A.winRatePct.toFixed(2)+"% | "+r.B.signals+" / "+r.B.winRatePct.toFixed(2)+"% | "+r.C.signals+" / "+r.C.winRatePct.toFixed(2)+"% | "+r.D.signals+" / "+r.D.winRatePct.toFixed(2)+"% |"),
    "","## Limitations",
    "- Gross performance excludes fees, funding and slippage.",
    "- 5m OHLC cannot reveal exact intrabar path; same-candle target/stop touches count as stop-first.",
    "- Daily bullish window is selected from BTC regime alone, independently of either engine's results.",
    "- Only Kraken Futures perpetual candles are used; no exchange fallback.",
    "- Version A's BTC 15m EMA50 filter remains part of its own strategy; B uses its 1h/4h filters.",
    "","## Data errors",...report.symbolErrors.map(x=>"- "+x.symbol+": "+x.error)
  ];
  await writeFile("artifacts/breakout-retest-long-comparison.md",md.join("\n"));
  console.log(JSON.stringify({period:report.marketRegime,aggregate:report.aggregate,bySymbol:report.bySymbol,symbolErrors:report.symbolErrors},null,2));
  if(!good.length)process.exitCode=1;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  main().catch(error=>{console.error(error);process.exitCode=1;});
}

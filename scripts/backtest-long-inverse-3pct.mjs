import { analyzeFuturesSymbol, FUTURES_CONFIG } from "../src/index.js";
import { mkdir, writeFile } from "node:fs/promises";

const BASE = "https://futures.kraken.com";
const HOUR = 3600000, FOUR_HOURS = 4 * HOUR, FIFTEEN_MINUTES = 900000;
const DAYS = 180;
const SYMBOL_LIMIT = 24;
const TARGET_MOVE = 0.03;
const MARGIN_USD = 10;
const LEVERAGE = 10;
const NOTIONAL_USD = MARGIN_USD * LEVERAGE;
const MARGIN_PROFIT_TARGET_PCT = 30;
const MAX_HOLD_HOURS = 72;

async function getJson(url) {
  const response = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(25000) });
  const body = await response.text();
  if (!response.ok) throw new Error("HTTP " + response.status + " for " + url + ": " + body.slice(0, 180));
  const data = JSON.parse(body);
  if (data?.result === "error" || (Array.isArray(data?.errors) && data.errors.length)) throw new Error("Kraken API error: " + JSON.stringify(data.errors || data.error));
  return data;
}

function normalize(rows, interval) {
  if (!Array.isArray(rows)) throw new Error("Kraken candles array missing");
  const seen = new Set();
  return rows.map(r => ({
    time: Number(r.time) < 1e12 ? Number(r.time) * 1000 : Number(r.time),
    open: Number(r.open), high: Number(r.high), low: Number(r.low), close: Number(r.close), volume: Number(r.volume)
  })).filter(c => Number.isFinite(c.time) && Number.isFinite(c.open) && Number.isFinite(c.high) &&
    Number.isFinite(c.low) && Number.isFinite(c.close) && c.open > 0 && c.close > 0 &&
    c.low > 0 && c.high >= c.low).sort((a,b)=>a.time-b.time).filter(c => {
      if (seen.has(c.time) || c.time + interval > Date.now()) return false;
      seen.add(c.time); return true;
    });
}

async function candles(symbol, resolution, from, to, interval) {
  const chunk = interval * 1750, all = [];
  for (let start=from; start<to; start+=chunk) {
    const end=Math.min(to,start+chunk);
    const url=new URL(BASE+"/api/charts/v1/trade/"+encodeURIComponent(symbol)+"/"+resolution);
    url.searchParams.set("from",String(Math.floor(start/1000)));
    url.searchParams.set("to",String(Math.floor(end/1000)));
    url.searchParams.set("count","1800");
    const data=await getJson(url);
    if (data.more_candles===true) throw new Error(symbol+" "+resolution+": incomplete chunk");
    all.push(...normalize(data.candles,interval));
  }
  return [...new Map(all.map(c=>[c.time,c])).values()].sort((a,b)=>a.time-b.time);
}

function historicalChange(rows,i) {
  const old=rows[i-24], now=rows[i];
  return old && old.close>0 ? (now.close/old.close-1)*100 : 0;
}

function evaluateFirstBarrier(rows, startAt, entry, stopPct) {
  // Every executed position is SHORT. The profit target is +30% on $10 margin
  // at 10x leverage (= 3% favorable underlying-price move, gross of costs).
  // Stop distance is copied from the original signal's own entry-to-stop percentage.
  const target=entry*(1-TARGET_MOVE);
  const stop=entry*(1+stopPct);
  const deadline=startAt+MAX_HOLD_HOURS*HOUR;
  for (const bar of rows) {
    if (bar.time < startAt) continue;
    if (bar.time > deadline) break;
    const hitTarget=bar.low<=target || bar.open<=target;
    const hitStop=bar.high>=stop || bar.open>=stop;
    if (hitTarget && hitStop) return { outcome:"AMBIGUOUS", hitTime:bar.time, target, stop };
    if (hitTarget) return { outcome:"TARGET", hitTime:bar.time, target, stop };
    if (hitStop) return { outcome:"STOP", hitTime:bar.time, target, stop };
  }
  return { outcome:"TIMEOUT", hitTime:null, target, stop };
}

async function backtestSymbol(ticker, from, to) {
  const [h1,h4,m15]=await Promise.all([
    candles(ticker.symbol,"1h",from,to,HOUR),
    candles(ticker.symbol,"4h",from,to,FOUR_HOURS),
    candles(ticker.symbol,"15m",from,to,FIFTEEN_MINUTES)
  ]);
  if(h1.length<120 || h4.length<FUTURES_CONFIG.MIN_CANDLES || m15.length<120)
    throw new Error("Insufficient candles: 1h="+h1.length+", 4h="+h4.length+", 15m="+m15.length);

  const found=[];
  let h4i=0, m15i=0;
  for(let i=60;i<h1.length-1;i++) {
    const signalBar=h1[i], signalClose=signalBar.time+HOUR, nextBar=h1[i+1];
    while(h4i<h4.length && h4[h4i].time+FOUR_HOURS<=signalClose) h4i++;
    while(m15i<m15.length && m15[m15i].time+FIFTEEN_MINUTES<=signalClose) m15i++;
    const closed4=h4.slice(0,h4i);
    const closed15=m15.slice(Math.max(0,m15i-120),m15i);
    if(closed4.length<FUTURES_CONFIG.MIN_CANDLES || closed15.length<60) continue;
    const tickerAtSignal={symbol:ticker.symbol,last:nextBar.open,quoteVolume:Number(ticker.volumeQuote)||0,
      priceChangePercent:historicalChange(h1,i),premium:{lastFundingRate:null}};
    const candidate=analyzeFuturesSymbol(tickerAtSignal,h1.slice(0,i+1),closed4,closed15);
    if(!candidate || !["LONG","SHORT"].includes(candidate.side) || (!candidate.eligible && !candidate.experimentalEligible)) continue;
    const entry=Number(candidate.entry), originalStop=Number(candidate.stop);
    if(!(entry>0) || !(originalStop>0)) continue;
    const stopPct=Math.abs(entry-originalStop)/entry;
    if(!(stopPct>0) || !Number.isFinite(stopPct)) continue;
    const cohort=candidate.side==="SHORT"?"NORMAL_SHORT":"INVERSE_LONG_SHORT";
    // Start checking at the first 15m candle opening at/after the signal's 1h close.
    if(m15i>=m15.length) continue;
    const result=evaluateFirstBarrier(m15.slice(m15i),signalClose,entry,stopPct);
    found.push({symbol:ticker.symbol,signalTime:signalClose,entry,originalSide:candidate.side,cohort,
      originalStop,stopPct,stopDistancePct:stopPct*100,score:candidate.score??null,
      eligibility:candidate.eligible?"STANDARD":"EXPERIMENTAL",marginUsd:MARGIN_USD,leverage:LEVERAGE,
      notionalUsd:NOTIONAL_USD,targetProfitUsd:MARGIN_USD*MARGIN_PROFIT_TARGET_PCT/100,...result});
  }
  return {symbol:ticker.symbol,candles:{h1:h1.length,h4:h4.length,m15:m15.length},signals:found};
}

function summarize(trades, cutoff) {
  const rows=trades.filter(t=>t.signalTime>=cutoff);
  const wins=rows.filter(t=>t.outcome==="TARGET").length;
  const stops=rows.filter(t=>t.outcome==="STOP").length;
  const ambiguous=rows.filter(t=>t.outcome==="AMBIGUOUS").length;
  const timeout=rows.filter(t=>t.outcome==="TIMEOUT").length;
  const decided=wins+stops;
  return {trades:rows.length,winners:wins,stopLosses:stops,ambiguous,timeouts,decided,
    winRateOfDecidedPct:decided?wins/decided*100:0,stopRateOfDecidedPct:decided?stops/decided*100:0,
    winRateOfAllPct:rows.length?wins/rows.length*100:0,stopRateOfAllPct:rows.length?stops/rows.length*100:0,
    grossProfitUsd:wins*MARGIN_USD*MARGIN_PROFIT_TARGET_PCT/100};
}

function splitSummary(trades, cutoff) {
  return {
    normalShort:summarize(trades.filter(t=>t.cohort==="NORMAL_SHORT"),cutoff),
    inverseLongAsShort:summarize(trades.filter(t=>t.cohort==="INVERSE_LONG_SHORT"),cutoff),
    combined:summarize(trades,cutoff)
  };
}

async function main() {
  const end=Date.now(), start=end-DAYS*24*HOUR, warmup=start-15*24*HOUR;
  const data=await getJson(BASE+"/derivatives/api/v3/tickers");
  if(!Array.isArray(data?.tickers)) throw new Error("Invalid Kraken tickers response");
  const universe=data.tickers.filter(t=>t?.tag==="perpetual"&&t.suspended!==true&&
    /^(PI|PF)_[A-Z0-9]+USD$/.test(String(t.symbol||""))&&
    Number(t.volumeQuote)>=FUTURES_CONFIG.MIN_QUOTE_VOLUME&&Number(t.last)>0)
    .sort((a,b)=>Number(b.volumeQuote)-Number(a.volumeQuote)).slice(0,SYMBOL_LIMIT);
  const results=[];
  for(const ticker of universe) {
    try { results.push(await backtestSymbol(ticker,warmup,end)); }
    catch(e) { results.push({symbol:ticker.symbol,error:String(e?.message||e),signals:[]}); }
  }
  const all=results.flatMap(r=>r.signals||[]).sort((a,b)=>a.signalTime-b.signalTime);
  const report={
    generatedAt:new Date().toISOString(),engineVersion:FUTURES_CONFIG.VERSION||"from-main-src",
    venue:"Kraken Futures public historical candles",
    position:{marginUsd:MARGIN_USD,leverage:LEVERAGE,notionalUsd:NOTIONAL_USD,
      profitTargetOnMarginPct:MARGIN_PROFIT_TARGET_PCT,targetPriceMovePct:TARGET_MOVE*100,
      grossProfitPerWinnerUsd:MARGIN_USD*MARGIN_PROFIT_TARGET_PCT/100},
    period180d:{from:new Date(start).toISOString(),to:new Date(end).toISOString(),days:180},
    period90d:{from:new Date(end-90*24*HOUR).toISOString(),to:new Date(end).toISOString(),days:90},
    settings:{symbolsRequested:SYMBOL_LIMIT,symbolsSucceeded:results.filter(r=>!r.error).length,
      signalLogic:"analyzeFuturesSymbol from repository source; eligible or experimentalEligible; both LONG and SHORT",
      executionLogic:"SHORT signals traded as normal SHORT; LONG signals inverted to SHORT at the same candidate.entry",
      entry:"candidate.entry, generated using next 1h candle open as ticker last",
      stopLogic:"For each signal, stopPct=abs(candidate.entry-candidate.stop)/candidate.entry; every executed SHORT stop is entry*(1+stopPct), preserving the original signal's entry-to-stop percentage distance",
      targetLogic:"All executed SHORT trades target entry*(1-3%); 3% favorable price move equals 30% gross return on $10 margin at 10x leverage",
      resolution:"15m candles; if target and stop both touched within same 15m candle, classify ambiguous",
      timeout:"No barrier within 72h is timeout; timeouts and ambiguous outcomes reported separately",
      universe:"Top 24 current-volume eligible Kraken perpetuals; historical universe/survivorship bias applies",
      costs:"Gross results; fees, funding and slippage excluded"},
    summary90d:splitSummary(all,end-90*24*HOUR),summary180d:splitSummary(all,start),
    symbols:results.map(r=>({symbol:r.symbol,error:r.error||null,candles:r.candles||null,
      summary90d:splitSummary(r.signals||[],end-90*24*HOUR),summary180d:splitSummary(r.signals||[],start)})),
    trades:all
  };
  await mkdir("artifacts",{recursive:true});
  await writeFile("artifacts/margin10x-dynamic-stop-30pct-90-180d.json",JSON.stringify(report,null,2));
  const fmt=s=>[s.trades,s.winners,s.stopLosses,s.ambiguous,s.timeouts,s.winRateOfDecidedPct.toFixed(2)+"%",s.grossProfitUsd.toFixed(2)].join(" | ");
  const lines=["# Futures backtest — $10 margin, 10x, 30% margin-profit target","",
    "Engine source: repository main ("+(report.engineVersion)+").",
    "Position: $10 margin × 10 = $100 notional; target is $3 gross profit / +3% favorable price move.",
    "Stop: per-signal original stop distance, mirrored above entry for every executed SHORT.",
    "Period: "+report.period180d.from+" to "+report.period180d.to,
    "Successful symbols: "+report.settings.symbolsSucceeded+"/"+SYMBOL_LIMIT,
    "Fees, funding and slippage excluded; 15m ambiguity and 72h timeouts reported separately.","",
    "| Window / cohort | Trades | Winners | Stop losses | Ambiguous | Timeouts | Win rate of decided | Gross profit ($) |",
    "|---|---:|---:|---:|---:|---:|---:|---:|",
    ...["90d","180d"].flatMap(w=>{const s=report["summary"+w];return [["Normal SHORT",s.normalShort],["Inverse LONG → SHORT",s.inverseLongAsShort],["Combined",s.combined]].map(([n,x])=>"| "+w+" / "+n+" | "+fmt(x)+" |");}),
    "","Win rate denominator is winners + stop losses; ambiguous and timeout trades are excluded.",
    "Universe is selected by current volume and therefore carries survivorship/universe bias."];
  await writeFile("artifacts/margin10x-dynamic-stop-30pct-90-180d.md",lines.join("\n"));
  console.log(JSON.stringify({ok:true,summary90d:report.summary90d,summary180d:report.summary180d,
    symbols:report.symbols},null,2));
}
main().catch(e=>{console.error(e);process.exitCode=1;});

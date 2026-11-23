import { analyzeFuturesSymbol, FUTURES_CONFIG } from "../src/index.js";
import { mkdir, writeFile } from "node:fs/promises";

const BASE = "https://futures.kraken.com";
const HOUR = 3600000, FOUR_HOURS = 4 * HOUR, FIFTEEN_MINUTES = 900000;
const DAYS = 180;
const SYMBOL_LIMIT = 24;
const MOVE = 0.03;
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

function evaluateFirstBarrier(rows, startAt, entry) {
  const down=entry*(1-MOVE), up=entry*(1+MOVE);
  const deadline=startAt+MAX_HOLD_HOURS*HOUR;
  let ambiguous=0;
  for (const bar of rows) {
    if (bar.time < startAt) continue;
    if (bar.time > deadline) break;
    // If a 15m candle touches both levels, OHLC cannot reveal which came first.
    const hitDown=bar.low<=down || bar.open<=down;
    const hitUp=bar.high>=up || bar.open>=up;
    if (hitDown && hitUp) return { outcome:"AMBIGUOUS", hitTime:bar.time, down, up };
    if (hitDown) return { outcome:"STOP", hitTime:bar.time, down, up };
    if (hitUp) return { outcome:"TARGET", hitTime:bar.time, down, up };
  }
  return { outcome:"TIMEOUT", hitTime:null, down, up };
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
    if(!candidate || candidate.side!=="LONG" || (!candidate.eligible && !candidate.experimentalEligible)) continue;
    const entry=Number(candidate.entry);
    if(!(entry>0)) continue;
    // Start checking at the first 15m candle opening at/after the signal's 1h close.
    if(m15i>=m15.length) continue;
    const result=evaluateFirstBarrier(m15.slice(m15i),signalClose,entry);
    found.push({symbol:ticker.symbol,signalTime:signalClose,entry,score:candidate.score??null,
      eligibility:candidate.eligible?"STANDARD":"EXPERIMENTAL",...result});
  }
  return {symbol:ticker.symbol,candles:{h1:h1.length,h4:h4.length,m15:m15.length},signals:found};
}

function summarize(trades, cutoff) {
  const rows=trades.filter(t=>t.signalTime>=cutoff);
  const stop=rows.filter(t=>t.outcome==="STOP").length;
  const target=rows.filter(t=>t.outcome==="TARGET").length;
  const ambiguous=rows.filter(t=>t.outcome==="AMBIGUOUS").length;
  const timeout=rows.filter(t=>t.outcome==="TIMEOUT").length;
  const decided=stop+target;
  return {signals:rows.length,stopHits:stop,targetHits:target,ambiguous,timeout,decided,
    stopSharePct:decided?stop/decided*100:0,targetSharePct:decided?target/decided*100:0,
    stopPctOfAll:rows.length?stop/rows.length*100:0,targetPctOfAll:rows.length?target/rows.length*100:0};
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
    venue:"Kraken Futures public historical candles",barrierPct:MOVE*100,maxWaitHours:MAX_HOLD_HOURS,
    period180d:{from:new Date(start).toISOString(),to:new Date(end).toISOString(),days:180},
    period90d:{from:new Date(end-90*24*HOUR).toISOString(),to:new Date(end).toISOString(),days:90},
    settings:{symbolsRequested:SYMBOL_LIMIT,symbolsSucceeded:results.filter(r=>!r.error).length,
      signalLogic:"analyzeFuturesSymbol from repository main (11.2.0 source); LONG only; eligible or experimentalEligible",
      entry:"candidate.entry, generated using next 1h candle open as ticker last",
      barrierLogic:"Original LONG stop at -3% is inverse SHORT win; original LONG target at +3% is inverse SHORT loss",
      resolution:"15m candles; if both barriers touched within same 15m candle, classify ambiguous",
      timeout:"No barrier within 72h is timeout; excluded from stop-vs-target percentage denominator",
      universe:"Top 24 current-volume eligible Kraken perpetuals; historical universe/survivorship bias applies"},
    summary90d:summarize(all,end-90*24*HOUR),summary180d:summarize(all,start),
    symbols:results.map(r=>({symbol:r.symbol,error:r.error||null,candles:r.candles||null,
      summary90d:summarize(r.signals||[],end-90*24*HOUR),summary180d:summarize(r.signals||[],start)})),
    trades:all
  };
  await mkdir("artifacts",{recursive:true});
  await writeFile("artifacts/long-inverse-3pct-90-180d.json",JSON.stringify(report,null,2));
  const lines=["# LONG inverse test — fixed ±3% barriers","",
    "Engine source: repository main (CONFIG.VERSION 11.2.0).",
    "Period: "+report.period180d.from+" to "+report.period180d.to,
    "Symbols tested successfully: "+report.settings.symbolsSucceeded+"/"+SYMBOL_LIMIT,
    "Entry: candidate.entry; barrier monitoring on 15m candles; max wait 72h.","",
    "| Window | LONG signals | Original stop hit (inverse win) | Original target hit (inverse loss) | Ambiguous | Timeout | Stop share of decided | Target share of decided |",
    "|---|---:|---:|---:|---:|---:|---:|---:|",
    ...[["90d",report.summary90d],["180d",report.summary180d]].map(([n,s])=>"| "+n+" | "+s.signals+" | "+s.stopHits+" | "+s.targetHits+" | "+s.ambiguous+" | "+s.timeout+" | "+s.stopSharePct.toFixed(2)+"% | "+s.targetSharePct.toFixed(2)+"% |"),
    "","A 15m candle touching both barriers is not guessed; it is reported as ambiguous.",
    "Timeouts and ambiguous outcomes are excluded from the stop-vs-target percentage denominator.",
    "Universe is selected by current volume and therefore carries survivorship/universe bias."];
  await writeFile("artifacts/long-inverse-3pct-90-180d.md",lines.join("\n"));
  console.log(JSON.stringify({ok:true,summary90d:report.summary90d,summary180d:report.summary180d,
    symbols:report.symbols},null,2));
}
main().catch(e=>{console.error(e);process.exitCode=1;});

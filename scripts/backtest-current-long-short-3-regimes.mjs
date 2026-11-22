import { mkdir, writeFile } from "node:fs/promises";
import { analyzeFuturesSymbol, FUTURES_CONFIG } from "../src/index.js";
import { evaluateTradeCandle, FUTURES_TRADE_LEVERAGE, FUTURES_MARGIN_PROFIT_TARGET_PERCENT } from "../src/futures-trade-lifecycle.js";

const BASE="https://futures.kraken.com";
const INTERVALS={"5m":300000,"15m":900000,"1h":3600000,"4h":14400000};
const SYMBOL_LIMIT=10;
const WARMUP_DAYS=15;
const TARGET=FUTURES_MARGIN_PROFIT_TARGET_PERCENT;
const LEVERAGE=FUTURES_TRADE_LEVERAGE;
const REGIMES=[
 {id:"bullish",label:"صعودی",from:"2024-10-01T00:00:00Z",to:"2024-11-01T00:00:00Z"},
 {id:"bearish",label:"نزولی",from:"2025-02-01T00:00:00Z",to:"2025-03-01T00:00:00Z"},
 {id:"neutral",label:"خنثی",from:"2023-09-01T00:00:00Z",to:"2023-10-01T00:00:00Z"}
];

async function getJson(url,attempt=0){
 const response=await fetch(url,{headers:{accept:"application/json"},signal:AbortSignal.timeout(30000)});
 const body=await response.text();
 if(!response.ok){
  if(attempt<3&&(response.status===429||response.status>=500)){await new Promise(r=>setTimeout(r,800*(attempt+1)));return getJson(url,attempt+1);}
  throw new Error("HTTP "+response.status+" "+body.slice(0,160));
 }
 let data;try{data=JSON.parse(body)}catch{throw new Error("Invalid Kraken JSON")};
 if(data?.result==="error"||(Array.isArray(data?.errors)&&data.errors.length))throw new Error("Kraken error "+JSON.stringify(data.errors||data.error));
 return data;
}
function normalize(rows,intervalMs){
 if(!Array.isArray(rows))throw new Error("Kraken candles array missing");
 const seen=new Set();
 return rows.map(row=>({time:Number(row.time)<1e12?Number(row.time)*1000:Number(row.time),open:Number(row.open),high:Number(row.high),low:Number(row.low),close:Number(row.close),volume:Number(row.volume)}))
 .filter(c=>Number.isFinite(c.time)&&[c.open,c.high,c.low,c.close,c.volume].every(Number.isFinite)&&c.open>0&&c.close>0&&c.low>0&&c.high>=c.low&&c.volume>=0&&c.time+intervalMs<=Date.now())
 .sort((a,b)=>a.time-b.time).filter(c=>{if(seen.has(c.time))return false;seen.add(c.time);return true;});
}
async function fetchCandles(symbol,resolution,fromMs,toMs){
 const step=INTERVALS[resolution]*1700,all=[];
 for(let start=fromMs;start<toMs;start+=step){
  const end=Math.min(toMs,start+step),url=new URL(BASE+"/api/charts/v1/trade/"+encodeURIComponent(symbol)+"/"+resolution);
  url.searchParams.set("from",String(Math.floor(start/1000)));
  url.searchParams.set("to",String(Math.floor(end/1000)));
  url.searchParams.set("count","1800");
  const data=await getJson(url);
  if(data.more_candles===true)throw new Error(symbol+" "+resolution+" incomplete Kraken chunk");
  all.push(...normalize(data.candles,INTERVALS[resolution]));
  await new Promise(r=>setTimeout(r,80));
 }
 return [...new Map(all.map(c=>[c.time,c])).values()].sort((a,b)=>a.time-b.time);
}
function historicalChange(candles,index){
 const old=candles[index-24],now=candles[index];
 return !old||old.close<=0?0:(now.close/old.close-1)*100;
}
function lowerBound(a,t){let l=0,h=a.length;while(l<h){const m=(l+h)>>1;if(a[m].time<t)l=m+1;else h=m;}return l;}
function candleAmbiguous(side,trade,c){
 const e=Number(trade.entry),s=Number(trade.initialStop),target=e*(1+(side==="LONG"?1:-1)*TARGET/LEVERAGE/100);
 const stop=side==="LONG"?c.low<=s:c.high>=s,profit=side==="LONG"?c.high>=target:c.low<=target;
 const stopOpen=side==="LONG"?c.open<=s:c.open>=s,profitOpen=side==="LONG"?c.open>=target:c.open<=target;
 return stop&&profit&&!stopOpen&&!profitOpen;
}
const emptySide=()=>({directionalCandidates:0,eligibleSignals:0,startedTrades:0,lockSkips:0,rejectedOrNotEligible:0});
function summarize(trades){
 const closed=trades.filter(t=>["CLOSED_PROFIT","CLOSED_STOP"].includes(t.status));
 const wins=closed.filter(t=>t.status==="CLOSED_PROFIT"),stops=closed.filter(t=>t.status==="CLOSED_STOP");
 const sum=a=>a.reduce((s,t)=>s+Number(t.marginReturnPercent||0),0);
 let eq=0,peak=0,dd=0;
 for(const t of [...closed].sort((a,b)=>a.closedAtMs-b.closedAtMs)){eq+=Number(t.marginReturnPercent||0);peak=Math.max(peak,eq);dd=Math.max(dd,peak-eq);}
 return {tradesStarted:trades.length,closedTrades:closed.length,profitCloses:wins.length,stopCloses:stops.length,openAtEnd:trades.length-closed.length,
  winRatePct:closed.length?wins.length/closed.length*100:0,totalMarginReturnPct:sum(closed),averageMarginReturnPct:closed.length?sum(closed)/closed.length:0,
  maxDrawdownMarginPct:dd,ambiguous5mCandles:trades.reduce((n,t)=>n+(t.ambiguousCandles||0),0)};
}
async function backtestSymbol(ticker,period){
 const from=Date.parse(period.from),to=Date.parse(period.to),warm=from-WARMUP_DAYS*86400000;
 const [oneHour,fourHour,fifteenMinute,fiveMinute]=await Promise.all([
  fetchCandles(ticker.symbol,"1h",warm,to),fetchCandles(ticker.symbol,"4h",warm,to),
  fetchCandles(ticker.symbol,"15m",warm,to),fetchCandles(ticker.symbol,"5m",from,to)
 ]);
 if(oneHour.length<100||fourHour.length<FUTURES_CONFIG.MIN_CANDLES||fifteenMinute.length<120||fiveMinute.length<1000)
  throw new Error("insufficient candles 1h="+oneHour.length+" 4h="+fourHour.length+" 15m="+fifteenMinute.length+" 5m="+fiveMinute.length);
 const trades=[],lockUntil=new Map(),initial={LONG:emptySide(),SHORT:emptySide()};
 let fourIndex=0,fifteenIndex=0,scanEvaluations=0,neutralNoSetup=0;
 const testStart=from;
 for(let i=60;i<oneHour.length-1;i++){
  const signalBar=oneHour[i],signalClose=signalBar.time+INTERVALS["1h"];
  if(signalClose<testStart||signalClose>=to)continue;
  while(fourIndex<fourHour.length&&fourHour[fourIndex].time+INTERVALS["4h"]<=signalClose)fourIndex++;
  while(fifteenIndex<fifteenMinute.length&&fifteenMinute[fifteenIndex].time+INTERVALS["15m"]<=signalClose)fifteenIndex++;
  const closed4h=fourHour.slice(0,fourIndex),closed15m=fifteenMinute.slice(Math.max(0,fifteenIndex-120),fifteenIndex);
  if(closed4h.length<FUTURES_CONFIG.MIN_CANDLES||closed15m.length<40)continue;
  const nextBar=oneHour[i+1];
  const tickerAtSignal={symbol:ticker.symbol,last:nextBar.open,quoteVolume:Number(ticker.volumeQuote)||0,
   priceChangePercent:historicalChange(oneHour,i),premium:{lastFundingRate:null}};
  let candidate;scanEvaluations++;
  try{candidate=analyzeFuturesSymbol(tickerAtSignal,oneHour.slice(0,i+1),closed4h,closed15m);}
  catch{neutralNoSetup++;continue;}
  if(!candidate?.side||!["LONG","SHORT"].includes(candidate.side)){neutralNoSetup++;continue;}
  const side=candidate.side;initial[side].directionalCandidates++;
  if(candidate.eligible!==true){initial[side].rejectedOrNotEligible++;continue;}
  initial[side].eligibleSignals++;
  const key=ticker.symbol+"|"+side;
  if((lockUntil.get(key)||0)>signalClose){initial[side].lockSkips++;continue;}
  const entry=Number(candidate.entry);
  const trade={id:ticker.symbol+":"+side+":"+signalClose,symbol:ticker.symbol,side,status:"OPEN",
   entry,actualEntry:entry,initialStop:Number(candidate.stop),currentStop:Number(candidate.stop),stop:Number(candidate.stop),
   signalTime:signalBar.time,entryTime:signalClose,score:candidate.score,ambiguousCandles:0};
  let closed=false;
  for(let j=lowerBound(fiveMinute,signalClose);j<fiveMinute.length&&fiveMinute[j].time<to;j++){
   const bar=fiveMinute[j];
   if(candleAmbiguous(side,trade,bar))trade.ambiguousCandles++;
   const result=evaluateTradeCandle(trade,{...bar,time:bar.time+INTERVALS["5m"]});
   if(result.changed){Object.assign(trade,result.trade);trade.closedAtMs=bar.time+INTERVALS["5m"];closed=true;break;}
  }
  if(!closed){
   trade.status="OPEN_AT_BACKTEST_END";
   const mark=fiveMinute.at(-1)?.close??null;
   trade.lastMark=mark;
   trade.marginReturnAtMarkPct=mark?(side==="LONG"?1:-1)*(mark-entry)/entry*100*LEVERAGE:null;
   lockUntil.set(key,to);
  }else lockUntil.set(key,trade.closedAtMs);
  initial[side].startedTrades++;
  trades.push(trade);
 }
 return {symbol:ticker.symbol,candles:{"1h":oneHour.length,"4h":fourHour.length,"15m":fifteenMinute.length,"5m":fiveMinute.length},
  scanEvaluations,neutralNoSetup,initial,trades,metrics:{LONG:summarize(trades.filter(t=>t.side==="LONG")),SHORT:summarize(trades.filter(t=>t.side==="SHORT"))}};
}
function aggregate(results,side){
 const trades=results.flatMap(r=>r.trades).filter(t=>t.side===side);
 const initial=results.reduce((a,r)=>{for(const k of Object.keys(a))a[k]+=r.initial[side][k];return a;},emptySide());
 return {initial,performance:summarize(trades),trades};
}
async function runRegime(period,universe){
 const from=Date.parse(period.from),to=Date.parse(period.to),results=[],errors=[];
 for(let i=0;i<universe.length;i++){
  const ticker=universe[i];
  console.log("["+period.id+"] "+(i+1)+"/"+universe.length+" "+ticker.symbol);
  try{results.push(await backtestSymbol(ticker,period));}
  catch(e){errors.push({symbol:ticker.symbol,error:String(e?.message||e)});console.error("FAILED",ticker.symbol,String(e?.message||e));}
 }
 const long=aggregate(results,"LONG"),short=aggregate(results,"SHORT");
 return {id:period.id,label:period.label,period:{from:period.from,to:period.to},symbolsRequested:universe.length,symbolsTested:results.length,errors,
  initialEvaluation:{scanEvaluations:results.reduce((n,r)=>n+r.scanEvaluations,0),LONG:long.initial,SHORT:short.initial,
   noDirectionalSetup:results.reduce((n,r)=>n+r.neutralNoSetup,0)},
  engines:{LONG:{initial:long.initial,performance:long.performance,bySymbol:results.map(r=>({symbol:r.symbol,...r.metrics.LONG}))},
   SHORT:{initial:short.initial,performance:short.performance,bySymbol:results.map(r=>({symbol:r.symbol,...r.metrics.SHORT}))}},
  trades:{LONG:long.trades,SHORT:short.trades}};
}
async function main(){
 const tickerData=await getJson(BASE+"/derivatives/api/v3/tickers");
 if(!Array.isArray(tickerData?.tickers))throw new Error("Kraken tickers response invalid");
 const universe=tickerData.tickers.filter(t=>t?.tag==="perpetual"&&t.suspended!==true&&/^(PI|PF)_[A-Z0-9]+USD$/.test(String(t.symbol||""))&&Number(t.volumeQuote)>=FUTURES_CONFIG.MIN_QUOTE_VOLUME&&Number(t.last)>0)
  .sort((a,b)=>Number(b.volumeQuote)-Number(a.volumeQuote)).slice(0,SYMBOL_LIMIT);
 if(!universe.length)throw new Error("No eligible Kraken perpetual contracts found");
 const results=[];
 for(const p of REGIMES)results.push(await runRegime(p,universe));
 const report={generatedAt:new Date().toISOString(),source:"Production main branch v"+(await import("../src/index.js")).FUTURES_CONFIG.VERSION,
  strategy:"Current unified futures engine, LONG and SHORT evaluated separately",symbols:universe.map(t=>({symbol:t.symbol,currentQuoteVolume:Number(t.volumeQuote)||0})),
  rules:{signalSource:"Exact production analyzeFuturesSymbol imported from src/index.js; no signal logic modified",timeframes:"1h primary, 4h trend confirmation, 15m entry confirmation",entry:"next 1h candle open after the 1h signal candle closes (historical equivalent of live ticker at scan)",exit:"exact production evaluateTradeCandle from src/futures-trade-lifecycle.js",leverage:LEVERAGE,targetMarginPercent:TARGET,requiredFavorablePriceMovePct:TARGET/LEVERAGE,stop:"production signal stop; unchanged",stopPriority:"stop-first on ambiguous 5m candles unless candle open gaps through a level",sameSideLock:"one active trade per symbol and side; opposite side can overlap",maxSignalsPerScan:FUTURES_CONFIG.MAX_SIGNALS_PER_SCAN,universe:"top 10 current Kraken perpetuals by current quote volume, filtered at production $5m minimum; survivorship bias applies",fees:"excluded, matching production lifecycle calculation",funding:"historical funding unavailable; omitted from historical score penalty"},
  results};
 await mkdir("artifacts",{recursive:true});
 await writeFile("artifacts/current-long-short-3-regimes.json",JSON.stringify(report,null,2));
 const rows=["# Current production LONG/SHORT engines — three-regime backtest","",
  "Production engine version: "+report.source,"Universe: "+universe.map(t=>t.symbol).join(", "),"Target: +"+TARGET+"% margin at "+LEVERAGE+"x = "+(TARGET/LEVERAGE)+"% underlying favorable move.","",
  "| Regime | Engine | Directional candidates | Eligible | Started | Closed | TP +30% | Stops | Win rate | Net margin % | Max DD margin pts |",
  "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|"];
 for(const p of results)for(const side of ["LONG","SHORT"]){const e=p.engines[side],m=e.performance;rows.push("| "+p.label+" | "+side+" | "+e.initial.directionalCandidates+" | "+e.initial.eligibleSignals+" | "+m.tradesStarted+" | "+m.closedTrades+" | "+m.profitCloses+" | "+m.stopCloses+" | "+m.winRatePct.toFixed(2)+"% | "+m.totalMarginReturnPct.toFixed(2)+"% | "+m.maxDrawdownMarginPct.toFixed(2)+" |");}
 rows.push("","## Initial scan diagnostics");
 for(const p of results){rows.push("### "+p.label,"- Evaluations: "+p.initialEvaluation.scanEvaluations,"- No directional setup: "+p.initialEvaluation.noDirectionalSetup);for(const side of ["LONG","SHORT"]){const x=p.engines[side].initial;rows.push("- "+side+": directional="+x.directionalCandidates+", eligible="+x.eligibleSignals+", not eligible="+x.rejectedOrNotEligible+", same-side lock skips="+x.lockSkips+", started="+x.startedTrades);}}
 rows.push("","## Per-symbol and error details");
 for(const p of results){rows.push("### "+p.label);for(const side of ["LONG","SHORT"]){rows.push("#### "+side);for(const s of p.engines[side].bySymbol){const m=s[side];rows.push("- "+s.symbol+": "+m.closedTrades+" closed; "+m.profitCloses+" TP; "+m.stopCloses+" stops; "+m.winRatePct.toFixed(2)+"% win; "+m.totalMarginReturnPct.toFixed(2)+"% margin return");}}for(const e of p.errors)rows.push("- ERROR "+e.symbol+": "+e.error);}
 rows.push("","## Limitations","- Fixed 30-day periods: bullish Oct 2024, bearish Feb 2025, neutral Sep 2023.","- Top 10 currently liquid Kraken perpetuals; survivorship bias applies and historical listings are not reconstructed.","- Historical funding is unavailable and funding score penalty is omitted.","- Fees and slippage are excluded because production lifecycle uses gross margin return; therefore reported margin returns are gross.","- 5m OHLC cannot prove intrabar order; ambiguous stop/target bars use production stop-first behavior.","- Entries are evaluated once per closed 1h bar at next 1h open; live production cron scans every 5m, so repeated intrahour signals are not modelled.","- Open trades at period end are not counted as closed wins/losses.");
 await writeFile("artifacts/current-long-short-3-regimes.md",rows.join("\n"));
 console.log("FINAL_SUMMARY");
 console.log(JSON.stringify(results.map(p=>({regime:p.label,period:p.period,symbolsTested:p.symbolsTested,errors:p.errors,initialEvaluation:p.initialEvaluation,engines:Object.fromEntries(["LONG","SHORT"].map(side=>[side,{initial:p.engines[side].initial,performance:p.engines[side].performance}]))})),null,2));
 if(results.every(p=>p.symbolsTested===0))throw new Error("No historical symbols successfully tested");
}
main().catch(e=>{console.error(e);process.exitCode=1;});

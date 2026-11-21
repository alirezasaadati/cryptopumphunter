import { mkdir, writeFile } from "node:fs/promises";
import { analyzeFuturesSymbol } from "../src/v63-long-btc-engine.mjs";

const BASE = "https://futures.kraken.com";
const MS = { "5m": 300000, "1h": 3600000, "4h": 14400000 };
const FEE = 0.0005, SLIPPAGE = 0.0003, SYMBOL_LIMIT = 7, WINDOW = 150;
const PERIODS = [
  { name: "LONG_BULL_2024_Q4", start: "2024-10-01T00:00:00Z", end: "2024-12-01T00:00:00Z" },
  { name: "LONG_BULL_2025_Q2", start: "2025-04-01T00:00:00Z", end: "2025-06-01T00:00:00Z" }
];
const TARGETS = [
  { key: "TP1", field: "target1", label: "1.5R" },
  { key: "TP2", field: "target2", label: "2.5R" },
  { key: "TP3", field: "target3", label: "4.0R" }
];
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function getJson(url, attempt = 0) {
  const response = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(30000) });
  const body = await response.text();
  if (!response.ok) {
    if (attempt < 5 && (response.status === 429 || response.status >= 500)) {
      await sleep(800 * (attempt + 1)); return getJson(url, attempt + 1);
    }
    throw new Error("HTTP " + response.status + " " + url + " " + body.slice(0, 160));
  }
  const data = JSON.parse(body);
  if (data?.result === "error" || (Array.isArray(data?.errors) && data.errors.length)) throw new Error("Kraken API error: " + JSON.stringify(data.errors || data.error));
  return data;
}
function normalize(rows, intervalMs) {
  const seen = new Set();
  return rows.map(r => ({
    time: Number(r.time) < 1e12 ? Number(r.time) * 1000 : Number(r.time),
    open: Number(r.open), high: Number(r.high), low: Number(r.low), close: Number(r.close), volume: Number(r.volume)
  })).filter(c => Number.isFinite(c.time) && [c.open,c.high,c.low,c.close,c.volume].every(Number.isFinite) &&
    c.open > 0 && c.low > 0 && c.close > 0 && c.high >= c.low && c.volume >= 0 &&
    c.time + intervalMs <= Date.now()).sort((a,b)=>a.time-b.time).filter(c=>{
      if(seen.has(c.time)) return false; seen.add(c.time); return true;
    });
}
async function fetchCandles(symbol, interval, fromMs, toMs) {
  const intervalMs = MS[interval], chunkMs = intervalMs * 1600, all = [];
  for(let from=fromMs; from<toMs; from+=chunkMs) {
    const to=Math.min(toMs,from+chunkMs);
    const url=new URL(BASE+"/api/charts/v1/trade/"+encodeURIComponent(symbol)+"/"+interval);
    url.searchParams.set("from",String(Math.floor(from/1000)));
    url.searchParams.set("to",String(Math.floor(to/1000)));
    url.searchParams.set("count","1750");
    const data=await getJson(url);
    if(data.more_candles===true) throw new Error(symbol+" "+interval+" incomplete candle chunk");
    all.push(...normalize(data.candles||[],intervalMs));
    await sleep(90);
  }
  const map=new Map(all.map(c=>[c.time,c]));
  return [...map.values()].sort((a,b)=>a.time-b.time);
}
function lowerBound(candles,time) {
  let lo=0,hi=candles.length;
  while(lo<hi){const mid=(lo+hi)>>1;if(candles[mid].time<time)lo=mid+1;else hi=mid;}
  return lo;
}
function simulate({candidate,target,candles,entryTime,endTime,symbol}) {
  const rawEntry=Number(candidate.entry), stop=Number(candidate.stop), targetPrice=Number(candidate[target.field]);
  const entryFill=rawEntry*(1+SLIPPAGE), risk=entryFill-stop;
  if(!(risk>0)||!Number.isFinite(targetPrice)) return {outcome:"INVALID_LEVELS",netR:null,symbol};
  const start=lowerBound(candles,entryTime);
  for(let i=start;i<candles.length&&candles[i].time<endTime;i++){
    const b=candles[i], stopHit=b.low<=stop, tpHit=b.high>=targetPrice;
    if(!stopHit&&!tpHit)continue;
    const stopAtOpen=b.open<=stop, tpAtOpen=b.open>=targetPrice;
    const stopped=stopAtOpen||(!tpAtOpen&&stopHit);
    const rawExit=stopped?(stopAtOpen?b.open:stop):(tpAtOpen?b.open:targetPrice);
    const exitFill=rawExit*(1-SLIPPAGE);
    const netR=(exitFill-entryFill)/risk-FEE*(entryFill+exitFill)/risk;
    return {outcome:stopped?"SL":"TP",netR,symbol,target:target.key,entryTime,closedAtMs:b.time+MS["5m"],barsHeld:i-start+1};
  }
  return {outcome:"OPEN",netR:null,symbol,target:target.key,entryTime,closedAtMs:endTime,barsHeld:candles.length-start};
}
function summarize(trades) {
  const closed=trades.filter(t=>t.outcome==="TP"||t.outcome==="SL");
  const wins=closed.filter(t=>t.outcome==="TP"), losses=closed.filter(t=>t.outcome==="SL");
  const open=trades.filter(t=>t.outcome==="OPEN");
  const netR=closed.reduce((s,t)=>s+t.netR,0);
  const grossWin=wins.reduce((s,t)=>s+Math.max(0,t.netR),0);
  const grossLoss=Math.abs(losses.reduce((s,t)=>s+Math.min(0,t.netR),0));
  let eq=0,peak=0,dd=0;
  for(const t of [...closed].sort((a,b)=>a.closedAtMs-b.closedAtMs)){eq+=t.netR;peak=Math.max(peak,eq);dd=Math.max(dd,peak-eq);}
  return {trades:trades.length,tp:wins.length,sl:losses.length,open:open.length,
    winRatePct:closed.length?wins.length/closed.length*100:0,netR,avgR:closed.length?netR/closed.length:0,
    profitFactor:grossLoss?grossWin/grossLoss:null,maxDrawdownR:dd};
}
async function backtestSymbol(ticker,period,btc4h) {
  const start=Date.parse(period.start),end=Date.parse(period.end);
  const [h1,h4,m5]=await Promise.all([
    fetchCandles(ticker.symbol,"1h",start-16*86400000,end),
    fetchCandles(ticker.symbol,"4h",start-45*86400000,end),
    fetchCandles(ticker.symbol,"5m",start,end)
  ]);
  if(h1.length<150||h4.length<60||m5.length<100) throw new Error("Insufficient candles 1h="+h1.length+" 4h="+h4.length+" 5m="+m5.length);
  const tradesByTarget=Object.fromEntries(TARGETS.map(t=>[t.key,[]]));
  const locks=Object.fromEntries(TARGETS.map(t=>[t.key,0]));
  let eligible=0,rejected=0; const reasons={};
  let h4Index=0,btcIndex=0;
  for(let i=149;i<h1.length-1;i++){
    const bar=h1[i], signalClose=bar.time+MS["1h"];
    if(signalClose<start||signalClose>=end)continue;
    while(h4Index<h4.length&&h4[h4Index].time+MS["4h"]<=signalClose)h4Index++;
    while(btcIndex<btc4h.length&&btc4h[btcIndex].time+MS["4h"]<=signalClose)btcIndex++;
    const c4=h4.slice(Math.max(0,h4Index-WINDOW),h4Index);
    const btcClosed=btc4h.slice(Math.max(0,btcIndex-WINDOW),btcIndex);
    if(c4.length<60||btcClosed.length<60)continue;
    const next=h1[i+1];
    const tickerAtEntry={symbol:ticker.symbol,last:next.open};
    let candidate;
    try{candidate=analyzeFuturesSymbol(tickerAtEntry,h1.slice(i-149,i+1),c4,btcClosed);}
    catch(e){rejected++;const k="exception: "+String(e?.message||e);reasons[k]=(reasons[k]||0)+1;continue;}
    if(candidate?.eligible!==true||candidate.side!=="LONG"){
      if(candidate?.rejected){rejected++;reasons[candidate.rejected]=(reasons[candidate.rejected]||0)+1;}
      continue;
    }
    eligible++;
    for(const t of TARGETS){
      if(locks[t.key]>signalClose)continue;
      const trade=simulate({candidate,target:t,candles:m5,entryTime:signalClose,endTime:end,symbol:ticker.symbol});
      trade.score=candidate.score;trade.signalTime=bar.time;
      tradesByTarget[t.key].push(trade);
      locks[t.key]=trade.closedAtMs||end;
    }
  }
  const priceBars=h1.filter(c=>c.time>=start&&c.time<end);
  return {symbol:ticker.symbol,marketChangePct:priceBars.length>1?(priceBars.at(-1).close/priceBars[0].close-1)*100:null,
    candles:{h1:h1.length,h4:h4.length,m5:m5.length},eligibleSignals:eligible,rejected,rejectReasons:reasons,
    targets:Object.fromEntries(TARGETS.map(t=>[t.key,{metrics:summarize(tradesByTarget[t.key]),trades:tradesByTarget[t.key]}]))};
}
function aggregate(results) {
  return Object.fromEntries(TARGETS.map(t=>[t.key,{metrics:summarize(results.flatMap(r=>r.targets[t.key].trades)),trades:results.flatMap(r=>r.targets[t.key].trades)}]));
}
async function main(){
  const tickerData=await getJson(BASE+"/derivatives/api/v3/tickers");
  const universe=(tickerData.tickers||[]).filter(t=>t?.tag==="perpetual"&&t.suspended!==true&&/^(PI|PF)_[A-Z0-9]+USD$/.test(String(t.symbol||""))&&Number(t.volumeQuote)>=5000000&&Number(t.last)>0)
    .sort((a,b)=>Number(b.volumeQuote)-Number(a.volumeQuote)).slice(0,SYMBOL_LIMIT);
  if(!universe.length)throw new Error("No Kraken perpetuals pass current $5m volume filter");
  const report={generatedAt:new Date().toISOString(),strategy:"User-supplied Crypto Pump Hunter v6.3.0 LONG-only with BTC 4h macro filter",
    venue:"Kraken Futures historical trade candles",
    universe:{filter:"Current perpetual contracts, quote volume >= $5m",selected:universe.map(t=>t.symbol)},
    periods:[],assumptions:{
      signalEvaluation:"One evaluation per completed 1h candle; only fully closed 1h, symbol 4h and BTC 4h candles supplied; 150-bar rolling windows.",
      btcMacro:"At each signal timestamp, BTC 4h close must be above EMA50 and EMA50 must exceed EMA50 calculated on the BTC 4h closes ending 10 candles earlier. All BTC candles are closed as of the signal time.",
      entry:"Next 1h candle open used as historical proxy for ticker.last; drift filter compares this proxy with the signal 1h close. v6.3.0 has no 15m trigger.",
      exits:"5m OHLC; stop-first for same-candle stop/target ambiguity unless candle opens beyond target.",
      targets:"Independent TP1 1.5R, TP2 2.5R, TP3 4R; one active trade per symbol and target.",
      costs:{feePerSide:FEE,slippagePerSide:SLIPPAGE},funding:"Historical funding is not applied.",
      capital:"Results are net R; no account sizing, leverage, compounding or liquidation simulation.",
      universeBias:"Today's top-volume contracts create survivorship/listing bias; historical data gaps are reported."
    }};
  for(const p of PERIODS){
    console.log("PERIOD",p.name);
    const start=Date.parse(p.start),end=Date.parse(p.end);
    const btc4h=await fetchCandles("PF_XBTUSD","4h",start-45*86400000,end);
    if(btc4h.length<60)throw new Error("Insufficient historical BTC 4h candles for "+p.name);
    const results=[];
    for(const t of universe){
      console.log("TEST",p.name,t.symbol);
      try{results.push(await backtestSymbol(t,p,btc4h));}
      catch(e){results.push({symbol:t.symbol,error:String(e?.message||e)});}
    }
    const ok=results.filter(r=>!r.error);
    const btcBars=btc4h.filter(c=>c.time>=start&&c.time<end);
    const changes=ok.map(r=>r.marketChangePct).filter(Number.isFinite).sort((a,b)=>a-b);
    const aggregateResults=aggregate(ok);
    report.periods.push({period:p,successfulSymbols:ok.map(r=>r.symbol),errors:results.filter(r=>r.error),
      marketContext:{btcChangePct:btcBars.length>1?(btcBars.at(-1).close/btcBars[0].close-1)*100:null,
        medianSymbolChangePct:changes.length?changes[Math.floor(changes.length/2)]:null},
      eligibleSignals:ok.reduce((s,r)=>s+r.eligibleSignals,0),
      rejectedEvaluations:ok.reduce((s,r)=>s+r.rejected,0),
      rejectReasons:ok.reduce((acc,r)=>{for(const [k,v] of Object.entries(r.rejectReasons))acc[k]=(acc[k]||0)+v;return acc;},{}),
      targets:Object.fromEntries(TARGETS.map(t=>[t.key,{label:t.label,metrics:aggregateResults[t.key].metrics,trades:aggregateResults[t.key].trades}])),
      perSymbol:ok.map(r=>({symbol:r.symbol,marketChangePct:r.marketChangePct,eligibleSignals:r.eligibleSignals,rejected:r.rejected,rejectReasons:r.rejectReasons,
        targets:Object.fromEntries(TARGETS.map(t=>[t.key,r.targets[t.key].metrics]))}))});
  }
  if(!report.periods.some(p=>p.successfulSymbols.length))throw new Error("No symbol completed either historical period");
  await mkdir("artifacts",{recursive:true});
  await writeFile("artifacts/v630-long-btc-backtest.json",JSON.stringify(report,null,2));
  const md=["# Crypto Pump Hunter v6.3.0 — LONG-only BTC macro historical backtest","",
    "Strategy logic copied from the user's supplied code; no strategy parameters changed.",
    "Costs: 0.05% fee and 0.03% adverse slippage per side. Funding not applied.",""];
  for(const p of report.periods){
    md.push("## "+p.period.name+" ("+p.period.start+" to "+p.period.end+")",
      "Successful symbols: "+p.successfulSymbols.join(", "),
      "BTC change: "+(p.marketContext.btcChangePct==null?"n/a":p.marketContext.btcChangePct.toFixed(2)+"%")+
      "; median symbol change: "+(p.marketContext.medianSymbolChangePct==null?"n/a":p.marketContext.medianSymbolChangePct.toFixed(2)+"%"),
      "Eligible LONG signals: "+p.eligibleSignals+"; rejected evaluations: "+p.rejectedEvaluations,"",
      "| Target | Trades | TP | SL | Open | Win rate | Net R | PF | Max DD R |",
      "|---|---:|---:|---:|---:|---:|---:|---:|---:|");
    for(const t of TARGETS){const m=p.targets[t.key].metrics;md.push("| "+t.label+" | "+m.trades+" | "+m.tp+" | "+m.sl+" | "+m.open+" | "+m.winRatePct.toFixed(2)+"% | "+m.netR.toFixed(2)+"R | "+(m.profitFactor==null?"—":m.profitFactor.toFixed(2))+" | "+m.maxDrawdownR.toFixed(2)+"R |");}
    md.push("","### Per-symbol TP1","| Symbol | Change | Signals | Trades | TP | SL | Net R |","|---|---:|---:|---:|---:|---:|---:|");
    for(const r of p.perSymbol){const m=r.targets.TP1;md.push("| "+r.symbol+" | "+(r.marketChangePct??0).toFixed(2)+"% | "+r.eligibleSignals+" | "+m.trades+" | "+m.tp+" | "+m.sl+" | "+m.netR.toFixed(2)+"R |");}
    md.push("","### Rejection reasons");
    for(const [k,v] of Object.entries(p.rejectReasons))md.push("- "+k+": "+v);
    if(p.errors.length)md.push("","Data errors: "+p.errors.map(e=>e.symbol+": "+e.error).join("; "));
    md.push("");
  }
  md.push("## Methodology and limitations",
    "- Completed 1h, 4h and BTC 4h candles only; BTC macro is evaluated as of each signal time, without future candles.",
    "- One evaluation per completed 1h candle; entry uses the next 1h open as proxy for live ticker.last.",
    "- No 15m data or trigger is used, matching v6.3.0.",
    "- Exit is simulated from 5m OHLC; same-candle ambiguity is stop-first unless the bar opens beyond target.",
    "- Independent target simulations; one active trade per symbol/target.",
    "- No historical funding, account sizing, leverage, compounding or liquidation model.",
    "- Current top-volume universe introduces survivorship and listing bias.");
  await writeFile("artifacts/v630-long-btc-backtest.md",md.join("\n"));
  console.log("V630_LONG_BTC_BACKTEST_FINAL");
  console.log(JSON.stringify({universe:report.universe,periods:report.periods.map(p=>({period:p.period,successfulSymbols:p.successfulSymbols,errors:p.errors,marketContext:p.marketContext,eligibleSignals:p.eligibleSignals,rejectedEvaluations:p.rejectedEvaluations,targets:Object.fromEntries(TARGETS.map(t=>[t.key,p.targets[t.key].metrics]))}))},null,2));
}
main().catch(e=>{console.error(e);process.exitCode=1;});

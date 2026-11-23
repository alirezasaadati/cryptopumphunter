import { mkdir, writeFile } from "node:fs/promises";
import { analyzeFuturesSymbol, FUTURES_CONFIG } from "../src/index.js";
import { evaluateTradeCandle, FUTURES_TRADE_LEVERAGE, FUTURES_MARGIN_PROFIT_TARGET_PERCENT } from "../src/futures-trade-lifecycle.js";

const BASE = "https://futures.kraken.com";
const MS = { "5m": 300000, "15m": 900000, "1h": 3600000, "4h": 14400000 };
const DAYS = Math.max(14, Math.min(90, Number(process.env.TREND_AB_DAYS || 60)));
const SYMBOL_LIMIT = Math.max(4, Math.min(20, Number(process.env.TREND_AB_SYMBOLS || 12)));
const WARMUP_DAYS = 20;
const LEVERAGE = FUTURES_TRADE_LEVERAGE;
const TARGET = FUTURES_MARGIN_PROFIT_TARGET_PERCENT;
const VARIANTS = [
  { id: "A_current", label: "Current production filter" },
  { id: "B_4h_aligned", label: "Require aligned 4h trend" },
  { id: "C_4h_or_15m_momentum", label: "Require aligned 4h OR confirmed 15m momentum" },
  { id: "D_4h_plus_rsi_52_65", label: "Require aligned 4h AND RSI 52–65 on all sides" },
  { id: "E_long_4h_rsi_52_65", label: "Filter LONG only: aligned 4h AND RSI 52–65; keep SHORT unchanged" }
];

async function getJson(url, attempt = 0) {
  const r = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(30000) });
  const body = await r.text();
  if (!r.ok) {
    if (attempt < 3 && (r.status === 429 || r.status >= 500)) {
      await new Promise(resolve => setTimeout(resolve, 700 * (attempt + 1)));
      return getJson(url, attempt + 1);
    }
    throw new Error("HTTP " + r.status + " " + body.slice(0, 180));
  }
  const data = JSON.parse(body);
  if (data?.result === "error" || (Array.isArray(data?.errors) && data.errors.length)) throw new Error("Kraken API error");
  return data;
}
function normalize(rows, interval) {
  if (!Array.isArray(rows)) throw new Error("Missing candle array");
  const seen = new Set();
  return rows.map(x => ({
    time: Number(x.time) < 1e12 ? Number(x.time) * 1000 : Number(x.time),
    open: Number(x.open), high: Number(x.high), low: Number(x.low),
    close: Number(x.close), volume: Number(x.volume)
  })).filter(c => Number.isFinite(c.time) && [c.open,c.high,c.low,c.close,c.volume].every(Number.isFinite) &&
    c.open > 0 && c.close > 0 && c.low > 0 && c.high >= c.low && c.volume >= 0 && c.time + interval <= Date.now())
    .sort((a,b) => a.time-b.time).filter(c => { if (seen.has(c.time)) return false; seen.add(c.time); return true; });
}
async function fetchCandles(symbol, resolution, from, to) {
  const interval = MS[resolution], chunk = interval * 1650, all = [];
  for (let start=from; start<to; start+=chunk) {
    const end=Math.min(to,start+chunk), u=new URL(BASE+"/api/charts/v1/trade/"+encodeURIComponent(symbol)+"/"+resolution);
    u.searchParams.set("from",String(Math.floor(start/1000)));
    u.searchParams.set("to",String(Math.floor(end/1000)));
    u.searchParams.set("count","1800");
    const data=await getJson(u);
    if (data.more_candles === true) throw new Error(symbol+" "+resolution+" incomplete Kraken response");
    all.push(...normalize(data.candles,interval));
    await new Promise(resolve=>setTimeout(resolve,90));
  }
  return [...new Map(all.map(c=>[c.time,c])).values()].sort((a,b)=>a.time-b.time);
}
function lowerBound(a,t){let l=0,h=a.length;while(l<h){const m=(l+h)>>1;if(a[m].time<t)l=m+1;else h=m;}return l;}
function ema(values, period) {
  if(values.length<period)return null;
  const k=2/(period+1);let v=values.slice(0,period).reduce((a,b)=>a+b,0)/period;
  for(let i=period;i<values.length;i++)v=values[i]*k+v*(1-k);
  return v;
}
function trend4h(candles) {
  const closes=candles.map(c=>c.close),e20=ema(closes,20),e50=ema(closes,50);
  return { up:Number.isFinite(e20)&&Number.isFinite(e50)&&e20>e50,
    down:Number.isFinite(e20)&&Number.isFinite(e50)&&e20<e50 };
}
function historicalQuoteVolume(candles,index) {
  const start=Math.max(0,index-23);let total=0;
  for(let i=start;i<=index;i++)total+=candles[i].volume*candles[i].close;
  return total;
}
function historicalChange(candles,index) {
  const old=candles[index-24],now=candles[index];
  return !old||old.close<=0?0:(now.close/old.close-1)*100;
}
function ambiguous(side,trade,c) {
  const e=Number(trade.entry),s=Number(trade.currentStop??trade.initialStop);
  const target=e*(1+(side==="LONG"?1:-1)*TARGET/LEVERAGE/100);
  const stopHit=side==="LONG"?c.low<=s:c.high>=s, tpHit=side==="LONG"?c.high>=target:c.low<=target;
  const stopOpen=side==="LONG"?c.open<=s:c.open>=s,tpOpen=side==="LONG"?c.open>=target:c.open<=target;
  return stopHit&&tpHit&&!stopOpen&&!tpOpen;
}
function empty(){return {signalsSeen:0,signalsAccepted:0,blockedByFilter:0,lockSkips:0,started:0,closed:0,tp:0,stops:0,openAtEnd:0,ambiguous5m:0,netMarginReturnPct:0,winRatePct:0,maxDrawdownPct:0};}
function summarize(trades, counters) {
  const closed=trades.filter(t=>t.status==="CLOSED_PROFIT"||t.status==="CLOSED_STOP");
  const wins=closed.filter(t=>t.status==="CLOSED_PROFIT"),stops=closed.filter(t=>t.status==="CLOSED_STOP");
  let equity=0,peak=0,dd=0;
  for(const t of [...closed].sort((a,b)=>a.closedAtMs-b.closedAtMs)){
    equity+=Number(t.marginReturnPercent||0);peak=Math.max(peak,equity);dd=Math.max(dd,peak-equity);
  }
  const sum=closed.reduce((n,t)=>n+Number(t.marginReturnPercent||0),0);
  const bySide={};
  const byRisk={};
  for(const key of ["LONG","SHORT"]) {
    const xs=closed.filter(t=>t.side===key);
    bySide[key]={trades:xs.length,tp:xs.filter(t=>t.status==="CLOSED_PROFIT").length,stops:xs.filter(t=>t.status==="CLOSED_STOP").length,
      winRatePct:xs.length?xs.filter(t=>t.status==="CLOSED_PROFIT").length/xs.length*100:0,
      netMarginReturnPct:xs.reduce((n,t)=>n+Number(t.marginReturnPercent||0),0)};
  }
  for(const key of ["STANDARD","HIGH_RISK"]) {
    const xs=closed.filter(t=>t.riskLevel===key);
    byRisk[key]={trades:xs.length,tp:xs.filter(t=>t.status==="CLOSED_PROFIT").length,stops:xs.filter(t=>t.status==="CLOSED_STOP").length,
      winRatePct:xs.length?xs.filter(t=>t.status==="CLOSED_PROFIT").length/xs.length*100:0,
      netMarginReturnPct:xs.reduce((n,t)=>n+Number(t.marginReturnPercent||0),0)};
  }
  const longClosed = closed.filter(t => t.side === "LONG");
  const longGroups = {};
  const addGroup = (name, key) => {
    const xs = longClosed.filter(key);
    longGroups[name] = { trades: xs.length, tp: xs.filter(t=>t.status==="CLOSED_PROFIT").length,
      stops: xs.filter(t=>t.status==="CLOSED_STOP").length,
      winRatePct: xs.length ? xs.filter(t=>t.status==="CLOSED_PROFIT").length/xs.length*100 : 0,
      netMarginReturnPct: xs.reduce((n,t)=>n+Number(t.marginReturnPercent||0),0),
      avgScore: xs.length ? xs.reduce((n,t)=>n+Number(t.score||0),0)/xs.length : 0 };
  };
  addGroup("4h_aligned",t=>t.trend4hAligned===true);
  addGroup("4h_opposed",t=>t.trend4hAligned===false);
  addGroup("15m_momentum_yes",t=>t.momentumConfirmed===true);
  addGroup("15m_momentum_no",t=>t.momentumConfirmed===false);
  addGroup("15m_pullback_yes",t=>t.pullbackConfirmed===true);
  addGroup("15m_pullback_no",t=>t.pullbackConfirmed===false);
  addGroup("both_confirmations",t=>t.momentumConfirmed===true&&t.pullbackConfirmed===true);
  addGroup("no_confirmations",t=>t.momentumConfirmed!==true&&t.pullbackConfirmed!==true);
  for (const [name,lo,hi] of [["rsi_32_45",32,45],["rsi_45_52",45,52],["rsi_52_65",52,65],["rsi_65_72",65,72],["rsi_72_82",72,82]]) addGroup(name,t=>Number(t.rsi)>=lo&&Number(t.rsi)<hi);
  for (const [name,lo,hi] of [["score_40_49",40,50],["score_50_59",50,60],["score_60_plus",60,101]]) addGroup(name,t=>Number(t.score)>=lo&&Number(t.score)<hi);
  addGroup("volume_ratio_below_0_5",t=>Number(t.volumeRatio)<0.5);
  addGroup("volume_ratio_0_5_1",t=>Number(t.volumeRatio)>=0.5&&Number(t.volumeRatio)<1);
  addGroup("volume_ratio_1_plus",t=>Number(t.volumeRatio)>=1);
  return {...counters,tradesStarted:trades.length,closedTrades:closed.length,profitCloses:wins.length,stopCloses:stops.length,
    openAtEnd:trades.length-closed.length,winRatePct:closed.length?wins.length/closed.length*100:0,
    totalMarginReturnPct:sum,averageMarginReturnPct:closed.length?sum/closed.length:0,maxDrawdownMarginPct:dd,
    ambiguous5mCandles:trades.reduce((n,t)=>n+(t.ambiguousCandles||0),0),bySide,byRisk,longDiagnostics:longGroups};
}
async function runSymbol(ticker, from, to) {
  const [h1,h4,m15,m5]=await Promise.all([
    fetchCandles(ticker.symbol,"1h",from,to),fetchCandles(ticker.symbol,"4h",from,to),
    fetchCandles(ticker.symbol,"15m",from,to),fetchCandles(ticker.symbol,"5m",from,to)
  ]);
  if(h1.length<100||h4.length<FUTURES_CONFIG.MIN_CANDLES||m15.length<120||m5.length<1000)
    throw new Error("Insufficient candles: 1h="+h1.length+" 4h="+h4.length+" 15m="+m15.length+" 5m="+m5.length);
  const states=Object.fromEntries(VARIANTS.map(v=>[v.id,{trades:[],counters:empty(),locks:new Map()}]));
  let i4=0,i15=0;
  const testStart=to-DAYS*86400000;
  for(let i=60;i<h1.length-1;i++) {
    const bar=h1[i],signalClose=bar.time+MS["1h"];
    if(signalClose<testStart||signalClose>=to)continue;
    while(i4<h4.length&&h4[i4].time+MS["4h"]<=signalClose)i4++;
    while(i15<m15.length&&m15[i15].time+MS["15m"]<=signalClose)i15++;
    const closed4=h4.slice(0,i4),closed15=m15.slice(Math.max(0,i15-120),i15);
    if(closed4.length<FUTURES_CONFIG.MIN_CANDLES||closed15.length<40)continue;
    const next=h1[i+1];
    const tickerAt={symbol:ticker.symbol,last:next.open,quoteVolume:historicalQuoteVolume(h1,i),
      priceChangePercent:historicalChange(h1,i),premium:{lastFundingRate:null}};
    let candidate;
    try{candidate=analyzeFuturesSymbol(tickerAt,h1.slice(0,i+1),closed4,closed15);}
    catch{continue;}
    if(!candidate||!["LONG","SHORT"].includes(candidate.side)||candidate.eligible!==true)continue;
    const four=trend4h(closed4);
    const aligned=candidate.side==="LONG"?four.up:four.down;
    const momentum=candidate.entryDiagnostics?.momentumConfirmed===true;
    const riskLevel=candidate.riskLevel==="HIGH_RISK"?"HIGH_RISK":"STANDARD";
    for(const variant of VARIANTS) {
      const state=states[variant.id],count=state.counters;
      count.signalsSeen++;
      let pass=true;
      if(variant.id==="B_4h_aligned")pass=aligned;
      if(variant.id==="C_4h_or_15m_momentum")pass=aligned||momentum;
      if(variant.id==="D_4h_plus_rsi_52_65")pass=aligned&&Number(candidate.rsi)>=52&&Number(candidate.rsi)<65;
      if(variant.id==="E_long_4h_rsi_52_65")pass=candidate.side==="SHORT"||(aligned&&Number(candidate.rsi)>=52&&Number(candidate.rsi)<65);
      if(!pass){count.blockedByFilter++;continue;}
      count.signalsAccepted++;
      const lockKey=ticker.symbol+"|"+candidate.side;
      if((state.locks.get(lockKey)||0)>signalClose){count.lockSkips++;continue;}
      const trade={id:ticker.symbol+":"+candidate.side+":"+signalClose+":"+variant.id,symbol:ticker.symbol,side:candidate.side,
        riskLevel,status:"OPEN",entry:Number(candidate.entry),initialStop:Number(candidate.stop),currentStop:Number(candidate.stop),
        stop:Number(candidate.stop),signalTime:bar.time,entryTime:signalClose,score:candidate.score,ambiguousCandles:0,
        rsi:Number(candidate.rsi),volumeRatio:Number(candidate.volumeRatio),
        momentumConfirmed:candidate.entryDiagnostics?.momentumConfirmed===true,
        pullbackConfirmed:candidate.entryDiagnostics?.pullbackConfirmed===true,
        confirmationCount:Number(candidate.confirmationCount||0),trend4hAligned:aligned,
        trend1hUp:Number(candidate.ema20)>Number(candidate.ema50)&&bar.close>Number(candidate.ema20),
        trend1hDown:Number(candidate.ema20)<Number(candidate.ema50)&&bar.close<Number(candidate.ema20),
        entryEmaDistanceAtr:Number(candidate.entryDiagnostics?.emaDistanceAtr),
        entryDriftPct:Number(candidate.entryDiagnostics?.driftPct)};
      let closed=false;
      for(let j=lowerBound(m5,signalClose);j<m5.length&&m5[j].time<to;j++){
        const candle=m5[j];if(ambiguous(candidate.side,trade,candle))trade.ambiguousCandles++;
        const result=evaluateTradeCandle(trade,{...candle,time:candle.time+MS["5m"]});
        if(result.changed){Object.assign(trade,result.trade);trade.closedAtMs=candle.time+MS["5m"];closed=true;break;}
      }
      if(!closed){
        trade.status="OPEN_AT_BACKTEST_END";trade.lastMark=m5.at(-1)?.close??null;
        trade.marginReturnAtMarkPct=trade.lastMark?(candidate.side==="LONG"?1:-1)*(trade.lastMark-trade.entry)/trade.entry*100*LEVERAGE:null;
        state.locks.set(lockKey,to);
      }else state.locks.set(lockKey,trade.closedAtMs);
      count.started++;state.trades.push(trade);
    }
  }
  return Object.fromEntries(VARIANTS.map(v=>[v.id,{symbol:ticker.symbol,metrics:summarize(states[v.id].trades,states[v.id].counters),trades:states[v.id].trades}]));
}
// Historical holdout execution: end date is pinned by TREND_AB_END in the workflow.
async function main(){
  const configuredEnd=process.env.TREND_AB_END?Date.parse(process.env.TREND_AB_END):Date.now();
  if(!Number.isFinite(configuredEnd)||configuredEnd>Date.now())throw new Error("TREND_AB_END must be a valid past ISO timestamp");
  const end=configuredEnd,start=end-DAYS*86400000,from=start-WARMUP_DAYS*86400000;
  const data=await getJson(BASE+"/derivatives/api/v3/tickers");
  if(!Array.isArray(data?.tickers))throw new Error("Kraken tickers response invalid");
  const universe=data.tickers.filter(t=>t?.tag==="perpetual"&&t.suspended!==true&&/^(PI|PF)_[A-Z0-9]+USD$/.test(String(t.symbol||""))&&Number(t.volumeQuote)>=FUTURES_CONFIG.HIGH_RISK_MIN_QUOTE_VOLUME&&Number(t.last)>0)
    .sort((a,b)=>Number(b.volumeQuote)-Number(a.volumeQuote)).slice(0,SYMBOL_LIMIT);
  if(!universe.length)throw new Error("No eligible Kraken perpetual symbols");
  const aggregate=Object.fromEntries(VARIANTS.map(v=>[v.id,{trades:[],counters:empty(),bySymbol:[]}]));
  const errors=[];
  for(let n=0;n<universe.length;n++){
    const ticker=universe[n];console.log("["+ (n+1)+"/"+universe.length+"] "+ticker.symbol);
    try{
      const result=await runSymbol(ticker,from,end);
      for(const v of VARIANTS){aggregate[v.id].trades.push(...result[v.id].trades);aggregate[v.id].bySymbol.push(result[v.id].metrics);
        for(const k of Object.keys(aggregate[v.id].counters))aggregate[v.id].counters[k]+=result[v.id].metrics[k]||0;}
    }catch(e){errors.push({symbol:ticker.symbol,error:String(e?.message||e)});}
  }
  const variants={};
  for(const v of VARIANTS){
    const a=aggregate[v.id];variants[v.id]={label:v.label,metrics:summarize(a.trades,a.counters),bySymbol:a.bySymbol,trades:a.trades};
  }
  const report={generatedAt:new Date().toISOString(),exchange:"Kraken Futures",source:"main production analyzeFuturesSymbol + production evaluateTradeCandle",
    period:{from:new Date(start).toISOString(),to:new Date(end).toISOString(),days:DAYS,warmupDays:WARMUP_DAYS},
    execution:{signal:"closed 1h candle; only closed 4h and 15m candles available",entry:"next 1h candle open",exit:"production 5m trade lifecycle",
      leverage:LEVERAGE,targetMarginReturnPct:TARGET,fees:"excluded, same as production lifecycle",funding:"historical funding unavailable and omitted",
      sameSideLock:"one active trade per symbol and side; opposite direction can overlap",
      candleAmbiguity:"stop-first unless candle open proves target or stop was reached first",
      quoteVolume:"rolling historical 24h sum of 1h base volume × close (approximate quote volume; avoids using current volume in historical candles)",
      universe:"top current Kraken perpetuals by current quote volume, floor at production HIGH_RISK minimum; survivorship bias remains"},
    symbols:universe.map(t=>({symbol:t.symbol,currentQuoteVolume:Number(t.volumeQuote)||0})),symbolsTested:aggregate[VARIANTS[0].id].bySymbol.length,
    errors,variants};
  await mkdir("artifacts",{recursive:true});await writeFile("artifacts/trend-filter-ab-c-60d.json",JSON.stringify(report,null,2));
  const rows=["# Trend filter A/B/C/D — Kraken Futures","",
    "Period: "+report.period.from+" — "+report.period.to+" ("+DAYS+" days)",
    "Symbols tested: "+report.symbolsTested+"/"+universe.length,"",
    "| Variant | Accepted signals | Blocked | Trades | TP | SL | Win % | Net margin % | Max DD % |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|",
    ...VARIANTS.map(v=>{const m=variants[v.id].metrics;return "| "+v.id+" | "+m.signalsAccepted+" | "+m.blockedByFilter+" | "+m.closedTrades+" | "+m.profitCloses+" | "+m.stopCloses+" | "+m.winRatePct.toFixed(1)+" | "+m.totalMarginReturnPct.toFixed(2)+" | "+m.maxDrawdownMarginPct.toFixed(2)+" |";}),
    "","HIGH_RISK / STANDARD and LONG / SHORT breakdowns are included in JSON.",
    "Caveats: approximate historical quote volume, current-universe survivorship bias, no fees/funding, and production 5m lifecycle assumptions."];
  await writeFile("artifacts/trend-filter-ab-c-60d.md",rows.join("\n"));
  console.log(JSON.stringify({period:report.period,symbolsTested:report.symbolsTested,errors,summary:Object.fromEntries(VARIANTS.map(v=>[v.id,variants[v.id].metrics]))},null,2));
}
main().catch(e=>{console.error(e);process.exitCode=1;});

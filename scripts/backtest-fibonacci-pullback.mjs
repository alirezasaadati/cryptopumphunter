import { mkdir, writeFile } from "node:fs/promises";
import { analyzeFibonacciSetup } from "../src/fibonacci-engine.js";

const BASE = "https://futures.kraken.com";
const H1 = 3600000, H4 = 4 * H1, M15 = 900000, DAY = 86400000;
const DAYS = Math.max(30, Math.min(180, Number(process.env.BACKTEST_DAYS || 60)));
const SYMBOL_LIMIT = Math.max(1, Math.min(8, Number(process.env.BACKTEST_SYMBOLS || 8)));
const FEE = Math.max(0, Number(process.env.BACKTEST_FEE || 0.0005));
const SLIP = Math.max(0, Number(process.env.BACKTEST_SLIPPAGE || 0.0003));
const MAX_HOLD_BARS = 72 * 4;
const WEIGHTS = [0.40, 0.35, 0.25];
const TARGET_R = [1.5, 2.2, 3.0];
const WARMUP_DAYS = 50;

async function getJson(url) {
  const r = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(30000) });
  const body = await r.text();
  if (!r.ok) throw new Error("HTTP " + r.status + ": " + body.slice(0, 180));
  const data = JSON.parse(body);
  if (data?.result === "error" || data?.errors?.length) throw new Error("Kraken API error: " + JSON.stringify(data.errors || data.error));
  return data;
}
function normalize(rows, interval) {
  const map = new Map();
  for (const row of rows || []) {
    const c = { time: Number(row.time) < 1e12 ? Number(row.time) * 1000 : Number(row.time),
      open: +row.open, high: +row.high, low: +row.low, close: +row.close, volume: +row.volume };
    if (![c.time,c.open,c.high,c.low,c.close,c.volume].every(Number.isFinite) ||
        c.low <= 0 || c.high < c.low || c.open <= 0 || c.close <= 0 || c.volume < 0 ||
        c.high < Math.max(c.open,c.close) || c.low > Math.min(c.open,c.close) ||
        c.time + interval > Date.now()) continue;
    map.set(c.time,c);
  }
  return [...map.values()].sort((a,b)=>a.time-b.time);
}
async function fetchCandles(symbol, resolution, interval, from, to) {
  const chunk = interval * 1700, rows = [];
  for (let start=from; start<to; start+=chunk) {
    const end=Math.min(to,start+chunk);
    const url=new URL(BASE+"/api/charts/v1/trade/"+encodeURIComponent(symbol)+"/"+resolution);
    url.searchParams.set("from",String(Math.floor(start/1000)));
    url.searchParams.set("to",String(Math.floor(end/1000)));
    url.searchParams.set("count","1800");
    const data=await getJson(url);
    if(data.more_candles===true) throw new Error(symbol+" "+resolution+": chunk exceeded Kraken candle limit");
    rows.push(...(data.candles||[]));
  }
  return normalize(rows,interval).filter(c=>c.time>=from&&c.time<to);
}
async function mapLimit(items,limit,fn) {
  const out=new Array(items.length);let next=0;
  await Promise.all(Array.from({length:Math.min(limit,items.length)},async()=>{
    while(next<items.length){const i=next++;try{out[i]=await fn(items[i],i);}catch(e){out[i]={symbol:items[i].symbol,error:String(e?.message||e)};}}
  }));
  return out;
}
function closedThrough(bars, closeTime, interval) {
  let lo=0,hi=bars.length;
  while(lo<hi){const mid=(lo+hi)>>1;if(bars[mid].time+interval<=closeTime)lo=mid+1;else hi=mid;}
  return bars.slice(0,lo);
}
function simulate({symbol,side,entry,stop,futureBars,signalTime}) {
  const dir=side==="LONG"?1:-1;
  const risk=dir===1?entry-stop:stop-entry;
  if(!(risk>0)||!Number.isFinite(risk))return null;
  const targets=TARGET_R.map(r=>entry+dir*risk*r);
  let remaining=1,netR=0;const hits=[false,false,false];
  const end=Math.min(futureBars.length,MAX_HOLD_BARS);
  let exitReason="TIME_EXIT",exitTime=null;
  const exitFill=p=>p*(1-dir*SLIP);
  const realize=(portion,raw)=>{
    const fill=exitFill(raw);
    netR+=portion*(dir*(fill-entry)/risk-FEE*(entry+fill)/risk);
    remaining-=portion;
  };
  for(let i=0;i<end&&remaining>1e-9;i++){
    const b=futureBars[i];
    const gap=dir===1?b.open<=stop:b.open>=stop;
    const stopTouched=dir===1?b.low<=stop:b.high>=stop;
    if(gap||stopTouched){realize(remaining,gap?b.open:stop);exitReason="STOP";exitTime=b.time;break;}
    for(let k=0;k<3&&remaining>1e-9;k++){
      const touched=dir===1?b.high>=targets[k]:b.low<=targets[k];
      if(touched&&!hits[k]){realize(WEIGHTS[k],targets[k]);hits[k]=true;}
    }
    if(remaining<=1e-9){remaining=0;exitReason="ALL_TARGETS";exitTime=b.time;break;}
    if(i===end-1){realize(remaining,b.close);exitReason="TIME_EXIT";exitTime=b.time;}
  }
  if(exitTime===null){const b=futureBars[Math.max(0,end-1)];realize(remaining,b.close);exitReason="TIME_EXIT";exitTime=b.time;}
  return {symbol,side,signalTime,entryTime:futureBars[0].time,entry,stop,risk,targets,
    tp1:hits[0],tp2:hits[1],tp3:hits[2],netR,exitReason,exitTime};
}
function summarize(trades) {
  const wins=trades.filter(t=>t.netR>0),losses=trades.filter(t=>t.netR<0);
  const grossWin=wins.reduce((s,t)=>s+t.netR,0),grossLoss=Math.abs(losses.reduce((s,t)=>s+t.netR,0));
  let equity=0,peak=0,maxDD=0;
  for(const t of [...trades].sort((a,b)=>a.entryTime-b.entryTime)){equity+=t.netR;peak=Math.max(peak,equity);maxDD=Math.max(maxDD,peak-equity);}
  const netR=trades.reduce((s,t)=>s+t.netR,0);
  const bySide={};
  for(const side of ["LONG","SHORT"]){const rows=trades.filter(t=>t.side===side),w=rows.filter(t=>t.netR>0),l=rows.filter(t=>t.netR<0),gw=w.reduce((s,t)=>s+t.netR,0),gl=Math.abs(l.reduce((s,t)=>s+t.netR,0));bySide[side]={trades:rows.length,wins:w.length,stops:rows.filter(t=>t.exitReason==="STOP").length,winRatePct:rows.length?w.length/rows.length*100:0,netR:rows.reduce((s,t)=>s+t.netR,0),profitFactor:gl?gw/gl:gw?null:0};}
  return {trades:trades.length,wins:wins.length,losses:losses.length,stops:trades.filter(t=>t.exitReason==="STOP").length,
    timeExits:trades.filter(t=>t.exitReason==="TIME_EXIT").length,allTargets:trades.filter(t=>t.exitReason==="ALL_TARGETS").length,
    winRatePct:trades.length?wins.length/trades.length*100:0,netR,expectancyR:trades.length?netR/trades.length:0,
    profitFactor:grossLoss?grossWin/grossLoss:grossWin?null:0,maxDrawdownR:maxDD,
    tp1:trades.filter(t=>t.tp1).length,tp2:trades.filter(t=>t.tp2).length,tp3:trades.filter(t=>t.tp3).length,bySide};
}
async function backtestSymbol(ticker,start,end) {
  const from=start-WARMUP_DAYS*DAY;
  const [h1,h4,m15]=await Promise.all([
    fetchCandles(ticker.symbol,"1h",H1,from,end),
    fetchCandles(ticker.symbol,"4h",H4,from,end),
    fetchCandles(ticker.symbol,"15m",M15,from,end)
  ]);
  if(h1.length<250||h4.length<205||m15.length<120)throw new Error("Insufficient history: 1h="+h1.length+", 4h="+h4.length+", 15m="+m15.length);
  const trades=[];let signals=0,byStatus={},nextFree=0;
  for(let i=0;i<m15.length-1;i++){
    const bar=m15[i],closeTime=bar.time+M15;
    if(closeTime<start||closeTime>=end||bar.time<nextFree)continue;
    const oneHour=closedThrough(h1,closeTime,H1);
    const fourHour=closedThrough(h4,closeTime,H4);
    const fifteenMin=m15.slice(Math.max(0,i-119),i+1);
    const result=analyzeFibonacciSetup({fourHour,oneHour,fifteenMin});
    byStatus[result.status]=(byStatus[result.status]||0)+1;
    if(result.status!=="SIGNAL"||!result.signal)continue;
    signals++;
    const nextBar=m15[i+1],dir=result.signal.side==="LONG"?1:-1;
    const entry=nextBar.open*(1+dir*SLIP);
    const stop=result.signal.stop;
    const trade=simulate({symbol:ticker.symbol,side:result.signal.side,entry,stop,
      futureBars:m15.slice(i+1,i+1+MAX_HOLD_BARS),signalTime:closeTime});
    if(!trade)continue;
    trades.push(trade);nextFree=trade.exitTime+M15;
  }
  return {symbol:ticker.symbol,candles:{h1:h1.length,h4:h4.length,m15:m15.length},
    signalOpportunities:signals,statusCounts:byStatus,metrics:summarize(trades),trades};
}
async function main(){
  const end=Date.now(),start=end-DAYS*DAY;
  const tickerData=await getJson(BASE+"/derivatives/api/v3/tickers");
  const universe=(tickerData.tickers||[]).filter(t=>t?.tag==="perpetual"&&t.suspended!==true&&/^(PI|PF)_[A-Z0-9]+USD$/.test(String(t.symbol||""))&&Number(t.volumeQuote)>0)
    .sort((a,b)=>Number(b.volumeQuote)-Number(a.volumeQuote)).slice(0,SYMBOL_LIMIT);
  if(!universe.length)throw new Error("No Kraken perpetual symbols found");
  const results=await mapLimit(universe,3,t=>backtestSymbol(t,start,end));
  const good=results.filter(x=>!x.error),failed=results.filter(x=>x.error);
  const trades=good.flatMap(x=>x.trades).sort((a,b)=>a.entryTime-b.entryTime);
  const report={generatedAt:new Date().toISOString(),venue:"Kraken Derivatives public historical OHLC",
    period:{from:new Date(start).toISOString(),to:new Date(end).toISOString(),days:DAYS},
    settings:{symbolsRequested:SYMBOL_LIMIT,symbolsTested:good.length,feePerSidePct:FEE*100,slippagePerSidePct:SLIP*100,
      maxHoldHours:72,targetsR:TARGET_R,partialExitWeights:WEIGHTS,sameCandleRule:"stop first (conservative)",
      entry:"next 15m candle open after a fully closed 15m confirmation candle; adverse slippage applied",
      stop:"engine stop from confirmation candle; targets recalculated from actual next-open entry and risk",
      funding:"excluded",universe:"top current Kraken perpetual contracts by current quote volume; survivorship/universe bias applies"},
    aggregate:summarize(trades),symbols:results.map(({trades,...r})=>r),
    trades};
  await mkdir("artifacts",{recursive:true});
  await writeFile("artifacts/fibonacci-pullback-backtest.json",JSON.stringify(report,null,2));
  const m=report.aggregate;
  const md=["# Fibonacci 0.618 pullback engine — historical backtest","",
    "Period: "+report.period.from+" to "+report.period.to+" ("+DAYS+" days)",
    "Symbols tested: "+good.length+"/"+universe.length+"; failed: "+failed.length,"",
    "| Metric | Result |","|---|---:|",
    "| Signal opportunities | "+good.reduce((s,x)=>s+x.signalOpportunities,0)+" |",
    "| Executed trades | "+m.trades+" |","| LONG | "+m.bySide.LONG.trades+" |","| SHORT | "+m.bySide.SHORT.trades+" |",
    "| TP1 touched | "+m.tp1+" |","| TP2 touched | "+m.tp2+" |","| TP3 touched | "+m.tp3+" |",
    "| Stop-outs | "+m.stops+" |","| Time exits | "+m.timeExits+" |","| Win rate | "+m.winRatePct.toFixed(2)+"% |",
    "| Net R | "+m.netR.toFixed(2)+"R |","| Expectancy | "+m.expectancyR.toFixed(3)+"R |",
    "| Profit factor | "+(m.profitFactor===null?"n/a":m.profitFactor.toFixed(2))+" |","| Max drawdown | "+m.maxDrawdownR.toFixed(2)+"R |","",
    "Costs: "+(FEE*100)+"% fee and "+(SLIP*100)+"% slippage per side; funding excluded.",
    "Execution: next 15m open after confirmation, conservative stop-first handling if stop and target occur in the same candle.",
    "TP weights are an explicit simulation assumption (40/35/25); the engine itself supplies target R levels, not position sizing.",
    "Universe is selected by current volume and has survivorship bias. Results are historical simulation, not live fills or a guarantee.","",
    "## Per-symbol results","",
    "| Symbol | Signals | Trades | LONG | SHORT | TP1 | TP2 | TP3 | Stops | Net R | PF |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ...results.map(x=>x.error?"| "+x.symbol+" | — | — | — | — | — | — | — | — | — | ERROR: "+x.error+" |":
      "| "+x.symbol+" | "+x.signalOpportunities+" | "+x.metrics.trades+" | "+x.metrics.bySide.LONG.trades+" | "+x.metrics.bySide.SHORT.trades+" | "+x.metrics.tp1+" | "+x.metrics.tp2+" | "+x.metrics.tp3+" | "+x.metrics.stops+" | "+x.metrics.netR.toFixed(2)+" | "+(x.metrics.profitFactor===null?"n/a":x.metrics.profitFactor.toFixed(2))+" |"),
    "","Failed symbols:",...failed.map(x=>"- "+x.symbol+": "+x.error)];
  await writeFile("artifacts/fibonacci-pullback-backtest.md",md.join("\n"));
  console.log(JSON.stringify({ok:true,period:report.period,symbols:{requested:universe.length,tested:good.length,failed},aggregate:report.aggregate,
    perSymbol:report.symbols.map(x=>({symbol:x.symbol,error:x.error,signalOpportunities:x.signalOpportunities,metrics:x.metrics})),
    artifacts:["artifacts/fibonacci-pullback-backtest.json","artifacts/fibonacci-pullback-backtest.md"]},null,2));
}
main().catch(error=>{console.error(error);process.exitCode=1;});

// Re-run trigger: isolated historical validation script.

// Trigger 180-day extended historical validation.

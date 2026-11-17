import { analyzeSMC } from "../src/smc-engine.js";
import { analyzePriceAction } from "../src/price-action-engine.js";
import { mkdir, writeFile } from "node:fs/promises";

const BASE = "https://futures.kraken.com";
const M15 = 15 * 60 * 1000, HOUR = 4 * M15, H4 = 16 * M15;
const DAYS = Math.max(15, Math.min(60, Number(process.env.SMC_BACKTEST_DAYS || 30)));
const SYMBOL_LIMIT = Math.max(1, Math.min(5, Number(process.env.SMC_BACKTEST_SYMBOLS || 3)));
const FEE = Math.max(0, Number(process.env.BACKTEST_FEE || 0.0005));
const SLIPPAGE = Math.max(0, Number(process.env.BACKTEST_SLIPPAGE || 0.0003));
const MAX_HOLD_BARS = 288; // 72 hours on 15m candles
const WEIGHTS = [0.40, 0.35, 0.25];

async function getJson(url) {
  const response = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(25000) });
  const body = await response.text();
  if (!response.ok) throw new Error("HTTP " + response.status + ": " + body.slice(0, 160));
  const data = JSON.parse(body);
  if (data?.result === "error" || data?.errors?.length) throw new Error("Kraken API error: " + JSON.stringify(data.errors || data.error));
  return data;
}
function normalize(rows, interval) {
  if (!Array.isArray(rows)) throw new Error("Kraken candle response missing");
  return rows.map(r => ({
    time: Number(r.time) < 1e12 ? Number(r.time) * 1000 : Number(r.time),
    open: Number(r.open), high: Number(r.high), low: Number(r.low), close: Number(r.close), volume: Number(r.volume)
  })).filter(c => Number.isFinite(c.time) && [c.open,c.high,c.low,c.close].every(Number.isFinite) &&
    c.open > 0 && c.low > 0 && c.high >= Math.max(c.open,c.close) && c.low <= Math.min(c.open,c.close))
    .filter(c => c.time + interval <= Date.now()).sort((a,b)=>a.time-b.time);
}
async function fetchCandles(symbol, resolution, from, to, interval) {
  const all = new Map();
  const chunkMs = interval * 1850;
  for (let cursor = from; cursor < to; cursor += chunkMs) {
    const end = Math.min(to, cursor + chunkMs);
    const url = new URL(BASE + "/api/charts/v1/trade/" + encodeURIComponent(symbol) + "/" + resolution);
    url.searchParams.set("from", String(Math.floor(cursor / 1000)));
    url.searchParams.set("to", String(Math.floor(end / 1000)));
    url.searchParams.set("count", "1900");
    const data = await getJson(url);
    for (const c of normalize(data.candles, interval)) all.set(c.time, c);
    if (data.more_candles === true && end - cursor <= interval * 1850) {
      throw new Error(symbol + " " + resolution + ": API returned more_candles for a bounded chunk");
    }
  }
  return [...all.values()].sort((a,b)=>a.time-b.time);
}
function reprice(plan, nextOpen) {
  const dir = plan.side === "LONG" ? 1 : -1;
  const oldRisk = dir * (plan.entry - plan.stop);
  if (!(oldRisk > 0)) return null;
  const entry = nextOpen * (1 + dir * SLIPPAGE);
  const stop = entry - dir * oldRisk;
  const ratios = [plan.target1,plan.target2,plan.target3].map(t => dir * (t-plan.entry) / oldRisk);
  if (ratios.some(r => !(r > 0) || !Number.isFinite(r))) return null;
  return { side:plan.side, entry, stop, targets:ratios.map(r=>entry+dir*oldRisk*r), risk:oldRisk };
}
function simulate(plan, candles, start) {
  const dir = plan.side === "LONG" ? 1 : -1;
  const targets = [...plan.targets];
  const p = { remaining:1, netR:0, hits:0, exitTime:null, reason:null };
  const end = Math.min(candles.length-1, start+MAX_HOLD_BARS);
  for (let i=start;i<=end && p.remaining>1e-9;i++) {
    const c=candles[i];
    const gap = dir===1 ? c.open<=plan.stop : c.open>=plan.stop;
    const stopped = dir===1 ? c.low<=plan.stop : c.high>=plan.stop;
    if (gap || stopped) {
      const exit=gap?c.open:plan.stop;
      const fill=exit*(1-dir*SLIPPAGE);
      p.netR += p.remaining*(dir*(fill-plan.entry)/plan.risk - FEE*(plan.entry+fill)/plan.risk);
      p.remaining=0; p.exitTime=c.time; p.reason="STOP"; break;
    }
    for(let t=0;t<3 && p.remaining>1e-9;t++) {
      const target=targets[t];
      if(target==null) continue;
      const touched=dir===1?c.high>=target:c.low<=target;
      if(!touched) break;
      const fill=target*(1-dir*SLIPPAGE);
      p.netR += WEIGHTS[t]*(dir*(fill-plan.entry)/plan.risk - FEE*(plan.entry+fill)/plan.risk);
      p.remaining-=WEIGHTS[t]; p.hits++; targets[t]=null;
    }
    if(p.remaining<=1e-9){p.remaining=0;p.exitTime=c.time;p.reason="TARGETS";break;}
    if(i===end){
      const fill=c.close*(1-dir*SLIPPAGE);
      p.netR += p.remaining*(dir*(fill-plan.entry)/plan.risk - FEE*(plan.entry+fill)/plan.risk);
      p.remaining=0;p.exitTime=c.time;p.reason="TIME_EXIT";
    }
  }
  return {side:plan.side,netR:p.netR,targetHits:p.hits,exitReason:p.reason,entryTime:candles[start].time,exitTime:p.exitTime,
    holdHours:(p.exitTime-candles[start].time)/3600000};
}
function metrics(trades) {
  const ordered=[...trades].sort((a,b)=>a.entryTime-b.entryTime);
  const wins=ordered.filter(t=>t.netR>0), losses=ordered.filter(t=>t.netR<0);
  const gw=wins.reduce((s,t)=>s+t.netR,0), gl=Math.abs(losses.reduce((s,t)=>s+t.netR,0));
  let equity=0,peak=0,dd=0,streak=0,maxStreak=0;
  for(const t of ordered){equity+=t.netR;peak=Math.max(peak,equity);dd=Math.max(dd,peak-equity);streak=t.netR<0?streak+1:0;maxStreak=Math.max(maxStreak,streak);}
  return {trades:ordered.length,winRatePct:ordered.length?100*wins.length/ordered.length:0,
    netR:ordered.reduce((s,t)=>s+t.netR,0),expectancyR:ordered.length?ordered.reduce((s,t)=>s+t.netR,0)/ordered.length:0,
    profitFactor:gl?gw/gl:gw?null:0,maxDrawdownR:dd,maxConsecutiveLosses:maxStreak,
    avgHoldHours:ordered.length?ordered.reduce((s,t)=>s+t.holdHours,0)/ordered.length:0};
}
function allowed(plan, mode) { return plan && (mode==="BOTH" || plan.side===mode); }

async function testSymbol(ticker, from, to, splitTime) {
  const [m15,h1,h4]=await Promise.all([
    fetchCandles(ticker.symbol,"15m",from,to,M15),
    fetchCandles(ticker.symbol,"1h",from,to,HOUR),
    fetchCandles(ticker.symbol,"4h",from,to,H4)
  ]);
  if(m15.length<100||h1.length<40||h4.length<30) throw new Error("Insufficient history: 15m="+m15.length+", 1h="+h1.length+", 4h="+h4.length);
  const modes=["BOTH","LONG","SHORT"];
  const systems=["SMC","PRICE_ACTION"];
  const trades=Object.fromEntries(systems.flatMap(s=>modes.map(m=>[s+"_"+m,[]])));
  let busyUntil=-1;
  for(let i=159;i<m15.length-1;i++){
    if(i<busyUntil) continue;
    const closeTime=m15[i].time+M15;
    const c15=m15.slice(0,i+1);
    const c1=h1.filter(c=>c.time+HOUR<=closeTime);
    const c4=h4.filter(c=>c.time+H4<=closeTime);
    if(c1.length<40||c4.length<30) continue;
    const pa=analyzePriceAction({symbol:ticker.symbol,oneHour:c1,fourHour:c4,fifteenMin:c15,livePrice:m15[i].close});
    const smc=analyzeSMC({symbol:ticker.symbol,oneHour:c1,fourHour:c4,fifteenMin:c15,livePrice:m15[i].close});
    const next=m15[i+1];
    const candidates=[
      ...modes.map(mode=>({key:"SMC_"+mode,plan:smc.signals?.find(x=>allowed(x,mode))})),
      ...modes.map(mode=>({key:"PRICE_ACTION_"+mode,plan:pa.signals?.filter(x=>allowed(x,mode)).sort((a,b)=>b.score-a.score)[0]}))
    ].filter(x=>x.plan);
    // Separate independent portfolios per strategy/mode; each gets its own no-overlap clock.
    for(const item of candidates){
      const clockKey=item.key+"__busy";
      const lastBusy=trades[clockKey]??-1;
      if(i<lastBusy) continue;
      const priced=reprice(item.plan,next.open);
      if(!priced) continue;
      const trade=simulate(priced,m15,i+1);
      if(!trade.exitTime) continue;
      trades[item.key].push({...trade,symbol:ticker.symbol,signalTime:m15[i].time});
      trades[clockKey]=Math.max(i+2,m15.findIndex(c=>c.time===trade.exitTime)+1);
    }
  }
  const out={symbol:ticker.symbol,candles:{m15:m15.length,h1:h1.length,h4:h4.length},metrics:{}};
  for(const key of Object.keys(trades).filter(k=>!k.endsWith("__busy"))){
    const all=trades[key];
    out.metrics[key]={all:metrics(all),inSample:metrics(all.filter(t=>t.entryTime<splitTime)),outOfSample:metrics(all.filter(t=>t.entryTime>=splitTime))};
  }
  return {out,trades:Object.fromEntries(Object.keys(trades).filter(k=>!k.endsWith("__busy")).map(k=>[k,trades[k]]))};
}
async function main(){
  const now=Date.now(), from=now-DAYS*24*3600000-20*24*3600000, to=now;
  const tickers=await getJson(BASE+"/derivatives/api/v3/tickers");
  const universe=(tickers.tickers||[]).filter(t=>t?.tag==="perpetual"&&t.suspended!==true&&/^(PI|PF)_[A-Z0-9]+USD$/.test(String(t.symbol||""))&&Number(t.volumeQuote)>0)
    .sort((a,b)=>Number(b.volumeQuote)-Number(a.volumeQuote)).slice(0,SYMBOL_LIMIT);
  if(!universe.length) throw new Error("No eligible perpetual contracts");
  const splitTime=now-DAYS*24*3600000*0.3;
  const results=[],combined={};
  for(const ticker of universe){
    try{
      const result=await testSymbol(ticker,from,to,splitTime);
      results.push(result.out);
      for(const [key,list] of Object.entries(result.trades)) (combined[key]??=[]).push(...list);
    }catch(e){results.push({symbol:ticker.symbol,error:String(e.message||e),metrics:{}});}
  }
  const report={generatedAt:new Date().toISOString(),venue:"Kraken Derivatives public OHLC candles",
    periodDays:DAYS,split:"last 30% of requested period is out-of-sample",
    settings:{symbols:universe.map(x=>x.symbol),feePerSidePct:FEE*100,slippagePerSidePct:SLIPPAGE*100,
      maxHoldHours:72,partialExitWeightsPct:[40,35,25],sameCandleRule:"stop first",
      entry:"next 15m open with adverse entry slippage; stop/targets repriced preserving original R distances",
      funding:"excluded; verify funding separately before paper trading",
      universeBias:"symbols selected from current top-volume perpetuals; historical survivorship/universe bias remains"},
    overall:Object.fromEntries(Object.entries(combined).map(([k,v])=>[k,{all:metrics(v),
      inSample:metrics(v.filter(t=>t.entryTime<splitTime)),outOfSample:metrics(v.filter(t=>t.entryTime>=splitTime))}])),
    symbols:results};
  await mkdir("artifacts",{recursive:true});
  await writeFile("artifacts/smc-comparison.json",JSON.stringify(report,null,2));
  const rows=Object.entries(report.overall).map(([k,v])=>"| "+k+" | "+v.all.trades+" | "+v.all.winRatePct.toFixed(1)+"% | "+v.all.netR.toFixed(2)+"R | "+v.all.expectancyR.toFixed(3)+"R | "+(v.all.profitFactor===null?"n/a":v.all.profitFactor.toFixed(2))+" | "+v.all.maxDrawdownR.toFixed(2)+"R | "+v.outOfSample.trades+" | "+v.outOfSample.expectancyR.toFixed(3)+"R |");
  const md=["# SMC vs Price Action — Kraken Futures","", "Period: "+DAYS+" days; last 30% out-of-sample.",
    "Costs: "+(FEE*100).toFixed(3)+"% fee and "+(SLIPPAGE*100).toFixed(3)+"% slippage per side. Funding excluded.",
    "Next 15m open entries; conservative stop-first rule if stop and target touch in the same candle.",
    "All systems use the same symbols, candles, cost assumptions, 40/35/25 exits and 72h max hold.",
    "Current top-volume universe creates survivorship bias; results are exploratory, not proof of profitability.","",
    "| System | Trades | Win rate | Net | Expectancy | PF | Max DD | OOS trades | OOS expectancy |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|",...rows,"",
    "## Per-symbol details","",...results.map(r=>"### "+r.symbol+"\n"+(r.error||JSON.stringify(r.metrics,null,2)))].join("\n");
  await writeFile("artifacts/smc-comparison.md",md);
  console.log(JSON.stringify({ok:true,overall:report.overall,symbols:results,artifacts:["artifacts/smc-comparison.json","artifacts/smc-comparison.md"]},null,2));
}
if(process.argv[1]&&import.meta.url===new URL("file://"+process.argv[1]).href) main().catch(e=>{console.error(e);process.exitCode=1;});

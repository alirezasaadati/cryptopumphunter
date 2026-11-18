import { analyzeVolumeFlow } from "../src/volume-flow-engine.js";
import { mkdir, writeFile } from "node:fs/promises";

const API = "https://futures.kraken.com";
const TF = { "15m": 900_000, "1h": 3_600_000, "4h": 14_400_000 };
const DAYS = Math.max(7, Math.min(90, Number(process.env.VF_DAYS || 30)));
const SYMBOLS = Math.max(1, Math.min(12, Number(process.env.VF_SYMBOLS || 8)));
const FEE = Number(process.env.VF_FEE ?? 0.0005);
const SLIP = Number(process.env.VF_SLIPPAGE ?? 0.0003);
const MAX_HOLD = 72 * 4;
const WEIGHTS = [0.4, 0.35, 0.25];

async function json(url) {
  const r = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(30000) });
  const body = await r.text();
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${body.slice(0, 180)}`);
  const data = JSON.parse(body);
  if (data.result === "error" || data.errors?.length) throw new Error(JSON.stringify(data.errors || data.error));
  return data;
}
function normalize(rows, interval) {
  const seen = new Set();
  return (rows || []).map(x => ({
    time: Number(x.time) < 1e12 ? Number(x.time) * 1000 : Number(x.time),
    open: Number(x.open), high: Number(x.high), low: Number(x.low),
    close: Number(x.close), volume: Number(x.volume)
  })).filter(c => Number.isFinite(c.time) &&
    [c.open,c.high,c.low,c.close,c.volume].every(Number.isFinite) &&
    c.open > 0 && c.low > 0 && c.volume >= 0 &&
    c.high >= Math.max(c.open,c.close) && c.low <= Math.min(c.open,c.close) &&
    c.time + interval <= Date.now()).sort((a,b)=>a.time-b.time).filter(c => {
      if (seen.has(c.time)) return false; seen.add(c.time); return true;
    });
}
async function getCandles(symbol, resolution, from, to, interval) {
  const out = [], chunkBars = 1500;
  for (let a=from; a<to; a+=chunkBars*interval) {
    const b=Math.min(to,a+chunkBars*interval);
    const u=new URL(`${API}/api/charts/v1/trade/${encodeURIComponent(symbol)}/${resolution}`);
    u.searchParams.set("from",String(Math.floor(a/1000)));
    u.searchParams.set("to",String(Math.floor(b/1000)));
    u.searchParams.set("count",String(chunkBars));
    const data=await json(u);
    out.push(...(data.candles || []));
  }
  return normalize(out,interval);
}
function metrics(trades) {
  const wins=trades.filter(t=>t.netR>0), losses=trades.filter(t=>t.netR<0);
  const gw=wins.reduce((s,t)=>s+t.netR,0), gl=Math.abs(losses.reduce((s,t)=>s+t.netR,0));
  let eq=0,peak=0,dd=0;
  for(const t of [...trades].sort((a,b)=>a.exitTime-b.exitTime)){eq+=t.netR;peak=Math.max(peak,eq);dd=Math.max(dd,peak-eq);}
  return {trades:trades.length,wins:wins.length,losses:losses.length,
    winRatePct:trades.length?100*wins.length/trades.length:0,
    netR:trades.reduce((s,t)=>s+t.netR,0),
    expectancyR:trades.length?trades.reduce((s,t)=>s+t.netR,0)/trades.length:0,
    profitFactor:gl?gw/gl:(gw?null:0),maxDrawdownR:dd,
    targetHits:trades.reduce((s,t)=>s+t.targetHits,0)};
}
function simulate(signal, bars, entryIndex, symbol) {
  const side=signal.side, dir=side==="LONG"?1:-1;
  const fill=bars[entryIndex].open*(1+dir*SLIP);
  const risk=dir===1?fill-signal.stop:signal.stop-fill;
  if(!(risk>0) || risk/fill>0.06) return null;
  const targets=[1.5,2.2,3].map(r=>fill+dir*risk*r);
  let remaining=1, netR=0, hits=0, exitTime=bars[entryIndex].time, reason="TIME_EXIT";
  const end=Math.min(bars.length-1,entryIndex+MAX_HOLD);
  for(let i=entryIndex;i<=end && remaining>1e-9;i++){
    const b=bars[i], gap=dir===1?b.open<=signal.stop:b.open>=signal.stop;
    const stopHit=dir===1?b.low<=signal.stop:b.high>=signal.stop;
    // Conservative OHLC rule: if stop and target can both be touched, stop wins.
    if(gap||stopHit){
      const px=(gap?b.open:signal.stop)*(1-dir*SLIP);
      netR+=remaining*(dir*(px-fill)/risk-FEE*(fill+px)/risk);
      remaining=0;reason="STOP";exitTime=b.time;break;
    }
    for(let k=0;k<3;k++){
      if(remaining<=1e-9) break;
      const touched=dir===1?b.high>=targets[k]:b.low<=targets[k];
      if(!touched) continue;
      const qty=Math.min(remaining,WEIGHTS[k]),px=targets[k]*(1-dir*SLIP);
      netR+=qty*(dir*(px-fill)/risk-FEE*(fill+px)/risk);
      remaining-=qty;hits++;
    }
    if(remaining<=1e-9){remaining=0;reason="TARGETS";exitTime=b.time;break;}
    if(i===end){
      const px=b.close*(1-dir*SLIP);
      netR+=remaining*(dir*(px-fill)/risk-FEE*(fill+px)/risk);
      remaining=0;exitTime=b.time;reason="TIME_EXIT";
    }
  }
  return {symbol,side,entry:fill,stop:signal.stop,targets,netR,targetHits:hits,
    exitReason:reason,entryTime:bars[entryIndex].time,exitTime};
}
async function runSymbol(ticker, from, to, evalFrom) {
  const [m15,h1,h4]=await Promise.all([
    getCandles(ticker,"15m",from,to,TF["15m"]),
    getCandles(ticker,"1h",from,to,TF["1h"]),
    getCandles(ticker,"4h",from,to,TF["4h"])
  ]);
  if(m15.length<300||h1.length<80||h4.length<60)
    throw new Error(`Not enough candles: 15m=${m15.length}, 1h=${h1.length}, 4h=${h4.length}`);
  let nextAllowed=0; const trades=[];
  const counts={checked:0,rejected:0,signals:0};
  for(let i=80;i<m15.length-1;i++){
    const closeTime=m15[i].time+TF["15m"];
    if(closeTime<evalFrom||i<nextAllowed) continue;
    const oneHour=h1.filter(c=>c.time+TF["1h"]<=closeTime);
    const fourHour=h4.filter(c=>c.time+TF["4h"]<=closeTime);
    const fifteenMin=m15.slice(0,i+1);
    if(oneHour.length<60||fourHour.length<55) continue;
    counts.checked++;
    const {signal}=analyzeVolumeFlow({symbol:ticker,fourHour,oneHour,fifteenMin});
    if(!signal){counts.rejected++;continue;}
    counts.signals++;
    const trade=simulate(signal,m15,i+1,ticker);
    if(!trade) continue;
    trades.push(trade);
    const exitIndex=m15.findIndex(c=>c.time===trade.exitTime);
    nextAllowed=Math.max(i+2,exitIndex+1);
  }
  return {symbol:ticker,candleCounts:{m15:m15.length,h1:h1.length,h4:h4.length},counts,metrics:metrics(trades),trades};
}
async function main(){
  const end=Date.now(), evalFrom=end-DAYS*86400000, from=evalFrom-7*86400000;
  const tickers=await json(API+"/derivatives/api/v3/tickers");
  const universe=(tickers.tickers||[]).filter(t=>t?.tag==="perpetual"&&t.suspended!==true&&
    /^(PI|PF)_[A-Z0-9]+USD$/.test(String(t.symbol||""))&&Number(t.volumeQuote)>0)
    .sort((a,b)=>Number(b.volumeQuote)-Number(a.volumeQuote)).slice(0,SYMBOLS);
  if(!universe.length) throw new Error("No eligible perpetual markets found");
  const results=[];
  for(const t of universe){
    try{results.push(await runSymbol(t.symbol,from,end,evalFrom));}
    catch(e){results.push({symbol:t.symbol,error:String(e.message||e),metrics:metrics([]),trades:[]});}
  }
  const trades=results.flatMap(x=>x.trades||[]).sort((a,b)=>a.entryTime-b.entryTime);
  const events=trades.flatMap(t=>[{time:t.entryTime,d:1},{time:t.exitTime,d:-1}]).sort((a,b)=>a.time-b.time||a.d-b.d);
  let open=0,maxOpen=0;for(const e of events){open+=e.d;maxOpen=Math.max(maxOpen,open);}
  const report={createdAt:new Date().toISOString(),engine:"volume-flow-breakout",
    window:{from:new Date(evalFrom).toISOString(),to:new Date(end).toISOString(),days:DAYS},
    assumptions:{venue:"Kraken Futures public OHLC",universe:"current top quote-volume perpetuals; survivorship bias",
      entry:"next 15m candle open",feePerSidePct:FEE*100,slippagePerSidePct:SLIP*100,
      exits:"40% at 1.5R, 35% at 2.2R, 25% at 3R",stopBeforeTargetsOnAmbiguousCandle:true,
      maxHoldHours:72,funding:"not included",onePositionPerSymbol:true,
      higherTimeframes:"only fully closed 1h and 4h candles at signal close"},
    overall:metrics(trades),maxConcurrentPositions:maxOpen,
    symbols:results.map(({trades,...r})=>r),trades};
  await mkdir("artifacts",{recursive:true});
  await writeFile("artifacts/volume-flow-backtest.json",JSON.stringify(report,null,2));
  const lines=["# Volume Flow Backtest","",`Window: ${report.window.from} — ${report.window.to}`,"",
    `Trades: ${report.overall.trades}`,`Win rate: ${report.overall.winRatePct.toFixed(2)}%`,
    `Net R: ${report.overall.netR.toFixed(2)}`,`Expectancy: ${report.overall.expectancyR.toFixed(3)}R/trade`,
    `Profit factor: ${report.overall.profitFactor===null?"n/a":report.overall.profitFactor.toFixed(2)}`,
    `Max drawdown: ${report.overall.maxDrawdownR.toFixed(2)}R`,
    `Max concurrent positions: ${maxOpen}`,"",
    "| Symbol | Trades | Win rate | Net R | Expectancy | Error |","|---|---:|---:|---:|---:|---|",
    ...results.map(r=>`| ${r.symbol} | ${r.metrics.trades} | ${r.metrics.winRatePct.toFixed(1)}% | ${r.metrics.netR.toFixed(2)} | ${r.metrics.expectancyR.toFixed(3)} | ${r.error||""} |`),
    "","Caveats: funding excluded; universe is selected using current volume; OHLC cannot reconstruct exact intrabar path or order-book fills."];
  await writeFile("artifacts/volume-flow-backtest.md",lines.join("\n"));
  console.log(JSON.stringify({ok:true,overall:report.overall,maxConcurrentPositions:maxOpen,
    symbols:report.symbols},null,2));
}
main().catch(e=>{console.error(e);process.exitCode=1;});

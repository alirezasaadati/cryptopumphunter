import { analyzePriceAction, PA_CONFIG } from "../src/price-action-engine.js";
import { mkdir, writeFile } from "node:fs/promises";

const BASE = "https://futures.kraken.com";
const H15 = 15 * 60 * 1000, H1 = 60 * 60 * 1000, H4 = 4 * H1;
const TEST_DAYS = Math.max(5, Math.min(30, Number(process.env.PA_BACKTEST_DAYS || 30)));
const END_OFFSET_DAYS = Math.max(0, Number(process.env.PA_BACKTEST_OFFSET_DAYS || 0)); // shifts the evaluation window backward for out-of-sample validation
const SYMBOL_LIMIT = Math.max(1, Math.min(10, Number(process.env.PA_BACKTEST_SYMBOLS || 8)));
const FEE = Number(process.env.PA_BACKTEST_FEE ?? 0.0005);
const SLIPPAGE = Number(process.env.PA_BACKTEST_SLIPPAGE ?? 0.0003);
const MAX_HOLD_BARS = 72 * 4;
const WEIGHTS = [0.4, 0.35, 0.25];
const STRATEGY_IDS = process.env.PA_BACKTEST_STRATEGIES
  ? process.env.PA_BACKTEST_STRATEGIES.split(",").map(x=>x.trim()).filter(Boolean) : null;
const CONFIRMATION_MODE = process.env.PA_BACKTEST_CONFIRMATION || "baseline";
if(!["baseline","macd","volume","macd_volume"].includes(CONFIRMATION_MODE))
  throw new Error(`Unsupported PA_BACKTEST_CONFIRMATION: ${CONFIRMATION_MODE}`);

async function getJson(url) {
  const response = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(25000) });
  const body = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${body.slice(0,160)}`);
  const data = JSON.parse(body);
  if (data?.result === "error" || data?.errors?.length) throw new Error(JSON.stringify(data.errors || data.error));
  return data;
}
function normalize(rows, interval) {
  const seen = new Set();
  return (Array.isArray(rows) ? rows : []).map(x => ({
    time: Number(x.time) < 1e12 ? Number(x.time) * 1000 : Number(x.time),
    open: Number(x.open), high: Number(x.high), low: Number(x.low),
    close: Number(x.close), volume: Number(x.volume || 0)
  })).filter(c => Number.isFinite(c.time) && [c.open,c.high,c.low,c.close].every(Number.isFinite) &&
    c.open>0 && c.low>0 && c.high>=Math.max(c.open,c.close) && c.low<=Math.min(c.open,c.close) &&
    c.time+interval<=Date.now()).sort((a,b)=>a.time-b.time).filter(c=>{
      if(seen.has(c.time)) return false; seen.add(c.time); return true;
    });
}
async function candles(symbol, resolution, from, to, interval) {
  // Fetch bounded chunks so a 30-day 15m history never exceeds the venue's per-request candle cap.
  const chunkBars = 1800;
  const combined = [];
  for (let chunkFrom=from; chunkFrom<to; chunkFrom+=chunkBars*interval) {
    const chunkTo=Math.min(to,chunkFrom+chunkBars*interval);
    const url = new URL(`${BASE}/api/charts/v1/trade/${encodeURIComponent(symbol)}/${resolution}`);
    url.searchParams.set("from", String(Math.floor(chunkFrom/1000)));
    url.searchParams.set("to", String(Math.floor(chunkTo/1000)));
    url.searchParams.set("count", String(chunkBars));
    const data = await getJson(url);
    if(data.more_candles===true)
      throw new Error(`${symbol} ${resolution}: API returned more than ${chunkBars} candles for a bounded chunk`);
    combined.push(...(data.candles||[]));
  }
  return normalize(combined, interval);
}
function summarize(trades) {
  const wins=trades.filter(x=>x.netR>0), losses=trades.filter(x=>x.netR<0);
  const grossWin=wins.reduce((s,x)=>s+x.netR,0), grossLoss=Math.abs(losses.reduce((s,x)=>s+x.netR,0));
  // Realized-equity drawdown must follow exit chronology, not entry chronology.
  let equity=0,peak=0,dd=0;
  for(const t of [...trades].sort((a,b)=>a.exitTime-b.exitTime||a.entryTime-b.entryTime)){
    equity+=t.netR;peak=Math.max(peak,equity);dd=Math.max(dd,peak-equity);
  }
  return {trades:trades.length,wins:wins.length,losses:losses.length,
    breakeven:trades.length-wins.length-losses.length,
    winRatePct:trades.length?100*wins.length/trades.length:0,
    netR:trades.reduce((s,x)=>s+x.netR,0),
    expectancyR:trades.length?trades.reduce((s,x)=>s+x.netR,0)/trades.length:0,
    profitFactor:grossLoss?grossWin/grossLoss:(grossWin?null:0),maxDrawdownR:dd,
    targetHits:trades.reduce((s,x)=>s+x.targetHits,0)};
}
function simulate(side, entry, stop, targets, bars, start, symbol) {
  const dir=side==="LONG"?1:-1, risk=dir===1?entry-stop:stop-entry;
  if(!(risk>0)) return null;
  let remaining=1, netR=0, hits=0, exitReason="TIME_EXIT", exitTime=bars[Math.min(bars.length-1,start+MAX_HOLD_BARS)]?.time;
  const end=Math.min(bars.length-1,start+MAX_HOLD_BARS);
  for(let i=start;i<=end&&remaining>1e-8;i++){
    const b=bars[i], gap=dir===1?b.open<=stop:b.open>=stop, stopHit=dir===1?b.low<=stop:b.high>=stop;
    if(gap||stopHit){
      const px=(gap?b.open:stop)*(1-dir*SLIPPAGE);
      netR+=remaining*(dir*(px-entry)/risk-FEE*(entry+px)/risk);
      remaining=0;exitReason="STOP";exitTime=b.time;break;
    }
    for(let k=0;k<3&&remaining>1e-8;k++){
      const target=targets[k], touched=dir===1?b.high>=target:b.low<=target;
      if(!touched) continue;
      const qty=Math.min(remaining,WEIGHTS[k]),px=target*(1-dir*SLIPPAGE);
      netR+=qty*(dir*(px-entry)/risk-FEE*(entry+px)/risk);
      remaining-=qty;hits++;
    }
    if(remaining<=1e-8){remaining=0;exitReason="TARGETS";exitTime=b.time;break;}
    if(i===end){
      const px=b.close*(1-dir*SLIPPAGE);
      netR+=remaining*(dir*(px-entry)/risk-FEE*(entry+px)/risk);
      remaining=0;exitReason="TIME_EXIT";exitTime=b.time;
    }
  }
  return {symbol,side,entry,stop,targets,netR,targetHits:hits,exitReason,entryTime:bars[start].time,exitTime};
}
async function runSymbol(ticker, from, to, evaluationStart) {
  const [m15,h1,h4]=await Promise.all([
    candles(ticker.symbol,"15m",from,to,H15),
    candles(ticker.symbol,"1h",from,to,H1),
    candles(ticker.symbol,"4h",from,to,H4)
  ]);
  if(m15.length<500||h1.length<100||h4.length<30)
    throw new Error(`insufficient candles: 15m=${m15.length}, 1h=${h1.length}, 4h=${h4.length}`);
  const trades=[];let nextAllowed=0;
  const diagnostics={evaluated:0,accepted:0,lateOrFiltered:0};
  for(let i=40;i<m15.length-1;i++){
    const bar=m15[i], closeTime=bar.time+H15;
    if(closeTime<evaluationStart||i<nextAllowed) continue;
    const oneHour=h1.filter(x=>x.time+H1<=closeTime);
    const fourHour=h4.filter(x=>x.time+H4<=closeTime);
    const fifteenMin=m15.slice(0,i+1);
    if(oneHour.length<40||fourHour.length<30||fifteenMin.length<40) continue;
    diagnostics.evaluated++;
    const next=m15[i+1];
    const live=next.open;
    const result=analyzePriceAction({symbol:ticker.symbol,oneHour,fourHour,fifteenMin,livePrice:live,strategyIds:STRATEGY_IDS,confirmationMode:CONFIRMATION_MODE});
    if(!result.signals?.length){diagnostics.lateOrFiltered++;continue;}
    const signal=result.signals[0],dir=signal.side==="LONG"?1:-1;
    const entry=next.open*(1+dir*SLIPPAGE);
    const risk=dir===1?entry-signal.stop:signal.stop-entry;
    const riskPct=risk/entry;
    if(!(risk>0)||riskPct<0.0015||riskPct>0.06) continue;
    // Rebase targets to the actual simulated fill, not the signal candle's planned close.
    const targets=PA_CONFIG.TARGET_R_MULTIPLES.map(r=>entry+dir*risk*r);
    const trade=simulate(signal.side,entry,signal.stop,targets,m15,i+1,ticker.symbol);
    if(!trade) continue;
    trade.strategyId=signal.strategyId;trade.score=signal.score;trade.signalTime=bar.time;
    trades.push(trade);diagnostics.accepted++;
    const exitIndex=m15.findIndex(x=>x.time===trade.exitTime);
    nextAllowed=Math.max(i+2,exitIndex+1);
  }
  return {symbol:ticker.symbol,candles:{m15:m15.length,h1:h1.length,h4:h4.length},diagnostics,metrics:summarize(trades),trades};
}
async function main(){
  const end=Date.now()-END_OFFSET_DAYS*24*H1,start=end-(TEST_DAYS+6)*24*H1,evaluationStart=end-TEST_DAYS*24*H1;
  const data=await getJson(BASE+"/derivatives/api/v3/tickers");
  const universe=(data.tickers||[]).filter(t=>t?.tag==="perpetual"&&t.suspended!==true&&
    /^(PI|PF)_[A-Z0-9]+USD$/.test(String(t.symbol||""))&&Number(t.volumeQuote)>0)
    .sort((a,b)=>Number(b.volumeQuote)-Number(a.volumeQuote)).slice(0,SYMBOL_LIMIT);
  if(!universe.length) throw new Error("No perpetual contracts found");
  const results=[];
  for(const t of universe){try{results.push(await runSymbol(t,start,end,evaluationStart));}
    catch(e){results.push({symbol:t.symbol,error:String(e.message||e),metrics:summarize([]),trades:[]});}}
  const all=results.flatMap(x=>x.trades||[]).sort((a,b)=>a.entryTime-b.entryTime);
  const strategyGroups=Object.groupBy(all,t=>t.strategyId||"unknown");
  const byStrategy=Object.entries(strategyGroups).map(([strategyId,trades])=>({
    strategyId,...summarize(trades)
  })).sort((a,b)=>a.strategyId.localeCompare(b.strategyId));
  const timeline=all.flatMap(t=>[{time:t.entryTime,delta:1},{time:t.exitTime,delta:-1}])
    .sort((a,b)=>a.time-b.time||a.delta-b.delta);
  let openPositions=0,maxConcurrentPositions=0;
  for(const event of timeline){openPositions+=event.delta;maxConcurrentPositions=Math.max(maxConcurrentPositions,openPositions);}
  const report={generatedAt:new Date().toISOString(),engine:"src/price-action-engine.js",confirmationMode:CONFIRMATION_MODE,
    venue:"Kraken Derivatives public OHLC",period:{from:new Date(evaluationStart).toISOString(),to:new Date(end).toISOString(),days:TEST_DAYS},
    methodology:{warmupDays:6,symbolSelection:"current highest-volume eligible perpetuals (survivorship/universe bias)",
      entry:"next 15m candle open with adverse slippage",feePerSidePct:FEE*100,slippagePerSidePct:SLIPPAGE*100,
      partialExitsPct:[40,35,25],maxHoldHours:72,sameCandleRule:"stop checked before targets",
      funding:"excluded",signals:"strictly closed 4h/1h/15m candles; 15m walk-forward; one position per symbol at a time",strategyFilter:STRATEGY_IDS||"all",confirmationMode:CONFIRMATION_MODE},
    overall:summarize(all),byStrategy,maxConcurrentPositions,
    symbols:results.map(({trades,...x})=>x),trades:all};
  await mkdir("artifacts",{recursive:true});
  await writeFile("artifacts/price-action-backtest.json",JSON.stringify(report,null,2));
  const md=["# Price Action Engine — Historical Backtest","",
    `Period: ${report.period.from} — ${report.period.to} (${TEST_DAYS} days)`,
    `Symbols successful: ${results.filter(x=>!x.error).length}/${SYMBOL_LIMIT}`,
    `Trades: ${report.overall.trades}`,`Win rate: ${report.overall.winRatePct.toFixed(2)}%`,
    `Net: ${report.overall.netR.toFixed(2)}R`,`Expectancy: ${report.overall.expectancyR.toFixed(3)}R/trade`,
    `Profit factor: ${report.overall.profitFactor===null?"n/a":report.overall.profitFactor.toFixed(2)}`,
    `Max drawdown (realized exit order): ${report.overall.maxDrawdownR.toFixed(2)}R`,
    `Max concurrent positions: ${report.maxConcurrentPositions}`,"",
    "## Strategy breakdown","",
    "| Strategy | Trades | Win rate | Net R | Expectancy | Profit factor | Max DD |",
    "|---|---:|---:|---:|---:|---:|---:|",
    ...report.byStrategy.map(x=>`| ${x.strategyId} | ${x.trades} | ${x.winRatePct.toFixed(1)}% | ${x.netR.toFixed(2)} | ${x.expectancyR.toFixed(3)} | ${x.profitFactor===null?"n/a":x.profitFactor.toFixed(2)} | ${x.maxDrawdownR.toFixed(2)} |`),"",
    "| Symbol | Trades | Win rate | Net R | Expectancy | Max DD | Error |",
    "|---|---:|---:|---:|---:|---:|---|",
    ...results.map(x=>`| ${x.symbol} | ${x.metrics.trades} | ${x.metrics.winRatePct.toFixed(1)}% | ${x.metrics.netR.toFixed(2)} | ${x.metrics.expectancyR.toFixed(3)} | ${x.metrics.maxDrawdownR.toFixed(2)} | ${x.error||""} |`),
    "","Caveats: funding excluded; current-volume universe introduces survivorship bias; OHLC simulation cannot model queue position or exact intrabar path. Stop is conservatively evaluated before targets when both are touched in one candle."];
  await writeFile("artifacts/price-action-backtest.md",md.join("\n"));
  console.log(JSON.stringify({ok:true,overall:report.overall,symbols:report.symbols.map(({trades,...x})=>x)},null,2));
}
main().catch(e=>{console.error(e);process.exitCode=1;});

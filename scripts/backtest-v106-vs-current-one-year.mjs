import { mkdir, writeFile } from "node:fs/promises";
import { analyzeFuturesSymbol, FUTURES_CONFIG } from "../src/index.js";

const BASE = "https://futures.kraken.com";
const HOUR = 3600000;
const DAY = 86400000;
const SYMBOLS = ["PF_XBTUSD","PF_ETHUSD","PF_SOLUSD","PF_XRPUSD","PF_DOGEUSD","PF_ADAUSD","PF_LINKUSD","PF_LTCUSD","PF_BCHUSD","PF_AVAXUSD"];
const FEE = 0.0005, SLIPPAGE = 0.0003, MAX_HOLD = 72;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function getJson(url, attempt = 0) {
  const response = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(30000) });
  const body = await response.text();
  if (!response.ok) {
    if (attempt < 4 && (response.status === 429 || response.status >= 500)) {
      await wait(500 * (attempt + 1));
      return getJson(url, attempt + 1);
    }
    throw new Error("HTTP " + response.status + ": " + body.slice(0, 180));
  }
  let data;
  try { data = JSON.parse(body); } catch { throw new Error("Invalid JSON: " + url); }
  if (data?.result === "error" || (Array.isArray(data?.errors) && data.errors.length)) throw new Error("Kraken API error: " + JSON.stringify(data.errors || data.error));
  return data;
}

function normalize(rows, intervalMs) {
  if (!Array.isArray(rows)) throw new Error("Kraken candles missing");
  const map = new Map();
  for (const row of rows) {
    const raw = Number(row.time);
    const candle = {
      time: raw < 1e12 ? raw * 1000 : raw,
      open: Number(row.open), high: Number(row.high), low: Number(row.low),
      close: Number(row.close), volume: Number(row.volume)
    };
    if (![candle.time,candle.open,candle.high,candle.low,candle.close,candle.volume].every(Number.isFinite)) continue;
    if (candle.time <= 0 || candle.open <= 0 || candle.low <= 0 || candle.close <= 0 ||
        candle.high < Math.max(candle.open,candle.close,candle.low) || candle.low > Math.min(candle.open,candle.close) ||
        candle.volume < 0 || candle.time + intervalMs > Date.now()) continue;
    map.set(candle.time, candle);
  }
  return [...map.values()].sort((a,b)=>a.time-b.time);
}

async function fetchCandles(symbol, resolution, fromMs, toMs, intervalMs) {
  const chunkMs = intervalMs * 1750;
  const all = [];
  for (let start = fromMs; start < toMs; start += chunkMs) {
    const end = Math.min(toMs, start + chunkMs);
    const url = new URL(BASE + "/api/charts/v1/trade/" + encodeURIComponent(symbol) + "/" + resolution);
    url.searchParams.set("from", String(Math.floor(start / 1000)));
    url.searchParams.set("to", String(Math.floor(end / 1000)));
    url.searchParams.set("count", "1800");
    const data = await getJson(url);
    if (data.more_candles === true) throw new Error(symbol + " " + resolution + ": incomplete candle chunk");
    all.push(...normalize(data.candles, intervalMs));
    await wait(100);
  }
  return normalize(all, intervalMs);
}

function ema(values, period) {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let value = values.slice(0,period).reduce((a,b)=>a+b,0)/period;
  for (let i=period;i<values.length;i++) value=values[i]*k+value*(1-k);
  return Number.isFinite(value) ? value : null;
}
function rsi(values, period=14) {
  if (values.length <= period) return null;
  let gains=0,losses=0;
  for(let i=1;i<=period;i++){const d=values[i]-values[i-1];gains+=Math.max(d,0);losses+=Math.max(-d,0);}
  let g=gains/period,l=losses/period;
  for(let i=period+1;i<values.length;i++){const d=values[i]-values[i-1];g=(g*(period-1)+Math.max(d,0))/period;l=(l*(period-1)+Math.max(-d,0))/period;}
  if(g===0&&l===0)return 50;
  if(l===0)return 100;
  if(g===0)return 0;
  return 100-100/(1+g/l);
}
function atr(candles,period=14){
  if(candles.length<=period)return null;
  const tr=[];
  for(let i=1;i<candles.length;i++){const c=candles[i],p=candles[i-1].close;tr.push(Math.max(c.high-c.low,Math.abs(c.high-p),Math.abs(c.low-p)));}
  const a=tr.slice(-period);
  return a.length===period?a.reduce((s,x)=>s+x,0)/period:null;
}
function strictV106(ticker,candles){
  if(candles.length<FUTURES_CONFIG.MIN_CANDLES)return null;
  const last=candles.at(-1),prev=candles.at(-2),closes=candles.map(c=>c.close);
  const e20=ema(closes,20),e50=ema(closes,50),rv=rsi(closes,14),a=atr(candles,14);
  if(![e20,e50,rv,a].every(Number.isFinite)||a<=0)return null;
  if(a/last.close*100>2.0)return null;
  let mode=null,stop=null;
  const distance=((last.close-e20)/e20)*100;
  if(last.close<e50&&e20<e50&&rv<40&&distance<-.5){
    mode="TREND_SHORT";stop=Math.max(...candles.slice(-7).map(c=>c.high))+a*.2;
  } else if(last.close>e50&&rv>75){
    const red=last.close<last.open,body=last.open-last.close,range=last.high-last.low;
    if(red&&range>0&&body/range>.5&&last.high>prev.high){mode="RALLY_FADE";stop=last.high+a*.2;}
  }
  if(!mode)return null;
  const entry=Number(ticker.last),risk=stop-entry,riskPct=risk/entry*100;
  if(!Number.isFinite(entry)||entry<=0||!Number.isFinite(risk)||risk<=0||riskPct<.5||riskPct>2)return null;
  return {symbol:ticker.symbol,side:"SHORT",mode,score:mode==="RALLY_FADE"?90:80,entry,stop,target1:entry-risk*1.5,risk,riskPct};
}
function lowerBound(candles,time){let lo=0,hi=candles.length;while(lo<hi){const mid=(lo+hi)>>1;if(candles[mid].time<time)lo=mid+1;else hi=mid;}return lo;}
function closeTrade(candidate, candles, startTime, model, signalTime) {
  const side=candidate.side,dir=side==="LONG"?1:-1;
  const rawEntry=Number(candidate.entry);
  const entry=rawEntry*(1+dir*SLIPPAGE);
  const stop=Number(candidate.stop);
  const initialRisk=dir===1?entry-stop:stop-entry;
  if(!(initialRisk>0))return null;
  let remaining=1,netR=0,targetHits=0,exitTime=null,exitReason="TIME_EXIT";
  const targets=model==="v106"?[{price:Number(candidate.target1),weight:1}]:[
    {price:Number(candidate.target1),weight:.40},
    {price:Number(candidate.target2),weight:.35},
    {price:Number(candidate.target3),weight:.25}
  ];
  const first=lowerBound(candles,startTime);
  const lastTime=startTime+MAX_HOLD*HOUR;
  for(let i=first;i<candles.length&&candles[i].time<=lastTime&&remaining>1e-9;i++){
    const b=candles[i];
    const stopGap=dir===1?b.open<=stop:b.open>=stop;
    const stopTouched=dir===1?b.low<=stop:b.high>=stop;
    if(stopGap||stopTouched){
      const raw=stopGap?b.open:stop;
      const fill=raw*(1-dir*SLIPPAGE);
      const pnlR=dir*(fill-entry)/initialRisk;
      const feeR=FEE*(entry+fill)/initialRisk;
      netR+=remaining*(pnlR-feeR);remaining=0;exitTime=b.time+HOUR;exitReason="STOP";break;
    }
    for(const target of targets){
      if(target.hit||remaining<=1e-9)continue;
      const touched=dir===1?b.high>=target.price:b.low<=target.price;
      if(!touched)continue;
      const gap=dir===1?b.open>=target.price:b.open<=target.price;
      const raw=gap?b.open:target.price;
      const fill=raw*(1-dir*SLIPPAGE);
      const pnlR=dir*(fill-entry)/initialRisk;
      const feeR=FEE*(entry+fill)/initialRisk;
      const weight=Math.min(remaining,target.weight);
      netR+=weight*(pnlR-feeR);remaining-=weight;target.hit=true;targetHits++;
    }
    if(remaining<=1e-9){remaining=0;exitTime=b.time+HOUR;exitReason="TARGETS";break;}
    if(i===first+MAX_HOLD){const fill=b.close*(1-dir*SLIPPAGE);netR+=remaining*(dir*(fill-entry)/initialRisk-FEE*(entry+fill)/initialRisk);remaining=0;exitTime=b.time+HOUR;exitReason="TIME_EXIT";}
  }
  if(remaining>1e-9){
    const b=candles[Math.min(candles.length-1,lowerBound(candles,lastTime)-1)]||candles.at(-1);
    const fill=b.close*(1-dir*SLIPPAGE);
    netR+=remaining*(dir*(fill-entry)/initialRisk-FEE*(entry+fill)/initialRisk);
    remaining=0;exitTime=b.time+HOUR;exitReason="END_OF_DATA";
  }
  return {symbol:candidate.symbol,side,mode:candidate.mode||null,score:candidate.score,signalTime,entryTime:startTime,entry,stop,initialRisk,netR,targetHits,exitTime,exitReason};
}
function metrics(trades){
  const wins=trades.filter(t=>t.netR>0),losses=trades.filter(t=>t.netR<0);
  const grossWin=wins.reduce((s,t)=>s+t.netR,0),grossLoss=Math.abs(losses.reduce((s,t)=>s+t.netR,0));
  let equity=0,peak=0,maxDD=0;for(const t of [...trades].sort((a,b)=>a.exitTime-b.exitTime)){equity+=t.netR;peak=Math.max(peak,equity);maxDD=Math.max(maxDD,peak-equity);}
  const net=trades.reduce((s,t)=>s+t.netR,0);
  return {trades:trades.length,wins:wins.length,losses:losses.length,winRatePct:trades.length?wins.length/trades.length*100:0,netR:net,expectancyR:trades.length?net/trades.length:0,profitFactor:grossLoss?grossWin/grossLoss:grossWin?null:0,maxDrawdownR:maxDD,avgTradesPerDay:trades.length/365};
}
async function testSymbol(symbol,fromMs,toMs){
  const warm=fromMs-25*DAY;
  const h1=await fetchCandles(symbol,"1h",warm,toMs,HOUR);
  const h4=await fetchCandles(symbol,"4h",warm,toMs,4*HOUR);
  const m15=await fetchCandles(symbol,"15m",warm,toMs,15*60000);
  if(h1.length<100||h4.length<FUTURES_CONFIG.MIN_CANDLES||m15.length<120)throw new Error("Insufficient data: 1h="+h1.length+" 4h="+h4.length+" 15m="+m15.length);
  const out={v106:{signals:0,trades:[]},current:{signals:0,trades:[]}};
  let next106=0,nextCurrent=0,i4=0,i15=0;
  for(let i=60;i<h1.length-1;i++){
    const bar=h1[i],signalClose=bar.time+HOUR;
    if(signalClose<fromMs||signalClose>=toMs)continue;
    const next=h1[i+1],entry=next.open;
    const hist1=h1.slice(0,i+1);
    const strict=strictV106({symbol,last:entry},hist1);
    if(strict){
      out.v106.signals++;
      if(signalClose>=next106){
        const trade=closeTrade(strict,h1,signalClose,"v106",bar.time);
        if(trade){out.v106.trades.push(trade);next106=trade.exitTime;}
      }
    }
    while(i4<h4.length&&h4[i4].time+4*HOUR<=signalClose)i4++;
    while(i15<m15.length&&m15[i15].time+15*60000<=signalClose)i15++;
    if(i4<FUTURES_CONFIG.MIN_CANDLES||i15<30)continue;
    const recent15=m15.slice(Math.max(0,i15-120),i15);
    const change= i>=24 ? (bar.close/h1[i-24].close-1)*100 : 0;
    const ticker={symbol,last:entry,quoteVolume:1e9,priceChangePercent:change,premium:{lastFundingRate:null}};
    let candidate;
    try{candidate=analyzeFuturesSymbol(ticker,hist1,h4.slice(0,i4),recent15);}catch{candidate=null;}
    if(candidate?.eligible===true){
      out.current.signals++;
      if(signalClose>=nextCurrent){
        const trade=closeTrade(candidate,h1,signalClose,"current",bar.time);
        if(trade){out.current.trades.push(trade);nextCurrent=trade.exitTime;}
      }
    }
  }
  return {symbol,candles:{oneHour:h1.length,fourHour:h4.length,fifteenMinute:m15.length},v106:{signals:out.v106.signals,metrics:metrics(out.v106.trades),trades:out.v106.trades},current:{signals:out.current.signals,metrics:metrics(out.current.trades),trades:out.current.trades}};
}
async function main(){
  const toMs=Date.now(),fromMs=toMs-365*DAY;
  const results=[];
  for(const symbol of SYMBOLS){
    console.log("START",symbol);
    try{const result=await testSymbol(symbol,fromMs,toMs);results.push(result);console.log("DONE",symbol,JSON.stringify({v106:result.v106.metrics,current:result.current.metrics}));}
    catch(error){results.push({symbol,error:String(error?.message||error)});console.error("FAILED",symbol,String(error?.stack||error));}
  }
  const good=results.filter(r=>!r.error);
  const aggregate=key=>metrics(good.flatMap(r=>r[key].trades).sort((a,b)=>a.exitTime-b.exitTime));
  const report={
    generatedAt:new Date().toISOString(),venue:"Kraken Derivatives historical OHLC",
    period:{from:new Date(fromMs).toISOString(),to:new Date(toMs).toISOString(),days:365},
    symbols:SYMBOLS,successfulSymbols:good.length,failedSymbols:results.filter(r=>r.error).map(r=>({symbol:r.symbol,error:r.error})),
    assumptions:{entry:"next 1h candle open",exitResolution:"1h OHLC",feePerSidePct:FEE*100,slippagePerSidePct:SLIPPAGE*100,funding:"excluded",maxHoldHours:MAX_HOLD,ambiguousStopTarget:"stop first",sameSymbolOverlap:"one position at a time",crossSymbolCapital:"not portfolio-constrained; results in R",v106Exit:"100% at 1.5R",currentExit:"40% at 1.5R, 35% at 2.2R, 25% at 3R"},
    v106:{signals:good.reduce((s,r)=>s+r.v106.signals,0),metrics:aggregate("v106")},
    current:{signals:good.reduce((s,r)=>s+r.current.signals,0),metrics:aggregate("current")},
    bySymbol:results.map(({v106,current,...rest})=>({...rest,v106:v106?{signals:v106.signals,metrics:v106.metrics}:null,current:current?{signals:current.signals,metrics:current.metrics}:null})),
    trades:{v106:good.flatMap(r=>r.v106.trades),current:good.flatMap(r=>r.current.trades)}
  };
  await mkdir("artifacts",{recursive:true});
  await writeFile("artifacts/v106-vs-current-one-year.json",JSON.stringify(report,null,2));
  const a=report.v106.metrics,b=report.current.metrics;
  const lines=[
    "# v10.6 corrected vs current production engine — 365-day backtest","",
    "Period: "+report.period.from+" — "+report.period.to,
    "Successfully tested: "+good.length+"/"+SYMBOLS.length+" symbols","",
    "| Metric | v10.6 corrected SHORT | Current production engine |",
    "|---|---:|---:|",
    "| Eligible signals | "+report.v106.signals+" | "+report.current.signals+" |",
    "| Executed trades | "+a.trades+" | "+b.trades+" |",
    "| Wins / losses | "+a.wins+" / "+a.losses+" | "+b.wins+" / "+b.losses+" |",
    "| Win rate | "+a.winRatePct.toFixed(2)+"% | "+b.winRatePct.toFixed(2)+"% |",
    "| Net result | "+a.netR.toFixed(2)+"R | "+b.netR.toFixed(2)+"R |",
    "| Expectancy | "+a.expectancyR.toFixed(3)+"R | "+b.expectancyR.toFixed(3)+"R |",
    "| Profit factor | "+(a.profitFactor??"n/a")+" | "+(b.profitFactor??"n/a")+" |",
    "| Max drawdown | "+a.maxDrawdownR.toFixed(2)+"R | "+b.maxDrawdownR.toFixed(2)+"R |",
    "| Avg trades / calendar day | "+a.avgTradesPerDay.toFixed(2)+" | "+b.avgTradesPerDay.toFixed(2)+" |","",
    "Fees: 0.05% per side. Slippage: 0.03% per side. Funding excluded. Same entry timing, 1h exit OHLC, stop-first ambiguity, one open trade per symbol.",
    "v10.6 exits 100% at 1.5R. Current production engine uses 40/35/25 partial exits at 1.5R/2.2R/3R. Returns are aggregate R, not account-equity returns; symbols are not constrained by shared capital.","",
    "| Symbol | v10.6 signals | v10.6 trades | v10.6 win% | v10.6 net R | Current signals | Current trades | Current win% | Current net R |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|",
    ...results.map(r=>r.error?"| "+r.symbol+" | ERROR | — | — | — | ERROR | — | — | — |":"| "+r.symbol+" | "+r.v106.signals+" | "+r.v106.metrics.trades+" | "+r.v106.metrics.winRatePct.toFixed(1)+" | "+r.v106.metrics.netR.toFixed(2)+" | "+r.current.signals+" | "+r.current.metrics.trades+" | "+r.current.metrics.winRatePct.toFixed(1)+" | "+r.current.metrics.netR.toFixed(2)+" |")
  ];
  await writeFile("artifacts/v106-vs-current-one-year.md",lines.join("\n"));
  console.log("FINAL_SUMMARY",JSON.stringify({period:report.period,successfulSymbols:report.successfulSymbols,failedSymbols:report.failedSymbols,v106:{signals:report.v106.signals,...report.v106.metrics},current:{signals:report.current.signals,...report.current.metrics}},null,2));
  if(!good.length)throw new Error("No symbols completed successfully");
}
main().catch(error=>{console.error(error);process.exitCode=1;});

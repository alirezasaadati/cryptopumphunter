import { analyzeFuturesSymbol, FUTURES_CONFIG } from "../src/index.js";
import { hasPullbackOrBreakout } from "../src/futures-entry-experiments.js";
import { mkdir, writeFile } from "node:fs/promises";

const BASE = "https://futures.kraken.com";
const HOUR = 3600000;
const DAY = 24 * HOUR;
const DAYS = Math.max(30, Math.min(90, Number(process.env.BACKTEST_DAYS || 90)));
const SYMBOL_LIMIT = Math.max(1, Math.min(5, Number(process.env.BACKTEST_SYMBOLS || 5)));
const FEE = Number(process.env.BACKTEST_FEE || 0.0005);
const SLIPPAGE = Number(process.env.BACKTEST_SLIPPAGE || 0.0003);
const MAX_HOLD_HOURS = 72;
const WEIGHTS = [0.40, 0.35, 0.25];
const INTERVALS = { "15m": 900000, "1h": HOUR, "4h": 4 * HOUR };

async function getJson(url) {
  const response = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(25000) });
  const body = await response.text();
  if (!response.ok) throw new Error("HTTP " + response.status + ": " + body.slice(0, 180));
  const data = JSON.parse(body);
  if (data?.result === "error" || (Array.isArray(data?.errors) && data.errors.length)) throw new Error("Kraken API error");
  return data;
}

function normalize(rows, intervalMs) {
  const seen = new Set();
  return (rows || []).map(r => ({
    time: Number(r.time) < 1e12 ? Number(r.time) * 1000 : Number(r.time),
    open: Number(r.open), high: Number(r.high), low: Number(r.low), close: Number(r.close), volume: Number(r.volume)
  })).filter(c => Number.isFinite(c.time) && [c.open,c.high,c.low,c.close,c.volume].every(Number.isFinite) &&
    c.open > 0 && c.close > 0 && c.low > 0 && c.high >= c.low && c.volume >= 0 &&
    c.time + intervalMs <= Date.now()).sort((a,b) => a.time-b.time).filter(c => {
      if (seen.has(c.time)) return false;
      seen.add(c.time); return true;
    });
}

// Fetch in bounded windows so the 90-day 15m history never exceeds Kraken's candle cap.
async function fetchCandles(symbol, resolution, fromMs, toMs) {
  const intervalMs = INTERVALS[resolution];
  const maxBarsPerRequest = 1500;
  const windowMs = maxBarsPerRequest * intervalMs;
  const all = [];
  for (let cursor = fromMs; cursor < toMs; cursor += windowMs) {
    const end = Math.min(toMs, cursor + windowMs);
    const url = new URL(BASE + "/api/charts/v1/trade/" + encodeURIComponent(symbol) + "/" + resolution);
    url.searchParams.set("from", String(Math.floor(cursor / 1000)));
    url.searchParams.set("to", String(Math.floor(end / 1000)));
    url.searchParams.set("count", "2000");
    const data = await getJson(url);
    if (!Array.isArray(data.candles)) throw new Error(symbol + " " + resolution + ": candles missing");
    all.push(...normalize(data.candles, intervalMs));
    if (data.more_candles === true) throw new Error(symbol + " " + resolution + ": Kraken returned more candles than the bounded window");
  }
  const byTime = new Map(all.map(c => [c.time,c]));
  return [...byTime.values()].sort((a,b)=>a.time-b.time);
}

function avg(xs) { return xs.length ? xs.reduce((a,b)=>a+b,0)/xs.length : 0; }
function ema(values, period) {
  if (values.length < period) return null;
  const k = 2/(period+1);
  let value = avg(values.slice(0,period));
  for (let i=period;i<values.length;i++) value = values[i]*k + value*(1-k);
  return value;
}
function atr(candles, period=14) {
  if (candles.length <= period) return null;
  const ranges=[];
  for(let i=1;i<candles.length;i++){
    const c=candles[i], prev=candles[i-1].close;
    ranges.push(Math.max(c.high-c.low,Math.abs(c.high-prev),Math.abs(c.low-prev)));
  }
  return avg(ranges.slice(-period));
}
function change24h(candles,index) {
  const old=candles[index-24], now=candles[index];
  return old && old.close>0 ? (now.close/old.close-1)*100 : 0;
}

function closePosition(p, rawPrice, reason, time) {
  const dir=p.direction, exit=rawPrice*(1-dir*SLIPPAGE);
  const gross=dir*(exit-p.entry)/p.risk;
  const fee=FEE*(p.entry+exit)/p.risk;
  p.r += p.remaining*(gross-fee);
  p.remaining=0; p.exitTime=time; p.reason=reason;
}
function simulate({side,entry,stop,targets,candles,startIndex,maxBars}) {
  const direction=side==="LONG"?1:-1;
  const risk=direction===1?entry-stop:stop-entry;
  if(!(risk>0)) return null;
  const p={direction,entry,stop,risk,remaining:1,r:0,targetHits:0,exitTime:null,reason:null};
  const end=Math.min(candles.length-1,startIndex+maxBars);
  for(let i=startIndex;i<=end&&p.remaining>0;i++){
    const b=candles[i], gap=direction===1?b.open<=stop:b.open>=stop;
    const stopped=direction===1?b.low<=stop:b.high>=stop;
    if(gap||stopped){closePosition(p,gap?b.open:stop,"STOP",b.time);break;}
    for(let j=0;j<3&&p.remaining>0;j++){
      const target=targets[j]; if(!Number.isFinite(target)) continue;
      const hit=direction===1?b.high>=target:b.low<=target;
      if(!hit) break;
      const exit=target*(1-direction*SLIPPAGE);
      p.r+=WEIGHTS[j]*(direction*(exit-entry)/risk-FEE*(entry+exit)/risk);
      p.remaining-=WEIGHTS[j]; p.targetHits++;
      targets[j]=null;
    }
    if(p.remaining<=1e-9){p.remaining=0;p.exitTime=b.time;p.reason="TARGETS";break;}
    if(i===end) closePosition(p,b.close,"TIME_EXIT",b.time);
  }
  if(p.remaining>0) closePosition(p,candles[end].close,"TIME_EXIT",candles[end].time);
  return {side,entry,stop,risk,netR:p.r,targetHits:p.targetHits,exitReason:p.reason,entryTime:candles[startIndex].time,exitTime:p.exitTime};
}
function summarize(trades) {
  const wins=trades.filter(t=>t.netR>0), losses=trades.filter(t=>t.netR<0);
  const gw= wins.reduce((s,t)=>s+t.netR,0), gl=Math.abs(losses.reduce((s,t)=>s+t.netR,0));
  let eq=0,peak=0,dd=0;
  for(const t of trades){eq+=t.netR;peak=Math.max(peak,eq);dd=Math.max(dd,peak-eq);}
  return {trades:trades.length,wins:wins.length,losses:losses.length,winRatePct:trades.length?wins.length/trades.length*100:0,
    netR:trades.reduce((s,t)=>s+t.netR,0),expectancyR:trades.length?trades.reduce((s,t)=>s+t.netR,0)/trades.length:0,
    profitFactor:gl?gw/gl:gw?null:0,maxDrawdownR:dd};
}
function timing(base,fast) {
  const used=new Set(), leads=[];
  for(const b of base){
    let best=-1, distance=Infinity;
    fast.forEach((f,i)=>{if(used.has(i)||f.symbol!==b.symbol||f.side!==b.side)return;
      const d=f.signalTime-b.signalTime;
      if(Math.abs(d)<=DAY&&Math.abs(d)<distance){best=i;distance=Math.abs(d);}
    });
    if(best>=0){used.add(best);leads.push((base.length?base[0].signalTime:0, (base.length?fast[best].signalTime:0)-b.signalTime));}
  }
  const minutes=leads.map(x=>x[1]/60000);
  return {matched:minutes.length,baselineSignals:base.length,averageLeadMinutes:minutes.length?avg(minutes):null,earlySignals:minutes.filter(x=>x<0).length,lateSignals:minutes.filter(x=>x>0).length};
}

async function main() {
  const end=Date.now(), start=end-DAYS*DAY, warmup=start-20*DAY;
  const tickers=(await getJson(BASE+"/derivatives/api/v3/tickers")).tickers;
  const universe=(tickers||[]).filter(t=>t?.tag==="perpetual"&&t.suspended!==true&&/^(PI|PF)_[A-Z0-9]+USD$/.test(String(t.symbol||""))&&
    Number(t.volumeQuote)>=FUTURES_CONFIG.MIN_QUOTE_VOLUME&&Number(t.last)>0)
    .sort((a,b)=>Number(b.volumeQuote)-Number(a.volumeQuote)).slice(0,SYMBOL_LIMIT);
  if(!universe.length) throw new Error("No eligible Kraken perpetual contracts");

  const baseline=[], fast=[], symbolReports=[];
  for(const ticker of universe){
    const [m15,h1,h4]=await Promise.all([
      fetchCandles(ticker.symbol,"15m",warmup,end),
      fetchCandles(ticker.symbol,"1h",warmup,end),
      fetchCandles(ticker.symbol,"4h",warmup,end)
    ]);
    if(m15.length<100||h1.length<FUTURES_CONFIG.MIN_CANDLES||h4.length<FUTURES_CONFIG.MIN_CANDLES)
      throw new Error(ticker.symbol+": insufficient history 15m="+m15.length+" 1h="+h1.length+" 4h="+h4.length);

    // Baseline: unchanged production eligibility and next 1h open fill.
    let nextBaseTime=0;
    for(let i=60;i<h1.length-1;i++){
      const signalTime=h1[i].time+HOUR;
      if(signalTime<start||signalTime<=nextBaseTime) continue;
      const closed4=h4.filter(c=>c.time+4*HOUR<=signalTime);
      if(closed4.length<FUTURES_CONFIG.MIN_CANDLES) continue;
      const t={...ticker,priceChangePercent:change24h(h1,i),quoteVolume:Number(ticker.volumeQuote)||0,premium:{lastFundingRate:null}};
      const s=analyzeFuturesSymbol(t,h1.slice(0,i+1),closed4);
      if(!s?.eligible) continue;
      const entry=h1[i+1].open*(1+(s.side==="LONG"?1:-1)*SLIPPAGE);
      const valid=s.side==="LONG"?s.stop<entry&&entry<s.target1:s.stop>entry&&entry>s.target1;
      if(!valid) continue;
      const bars=h1.slice(i+1,Math.min(h1.length,i+1+MAX_HOLD_HOURS+1));
      const tr=simulate({side:s.side,entry,stop:s.stop,targets:[s.target1,s.target2,s.target3],candles:bars,startIndex:0,maxBars:MAX_HOLD_HOURS});
      if(!tr) continue;
      Object.assign(tr,{symbol:ticker.symbol,signalTime,signalEntry:s.entry});
      baseline.push(tr); nextBaseTime=tr.exitTime;
    }

    // Faster path: use the last fully closed 1h/4h engine snapshot for direction and
    // exact existing SL/TP levels, but permit the 4h trend to be non-confirming (not opposing)
    // through the engine's experimentalEligible path. Trigger and fill are 15m.
    let h1Index=-1, nextFastTime=0, cachedIndex=-1, cachedSignal=null;
    for(let i=60;i<m15.length-1;i++){
      const bar=m15[i], signalTime=bar.time+INTERVALS["15m"];
      if(signalTime<start||signalTime<=nextFastTime) continue;
      while(h1Index+1<h1.length&&h1[h1Index+1].time+HOUR<=signalTime) h1Index++;
      if(h1Index<59) continue;
      if(cachedIndex!==h1Index){
        const hourClose=h1[h1Index].time+HOUR;
        const closed4=h4.filter(c=>c.time+4*HOUR<=hourClose);
        const t={...ticker,priceChangePercent:change24h(h1,h1Index),quoteVolume:Number(ticker.volumeQuote)||0,premium:{lastFundingRate:null}};
        cachedSignal=closed4.length>=FUTURES_CONFIG.MIN_CANDLES?analyzeFuturesSymbol(t,h1.slice(0,h1Index+1),closed4):null;
        cachedIndex=h1Index;
      }
      const s=cachedSignal;
      if(!s||(!s.eligible&&!s.experimentalEligible)) continue;
      const m15Slice=m15.slice(Math.max(0,i-60),i+1);
      const e15=ema(m15Slice.map(c=>c.close),20), a15=atr(m15Slice,14);
      if(!Number.isFinite(e15)||!Number.isFinite(a15)||a15<=0) continue;
      if(!hasPullbackOrBreakout({side:s.side,candles:m15Slice,ema20:e15,atr:a15,lookback:20})) continue;
      const volAvg=avg(m15Slice.slice(-21,-1).map(c=>c.volume));
      const volRatio=volAvg>0?bar.volume/volAvg:0;
      if(volRatio<1.0) continue;
      const next=m15[i+1], dir=s.side==="LONG"?1:-1;
      const entry=next.open*(1+dir*SLIPPAGE);
      const valid=s.side==="LONG"?s.stop<entry&&entry<s.target1:s.stop>entry&&entry>s.target1;
      if(!valid) continue;
      const bars=m15.slice(i+1,Math.min(m15.length,i+1+MAX_HOLD_HOURS*4+1));
      const tr=simulate({side:s.side,entry,stop:s.stop,targets:[s.target1,s.target2,s.target3],candles:bars,startIndex:0,maxBars:MAX_HOLD_HOURS*4});
      if(!tr) continue;
      Object.assign(tr,{symbol:ticker.symbol,signalTime,signalEntry:s.entry,volume15mRatio:volRatio,sourceHourTime:h1[h1Index].time});
      fast.push(tr); nextFastTime=tr.exitTime;
    }
    symbolReports.push({symbol:ticker.symbol,candles15m:m15.length,candles1h:h1.length,candles4h:h4.length,
      baselineTrades:baseline.filter(x=>x.symbol===ticker.symbol).length,fastTrades:fast.filter(x=>x.symbol===ticker.symbol).length});
  }

  baseline.sort((a,b)=>a.entryTime-b.entryTime); fast.sort((a,b)=>a.entryTime-b.entryTime);
  const report={generatedAt:new Date().toISOString(),venue:"Kraken Derivatives public historical candles",
    period:{from:new Date(start).toISOString(),to:new Date(end).toISOString(),days:DAYS},
    settings:{symbols:universe.map(x=>x.symbol),feePerSidePct:FEE*100,slippagePerSidePct:SLIPPAGE*100,maxHoldHours:MAX_HOLD_HOURS,
      baselineEntry:"next 1h candle open plus adverse slippage",
      fastEntry:"15m breakout/retest confirmation + 15m volume >= 1.0x; fill at next 15m open plus adverse slippage",
      fastDirection:"last closed 1h engine signal; existing 4h non-opposition/score context retained, strict 4h agreement not required",
      exits:"For both paths, stop and all three target price levels are copied unchanged from analyzeFuturesSymbol; same weights and stop-first simulator",
      funding:"historical funding excluded"},
    baseline:{metrics:summarize(baseline),trades:baseline},
    fast15m:{metrics:summarize(fast),timing:timing(baseline,fast),trades:fast},
    symbols:symbolReports};
  await mkdir("artifacts",{recursive:true});
  await writeFile("artifacts/kraken-fast-15m-entry.json",JSON.stringify(report,null,2));
  const rows=[
    "# Kraken Futures — Faster 15m Entry Experiment","",
    "Period: "+report.period.from+" to "+report.period.to+" ("+DAYS+" days)",
    "Symbols: "+universe.map(x=>x.symbol).join(", "),
    "Costs: "+(FEE*100).toFixed(3)+"% fee + "+(SLIPPAGE*100).toFixed(3)+"% slippage per side.","",
    "| Variant | Trades | Win rate | Net R | Expectancy | Profit factor | Max DD |",
    "|---|---:|---:|---:|---:|---:|---:|",
    ...[["Current 1h/4h baseline",report.baseline.metrics],["Fast 15m entry",report.fast15m.metrics]].map(([n,m])=>"| "+n+" | "+m.trades+" | "+m.winRatePct.toFixed(2)+"% | "+m.netR.toFixed(2)+" | "+m.expectancyR.toFixed(3)+" | "+(m.profitFactor===null?"n/a":m.profitFactor.toFixed(2))+" | "+m.maxDrawdownR.toFixed(2)+" |"),
    "",
    "Fast path timing vs baseline (nearest same-symbol/same-side match within 24h): "+JSON.stringify(report.fast15m.timing),
    "",
    "Important: historical simulation only; 15m entry uses next-bar open and adverse slippage. Existing production stop/target price levels and weights are reused unchanged. Historical funding is excluded."
  ];
  await writeFile("artifacts/kraken-fast-15m-entry.md",rows.join("\n"));
  console.log(JSON.stringify({ok:true,period:report.period,baseline:report.baseline.metrics,fast15m:report.fast15m.metrics,timing:report.fast15m.timing,symbols:symbolReports,
    artifacts:["artifacts/kraken-fast-15m-entry.json","artifacts/kraken-fast-15m-entry.md"]},null,2));
}
main().catch(e=>{console.error(e);process.exitCode=1;});

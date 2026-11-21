import { mkdir, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { analyzeFuturesSymbol, FUTURES_CONFIG } from "../src/index.js";

const API = "https://futures.kraken.com/api/charts/v1";
const FUTURES_API = "https://futures.kraken.com/derivatives/api/v3";
const MS = { "15m": 900000, "1h": 3600000, "4h": 14400000, "1d": 86400000 };
const DAYS = 60, LEVERAGE = 10, FEE = 0.0005, SLIPPAGE = 0.0003, MAX_HOLD = 72;
const SYMBOLS = ["PF_XBTUSD","PF_ETHUSD","PF_SOLUSD","PF_XRPUSD","PF_ADAUSD","PF_LINKUSD","PF_AVAXUSD","PF_DOTUSD"];
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getJson(url) {
  for (let attempt=0; attempt<5; attempt++) {
    try {
      const res = await fetch(url,{headers:{accept:"application/json"},signal:AbortSignal.timeout(30000)});
      const body = await res.text();
      if (!res.ok) throw new Error("Kraken HTTP "+res.status+": "+body.slice(0,180));
      const json=JSON.parse(body);
      if (json.result==="error") throw new Error("Kraken API: "+JSON.stringify(json.error));
      return json;
    } catch(e) {
      if(attempt===4) throw e;
      await sleep(500*(attempt+1));
    }
  }
}
async function candles(symbol,resolution,from,to) {
  const interval=MS[resolution], chunk=interval*4000, all=[];
  for(let s=from;s<to;s+=chunk) {
    const url=new URL(API+"/trade/"+encodeURIComponent(symbol)+"/"+resolution);
    url.searchParams.set("from",String(Math.floor(s/1000)));
    url.searchParams.set("to",String(Math.floor(Math.min(to,s+chunk)/1000)));
    const data=await getJson(url);
    if(!Array.isArray(data.candles)) throw new Error("Missing candles "+symbol+" "+resolution);
    for(const x of data.candles) {
      const c={time:Number(x.time),open:Number(x.open),high:Number(x.high),low:Number(x.low),close:Number(x.close),volume:Number(x.volume)};
      if(Number.isFinite(c.time)&&[c.open,c.high,c.low,c.close,c.volume].every(Number.isFinite)&&c.open>0&&c.low>0&&c.high>=Math.max(c.open,c.close,c.low)&&c.volume>=0&&c.time+interval<=to) all.push(c);
    }
    await sleep(120);
  }
  return [...new Map(all.map(c=>[c.time,c])).values()].sort((a,b)=>a.time-b.time);
}
function selectBearishWindow(daily) {
  const close=daily.map(c=>c.close), ema=Array(close.length).fill(null), a=2/51;
  if(close.length<100) throw new Error("Insufficient BTC daily candles to select regime");
  let e=close.slice(0,50).reduce((s,v)=>s+v,0)/50;
  for(let i=49;i<close.length;i++){ if(i>49)e=close[i]*a+e*(1-a); ema[i]=e; }
  for(let end=daily.length-1;end>=DAYS+10;end--) {
    const start=end-DAYS+1; let ok=true;
    for(let i=start;i<=end;i++) if(!(close[i]<ema[i]&&ema[i]<ema[i-10])) {ok=false;break;}
    if(ok) return {startMs:daily[start].time,endMs:daily[end].time+MS["1d"],days:DAYS,
      btcCloseBelowEma50Pct:100,btcEma50FallingPct:100,startClose:close[start],endClose:close[end],
      startEma50:ema[start],endEma50:ema[end]};
  }
  throw new Error("No full 60-day BTC bearish regime found in retrieved daily history; no non-bearish period substituted");
}
function closedCount(cs,interval,cutoff) {
  let lo=0,hi=cs.length; while(lo<hi){const m=(lo+hi)>>1;if(cs[m].time+interval<=cutoff)lo=m+1;else hi=m;} return lo;
}
function summarize(trades) {
  const wins=trades.filter(t=>t.netR>0),losses=trades.filter(t=>t.netR<0);
  const gp=wins.reduce((s,t)=>s+t.netR,0),gl=Math.abs(losses.reduce((s,t)=>s+t.netR,0));
  let eq=0,peak=0,dd=0;
  for(const t of [...trades].sort((a,b)=>a.entryTime-b.entryTime)){eq+=t.netR;peak=Math.max(peak,eq);dd=Math.max(dd,peak-eq);}
  return {trades:trades.length,wins:wins.length,losses:losses.length,winRatePct:trades.length?100*wins.length/trades.length:0,
    stopFirst:trades.filter(t=>t.exitReason==="STOP").length,tp1Hits:trades.filter(t=>t.targetHits>=1).length,
    tp2Hits:trades.filter(t=>t.targetHits>=2).length,tp3Hits:trades.filter(t=>t.targetHits>=3).length,
    netR:trades.reduce((s,t)=>s+t.netR,0),expectancyR:trades.length?trades.reduce((s,t)=>s+t.netR,0)/trades.length:0,
    profitFactor:gl?gp/gl:gp?null:0,maxDrawdownR:dd,
    netMarginRoiPct:trades.reduce((s,t)=>s+t.netMarginRoiPct,0)};
}
function simulateShort({entry,stop,targets,bars,startIndex}) {
  const risk=stop-entry;
  if(!(risk>0)) throw new Error("Invalid SHORT stop distance");
  let remaining=1,netR=0,netMarginRoiPct=0,hits=0,exitReason="TIME_EXIT",exitTime=bars[Math.min(bars.length-1,startIndex+MAX_HOLD)]?.time;
  const end=Math.min(bars.length-1,startIndex+MAX_HOLD);
  const closePart=(raw,weight)=>{
    const fill=raw*(1+SLIPPAGE), grossR=(entry-fill)/risk, feeR=FEE*(entry+fill)/risk;
    netR+=weight*(grossR-feeR);
    netMarginRoiPct+=weight*((entry-fill)/entry*LEVERAGE*100 - FEE*(entry+fill)/entry*LEVERAGE*100);
  };
  for(let i=startIndex;i<=end&&remaining>1e-9;i++) {
    const b=bars[i],gap=b.open>=stop,stopHit=b.high>=stop;
    if(gap||stopHit){closePart(gap?b.open:stop,remaining);remaining=0;exitReason="STOP";exitTime=b.time;break;}
    for(let t=0;t<3&&remaining>1e-9;t++) {
      if(targets[t]==null)continue;
      if(b.low<=targets[t]) {
        const w=Math.min([0.4,0.35,0.25][t],remaining); closePart(targets[t],w);
        remaining-=w;targets[t]=null;hits++;
      } else break;
    }
    if(remaining<=1e-9){remaining=0;exitReason="TARGETS";exitTime=b.time;break;}
    if(i===end){closePart(b.close,remaining);remaining=0;exitReason="TIME_EXIT";exitTime=b.time;}
  }
  if(remaining>1e-9){closePart(bars[end].close,remaining);remaining=0;exitReason="TIME_EXIT";exitTime=bars[end].time;}
  return {netR,netMarginRoiPct,targetHits:hits,exitReason,exitTime};
}
async function backtestSymbol(symbol,window,ticker) {
  const warm=window.startMs-120*MS["1d"];
  const [h1,h4,m15]=await Promise.all([
    candles(symbol,"1h",warm,window.endMs),candles(symbol,"4h",warm,window.endMs),candles(symbol,"15m",warm,window.endMs)
  ]);
  if(h1.length<100||h4.length<FUTURES_CONFIG.MIN_CANDLES||m15.length<120)
    throw new Error("Insufficient data h1="+h1.length+" h4="+h4.length+" m15="+m15.length);
  let lockUntil=0,signals=0; const trades=[];
  for(let i=60;i<h1.length-1;i++) {
    const bar=h1[i],signalTime=bar.time+MS["1h"];
    if(signalTime<window.startMs||signalTime>=window.endMs||signalTime<lockUntil)continue;
    const n4=closedCount(h4,MS["4h"],signalTime),n15=closedCount(m15,MS["15m"],signalTime);
    if(n4<FUTURES_CONFIG.MIN_CANDLES||n15<40)continue;
    const next=h1[i+1],tickerAtSignal={...ticker,symbol,last:next.open,quoteVolume:Number(ticker.volumeQuote)||0};
    const candidate=analyzeFuturesSymbol(tickerAtSignal,h1.slice(0,i+1),h4.slice(0,n4),m15.slice(Math.max(0,n15-120),n15));
    if(!candidate||candidate.side!=="SHORT"||candidate.eligible!==true)continue;
    signals++;
    const entry=next.open*(1-SLIPPAGE);
    const bars=h1.slice(i+1,Math.min(h1.length,i+1+MAX_HOLD+1));
    const result=simulateShort({entry,stop:candidate.stop,targets:[candidate.target1,candidate.target2,candidate.target3],bars,startIndex:0});
    trades.push({symbol,side:"SHORT",signalTime,entryTime:next.time,entry,stop:candidate.stop,score:candidate.score,...result});
    const exitIndex=h1.findIndex(c=>c.time===result.exitTime);
    lockUntil=exitIndex>=0?h1[exitIndex].time+MS["1h"]:window.endMs;
  }
  return {symbol,candles:{h1:h1.length,h4:h4.length,m15:m15.length},signals,metrics:summarize(trades),trades};
}
async function main() {
  const now=Date.now(),daily=await candles("PF_XBTUSD","1d",now-800*MS["1d"],now);
  const window=selectBearishWindow(daily);
  console.log("BTC bearish 60d window: "+new Date(window.startMs).toISOString()+" -> "+new Date(window.endMs).toISOString());
  const payload=await getJson(FUTURES_API+"/tickers");
  const map=new Map((payload.tickers||[]).map(t=>[String(t.symbol||"").toUpperCase(),t]));
  const selected=SYMBOLS.map(s=>map.get(s)).filter(t=>t&&t.tag==="perpetual"&&!t.suspended&&Number(t.volumeQuote)>=FUTURES_CONFIG.MIN_QUOTE_VOLUME);
  const results=[];
  for(const t of selected) {
    try { console.log("Testing "+t.symbol); results.push(await backtestSymbol(t.symbol,window,t)); }
    catch(e) { results.push({symbol:t.symbol,error:String(e.message||e)}); }
  }
  const good=results.filter(r=>!r.error),trades=good.flatMap(r=>r.trades).sort((a,b)=>a.entryTime-b.entryTime);
  const report={generatedAt:new Date().toISOString(),venue:"Kraken Futures public OHLC only",
    direction:"SHORT only",marketRegime:{benchmark:"PF_XBTUSD daily",definition:"Every daily close below EMA50 and EMA50 below its value 10 days earlier",...window,
      from:new Date(window.startMs).toISOString(),to:new Date(window.endMs).toISOString()},
    symbolsRequested:SYMBOLS,symbolsTested:good.map(r=>r.symbol),symbolErrors:results.filter(r=>r.error),
    settings:{engine:"C - current production analyzer imported unchanged; test runner only",leverage:LEVERAGE,feePerSidePct:FEE*100,
      slippagePerSidePct:SLIPPAGE*100,maxHoldHours:MAX_HOLD,targetWeightsPct:[40,35,25],
      sameCandleRule:"stop first",funding:"excluded",entry:"next 1h open adverse slippage"},
    aggregate:summarize(trades),bySymbol:good.map(r=>({symbol:r.symbol,candles:r.candles,signals:r.signals,metrics:r.metrics})),trades};
  await mkdir("artifacts",{recursive:true});
  await writeFile("artifacts/kraken-bearish-short-current-engine.json",JSON.stringify(report,null,2));
  const m=report.aggregate;
  const md=["# Kraken bearish-regime SHORT — current engine","",
    "Period: "+report.marketRegime.from+" to "+report.marketRegime.to+" (60 days)",
    "Symbols tested: "+good.length+"/"+selected.length,"",
    "| Metric | Result |","|---|---:|",
    "| Signals / trades | "+m.trades+" |","| Wins | "+m.wins+" |","| Stop-first | "+m.stopFirst+" |",
    "| Win rate | "+m.winRatePct.toFixed(2)+"% |","| Net R | "+m.netR.toFixed(2)+"R |",
    "| Expectancy | "+m.expectancyR.toFixed(3)+"R |","| Profit factor | "+m.profitFactor+" |",
    "| Max drawdown | "+m.maxDrawdownR.toFixed(2)+"R |","| Net margin ROI points | "+m.netMarginRoiPct.toFixed(2)+"% |","",
    "| Symbol | Signals | Trades | Wins | Stops | Win rate | Net R |","|---|---:|---:|---:|---:|---:|---:|",
    ...good.map(r=>"| "+r.symbol+" | "+r.signals+" | "+r.metrics.trades+" | "+r.metrics.wins+" | "+r.metrics.stopFirst+" | "+r.metrics.winRatePct.toFixed(2)+"% | "+r.metrics.netR.toFixed(2)+"R |"),
    "","Limitations: no funding; current active-symbol universe; fixed 10x; one trade at a time per symbol; 1h OHLC with stop-first ambiguity."
  ];
  await writeFile("artifacts/kraken-bearish-short-current-engine.md",md.join("\n"));
  console.log(JSON.stringify({period:report.marketRegime,aggregate:report.aggregate,bySymbol:report.bySymbol,errors:report.symbolErrors},null,2));
  if(!good.length)process.exitCode=1;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(e=>{console.error(e);process.exitCode=1;});

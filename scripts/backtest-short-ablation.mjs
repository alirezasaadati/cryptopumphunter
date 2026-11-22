import { mkdir, writeFile } from "node:fs/promises";

const API = "https://futures.kraken.com";
const HOUR = 3600000;
const DAY = 86400000;
const DAYS = [90, 180];
const SYMBOL_LIMIT = 7;
const FEE = 0.0005;
const SLIPPAGE = 0.0003;
const TARGET_R = 1.5;
const STOP_BUFFER_ATR = 0.2;
const MIN_RISK_PCT = 0.5;
const MAX_RISK_PCT = 2.0;
const MAX_ATR_PCT = 2.0;
const MIN_QUOTE_VOLUME = 5_000_000;
const WARMUP_HOURS = 120;

const TREND = ["closeBelowEma50","ema20BelowEma50","rsiBelow45","atLeastHalfPercentBelowEma20"];
const RALLY = ["closeAboveEma50","rsiAbove75","redCandle","currentHighAbovePreviousHigh","bodyExceedsHalfCandleRange"];
const SCENARIOS = [
  {id:"strict",label:"Current strict rules",engine:"BOTH",omit:null},
  ...TREND.map(id=>({id:"trend_without_"+id,label:"TREND_SHORT: remove "+id,engine:"TREND_SHORT",omit:id})),
  ...RALLY.map(id=>({id:"rally_without_"+id,label:"RALLY_FADE: remove "+id,engine:"RALLY_FADE",omit:id}))
];

async function getJson(url) {
  let last;
  for (let attempt=0;attempt<4;attempt++) {
    try {
      const res=await fetch(url,{headers:{accept:"application/json"},signal:AbortSignal.timeout(30000)});
      const body=await res.text();
      if (!res.ok) throw new Error("HTTP "+res.status+" "+body.slice(0,120));
      const data=JSON.parse(body);
      if (data?.result==="error" || data?.error) throw new Error(JSON.stringify(data.errors||data.error));
      return data;
    } catch(e) {
      last=e;
      if(attempt<3) await new Promise(r=>setTimeout(r,500*(attempt+1)));
    }
  }
  throw last;
}
function normalize(rows) {
  const map=new Map();
  for(const x of rows||[]) {
    const time=Number(x.time)<1e12?Number(x.time)*1000:Number(x.time);
    const c={time,open:Number(x.open),high:Number(x.high),low:Number(x.low),close:Number(x.close),volume:Number(x.volume)};
    if(Number.isFinite(time)&&[c.open,c.high,c.low,c.close,c.volume].every(Number.isFinite)&&c.open>0&&c.low>0&&c.close>0&&c.high>=Math.max(c.open,c.close,c.low)&&c.low<=Math.min(c.open,c.close)) map.set(time,c);
  }
  return [...map.values()].sort((a,b)=>a.time-b.time).filter(c=>c.time+HOUR<=Date.now());
}
async function candlesFor(symbol,from,to) {
  const out=[];
  const chunk=1500*HOUR;
  for(let start=from;start<to;start+=chunk) {
    const end=Math.min(to,start+chunk);
    const u=new URL(API+"/api/charts/v1/trade/"+encodeURIComponent(symbol)+"/1h");
    u.searchParams.set("from",String(Math.floor(start/1000)));
    u.searchParams.set("to",String(Math.floor(end/1000)));
    u.searchParams.set("count","1600");
    const data=await getJson(u.toString());
    if(!Array.isArray(data.candles)) throw new Error("Candles missing for "+symbol);
    out.push(...data.candles);
    await new Promise(r=>setTimeout(r,120));
  }
  return normalize(out);
}
function ema(values,n) {
  if(values.length<n)return NaN;
  const k=2/(n+1);let v=values.slice(0,n).reduce((a,b)=>a+b,0)/n;
  for(let i=n;i<values.length;i++)v=values[i]*k+v*(1-k);
  return v;
}
function rsi(values,n=14) {
  if(values.length<=n)return NaN;
  let g=0,l=0;
  for(let i=1;i<=n;i++){const d=values[i]-values[i-1];g+=Math.max(d,0);l+=Math.max(-d,0);}
  let ag=g/n,al=l/n;
  for(let i=n+1;i<values.length;i++){const d=values[i]-values[i-1];ag=(ag*(n-1)+Math.max(d,0))/n;al=(al*(n-1)+Math.max(-d,0))/n;}
  if(ag===0&&al===0)return 50;if(al===0)return 100;if(ag===0)return 0;
  return 100-100/(1+ag/al);
}
function atr(candles,n=14) {
  const a=[];
  for(let i=1;i<candles.length;i++){const c=candles[i],p=candles[i-1].close;a.push(Math.max(c.high-c.low,Math.abs(c.high-p),Math.abs(c.low-p)));}
  return a.length>=n?a.slice(-n).reduce((x,y)=>x+y,0)/n:NaN;
}
function candidateAt(candles,i,engine,omit) {
  const hist=candles.slice(0,i+1),last=hist.at(-1),prev=hist.at(-2),closes=hist.map(c=>c.close);
  const e20=ema(closes,20),e50=ema(closes,50),rv=rsi(closes),av=atr(hist);
  if(![e20,e50,rv,av].every(Number.isFinite)||av<=0)return null;
  const atrPct=av/last.close*100;if(atrPct>MAX_ATR_PCT)return null;
  const d=((last.close-e20)/e20)*100;
  const t={closeBelowEma50:last.close<e50,ema20BelowEma50:e20<e50,rsiBelow45:rv<45,atLeastHalfPercentBelowEma20:d<-.5};
  const range=last.high-last.low,body=last.open-last.close;
  const r={closeAboveEma50:last.close>e50,rsiAbove75:rv>75,redCandle:last.close<last.open,currentHighAbovePreviousHigh:last.high>prev.high,bodyExceedsHalfCandleRange:range>0&&body/range>.5};
  const pass=(obj,keys)=>keys.filter(k=>k!==omit).every(k=>obj[k]);
  let side=null,stop=null;
  if((engine==="BOTH"||engine==="TREND_SHORT")&&pass(t,TREND)){side="TREND_SHORT";stop=Math.max(...hist.slice(-7).map(c=>c.high))+av*STOP_BUFFER_ATR;}
  else if((engine==="BOTH"||engine==="RALLY_FADE")&&pass(r,RALLY)){side="RALLY_FADE";stop=last.high+av*STOP_BUFFER_ATR;}
  if(!side)return null;
  const entry=candles[i+1]?.open;
  if(!Number.isFinite(entry)||entry<=0||!Number.isFinite(stop)||stop<=entry)return null;
  const risk=stop-entry,riskPct=risk/entry*100;
  if(riskPct<MIN_RISK_PCT||riskPct>MAX_RISK_PCT)return null;
  return {side,entry,stop,risk,target:entry-risk*TARGET_R,signalTime:last.time,atrPct,rsi:rv,distanceEma20Pct:d};
}
function simulate(candles,startIndex,c) {
  const entry=c.entry*(1+SLIPPAGE),stop=c.stop,target=c.target;
  const risk=stop-entry;
  const maxIndex=Math.min(candles.length-1,startIndex+72);
  let exit= candles[maxIndex].close,reason="TIME",exitTime=candles[maxIndex].time;
  for(let j=startIndex;j<=maxIndex;j++){
    const b=candles[j];
    if(b.open>=stop||b.high>=stop){exit=b.open>=stop?b.open:stop;reason="STOP";exitTime=b.time;break;}
    if(b.low<=target){exit=target;reason="TARGET";exitTime=b.time;break;}
  }
  const fill=exit*(1+SLIPPAGE);
  const gross=(entry-fill)/risk;
  const fee=FEE*(entry+fill)/risk;
  return {symbol:c.symbol,engine:c.side,entryTime:candles[startIndex].time,exitTime,reason,netR:gross-fee};
}
function metrics(trades) {
  const wins=trades.filter(t=>t.netR>0),loss=trades.filter(t=>t.netR<0);
  const gw=wins.reduce((s,t)=>s+t.netR,0),gl=Math.abs(loss.reduce((s,t)=>s+t.netR,0));
  let eq=0,peak=0,dd=0;
  for(const t of [...trades].sort((a,b)=>a.exitTime-b.exitTime)){eq+=t.netR;peak=Math.max(peak,eq);dd=Math.max(dd,peak-eq);}
  return {trades:trades.length,wins:wins.length,losses:loss.length,winRatePct:trades.length?wins.length/trades.length*100:0,netR:trades.reduce((s,t)=>s+t.netR,0),expectancyR:trades.length?trades.reduce((s,t)=>s+t.netR,0)/trades.length:0,profitFactor:gl?gw/gl:gw?null:0,maxDrawdownR:dd,stops:trades.filter(t=>t.reason==="STOP").length,targets:trades.filter(t=>t.reason==="TARGET").length};
}
function runScenario(data,from,scenario) {
  const trades=[],byEngine={TREND_SHORT:[],RALLY_FADE:[]};
  for(const {symbol,candles} of data) {
    let lockedUntil=0;
    for(let i=119;i<candles.length-1;i++){
      const signalClose=candles[i].time+HOUR;
      if(signalClose<from||signalClose<=lockedUntil)continue;
      const c=candidateAt(candles,i,scenario.engine,scenario.omit);
      if(!c)continue;
      c.symbol=symbol;
      const trade=simulate(candles,i+1,c);
      trades.push(trade);byEngine[c.side].push(trade);lockedUntil=trade.exitTime+HOUR;
    }
  }
  return {id:scenario.id,label:scenario.label,engine:scenario.engine,omittedCondition:scenario.omit,metrics:metrics(trades),trendShort:metrics(byEngine.TREND_SHORT),rallyFade:metrics(byEngine.RALLY_FADE)};
}
async function main(){
  const now=Date.now(),from180=now-180*DAY,fromFetch=from180-WARMUP_HOURS*HOUR;
  const tickerData=await getJson(API+"/derivatives/api/v3/tickers");
  const universe=(tickerData.tickers||[]).filter(t=>t.tag==="perpetual"&&t.suspended!==true&&/^(PI|PF)_[A-Z0-9]+USD$/.test(String(t.symbol||""))&&Number(t.volumeQuote)>=MIN_QUOTE_VOLUME&&Number(t.last)>0).sort((a,b)=>Number(b.volumeQuote)-Number(a.volumeQuote)).slice(0,SYMBOL_LIMIT);
  const data=[],errors=[];
  for(const t of universe){try{const c=await candlesFor(t.symbol,fromFetch,now);if(c.length<180*24+100)throw new Error("Insufficient history: "+c.length+" candles");data.push({symbol:t.symbol,candles:c});}catch(e){errors.push({symbol:t.symbol,error:String(e.message||e)});}}
  if(!data.length)throw new Error("No symbols had sufficient historical data: "+JSON.stringify(errors));
  const reports=[];
  for(const days of DAYS){const from=now-days*DAY;reports.push({days,from:new Date(from).toISOString(),to:new Date(now).toISOString(),scenarios:SCENARIOS.map(s=>runScenario(data,from,s))});}
  const report={generatedAt:new Date().toISOString(),venue:"Kraken Futures public 1h OHLC",universe:data.map(x=>({symbol:x.symbol,candles:x.candles.length,from:new Date(x.candles[0].time).toISOString(),to:new Date(x.candles.at(-1).time).toISOString()})),errors,assumptions:{symbols:SYMBOL_LIMIT,feePerSidePct:FEE*100,slippagePerSidePct:SLIPPAGE*100,target:TARGET_R+"R",stopBufferATR:STOP_BUFFER_ATR,minStopPct:MIN_RISK_PCT,maxStopPct:MAX_RISK_PCT,maxATRpct:MAX_ATR_PCT,maxHoldHours:72,entry:"next 1h candle open",sameCandleStopAndTarget:"stop first",funding:"excluded",universeBias:"current top-volume Kraken perpetuals; survivorship bias applies",ablation:"remove exactly one condition at a time; all other engine rules and risk checks remain unchanged"},periods:reports};
  await mkdir("artifacts",{recursive:true});
  await writeFile("artifacts/short-engine-ablation-90-180d.json",JSON.stringify(report,null,2));
  const md=["# SHORT engine condition ablation backtest","","Generated: "+report.generatedAt,"Symbols: "+data.map(x=>x.symbol).join(", "),"Assumptions: "+JSON.stringify(report.assumptions),"","Only one condition is removed per scenario. The strict row is the current strategy baseline.",""];
  for(const p of reports){md.push("## "+p.days+" days","","| Scenario | Engine | Trades | Win % | Net R | Expectancy R | PF | Max DD R | Stops | Targets |","|---|---|---:|---:|---:|---:|---:|---:|---:|---:|");for(const s of p.scenarios){const m=s.metrics;md.push("| "+s.label+" | "+s.engine+" | "+m.trades+" | "+m.winRatePct.toFixed(1)+" | "+m.netR.toFixed(2)+" | "+m.expectancyR.toFixed(3)+" | "+(m.profitFactor===null?"∞":m.profitFactor.toFixed(2))+" | "+m.maxDrawdownR.toFixed(2)+" | "+m.stops+" | "+m.targets+" |");}md.push("");}
  md.push("## Data quality","","| Symbol | Candles | First | Last |","|---|---:|---|---|");for(const x of report.universe)md.push("| "+x.symbol+" | "+x.candles+" | "+x.from+" | "+x.to+" |");md.push("","## Errors","",...errors.map(x=>"- "+x.symbol+": "+x.error),"","Limitations: current top-volume universe introduces survivorship bias; historical funding is excluded; OHLC cannot reveal intrabar path, so stop wins ambiguous same-candle cases; slippage and fees are fixed assumptions. Results are a comparative simulation, not a promise of live performance.");
  await writeFile("artifacts/short-engine-ablation-90-180d.md",md.join("\n"));
  console.log(JSON.stringify({ok:true,generatedAt:report.generatedAt,universe:report.universe,errors:report.errors,periods:reports.map(p=>({days:p.days,scenarios:p.scenarios.map(s=>({id:s.id,metrics:s.metrics,trendShort:s.trendShort,rallyFade:s.rallyFade}))}))},null,2));
}
main().catch(e=>{console.error(e);process.exitCode=1;});

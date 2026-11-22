import { mkdir, writeFile } from "node:fs/promises";

const BASE = "https://futures.kraken.com";
const HOUR = 3600000;
const DAY = 86400000;
const DAYS = 365;
const SYMBOL_LIMIT = Number(process.env.BT_SYMBOLS || 30);
const CONCURRENCY = 3;
const TARGET_R = 1.5;
const STOP_BUFFER_ATR = 0.2;
const MAX_RISK_PCT = 2.0;
const MAX_ATR_PCT = 2.5;
const COOLDOWN_HOURS = 4;
const MAX_TRADES_PER_DAY = 2;

function ema(values, period) {
  if (values.length < period) return null;
  const multiplier = 2 / (period + 1);
  let value = values.slice(0, period).reduce((a,b)=>a+b,0)/period;
  for (let i=period;i<values.length;i++) value=values[i]*multiplier+value*(1-multiplier);
  return value;
}
function rsi(values, period=14) {
  if (values.length<=period) return null;
  let gains=0,losses=0;
  for(let i=1;i<=period;i++){const d=values[i]-values[i-1];gains+=Math.max(d,0);losses+=Math.max(-d,0);}
  let avgGain=gains/period,avgLoss=losses/period;
  for(let i=period+1;i<values.length;i++){const d=values[i]-values[i-1];avgGain=(avgGain*(period-1)+Math.max(d,0))/period;avgLoss=(avgLoss*(period-1)+Math.max(-d,0))/period;}
  if(avgLoss===0)return 100;if(avgGain===0)return 0;
  return 100-100/(1+avgGain/avgLoss);
}
function average(values){return values.length?values.reduce((a,b)=>a+b,0)/values.length:0;}
function calculateAtr(candles,period=14){
  if(candles.length<=period)return null;
  const ranges=[];
  for(let i=1;i<candles.length;i++){const c=candles[i],p=candles[i-1].close;ranges.push(Math.max(c.high-c.low,Math.abs(c.high-p),Math.abs(c.low-p)));}
  return average(ranges.slice(-period));
}
async function getJson(url,attempt=0){
  const res=await fetch(url,{headers:{accept:"application/json"},signal:AbortSignal.timeout(30000)});
  const body=await res.text();
  if(!res.ok){if(attempt<5&&(res.status===429||res.status>=500)){await new Promise(r=>setTimeout(r,1000*(attempt+1)));return getJson(url,attempt+1);}throw new Error("HTTP "+res.status+" "+url+" "+body.slice(0,160));}
  let data;try{data=JSON.parse(body);}catch{throw new Error("Invalid JSON "+url);}
  if(data?.result==="error"||(Array.isArray(data?.errors)&&data.errors.length))throw new Error("Kraken API error "+JSON.stringify(data.errors||data.error));
  return data;
}
function normalize(rows,intervalMs){
  if(!Array.isArray(rows))throw new Error("Kraken candles array missing");
  const seen=new Set();
  return rows.map(r=>({time:Number(r.time)<1e12?Number(r.time)*1000:Number(r.time),open:Number(r.open),high:Number(r.high),low:Number(r.low),close:Number(r.close),volume:Number(r.volume)}))
    .filter(c=>Number.isFinite(c.time)&&[c.open,c.high,c.low,c.close,c.volume].every(Number.isFinite)&&c.open>0&&c.low>0&&c.close>0&&c.high>=c.low&&c.time+intervalMs<=Date.now())
    .sort((a,b)=>a.time-b.time).filter(c=>{if(seen.has(c.time))return false;seen.add(c.time);return true;});
}
async function fetchCandles(symbol,resolution,fromMs,toMs,intervalMs){
  const chunkMs=intervalMs*1500,all=[];
  for(let start=fromMs;start<toMs;start+=chunkMs){
    const end=Math.min(toMs,start+chunkMs);
    const u=new URL(BASE+"/api/charts/v1/trade/"+encodeURIComponent(symbol)+"/"+resolution);
    u.searchParams.set("from",String(Math.floor(start/1000)));
    u.searchParams.set("to",String(Math.floor(end/1000)));
    u.searchParams.set("count","1600");
    const d=await getJson(u);
    if(d.more_candles===true)throw new Error(symbol+" "+resolution+" chunk incomplete (more_candles)");
    all.push(...normalize(d.candles,intervalMs));
    await new Promise(r=>setTimeout(r,80));
  }
  const map=new Map(all.map(c=>[c.time,c]));
  return [...map.values()].sort((a,b)=>a.time-b.time);
}
async function mapLimit(items,limit,fn){
  const out=new Array(items.length);let next=0;
  await Promise.all(Array.from({length:Math.min(limit,items.length)},async()=>{while(true){const i=next++;if(i>=items.length)return;try{out[i]=await fn(items[i],i);}catch(e){out[i]={symbol:items[i].symbol,error:String(e?.message||e)};}}}));
  return out;
}
function analyze(candles,entry){
  if(candles.length<100)return null;
  const last=candles.at(-1),prev=candles.at(-2),closes=candles.map(c=>c.close);
  const e20=ema(closes,20),e50=ema(closes,50),rv=rsi(closes,14),atr=calculateAtr(candles,14);
  if(!e20||!e50||!rv||!atr)return null;
  const atrPct=atr/last.close*100;if(atrPct>MAX_ATR_PCT)return null;
  let mode=null,stop=null;
  const down=last.close<e50&&e20<e50&&rv<50;
  if(down){mode="TREND_SHORT";stop=Math.max(...candles.slice(-7).map(c=>c.high))+atr*STOP_BUFFER_ATR;}
  else if(last.close>e50&&rv>70&&last.close<last.open&&last.high>prev.high){mode="RALLY_FADE";stop=last.high+atr*STOP_BUFFER_ATR;}
  if(!mode)return null;
  const risk=stop-entry,riskPct=risk/entry*100;
  if(risk<=0||riskPct>MAX_RISK_PCT)return null;
  return {mode,entry,stop,target:entry-risk*TARGET_R,risk,riskPct};
}
function simulateShort(candles,startIndex,trade){
  for(let i=startIndex;i<candles.length;i++){
    const c=candles[i];
    const stopGap=c.open>=trade.stop;
    const stopHit=c.high>=trade.stop;
    const targetGap=c.open<=trade.target;
    const targetHit=c.low<=trade.target;
    if(stopGap||stopHit){
      const exit=stopGap?c.open:trade.stop;
      return {...trade,result:"STOP",exit,time:c.time,returnPct:(trade.entry-exit)/trade.entry*100,rMultiple:(trade.entry-exit)/trade.risk};
    }
    if(targetGap||targetHit){
      const exit=trade.target;
      return {...trade,result:"TP",exit,time:c.time,returnPct:(trade.entry-exit)/trade.entry*100,rMultiple:(trade.entry-exit)/trade.risk};
    }
  }
  return {...trade,result:"OPEN",exit:null,time:null,returnPct:null,rMultiple:null};
}
function dailyKey(ms){return new Date(ms).toISOString().slice(0,10);}
function regimeAt(time,bars){
  let lo=0,hi=bars.length;
  while(lo<hi){const m=(lo+hi)>>1;if(bars[m].time<=time)lo=m+1;else hi=m;}
  const i=lo-1;if(i<200)return "UNKNOWN";
  const close=bars[i].close,ema200=ema(bars.slice(0,i+1).map(x=>x.close),200);
  const old=bars[Math.max(0,i-30)];
  const ret=old?.close?((close/old.close)-1)*100:0;
  if(close>ema200&&ret>2)return "BULL";
  if(close<ema200&&ret< -2)return "BEAR";
  return "NEUTRAL";
}
function metrics(trades){
  const closed=trades.filter(t=>t.result==="TP"||t.result==="STOP");
  const wins=closed.filter(t=>t.result==="TP"),losses=closed.filter(t=>t.result==="STOP");
  const sumR=closed.reduce((s,t)=>s+t.rMultiple,0);
  return {signals:trades.length,closed:closed.length,tp:wins.length,stops:losses.length,open:trades.length-closed.length,
    winRatePct:closed.length?wins.length/closed.length*100:0,netR:sumR,avgR:closed.length?sumR/closed.length:0,
    rawPriceReturnPct:closed.reduce((s,t)=>s+(t.returnPct||0),0)};
}
async function backtestSymbol(ticker,fromMs,toMs,btcDaily){
  const candles=await fetchCandles(ticker.symbol,"1h",fromMs-100*HOUR,toMs,HOUR);
  if(candles.length<100)throw new Error("Only "+candles.length+" hourly candles");
  const lastSignalBySymbol={time:null,day:null,count:0};
  const trades=[],rejections={cooldown:0,dailyLimit:0,atr:0,setupOrRisk:0};
  for(let i=99;i<candles.length-1;i++){
    const signalCloseTime=candles[i].time+HOUR;
    if(signalCloseTime<fromMs||signalCloseTime>=toMs)continue;
    if(lastSignalBySymbol.time!==null&&(signalCloseTime-lastSignalBySymbol.time)/HOUR<COOLDOWN_HOURS){rejections.cooldown++;continue;}
    const day=dailyKey(signalCloseTime);
    if(lastSignalBySymbol.day!==day){lastSignalBySymbol.day=day;lastSignalBySymbol.count=0;}
    if(lastSignalBySymbol.count>=MAX_TRADES_PER_DAY){rejections.dailyLimit++;continue;}
    const entry=candles[i+1].open;
    const candidate=analyze(candles.slice(0,i+1),entry);
    if(!candidate){rejections.setupOrRisk++;continue;}
    lastSignalBySymbol.time=signalCloseTime;lastSignalBySymbol.day=day;lastSignalBySymbol.count++;
    const trade=simulateShort(candles,i+1,{symbol:ticker.symbol,mode:candidate.mode,signalTime:signalCloseTime,entryTime:candles[i+1].time,entry:candidate.entry,stop:candidate.stop,target:candidate.target,risk:candidate.risk,riskPct:candidate.riskPct});
    trade.regime=regimeAt(signalCloseTime,btcDaily);
    trades.push(trade);
  }
  return {symbol:ticker.symbol,candles:candles.length,metrics:metrics(trades),modes:{
    TREND_SHORT:metrics(trades.filter(t=>t.mode==="TREND_SHORT")),
    RALLY_FADE:metrics(trades.filter(t=>t.mode==="RALLY_FADE"))
  },rejections,trades};
}
async function main(){
  const toMs=Date.now(),fromMs=toMs-DAYS*DAY,warmup=fromMs-220*DAY;
  const tickerData=await getJson(BASE+"/derivatives/api/v3/tickers");
  if(!Array.isArray(tickerData?.tickers))throw new Error("Kraken tickers invalid");
  const universe=tickerData.tickers.filter(t=>t?.tag==="perpetual"&&t.suspended!==true&&/^(PI|PF)_[A-Z0-9]+USD$/.test(String(t.symbol||""))&&Number(t.last)>0)
    .sort((a,b)=>Number(b.volumeQuote||0)-Number(a.volumeQuote||0)).slice(0,SYMBOL_LIMIT);
  if(!universe.length)throw new Error("No Kraken perpetual symbols found");
  const btc=universe.find(t=>/^(PI|PF)_XBTUSD$/.test(t.symbol))||{symbol:"PI_XBTUSD"};
  const btcDaily=await fetchCandles(btc.symbol,"1d",warmup,toMs,DAY);
  const results=await mapLimit(universe,CONCURRENCY,t=>backtestSymbol(t,fromMs,toMs,btcDaily));
  const trades=results.flatMap(r=>r.trades||[]).sort((a,b)=>a.signalTime-b.signalTime);
  const group=(key)=>Object.fromEntries(["BULL","BEAR","NEUTRAL","UNKNOWN"].map(k=>[k,metrics(trades.filter(t=>t.regime===k))]));
  const summary={
    generatedAt:new Date().toISOString(),period:{from:new Date(fromMs).toISOString(),to:new Date(toMs).toISOString(),days:DAYS},
    venue:"Kraken Futures public OHLC historical candles",
    rules:{symbolsRequested:SYMBOL_LIMIT,symbolsSuccessfullyTested:results.filter(r=>!r.error).length,
      timeframe:"1h signal and 1h exit bars",entry:"next hourly candle open",side:"SHORT only",
      target:"1.5R",stop:"as returned by supplied v10.4 logic",sameCandle:"stop-first conservative",
      cooldownHours:COOLDOWN_HOURS,maxTradesPerUtcDay:MAX_TRADES_PER_DAY,atrMaxPct:MAX_ATR_PCT,maxRiskPct:MAX_RISK_PCT,
      regime:"BTC daily close vs EMA200 plus 30-day return: BULL if above and >+2%; BEAR if below and <-2%; otherwise NEUTRAL",
      fees:"excluded",funding:"excluded",slippage:"excluded",
      universe:"top current Kraken perpetual contracts by current quote volume; survivorship bias applies",
      executionNote:"The supplied code defines signal, stop and target but not a trade manager. Backtest exits at first 1h touch of stop or 1.5R target; stop wins if both touch in one candle."},
    overall:metrics(trades),byMode:{
      TREND_SHORT:metrics(trades.filter(t=>t.mode==="TREND_SHORT")),
      RALLY_FADE:metrics(trades.filter(t=>t.mode==="RALLY_FADE"))
    },byRegime:group("regime"),
    rejections:Object.fromEntries(["cooldown","dailyLimit","atr","setupOrRisk"].map(k=>[k,results.reduce((s,r)=>s+(r.rejections?.[k]||0),0)])),
    symbols:results.map(({trades,...r})=>r),symbolErrors:results.filter(r=>r.error).map(r=>({symbol:r.symbol,error:r.error})),trades
  };
  await mkdir("artifacts",{recursive:true});
  await writeFile("artifacts/v10-4-one-year.json",JSON.stringify(summary,null,2));
  const rows=["# CRYPTO PUMP HUNTER v10.4 — One-year backtest","",
    "Period: "+summary.period.from+" to "+summary.period.to+" ("+DAYS+" days)",
    "Symbols successfully tested: "+summary.rules.symbolsSuccessfullyTested+"/"+SYMBOL_LIMIT,"",
    "| Metric | Result |","|---|---:|",
    "| Signals/trades | "+summary.overall.signals+" |","| Closed | "+summary.overall.closed+" |",
    "| TP | "+summary.overall.tp+" |","| Stop | "+summary.overall.stops+" |","| Open at end | "+summary.overall.open+" |",
    "| Win rate | "+summary.overall.winRatePct.toFixed(2)+"% |","| Net result | "+summary.overall.netR.toFixed(2)+"R |",
    "| Expectancy | "+summary.overall.avgR.toFixed(3)+"R/trade |",
    "| Trend short signals | "+summary.byMode.TREND_SHORT.signals+" |","| Rally fade signals | "+summary.byMode.RALLY_FADE.signals+" |","",
    "## Market regime breakdown","",
    "| Regime | Trades | TP | Stops | Win rate | Net R |","|---|---:|---:|---:|---:|---:|",
    ...["BULL","BEAR","NEUTRAL","UNKNOWN"].map(k=>{const m=summary.byRegime[k];return "| "+k+" | "+m.signals+" | "+m.tp+" | "+m.stops+" | "+m.winRatePct.toFixed(2)+"% | "+m.netR.toFixed(2)+"R |";}),
    "","## Symbol detail","","| Symbol | Trades | TP | Stops | Win rate | Net R | Trend short | Rally fade |","|---|---:|---:|---:|---:|---:|---:|---:|",
    ...results.map(r=>{const m=r.metrics||metrics([]);return "| "+r.symbol+" | "+m.signals+" | "+m.tp+" | "+m.stops+" | "+m.winRatePct.toFixed(2)+"% | "+m.netR.toFixed(2)+"R | "+(r.modes?.TREND_SHORT?.signals||0)+" | "+(r.modes?.RALLY_FADE?.signals||0)+" |";}),
    "","## Method notes","",
    "Signals are evaluated only on completed 1h candles. Entry is the next 1h open. Historical cooldown and daily cap are applied chronologically per symbol using UTC calendar days. Target is 1.5R. If stop and target are both touched within the same hourly candle, stop is assumed first. Fees, funding and slippage are excluded. The supplied code does not include its trade-management/exit function; this report uses first-touch stop/target simulation.",
    "The tested universe is selected from currently listed perpetuals by current quote volume; delisted contracts and historical universe membership are not reconstructed, so survivorship bias applies.",
    "","Symbol errors:",...summary.symbolErrors.map(x=>"- "+x.symbol+": "+x.error)];
  await writeFile("artifacts/v10-4-one-year.md",rows.join("\n"));
  console.log(JSON.stringify({ok:summary.rules.symbolsSuccessfullyTested>0,period:summary.period,overall:summary.overall,byMode:summary.byMode,byRegime:summary.byRegime,rejections:summary.rejections,symbols:summary.symbols,symbolErrors:summary.symbolErrors},null,2));
  if(!summary.rules.symbolsSuccessfullyTested)process.exitCode=1;
}
main().catch(e=>{console.error(e);process.exitCode=1;});

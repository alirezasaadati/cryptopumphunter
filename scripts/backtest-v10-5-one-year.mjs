import fs from "node:fs/promises";

const CONFIG = {
  CHARTS_URL: "https://futures.kraken.com/api/charts/v1",
  SYMBOLS: ["PF_XBTUSD","PF_ETHUSD","PF_SOLUSD","PF_XRPUSD","PF_DOGEUSD","PF_ADAUSD","PF_LINKUSD","PF_LTCUSD","PF_BCHUSD","PF_AVAXUSD"],
  MIN_CANDLES: 100, TARGET_1_R: 1.5, STOP_BUFFER_ATR: 0.2, MAX_RISK_PCT: 2.0, MAX_ATR_PCT: 2.5,
  INTERVAL_MS: 3600000
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
function ema(values, period) {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let v = values.slice(0, period).reduce((a,b)=>a+b,0)/period;
  for (let i=period;i<values.length;i++) v=values[i]*k+v*(1-k);
  return v;
}
function rsi(values, period=14) {
  if (values.length<=period) return null;
  let g=0,l=0;
  for(let i=1;i<=period;i++){const d=values[i]-values[i-1];g+=Math.max(d,0);l+=Math.max(-d,0);}
  let ag=g/period, al=l/period;
  for(let i=period+1;i<values.length;i++){const d=values[i]-values[i-1];ag=(ag*(period-1)+Math.max(d,0))/period;al=(al*(period-1)+Math.max(-d,0))/period;}
  if(al===0)return 100;if(ag===0)return 0;return 100-100/(1+ag/al);
}
function average(a){return a.length?a.reduce((x,y)=>x+y,0)/a.length:0;}
function atr(candles,period=14){
  if(candles.length<=period)return null;
  const tr=[];
  for(let i=1;i<candles.length;i++){const c=candles[i],p=candles[i-1].close;tr.push(Math.max(c.high-c.low,Math.abs(c.high-p),Math.abs(c.low-p)));}
  return average(tr.slice(-period));
}
async function fetchChunk(symbol, fromMs, toMs) {
  const url = `${CONFIG.CHARTS_URL}/trade/${encodeURIComponent(symbol)}/1h?from=${Math.floor(fromMs/1000)}&to=${Math.floor(toMs/1000)}&count=1600`;
  let lastErr;
  for(let attempt=0;attempt<5;attempt++){
    try{
      const res=await fetch(url,{headers:{Accept:"application/json","User-Agent":"CryptoPumpHunter-Backtest/10.5"}});
      if(!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0,250)}`);
      const data=await res.json();
      if(!Array.isArray(data?.candles)) throw new Error("Response missing candles: "+JSON.stringify(data).slice(0,300));
      return data.candles.map(x=>({time:Number(x.time)<1e12?Number(x.time)*1000:Number(x.time),open:+x.open,high:+x.high,low:+x.low,close:+x.close,volume:+x.volume}))
        .filter(c=>Number.isFinite(c.time)&&Number.isFinite(c.close)&&c.close>0&&Number.isFinite(c.high)&&Number.isFinite(c.low)&&Number.isFinite(c.open))
        .sort((a,b)=>a.time-b.time);
    }catch(e){lastErr=e;await sleep(500*(attempt+1));}
  }
  throw lastErr;
}
async function fetchHistory(symbol,startMs,endMs){
  const chunkMs=1450*CONFIG.INTERVAL_MS, all=[];
  for(let from=startMs;from<endMs;from+=chunkMs){
    const to=Math.min(endMs,from+chunkMs);
    const batch=await fetchChunk(symbol,from,to);
    all.push(...batch);
    await sleep(180);
  }
  const byTime=new Map();
  for(const c of all) if(c.time+CONFIG.INTERVAL_MS<=endMs) byTime.set(c.time,c);
  return [...byTime.values()].sort((a,b)=>a.time-b.time);
}
function analyze(candles, entry) {
  if(candles.length<CONFIG.MIN_CANDLES)return null;
  const last=candles[candles.length-1],prev=candles[candles.length-2];
  const closes=candles.map(c=>c.close),e20=ema(closes,20),e50=ema(closes,50),rv=rsi(closes,14),a=atr(candles,14);
  if(e20===null||e50===null||rv===null||a===null||!Number.isFinite(a))return null;
  const atrPct=a/last.close*100;
  if(atrPct>CONFIG.MAX_ATR_PCT)return null;
  let mode=null,stop=null;
  if(last.close<e50&&e20<e50&&rv<50){
    mode="TREND_SHORT";
    stop=Math.max(...candles.slice(-7).map(c=>c.high))+a*CONFIG.STOP_BUFFER_ATR;
  }else if(last.close>e50&&rv>70){
    if(last.close<last.open&&last.high>prev.high){
      mode="RALLY_FADE";
      stop=last.high+a*CONFIG.STOP_BUFFER_ATR;
    }
  }
  if(!mode)return null;
  const risk=stop-entry,riskPct=risk/entry*100;
  if(!(risk>0)||riskPct>CONFIG.MAX_RISK_PCT)return null;
  return {mode,entry,stop,target:entry-risk*CONFIG.TARGET_1_R,risk,riskPct,atrPct};
}
function buildDailyRegimes(btc){
  const byDay=new Map();
  for(const c of btc){const day=Math.floor(c.time/86400000)*86400000;const old=byDay.get(day);if(!old||c.time>old.time)byDay.set(day,{time:day+86400000,close:c.close});}
  const days=[...byDay.values()].sort((a,b)=>a.time-b.time);
  const regimes=[];
  for(let i=0;i<days.length;i++){
    const closes=days.slice(0,i+1).map(x=>x.close);
    const e50=ema(closes,50),e200=ema(closes,200);
    let regime="NEUTRAL";
    if(e50!==null&&e200!==null){if(closes.at(-1)>e200&&e50>e200)regime="BULL";else if(closes.at(-1)<e200&&e50<e200)regime="BEAR";}
    regimes.push({time:days[i].time,regime});
  }
  return regimes;
}
function regimeAt(regimes,ts){
  let lo=0,hi=regimes.length-1,ans=-1;
  while(lo<=hi){const m=(lo+hi)>>1;if(regimes[m].time<=ts){ans=m;lo=m+1;}else hi=m-1;}
  return ans>=0?regimes[ans].regime:"NEUTRAL";
}
function summarize(trades){
  const closed=trades.filter(t=>t.result!=="OPEN"),wins=closed.filter(t=>t.result==="TP"),losses=closed.filter(t=>t.result==="SL");
  const sum=closed.reduce((s,t)=>s+t.rMultiple,0);
  const sorted=[...closed].sort((a,b)=>a.exitTime-b.exitTime);
  let equity=0,peak=0,maxDD=0;
  for(const t of sorted){equity+=t.rMultiple;peak=Math.max(peak,equity);maxDD=Math.max(maxDD,peak-equity);}
  const avg=closed.length?sum/closed.length:0;
  return {signals:trades.length,closed:closed.length,open:trades.length-closed.length,wins:wins.length,losses:losses.length,winRatePct:closed.length?100*wins.length/closed.length:0,netR:sum,avgR:avg,maxDrawdownR:maxDD};
}
function groupBy(trades,key){
  const keys=[...new Set(trades.map(t=>t[key]))].sort();
  return Object.fromEntries(keys.map(k=>[k,summarize(trades.filter(t=>t[key]===k))]));
}
function maxConcurrent(trades,endMs){
  const events=[];
  for(const t of trades){
    events.push([t.entryTime,1]);
    events.push([t.exitTime??endMs,-1]);
  }
  events.sort((a,b)=>a[0]-b[0]||a[1]-b[1]);
  let active=0,max=0;
  for(const [,delta] of events){active+=delta;max=Math.max(max,active);}
  return max;
}
async function main(){
  const endMs=Date.now(),periodMs=365*86400000,startMs=endMs-periodMs,warmStart=startMs-230*86400000;
  console.log("FETCH_WINDOW",new Date(startMs).toISOString(),new Date(endMs).toISOString());
  const histories={};
  for(const symbol of CONFIG.SYMBOLS){
    console.log("FETCH",symbol);
    histories[symbol]=await fetchHistory(symbol,warmStart,endMs);
    console.log("CANDLES",symbol,histories[symbol].length,new Date(histories[symbol][0]?.time||0).toISOString(),new Date(histories[symbol].at(-1)?.time||0).toISOString());
  }
  const btc=histories.PF_XBTUSD;
  const regimes=buildDailyRegimes(btc);
  const trades=[],dataQuality={};
  for(const symbol of CONFIG.SYMBOLS){
    const candles=histories[symbol];
    let missingHours=0;
    for(let k=1;k<candles.length;k++) missingHours+=Math.max(0,Math.round((candles[k].time-candles[k-1].time)/CONFIG.INTERVAL_MS)-1);
    dataQuality[symbol]={candles:candles.length,missingHours};
    for(let i=CONFIG.MIN_CANDLES-1;i<candles.length-1;i++){
      const signalCandle=candles[i];
      if(signalCandle.time<startMs||signalCandle.time>=endMs)continue;
      const entryCandle=candles[i+1],entry=entryCandle.open;
      const sig=analyze(candles.slice(0,i+1),entry);
      if(!sig)continue;
      const trade={symbol,mode:sig.mode,signalTime:signalCandle.time,entryTime:entryCandle.time,entry:sig.entry,stop:sig.stop,target:sig.target,riskPct:sig.riskPct,atrPct:sig.atrPct,regime:regimeAt(regimes,signalCandle.time),result:"OPEN",exitTime:null,exitPrice:null,rMultiple:0};
      for(let j=i+1;j<candles.length;j++){
        const c=candles[j];
        const stopHit=c.high>=sig.stop,targetHit=c.low<=sig.target;
        if(stopHit&&targetHit){trade.result="SL";trade.exitTime=c.time;trade.exitPrice=sig.stop;trade.rMultiple=-1;break;}
        if(stopHit){trade.result="SL";trade.exitTime=c.time;trade.exitPrice=sig.stop;trade.rMultiple=-1;break;}
        if(targetHit){trade.result="TP";trade.exitTime=c.time;trade.exitPrice=sig.target;trade.rMultiple=CONFIG.TARGET_1_R;break;}
      }
      trades.push(trade);
    }
  }
  trades.sort((a,b)=>a.entryTime-b.entryTime||a.symbol.localeCompare(b.symbol));
  const report={engine:"Crypto Pump Hunter v10.5 SHORT Hybrid",generatedAt:new Date().toISOString(),period:{start:new Date(startMs).toISOString(),end:new Date(endMs).toISOString(),days:365},symbols:CONFIG.SYMBOLS,config:CONFIG,methodology:{signal:"evaluate each completed 1h candle; entry at next 1h candle open",exit:"TP 1.5R or stop; stop is assumed first if both touched in same 1h candle",overlapping:"signals/trades are independently counted; source code has no per-symbol cooldown or open-position lock",regime:"BTC daily close vs EMA200 and EMA50/EMA200; use only fully completed prior UTC days",feesFundingSlippage:"excluded",endOfPeriod:"unclosed positions reported OPEN and excluded from win rate/net R"},dataQuality,overall:summarize(trades),byMode:groupBy(trades,"mode"),byRegime:groupBy(trades,"regime"),bySymbol:groupBy(trades,"symbol"),maxConcurrentOpenPositions:maxConcurrent(trades,endMs),
    maxConcurrentBySymbol:Object.fromEntries(CONFIG.SYMBOLS.map(symbol=>[symbol,maxConcurrent(trades.filter(t=>t.symbol===symbol),endMs)])),
    trades:trades.length};
  await fs.mkdir("out",{recursive:true});
  await fs.writeFile("out/summary.json",JSON.stringify(report,null,2));
  const fields=["symbol","mode","signalTime","entryTime","entry","stop","target","riskPct","atrPct","regime","result","exitTime","exitPrice","rMultiple"];
  const csv=[fields.join(","),...trades.map(t=>fields.map(k=>JSON.stringify(t[k]??"")).join(","))].join("\n");
  await fs.writeFile("out/trades.csv",csv);
  console.log("SUMMARY",JSON.stringify(report));
}
main().catch(e=>{console.error(e?.stack||e);process.exit(1);});

import { mkdir, writeFile } from "node:fs/promises";
import { evaluateBtcSwingSetup, selectDailyBtcSignals, BTC_ENGINE_CONFIG } from "../src/btc-swing-signal-engine.js";

const BASE = "https://futures.kraken.com";
const MS = { "5m":300000, "15m":900000, "1h":3600000 };
const DAYS = 30, WARMUP_DAYS = 60, LEVERAGE = BTC_ENGINE_CONFIG.leverage;
const END = Date.now(), TEST_START = END - DAYS*86400000, DATA_START = TEST_START - WARMUP_DAYS*86400000;

async function getJson(url, attempt=0) {
  const res = await fetch(url,{headers:{accept:"application/json"},signal:AbortSignal.timeout(30000)});
  const body=await res.text();
  if(!res.ok){ if(attempt<3&&(res.status===429||res.status>=500)){await new Promise(r=>setTimeout(r,800*(attempt+1)));return getJson(url,attempt+1);} throw new Error("HTTP "+res.status+" "+url+" "+body.slice(0,180));}
  const data=JSON.parse(body);
  if(data?.result==="error"||(Array.isArray(data?.errors)&&data.errors.length)) throw new Error("Kraken API error "+JSON.stringify(data.errors||data.error));
  return data;
}
function normalize(rows, interval) {
  const seen=new Set();
  return (rows||[]).map(r=>({time:Number(r.time)<1e12?Number(r.time)*1000:Number(r.time),open:+r.open,high:+r.high,low:+r.low,close:+r.close,volume:+r.volume}))
    .filter(c=>Number.isFinite(c.time)&&[c.open,c.high,c.low,c.close,c.volume].every(Number.isFinite)&&c.low>0&&c.high>=c.low&&c.close>0&&c.time+interval<=END)
    .sort((a,b)=>a.time-b.time).filter(c=>{if(seen.has(c.time))return false;seen.add(c.time);return true;});
}
async function fetchCandles(resolution) {
  const interval=MS[resolution], chunk=interval*1700, all=[];
  for(let from=DATA_START;from<END;from+=chunk){
    const to=Math.min(END,from+chunk),u=new URL(BASE+"/api/charts/v1/trade/PF_XBTUSD/"+resolution);
    u.searchParams.set("from",String(Math.floor(from/1000)));u.searchParams.set("to",String(Math.floor(to/1000)));u.searchParams.set("count","1800");
    const d=await getJson(u);if(d.more_candles===true)throw new Error("Kraken incomplete chunk "+resolution);
    all.push(...normalize(d.candles,interval));
  }
  const map=new Map(all.map(c=>[c.time,c]));return [...map.values()].sort((a,b)=>a.time-b.time);
}
function lowerBound(a,t){let l=0,h=a.length;while(l<h){const m=(l+h)>>1;if(a[m].time<t)l=m+1;else h=m;}return l;}
function utcDay(t){return new Date(t).toISOString().slice(0,10);}
function simulateTrade(signal, candles5m) {
  const entryIndex=lowerBound(candles5m,signal.signalCloseTime);
  if(entryIndex>=candles5m.length)return null;
  const entryBar=candles5m[entryIndex],entry=entryBar.open,side=signal.side,dir=side==="LONG"?1:-1,initialStop=signal.stop;
  const risk=side==="LONG"?entry-initialStop:initialStop-entry,riskPct=risk/entry;
  if(!(risk>0)||riskPct<BTC_ENGINE_CONFIG.minRiskPct||riskPct>BTC_ENGINE_CONFIG.maxRiskPct)return null;
  const tp1=entry+dir*risk*BTC_ENGINE_CONFIG.tp1R,tp2=entry+dir*risk*BTC_ENGINE_CONFIG.tp2R;
  let stop=initialStop,be=false,tp1Done=false,remaining=1,realized=0,exitReason="OPEN_AT_END",closedAt=null,exitPrice=null,stopLock=false;
  const priceReturn=px=>dir*((px-entry)/entry)*100*LEVERAGE;
  for(let i=entryIndex;i<candles5m.length&&candles5m[i].time<END;i++){
    const c=candles5m[i],open=c.open,high=c.high,low=c.low;
    const stopHit=side==="LONG"?low<=stop:high>=stop,stopAtOpen=side==="LONG"?open<=stop:open>=stop;
    if(stopHit){
      exitPrice=stopAtOpen?open:stop;realized+=remaining*priceReturn(exitPrice);remaining=0;exitReason=tp1Done?"STOP_AFTER_TP1":"STOP";closedAt=c.time+MS["5m"];break;
    }
    const oneR=entry+dir*risk;
    const hitOneR=side==="LONG"?high>=oneR:low<=oneR;
    if(!be&&hitOneR){const beStop=entry+dir*entry*0.0012;if((dir===1&&beStop>stop)||(dir===-1&&beStop<stop))stop=beStop;be=true;}
    if(!tp1Done){
      const hit1=side==="LONG"?high>=tp1:low<=tp1;
      if(hit1){
        const fill=side==="LONG"?(open>=tp1?open:tp1):(open<=tp1?open:tp1);
        realized+=(1/3)*priceReturn(fill);remaining-=1/3;tp1Done=true;
        const lock=entry+dir*risk*0.5;
        if((dir===1&&lock>stop)||(dir===-1&&lock<stop))stop=lock;
        stopLock=true;
      }
    }
    const hit2=side==="LONG"?high>=tp2:low<=tp2;
    if(hit2){
      const fill=side==="LONG"?(open>=tp2?open:tp2):(open<=tp2?open:tp2);
      realized+=remaining*priceReturn(fill);remaining=0;exitPrice=fill;exitReason="TP2";closedAt=c.time+MS["5m"];break;
    }
  }
  const last=candles5m.filter(c=>c.time<END).at(-1);
  if(remaining>0){exitPrice=last?.close??entry;realized+=remaining*priceReturn(exitPrice);exitReason="MARK_TO_MARKET_END";closedAt=END;}
  return {id:"BTC:"+signal.candleTime,side,setupType:signal.setupType,score:signal.entryAccuracyScore,regime1h:signal.regime1h,signalTime:signal.candleTime,entryTime:entryBar.time,entry,initialStop,tp1,tp2,exitPrice,exitReason,closedAt,beActivated:be,tp1Done,stopLockedAtHalfR:stopLock,realizedMarginReturnPct:realized,win:realized>0};
}
function portfolio(trades){
  const events=[];for(const t of trades){events.push({time:t.entryTime,type:"IN",t});events.push({time:t.closedAt,type:"OUT",t});}
  events.sort((a,b)=>a.time-b.time||(a.type==="OUT"?-1:1));
  const initial=100,margin=10,maxOpen=6;let free=initial,used=0,peak=initial,maxDD=0,pnl=0,maxConcurrent=0,accepted=0,skipped=0;const active=new Map();
  for(const e of events){const t=e.t;if(e.type==="IN"){if(active.size>=maxOpen||free<margin){skipped++;continue;}free-=margin;used+=margin;active.set(t.id,t);accepted++;maxConcurrent=Math.max(maxConcurrent,active.size);}else if(active.has(t.id)){const p=margin*t.realizedMarginReturnPct/100;free+=margin+p;used-=margin;pnl+=p;active.delete(t.id);const eq=free+used;peak=Math.max(peak,eq);maxDD=Math.max(maxDD,peak-eq);}}
  return {initialCapitalUSD:initial,marginPerTradeUSD:margin,leverage:LEVERAGE,notionalPerTradeUSD:margin*LEVERAGE,maxConcurrentPositions:maxConcurrent,acceptedTrades:accepted,skippedForConcurrencyOrMargin:skipped,closedPositions:accepted,realizedNetPnlUSD:+pnl.toFixed(4),endingEquityUSD:+(initial+pnl).toFixed(4),maxDrawdownUSD:+maxDD.toFixed(4)};
}
const [c1h,c15m,c5m]=await Promise.all([fetchCandles("1h"),fetchCandles("15m"),fetchCandles("5m")]);
if(c1h.length<100||c15m.length<300||c5m.length<1000)throw new Error("Insufficient candles: "+JSON.stringify({h1:c1h.length,m15:c15m.length,m5:c5m.length}));
const candidates=[],issued=[],accepted=[],rejections={};
let h=0;
for(let i=45;i<c15m.length;i++){
  const bar=c15m[i],closeTime=bar.time+MS["15m"];
  if(closeTime<TEST_START||closeTime>=END)continue;
  while(h<c1h.length&&c1h[h].time+MS["1h"]<=closeTime)h++;
  const closed1h=c1h.slice(0,h),closed15=c15m.slice(0,i+1);
  const candidate=evaluateBtcSwingSetup(closed15,closed1h);
  if(!candidate.ok){rejections[candidate.reason]=(rejections[candidate.reason]||0)+1;continue;}
  candidate.candleTime=closeTime;
  candidates.push(candidate);
  const day=utcDay(closeTime),today=issued.filter(x=>utcDay(x.candleTime)===day);
  const last=issued.at(-1);
  if(last&&closeTime-Number(last.candleTime)<BTC_ENGINE_CONFIG.minCooldownMinutes*60000)continue;
  const selected=selectDailyBtcSignals([candidate],today);
  if(selected.some(x=>x===candidate)){issued.push(candidate);accepted.push({...candidate,signalCloseTime:closeTime});}
}
const trades=accepted.map(s=>simulateTrade(s,c5m)).filter(Boolean);
const wins=trades.filter(t=>t.realizedMarginReturnPct>0),losses=trades.filter(t=>t.realizedMarginReturnPct<0);
const stopTrades=trades.filter(t=>t.exitReason.startsWith("STOP"));
const avg=a=>a.length?a.reduce((n,x)=>n+x,0)/a.length:0;
const report={
  source:"Kraken Futures historical candles",symbol:"PF_XBTUSD",periodStart:new Date(TEST_START).toISOString(),periodEnd:new Date(END).toISOString(),
  candleCounts:{"1h":c1h.length,"15m":c15m.length,"5m":c5m.length},
  engineConfig:BTC_ENGINE_CONFIG,
  selectionMethod:"Causal streaming scan: evaluate each closed 15m candle, then pass only that candidate plus same-day issued signals to the supplied selector; execute at next 5m candle open.",
  lifecycleAssumptions:{entry:"next available 5m candle open after 15m signal close",stop:"initial ATR/swing stop; at +1R move to entry plus 0.12% fee buffer; after TP1 move remaining stop to +0.5R",tp1:"close 1/3 at 1.5R",tp2:"close remaining 2/3 at 2.8R",intrabar:"active stop checked before targets; stop changes apply from following 5m candle",feesAndFunding:"not included beyond 0.12% BE buffer",margin:"$10 per position, 10x, $100 initial capital, max 6 concurrent positions, no compounding"},
  scanStats:{validSetups:candidates.length,selectedSignals:accepted.length,signalsPerDay:accepted.length/DAYS,scoreAverage:+avg(accepted.map(x=>x.entryAccuracyScore)).toFixed(2),standardScoreSignals:accepted.filter(x=>x.entryAccuracyScore>=BTC_ENGINE_CONFIG.minEntryAccuracyScore).length,fallbackSignals:accepted.filter(x=>x.entryAccuracyScore<BTC_ENGINE_CONFIG.minEntryAccuracyScore).length,rejections},
  tradeStats:{trades:trades.length,wins:wins.length,losses:losses.length,winRatePct:trades.length?+(wins.length/trades.length*100).toFixed(2):0,stopExits:stopTrades.length,stopLossExits:stopTrades.filter(t=>t.realizedMarginReturnPct<0).length,positiveStopExits:stopTrades.filter(t=>t.realizedMarginReturnPct>0).length,tp2Exits:trades.filter(t=>t.exitReason==="TP2").length,markToMarketAtEnd:trades.filter(t=>t.exitReason==="MARK_TO_MARKET_END").length,averageMarginReturnPct:+avg(trades.map(t=>t.realizedMarginReturnPct)).toFixed(2),averageWinMarginPct:+avg(wins.map(t=>t.realizedMarginReturnPct)).toFixed(2),averageLossMarginPct:+avg(losses.map(t=>t.realizedMarginReturnPct)).toFixed(2),grossMarginReturnPct:+trades.reduce((n,t)=>n+t.realizedMarginReturnPct,0).toFixed(2)},
  portfolio:portfolio(trades),trades
};
await mkdir("artifacts",{recursive:true});
await writeFile("artifacts/btc-swing-30d-report.json",JSON.stringify(report,null,2));
console.log("BTC_SWING_BACKTEST_REPORT="+JSON.stringify(report));

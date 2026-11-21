import { mkdir, writeFile } from "node:fs/promises";
import { analyzeFuturesSymbol } from "../src/v480-engine.mjs";

const BASE="https://futures.kraken.com";
const MS={"5m":300000,"15m":900000,"1h":3600000,"4h":14400000};
const WARMUP_DAYS=20, FEE=0.0005, SLIPPAGE=0.0003;
const INITIAL_BALANCE=100, MARGIN=10, LEVERAGE=10, NOTIONAL=MARGIN*LEVERAGE;
const TP_MARGIN_PCT=0.30, TP_MOVE_PCT=TP_MARGIN_PCT/LEVERAGE;
const SYMBOLS=["PF_XBTUSD","PF_ETHUSD","PF_SOLUSD","PF_HYPEUSD","PF_ZECUSD","PF_XRPUSD","PF_NEARUSD"];
const PERIODS=[
 {name:"SHORT_BEAR_2024_Q3",side:"SHORT",start:"2024-07-01T00:00:00Z",end:"2024-08-30T00:00:00Z"},
 {name:"LONG_BULL_2024_Q4",side:"LONG",start:"2024-10-01T00:00:00Z",end:"2024-11-30T00:00:00Z"},
 {name:"SHORT_BEAR_2025_Q1",side:"SHORT",start:"2025-01-15T00:00:00Z",end:"2025-03-16T00:00:00Z"},
 {name:"LONG_BULL_2025_Q2",side:"LONG",start:"2025-04-01T00:00:00Z",end:"2025-05-31T00:00:00Z"}
];
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function getJson(url,attempt=0){
 const res=await fetch(url,{headers:{accept:"application/json"},signal:AbortSignal.timeout(30000)});
 const body=await res.text();
 if(!res.ok){if(attempt<5&&(res.status===429||res.status>=500)){await sleep(700*(attempt+1));return getJson(url,attempt+1);}throw Error("HTTP "+res.status+" "+url+" "+body.slice(0,160));}
 const data=JSON.parse(body);if(data?.result==="error"||data?.errors?.length)throw Error("Kraken API error "+JSON.stringify(data.errors||data.error));return data;
}
function normalize(rows,interval){
 const seen=new Set();
 return rows.map(r=>({time:Number(r.time)<1e12?Number(r.time)*1000:Number(r.time),open:+r.open,high:+r.high,low:+r.low,close:+r.close,volume:+r.volume}))
 .filter(c=>Number.isFinite(c.time)&&[c.open,c.high,c.low,c.close,c.volume].every(Number.isFinite)&&c.open>0&&c.close>0&&c.low>0&&c.high>=c.low&&c.volume>=0&&c.time+interval<=Date.now())
 .sort((a,b)=>a.time-b.time).filter(c=>{if(seen.has(c.time))return false;seen.add(c.time);return true;});
}
async function candles(symbol,resolution,from,to){
 const interval=MS[resolution],chunk=interval*1650,out=[];
 for(let s=from;s<to;s+=chunk){
  const e=Math.min(to,s+chunk),u=new URL(BASE+"/api/charts/v1/trade/"+encodeURIComponent(symbol)+"/"+resolution);
  u.searchParams.set("from",String(Math.floor(s/1000)));u.searchParams.set("to",String(Math.floor(e/1000)));u.searchParams.set("count","1750");
  const d=await getJson(u);if(d.more_candles===true)throw Error(symbol+" "+resolution+" incomplete chunk");
  out.push(...normalize(d.candles,interval));await sleep(80);
 }
 return [...new Map(out.map(c=>[c.time,c])).values()].sort((a,b)=>a.time-b.time);
}
function lowerBound(a,t){let l=0,h=a.length;while(l<h){const m=(l+h)>>1;if(a[m].time<t)l=m+1;else h=m;}return l;}
function change24(a,i){const old=a[i-24],now=a[i];return !old||old.close<=0?0:(now.close/old.close-1)*100;}
function makeTrade(candidate,entryTime,endTime,bars,symbol,period){
 const side=candidate.side,dir=side==="LONG"?1:-1;
 const rawEntry=Number(candidate.entry),entryFill=rawEntry*(1+dir*SLIPPAGE);
 const stop=Number(candidate.stop),targetPrice=entryFill*(1+dir*TP_MOVE_PCT);
 if(!(entryFill>0)||!(dir===1?entryFill>stop:entryFill<stop))return null;
 const i0=lowerBound(bars,entryTime);
 for(let i=i0;i<bars.length&&bars[i].time<endTime;i++){
  const b=bars[i],stopHit=side==="LONG"?b.low<=stop:b.high>=stop;
  const tpHit=side==="LONG"?b.high>=targetPrice:b.low<=targetPrice;
  if(!stopHit&&!tpHit)continue;
  const stopAtOpen=side==="LONG"?b.open<=stop:b.open>=stop;
  const tpAtOpen=side==="LONG"?b.open>=targetPrice:b.open<=targetPrice;
  const isStop=stopAtOpen||(!tpAtOpen&&stopHit);
  const rawExit=isStop?(stopAtOpen?b.open:stop):(tpAtOpen?b.open:targetPrice);
  const exitFill=rawExit*(1-dir*SLIPPAGE);
  const qty=NOTIONAL/entryFill,exitNotional=qty*exitFill;
  const gross=dir*(exitFill-entryFill)*qty;
  const fees=FEE*(NOTIONAL+exitNotional);
  return {symbol,period,side,score:candidate.score,entryTime,exitTime:b.time+MS["5m"],outcome:isStop?"STOP":"TP",rawEntry,entryFill,stop,targetPrice,exitFill,qty,gross,fees,pnl:gross-fees};
 }
 const last=bars.at(-1);
 if(!last||last.time<entryTime)return null;
 const rawExit=last.close,exitFill=rawExit*(1-dir*SLIPPAGE),qty=NOTIONAL/entryFill,exitNotional=qty*exitFill;
 const gross=dir*(exitFill-entryFill)*qty,fees=FEE*(NOTIONAL+exitNotional);
 return {symbol,period,side,score:candidate.score,entryTime,exitTime:endTime,outcome:"UNRESOLVED_END",rawEntry,entryFill,stop,targetPrice,exitFill,qty,gross,fees,pnl:gross-fees};
}
async function main(){
 const tickers=await getJson(BASE+"/derivatives/api/v3/tickers");
 const tickerMap=new Map((tickers.tickers||[]).map(t=>[t.symbol,t]));
 const candidates=[],errors=[],periodSymbolResults=[];
 for(const p of PERIODS){
  const start=Date.parse(p.start),end=Date.parse(p.end);
  for(const symbol of SYMBOLS){
   const ticker=tickerMap.get(symbol);
   if(!ticker){errors.push({period:p.name,symbol,error:"Ticker not found"});continue;}
   try{
    const warm=start-WARMUP_DAYS*86400000;
    const [h1,h4,m15,m5]=await Promise.all([candles(symbol,"1h",warm,end),candles(symbol,"4h",warm,end),candles(symbol,"15m",warm,end),candles(symbol,"5m",start,end)]);
    if(h1.length<100||h4.length<60||m15.length<120||m5.length<500)throw Error("Insufficient candles 1h="+h1.length+" 4h="+h4.length+" 15m="+m15.length+" 5m="+m5.length);
    let eligible=0;
    let fourIdx=0,fifteenIdx=0;
    for(let i=60;i<h1.length-1;i++){
     const bar=h1[i],signalTime=bar.time+MS["1h"];
     if(signalTime<start||signalTime>=end)continue;
     while(fourIdx<h4.length&&h4[fourIdx].time+MS["4h"]<=signalTime)fourIdx++;
     while(fifteenIdx<m15.length&&m15[fifteenIdx].time+MS["15m"]<=signalTime)fifteenIdx++;
     const closed4=h4.slice(0,fourIdx),closed15=m15.slice(Math.max(0,fifteenIdx-120),fifteenIdx);
     if(closed4.length<60||closed15.length<30)continue;
     const next=h1[i+1],tickerAt={symbol,last:next.open,quoteVolume:+ticker.volumeQuote||0,priceChangePercent:change24(h1,i),premium:{lastFundingRate:null}};
     let c;try{c=analyzeFuturesSymbol(tickerAt,h1.slice(0,i+1),closed4,closed15);}catch{continue;}
     if(c?.eligible!==true||c.side!==p.side)continue;
     eligible++;
     const trade=makeTrade(c,signalTime,end,m5,symbol,p.name);
     if(trade)candidates.push(trade);
    }
    periodSymbolResults.push({period:p.name,symbol,eligibleSignals:eligible,candles:{h1:h1.length,h4:h4.length,m15:m15.length,m5:m5.length}});
    console.log("DONE",p.name,symbol,"eligible",eligible);
   }catch(e){errors.push({period:p.name,symbol,error:String(e?.message||e)});console.log("FAILED",p.name,symbol,String(e?.message||e));}
  }
 }
 // Event-driven account simulation. Exit events are processed before entries at equal timestamps.
 const events=[];
 for(const t of candidates){events.push({time:t.entryTime,type:"ENTRY",trade:t});events.push({time:t.exitTime,type:"EXIT",trade:t});}
 events.sort((a,b)=>a.time-b.time||((a.type==="EXIT"?0:1)-(b.type==="EXIT"?0:1))||a.trade.symbol.localeCompare(b.trade.symbol));
 let balance=INITIAL_BALANCE,locked=0,openBySymbol=new Map(),accepted=[],skipped={occupiedSymbol:0,insufficientFreeMargin:0};
 for(const ev of events){
  const t=ev.trade;
  if(ev.type==="EXIT"){
   if(!t.accepted)continue;
   balance+=t.pnl;locked-=MARGIN;openBySymbol.delete(t.symbol);t.balanceAfter=balance;t.acceptedExit=true;
  }else{
   if(openBySymbol.has(t.symbol)){skipped.occupiedSymbol++;continue;}
   if(balance-locked+1e-9<MARGIN){skipped.insufficientFreeMargin++;continue;}
   t.accepted=true;openBySymbol.set(t.symbol,t);locked+=MARGIN;accepted.push(t);
  }
 }
 const tp=accepted.filter(t=>t.outcome==="TP"),sl=accepted.filter(t=>t.outcome==="STOP"),unresolved=accepted.filter(t=>t.outcome==="UNRESOLVED_END");
 const sum=a=>a.reduce((s,t)=>s+t.pnl,0),closed=tp.length+sl.length;
 const report={
  engine:"User-supplied Signal Engine v4.8.0; strategy module unchanged",
  venue:"Kraken Futures public historical trade candles",
  periods:PERIODS,universe:SYMBOLS,
  account:{initialBalance:INITIAL_BALANCE,marginPerTrade:MARGIN,leverage:LEVERAGE,notionalPerTrade:NOTIONAL,tpMarginPct:TP_MARGIN_PCT,tpUnderlyingMovePct:TP_MOVE_PCT*100,feePerSide:FEE,slippagePerSide:SLIPPAGE,endingBalance:balance,netPnl:balance-INITIAL_BALANCE,returnPct:(balance/INITIAL_BALANCE-1)*100},
  counts:{signalsWithValidExit:candidates.length,acceptedTrades:accepted.length,long:accepted.filter(t=>t.side==="LONG").length,short:accepted.filter(t=>t.side==="SHORT").length,tp:tp.length,stop:sl.length,unresolvedAtPeriodEnd:unresolved.length,skipped},
  results:{tpNetProfit:sum(tp),stopNetLoss:sum(sl),unresolvedPnl:sum(unresolved),netPnl:sum(accepted),winRatePct:closed?tp.length/closed*100:0,profitFactor:Math.abs(sum(sl))?sum(tp)/Math.abs(sum(sl)):null},
  assumptions:{
   signalLogic:"analyzeFuturesSymbol imported unchanged from src/v480-engine.mjs; signal evaluation once per completed 1h candle, only closed 1h/4h/15m bars supplied, entry at next 1h open.",
   target:"30% gross return on $10 margin at 10x = 3% favorable underlying price move from adverse-slippage-adjusted entry fill. TP trigger is price-based; realized net profit deducts both-side fees and slippage.",
   stop:"Original engine stop price unchanged. A stop counts only if touched before the 30%-margin TP. Same 5m candle ambiguity resolves stop-first unless open gaps through target.",
   capital:"One $10-margin position per symbol at a time; new trade accepted only when realized balance minus locked margin is at least $10. No more than account-supported simultaneous positions. Fixed $10 margin; no compounding position size.",
   endOfWindow:"Any position not reaching TP or stop by the end of its historical window is closed at final available 5m close, adverse slippage and fees applied, and counted as UNRESOLVED_END—not TP or SL. Balance carries chronologically into the next historical window.",
   funding:"Historical funding unavailable; null passed to unchanged engine.",
   liquidation:"No exchange liquidation/maintenance-margin simulation. This is a simplified isolated-margin account ledger.",
   costs:"Fee 0.05% per side; adverse slippage 0.03% per side."
  },
  acceptedTrades:accepted.map(({accepted,acceptedExit,...t})=>t),
  periodSymbolResults,errors
 };
 await mkdir("artifacts",{recursive:true});
 await writeFile("artifacts/v480-account-30pct.json",JSON.stringify(report,null,2));
 const lines=[
 "# v4.8.0 account simulation — 30% margin TP",
 "",
 "| Metric | Result |","|---|---:|",
 "| Starting balance | $100.00 |","| Margin / trade | $10.00 |","| Leverage | 10x |","| Notional / trade | $100.00 |",
 "| TP trigger | +30% margin (3% underlying) |","| Accepted trades | "+accepted.length+" |",
 "| LONG | "+report.counts.long+" |","| SHORT | "+report.counts.short+" |","| TP | "+tp.length+" |","| STOP | "+sl.length+" |","| Unresolved end | "+unresolved.length+" |",
 "| TP net profit | $"+sum(tp).toFixed(2)+" |","| Stop net loss | $"+sum(sl).toFixed(2)+" |","| Unresolved PnL | $"+sum(unresolved).toFixed(2)+" |",
 "| Win rate (TP / TP+STOP) | "+report.results.winRatePct.toFixed(2)+"% |","| Net PnL | $"+(balance-INITIAL_BALANCE).toFixed(2)+" |",
 "| Ending balance | $"+balance.toFixed(2)+" |","| Account return | "+report.account.returnPct.toFixed(2)+"% |",
 "",
 "## Skipped signals","",
 JSON.stringify(skipped,null,2),"",
 "## Errors","",...errors.map(e=>"- "+e.period+" "+e.symbol+": "+e.error),
 "",
 "## Assumptions","",...Object.entries(report.assumptions).map(([k,v])=>"- "+k+": "+v)
 ];
 await writeFile("artifacts/v480-account-30pct.md",lines.join("\n"));
 console.log("ACCOUNT_BACKTEST_FINAL");
 console.log(JSON.stringify({account:report.account,counts:report.counts,results:report.results,errors},null,2));
}
main().catch(e=>{console.error(e);process.exitCode=1;});

// Account simulation harness only; v4.8.0 strategy module remains unchanged.

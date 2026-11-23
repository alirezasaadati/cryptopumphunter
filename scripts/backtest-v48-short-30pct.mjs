import { mkdir, writeFile } from "node:fs/promises";
import { analyzeFuturesSymbol, computeBtcRegime, FUTURES_CONFIG } from "../src/index.js";
import { evaluateTradeCandle } from "../src/futures-trade-lifecycle.js";

const BASE="https://futures.kraken.com";
const MS={ "5m":300000,"15m":900000,"1h":3600000,"4h":14400000 };
const MARGIN=10, LEVERAGE=10, TARGET_MARGIN=30, WARMUP_DAYS=15, LIMIT=10;
const END=process.env.BACKTEST_END ? Date.parse(process.env.BACKTEST_END) : Date.now();
if(!Number.isFinite(END)) throw new Error("Invalid BACKTEST_END");

async function getJson(url,attempt=0){
  const r=await fetch(url,{headers:{accept:"application/json"},signal:AbortSignal.timeout(30000)});
  const body=await r.text();
  if(!r.ok){if(attempt<3&&(r.status===429||r.status>=500)){await new Promise(x=>setTimeout(x,900*(attempt+1)));return getJson(url,attempt+1);}throw new Error("HTTP "+r.status+" "+url+" "+body.slice(0,160));}
  const data=JSON.parse(body);
  if(data?.result==="error"||(Array.isArray(data?.errors)&&data.errors.length))throw new Error("Kraken API error "+JSON.stringify(data.errors||data.error));
  return data;
}
function normalize(rows,step){
  if(!Array.isArray(rows))throw new Error("Missing candle array");
  const seen=new Set();
  return rows.map(x=>({time:Number(x.time)<1e12?Number(x.time)*1000:Number(x.time),open:Number(x.open),high:Number(x.high),low:Number(x.low),close:Number(x.close),volume:Number(x.volume)}))
    .filter(c=>Number.isFinite(c.time)&&[c.open,c.high,c.low,c.close,c.volume].every(Number.isFinite)&&c.open>0&&c.low>0&&c.high>=c.low&&c.time+step<=Date.now())
    .sort((a,b)=>a.time-b.time).filter(c=>{if(seen.has(c.time))return false;seen.add(c.time);return true;});
}
async function candles(symbol,res,from,to){
  const step=MS[res],chunk=step*1700,all=[];
  for(let s=from;s<to;s+=chunk){
    const e=Math.min(to,s+chunk),u=new URL(BASE+"/api/charts/v1/trade/"+encodeURIComponent(symbol)+"/"+res);
    u.searchParams.set("from",String(Math.floor(s/1000)));u.searchParams.set("to",String(Math.floor(e/1000)));u.searchParams.set("count","1800");
    const d=await getJson(u);if(d.more_candles===true)throw new Error(symbol+" "+res+" incomplete chunk");
    all.push(...normalize(d.candles,step));
  }
  return [...new Map(all.map(c=>[c.time,c])).values()].sort((a,b)=>a.time-b.time);
}
function lower(a,t){let l=0,h=a.length;while(l<h){const m=(l+h)>>1;if(a[m].time<t)l=m+1;else h=m;}return l;}
function hist(a,i){const s=a.slice(Math.max(0,i-23),i+1),old=a[Math.max(0,i-24)];return {change:!old||old.close<=0?0:(a[i].close/old.close-1)*100,quoteVolume:s.reduce((n,c)=>n+c.volume*c.close,0)};}
function metrics(trades,counters){
  const closed=trades.filter(t=>t.status==="CLOSED_PROFIT"||t.status==="CLOSED_STOP"),wins=closed.filter(t=>t.status==="CLOSED_PROFIT"),stops=closed.filter(t=>t.status==="CLOSED_STOP");
  const gross=t=>MARGIN*Number(t.marginReturnPercent||0)/100;
  const pnls=closed.map(gross),profit=pnls.filter(x=>x>0).reduce((a,b)=>a+b,0),loss=Math.abs(pnls.filter(x=>x<0).reduce((a,b)=>a+b,0));
  let eq=0,peak=0,dd=0;for(const t of [...closed].sort((a,b)=>(a.closedAtMs||0)-(b.closedAtMs||0))){eq+=gross(t);peak=Math.max(peak,eq);dd=Math.max(dd,peak-eq);}
  return {signals:trades.length,closed:closed.length,wins:wins.length,stops:stops.length,openAtEnd:trades.length-closed.length,
    winRatePct:closed.length?wins.length/closed.length*100:0,stopRatePct:closed.length?stops.length/closed.length*100:0,
    grossPnlUsd:pnls.reduce((a,b)=>a+b,0),grossProfitUsd:profit,grossLossUsd:loss,profitFactor:loss?profit/loss:(profit?Infinity:0),
    maxDrawdownUsd:dd,eligibleShortCandidates:counters.eligible,rejected:counters.rejected,lockSkips:counters.lockSkips};
}
async function run(data,btc,testStart,end){
  const {oneHour,fourHour,fifteenMinute,fiveMinute}=data,trades=[],locks=new Map(),counts={eligible:0,rejected:0,lockSkips:0};
  let i4=0,i15=0,ib=0;
  for(let i=60;i<oneHour.length-1;i++){
    const bar=oneHour[i],signalClose=bar.time+MS["1h"];
    if(signalClose<testStart||signalClose>=end)continue;
    while(i4<fourHour.length&&fourHour[i4].time+MS["4h"]<=signalClose)i4++;
    while(i15<fifteenMinute.length&&fifteenMinute[i15].time+MS["15m"]<=signalClose)i15++;
    while(ib<btc.length&&btc[ib].time+MS["4h"]<=signalClose)ib++;
    const h4=fourHour.slice(0,i4),m15=fifteenMinute.slice(Math.max(0,i15-120),i15);
    if(h4.length<FUTURES_CONFIG.MIN_CANDLES||m15.length<40)continue;
    const next=oneHour[i+1],hv=hist(oneHour,i),ticker={symbol:data.symbol,last:next.open,quoteVolume:hv.quoteVolume,priceChangePercent:hv.change,premium:{lastFundingRate:null}};
    let candidate;
    try{candidate=analyzeFuturesSymbol(ticker,oneHour.slice(0,i+1),h4,m15,{btcRegime:computeBtcRegime(btc.slice(Math.max(0,ib-120),ib))});}
    catch{counts.rejected++;continue;}
    if(!candidate||candidate.eligible!==true||candidate.side!=="SHORT"){counts.rejected++;continue;}
    counts.eligible++;
    const key=data.symbol+"|SHORT";if((locks.get(key)||0)>signalClose){counts.lockSkips++;continue;}
    const entry=Number(candidate.entry),stop=Number(candidate.stop);
    const trade={id:data.symbol+":SHORT:"+signalClose,symbol:data.symbol,side:"SHORT",status:"OPEN",entry,actualEntry:entry,initialStop:stop,stop,currentStop:stop,signalTime:bar.time,entryTime:signalClose,score:candidate.score,riskLevel:candidate.riskLevel||"STANDARD"};
    let j=lower(fiveMinute,signalClose),done=false;
    for(;j<fiveMinute.length&&fiveMinute[j].time<end;j++){
      const c=fiveMinute[j],result=evaluateTradeCandle(trade,{...c,time:c.time+MS["5m"]},{leverage:LEVERAGE,targetMarginPercent:TARGET_MARGIN});
      if(result.changed)Object.assign(trade,result.trade);
      if(trade.status==="CLOSED_PROFIT"||trade.status==="CLOSED_STOP"){trade.closedAtMs=c.time+MS["5m"];done=true;break;}
    }
    if(!done){trade.status="OPEN_AT_BACKTEST_END";locks.set(key,end);}else locks.set(key,trade.closedAtMs);
    trades.push(trade);
  }
  return {trades,counts,metrics:metrics(trades,counts)};
}
async function main(){
  const tickers=(await getJson(BASE+"/derivatives/api/v3/tickers")).tickers;
  const excluded=new Set(["XAU","NVDAX","EUR","GBP","JPY","AUD","CAD","CHF","SPX","NDX","US500","US100"]);
  const universe=tickers.filter(t=>t?.tag==="perpetual"&&t.suspended!==true&&/^(PI|PF)_[A-Z0-9]+USD$/.test(String(t.symbol||""))&&Number(t.volumeQuote)>=FUTURES_CONFIG.HIGH_RISK_MIN_QUOTE_VOLUME&&Number(t.last)>0&&!excluded.has(String(t.symbol).toUpperCase().replace(/^(PI|PF)_/,"").replace(/USD$/,""))).sort((a,b)=>Number(b.volumeQuote)-Number(a.volumeQuote)).slice(0,LIMIT);
  if(!universe.length)throw new Error("No eligible perpetuals");
  const maxDays=180,from=END-(maxDays+WARMUP_DAYS)*86400000;
  const btc=await candles(FUTURES_CONFIG.BTC_SYMBOL,"4h",from,END),all=[],errors=[];
  for(const t of universe){
    try{
      const [oneHour,fourHour,fifteenMinute,fiveMinute]=await Promise.all([candles(t.symbol,"1h",from,END),candles(t.symbol,"4h",from,END),candles(t.symbol,"15m",from,END),candles(t.symbol,"5m",from,END)]);
      if(oneHour.length<100||fourHour.length<60||fifteenMinute.length<120||fiveMinute.length<1000)throw new Error("Insufficient candles");
      const data={symbol:t.symbol,oneHour,fourHour,fifteenMinute,fiveMinute};
      const periods={};for(const days of [90,180]){const start=END-days*86400000,r=await run(data,btc,start,END);periods[days]={period:{from:new Date(start).toISOString(),to:new Date(END).toISOString(),days},...r};}
      all.push({symbol:t.symbol,periods});
      console.log("completed",t.symbol);
    }catch(e){errors.push({symbol:t.symbol,error:String(e?.message||e)});console.error("failed",t.symbol,String(e?.message||e));}
  }
  const report={generatedAt:new Date().toISOString(),engine:"V4.8 experimental (src/index.js)",side:"SHORT only",rules:{marginUsd:MARGIN,leverage:LEVERAGE,targetMarginPercent:TARGET_MARGIN,priceMoveTargetPercent:3,fullCloseAtTarget:true,partialTakeProfits:false,stopFirstSame5mCandle:true,entry:"signal after closed 1h/4h/15m candles; enter at next 1h open; evaluate exits using 5m OHLC",feesAndFunding:"excluded from win/stop classification and PnL",universe:"top 10 current-volume eligible Kraken crypto USD perpetuals; current-volume survivorship bias applies"},symbolsRequested:LIMIT,symbolsTested:all.length,errors,results:all};
  await mkdir("artifacts",{recursive:true});await writeFile("artifacts/v48-short-30pct.json",JSON.stringify(report,null,2));
  const fmt=n=>Number(n||0).toFixed(2),lines=["# V4.8 SHORT-only backtest — 30% margin target","","Target: +30% margin return = +3% favorable price move; $10 margin, 10x; full close; no TP1/TP2/TP3.","Same 5m candle touching stop and target is counted as stop first.","","| Period | Signals | Closed | Wins | Stops | Open | Win rate | Gross PnL | PF | Max DD |","|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|"];
  for(const days of [90,180]){const m=all.flatMap(x=>x.periods[days].trades),c={eligible:all.reduce((s,x)=>s+x.periods[days].counts.eligible,0),rejected:0,lockSkips:all.reduce((s,x)=>s+x.periods[days].counts.lockSkips,0)},x=metrics(m,c),o=all.flatMap(z=>z.periods[days].trades);lines.push("| "+days+" days | "+x.signals+" | "+x.closed+" | "+x.wins+" | "+x.stops+" | "+x.openAtEnd+" | "+fmt(x.winRatePct)+"% | $"+fmt(x.grossPnlUsd)+" | "+fmt(x.profitFactor)+" | $"+fmt(x.maxDrawdownUsd)+" |");}
  lines.push("","## Per-symbol breakdown","","| Symbol | 90d signals | 90d wins | 90d stops | 90d win% | 180d signals | 180d wins | 180d stops | 180d win% |","|---|---:|---:|---:|---:|---:|---:|---:|---:|");
  for(const x of all){const a=x.periods[90].metrics,b=x.periods[180].metrics;lines.push("| "+x.symbol+" | "+a.signals+" | "+a.wins+" | "+a.stops+" | "+fmt(a.winRatePct)+"% | "+b.signals+" | "+b.wins+" | "+b.stops+" | "+fmt(b.winRatePct)+"% |");}
  lines.push("","Limitations: Kraken historical data; only 10 symbols selected by current volume; survivorship bias; funding, fees, slippage, liquidation and cross-position margin competition excluded. The 5m OHLC same-candle rule is conservative stop-first. Open-at-end trades are not counted as wins or stops.");
  await writeFile("artifacts/v48-short-30pct.md",lines.join("\n"));console.log(JSON.stringify(report,null,2));if(!all.length)process.exitCode=1;
}
main().catch(e=>{console.error(e);process.exitCode=1;});

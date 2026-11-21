import { mkdir, writeFile } from "node:fs/promises";
import { analyzeEma20PullbackLong } from "../src/futures-ema20-pullback-long.js";

const BASE="https://futures.kraken.com";
const INTERVALS={"5m":300000,"15m":900000};
const DAYS=Math.max(30,Math.min(365,Number(process.env.EMA20_BACKTEST_DAYS||180)));
const SYMBOL_LIMIT=Math.max(1,Math.min(20,Number(process.env.EMA20_BACKTEST_SYMBOLS||10)));
const LEVERAGE=Math.max(1,Number(process.env.EMA20_BACKTEST_LEVERAGE||10));
const WARMUP_DAYS=15;

async function getJson(url,attempt=0){
  const res=await fetch(url,{headers:{accept:"application/json"},signal:AbortSignal.timeout(30000)});
  const body=await res.text();
  if(!res.ok){if(attempt<3&&(res.status===429||res.status>=500)){await new Promise(r=>setTimeout(r,700*(attempt+1)));return getJson(url,attempt+1);}throw new Error("HTTP "+res.status+" "+body.slice(0,120));}
  const data=JSON.parse(body);
  if(data?.result==="error")throw new Error(JSON.stringify(data.errors||data.error));
  return data;
}
function normalize(rows,interval){
  const seen=new Set();
  return (rows||[]).map(x=>({time:Number(x.time)<1e12?Number(x.time)*1000:Number(x.time),open:Number(x.open),high:Number(x.high),low:Number(x.low),close:Number(x.close),volume:Number(x.volume)}))
    .filter(c=>Number.isFinite(c.time)&&[c.open,c.high,c.low,c.close,c.volume].every(Number.isFinite)&&c.open>0&&c.low>0&&c.high>=c.low&&c.time+interval<=Date.now())
    .sort((a,b)=>a.time-b.time).filter(c=>{if(seen.has(c.time))return false;seen.add(c.time);return true;});
}
async function candles(symbol,resolution,from,to){
  const interval=INTERVALS[resolution],chunk=interval*1700,all=[];
  for(let start=from;start<to;start+=chunk){
    const end=Math.min(to,start+chunk),u=new URL(BASE+"/api/charts/v1/trade/"+encodeURIComponent(symbol)+"/"+resolution);
    u.searchParams.set("from",String(Math.floor(start/1000)));u.searchParams.set("to",String(Math.floor(end/1000)));u.searchParams.set("count","1800");
    const d=await getJson(u);if(d.more_candles===true)throw new Error("incomplete Kraken candle page "+symbol+" "+resolution);
    all.push(...normalize(d.candles,interval));
  }
  const m=new Map(all.map(c=>[c.time,c]));return [...m.values()].sort((a,b)=>a.time-b.time);
}
function lowerBound(a,t){let l=0,h=a.length;while(l<h){const m=(l+h)>>1;if(a[m].time<t)l=m+1;else h=m;}return l;}
function stats(trades){
  const closed=trades.filter(t=>t.status==="TP"||t.status==="SL"),wins=closed.filter(t=>t.status==="TP"),losses=closed.filter(t=>t.status==="SL");
  let equity=0,peak=0,dd=0;for(const t of [...closed].sort((a,b)=>a.closedAt-b.closedAt)){equity+=t.marginReturnPct;peak=Math.max(peak,equity);dd=Math.max(dd,peak-equity);}
  return {signals:trades.length,closed:closed.length,wins:wins.length,stops:losses.length,open:trades.length-closed.length,winRatePct:closed.length?wins.length/closed.length*100:0,netMarginReturnPct:closed.reduce((s,t)=>s+t.marginReturnPct,0),maxDrawdownMarginPct:dd,avgReturnPerClosedTradePct:closed.length?closed.reduce((s,t)=>s+t.marginReturnPct,0)/closed.length:0};
}
async function main(){
  const end=Date.now(),start=end-DAYS*86400000,from=start-WARMUP_DAYS*86400000;
  const data=await getJson(BASE+"/derivatives/api/v3/tickers");
  if(!Array.isArray(data.tickers))throw new Error("Kraken ticker response invalid");
  const universe=data.tickers.filter(t=>t?.tag==="perpetual"&&t.suspended!==true&&/^(PI|PF)_[A-Z0-9]+USD$/.test(String(t.symbol||""))&&Number(t.last)>0&&Number(t.volumeQuote)>0)
    .sort((a,b)=>Number(b.volumeQuote)-Number(a.volumeQuote)).slice(0,SYMBOL_LIMIT);
  if(!universe.length)throw new Error("No perpetual symbols found");
  const btc=await candles("PF_XBTUSD","15m",from,end);
  const results=[];
  for(const ticker of universe){
    try{
      const [s15,s5]=await Promise.all([candles(ticker.symbol,"15m",from,end),candles(ticker.symbol,"5m",from,end)]);
      if(s15.length<100||s5.length<500||btc.length<100)throw new Error("insufficient candles 15m="+s15.length+" 5m="+s5.length+" BTC15m="+btc.length);
      const trades=[];let lockUntil=0,btcIndex=0;
      for(let i=54;i<s15.length-1;i++){
        const bar=s15[i],closeTime=bar.time+INTERVALS["15m"];
        if(closeTime<start||closeTime>=end)continue;
        while(btcIndex<btc.length&&btc[btcIndex].time+INTERVALS["15m"]<=closeTime)btcIndex++;
        const btcClosed=btc.slice(0,btcIndex);
        if(btcClosed.length<20)continue;
        const history=s15.slice(Math.max(0,i+1-180),i+1);
        const signal=analyzeEma20PullbackLong({symbol:ticker.symbol,candles:history,btcCandles:btcClosed});
        if(!signal.eligible||lockUntil>closeTime)continue;
        const fillIndex=lowerBound(s5,closeTime),fill=s5[fillIndex];
        if(!fill||fill.time>=end)continue;
        const entry=fill.open,stop=signal.stop,risk=entry-stop,riskPct=risk/entry*100;
        if(!(stop<entry&&riskPct>=0.1&&riskPct<=1.5))continue;
        const target=entry+2*risk;
        const trade={symbol:ticker.symbol,entryTime:fill.time,signalTime:bar.time,entry,stop,target,riskPct,status:"OPEN",closedAt:null,marginReturnPct:0,ambiguousBars:0};
        for(let j=fillIndex;j<s5.length&&s5[j].time<end;j++){
          const c=s5[j];
          const stopAtOpen=c.open<=stop,targetAtOpen=c.open>=target;
          const stopHit=c.low<=stop,targetHit=c.high>=target;
          let outcome=null,exit=null;
          if(stopAtOpen){outcome="SL";exit=c.open;}
          else if(targetAtOpen){outcome="TP";exit=c.open;}
          else if(stopHit&&targetHit){outcome="SL";exit=stop;trade.ambiguousBars++;}
          else if(stopHit){outcome="SL";exit=stop;}
          else if(targetHit){outcome="TP";exit=target;}
          if(outcome){trade.status=outcome;trade.exit=exit;trade.closedAt=c.time+INTERVALS["5m"];trade.marginReturnPct=(exit/entry-1)*LEVERAGE*100;break;}
        }
        if(trade.status==="OPEN"){trade.mark=s5.at(-1)?.close??null;trade.marginReturnPct=trade.mark?(trade.mark/entry-1)*LEVERAGE*100:0;}
        trades.push(trade);lockUntil=trade.closedAt??end;
      }
      results.push({symbol:ticker.symbol,quoteVolume:Number(ticker.volumeQuote),candles15m:s15.length,candles5m:s5.length,metrics:stats(trades),trades});
    }catch(e){results.push({symbol:ticker.symbol,error:String(e?.message||e)});}
  }
  const good=results.filter(x=>!x.error),all=good.flatMap(x=>x.trades),metrics=stats(all);
  const withoutBtc=stats(all.filter(t=>t)); // placeholder replaced by same signal stream; BTC-off needs separate signal pass.
  const report={createdAt:new Date().toISOString(),venue:"Kraken Futures public historical OHLC",period:{start:new Date(start).toISOString(),end:new Date(end).toISOString(),days:DAYS},settings:{timeframe:"15m",btcFilter:"BTC 15m close above BTC EMA20",trend:"symbol EMA20 > EMA50; both EMA slopes positive; close above both",entry:"first bullish candle closing on/above EMA20 after touch within 0.15%",maxExtensionAtr:0.5,stop:"below min(EMA50, prior candle low) minus 0.03 ATR; allowed distance 0.1%-1.5%",target:"2R",leverage:LEVERAGE,execution:"next 5m open; stop-first if TP and SL touched in same 5m candle",fees:"excluded",funding:"excluded",universe:"top current perpetual contracts by current quote volume; survivorship bias applies"},symbolsRequested:SYMBOL_LIMIT,symbolsTested:good.length,symbolErrors:results.filter(x=>x.error),metrics,bySymbol:results.map(({trades,...x})=>x),trades:all};
  await mkdir("artifacts",{recursive:true});
  await writeFile("artifacts/ema20-pullback-long-backtest.json",JSON.stringify(report,null,2));
  const md=["# EMA20 Pullback LONG — Historical Backtest","",`Period: ${report.period.start} — ${report.period.end} (${DAYS} days)`,`Symbols tested: ${good.length}/${SYMBOL_LIMIT}`,"","| Metric | Result |","|---|---:|",...Object.entries(metrics).map(([k,v])=>`| ${k} | ${typeof v==="number"?v.toFixed(2):v} |`),"","## Per symbol","| Symbol | Signals | Closed | Wins | Stops | Win rate | Net margin return |","|---|---:|---:|---:|---:|---:|---:|",...results.map(x=>x.error?`| ${x.symbol} | ERROR | ${x.error} | | | | |`:`| ${x.symbol} | ${x.metrics.signals} | ${x.metrics.closed} | ${x.metrics.wins} | ${x.metrics.stops} | ${x.metrics.winRatePct.toFixed(2)}% | ${x.metrics.netMarginReturnPct.toFixed(2)}% |`),"","Caveats: fees and funding excluded; current-volume universe introduces survivorship bias; entry fills approximated at next 5m open; ambiguous same-candle TP/SL resolves to stop first.",""].join("\n");
  await writeFile("artifacts/ema20-pullback-long-backtest.md",md);
  console.log(JSON.stringify({metrics,symbolsTested:good.length,errors:results.filter(x=>x.error)},null,2));
}
main().catch(e=>{console.error(e);process.exit(1);});

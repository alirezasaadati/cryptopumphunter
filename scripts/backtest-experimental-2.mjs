import { mkdir, writeFile } from "node:fs/promises";

const BASE = "https://futures.kraken.com";
const END = Number(process.env.BACKTEST_END_MS || 1795527325576);
const DAYS = Number(process.env.BACKTEST_DAYS || 30);
const START = END - DAYS * 86400000;
const FROM = START - 15 * 86400000;
const LEVERAGE = 10, INITIAL = 100, MARGIN = 10;
const INTERVAL = { "5m": 300000, "15m": 900000 };

async function getJson(url) {
  const r = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(30000) });
  const t = await r.text();
  if (!r.ok) throw new Error("HTTP " + r.status + " " + t.slice(0,200));
  const j = JSON.parse(t);
  if (j.result === "error" || j.errors?.length) throw new Error(JSON.stringify(j.errors || j.error));
  return j;
}
function normalize(rows, ms) {
  const seen = new Set();
  return (rows || []).map(x => ({time:Number(x.time)<1e12?Number(x.time)*1000:Number(x.time),
    open:+x.open,high:+x.high,low:+x.low,close:+x.close,volume:+x.volume}))
    .filter(x=>Number.isFinite(x.time)&&[x.open,x.high,x.low,x.close,x.volume].every(Number.isFinite)&&x.close>0&&x.low>0&&x.high>=x.low&&x.time+ms<=END)
    .sort((a,b)=>a.time-b.time).filter(x=>{if(seen.has(x.time))return false;seen.add(x.time);return true;});
}
async function candles(symbol,tf) {
  const ms=INTERVAL[tf], chunk=ms*1700, out=[];
  for(let s=FROM;s<END;s+=chunk){
    const e=Math.min(END,s+chunk),u=new URL(BASE+"/api/charts/v1/trade/"+symbol+"/"+tf);
    u.searchParams.set("from",String(Math.floor(s/1000)));u.searchParams.set("to",String(Math.floor(e/1000)));u.searchParams.set("count","1800");
    const j=await getJson(u);if(j.more_candles===true)throw new Error(symbol+" "+tf+" incomplete candles");
    out.push(...normalize(j.candles,ms));
  }
  const m=new Map(out.map(x=>[x.time,x]));return [...m.values()].sort((a,b)=>a.time-b.time);
}
function indicators(a){
  const ema=(period)=>{let v=a[0].close,alpha=2/(period+1),out=[];for(let i=0;i<a.length;i++){v=i===0?a[i].close:a[i].close*alpha+v*(1-alpha);out.push(v);}return out;};
  const e9=ema(9),e21=ema(21),e50=ema(50),rsi=[],atr=[];
  let ag=0,al=0,avgCount=0,at=0,trCount=0;
  for(let i=0;i<a.length;i++){
    const d=i?a[i].close-a[i-1].close:NaN,g=Math.max(0,d),l=Math.max(0,-d);
    if(i>0){if(avgCount===0){ag=g;al=l;}else{ag=(1/14)*g+(13/14)*ag;al=(1/14)*l+(13/14)*al;}avgCount++;}
    rsi.push(avgCount<14||al===0?NaN:100-100/(1+ag/al));
    const tr=i===0?a[i].high-a[i].low:Math.max(a[i].high-a[i].low,Math.abs(a[i].high-a[i-1].close),Math.abs(a[i].low-a[i-1].close));
    if(trCount===0)at=tr;else at=(1/14)*tr+(13/14)*at;
    trCount++;atr.push(trCount<14?NaN:at);
  }
  return a.map((c,i)=>({...c,ema9:e9[i],ema21:e21[i],ema50:e50[i],rsi:rsi[i],atr:atr[i]}));
}
function lowerBound(a,t){let l=0,h=a.length;while(l<h){let m=(l+h)>>1;if(a[m].time<t)l=m+1;else h=m;}return l;}
function portfolio(trades){
  const events=[];for(const t of trades){events.push({time:t.entryTime,type:0,t});if(t.closedAt)events.push({time:t.closedAt,type:1,t});}
  events.sort((a,b)=>a.time-b.time||b.type-a.type);
  let free=INITIAL,used=0,realized=0,peak=INITIAL,dd=0,active=new Map(),accepted=0,skipped=0,maxOpen=0;const acceptedIds=[],skippedIds=[];
  for(const e of events){const t=e.t;if(e.type===0){if(free<MARGIN){skipped++;skippedIds.push(t.id);continue;}free-=MARGIN;used+=MARGIN;active.set(t.id,t);accepted++;acceptedIds.push(t.id);maxOpen=Math.max(maxOpen,active.size);}
    else if(active.has(t.id)){const pnl=MARGIN*t.marginReturnPct/100;free+=MARGIN+pnl;used-=MARGIN;realized+=pnl;active.delete(t.id);const eq=free+used;peak=Math.max(peak,eq);dd=Math.max(dd,peak-eq);}}
  let floating=0;for(const t of active.values())floating+=MARGIN*(t.markReturnPct||0)/100;
  return {initialCapitalUSD:INITIAL,marginPerTradeUSD:MARGIN,leverage:LEVERAGE,acceptedTrades:accepted,skippedForInsufficientFreeMargin:skipped,
    closedPositions:accepted-active.size,openPositionsAtEnd:active.size,realizedNetPnlUSD:+realized.toFixed(4),
    openPositionsMarkToMarketPnlUSD:+floating.toFixed(4),endingEquityUSD:+(free+used+floating).toFixed(4),
    netReturnPct:+((free+used+floating)/INITIAL*100-100).toFixed(4),maxDrawdownFromRealizedEquityUSD:+dd.toFixed(4),maxConcurrentPositions:maxOpen,acceptedTradeIds:acceptedIds,skippedTradeIds:skippedIds};
}
async function run(symbol){
  const [raw15,raw5]=await Promise.all([candles(symbol,"15m"),candles(symbol,"5m")]);
  if(raw15.length<150||raw5.length<1000)throw new Error("not enough data: 15m="+raw15.length+" 5m="+raw5.length);
  const bars=raw15,trades=[];let signalCount=0;
  for(let i=60;i<bars.length-1;i++){
    const window=indicators(raw15.slice(Math.max(0,i-249),i+1)),c=window.at(-1),p=window.at(-2),closeTime=c.time+INTERVAL["15m"];
    if(closeTime<START||closeTime>=END)continue;
    const up=p.ema9<=p.ema21&&c.ema9>c.ema21,down=p.ema9>=p.ema21&&c.ema9<c.ema21;
    let side=null;if(up&&c.close>c.ema50&&c.rsi>=50&&c.rsi<=70)side="LONG";
    else if(down&&c.close<c.ema50&&c.rsi>=30&&c.rsi<=50)side="SHORT";
    if(!side||!Number.isFinite(c.atr)||c.atr<=0)continue;
    signalCount++;const entry=c.close,dist=1.5*c.atr,stop=side==="LONG"?entry-dist:entry+dist,target=side==="LONG"?entry+3*c.atr:entry-3*c.atr;
    const t={id:symbol+":"+side+":"+c.time,symbol,side,entry,stop,target,entryTime:closeTime,signalTime:c.time,status:"OPEN"};
    const dir=side==="LONG"?1:-1;let ix=lowerBound(raw5,closeTime),closed=false;
    for(;ix<raw5.length&&raw5[ix].time<END;ix++){
      const b=raw5[ix],stopHit=side==="LONG"?b.low<=stop:b.high>=stop,targetHit=side==="LONG"?b.high>=target:b.low<=target;
      if(stopHit||targetHit){
        const stopGap=side==="LONG"?b.open<=stop:b.open>=stop,targetGap=side==="LONG"?b.open>=target:b.open<=target;
        let exit,reason;if(stopHit&&(targetHit||!targetHit)){exit=stopGap?b.open:stop;reason="STOP";if(targetGap&&!stopGap){exit=b.open;reason="TARGET";}}
        else{exit=targetGap?b.open:target;reason="TARGET";}
        t.exit=exit;t.closeReason=reason;t.closedAt=b.time+INTERVAL["5m"];t.status="CLOSED";
        t.marginReturnPct=dir*((exit-entry)/entry)*100*LEVERAGE;closed=true;break;
      }
    }
    if(!closed){t.status="OPEN_AT_END";t.mark=raw5.at(-1).close;t.markReturnPct=dir*((t.mark-entry)/entry)*100*LEVERAGE;}
    trades.push(t);
  }
  return {symbol,candles15m:raw15.length,candles5m:raw5.length,signalCount,trades};
}
async function main(){
  const symbols=String(process.env.BACKTEST_SYMBOLS||"PF_XBTUSD,PF_ETHUSD").split(",").filter(Boolean);
  const results=[];for(const s of symbols){try{results.push(await run(s));}catch(e){results.push({symbol:s,error:String(e)});}}
  const good=results.filter(x=>!x.error),trades=good.flatMap(x=>x.trades).sort((a,b)=>(a.closedAt||END+1)-(b.closedAt||END+1));
  const portfolioResult=portfolio(trades),executedIds=new Set(portfolioResult.acceptedTradeIds),executed=trades.filter(t=>executedIds.has(t.id));
  const closed=executed.filter(t=>t.status==="CLOSED"),wins=closed.filter(t=>t.marginReturnPct>0),stops=closed.filter(t=>t.closeReason==="STOP");
  const report={name:"experimental-2",venue:"Kraken Futures public OHLC candles",period:{from:new Date(START).toISOString(),to:new Date(END).toISOString(),days:DAYS,warmupDays:15},
    rules:{timeframe:"15m",signals:"EMA9/EMA21 crossover; LONG close>EMA50 and RSI 50-70; SHORT close<EMA50 and RSI 30-50",
      stop:"1.5x ATR",target:"3.0x ATR (2R)",entry:"signal candle close",exitCandles:"5m OHLC, stop-first on same-candle ambiguity",
      leverage:LEVERAGE,marginPerTradeUSD:MARGIN,fees:"excluded",funding:"excluded",sameSymbolOverlap:"not blocked; every crossover emits a signal, and the $100 portfolio margin cap controls concurrent trades"},
    portfolio:portfolioResult,metrics:{signals:good.reduce((n,x)=>n+x.signalCount,0),tradesStarted:executed.length,closedTrades:closed.length,
      targetCloses:closed.filter(t=>t.closeReason==="TARGET").length,stopCloses:stops.length,losingStops:stops.filter(t=>t.marginReturnPct<0).length,
      positiveStopCloses:stops.filter(t=>t.marginReturnPct>0).length,netPositiveClosedTrades:wins.length,
      netNegativeClosedTrades:closed.filter(t=>t.marginReturnPct<0).length,winRatePct:closed.length?100*wins.length/closed.length:0,
      totalMarginReturnPct:closed.reduce((n,t)=>n+t.marginReturnPct,0),openAtEnd:executed.length-closed.length,skippedForInsufficientFreeMargin:portfolioResult.skippedForInsufficientFreeMargin},
    bySymbol:good.map(x=>{const ts=x.trades.filter(t=>executedIds.has(t.id));return {symbol:x.symbol,signals:x.signalCount,trades:ts.length,closed:ts.filter(t=>t.status==="CLOSED").length,
      wins:ts.filter(t=>t.status==="CLOSED"&&t.marginReturnPct>0).length,stops:ts.filter(t=>t.closeReason==="STOP").length,
      netMarginReturnPct:ts.filter(t=>t.status==="CLOSED").reduce((n,t)=>n+t.marginReturnPct,0)};}),
    symbolErrors:results.filter(x=>x.error),trades};
  await mkdir("artifacts",{recursive:true});await writeFile("artifacts/experimental-2-backtest.json",JSON.stringify(report,null,2));
  await writeFile("artifacts/experimental-2-backtest.md",["# Experimental 2 backtest","",JSON.stringify({period:report.period,portfolio:report.portfolio,metrics:report.metrics,bySymbol:report.bySymbol,symbolErrors:report.symbolErrors},null,2)].join("\n"));
  console.log(JSON.stringify({period:report.period,portfolio:report.portfolio,metrics:report.metrics,bySymbol:report.bySymbol,symbolErrors:report.symbolErrors},null,2));
  if(!good.length)process.exitCode=1;
}
main().catch(e=>{console.error(e);process.exitCode=1;});

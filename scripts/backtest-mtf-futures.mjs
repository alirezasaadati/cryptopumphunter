import { mkdir, writeFile } from "node:fs/promises";
import { classifyMarket, buildMtfSignal } from "../src/mtf-futures-engine.js";
const BASE="https://futures.kraken.com", M15=900000, H1=3600000, H4=14400000;
const DAYS=Math.max(30,Math.min(90,Number(process.env.BACKTEST_DAYS||90)));
const LIMIT=Math.max(5,Math.min(20,Number(process.env.BACKTEST_SYMBOLS||10)));
const FEE=Number(process.env.BACKTEST_FEE??0.0005), SLIP=Number(process.env.BACKTEST_SLIPPAGE??0.0003);
const MAX_HOLD=96, LEVERAGE=10, TARGET_MARGIN_ROI=.25;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function json(url){let last;for(let n=0;n<4;n++){try{const r=await fetch(url,{headers:{accept:"application/json"},signal:AbortSignal.timeout(30000)});const t=await r.text();if(!r.ok)throw Error("HTTP "+r.status+" "+t.slice(0,120));const d=JSON.parse(t);if(d?.result==="error"||d?.errors?.length)throw Error(JSON.stringify(d.errors||d.error));return d;}catch(e){last=e;await sleep(400*(n+1));}}throw last;}
function norm(rows,ms){const seen=new Set();return(rows||[]).map(x=>({time:Number(x.time)<1e12?Number(x.time)*1000:Number(x.time),open:+x.open,high:+x.high,low:+x.low,close:+x.close,volume:+x.volume})).filter(x=>[x.time,x.open,x.high,x.low,x.close,x.volume].every(Number.isFinite)&&x.open>0&&x.low>0&&x.high>=x.low&&x.close>0&&x.volume>=0&&x.time+ms<=Date.now()).sort((a,b)=>a.time-b.time).filter(x=>{if(seen.has(x.time))return false;seen.add(x.time);return true;});}
async function candles(symbol,res,from,to,interval){const out=[],step=1900*interval;for(let a=from;a<to;a+=step){const b=Math.min(to,a+step),u=new URL(BASE+"/api/charts/v1/trade/"+encodeURIComponent(symbol)+"/"+res);u.searchParams.set("from",String(Math.floor(a/1000)));u.searchParams.set("to",String(Math.floor(b/1000)));u.searchParams.set("count","2000");const d=await json(u);if(d.more_candles===true)throw Error(symbol+" "+res+" pagination overflow");out.push(...norm(d.candles,interval));await sleep(90);}const m=new Map(out.map(x=>[x.time,x]));return[...m.values()].sort((a,b)=>a.time-b.time);}
function lastClosed(a,t,iv){let lo=0,hi=a.length;while(lo<hi){const m=(lo+hi)>>1;if(a[m].time+iv<=t)lo=m+1;else hi=m;}return lo;}
function fixedTarget(entry,side){const d=side==="LONG"?1:-1,q=TARGET_MARGIN_ROI/LEVERAGE,ratio=d===1?(1+FEE+q)/(1-FEE):(1-FEE-q)/(1+FEE);return entry*ratio/(1-d*SLIP);}
function stats(ts){const w=ts.filter(x=>x.netR>0),l=ts.filter(x=>x.netR<0),gw=w.reduce((s,x)=>s+x.netR,0),gl=-l.reduce((s,x)=>s+x.netR,0);let eq=0,peak=0,dd=0;for(const t of ts){eq+=t.netR;peak=Math.max(peak,eq);dd=Math.max(dd,peak-eq);}return{trades:ts.length,wins:w.length,losses:l.length,winRatePct:ts.length?100*w.length/ts.length:0,netR:ts.reduce((s,x)=>s+x.netR,0),expectancyR:ts.length?ts.reduce((s,x)=>s+x.netR,0)/ts.length:0,profitFactor:gl?gw/gl:gw?null:0,maxDrawdownR:dd,averageMarginRoiPct:ts.length?ts.reduce((s,x)=>s+x.marginRoiPct,0)/ts.length:0,totalMarginRoiPct:ts.reduce((s,x)=>s+x.marginRoiPct,0)};}
async function main(){
 const end=Date.now(),start=end-DAYS*86400000,warm=start-30*86400000,td=await json(BASE+"/derivatives/api/v3/tickers");
 const excluded=new Set(["PF_NVDAXUSD","PF_MSTRXUSD","PF_XAGUSD","PF_XAUUSD","PF_SPXUSD","PF_NQUSD","PF_US500USD","PF_UK100USD","PF_BRENTUSD","PF_WTIUSD"]);
 const universe=(td.tickers||[]).filter(t=>t?.tag==="perpetual"&&t.suspended!==true&&/^(PI|PF)_[A-Z0-9]+USD$/.test(String(t.symbol||""))&&!excluded.has(String(t.symbol))&&+t.volumeQuote>0&&+t.last>0).sort((a,b)=>+b.volumeQuote-+a.volumeQuote).slice(0,LIMIT);
 if(!universe.length)throw Error("No Kraken perpetual symbols found");
 const symbols=[...new Set(["PF_XBTUSD",...universe.map(x=>x.symbol)])],data={};
 for(const s of symbols){try{data[s]={m15:await candles(s,"15m",warm,end,M15),h1:await candles(s,"1h",warm,end,H1),h4:await candles(s,"4h",warm,end,H4)};console.log("loaded",s,data[s].m15.length,data[s].h1.length,data[s].h4.length);}catch(e){console.log("data error",s,e.message);data[s]={error:e.message};}}
 const valid=universe.map(x=>x.symbol).filter(s=>data[s]?.m15?.length&&data[s]?.h1?.length&&data[s]?.h4?.length),btc=data.PF_XBTUSD?.h4||[];
 if(valid.length<3||btc.length<55)throw Error("Insufficient data; valid symbols="+valid.length);
 const all=[],active={},nextAllowed={},idx=Object.fromEntries(valid.map(s=>[s,0]));let ambiguousBars=0;
 const timeline=[...new Set(valid.flatMap(s=>data[s].m15.filter(c=>c.time>=start&&c.time<end).map(c=>c.time)))].sort((a,b)=>a-b);
 for(const time of timeline){for(const s of valid){const arr=data[s].m15;while(idx[s]<arr.length&&arr[idx[s]].time<time)idx[s]++;const j=idx[s];if(j>=arr.length||arr[j].time!==time)continue;const b=arr[j];
  if(active[s]){const p=active[s],d=p.side==="LONG"?1:-1,stopHit=d===1?(b.open<=p.stop||b.low<=p.stop):(b.open>=p.stop||b.high>=p.stop),targetHit=d===1?b.high>=p.targetPrice:b.low<=p.targetPrice;if(stopHit&&targetHit) {p.ambiguousBars++;ambiguousBars++;}
   if(stopHit){const px=(d===1&&b.open<=p.stop)||(d===-1&&b.open>=p.stop)?b.open:p.stop,fill=px*(1-d*SLIP);p.netR+=d*(fill-p.entry)/p.risk-FEE*(p.entry+fill)/p.risk;p.exitReason="STOP";}
   else if(targetHit){const fill=p.targetPrice*(1-d*SLIP);p.netR+=d*(fill-p.entry)/p.risk-FEE*(p.entry+fill)/p.risk;p.exitReason="MARGIN_ROI_TARGET";}
   else if(time-p.entryTime>=MAX_HOLD*M15){const fill=b.close*(1-d*SLIP);p.netR+=d*(fill-p.entry)/p.risk-FEE*(p.entry+fill)/p.risk;p.exitReason="TIME_EXIT";}
   if(p.exitReason){p.exitTime=time;p.marginRoiPct=p.netR*(p.risk/p.entry)*LEVERAGE*100;all.push(p);delete active[s];nextAllowed[s]=time+M15;}continue;
  }
  if(time<(nextAllowed[s]||0))continue;
  const decision=time+M15,i15=lastClosed(arr,decision,M15),h1=data[s].h1,ih=lastClosed(h1,decision,H1),h4=data[s].h4,i4=lastClosed(h4,decision,H4),ib=lastClosed(btc,decision,H4);
  if(i15<40||ih<60||i4<55||ib<55)continue;
  const breadth=valid.map(sym=>{const a=data[sym].h4,k=lastClosed(a,decision,H4);return{symbol:sym,candles:k>=55?a.slice(0,k):[]};}).filter(x=>x.candles.length);
  const market=classifyMarket(btc.slice(0,ib),breadth);
  const signal=buildMtfSignal({symbol:s,market,candles1h:h1.slice(0,ih),candles15m:arr.slice(0,i15)});
  if(!signal)continue;
  const next=arr[j+1];if(!next)continue;const d=signal.side==="LONG"?1:-1,entry=next.open*(1+d*SLIP);
  // Preserve the live bot's 15m structural/ATR stop distance, translated to actual next-open fill.
  const shift=entry-signal.entry,stop=signal.stop+shift,risk=d===1?entry-stop:stop-entry,riskPct=risk/entry;
  if(!(risk>0)||riskPct<.002||riskPct>.08)continue;
  active[s]={symbol:s,side:signal.side,entry,stop,risk,targetPrice:fixedTarget(entry,signal.side),netR:0,entryTime:next.time,exitReason:null,ambiguousBars:0,marketRegime:market.regime};
 }}
 for(const p of Object.values(active)){const b=data[p.symbol].m15.at(-1),d=p.side==="LONG"?1:-1,fill=b.close*(1-d*SLIP);p.netR+=d*(fill-p.entry)/p.risk-FEE*(p.entry+fill)/p.risk;p.exitReason="END_OF_DATA";p.exitTime=b.time;p.marginRoiPct=p.netR*(p.risk/p.entry)*LEVERAGE*100;all.push(p);}
 all.sort((a,b)=>a.entryTime-b.entryTime);
 const report={generatedAt:new Date().toISOString(),engine:"4H BTC+market breadth / 1H live-bot strict EMA+RSI+volume direction / 15m live-bot swing+1.5ATR stop; fixed +25% net margin ROI target",period:{from:new Date(start).toISOString(),to:new Date(end).toISOString(),days:DAYS},universe:{requested:LIMIT,tested:valid.length,symbols:valid,btcSymbol:"PF_XBTUSD",selection:"current top quote-volume crypto perpetuals; survivorship/universe bias"},settings:{feePerSide:FEE,slippagePerSide:SLIP,leverage:LEVERAGE,targetNetMarginRoiPct:25,maxHold15mBars:MAX_HOLD,stop:"15m min/max of prior 7 candles vs 1.5*ATR14; fixed after entry",liveBotTargetsPreserved:"1.5R/2.5R/3.5R levels calculated for diagnostics; backtest exits full size at fixed +25% net margin ROI",moveToBreakeven:false,trailingStop:false,sameBarRule:"stop first",entry:"next 15m open after signal candle close; adverse slippage",funding:"excluded",marketRule:"BTC 4H EMA20/50 plus >=55% market breadth",symbolRule:"live bot strict 1H EMA20/50, close vs EMA20, RSI bands and volume >=0.75x"},overall:stats(all),sameBarAmbiguity:{bars:ambiguousBars,trades:all.filter(x=>x.ambiguousBars>0).length},exitReasons:Object.fromEntries([...new Set(all.map(x=>x.exitReason))].map(k=>[k,{count:all.filter(x=>x.exitReason===k).length,...stats(all.filter(x=>x.exitReason===k))}])),symbols:valid.map(s=>({symbol:s,...stats(all.filter(x=>x.symbol===s))})),trades:all,openAtEnd:Object.keys(active).length};
 await mkdir("artifacts",{recursive:true});await writeFile("artifacts/mtf-futures-backtest.json",JSON.stringify(report,null,2));
 const md=["# Revised MTF + live-bot risk logic backtest","",`Period: ${report.period.from} → ${report.period.to}`,`Symbols: ${valid.length}/${LIMIT} (${valid.join(", ")})`,"",`Trades: ${report.overall.trades}`,`Win rate: ${report.overall.winRatePct.toFixed(2)}%`,`Net R: ${report.overall.netR.toFixed(2)}`,`Expectancy: ${report.overall.expectancyR.toFixed(3)}R`,`Profit factor: ${report.overall.profitFactor===null?"n/a":report.overall.profitFactor.toFixed(3)}`,`Max DD: ${report.overall.maxDrawdownR.toFixed(2)}R`,`Average net margin ROI/trade: ${report.overall.averageMarginRoiPct.toFixed(2)}%`,"","No break-even stop move. Stop is fixed. Full exit at +25% net margin ROI, 10x leverage.","Funding excluded; current top-volume universe has survivorship bias; OHLC ambiguity resolves stop-first.",""].join("\n");
 await writeFile("artifacts/mtf-futures-backtest.md",md);console.log(JSON.stringify({ok:true,overall:report.overall,exitReasons:report.exitReasons,symbols:report.symbols,sameBarAmbiguity:report.sameBarAmbiguity},null,2));
}
main().catch(e=>{console.error(e);process.exitCode=1;});

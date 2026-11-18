import { mkdir, writeFile } from "node:fs/promises";
import { classifyMarket, buildMtfSignal } from "../src/mtf-futures-engine.js";
const BASE="https://futures.kraken.com", H1=3600000, H4=14400000;
const DAYS=Math.max(30,Math.min(90,Number(process.env.BACKTEST_DAYS||90)));
const LIMIT=Math.max(5,Math.min(20,Number(process.env.BACKTEST_SYMBOLS||10)));
const FEE=Number(process.env.BACKTEST_FEE??0.0005), SLIP=Number(process.env.BACKTEST_SLIPPAGE??0.0003);
const MAX_HOLD_HOURS=24, LEVERAGE=10, TARGET_MARGIN_ROI=.25;
const BTC="PF_XBTUSD";
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function json(url){let last;for(let n=0;n<4;n++){try{const r=await fetch(url,{headers:{accept:"application/json"},signal:AbortSignal.timeout(30000)});const t=await r.text();if(!r.ok)throw Error("HTTP "+r.status+" "+t.slice(0,120));const d=JSON.parse(t);if(d?.result==="error"||d?.errors?.length)throw Error(JSON.stringify(d.errors||d.error));return d;}catch(e){last=e;await sleep(400*(n+1));}}throw last;}
function norm(rows,ms){const seen=new Set();return(rows||[]).map(x=>({time:Number(x.time)<1e12?Number(x.time)*1000:Number(x.time),open:+x.open,high:+x.high,low:+x.low,close:+x.close,volume:+x.volume})).filter(x=>[x.time,x.open,x.high,x.low,x.close,x.volume].every(Number.isFinite)&&x.open>0&&x.low>0&&x.high>=x.low&&x.close>0&&x.volume>=0&&x.time+ms<=Date.now()).sort((a,b)=>a.time-b.time).filter(x=>{if(seen.has(x.time))return false;seen.add(x.time);return true;});}
async function candles(symbol,res,from,to,interval){const out=[],step=1900*interval;for(let a=from;a<to;a+=step){const b=Math.min(to,a+step),u=new URL(BASE+"/api/charts/v1/trade/"+encodeURIComponent(symbol)+"/"+res);u.searchParams.set("from",String(Math.floor(a/1000)));u.searchParams.set("to",String(Math.floor(b/1000)));u.searchParams.set("count","2000");const d=await json(u);if(d.more_candles===true)throw Error(symbol+" "+res+" pagination overflow");out.push(...norm(d.candles,interval));await sleep(90);}const m=new Map(out.map(x=>[x.time,x]));return[...m.values()].sort((a,b)=>a.time-b.time);}
function lastClosed(a,t,iv){let lo=0,hi=a.length;while(lo<hi){const m=(lo+hi)>>1;if(a[m].time+iv<=t)lo=m+1;else hi=m;}return lo;}
function fixedTarget(entry,side){const d=side==="LONG"?1:-1,q=TARGET_MARGIN_ROI/LEVERAGE,ratio=d===1?(1+FEE+q)/(1-FEE):(1-FEE-q)/(1+FEE);return entry*ratio/(1-d*SLIP);}
function stats(ts){const w=ts.filter(x=>x.netR>0),l=ts.filter(x=>x.netR<0),gw=w.reduce((s,x)=>s+x.netR,0),gl=-l.reduce((s,x)=>s+x.netR,0);let eq=0,peak=0,dd=0;for(const t of ts){eq+=t.netR;peak=Math.max(peak,eq);dd=Math.max(dd,peak-eq);}return{trades:ts.length,wins:w.length,losses:l.length,winRatePct:ts.length?100*w.length/ts.length:0,netR:ts.reduce((s,x)=>s+x.netR,0),expectancyR:ts.length?ts.reduce((s,x)=>s+x.netR,0)/ts.length:0,profitFactor:gl?gw/gl:gw?null:0,maxDrawdownR:dd,averageMarginRoiPct:ts.length?ts.reduce((s,x)=>s+x.marginRoiPct,0)/ts.length:0,totalMarginRoiPct:ts.reduce((s,x)=>s+x.marginRoiPct,0)};}
function closeTrade(p,raw,time,reason){const d=p.side==="LONG"?1:-1,fill=raw*(1-d*SLIP);p.netR+=d*(fill-p.entry)/p.risk-FEE*(p.entry+fill)/p.risk;p.exitReason=reason;p.exitTime=time;p.marginRoiPct=p.netR*(p.risk/p.entry)*LEVERAGE*100;return p;}
function inspectBar(p,b,time){const d=p.side==="LONG"?1:-1,stopHit=d===1?(b.open<=p.stop||b.low<=p.stop):(b.open>=p.stop||b.high>=p.stop),targetHit=d===1?b.high>=p.targetPrice:b.low<=p.targetPrice;if(stopHit&&targetHit){p.ambiguousBars++;}if(stopHit){const px=(d===1&&b.open<=p.stop)||(d===-1&&b.open>=p.stop)?b.open:p.stop;return closeTrade(p,px,time,"STOP");}if(targetHit)return closeTrade(p,p.targetPrice,time,"MARGIN_ROI_TARGET");if(time-p.entryTime>=MAX_HOLD_HOURS*H1)return closeTrade(p,b.close,time,"TIME_EXIT");return null;}
async function main(){
 const end=Date.now(),start=end-DAYS*86400000,warm=start-30*86400000,td=await json(BASE+"/derivatives/api/v3/tickers");
 const excluded=new Set(["PF_NVDAXUSD","PF_MSTRXUSD","PF_XAGUSD","PF_XAUUSD","PF_SPXUSD","PF_NQUSD","PF_US500USD","PF_UK100USD","PF_BRENTUSD","PF_WTIUSD"]);
 const universe=(td.tickers||[]).filter(t=>t?.tag==="perpetual"&&t.suspended!==true&&/^(PI|PF)_[A-Z0-9]+USD$/.test(String(t.symbol||""))&&!excluded.has(String(t.symbol))&&+t.volumeQuote>0&&+t.last>0).sort((a,b)=>+b.volumeQuote-+a.volumeQuote).slice(0,LIMIT);
 if(!universe.length)throw Error("No Kraken perpetual symbols found");
 const breadthSymbols=[...new Set(universe.map(x=>x.symbol))],data={};
 for(const s of breadthSymbols){try{data[s]={h4:await candles(s,"4h",warm,end,H4)};console.log("loaded breadth",s,data[s].h4.length);}catch(e){console.log("data error",s,e.message);data[s]={error:e.message};}}
 const btc1h=await candles(BTC,"1h",warm,end,H1),btc4h=data[BTC]?.h4?.length?data[BTC].h4:await candles(BTC,"4h",warm,end,H4);
 const valid=breadthSymbols.filter(s=>data[s]?.h4?.length>=55),btcIndex=btc4h;
 if(btc1h.length<60||btcIndex.length<55||valid.length<3)throw Error("Insufficient data for BTC 1H or 4H market breadth");
 const trades=[],timeline=btc1h.map((c,i)=>({c,i})).filter(x=>x.c.time>=start&&x.c.time<end);
 let active=null,ambiguousBars=0,nextAllowed=0;
 for(const {c:b,i:j} of timeline){
  const time=b.time;
  if(active){const closed=inspectBar(active,b,time);if(closed){trades.push(closed);active=null;nextAllowed=time+H1;}continue;}
  if(time<nextAllowed)continue;
  const decision=time,ih=lastClosed(btc1h,decision,H1),ib=lastClosed(btcIndex,decision,H4);
  if(ih<60||ib<55)continue;
  const breadth=valid.map(symbol=>{const a=data[symbol].h4,k=lastClosed(a,decision,H4);return{symbol,candles:k>=55?a.slice(0,k):[]};}).filter(x=>x.candles.length);
  const market=classifyMarket(btcIndex.slice(0,ib),breadth);
  const signal=buildMtfSignal({symbol:BTC,market,candles1h:btc1h.slice(0,ih)});
  if(!signal)continue;
  const d=signal.side==="LONG"?1:-1,entry=b.open*(1+d*SLIP),stop=signal.stop,risk=d===1?entry-stop:stop-entry,riskPct=risk/entry;
  if(!(risk>0)||riskPct<.002||riskPct>.08)continue;
  active={symbol:BTC,side:signal.side,entry,signalReferenceEntry:signal.entry,stop,risk,targetPrice:fixedTarget(entry,signal.side),netR:0,entryTime:time,exitReason:null,ambiguousBars:0,marketRegime:market.regime,target1:entry+d*risk*1.5,target2:entry+d*risk*2.5,target3:entry+d*risk*3.5};
  const closed=inspectBar(active,b,time);
  if(closed){trades.push(closed);active=null;nextAllowed=time+H1;}
 }
 if(active){const b=btc1h.at(-1);trades.push(closeTrade(active,b.close,b.time,"END_OF_DATA"));}
 trades.sort((a,b)=>a.entryTime-b.entryTime);ambiguousBars=trades.reduce((s,x)=>s+x.ambiguousBars,0);
 const report={generatedAt:new Date().toISOString(),engine:"BTC-only signals: 4H BTC + top-perpetual market breadth / 1H BTC direction, entry, structural stop and targets",period:{from:new Date(start).toISOString(),to:new Date(end).toISOString(),days:DAYS},universe:{requested:LIMIT,breadthSymbols:valid.length,symbols:valid,signalSymbols:[BTC],selection:"current top quote-volume Kraken crypto perpetuals for 4H market breadth; BTC is the only signal instrument"},settings:{feePerSide:FEE,slippagePerSide:SLIP,leverage:LEVERAGE,targetNetMarginRoiPct:25,maxHoldHours:MAX_HOLD_HOURS,stop:"fixed absolute level: prior 7 closed 1H candles vs 1.5*ATR14 on 1H",diagnosticTargets:"1.5R/2.5R/3.5R, all calculated from actual next-1H-open fill",sameBarRule:"stop first",entry:"next 1H open after previous 1H candle close; adverse slippage",funding:"excluded",marketRule:"BTC 4H EMA20/50 plus >=55% breadth",symbolRule:"BTC 1H EMA20/EMA50, close vs EMA20, RSI bands and volume >=0.75x"},overall:stats(trades),sameBarAmbiguity:{bars:ambiguousBars,trades:trades.filter(x=>x.ambiguousBars>0).length},exitReasons:Object.fromEntries([...new Set(trades.map(x=>x.exitReason))].map(k=>[k,{count:trades.filter(x=>x.exitReason===k).length,...stats(trades.filter(x=>x.exitReason===k))}])),trades,openAtEnd:active?1:0};
 await mkdir("artifacts",{recursive:true});await writeFile("artifacts/mtf-futures-backtest.json",JSON.stringify(report,null,2));
 const md=["# BTC-only 1H-entry MTF backtest","",`Period: ${report.period.from} → ${report.period.to}`,`Breadth symbols: ${valid.length} (${valid.join(", ")})`,"Signal symbol: PF_XBTUSD only","",`Trades: ${report.overall.trades}`,`Win rate: ${report.overall.winRatePct.toFixed(2)}%`,`Net R: ${report.overall.netR.toFixed(2)}`,`Expectancy: ${report.overall.expectancyR.toFixed(3)}R`,`Profit factor: ${report.overall.profitFactor===null?"n/a":report.overall.profitFactor.toFixed(3)}`,`Max DD: ${report.overall.maxDrawdownR.toFixed(2)}R`,`Average net margin ROI/trade: ${report.overall.averageMarginRoiPct.toFixed(2)}%`,"","Entry, stop and target calculations use 1H candles only. Entry is next 1H open; stop remains fixed. Full exit at +25% net margin ROI, 10x leverage.","Funding excluded; top-volume universe is used only for market breadth; OHLC ambiguity resolves stop-first.",""].join("\n");
 await writeFile("artifacts/mtf-futures-backtest.md",md);console.log(JSON.stringify({ok:true,signalSymbol:BTC,overall:report.overall,exitReasons:report.exitReasons,sameBarAmbiguity:report.sameBarAmbiguity},null,2));
}
main().catch(e=>{console.error(e);process.exitCode=1;});

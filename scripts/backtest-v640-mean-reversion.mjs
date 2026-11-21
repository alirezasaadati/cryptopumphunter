// Isolated v6.4.0 LONG mean-reversion historical backtest.
// Strategy rules below are a direct implementation of the user-supplied v6.4.0 logic.
// Only the execution harness (historical entry/exit, fees, reporting) is added.
import { mkdir, writeFile } from "node:fs/promises";

const CFG = { TARGET_1_R: 1.5, TARGET_2_R: 2.5, STOP_BUFFER_ATR: 0.2, MAX_RISK_PCT: 2.0, MIN_SCORE: 60 };
const BASE = "https://futures.kraken.com";
const H = 3600000, FEE = 0.0005, SLIP = 0.0003, MAX_HOLD = 72;
const SYMBOLS = (process.env.BACKTEST_SYMBOLS || "PF_XBTUSD,PF_ETHUSD,PF_SOLUSD,PF_XRPUSD,PF_DOGEUSD,PF_ADAUSD,PF_LINKUSD,PF_LTCUSD,PF_BCHUSD,PF_AVAXUSD").split(",");
const PERIODS = [
  { name: "2024-10-01_to_2024-12-01", from: "2024-10-01T00:00:00Z", to: "2024-12-01T00:00:00Z" },
  { name: "2025-04-01_to_2025-06-01", from: "2025-04-01T00:00:00Z", to: "2025-06-01T00:00:00Z" }
];
function ema(values, period) {
  if (values.length < period) return null;
  const k=2/(period+1); let v=values.slice(0,period).reduce((a,b)=>a+b,0)/period;
  for(let i=period;i<values.length;i++) v=values[i]*k+v*(1-k);
  return v;
}
function rsi(values, period=14) {
  if(values.length<=period) return null;
  let gains=0,losses=0;
  for(let i=1;i<=period;i++){const d=values[i]-values[i-1];gains+=Math.max(d,0);losses+=Math.max(-d,0);}
  let ag=gains/period,al=losses/period;
  for(let i=period+1;i<values.length;i++){const d=values[i]-values[i-1];ag=(ag*(period-1)+Math.max(d,0))/period;al=(al*(period-1)+Math.max(-d,0))/period;}
  if(al===0)return 100;if(ag===0)return 0;return 100-100/(1+ag/al);
}
function average(a){return a.length?a.reduce((x,y)=>x+y,0)/a.length:0;}
function calculateAtr(c,period=14){
  if(c.length<=period)return null;const ranges=[];
  for(let i=1;i<c.length;i++){const x=c[i],p=c[i-1].close;ranges.push(Math.max(x.high-x.low,Math.abs(x.high-p),Math.abs(x.low-p)));}
  const recent=ranges.slice(-period);return recent.length===period?average(recent):null;
}
// Exact v6.4.0 signal decision logic; ticker.last is supplied as next 1h open for no-lookahead entry proxy.
function analyzeLongMeanReversion(ticker,candles1h){
  if(candles1h.length<200)throw Error("insufficient 200 candles");
  const closes=candles1h.map(c=>c.close),last=candles1h.at(-1),prev=candles1h.at(-2);
  const e20=ema(closes,20),e200=ema(closes,200),rv=rsi(closes,14),atr=calculateAtr(candles1h,14);
  if([e20,e200,rv,atr].some(v=>!Number.isFinite(v)))throw Error("invalid indicators");
  if(rv>35)return {rejected:"RSI above 35"};
  const distance=(last.close-e200)/e200*100;
  if(distance>1.0)return {rejected:"not near EMA200"};
  if(!(last.close>last.open) || !(last.close>prev.high))return {rejected:"no reclaim"};
  let score=70;if(rv<25)score+=15;if(last.volume>average(candles1h.slice(-20).map(c=>c.volume)))score+=10;
  if(score<CFG.MIN_SCORE)return {rejected:"score"};
  const entry=Number(ticker.last),stop=prev.low-atr*CFG.STOP_BUFFER_ATR,risk=entry-stop,riskPct=risk/entry*100;
  if(risk<=0||riskPct>CFG.MAX_RISK_PCT)return {rejected:"risk"};
  return {eligible:true,side:"LONG",score,entry,stop,target1:entry+risk*CFG.TARGET_1_R,target2:entry+risk*CFG.TARGET_2_R,risk,riskPct,rsi:rv};
}
async function getJson(url){
  const r=await fetch(url,{headers:{accept:"application/json"},signal:AbortSignal.timeout(30000)});
  const t=await r.text();if(!r.ok)throw Error("HTTP "+r.status+" "+url+" "+t.slice(0,200));
  const j=JSON.parse(t);if(j.result==="error")throw Error(JSON.stringify(j));return j;
}
function normalize(rows){
  const seen=new Set();return (rows||[]).map(x=>({time:Number(x.time)<1e12?Number(x.time)*1000:Number(x.time),open:+x.open,high:+x.high,low:+x.low,close:+x.close,volume:+x.volume}))
    .filter(c=>Object.values(c).every(Number.isFinite)&&c.close>0&&c.low>0&&c.high>=c.low)
    .sort((a,b)=>a.time-b.time).filter(c=>{if(seen.has(c.time))return false;seen.add(c.time);return true;});
}
async function candles(symbol,from,to){
  const url=new URL(BASE+"/api/charts/v1/trade/"+encodeURIComponent(symbol)+"/1h");
  url.searchParams.set("from",String(Math.floor(from/1000)));url.searchParams.set("to",String(Math.floor(to/1000)));url.searchParams.set("count","5000");
  const d=await getJson(url);if(!Array.isArray(d.candles))throw Error("no candle array");
  return normalize(d.candles).filter(c=>c.time+H<=to);
}
function runExit(entry,stop,target,bars,start,reasonTarget){
  const risk=entry-stop;let exit=null,why="TIME_EXIT";
  for(let k=start;k<Math.min(bars.length,start+MAX_HOLD);k++){
    const b=bars[k];
    if(b.open<=stop||b.low<=stop){exit=(b.open<=stop?b.open:stop)*(1-SLIP);why="SL";break;}
    if(b.high>=target){exit=target*(1-SLIP);why=reasonTarget;break;}
  }
  if(exit===null){const b=bars[Math.min(bars.length-1,start+MAX_HOLD-1)];exit=b.close*(1-SLIP);}
  const netR=(exit-entry)/risk-FEE*(entry+exit)/risk;
  return {netR,exitReason:why};
}
function metrics(trades){
  const w=trades.filter(x=>x.netR>0),l=trades.filter(x=>x.netR<0),gw=w.reduce((s,x)=>s+x.netR,0),gl=Math.abs(l.reduce((s,x)=>s+x.netR,0));
  let eq=0,peak=0,dd=0;for(const t of trades){eq+=t.netR;peak=Math.max(peak,eq);dd=Math.max(dd,peak-eq);}
  return {trades:trades.length,wins:w.length,losses:l.length,open:trades.filter(x=>x.exitReason==="OPEN").length,winRatePct:trades.length?w.length/trades.length*100:0,netR:trades.reduce((s,x)=>s+x.netR,0),expectancyR:trades.length?trades.reduce((s,x)=>s+x.netR,0)/trades.length:0,profitFactor:gl?gw/gl:gw?null:0,maxDrawdownR:dd};
}
async function main(){
  const all=[];
  for(const p of PERIODS){
    const from=Date.parse(p.from),to=Date.parse(p.to),warm=from-260*H;
    const rows=[];
    for(const symbol of SYMBOLS){
      try{
        const cs=await candles(symbol,warm,to);
        if(cs.length<250)throw Error("insufficient hourly candles "+cs.length);
        const byTarget={"1.5R":[],"2.5R":[]},next={"1.5R":0,"2.5R":0};let signals=0,signalRecords=[];
        for(let i=199;i<cs.length-1;i++){
          const signalClose=cs[i].time+H;if(signalClose<from||signalClose>=to)continue;
          const nextBar=cs[i+1],ticker={symbol,last:nextBar.open};
          const candidate=analyzeLongMeanReversion(ticker,cs.slice(0,i+1));
          if(!candidate.eligible)continue;
          signals++;signalRecords.push({symbol,time:new Date(signalClose).toISOString(),entry:candidate.entry,stop:candidate.stop,rsi:candidate.rsi,score:candidate.score});
          for(const targetName of ["1.5R","2.5R"]){
            if(i+1<next[targetName])continue;
            const target=targetName==="1.5R"?candidate.target1:candidate.target2;
            const entry=candidate.entry*(1+SLIP);
            const outcome=runExit(entry,candidate.stop,target,cs,i+1,"TP");
            byTarget[targetName].push({symbol,entryTime:nextBar.time,entry,stop:candidate.stop,target, ...outcome});
            const hitIndex=cs.findIndex((c,j)=>j>=i+1&&c.time>=nextBar.time&&((c.low<=candidate.stop)||(c.high>=target)));
            next[targetName]=hitIndex>=0?hitIndex+1:Math.min(cs.length,i+MAX_HOLD);
          }
        }
        rows.push({symbol,candles:cs.length,signals,targets:Object.fromEntries(Object.entries(byTarget).map(([k,v])=>[k,metrics(v)])),trades:byTarget,signalRecords});
      }catch(e){rows.push({symbol,error:String(e.message||e)});}
    }
    const agg={};for(const target of ["1.5R","2.5R"]){const ts=rows.flatMap(r=>r.trades?.[target]||[]).sort((a,b)=>a.entryTime-b.entryTime);agg[target]={...metrics(ts),trades:ts};}
    all.push({period:p,successfulSymbols:rows.filter(r=>!r.error).length,signals:rows.reduce((s,r)=>s+(r.signals||0),0),aggregate:agg,symbols:rows});
  }
  const report={version:"v6.4.0 LONG Mean Reversion",generatedAt:new Date().toISOString(),source:"Kraken Futures historical 1h candles",periods:all,assumptions:{entry:"next 1h open + 0.03% adverse slippage",exit:"1h OHLC, stop-first if stop and target touched in same bar",fees:"0.05% each side",slippage:"0.03% each side",maxHoldHours:MAX_HOLD,targets:"independent simulations at 1.5R and 2.5R",funding:"excluded",breakeven:"not simulated; source only provides management metadata, no execution rule",universe:"fixed 10 contracts selected from prior test universe; delisted/unavailable symbols disclosed",noLookahead:"signal computed only on fully closed 1h bars; entry at following bar open"}};
  await mkdir("artifacts",{recursive:true});
  await writeFile("artifacts/v640-long-mean-reversion.json",JSON.stringify(report,null,2));
  const lines=["# v6.4.0 LONG Mean Reversion Backtest","", "Generated: "+report.generatedAt,"","| Period | Symbols | Signals | Target | Trades | Wins | Losses | Win rate | Net R | PF | Max DD |","|---|---:|---:|---|---:|---:|---:|---:|---:|---:|---:|"];
  for(const p of all)for(const target of ["1.5R","2.5R"]){const m=p.aggregate[target];lines.push("| "+p.period.name+" | "+p.successfulSymbols+" | "+p.signals+" | "+target+" | "+m.trades+" | "+m.wins+" | "+m.losses+" | "+m.winRatePct.toFixed(2)+"% | "+m.netR.toFixed(2)+"R | "+(m.profitFactor??"n/a")+" | "+m.maxDrawdownR.toFixed(2)+"R |");}
  lines.push("","## Per-symbol details");for(const p of all){lines.push("","### "+p.period.name,"","| Symbol | Signals | 1.5R net | 1.5R win% | 2.5R net | 2.5R win% | Status |","|---|---:|---:|---:|---:|---:|---|");for(const r of p.symbols)lines.push("| "+r.symbol+" | "+(r.signals??0)+" | "+(r.targets?.["1.5R"]?.netR.toFixed(2)??"—")+" | "+(r.targets?.["1.5R"]?.winRatePct.toFixed(1)??"—")+" | "+(r.targets?.["2.5R"]?.netR.toFixed(2)??"—")+" | "+(r.targets?.["2.5R"]?.winRatePct.toFixed(1)??"—")+" | "+(r.error||"OK")+" |");}
  lines.push("","## Assumptions",...Object.entries(report.assumptions).map(([k,v])=>"- "+k+": "+v));
  await writeFile("artifacts/v640-long-mean-reversion.md",lines.join("\n"));
  console.log(JSON.stringify({ok:true,periods:all.map(p=>({period:p.period,signals:p.signals,symbols:p.successfulSymbols,targets:Object.fromEntries(["1.5R","2.5R"].map(t=>[t,{...p.aggregate[t],trades:undefined}]))}))},null,2));
}
main().catch(e=>{console.error(e);process.exit(1);});

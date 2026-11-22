// Isolated historical harness for the user-supplied v7.1.0 LONG Hybrid logic.
// Strategy parameters and signal conditions are reproduced verbatim.
// Execution-only assumptions are documented in the report.
import { mkdir, writeFile } from "node:fs/promises";
import { randomInt } from "node:crypto";

const API = "https://futures.kraken.com/api/charts/v1/trade/";
const H1 = 3600000, H4 = 14400000;
const SYMBOLS = ["PF_XBTUSD","PF_ETHUSD","PF_SOLUSD","PF_XRPUSD","PF_DOGEUSD","PF_ADAUSD","PF_LINKUSD","PF_LTCUSD","PF_BCHUSD","PF_AVAXUSD"];
const CFG = { MIN_CANDLES:200, TARGET_1_R:1.5, TARGET_2_R:2.5, STOP_BUFFER_ATR:0.2, MAX_RISK_PCT:2.5 };
const FEE = 0.0005, SLIPPAGE = 0.0003;

function ema(values, period) {
  if (values.length < period) return null;
  const k=2/(period+1);
  let v=values.slice(0,period).reduce((a,b)=>a+b,0)/period;
  for(let i=period;i<values.length;i++) v=values[i]*k+v*(1-k);
  return v;
}
function rsi(values, period=14) {
  if(values.length<=period) return null;
  let g=0,l=0;
  for(let i=1;i<=period;i++){const d=values[i]-values[i-1];g+=Math.max(d,0);l+=Math.max(-d,0);}
  let ag=g/period,al=l/period;
  for(let i=period+1;i<values.length;i++){const d=values[i]-values[i-1];ag=(ag*(period-1)+Math.max(d,0))/period;al=(al*(period-1)+Math.max(-d,0))/period;}
  if(al===0)return 100;if(ag===0)return 0;return 100-100/(1+ag/al);
}
function atr(candles,period=14){
  if(candles.length<=period)return null;
  const ranges=[];
  for(let i=1;i<candles.length;i++){const c=candles[i],p=candles[i-1].close;ranges.push(Math.max(c.high-c.low,Math.abs(c.high-p),Math.abs(c.low-p)));}
  const a=ranges.slice(-period);return a.reduce((x,y)=>x+y,0)/a.length;
}
function macroBull(btc){
  if(!btc||btc.length<60)return false;
  const closes=btc.map(c=>c.close),cur=closes.at(-1),e=ema(closes,50),past=ema(closes.slice(0,-5),50);
  return !!e&&!!past&&cur>e&&e>past;
}
function analyze(symbol,bars,btc){
  if(bars.length<CFG.MIN_CANDLES)return null;
  if(!macroBull(btc))return {rejected:"BTC_MACRO"};
  const closes=bars.map(c=>c.close),last=bars.at(-1),prev=bars.at(-2);
  const e20=ema(closes,20),e50=ema(closes,50),e200=ema(closes,200),rv=rsi(closes,14),a=atr(bars,14);
  if([e20,e50,e200,rv,a].some(v=>!Number.isFinite(v)))return {rejected:"BAD_INDICATOR"};
  let mode=null,stop=null;
  if(e20>e50&&last.close>e20&&rv>45&&rv<75){
    mode="TREND";const lows=bars.slice(-7).map(c=>c.low);stop=Math.min(...lows)-a*CFG.STOP_BUFFER_ATR;
  }else if(rv<35&&last.close>e200){
    mode="REVERSION";stop=prev.low-a*CFG.STOP_BUFFER_ATR;
  }else return {rejected:"NO_SETUP"};
  return {mode,stop};
}
async function getJson(url){
  const res=await fetch(url,{headers:{accept:"application/json"},signal:AbortSignal.timeout(30000)});
  const txt=await res.text();if(!res.ok)throw Error("HTTP "+res.status+" "+txt.slice(0,200));
  return JSON.parse(txt);
}
function normalize(rows,ms){
  if(!Array.isArray(rows))throw Error("candles missing");
  const seen=new Set();
  return rows.map(x=>({time:Number(x.time)<1e12?Number(x.time)*1000:Number(x.time),open:+x.open,high:+x.high,low:+x.low,close:+x.close,volume:+x.volume}))
    .filter(c=>[c.time,c.open,c.high,c.low,c.close].every(Number.isFinite)&&c.open>0&&c.close>0&&c.low>0&&c.high>=c.low)
    .sort((a,b)=>a.time-b.time).filter(c=>{if(seen.has(c.time)||c.time+ms>Date.now())return false;seen.add(c.time);return true;});
}
async function candles(symbol,resolution,from,to,ms){
  const chunk=ms*1700,all=[];
  for(let s=from;s<to;s+=chunk){
    const e=Math.min(to,s+chunk),u=new URL(API+encodeURIComponent(symbol)+"/"+resolution);
    u.searchParams.set("from",String(Math.floor(s/1000)));u.searchParams.set("to",String(Math.floor(e/1000)));u.searchParams.set("count","1800");
    const d=await getJson(u);if(d.more_candles===true)throw Error("more_candles=true");
    all.push(...normalize(d.candles,ms));
  }
  return [...new Map(all.map(c=>[c.time,c])).values()].sort((a,b)=>a.time-b.time);
}
function fillExit(raw,side){return raw*(1-(side==="LONG"?1:-1)*SLIPPAGE);}
function netR(entry,stop,exit,side){
  const dir=side==="LONG"?1:-1,risk=side==="LONG"?entry-stop:stop-entry;
  const gross=dir*(exit-entry)/risk,fees=FEE*(entry+exit)/risk;
  return gross-fees;
}
function simulate(entryRaw,stop,barSet){
  const side="LONG",entry=entryRaw*(1+SLIPPAGE),risk=entry-stop;
  if(!(risk>0))return null;
  const t1=entry+risk*CFG.TARGET_1_R,t2=entry+risk*CFG.TARGET_2_R;
  let be=false;
  for(const b of barSet){
    if(!be){
      const stopGap=b.open<=stop,stopHit=b.low<=stop,t1Hit=b.high>=t1;
      if(stopGap||stopHit){const raw=stopGap?b.open:stop;const ex=fillExit(raw,side);return {outcome:"STOP_BEFORE_T1",exitTime:b.time,exit:ex,netR:netR(entry,stop,ex,side)};}
      if(t1Hit){
        be=true;
        // Conservative OHLC sequencing: if entry and T2 are both touched in this bar,
        // assume breakeven stop first; otherwise allow T2 only if low stayed above entry.
        if(b.low<=entry){const ex=fillExit(entry,side);return {outcome:"BREAKEVEN_AFTER_T1",exitTime:b.time,exit:ex,netR:netR(entry,stop,ex,side)};}
        if(b.high>=t2){const ex=fillExit(t2,side);return {outcome:"T2",exitTime:b.time,exit:ex,netR:netR(entry,stop,ex,side)};}
      }
    }else{
      const beHit=b.open<=entry||b.low<=entry,t2Hit=b.high>=t2;
      if(beHit){const raw=b.open<=entry?b.open:entry,ex=fillExit(raw,side);return {outcome:"BREAKEVEN_AFTER_T1",exitTime:b.time,exit:ex,netR:netR(entry,stop,ex,side)};}
      if(t2Hit){const ex=fillExit(t2,side);return {outcome:"T2",exitTime:b.time,exit:ex,netR:netR(entry,stop,ex,side)};}
    }
  }
  return {outcome:"OPEN_AT_END",exitTime:null,exit:null,netR:null};
}
function stats(trades){
  const closed=trades.filter(t=>t.netR!==null),wins=closed.filter(t=>t.netR>0),loss=closed.filter(t=>t.netR<0);
  const gp=wins.reduce((s,t)=>s+t.netR,0),gl=Math.abs(loss.reduce((s,t)=>s+t.netR,0));
  let eq=0,peak=0,dd=0;
  for(const t of [...closed].sort((a,b)=>a.exitTime-b.exitTime)){eq+=t.netR;peak=Math.max(peak,eq);dd=Math.max(dd,peak-eq);}
  return {trades:trades.length,closed:closed.length,open:trades.length-closed.length,wins:wins.length,losses:loss.length,breakeven:closed.filter(t=>t.netR===0).length,winRatePct:closed.length?100*wins.length/closed.length:0,netR:closed.reduce((s,t)=>s+t.netR,0),grossProfitR:gp,grossLossR:gl,profitFactor:gl?gp/gl:null,expectancyR:closed.length?closed.reduce((s,t)=>s+t.netR,0)/closed.length:0,maxDrawdownR:dd,t2Hits:closed.filter(t=>t.outcome==="T2").length,stoppedBeforeT1:closed.filter(t=>t.outcome==="STOP_BEFORE_T1").length,breakevenAfterT1:closed.filter(t=>t.outcome==="BREAKEVEN_AFTER_T1").length};
}
async function runPeriod(name,start,end){
  const warm=start-35*H4,btc=await candles("PF_XBTUSD","4h",warm,end,H4);
  const all=[];let failures=[];
  for(const symbol of SYMBOLS){
    try{
      const bars=await candles(symbol,"1h",start-220*H1,end,H1);
      if(bars.length<CFG.MIN_CANDLES)throw Error("insufficient 1h candles: "+bars.length);
      let nextFree=0,rej={};
      for(let i=199;i<bars.length-1;i++){
        const signalClose=bars[i].time+H1;if(signalClose<start||signalClose>=end)continue;
        const b4=btc.filter(c=>c.time+H4<=signalClose);
        if(b4.length<60){rej.BTC_HISTORY=(rej.BTC_HISTORY||0)+1;continue;}
        const candidate=analyze(symbol,bars.slice(0,i+1),b4);
        if(candidate?.rejected){rej[candidate.rejected]=(rej[candidate.rejected]||0)+1;continue;}
        const entryBar=bars[i+1];if(entryBar.time>=end||entryBar.time<nextFree)continue;
        const entry=entryBar.open,risk=entry-candidate.stop,riskPct=risk/entry*100;
        if(!(risk>0)||riskPct>2.5){rej.RISK=(rej.RISK||0)+1;continue;}
        const sim=simulate(entry,candidate.stop,bars.slice(i+1).filter(c=>c.time<end));
        if(!sim)continue;
        all.push({symbol,mode:candidate.mode,signalTime:bars[i].time,entryTime:entryBar.time,entry,stop:candidate.stop,riskPct,...sim});
        if(sim.exitTime===null)nextFree=end;else nextFree=sim.exitTime+H1;
      }
      console.log(name,symbol,"candles",bars.length,"trades",all.filter(t=>t.symbol===symbol).length,"rejects",JSON.stringify(rej));
    }catch(e){failures.push({symbol,error:String(e.message||e)});console.log("FAILED",name,symbol,String(e.message||e));}
  }
  const s=stats(all);
  return {name,from:new Date(start).toISOString(),to:new Date(end).toISOString(),symbols:SYMBOLS,failures,macroBtcCandles:btc.length,performance:s,byMode:{TREND:stats(all.filter(t=>t.mode==="TREND")),REVERSION:stats(all.filter(t=>t.mode==="REVERSION"))},bySymbol:SYMBOLS.map(symbol=>({symbol,...stats(all.filter(t=>t.symbol===symbol))})),trades:all};
}
async function main(){
  const earliest=Date.UTC(2023,0,1),latest=Date.UTC(2025,10,1),span=30*24*H1;
  const randomStart=earliest+randomInt(0,Math.floor((latest-earliest-span)/H1))*H1;
  const periods=[
    await runPeriod("RANDOM_30D",randomStart,randomStart+span),
    await runPeriod("BULLISH_2024_Q4",Date.UTC(2024,9,1),Date.UTC(2024,11,1))
  ];
  const report={generatedAt:new Date().toISOString(),strategy:"User-supplied CRYPTO PUMP HUNTER v7.1.0 LONG Hybrid",symbols:SYMBOLS,parameters:{MIN_CANDLES:200,TARGET_1_R:1.5,TARGET_2_R:2.5,STOP_BUFFER_ATR:0.2,MAX_RISK_PCT:2.5,feePerSidePct:FEE*100,slippagePerSidePct:SLIPPAGE*100},executionAssumptions:{signalAtClosed1hBar:"yes",entry:"next 1h open with adverse slippage",BTCguard:"latest fully closed 4h candles only",T1:"when +1.5R is reached, move stop to breakeven; no partial take-profit because source code specifies none",T2:"close 100% at +2.5R",sameCandle:"conservative stop-first; after T1, if breakeven and T2 both touched in same candle, breakeven first",holding:"one active trade per symbol; no overlapping trades per symbol",funding:"excluded",feesAndSlippage:"0.05% fee and 0.03% adverse slippage per side",openTrades:"excluded from closed-trade performance"},periods};
  await mkdir("artifacts",{recursive:true});
  await writeFile("artifacts/v710-long-hybrid-report.json",JSON.stringify(report,null,2));
  const lines=["# CRYPTO PUMP HUNTER v7.1.0 — LONG Hybrid backtest","", "Generated: "+report.generatedAt,"","| Period | Trades | Wins | Losses | Win rate | Net R | PF | Max DD (R) |","|---|---:|---:|---:|---:|---:|---:|---:|",...periods.map(p=>{const x=p.performance;return "| "+p.name+" ("+p.from.slice(0,10)+" → "+p.to.slice(0,10)+") | "+x.trades+" | "+x.wins+" | "+x.losses+" | "+x.winRatePct.toFixed(1)+"% | "+x.netR.toFixed(2)+" | "+(x.profitFactor==null?"—":x.profitFactor.toFixed(2))+" | "+x.maxDrawdownR.toFixed(2)+" |";}),"", "## Mode breakdown","",...periods.flatMap(p=>["### "+p.name,"","| Mode | Trades | Win rate | Net R | PF | Max DD R |","|---|---:|---:|---:|---:|---:|",...["TREND","REVERSION"].map(m=>{const x=p.byMode[m];return "| "+m+" | "+x.trades+" | "+x.winRatePct.toFixed(1)+"% | "+x.netR.toFixed(2)+" | "+(x.profitFactor==null?"—":x.profitFactor.toFixed(2))+" | "+x.maxDrawdownR.toFixed(2)+" |";}),""]), "## Assumptions","",JSON.stringify(report.executionAssumptions,null,2)];
  await writeFile("artifacts/v710-long-hybrid-report.md",lines.join("\n"));
  console.log("FINAL_REPORT",JSON.stringify(periods.map(p=>({name:p.name,from:p.from,to:p.to,performance:p.performance,byMode:p.byMode,failures:p.failures}))));
}
main().catch(e=>{console.error(e);process.exit(1);});

// trigger run after workflow and harness are both present

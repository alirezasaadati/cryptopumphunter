// Pure PDH/PDL sweep-reclaim experiment; no maximum holding-time exit.
import { mkdir, readFile, writeFile, mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const END = Date.UTC(2026, 10, 20);
const REQUESTED_START = END - 365 * 86400000;
const WARM_START = REQUESTED_START - 10 * 86400000;
const INTERVAL = "5m";
const STEP = 5 * 60 * 1000;
const NY = "America/New_York";
const LONDON = "Europe/London";
const BINANCE_FEE = 0.0005;
const BINANCE_SLIPPAGE = 0.0001;
const GOLD_SLIPPAGE = 0.0001;
const TARGET_R = 2;

const fmtNY = new Intl.DateTimeFormat("en-US", {
  timeZone: NY, year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hourCycle: "h23"
});
const fmtLondon = new Intl.DateTimeFormat("en-GB", {
  timeZone: LONDON, hour: "2-digit", minute: "2-digit", hourCycle: "h23"
});
const finite = Number.isFinite;
const dateKey = (p) => p.year + "-" + p.month + "-" + p.day;
function parts(formatter, time) {
  const o = {};
  for (const p of formatter.formatToParts(new Date(time))) if (p.type !== "literal") o[p.type] = p.value;
  return o;
}
function sessionKey(time) {
  const p = parts(fmtNY, time);
  const d = new Date(Date.UTC(+p.year, +p.month - 1, +p.day));
  if (+p.hour >= 17) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
function inLondonKillzone(time) {
  const p = parts(fmtNY, time);
  const h = +p.hour;
  return h >= 2 && h < 5;
}
function inNewYorkKillzone(time) {
  const p=parts(fmtNY,time);
  const minutes=+p.hour*60 + +p.minute;
  return minutes>=8*60 && minutes<11*60;
}
function parseCsv(csv) {
  const out = [];
  const lines = csv.trim().split(/\r?\n/);
  for (let n = 1; n < lines.length; n++) {
    const x = lines[n].split(",");
    if (x.length < 5) continue;
    const b = { time: +x[0], open: +x[1], high: +x[2], low: +x[3], close: +x[4], volume: +(x[5] || 0) };
    if (finite(b.time) && [b.open,b.high,b.low,b.close].every(finite) && b.open > 0 && b.low > 0 && b.high >= b.low && b.close > 0) out.push(b);
  }
  return out;
}
async function fetchZipCsv(url, dir) {
  const r = await fetch(url, { signal: AbortSignal.timeout(40000) });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error("HTTP " + r.status + " for " + url);
  const p = join(dir, Math.random().toString(36).slice(2) + ".zip");
  await writeFile(p, Buffer.from(await r.arrayBuffer()));
  try { return execFileSync("unzip", ["-p", p], { encoding: "utf8", maxBuffer: 180 * 1024 * 1024 }); }
  finally { await rm(p, { force: true }); }
}
function parseBinance(csv) {
  const out = [];
  for (const line of csv.split(/\r?\n/)) {
    if (!/^\d+,/.test(line)) continue;
    const x = line.split(",");
    if (x.length < 7) continue;
    const b = { time:+x[0], open:+x[1], high:+x[2], low:+x[3], close:+x[4], volume:+x[5], closeTime:+x[6] };
    if ([b.time,b.open,b.high,b.low,b.close,b.closeTime].every(finite) && b.closeTime < END && b.open > 0 && b.low > 0 && b.high >= b.low && b.close > 0) out.push(b);
  }
  return out;
}
async function loadBinanceSymbol(symbol, dir) {
  const all = [];
  let month = new Date(Date.UTC(new Date(WARM_START).getUTCFullYear(), new Date(WARM_START).getUTCMonth(), 1));
  const lastMonth = Date.UTC(new Date(END).getUTCFullYear(), new Date(END).getUTCMonth(), 1);
  while (month.getTime() < lastMonth) {
    const y = month.getUTCFullYear(), m = String(month.getUTCMonth()+1).padStart(2,"0");
    const file = symbol + "-" + INTERVAL + "-" + y + "-" + m + ".zip";
    const url = "https://data.binance.vision/data/futures/um/monthly/klines/" + symbol + "/" + INTERVAL + "/" + file;
    const csv = await fetchZipCsv(url, dir);
    if (csv) all.push(...parseBinance(csv));
    month = new Date(Date.UTC(y, month.getUTCMonth()+1, 1));
  }
  const current = new Date(Date.UTC(new Date(END).getUTCFullYear(), new Date(END).getUTCMonth(), 1));
  for (let d = current; d.getTime() < END; d.setUTCDate(d.getUTCDate()+1)) {
    const yy=d.getUTCFullYear(), mm=String(d.getUTCMonth()+1).padStart(2,"0"), dd=String(d.getUTCDate()).padStart(2,"0");
    const daily = symbol + "-" + INTERVAL + "-" + yy + "-" + mm + "-" + dd + ".zip";
    const url = "https://data.binance.vision/data/futures/um/daily/klines/" + symbol + "/" + INTERVAL + "/" + daily;
    const csv = await fetchZipCsv(url, dir);
    if (csv) all.push(...parseBinance(csv));
  }
  const map = new Map(all.filter(b => b.time >= WARM_START && b.time < END).map(b => [b.time,b]));
  return [...map.values()].sort((a,b)=>a.time-b.time);
}
async function loadXauUsd(dir) {
  const outDir = join(dir, "dukascopy");
  await mkdir(outDir, { recursive: true });
  const from = new Date(WARM_START).toISOString().slice(0,10);
  const to = new Date(END).toISOString().slice(0,10);
  for (const side of ["bid","ask"]) {
    execFileSync("npx", [
      "--yes", "dukascopy-node@1.51.1",
      "-i", "xauusd", "-from", from, "-to", to,
      "-t", "m5", "-p", side, "-f", "csv",
      "-dir", outDir, "-fn", "xauusd-" + side,
      "--retries", "3", "--batch-pause", "1500", "--rate-limit-retries", "3"
    ], { stdio: "inherit", timeout: 25 * 60 * 1000 });
  }
  const files = await readdir(outDir);
  const bidFile = files.find(x => x.startsWith("xauusd-bid") && x.endsWith(".csv"));
  const askFile = files.find(x => x.startsWith("xauusd-ask") && x.endsWith(".csv"));
  if (!bidFile || !askFile) throw new Error("Dukascopy XAUUSD bid/ask CSV files were not created");
  const bid = parseCsv(await readFile(join(outDir,bidFile),"utf8"));
  const ask = parseCsv(await readFile(join(outDir,askFile),"utf8"));
  const asks = new Map(ask.map(x=>[x.time,x]));
  const merged = [];
  for (const b of bid) {
    const a = asks.get(b.time);
    if (!a) continue;
    merged.push({
      time:b.time,
      open:(b.open+a.open)/2, high:(b.high+a.high)/2,
      low:(b.low+a.low)/2, close:(b.close+a.close)/2,
      bid:b, ask:a, source:"Dukascopy"
    });
  }
  return merged.filter(b=>b.time>=WARM_START&&b.time<END).sort((a,b)=>a.time-b.time);
}
function averageTrueRange(bars, period=14) {
  const tr=bars.map((b,i)=>i===0?b.high-b.low:Math.max(b.high-b.low,Math.abs(b.high-bars[i-1].close),Math.abs(b.low-bars[i-1].close)));
  const out=Array(bars.length).fill(null);
  if (bars.length <= period) return out;
  let v=tr.slice(1,period+1).reduce((s,x)=>s+x,0)/period;
  out[period]=v;
  for(let i=period+1;i<bars.length;i++){v=(v*(period-1)+tr[i])/period;out[i]=v;}
  return out;
}
function confirmedPivots(bars,left=2,right=2) {
  const highs=Array(bars.length).fill(null), lows=Array(bars.length).fill(null);
  let h=null,l=null;
  for(let i=0;i<bars.length;i++){
    const p=i-right;
    if(p>=left){
      let isH=true,isL=true;
      for(let j=p-left;j<=p+right;j++){if(j===p)continue;if(bars[p].high<=bars[j].high)isH=false;if(bars[p].low>=bars[j].low)isL=false;}
      if(isH)h=bars[p].high;
      if(isL)l=bars[p].low;
    }
    highs[i]=h;lows[i]=l;
  }
  return {highs,lows};
}
function dailyLevels(bars) {
  const days=new Map();
  for(let i=0;i<bars.length;i++){
    const key=sessionKey(bars[i].time);
    let d=days.get(key);
    if(!d){d={high:-Infinity,low:Infinity,first:i,last:i};days.set(key,d);}
    d.high=Math.max(d.high,bars[i].high);d.low=Math.min(d.low,bars[i].low);d.last=i;
  }
  const keys=[...days.keys()].sort();
  const prev=new Map();
  for(let i=1;i<keys.length;i++)prev.set(keys[i],days.get(keys[i-1]));
  return {days,prev,keys};
}
function summarize(trades) {
  const closed=trades.filter(t=>Number.isFinite(t.netR));
  const wins=closed.filter(t=>t.netR>0),losses=closed.filter(t=>t.netR<0);
  const grossWin=wins.reduce((sum,t)=>sum+t.netR,0),grossLoss=Math.abs(losses.reduce((sum,t)=>sum+t.netR,0));
  let eq=0,peak=0,dd=0;
  for(const t of closed){eq+=t.netR;peak=Math.max(peak,eq);dd=Math.max(dd,peak-eq);}
  return {
    trades:closed.length,openTrades:trades.length-closed.length,wins:wins.length,losses:losses.length,
    winRatePct:closed.length?100*wins.length/closed.length:0,
    netR:closed.reduce((sum,t)=>sum+t.netR,0),
    expectancyR:closed.length?closed.reduce((sum,t)=>sum+t.netR,0)/closed.length:0,
    profitFactor:grossLoss?grossWin/grossLoss:(grossWin?null:0),
    maxDrawdownR:dd,
    avgWinR:wins.length?grossWin/wins.length:0,
    avgLossR:losses.length?-grossLoss/losses.length:0
  };
}

function costAndFill(symbol,bar,side,mid,exit=false) {
  const dir=side==="LONG"?1:-1;
  if(symbol==="XAUUSD"){
    const spread=bar.ask&&bar.bid?Math.max(0,((bar.ask.open-bar.bid.open)+(bar.ask.high-bar.bid.high)+(bar.ask.low-bar.bid.low)+(bar.ask.close-bar.bid.close))/4):0;
    const half=spread/2;
    const slip=mid*GOLD_SLIPPAGE;
    return mid + (exit?-dir:dir)*(half+slip);
  }
  const slip=mid*BINANCE_SLIPPAGE;
  return mid + (exit?-dir:dir)*slip;
}
function calcTradeVariant(symbol,bars,entryIndex,side,entryMid,stopMid,targets) {
  const dir=side==="LONG"?1:-1;
  const risk=dir===1?entryMid-stopMid:stopMid-entryMid;
  if(!(risk>0)||!targets.length)return null;
  const entryBar=bars[entryIndex];
  const entryFill=costAndFill(symbol,entryBar,side,entryMid,false);
  const pending=targets.map((x,i)=>({...x,index:i,done:false}));
  let realized=0,closedFraction=0,exitIndex=null,exitReason="OPEN_AT_DATA_END";
  for(let j=entryIndex+1;j<bars.length;j++){
    const b=bars[j], triggerBar=symbol==="XAUUSD"?(dir===1?b.bid:b.ask):b;
    const stopHit=dir===1?triggerBar.low<=stopMid:triggerBar.high>=stopMid;
    if(stopHit){
      const fill=costAndFill(symbol,b,side,stopMid,true);
      const rem=Math.max(0,1-closedFraction);
      realized+=rem*dir*(fill-entryFill)/risk;
      closedFraction=1;exitIndex=j;exitReason="STOP";break;
    }
    for(const t of pending){
      if(t.done)continue;
      const hit=dir===1?triggerBar.high>=t.price:triggerBar.low<=t.price;
      if(hit){
        const fill=costAndFill(symbol,b,side,t.price,true);
        realized+=t.portion*dir*(fill-entryFill)/risk;
        closedFraction+=t.portion;t.done=true;
        if(closedFraction>=0.999999){exitIndex=j;exitReason="TARGETS";break;}
      }
    }
    if(closedFraction>=0.999999)break;
  }
  if(closedFraction<0.999999){
    const mark=bars[bars.length-1],fill=costAndFill(symbol,mark,side,mark.close,true);
    const unrealized=dir*(fill-entryFill)/risk;
    return {symbol,side,signalTime:entryBar.time,entryTime:entryBar.time,entry:entryFill,entryMid,stop:stopMid,
      targets,riskPrice:risk,exit:null,exitMid:null,exitTime:null,exitReason:"OPEN_AT_DATA_END",
      grossR:null,feesR:null,netR:null,realizedPartialR:realized,unrealizedRemainingR:unrealized*(1-closedFraction),
      closedFraction,markTime:mark.time,markPrice:fill};
  }
  const netR=realized;
  return {symbol,side,signalTime:entryBar.time,entryTime:entryBar.time,entry:entryFill,entryMid,stop:stopMid,
    targets,riskPrice:risk,exitTime:bars[exitIndex].time,exitReason, grossR:netR,feesR:0,netR,closedFraction:1};
}
function findSetup(bars,ind,start,side,level,session,variant) {
  const sweep=bars[start],atr0=ind.atr[start];
  if(!finite(atr0)||atr0<=0)return {diagnostics:{sweeps:1,invalidAtr:1}};
  const sweepExtreme=side==="LONG"?sweep.low:sweep.high;
  const stopBuffer=Math.max(atr0*0.1,sweep.close*0.00005);
  const stop=side==="LONG"?sweepExtreme-stopBuffer:sweepExtreme+stopBuffer;
  const entry=sweep.close,dir=side==="LONG"?1:-1;
  const risk=side==="LONG"?entry-stop:stop-entry;
  if(!(risk>0))return {diagnostics:{sweeps:1,invalidRisk:1}};
  let targets=[];
  if(variant.management==="fixed2r") targets=[{price:entry+dir*risk*2,portion:1,label:"2R"}];
  else {
    const eq=(level.high+level.low)/2;
    const opposite=side==="LONG"?level.high:level.low;
    const eqValid=dir*(eq-entry)>0, oppositeValid=dir*(opposite-entry)>0;
    if(variant.management==="equilibrium") {
      if(!eqValid)return {diagnostics:{sweeps:1,reclaims:1,invalidTarget:1}};
      targets=[{price:eq,portion:1,label:"PDH_PDL_EQ"}];
    } else if(variant.management==="split") {
      if(eqValid&&oppositeValid) targets=[{price:eq,portion:0.5,label:"EQ_50"},{price:opposite,portion:0.5,label:"OPPOSITE_LIQUIDITY"}];
      else if(oppositeValid) targets=[{price:opposite,portion:1,label:"OPPOSITE_LIQUIDITY"}];
      else return {diagnostics:{sweeps:1,reclaims:1,invalidTarget:1}};
    }
  }
  const trade=calcTradeVariant(ind.symbol,bars,start,side,entry,stop,targets);
  return {diagnostics:{sweeps:1,reclaims:1,entries:trade?1:0},trade,entryIndex:start};
}
function hourlyTrendRegimes(bars) {
 const buckets=new Map();
 for(const b of bars){const h=Math.floor(b.time/3600000)*3600000;let x=buckets.get(h);if(!x){x={time:h,close:b.close,count:0};buckets.set(h,x);}x.close=b.close;x.count++;}
 const hourly=[...buckets.values()].filter(x=>x.count===12).sort((a,b)=>a.time-b.time),out=[];let ema=null;const alpha=2/201;
 for(let i=0;i<hourly.length;i++){const c=hourly[i].close;if(i===199)ema=hourly.slice(0,200).reduce((s,x)=>s+x.close,0)/200;else if(i>199)ema=c*alpha+ema*(1-alpha);if(i<205)continue;const prior=out.length>=6?out[out.length-6].ema:null;let regime="NEUTRAL";if(prior!==null&&c>ema&&ema>prior)regime="BULLISH";else if(prior!==null&&c<ema&&ema<prior)regime="BEARISH";out.push({closeTime:hourly[i].time+3600000,ema,regime});}
 return out;
}
function regimeAt(rs,t){let l=0,h=rs.length-1,b=null;while(l<=h){const m=(l+h)>>1;if(rs[m].closeTime<=t){b=rs[m];l=m+1;}else h=m-1;}return b?.regime||"UNCLASSIFIED";}
function summarizeRegimes(ts){const o={};for(const r of ["BULLISH","BEARISH","NEUTRAL","UNCLASSIFIED"]){const a=ts.filter(t=>t.regime===r);o[r]={all:summarize(a),LONG:summarize(a.filter(t=>t.side==="LONG")),SHORT:summarize(a.filter(t=>t.side==="SHORT"))};}return o;}

function addTargetOneDiagnostics(result, bars) {
  const dirOf = side => side === "LONG" ? 1 : -1;
  for (const trade of result.trades) {
    const dir = dirOf(trade.side);
    const isFixed = result.variant.management === "fixed2r";
    const target1 = isFixed
      ? trade.entryMid + dir * trade.riskPrice
      : trade.targets[0]?.price;
    let touched = false, touchTime = null, stopBeforeTarget = false;
    const endTime = trade.exitTime ?? bars[bars.length - 1].time;
    for (let i = bars.findIndex(b => b.time > trade.entryTime); i >= 0 && i < bars.length && bars[i].time <= endTime; i++) {
      const b = bars[i];
      const trigger = trade.symbol === "XAUUSD" ? (dir === 1 ? b.bid : b.ask) : b;
      if (!trigger) continue;
      const stopHit = dir === 1 ? trigger.low <= trade.stop : trigger.high >= trade.stop;
      const targetHit = dir === 1 ? trigger.high >= target1 : trigger.low <= target1;
      // Preserve the backtest's conservative same-candle rule: stop is evaluated first.
      if (stopHit) { stopBeforeTarget = !touched; break; }
      if (targetHit) { touched = true; touchTime = b.time; break; }
    }
    trade.target1 = { price: target1, label: isFixed ? "1R" : (trade.targets[0]?.label || "FIRST_TARGET"), touched, touchTime,
      touchedBeforeFinalStop: touched && trade.exitReason === "STOP" };
  }
  const summarizeTouch = trades => ({
    trades: trades.length,
    target1Touched: trades.filter(t => t.target1?.touched).length,
    target1NotTouched: trades.filter(t => !t.target1?.touched).length,
    stoppedTrades: trades.filter(t => t.exitReason === "STOP").length,
    stoppedAfterTarget1: trades.filter(t => t.exitReason === "STOP" && t.target1?.touched).length,
    stoppedWithoutTarget1: trades.filter(t => t.exitReason === "STOP" && !t.target1?.touched).length
  });
  const oos = result.trades.filter(t => t.signalTime >= result.splitTime);
  result.target1Touch = { overall: summarizeTouch(result.trades), outOfSample: summarizeTouch(oos) };
}
function runBacktest(symbol,bars,source,variant) {
  const startIndex=bars.findIndex(b=>b.time>=REQUESTED_START);
  const actual=bars.filter(b=>b.time>=REQUESTED_START&&b.time<END);
  const atr=averageTrueRange(bars),piv=confirmedPivots(bars),levels=dailyLevels(bars);
  const ind={atr,piv,symbol};
  const diag={sessions:levels.keys.length,sweeps:0,reclaims:0,entries:0,invalidAtr:0,invalidRisk:0};
  const trades=[];
  const regimes=hourlyTrendRegimes(bars);
  let i=Math.max(50,startIndex);
  let nextFree=0;
  const tradedSessions=new Set();
  while(i<bars.length-2){
    if(i<nextFree){i++;continue;}
    const b=bars[i],session=sessionKey(b.time),prior=levels.prev.get(session);
    const allowedTime=variant.session==="london_ny"?(inLondonKillzone(b.time)||inNewYorkKillzone(b.time)):inLondonKillzone(b.time);
    if(!prior||tradedSessions.has(session)||!allowedTime){i++;continue;}
    let side=null;
    if(b.low<prior.low&&b.close>prior.low)side="LONG";
    else if(b.high>prior.high&&b.close<prior.high)side="SHORT";
    if(!side){i++;continue;}
    const found=findSetup(bars,ind,i,side,prior,session,variant);
    for(const key of Object.keys(found.diagnostics||{}))diag[key]=(diag[key]||0)+found.diagnostics[key];
    if(found.rejectedRisk)diag.rejectedRisk++;
    if(found.trade){
      found.trade.regime=regimeAt(regimes,found.trade.signalTime+STEP);
      trades.push(found.trade);
      tradedSessions.add(session);
      nextFree=bars.findIndex((x,idx)=>idx>found.entryIndex&&x.time>found.trade.exitTime);
      if(nextFree<0)nextFree=bars.length;
      i=Math.max(i+1,nextFree);
    } else i++;
  }
  const periodStart=actual.length?actual[0].time:null,periodEnd=actual.length?actual[actual.length-1].time:null;
  const split=periodStart===null?null:periodStart+Math.floor((periodEnd-periodStart)*0.7);
  const oos=trades.filter(t=>split!==null&&t.signalTime>=split);
  const is=trades.filter(t=>split!==null&&t.signalTime<split);
  const result={
    symbol,source,variant,period:{from:periodStart?new Date(periodStart).toISOString():null,to:periodEnd?new Date(periodEnd).toISOString():null,days:periodStart?Math.round((periodEnd-periodStart)/86400000):0},
    data:{candlesM5:actual.length,firstAvailable:bars[0]?new Date(bars[0].time).toISOString():null,lastAvailable:bars.length?new Date(bars[bars.length-1].time).toISOString():null},
    diagnostics:diag,overall:summarize(trades),inSample:summarize(is),outOfSample:summarize(oos),
    oosBySide:{LONG:summarize(oos.filter(t=>t.side==="LONG")),SHORT:summarize(oos.filter(t=>t.side==="SHORT"))},
    regimeOverall:summarizeRegimes(trades),regimeInSample:summarizeRegimes(is),regimeOutOfSample:summarizeRegimes(oos),
    regimeMetadata:{source:"complete UTC H1 candles aggregated from M5",emaPeriod:200,slopeLookbackHours:6,completedBarsOnly:true},
    trades
  };
  return result;
}
function mdReport(report) {
  const f=x=>x===null?"—":finite(x)?x.toFixed(2):"—";
  const lines=[
    "# XAUUSD London PDH/PDL — market-regime backtest",
    "",
    "Generated: "+report.generatedAt,
    "Requested window: "+report.requestedPeriod.from+" to "+report.requestedPeriod.to+" UTC",
    "Time definition: ICT London Killzone = 02:00–05:00 America/New_York (DST-aware); trading day rolls at 17:00 New York time.",
    "Timeframes: M5 for PDH/PDL sweep-reclaim and management; H1 EMA200 for regime classification.",
    "Setup: previous-session high/low sweep and immediate candle close back inside; entry at reclaim candle close; stop beyond sweep extreme by 0.1 ATR; 2R target; no maximum holding time (positions remain open until stop/target or data ends).",
    "Costs: Binance symbols use 0.05% taker fee and 0.01% adverse slippage per side. XAUUSD uses Dukascopy bid/ask candle spreads plus 0.01% slippage per side; broker commission/swap excluded.",
    "Conservative intrabar rule: stop is checked before target if both are touched in the same M5 candle. Funding is excluded.",
    "",
    "Regime: H1 EMA200; bullish = H1 close above EMA200 and EMA rising over six completed H1 bars; bearish = below EMA200 and EMA falling; otherwise neutral.",
    "",
    "## Baseline results",
    "| Symbol | Candles M5 | Actual days | Trades | OOS trades | OOS win % | OOS net R | OOS expectancy | OOS PF | OOS max DD R | LONG net R | SHORT net R |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|"
  ];
  for(const x of report.results){
    const o=x.outOfSample||{},l=x.oosBySide?.LONG||{},s=x.oosBySide?.SHORT||{};
    lines.push("| "+x.symbol+" | "+x.data.candlesM5+" | "+x.period.days+" | "+x.overall.trades+" | "+o.trades+" | "+f(o.winRatePct)+" | "+f(o.netR)+" | "+f(o.expectancyR)+" | "+f(o.profitFactor)+" | "+f(o.maxDrawdownR)+" | "+f(l.netR)+" | "+f(s.netR)+" |");
  }
  for(const x of report.results){
    lines.push("","## "+x.symbol,"","- Source: "+x.source,"- Data: "+x.data.candlesM5+" M5 candles; "+x.data.firstAvailable+" through "+x.data.lastAvailable,"- Period tested: "+x.period.from+" through "+x.period.to,"- Diagnostics: "+JSON.stringify(x.diagnostics),"","### Out-of-sample LONG / SHORT","| Side | Trades | Win % | Net R | Expectancy R | PF | Max DD R |","|---|---:|---:|---:|---:|---:|---:|");
    for(const side of ["LONG","SHORT"]){const z=x.oosBySide[side];lines.push("| "+side+" | "+z.trades+" | "+f(z.winRatePct)+" | "+f(z.netR)+" | "+f(z.expectancyR)+" | "+f(z.profitFactor)+" | "+f(z.maxDrawdownR)+" |");}
    lines.push("","### Overall","| Trades | Win % | Net R | Expectancy R | PF | Max DD R |","|---:|---:|---:|---:|---:|---:|","| "+x.overall.trades+" | "+f(x.overall.winRatePct)+" | "+f(x.overall.netR)+" | "+f(x.overall.expectancyR)+" | "+f(x.overall.profitFactor)+" | "+f(x.overall.maxDrawdownR)+" |");
  }
  lines.push("","## Interpretation guardrails","- XAUUSDT may have a shorter listing history than the requested one-year window; its actual period is shown separately and its OOS split is computed within its own available history.","- Fewer than 30 OOS trades is a small sample and should not be treated as robust evidence.","- The XAUUSD data source is Dukascopy; this is not the user's broker feed. Bid/ask spreads are modeled from the source candles.","- This is a historical simulation, not a live execution guarantee.");
  return lines.join("\n");
}
async function main(){
  const temp=await mkdtemp(join(tmpdir(),"xau-pdh-improvements-"));
  try{
    console.log("Downloading XAUUSD M5 Dukascopy BID and ASK data once for all variants...");
    const xau=await loadXauUsd(temp);
    if(xau.length<5000)throw new Error("Insufficient XAUUSD M5 history: "+xau.length);
    const variants=[
      {id:"baseline_london_2r",management:"fixed2r",session:"london"},
      {id:"equilibrium_london",management:"equilibrium",session:"london"},
      {id:"split_targets_london",management:"split",session:"london"},
      {id:"baseline_london_plus_ny",management:"fixed2r",session:"london_ny"},
      {id:"split_targets_london_plus_ny",management:"split",session:"london_ny"}
    ];
    const results=variants.map(v=>runBacktest("XAUUSD",xau,"Dukascopy M5 BID/ASK candles",v));
    for (const result of results) { result.splitTime = result.period.from ? Date.parse(result.period.from) + Math.floor((Date.parse(result.period.to)-Date.parse(result.period.from))*0.7) : 0; addTargetOneDiagnostics(result, xau); }
    const report={
      generatedAt:new Date().toISOString(),
      requestedPeriod:{from:new Date(REQUESTED_START).toISOString(),to:new Date(END).toISOString(),days:365},
      data:{candlesM5:xau.filter(b=>b.time>=REQUESTED_START&&b.time<END).length,firstAvailable:new Date(xau[0].time).toISOString(),lastAvailable:new Date(xau[xau.length-1].time).toISOString()},
      baseline:results[0].overall,
      newsFilter:{status:"NOT_RUN",reason:"No verified historical red-USD-event calendar was available in this run; event dates were not guessed or hard-coded."},
      assumptions:{
        setup:"Unchanged PDH/PDL wick sweep followed by immediate M5 close back inside; entry at reclaim close.",
        stop:"Beyond sweep extreme by max(0.1 ATR(14), close*0.00005).",
        tradingDay:"17:00 America/New_York rollover; previous completed trading-session high/low.",
        london:"02:00-05:00 America/New_York, DST-aware.",
        newYork:"08:00-11:00 America/New_York, DST-aware (equivalent to 15:00-18:00 Iran in US daylight time; 16:00-19:00 Iran in US standard time).",
        management:"Equilibrium = midpoint of previous-session high/low. Split model realizes 50% at EQ and 50% at opposite previous-session extreme; original stop remains active.",
        noMaxHoldingTime:true,
        sameCandle:"Stop checked before targets.",
        costs:"Dukascopy BID/ASK spread plus 0.01% adverse slippage per side; broker commission/swap excluded.",
        split:"70% chronological in-sample / 30% out-of-sample within the one-year XAUUSD sample."
      },
      results
    };
    await mkdir("artifacts",{recursive:true});
    await writeFile("artifacts/xauusd-pdh-improvements.json",JSON.stringify(report,null,2));
    const f=x=>x===null?"—":finite(x)?x.toFixed(2):"—";
    const lines=["# XAUUSD PDH/PDL improvement experiments","",
      "Generated: "+report.generatedAt,
      "Period: "+report.requestedPeriod.from+" to "+report.requestedPeriod.to+" UTC",
      "Data: "+report.data.candlesM5+" M5 candles; "+report.data.firstAvailable+" through "+report.data.lastAvailable,
      "Baseline: "+JSON.stringify(report.baseline),
      "News filter: NOT RUN — verified historical event calendar unavailable; no guessed dates used.",
      "",
      "| Variant | Trades | OOS trades | OOS win % | OOS net R | OOS expectancy | OOS PF | OOS max DD R | Overall net R |",
      "|---|---:|---:|---:|---:|---:|---:|---:|---:|"];
    for(const x of results){const o=x.outOfSample;lines.push("| "+x.variant.id+" | "+x.overall.trades+" | "+o.trades+" | "+f(o.winRatePct)+" | "+f(o.netR)+" | "+f(o.expectancyR)+" | "+f(o.profitFactor)+" | "+f(o.maxDrawdownR)+" | "+f(x.overall.netR)+" |");}
    lines.push("","## Method notes","- Every variant uses the same XAUUSD data and chronological split.","- No maximum holding-time exit.","- For the split-target model, 50% is realized at previous-session EQ and 50% at the opposite previous-session extreme; stop remains unchanged.","- New York window is 08:00–11:00 New York local time and follows DST.","- This is a historical simulation; the sample and broker-specific costs limit conclusions.");
    await writeFile("artifacts/xauusd-pdh-improvements.md",lines.join("\n"));
    console.log(JSON.stringify({ok:true,period:report.requestedPeriod,data:report.data,newsFilter:report.newsFilter,
      results:results.map(x=>({variant:x.variant,period:x.period,data:x.data,overall:x.overall,outOfSample:x.outOfSample,target1Touch:x.target1Touch})),
      artifacts:["artifacts/xauusd-pdh-improvements.md","artifacts/xauusd-pdh-improvements.json"]},null,2));
  } finally { await rm(temp,{recursive:true,force:true}); }
}
main().catch(e=>{console.error(e);process.exitCode=1;});

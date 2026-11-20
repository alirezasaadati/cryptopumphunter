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
const MAX_SWEEP_WAIT = 18;
const MAX_MSS_TO_FVG = 6;
const MAX_FVG_RETEST = 12;
const MAX_HOLD = 36;
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
    let csv = await fetchZipCsv(url, dir);
    if (csv) all.push(...parseBinance(csv));
    else {
      const first = new Date(month);
      const next = new Date(Date.UTC(y, month.getUTCMonth()+1, 1));
      for (let d = new Date(first); d < next && d.getTime() < END; d.setUTCDate(d.getUTCDate()+1)) {
        const yy=d.getUTCFullYear(), mm=String(d.getUTCMonth()+1).padStart(2,"0"), dd=String(d.getUTCDate()).padStart(2,"0");
        const daily = symbol + "-" + INTERVAL + "-" + yy + "-" + mm + "-" + dd + ".zip";
        const dailyUrl = "https://data.binance.vision/data/futures/um/daily/klines/" + symbol + "/" + INTERVAL + "/" + daily;
        const dcsv = await fetchZipCsv(dailyUrl, dir);
        if (dcsv) all.push(...parseBinance(dcsv));
      }
    }
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
  const bidFile = files.find(x => x.startsWith("xauusd-bid-") && x.endsWith(".csv"));
  const askFile = files.find(x => x.startsWith("xauusd-ask-") && x.endsWith(".csv"));
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
  const wins=trades.filter(t=>t.netR>0),losses=trades.filter(t=>t.netR<0);
  const grossWin=wins.reduce((s,t)=>s+t.netR,0),grossLoss=Math.abs(losses.reduce((s,t)=>s+t.netR,0));
  let eq=0,peak=0,dd=0;
  for(const t of trades){eq+=t.netR;peak=Math.max(peak,eq);dd=Math.max(dd,peak-eq);}
  return {
    trades:trades.length,wins:wins.length,losses:losses.length,
    winRatePct:trades.length?100*wins.length/trades.length:0,
    netR:trades.reduce((s,t)=>s+t.netR,0),
    expectancyR:trades.length?trades.reduce((s,t)=>s+t.netR,0)/trades.length:0,
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
function calcTrade(symbol,bars,entryIndex,side,entryMid,stopMid,atrAtSweep,entrySpread) {
  const dir=side==="LONG"?1:-1;
  const risk=dir===1?entryMid-stopMid:stopMid-entryMid;
  if(!(risk>0))return null;
  const target=entryMid+dir*risk*TARGET_R;
  let exitMid=null,exitIndex=Math.min(bars.length-1,entryIndex+MAX_HOLD),reason="TIME_EXIT";
  for(let j=entryIndex;j<=exitIndex;j++){
    const b=bars[j];
    const stopHit=dir===1?b.low<=stopMid:b.high>=stopMid;
    const targetHit=dir===1?b.high>=target:b.low<=target;
    if(stopHit){exitMid=stopMid;reason="STOP";exitIndex=j;break;}
    if(targetHit){exitMid=target;reason="TP_2R";exitIndex=j;break;}
  }
  if(exitMid===null){exitMid=bars[exitIndex].close;reason="TIME_EXIT";}
  const entryBar=bars[entryIndex],exitBar=bars[exitIndex];
  const entryFill=costAndFill(symbol,entryBar,side,entryMid,false);
  const exitFill=costAndFill(symbol,exitBar,side,exitMid,true);
  const grossR=dir*(exitFill-entryFill)/risk;
  const fees=symbol==="XAUUSD"?0:BINANCE_FEE*(Math.abs(entryFill)+Math.abs(exitFill))/risk;
  const netR=grossR-fees;
  return {
    symbol,side,signalTime:bars[entryIndex].time,entryTime:bars[entryIndex].time,
    entry:entryFill,entryMid,stop:stopMid,target,exit:exitFill,exitMid,
    exitTime:bars[exitIndex].time,exitReason:reason,riskPrice:risk,
    grossR,feesR:fees,netR,entrySpread:entrySpread||0
  };
}
function findSetup(bars,ind,start,side,level,session) {
  const dir=side==="LONG"?1:-1;
  const sweep=bars[start],atr0=ind.atr[start];
  if(!finite(atr0)||atr0<=0)return {diagnostics:{sweeps:1,invalidAtr:1}};
  const sweepExtreme=side==="LONG"?sweep.low:sweep.high;
  const mssLevel=side==="LONG"?ind.piv.highs[start]:ind.piv.lows[start];
  if(!finite(mssLevel))return {diagnostics:{sweeps:1,noPriorPivot:1}};
  const stopBuffer=Math.max(atr0*0.1,sweep.close*0.00005);
  const stop=side==="LONG"?sweepExtreme-stopBuffer:sweepExtreme+stopBuffer;
  const diag={sweeps:1,mss:0,fvg:0,fills:0};
  const last=Math.min(bars.length-20,start+MAX_SWEEP_WAIT);
  for(let j=start+1;j<=last;j++){
    const mss=side==="LONG"?bars[j].close>mssLevel:bars[j].close<mssLevel;
    if(!mss)continue;
    diag.mss++;
    const fvgLast=Math.min(bars.length-2,j+MAX_MSS_TO_FVG);
    for(let k=j;k<=fvgLast;k++){
      const bull=side==="LONG"&&bars[k].low>bars[k-2].high;
      const bear=side==="SHORT"&&bars[k].high<bars[k-2].low;
      if(!bull&&!bear)continue;
      diag.fvg++;
      const zLow=side==="LONG"?bars[k-2].high:bars[k].high;
      const zHigh=side==="LONG"?bars[k].low:bars[k-2].low;
      const mid=(zLow+zHigh)/2;
      const retestLast=Math.min(bars.length-1,k+MAX_FVG_RETEST);
      for(let e=k+1;e<=retestLast;e++){
        if(sessionKey(bars[e].time)!==session)break;
        if(bars[e].low<=mid&&bars[e].high>=mid){
          const risk=side==="LONG"?mid-stop:stop-mid;
          if(!(risk>=atr0*0.2&&risk<=atr0*3))return {diagnostics:diag,rejectedRisk:true};
          diag.fills++;
          const trade=calcTrade(ind.symbol,bars,e,side,mid,stop,atr0,0);
          return {diagnostics:diag,trade,entryIndex:e};
        }
      }
      return {diagnostics:diag};
    }
  }
  return {diagnostics:diag};
}
function runBacktest(symbol,bars,source) {
  const startIndex=bars.findIndex(b=>b.time>=REQUESTED_START);
  const actual=bars.filter(b=>b.time>=REQUESTED_START&&b.time<END);
  const atr=averageTrueRange(bars),piv=confirmedPivots(bars),levels=dailyLevels(bars);
  const ind={atr,piv,symbol};
  const diag={sessions:levels.keys.length,sweeps:0,mss:0,fvg:0,fills:0,noPriorPivot:0,invalidAtr:0,rejectedRisk:0};
  const trades=[];
  let i=Math.max(50,startIndex);
  let nextFree=0;
  const tradedSessions=new Set();
  while(i<bars.length-2){
    if(i<nextFree){i++;continue;}
    const b=bars[i],session=sessionKey(b.time),prior=levels.prev.get(session);
    if(!prior||tradedSessions.has(session)||!inLondonKillzone(b.time)){i++;continue;}
    let side=null;
    if(b.low<prior.low&&b.close>prior.low)side="LONG";
    else if(b.high>prior.high&&b.close<prior.high)side="SHORT";
    if(!side){i++;continue;}
    const found=findSetup(bars,ind,i,side,side==="LONG"?prior.low:prior.high,session);
    for(const key of Object.keys(found.diagnostics||{}))diag[key]=(diag[key]||0)+found.diagnostics[key];
    if(found.rejectedRisk)diag.rejectedRisk++;
    if(found.trade){
      trades.push(found.trade);diag.fills++;
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
    symbol,source,period:{from:periodStart?new Date(periodStart).toISOString():null,to:periodEnd?new Date(periodEnd).toISOString():null,days:periodStart?Math.round((periodEnd-periodStart)/86400000):0},
    data:{candlesM5:actual.length,firstAvailable:bars[0]?new Date(bars[0].time).toISOString():null,lastAvailable:bars.length?new Date(bars[bars.length-1].time).toISOString():null},
    diagnostics:diag,overall:summarize(trades),inSample:summarize(is),outOfSample:summarize(oos),
    oosBySide:{LONG:summarize(oos.filter(t=>t.side==="LONG")),SHORT:summarize(oos.filter(t=>t.side==="SHORT"))},
    trades
  };
  return result;
}
function mdReport(report) {
  const f=x=>x===null?"—":finite(x)?x.toFixed(2):"—";
  const lines=[
    "# London PDH/PDL Liquidity Sweep — three-market backtest",
    "",
    "Generated: "+report.generatedAt,
    "Requested window: "+report.requestedPeriod.from+" to "+report.requestedPeriod.to+" UTC",
    "Time definition: ICT London Killzone = 02:00–05:00 America/New_York (DST-aware); trading day rolls at 17:00 New York time.",
    "Timeframes: M5 for levels, sweep, MSS, FVG, entry and management.",
    "Setup: previous-session high/low sweep with close back inside; confirmed 2-left/2-right pivot MSS; first directional 3-candle FVG; midpoint retest entry; stop beyond sweep extreme by 0.1 ATR; 2R target; 36-bar time exit.",
    "Costs: Binance symbols use 0.05% taker fee and 0.01% adverse slippage per side. XAUUSD uses Dukascopy bid/ask candle spreads plus 0.01% slippage per side; broker commission/swap excluded.",
    "Conservative intrabar rule: stop is checked before target if both are touched in the same M5 candle. Funding is excluded.",
    "",
    "## Results",
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
  const temp=await mkdtemp(join(tmpdir(),"london-pdh-pdl-"));
  try{
    console.log("Downloading BTCUSDT M5 Binance USD-M Futures data...");
    const btc=await loadBinanceSymbol("BTCUSDT",temp);
    console.log("Downloading XAUUSDT M5 Binance USD-M Futures data...");
    const xaut=await loadBinanceSymbol("XAUUSDT",temp);
    console.log("Downloading XAUUSD M5 Dukascopy BID and ASK data...");
    const xau=await loadXauUsd(temp);
    const results=[];
    for(const [symbol,bars,source] of [
      ["BTCUSDT",btc,"Binance USD-M Futures monthly/daily klines"],
      ["XAUUSDT",xaut,"Binance USD-M Futures monthly/daily klines"],
      ["XAUUSD",xau,"Dukascopy M5 BID/ASK candles"]
    ]){
      if(bars.length<5000){
        results.push({
          symbol,source,status:"insufficient_data",
          period:{from:bars[0]?new Date(bars[0].time).toISOString():null,to:bars.length?new Date(bars[bars.length-1].time).toISOString():null,days:0},
          data:{candlesM5:bars.length,firstAvailable:bars[0]?new Date(bars[0].time).toISOString():null,lastAvailable:bars.length?new Date(bars[bars.length-1].time).toISOString():null},
          diagnostics:{},overall:summarize([]),inSample:summarize([]),outOfSample:summarize([]),oosBySide:{LONG:summarize([]),SHORT:summarize([])},trades:[]
        });
      } else results.push(runBacktest(symbol,bars,source));
    }
    const report={
      generatedAt:new Date().toISOString(),
      requestedPeriod:{from:new Date(REQUESTED_START).toISOString(),to:new Date(END).toISOString(),days:365},
      strategy:{
        killzone:"02:00-05:00 America/New_York, DST-aware",
        tradingDay:"17:00 America/New_York rollover",
        timeframe:"M5",
        liquidity:"previous trading-session high and low",
        sweep:"wick beyond PDH/PDL followed by candle close back inside",
        mss:"close beyond the latest confirmed 2-left/2-right pivot in reversal direction",
        fvg:"first directional 3-candle fair value gap within 6 bars after MSS",
        entry:"50% FVG midpoint retest within 12 bars",
        stop:"beyond sweep extreme by 0.1 ATR(14)",
        target:"2R",
        maxHoldBars:MAX_HOLD,
        sameCandle:"stop checked before target",
        split:"70% chronological in-sample / 30% out-of-sample within each symbol's actual data window"
      },
      costAssumptions:{binanceTakerFeePerSidePct:BINANCE_FEE*100,binanceSlippagePerSidePct:BINANCE_SLIPPAGE*100,xauusd:"Dukascopy bid/ask spread per candle plus 0.01% adverse slippage per side; broker commission/swap excluded",funding:"excluded"},
      results
    };
    await mkdir("artifacts",{recursive:true});
    await writeFile("artifacts/london-pdh-pdl-three-markets.json",JSON.stringify(report,null,2));
    await writeFile("artifacts/london-pdh-pdl-three-markets.md",mdReport(report));
    console.log(JSON.stringify({
      ok:true,requestedPeriod:report.requestedPeriod,strategy:report.strategy,
      results:results.map(x=>({symbol:x.symbol,status:x.status||"completed",data:x.data,period:x.period,diagnostics:x.diagnostics,overall:x.overall,outOfSample:x.outOfSample,oosBySide:x.oosBySide})),
      artifacts:["artifacts/london-pdh-pdl-three-markets.md","artifacts/london-pdh-pdl-three-markets.json"]
    },null,2));
  } finally { await rm(temp,{recursive:true,force:true}); }
}
main().catch(e=>{console.error(e);process.exitCode=1;});

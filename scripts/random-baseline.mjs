import { mkdir, writeFile } from "node:fs/promises";

const BASE = "https://futures.kraken.com";
const HOUR = 3_600_000, DAYS = 365, FEE = 0.0005, SLIP = 0.0003;
const MAX_HOLD = 72, WEIGHTS = [0.40, 0.35, 0.25], MAX_TRADES = 1000;
const ATR_N = 14, SEED = 20261121;

async function getJson(url) {
  const r = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(25000) });
  const body = await r.text();
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${body.slice(0,160)}`);
  return JSON.parse(body);
}
function normalize(rows) {
  const seen = new Set();
  return rows.map(x => ({ time: +x.time < 1e12 ? +x.time * 1000 : +x.time,
    open:+x.open, high:+x.high, low:+x.low, close:+x.close, volume:+x.volume }))
    .filter(c => [c.time,c.open,c.high,c.low,c.close,c.volume].every(Number.isFinite) &&
      c.open>0 && c.low>0 && c.high>=c.low && c.close>0 && c.volume>=0)
    .sort((a,b)=>a.time-b.time).filter(c => { if(seen.has(c.time)) return false; seen.add(c.time); return true; });
}
async function fetchCandles(symbol, from, to) {
  const chunk = HOUR * 1800, all=[];
  for(let s=from;s<to;s+=chunk) {
    const u=new URL(`${BASE}/api/charts/v1/trade/${encodeURIComponent(symbol)}/1h`);
    u.searchParams.set("from",String(Math.floor(s/1000)));
    u.searchParams.set("to",String(Math.floor(Math.min(to,s+chunk)/1000)));
    u.searchParams.set("count","1900");
    const j=await getJson(u); all.push(...normalize(j.candles||[]));
  }
  return [...new Map(all.map(c=>[c.time,c])).values()].sort((a,b)=>a.time-b.time);
}
function atrAt(candles, i) {
  if(i<ATR_N+1) return NaN;
  let sum=0;
  for(let k=i-ATR_N;k<i;k++) {
    const c=candles[k], p=candles[k-1];
    sum += Math.max(c.high-c.low,Math.abs(c.high-p.close),Math.abs(c.low-p.close));
  }
  return sum/ATR_N;
}
function simulate(side, entry, risk, bars, start) {
  const d=side==="LONG"?1:-1, stop=entry-d*risk;
  const targets=[1.5,2.2,3].map(r=>entry+d*risk*r);
  let remaining=1, netR=0, hits=0, exitReason="TIME_EXIT";
  const end=Math.min(bars.length-1,start+MAX_HOLD-1);
  for(let i=start;i<=end && remaining>1e-9;i++) {
    const b=bars[i], gap=d===1?b.open<=stop:b.open>=stop;
    const touched=d===1?b.low<=stop:b.high>=stop;
    if(gap||touched) {
      const raw=gap?b.open:stop, fill=raw*(1-d*SLIP);
      netR += remaining*(d*(fill-entry)/risk - FEE*(entry+fill)/risk);
      remaining=0; exitReason="STOP"; break;
    }
    for(let t=0;t<3 && remaining>1e-9;t++) {
      if(targets[t]===null) continue;
      const hit=d===1?b.high>=targets[t]:b.low<=targets[t];
      if(!hit) break;
      const fill=targets[t]*(1-d*SLIP);
      netR += WEIGHTS[t]*(d*(fill-entry)/risk - FEE*(entry+fill)/risk);
      remaining-=WEIGHTS[t]; targets[t]=null; hits++;
    }
    if(remaining<=1e-9){remaining=0;exitReason="TARGETS";break;}
    if(i===end) {
      const fill=b.close*(1-d*SLIP);
      netR += remaining*(d*(fill-entry)/risk - FEE*(entry+fill)/risk);
      remaining=0;
    }
  }
  return {netR,targetHits:hits,exitReason};
}
function rng(seed){let a=seed>>>0;return()=>{a=(a+0x6D2B79F5)|0;let t=Math.imul(a^(a>>>15),1|a);t^=t+Math.imul(t^(t>>>7),61|t);return((t^(t>>>14))>>>0)/4294967296;};}
function stats(trades){
  const wins=trades.filter(x=>x.netR>0), losses=trades.filter(x=>x.netR<0);
  const gw=wins.reduce((s,x)=>s+x.netR,0), gl=Math.abs(losses.reduce((s,x)=>s+x.netR,0));
  let eq=0,peak=0,dd=0; for(const t of [...trades].sort((a,b)=>a.startTime-b.startTime)){eq+=t.netR;peak=Math.max(peak,eq);dd=Math.max(dd,peak-eq);}
  return {trades:trades.length,wins:wins.length,losses:losses.length,winRatePct:trades.length?100*wins.length/trades.length:0,
    netR:trades.reduce((s,x)=>s+x.netR,0),expectancyR:trades.length?trades.reduce((s,x)=>s+x.netR,0)/trades.length:0,
    profitFactor:gl?gw/gl:null,maxDrawdownR:dd,longCount:trades.filter(x=>x.side==="LONG").length,shortCount:trades.filter(x=>x.side==="SHORT").length};
}
async function main(){
  const end=Date.now(), start=end-DAYS*86400000;
  console.log("Fetching PF_XBTUSD 1h candles...");
  const bars=await fetchCandles("PF_XBTUSD",start,end);
  if(bars.length<500) throw new Error("Insufficient historical candles: "+bars.length);
  const random=rng(SEED), trades=[], maxStart=bars.length-MAX_HOLD-2;
  // Sample unique historical entry indices; each trade is an independent random experiment, not a single-position portfolio.
  const candidates=Array.from({length:maxStart-ATR_N-1},(_,k)=>k+ATR_N+1);
  for(let i=candidates.length-1;i>0;i--){const j=Math.floor(random()*(i+1));[candidates[i],candidates[j]]=[candidates[j],candidates[i]];}
  for(const idx of candidates.slice(0,Math.min(MAX_TRADES,candidates.length))){
    const atr=atrAt(bars,idx); if(!Number.isFinite(atr)||atr<=0) continue;
    const side=random()<0.5?"LONG":"SHORT", d=side==="LONG"?1:-1;
    const entry=bars[idx].open*(1+d*SLIP), risk=atr*1.5;
    const result=simulate(side,entry,risk,bars,idx);
    trades.push({side,entry,stop:entry-d*risk,atr,startTime:bars[idx].time,...result});
  }
  const report={symbol:"PF_XBTUSD",interval:"1h",period:{from:new Date(start).toISOString(),to:new Date(end).toISOString(),days:DAYS},
    candles:bars.length,seed:SEED,settings:{feePerSide:FEE,slippagePerSide:SLIP,atrWindow:ATR_N,stopDistance:"1.5 x ATR calculated using only candles before entry",
      targetsR:[1.5,2.2,3],targetWeights:WEIGHTS,maxHoldHours:MAX_HOLD,sample:"unique random entry timestamps; independent trades; overlap allowed; not a portfolio simulation",
      intrabarRule:"stop checked before targets; conservative when both are touched",funding:"excluded"},
    summary:stats(trades),bySide:{LONG:stats(trades.filter(t=>t.side==="LONG")),SHORT:stats(trades.filter(t=>t.side==="SHORT"))},trades};
  await mkdir("artifacts",{recursive:true});
  await writeFile("artifacts/random-baseline-results.json",JSON.stringify(report,null,2));
  await writeFile("artifacts/random-baseline-results.md",[
    "# Random baseline — PF_XBTUSD 1h",`Period: ${report.period.from} — ${report.period.to}`,`Candles: ${bars.length}`,
    "", "| Trades | Win % | Net R | Expectancy R | PF | Max DD R | LONG | SHORT |",
    "|---:|---:|---:|---:|---:|---:|---:|---:|",
    `| ${report.summary.trades} | ${report.summary.winRatePct.toFixed(2)} | ${report.summary.netR.toFixed(2)} | ${report.summary.expectancyR.toFixed(4)} | ${report.summary.profitFactor?.toFixed(3)??"N/A"} | ${report.summary.maxDrawdownR.toFixed(2)} | ${report.summary.longCount} | ${report.summary.shortCount} |`,
    "", "## By side", "LONG: "+JSON.stringify(report.bySide.LONG), "SHORT: "+JSON.stringify(report.bySide.SHORT),
    "", "ATR is calculated using only pre-entry candles. Fees and slippage are charged on entry and every exit. Trades are independent random samples and may overlap; drawdown is therefore a diagnostic sequence, not portfolio drawdown. Funding is excluded."
  ].join("\n"));
  console.log(JSON.stringify({period:report.period,candles:bars.length,summary:report.summary,bySide:report.bySide},null,2));
}
main().catch(e=>{console.error(e);process.exitCode=1;});

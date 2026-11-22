// Isolated historical backtest for the user's exact v9.1.0 LONG 15m strategy.
// No production source is imported or modified.
import { mkdir, writeFile } from "node:fs/promises";

const BASE = "https://futures.kraken.com";
const SYMBOLS = [
  "PF_XBTUSD", "PF_ETHUSD", "PF_SOLUSD", "PF_XRPUSD", "PF_DOGEUSD",
  "PF_ADAUSD", "PF_LINKUSD", "PF_LTCUSD", "PF_BCHUSD", "PF_AVAXUSD"
];
const MS = 60_000;
const TF = 15 * MS;
const FEE = 0.0005;
const SLIPPAGE = 0.0003;
const STOP_BUFFER_ATR = 0.1;
const TARGET_R = 1.5;
const MAX_RISK_PCT = 1.5;
const MIN_CANDLES = 60;
const REGIMES = [
  { name: "bullish", label: "صعودی", from: "2024-10-01T00:00:00Z", to: "2024-11-01T00:00:00Z" },
  { name: "bearish", label: "نزولی", from: "2025-02-01T00:00:00Z", to: "2025-03-01T00:00:00Z" },
  { name: "neutral", label: "خنثی", from: "2023-09-01T00:00:00Z", to: "2023-10-01T00:00:00Z" }
];

async function getJson(url) {
  const response = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(30000) });
  const body = await response.text();
  if (!response.ok) throw new Error("HTTP " + response.status + ": " + body.slice(0, 200));
  const data = JSON.parse(body);
  if (!Array.isArray(data?.candles)) throw new Error("Kraken candles missing: " + body.slice(0, 200));
  return data;
}

function normalize(rows) {
  const map = new Map();
  for (const row of rows) {
    const time = Number(row.time) < 1e12 ? Number(row.time) * 1000 : Number(row.time);
    const c = { time, open:Number(row.open), high:Number(row.high), low:Number(row.low), close:Number(row.close), volume:Number(row.volume) };
    if ([c.time,c.open,c.high,c.low,c.close].every(Number.isFinite) && c.open>0 && c.low>0 && c.close>0 && c.high>=c.low) map.set(time,c);
  }
  return [...map.values()].sort((a,b)=>a.time-b.time);
}

async function fetchCandles(symbol, fromMs, toMs) {
  const chunkMs = TF * 1700;
  const all = [];
  for (let from=fromMs; from<toMs; from+=chunkMs) {
    const to = Math.min(toMs, from+chunkMs);
    const url = new URL(BASE + "/api/charts/v1/trade/" + encodeURIComponent(symbol) + "/15m");
    url.searchParams.set("from", String(Math.floor(from/1000)));
    url.searchParams.set("to", String(Math.floor(to/1000)));
    url.searchParams.set("count", "1800");
    const data = await getJson(url);
    all.push(...data.candles);
    await new Promise(resolve=>setTimeout(resolve,120));
  }
  return normalize(all).filter(c=>c.time+TF<=toMs);
}

function average(a) { return a.length ? a.reduce((s,x)=>s+x,0)/a.length : 0; }
function ema(values, period) {
  if (values.length<period) return null;
  const k=2/(period+1);
  let v=average(values.slice(0,period));
  for(let i=period;i<values.length;i++) v=values[i]*k+v*(1-k);
  return v;
}
function rsi(values, period=14) {
  if(values.length<=period) return null;
  let gains=0,losses=0;
  for(let i=1;i<=period;i++){const d=values[i]-values[i-1];gains+=Math.max(d,0);losses+=Math.max(-d,0);}
  let ag=gains/period,al=losses/period;
  for(let i=period+1;i<values.length;i++){const d=values[i]-values[i-1];ag=(ag*(period-1)+Math.max(d,0))/period;al=(al*(period-1)+Math.max(-d,0))/period;}
  if(al===0)return 100;
  if(ag===0)return 0;
  return 100-100/(1+ag/al);
}
function atr(candles,period=14) {
  if(candles.length<=period)return null;
  const ranges=[];
  for(let i=1;i<candles.length;i++){const c=candles[i],p=candles[i-1].close;ranges.push(Math.max(c.high-c.low,Math.abs(c.high-p),Math.abs(c.low-p)));}
  return average(ranges.slice(-period));
}

// Mirrors analyzeLongScalp exactly, with backtestEntryOpen supplied as next candle open.
function analyzeSignal(symbol,candles,entryOpen) {
  if(candles.length<MIN_CANDLES)return null;
  const last=candles[candles.length-1],prev=candles[candles.length-2],prev2=candles[candles.length-3];
  const closes=candles.map(c=>c.close);
  const rv=rsi(closes,14),e20=ema(closes,20),a=atr(candles,14);
  if(!rv||!a||!e20)return null; // preserves source's falsy-indicator guard
  if(!(last.close>e20*0.998))return null;
  if(rv>60)return null;
  const green=last.close>last.open;
  const engulf=last.close>prev.open;
  if(!green||!engulf)return null;
  const entry=entryOpen;
  const lowest=Math.min(prev.low,prev2.low);
  const stop=lowest-a*STOP_BUFFER_ATR;
  const risk=entry-stop;
  const riskPct=(risk/entry)*100;
  if(risk<=0||riskPct>MAX_RISK_PCT)return null;
  return {symbol,side:"LONG",entry,stop,target1:entry+risk*TARGET_R,risk,riskPct};
}

function executeTrade(signal, candles) {
  const entryFill=signal.entry*(1+SLIPPAGE);
  for(const bar of candles) {
    const stopGap=bar.open<=signal.stop;
    const stopTouch=bar.low<=signal.stop;
    const targetTouch=bar.high>=signal.target1;
    // Conservative intrabar ambiguity: stop is assumed first.
    if(stopGap||stopTouch) {
      const raw=stopGap?bar.open:signal.stop;
      const exit=raw*(1-SLIPPAGE);
      const netR=(exit-entryFill)/signal.risk-(FEE*(entryFill+exit))/signal.risk;
      return {outcome:"STOP",exitTime:bar.time,exitPrice:exit,netR};
    }
    if(targetTouch) {
      const exit=signal.target1*(1-SLIPPAGE);
      const netR=(exit-entryFill)/signal.risk-(FEE*(entryFill+exit))/signal.risk;
      return {outcome:"TARGET_1_5R",exitTime:bar.time,exitPrice:exit,netR};
    }
  }
  const last=candles[candles.length-1];
  if(!last)return {outcome:"OPEN",exitTime:null,exitPrice:null,netR:null};
  const exit=last.close*(1-SLIPPAGE);
  const netR=(exit-entryFill)/signal.risk-(FEE*(entryFill+exit))/signal.risk;
  return {outcome:"OPEN_AT_PERIOD_END",exitTime:last.time,exitPrice:exit,netR};
}

function maxDrawdownR(trades) {
  let equity=0,peak=0,dd=0;
  for(const t of trades){if(t.netR==null)continue;equity+=t.netR;peak=Math.max(peak,equity);dd=Math.max(dd,peak-equity);}
  return dd;
}
function stats(trades) {
  const closed=trades.filter(t=>t.outcome==="STOP"||t.outcome==="TARGET_1_5R");
  const wins=closed.filter(t=>t.netR>0),losses=closed.filter(t=>t.netR<0);
  const gp=wins.reduce((s,t)=>s+t.netR,0),gl=Math.abs(losses.reduce((s,t)=>s+t.netR,0));
  return {
    signals:trades.length,closed:closed.length,targets:closed.filter(t=>t.outcome==="TARGET_1_5R").length,
    stops:closed.filter(t=>t.outcome==="STOP").length,openAtEnd:trades.filter(t=>t.outcome==="OPEN_AT_PERIOD_END").length,
    wins:wins.length,losses:losses.length,winRatePct:closed.length?wins.length/closed.length*100:0,
    netR:trades.reduce((s,t)=>s+(t.netR||0),0),closedNetR:closed.reduce((s,t)=>s+t.netR,0),
    expectancyR:closed.length?closed.reduce((s,t)=>s+t.netR,0)/closed.length:0,
    profitFactor:gl?gp/gl:(gp>0?null:0),maxDrawdownR:maxDrawdownR(trades)
  };
}

async function testRegime(regime) {
  const from=Date.parse(regime.from),to=Date.parse(regime.to),warm=from-24*60*60*1000;
  const reports=[],failures=[];
  for(const symbol of SYMBOLS) {
    console.log("[" + regime.name + "] downloading " + symbol);
    try {
      const candles=await fetchCandles(symbol,warm,to);
      const usable=candles.filter(c=>c.time>=warm&&c.time+TF<=to);
      if(usable.length<MIN_CANDLES+2)throw new Error("Insufficient candles: "+usable.length);
      const trades=[];
      let nextEntryIndex=MIN_CANDLES;
      for(let i=MIN_CANDLES-1;i<usable.length-1;i++) {
        const signalClose=usable[i].time+TF;
        if(signalClose<from)continue;
        if(i<nextEntryIndex)continue;
        const entryBar=usable[i+1];
        const signal=analyzeSignal(symbol,usable.slice(0,i+1),entryBar.open);
        if(!signal)continue;
        const result=executeTrade(signal,usable.slice(i+1));
        trades.push({symbol,signalTime:usable[i].time,entryTime:entryBar.time,entry:signal.entry,stop:signal.stop,target:signal.target1,riskPct:signal.riskPct,...result});
        if(result.exitTime!=null) {
          const exitIndex=usable.findIndex(c=>c.time===result.exitTime);
          nextEntryIndex=Math.max(i+1,exitIndex+1);
        } else nextEntryIndex=usable.length;
      }
      reports.push({symbol,candleCount:usable.length,...stats(trades),trades});
      console.log(JSON.stringify({regime:regime.name,symbol,...stats(trades)}));
    } catch(e) {
      failures.push({symbol,error:String(e?.message||e)});
      console.error("FAILED "+regime.name+" "+symbol+": "+String(e?.message||e));
    }
  }
  const all=reports.flatMap(r=>r.trades);
  const closed=all.filter(t=>t.outcome==="STOP"||t.outcome==="TARGET_1_5R");
  const btc=reports.find(r=>r.symbol==="PF_XBTUSD");
  const btcFirst=btc?.trades[0];
  const btcLast=btc?.trades.at(-1);
  const btcChange=btcFirst&&btcLast?((btcLast.entry/btcFirst.entry)-1)*100:null;
  return {
    regime:regime.name,label:regime.label,period:{from:regime.from,to:regime.to},
    btcPriceChangePct:btcChange,requestedSymbols:SYMBOLS.length,testedSymbols:reports.length,failures,
    aggregate:stats(all),perSymbol:reports.map(({trades,...r})=>r),trades:all
  };
}

async function main() {
  const results=[];
  for(const regime of REGIMES)results.push(await testRegime(regime));
  const report={
    generatedAt:new Date().toISOString(),strategy:"CRYPTO PUMP HUNTER v9.1.0 LONG Fast Scalp",
    rules:{timeframe:"15m",symbols:SYMBOLS,minCandles:MIN_CANDLES,entry:"next 15m candle open after signal candle closes",ema:"close > EMA20 * 0.998",rsi:"RSI(14) <= 60",priceAction:"green signal candle and signal close > previous candle open",stop:"min(previous low, prior-previous low) - 0.1 * ATR(14)",maxRiskPct:MAX_RISK_PCT,target:"1.5R full exit",positionConcurrency:"one active trade per symbol"},
    execution:{feePerSidePct:FEE*100,slippagePerSidePct:SLIPPAGE*100,sameCandleRule:"stop first",funding:"excluded",openAtEnd:"marked to market for netR but excluded from closed win rate",pnlUnit:"R; no position sizing or leverage was specified"},
    results
  };
  await mkdir("artifacts",{recursive:true});
  await writeFile("artifacts/v910-three-regime-backtest.json",JSON.stringify(report,null,2));
  const lines=[
    "# v9.1.0 LONG 15m — three-regime historical backtest",
    "",
    "| Regime | Period UTC | BTC change | Symbols | Trades | Wins | Losses | Win rate | Net R | PF | Max DD (R) |",
    "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ...results.map(r=>"| "+r.label+" | "+r.period.from.slice(0,10)+" to "+r.period.to.slice(0,10)+" | "+(r.btcPriceChangePct==null?"n/a":r.btcPriceChangePct.toFixed(2)+"%")+" | "+r.testedSymbols+"/10 | "+r.aggregate.closed+" | "+r.aggregate.wins+" | "+r.aggregate.losses+" | "+r.aggregate.winRatePct.toFixed(2)+"% | "+r.aggregate.closedNetR.toFixed(2)+" | "+(r.aggregate.profitFactor==null?"∞":r.aggregate.profitFactor.toFixed(2))+" | "+r.aggregate.maxDrawdownR.toFixed(2)+" |"),
    "",
    "## Assumptions",
    "- Exact v9.1.0 signal rules copied from the submitted code; no strategy thresholds changed.",
    "- 15m signal candle must close before entry; entry is the following candle open.",
    "- 0.05% fee and 0.03% adverse slippage per side; funding excluded.",
    "- If stop and target are both touched in one candle, stop is counted first.",
    "- One active trade per symbol; other symbols may have concurrent positions.",
    "- Open positions at the period boundary are marked to market and excluded from closed win rate.",
    "- Results are reported in R because no position size or leverage was specified.",
    "",
    "## Per-symbol details",
    ...results.flatMap(r=>["### "+r.label,...r.perSymbol.map(s=>"- "+s.symbol+": "+s.closed+" closed, "+s.wins+" wins, "+s.losses+" losses, "+s.winRatePct.toFixed(1)+"% win rate, "+s.closedNetR.toFixed(2)+"R, PF "+(s.profitFactor==null?"∞":s.profitFactor.toFixed(2))),...(r.failures.length?["Failures: "+JSON.stringify(r.failures)]:[]),""])
  ];
  await writeFile("artifacts/v910-three-regime-backtest.md",lines.join("\n"));
  console.log("FINAL_SUMMARY");
  console.log(JSON.stringify(results.map(r=>({regime:r.label,period:r.period,btcPriceChangePct:r.btcPriceChangePct,testedSymbols:r.testedSymbols,failures:r.failures,aggregate:r.aggregate,perSymbol:r.perSymbol.map(s=>({symbol:s.symbol,closed:s.closed,wins:s.wins,losses:s.losses,winRatePct:s.winRatePct,closedNetR:s.closedNetR,profitFactor:s.profitFactor,maxDrawdownR:s.maxDrawdownR}))})),null,2));
  if(results.every(r=>r.testedSymbols===0))throw new Error("No symbols were successfully backtested.");
}
main().catch(e=>{console.error(e);process.exitCode=1;});

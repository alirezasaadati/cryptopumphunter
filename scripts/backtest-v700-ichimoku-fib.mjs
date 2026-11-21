// Isolated historical harness for the supplied v7.0.0 LONG engine.
// Strategy rules below mirror the user's code; only historical data loading and
// trade execution/accounting are added for backtesting.
import fs from "node:fs/promises";

const CFG = {
  MIN_CANDLES: 150, MIN_SCORE: 65, TARGET_1_R: 2.0, TARGET_2_R: 3.5,
  STOP_BUFFER_ATR: 0.2, MAX_RISK_PCT: 2.5
};
const SYMBOLS = [
  "PF_XBTUSD","PF_ETHUSD","PF_SOLUSD","PF_XRPUSD","PF_DOGEUSD",
  "PF_ADAUSD","PF_LINKUSD","PF_LTCUSD","PF_BCHUSD","PF_AVAXUSD"
];
const PERIODS = [
  {name:"Bull run 2023-10 to 2023-12", start:"2023-10-01T00:00:00Z", end:"2023-12-01T00:00:00Z"},
  {name:"Bull run 2024-10 to 2024-12", start:"2024-10-01T00:00:00Z", end:"2024-12-01T00:00:00Z"}
];
const FEE_RATE = 0.0005, SLIPPAGE_RATE = 0.0003;
const HOUR = 3600_000;

function average(values) { return values.length ? values.reduce((a,b)=>a+b,0)/values.length : 0; }
function calculateAtr(candles, period=14) {
  if (candles.length <= period) return null;
  const ranges=[];
  for(let i=1;i<candles.length;i++){
    const c=candles[i], p=candles[i-1].close;
    ranges.push(Math.max(c.high-c.low,Math.abs(c.high-p),Math.abs(c.low-p)));
  }
  return average(ranges.slice(-period));
}
function calculateIchimoku(candles) {
  if(candles.length<78) return null;
  const avg=(arr,start,end)=>{
    let hi=-Infinity,lo=Infinity;
    for(let i=start;i<end;i++){ if(arr[i].high>hi)hi=arr[i].high; if(arr[i].low<lo)lo=arr[i].low; }
    return (hi+lo)/2;
  };
  const n=candles.length;
  const tenkan=avg(candles,n-9,n);
  const kijun=avg(candles,n-26,n);
  const senkouA=(avg(candles,n-35,n-26)+avg(candles,n-52,n-26))/2;
  const senkouB=avg(candles,n-78,n-26);
  return {tenkan,kijun,senkouA,senkouB,cloudTop:Math.max(senkouA,senkouB),cloudBottom:Math.min(senkouA,senkouB)};
}
function analyzeAt(ticker, candles) {
  if(candles.length<CFG.MIN_CANDLES) return null;
  const last=candles[candles.length-1], atr=calculateAtr(candles,14), ichi=calculateIchimoku(candles);
  if(!ichi||!atr) return null;
  if(last.close<ichi.cloudTop||last.close<ichi.kijun) return null;
  const lookback=candles.slice(-40);
  let swingHigh=-Infinity,swingLow=Infinity,highIndex=-1,lowIndex=-1;
  for(let i=0;i<lookback.length;i++){
    if(lookback[i].high>swingHigh){swingHigh=lookback[i].high;highIndex=i;}
    if(lookback[i].low<swingLow){swingLow=lookback[i].low;lowIndex=i;}
  }
  if(lowIndex>=highIndex||highIndex===-1) return null;
  const range=swingHigh-swingLow, fib50=swingHigh-range*0.50, fib618=swingHigh-range*0.618;
  if(last.close>fib50||last.close<fib618) return null;
  if(last.close<=last.open||last.close<ichi.cloudTop) return null;
  const stop=ichi.cloudBottom-atr*CFG.STOP_BUFFER_ATR;
  // Entry is supplied by the next candle open in the execution loop.
  return {symbol:ticker,stop,score:80,signalClose:last.close,signalTime:last.time};
}
async function fetchCandles(symbol, fromMs, toMs) {
  const params=new URLSearchParams({from:String(Math.floor(fromMs/1000)),to:String(Math.floor(toMs/1000)),count:"5000"});
  const url=`https://futures.kraken.com/api/charts/v1/trade/${encodeURIComponent(symbol)}/1h?${params}`;
  const res=await fetch(url,{headers:{Accept:"application/json"}});
  if(!res.ok) throw new Error(`HTTP ${res.status} for ${symbol}`);
  const json=await res.json();
  if(!Array.isArray(json.candles)) throw new Error(`No candles for ${symbol}: ${JSON.stringify(json).slice(0,250)}`);
  return json.candles.map(x=>({time:Number(x.time),open:Number(x.open),high:Number(x.high),low:Number(x.low),close:Number(x.close),volume:Number(x.volume)}))
    .filter(c=>Number.isFinite(c.close)&&c.close>0).sort((a,b)=>a.time-b.time);
}
function simulate(candles, signalIndex, setup, targetR) {
  const entryBar=candles[signalIndex+1];
  if(!entryBar) return null;
  const entry=entryBar.open, stop=setup.stop, risk=entry-stop, riskPct=risk/entry*100;
  if(!(risk>0)||riskPct>CFG.MAX_RISK_PCT) return null;
  const target=entry+risk*targetR;
  for(let j=signalIndex+1;j<candles.length;j++){
    const c=candles[j];
    const stopHit=c.low<=stop, targetHit=c.high>=target;
    // Conservative intrabar ordering when both levels trade in the same candle.
    if(stopHit&&targetHit) return finish("LOSS",-1,stop,entry,risk,c.time,j-signalIndex);
    if(stopHit) return finish("LOSS",-1,stop,entry,risk,c.time,j-signalIndex);
    if(targetHit) return finish("WIN",targetR,target,entry,risk,c.time,j-signalIndex);
  }
  const last=candles[candles.length-1];
  const gross=(last.close-entry)/risk;
  return finish(gross>0?"OPEN_WIN":gross<0?"OPEN_LOSS":"BREAKEVEN",gross,last.close,entry,risk,last.time,candles.length-1-signalIndex);
}
function finish(outcome,grossR,exit,entry,risk,exitTime,holdBars){
  const costs=(entry*(FEE_RATE+SLIPPAGE_RATE)+exit*(FEE_RATE+SLIPPAGE_RATE))/risk;
  // Cost model: round-trip taker fee + adverse slippage on entry and exit.
  return {outcome,grossR,netR:grossR-costs,entry,exit,risk,exitTime,holdBars,costR:costs};
}
function summarize(trades){
  const wins=trades.filter(t=>t.grossR>0).length, losses=trades.filter(t=>t.grossR<0).length;
  const grossWin=trades.filter(t=>t.netR>0).reduce((s,t)=>s+t.netR,0);
  const grossLoss=Math.abs(trades.filter(t=>t.netR<0).reduce((s,t)=>s+t.netR,0));
  const net=trades.reduce((s,t)=>s+t.netR,0);
  let equity=0,peak=0,maxDD=0;
  for(const t of trades){equity+=t.netR;peak=Math.max(peak,equity);maxDD=Math.max(maxDD,peak-equity);}
  return {trades:trades.length,wins,losses,breakeven:trades.length-wins-losses,winRatePct:trades.length?100*wins/trades.length:0,netR:net,profitFactor:grossLoss?grossWin/grossLoss:(grossWin?null:0),maxDrawdownR:maxDD,avgNetR:trades.length?net/trades.length:0};
}

const results=[], failures=[];
for(const period of PERIODS){
  const start=Date.parse(period.start), end=Date.parse(period.end);
  const fetchStart=start-220*HOUR, fetchEnd=end+24*HOUR;
  for(const symbol of SYMBOLS){
    try{
      const all=await fetchCandles(symbol,fetchStart,fetchEnd);
      const candles=all.filter(c=>c.time>=fetchStart&&c.time<fetchEnd);
      if(candles.length<CFG.MIN_CANDLES+5){failures.push({period:period.name,symbol,error:`Only ${candles.length} candles`});continue;}
      const tradesByTarget={2:[],3.5:[]};
      for(const targetR of [CFG.TARGET_1_R,CFG.TARGET_2_R]){
        let blockedUntil=-1;
        for(let i=CFG.MIN_CANDLES-1;i<candles.length-1;i++){
          if(candles[i].time<start||candles[i].time>=end||i<=blockedUntil) continue;
          const setup=analyzeAt(symbol,candles.slice(0,i+1));
          if(!setup) continue;
          const trade=simulate(candles,i,setup,targetR);
          if(!trade) continue;
          tradesByTarget[targetR].push({...trade,symbol,period:period.name,signalTime:setup.signalTime});
          // Keep each target's trade stream independent; no overlapping positions per symbol.
          blockedUntil=i+trade.holdBars;
        }
      }
      for(const [target,trades] of Object.entries(tradesByTarget)){
        results.push({period:period.name,symbol,targetR:Number(target),...summarize(trades),tradeDetails:trades});
      }
    }catch(e){failures.push({period:period.name,symbol,error:String(e.message||e)});}
    await new Promise(r=>setTimeout(r,180));
  }
}
const grouped={};
for(const target of [2,3.5]){
  const trades=results.filter(r=>r.targetR===target).flatMap(r=>r.tradeDetails);
  grouped[target]=summarize(trades);
}
const output={strategy:"Crypto Pump Hunter v7.0.0 LONG Ichimoku + Fib",generatedAt:new Date().toISOString(),symbols:SYMBOLS,periods:PERIODS,assumptions:{timeframe:"1h",entry:"next candle open after signal candle closes",stop:"Kumo bottom minus 0.2 ATR",targetR:[2,3.5],intrabar:"stop-first if stop and target both touch in one candle",overlap:"one open trade per symbol; no overlapping entries",positionExit:"stop or target; if neither occurs before end of fetched data, mark to final close",fees:"0.05% per side",slippage:"0.03% adverse per side",funding:"not included",breakeven:"not simulated; source only stores moveToBreakevenAt metadata and does not implement stop movement",capitalOrLeverage:"not applied; results in R"},summary:grouped,byPeriodSymbol:results.map(({tradeDetails,...rest})=>rest),failures,details:results};
await fs.mkdir("artifacts",{recursive:true});
await fs.writeFile("artifacts/v700-ichimoku-fib.json",JSON.stringify(output,null,2));
const lines=[
"# v7.0.0 LONG Ichimoku + Fib — Historical Backtest",
"",
`Generated: ${output.generatedAt}`,
"",
"## Aggregate results",
"",
"| Target | Trades | Wins | Losses | Win rate | Net R | Profit factor | Max DD (R) |",
"|---:|---:|---:|---:|---:|---:|---:|---:|",
...Object.entries(grouped).map(([r,s])=>`| ${r}R | ${s.trades} | ${s.wins} | ${s.losses} | ${s.winRatePct.toFixed(2)}% | ${s.netR.toFixed(2)} | ${s.profitFactor===null?"∞":s.profitFactor.toFixed(3)} | ${s.maxDrawdownR.toFixed(2)} |`),
"",
"## Per-period / symbol",
"",
"| Period | Symbol | Target | Trades | Wins | Losses | Win rate | Net R | PF |",
"|---|---|---:|---:|---:|---:|---:|---:|---:|",
...results.map(r=>`| ${r.period} | ${r.symbol} | ${r.targetR}R | ${r.trades} | ${r.wins} | ${r.losses} | ${r.winRatePct.toFixed(2)}% | ${r.netR.toFixed(2)} | ${r.profitFactor===null?"∞":r.profitFactor.toFixed(3)} |`),
"",
"## Assumptions and limitations",
"",
"- 1h candles from Kraken Futures Charts API with explicit from/to timestamps; 220h warmup.",
"- Signal rules and Ichimoku/Fibonacci calculations are transcribed from the supplied v7.0.0 code.",
"- Entry is next candle open; stop-first on ambiguous same-candle stop/target hits.",
"- One position per symbol at a time; positions are closed at stop/target or marked to final available close.",
"- Fees 0.05% per side and adverse slippage 0.03% per side; funding, leverage and liquidation are excluded.",
"- Breakeven management is not simulated because the supplied function only returns metadata and does not implement a stop update.",
"- Results are in R, not account-currency returns.",
"",
"## Data failures",
"",
...(failures.length?failures.map(f=>`- ${f.period} / ${f.symbol}: ${f.error}`):["- None"])
];
await fs.writeFile("artifacts/v700-ichimoku-fib.md",lines.join("\n"));
console.log(JSON.stringify({summary:grouped,rows:results.length,failures},null,2));

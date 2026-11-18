import {mkdir,writeFile} from "node:fs/promises";
import {detectCandlestickSignals,CANDLE_CONFIG} from "../src/candlestick-engine.js";

const BASE="https://futures.kraken.com";
const INTERVAL_MS=15*60*1000;
const DAYS=Math.max(30,Math.min(180,Number(process.env.BACKTEST_DAYS||90)));
const SYMBOLS=Math.max(3,Math.min(24,Number(process.env.BACKTEST_SYMBOLS||12)));
const FEE=Number(process.env.BACKTEST_FEE||0.0005);
const SLIPPAGE=Number(process.env.BACKTEST_SLIPPAGE||0.0002);
const NOTIONAL=Number(process.env.BACKTEST_NOTIONAL_USD||50);
const PATTERNS=["bullish_engulfing","bearish_engulfing","bullish_pin_bar","bearish_pin_bar","morning_star","evening_star","piercing_line","dark_cloud_cover","three_white_soldiers","three_black_crows","inside_bar_breakout_long","inside_bar_breakout_short"];
const PRIORITY=["three_white_soldiers","three_black_crows","morning_star","evening_star","bullish_engulfing","bearish_engulfing","piercing_line","dark_cloud_cover","bullish_pin_bar","bearish_pin_bar","inside_bar_breakout_long","inside_bar_breakout_short"];

async function json(url){
  const r=await fetch(url,{headers:{accept:"application/json"},signal:AbortSignal.timeout(25000)});
  const t=await r.text();if(!r.ok)throw new Error("HTTP "+r.status+" "+t.slice(0,160));
  const d=JSON.parse(t);if(d?.result==="error")throw new Error(JSON.stringify(d.errors||d.error));return d;
}
function normalize(rows){
  const seen=new Set();
  return (rows||[]).map(x=>({time:Number(x.time)<1e12?Number(x.time)*1000:Number(x.time),open:+x.open,high:+x.high,low:+x.low,close:+x.close,volume:+x.volume||0}))
    .filter(x=>[x.time,x.open,x.high,x.low,x.close].every(Number.isFinite)&&x.open>0&&x.low>0&&x.high>=Math.max(x.open,x.close)&&x.low<=Math.min(x.open,x.close))
    .sort((a,b)=>a.time-b.time).filter(x=>{if(seen.has(x.time)||x.time+INTERVAL_MS>Date.now())return false;seen.add(x.time);return true;});
}
async function fetchCandles(symbol,from,to){
  const chunkMs=9*24*60*60*1000, all=[];
  for(let a=from;a<to;a+=chunkMs){
    const b=Math.min(to,a+chunkMs),u=new URL(BASE+"/api/charts/v1/trade/"+encodeURIComponent(symbol)+"/15m");
    u.searchParams.set("from",String(Math.floor(a/1000)));u.searchParams.set("to",String(Math.floor(b/1000)));u.searchParams.set("count","1000");
    const d=await json(u);if(d.more_candles===true)throw new Error(symbol+": chunk too large; Kraken reports more_candles");
    all.push(...normalize(d.candles));
  }
  const unique=new Map(all.map(x=>[x.time,x]));
  return [...unique.values()].sort((a,b)=>a.time-b.time);
}
function simulate(signal,bars,entryIndex){
  const dir=signal.side==="LONG"?1:-1,entry=bars[entryIndex].open*(1+dir*SLIPPAGE);
  const risk=dir===1?entry-signal.stop:signal.stop-entry;
  if(!(risk>0)||risk/entry<CANDLE_CONFIG.MIN_RISK_PCT||risk/entry>CANDLE_CONFIG.MAX_RISK_PCT)return null;
  const targets=CANDLE_CONFIG.TARGET_R_MULTIPLES.map(r=>entry+dir*risk*r);
  let remaining=1,netR=0,targetHits=0,exitReason="TIME_EXIT",exitTime=null;
  const end=Math.min(bars.length-1,entryIndex+CANDLE_CONFIG.MAX_HOLD_BARS);
  function realize(raw,weight){
    const fill=raw*(1-dir*SLIPPAGE),gross=dir*(fill-entry)/risk,fees=FEE*(entry+fill)/risk;
    netR+=weight*(gross-fees);remaining-=weight;
  }
  for(let i=entryIndex;i<=end&&remaining>1e-9;i++){
    const bar=bars[i],gap=dir===1?bar.open<=signal.stop:bar.open>=signal.stop;
    const stopTouched=dir===1?bar.low<=signal.stop:bar.high>=signal.stop;
    if(gap||stopTouched){realize(gap?bar.open:signal.stop,remaining);exitReason="STOP";exitTime=bar.time;break;}
    for(let t=0;t<targets.length&&remaining>1e-9;t++){
      const hit=dir===1?bar.high>=targets[t]:bar.low<=targets[t];
      if(hit){const weight=Math.min(CANDLE_CONFIG.TARGET_WEIGHTS[t],remaining);realize(targets[t],weight);targetHits++;if(remaining<=1e-9){exitReason="TARGETS";exitTime=bar.time;break;}}
    }
    if(i===end&&remaining>1e-9){realize(bar.close,remaining);exitReason="TIME_EXIT";exitTime=bar.time;}
  }
  const riskPct=risk/entry;
  return {pattern:signal.pattern,side:signal.side,signalTime:signal.signalTime,entryTime:bars[entryIndex].time,exitTime,entry,stop:signal.stop,riskPct,netR,targetHits,exitReason,netPnlUsd:netR*riskPct*NOTIONAL};
}
function summary(trades){
  const ordered=[...trades].sort((a,b)=>a.exitTime-b.exitTime),wins=ordered.filter(x=>x.netR>0),losses=ordered.filter(x=>x.netR<0);
  const gp=wins.reduce((s,x)=>s+x.netR,0),gl=Math.abs(losses.reduce((s,x)=>s+x.netR,0));
  let eq=0,peak=0,dd=0;for(const t of ordered){eq+=t.netR;peak=Math.max(peak,eq);dd=Math.max(dd,peak-eq);}
  return {trades:ordered.length,wins:wins.length,losses:losses.length,winRatePct:ordered.length?100*wins.length/ordered.length:0,netR:ordered.reduce((s,x)=>s+x.netR,0),netPnlUsd:ordered.reduce((s,x)=>s+x.netPnlUsd,0),expectancyR:ordered.length?ordered.reduce((s,x)=>s+x.netR,0)/ordered.length:0,profitFactor:gl?gp/gl:gp?null:0,maxDrawdownR:dd};
}
async function main(){
  const to=Date.now(),from=to-DAYS*86400000;
  const tickers=await json(BASE+"/derivatives/api/v3/tickers");
  const universe=(tickers.tickers||[]).filter(t=>t.tag==="perpetual"&&t.suspended!==true&&/^(PI|PF)_[A-Z0-9]+USD$/.test(t.symbol||"")&&Number(t.volumeQuote)>=5000000)
    .sort((a,b)=>Number(b.volumeQuote)-Number(a.volumeQuote)).slice(0,SYMBOLS);
  if(!universe.length)throw new Error("No eligible Kraken perpetual contracts.");
  const patternTrades=Object.fromEntries(PATTERNS.map(p=>[p,[]])),combinedTrades=[],symbolReports=[];
  for(const ticker of universe){
    try{
      const bars=await fetchCandles(ticker.symbol,from,to);
      if(bars.length<100)throw new Error("Insufficient 15m candles: "+bars.length);
      // Each pattern is evaluated independently; only one open position per pattern/symbol.
      for(const pattern of PATTERNS){
        let nextIndex=2;
        for(let i=2;i<bars.length-1;i++){
          if(i<nextIndex)continue;
          const signal=detectCandlestickSignals(bars,i).find(x=>x.pattern===pattern);
          if(!signal)continue;
          const trade=simulate(signal,bars,i+1);if(!trade)continue;
          trade.symbol=ticker.symbol;patternTrades[pattern].push(trade);
          const exitIndex=bars.findIndex((x,j)=>j>=i+1&&x.time===trade.exitTime);
          nextIndex=Math.max(i+2,exitIndex>=0?exitIndex+1:i+2);
        }
      }
      // Combined portfolio candidate: one same-direction pattern per candle, no overlapping positions per symbol.
      let nextCombined=2;
      for(let i=2;i<bars.length-1;i++){
        if(i<nextCombined)continue;
        const signals=detectCandlestickSignals(bars,i);
        const sides=[...new Set(signals.map(x=>x.side))];
        if(sides.length!==1)continue; // ambiguous candle: no trade
        const signal=signals.sort((a,b)=>PRIORITY.indexOf(a.pattern)-PRIORITY.indexOf(b.pattern))[0];
        if(!signal)continue;
        const trade=simulate(signal,bars,i+1);if(!trade)continue;
        trade.symbol=ticker.symbol;combinedTrades.push(trade);
        const exitIndex=bars.findIndex((x,j)=>j>=i+1&&x.time===trade.exitTime);
        nextCombined=Math.max(i+2,exitIndex>=0?exitIndex+1:i+2);
      }
      symbolReports.push({symbol:ticker.symbol,candles:bars.length,firstCandle:bars[0].time,lastCandle:bars.at(-1).time,combinedTrades:combinedTrades.filter(x=>x.symbol===ticker.symbol).length});
    }catch(e){symbolReports.push({symbol:ticker.symbol,error:String(e.message||e)});}
  }
  const patterns=PATTERNS.map(pattern=>{
    const trades=patternTrades[pattern];
    return {pattern,...summary(trades),long:summary(trades.filter(x=>x.side==="LONG")),short:summary(trades.filter(x=>x.side==="SHORT"))};
  });
  const report={generatedAt:new Date().toISOString(),venue:"Kraken Derivatives public OHLC",timeframe:"15m",period:{days:DAYS,from:new Date(from).toISOString(),to:new Date(to).toISOString()},settings:{symbolsRequested:SYMBOLS,symbolsTested:symbolReports.filter(x=>!x.error).length,feePerSide:FEE,slippagePerSide:SLIPPAGE,notionalUsd:NOTIONAL,marginUsd:NOTIONAL/10,leverage:10,entry:"next 15m candle open",sameCandleStopTarget:"stop first (conservative)",targetsR:CANDLE_CONFIG.TARGET_R_MULTIPLES,targetWeights:CANDLE_CONFIG.TARGET_WEIGHTS,maxHoldBars:CANDLE_CONFIG.MAX_HOLD_BARS,funding:"excluded",patternOnly:true,overlap:"one open trade per symbol in combined test; each pattern separately tested"},overall:summary(combinedTrades),long:summary(combinedTrades.filter(x=>x.side==="LONG")),short:summary(combinedTrades.filter(x=>x.side==="SHORT")),patterns,symbols:symbolReports};
  await mkdir("artifacts",{recursive:true});
  await writeFile("artifacts/candlestick-backtest.json",JSON.stringify(report,null,2));
  const lines=["# Candlestick Long/Short Backtest","",`Period: ${report.period.from} to ${report.period.to} (${DAYS} days)`,"Timeframe: 15m",`Symbols tested: ${report.settings.symbolsTested}/${SYMBOLS}`,"",`Combined trades: ${report.overall.trades} | Win rate: ${report.overall.winRatePct.toFixed(2)}% | Net R: ${report.overall.netR.toFixed(2)} | Net PnL: $${report.overall.netPnlUsd.toFixed(4)}`,`LONG: ${report.long.trades} trades, ${report.long.winRatePct.toFixed(2)}% wins, $${report.long.netPnlUsd.toFixed(4)}`,`SHORT: ${report.short.trades} trades, ${report.short.winRatePct.toFixed(2)}% wins, $${report.short.netPnlUsd.toFixed(4)}`,`Profit factor: ${report.overall.profitFactor===null?"n/a":report.overall.profitFactor.toFixed(3)} | Max DD: ${report.overall.maxDrawdownR.toFixed(2)}R`,"",`Costs: ${(FEE*100).toFixed(3)}% fee and ${(SLIPPAGE*100).toFixed(3)}% slippage per side. Funding excluded. ${NOTIONAL} notional (= ${(NOTIONAL/10).toFixed(2)} margin at 10x) per trade. This is a signal-edge test, not a capital-constrained portfolio replay; no global concurrent-position cap is applied.`,"","| Pattern | Trades | Win % | Net R | Net USD | PF | LONG | SHORT |","|---|---:|---:|---:|---:|---:|---:|---:|",...patterns.map(x=>`| ${x.pattern} | ${x.trades} | ${x.winRatePct.toFixed(1)} | ${x.netR.toFixed(2)} | ${x.netPnlUsd.toFixed(4)} | ${x.profitFactor===null?"n/a":x.profitFactor.toFixed(2)} | ${x.long.trades} | ${x.short.trades} |`),"","## Symbols",...symbolReports.map(x=>`- ${x.symbol}: ${x.error||x.candles+" candles; "+x.combinedTrades+" combined trades"}`)];
  await writeFile("artifacts/candlestick-backtest.md",lines.join("\n"));
  console.log(JSON.stringify({ok:true,overall:report.overall,long:report.long,short:report.short,patterns,symbols:symbolReports,artifacts:["artifacts/candlestick-backtest.json","artifacts/candlestick-backtest.md"]},null,2));
}
main().catch(e=>{console.error(e);process.exitCode=1;});

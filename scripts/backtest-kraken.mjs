import { analyzeFuturesSymbol, FUTURES_CONFIG } from "../src/index.js";
import { mkdir, writeFile } from "node:fs/promises";

const BASE = "https://futures.kraken.com";
const HOUR = 60 * 60 * 1000;
const FOUR_HOURS = 4 * HOUR;
const DAYS = Math.max(15, Math.min(90, Number(process.env.BACKTEST_DAYS || 30)));
const SYMBOL_LIMIT = Math.max(1, Math.min(5, Number(process.env.BACKTEST_SYMBOLS || 3)));
const FEE_PER_SIDE = Math.max(0, Number(process.env.BACKTEST_FEE || 0.0005));
const SLIPPAGE_PER_SIDE = Math.max(0, Number(process.env.BACKTEST_SLIPPAGE || 0.0003));
const MAX_HOLD_HOURS = 72;
const TARGET_WEIGHTS = [0.40, 0.35, 0.25];

async function getJson(url) {
  const response = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(25000) });
  const body = await response.text();
  if (!response.ok) throw new Error("HTTP " + response.status + " for " + url + ": " + body.slice(0, 180));
  let data;
  try { data = JSON.parse(body); } catch { throw new Error("Invalid JSON from " + url); }
  if (data?.result === "error" || (Array.isArray(data?.errors) && data.errors.length)) throw new Error("Kraken API error: " + JSON.stringify(data.errors || data.error));
  return data;
}

function normalizeCandles(rows, intervalMs) {
  if (!Array.isArray(rows)) throw new Error("Kraken candles array missing");
  const seen = new Set();
  return rows.map(row => ({
    time: Number(row.time) < 1e12 ? Number(row.time) * 1000 : Number(row.time),
    open: Number(row.open), high: Number(row.high), low: Number(row.low),
    close: Number(row.close), volume: Number(row.volume)
  })).filter(c =>
    Number.isFinite(c.time) && Number.isFinite(c.open) && Number.isFinite(c.high) &&
    Number.isFinite(c.low) && Number.isFinite(c.close) && Number.isFinite(c.volume) &&
    c.open > 0 && c.close > 0 && c.low > 0 && c.high >= c.low && c.volume >= 0
  ).sort((a,b)=>a.time-b.time).filter(c => {
    if (seen.has(c.time) || c.time + intervalMs > Date.now()) return false;
    seen.add(c.time); return true;
  });
}

async function fetchHistoricalCandles(symbol, resolution, fromMs, toMs, intervalMs) {
  const url = new URL(BASE + "/api/charts/v1/trade/" + encodeURIComponent(symbol) + "/" + resolution);
  url.searchParams.set("from", String(Math.floor(fromMs / 1000)));
  url.searchParams.set("to", String(Math.floor(toMs / 1000)));
  url.searchParams.set("count", "2000");
  const data = await getJson(url);
  if (data.more_candles === true) throw new Error(symbol + " " + resolution + ": Kraken reports more candles than requested; shorten backtest window.");
  return normalizeCandles(data.candles, intervalMs);
}

function historicalChange(candles, index) {
  const old = candles[index - 24], now = candles[index];
  if (!old || old.close <= 0) return 0;
  return ((now.close / old.close) - 1) * 100;
}

function closeTrade(position, rawPrice, reason, time, config) {
  const dir = position.direction;
  const exitFill = rawPrice * (1 - dir * config.slippage);
  const grossR = dir * (exitFill - position.entry) / position.risk;
  const feeR = config.fee * (position.entry + exitFill) / position.risk;
  position.realizedR += position.remaining * (grossR - feeR);
  position.remaining = 0;
  position.exitTime = time;
  position.exitReason = reason;
  return position;
}

export function simulateTrade({ side, entry, stop, targets, candles, startIndex, fee = 0.0005, slippage = 0.0003, maxHoldHours = 72 }) {
  const direction = side === "LONG" ? 1 : -1;
  const risk = direction === 1 ? entry - stop : stop - entry;
  if (!(risk > 0) || !Number.isFinite(risk)) throw new Error("Invalid trade risk");
  const position = { side, entry, stop, risk, direction, remaining: 1, realizedR: 0, targetHits: 0, exitTime: null, exitReason: null };
  const config = { fee, slippage };
  const endIndex = Math.min(candles.length - 1, startIndex + maxHoldHours);
  for (let i = startIndex; i <= endIndex && position.remaining > 0; i++) {
    const bar = candles[i];
    const stopGap = direction === 1 ? bar.open <= stop : bar.open >= stop;
    const stopTouched = direction === 1 ? bar.low <= stop : bar.high >= stop;
    if (stopGap || stopTouched) {
      closeTrade(position, stopGap ? bar.open : stop, "STOP", bar.time, config);
      break;
    }
    for (let t = 0; t < targets.length && position.remaining > 0; t++) {
      const target = targets[t];
      if (target == null) continue;
      const touched = direction === 1 ? bar.high >= target : bar.low <= target;
      if (!touched) break;
      const weight = [0.40, 0.35, 0.25][t];
      const exitFill = target * (1 - direction * slippage);
      const grossR = direction * (exitFill - entry) / risk;
      const feeR = fee * (entry + exitFill) / risk;
      position.realizedR += weight * (grossR - feeR);
      position.remaining -= weight;
      position.targetHits++;
      targets[t] = null;
    }
    if (position.remaining <= 1e-9) {
      position.remaining = 0; position.exitTime = bar.time; position.exitReason = "TARGETS"; break;
    }
    if (i === endIndex) closeTrade(position, bar.close, "TIME_EXIT", bar.time, config);
  }
  if (position.remaining > 0) closeTrade(position, candles[endIndex].close, "TIME_EXIT", candles[endIndex].time, config);
  return {
    side, entry, stop, risk, netR: position.realizedR, targetHits: position.targetHits,
    exitReason: position.exitReason, entryTime: candles[startIndex].time, exitTime: position.exitTime
  };
}

function summarize(trades) {
  const wins = trades.filter(t => t.netR > 0), losses = trades.filter(t => t.netR < 0);
  const grossWin = wins.reduce((s,t)=>s+t.netR,0), grossLoss = Math.abs(losses.reduce((s,t)=>s+t.netR,0));
  let equity = 0, peak = 0, maxDrawdown = 0;
  for (const trade of trades) { equity += trade.netR; peak = Math.max(peak,equity); maxDrawdown = Math.max(maxDrawdown,peak-equity); }
  return {
    trades: trades.length, wins: wins.length, losses: losses.length,
    breakeven: trades.length-wins.length-losses.length,
    winRatePct: trades.length ? wins.length/trades.length*100 : 0,
    netR: trades.reduce((s,t)=>s+t.netR,0),
    expectancyR: trades.length ? trades.reduce((s,t)=>s+t.netR,0)/trades.length : 0,
    profitFactor: grossLoss ? grossWin/grossLoss : grossWin ? null : 0,
    maxDrawdownR: maxDrawdown, targetHits: trades.reduce((s,t)=>s+t.targetHits,0)
  };
}

async function backtestSymbol(ticker, fromMs, toMs) {
  const [oneHour,fourHour] = await Promise.all([
    fetchHistoricalCandles(ticker.symbol,"1h",fromMs,toMs,HOUR),
    fetchHistoricalCandles(ticker.symbol,"4h",fromMs,toMs,FOUR_HOURS)
  ]);
  if (oneHour.length < 100 || fourHour.length < FUTURES_CONFIG.MIN_CANDLES) throw new Error(ticker.symbol + ": insufficient historical candles (1h=" + oneHour.length + ", 4h=" + fourHour.length + ")");
  const trades = [];
  let nextAvailableIndex = 60;
  for (let i=60;i<oneHour.length-1;i++) {
    if (i<nextAvailableIndex) continue;
    const signalBar=oneHour[i], signalCloseTime=signalBar.time+HOUR;
    const closed4h=fourHour.filter(c=>c.time+FOUR_HOURS<=signalCloseTime);
    if (closed4h.length<FUTURES_CONFIG.MIN_CANDLES) continue;
    const nextBar=oneHour[i+1];
    const tickerAtSignal={
      symbol:ticker.symbol,last:nextBar.open,quoteVolume:Number(ticker.volumeQuote)||0,
      priceChangePercent:historicalChange(oneHour,i),premium:{lastFundingRate:null}
    };
    const first=analyzeFuturesSymbol(tickerAtSignal,oneHour.slice(0,i+1),closed4h);
    if (!first?.eligible) continue;
    const direction=first.side==="LONG"?1:-1;
    tickerAtSignal.last=nextBar.open*(1+direction*SLIPPAGE_PER_SIDE);
    const confirmed=analyzeFuturesSymbol(tickerAtSignal,oneHour.slice(0,i+1),closed4h);
    if (!confirmed?.eligible) continue;
    const entryIndex=i+1;
    const tradeCandles=oneHour.slice(entryIndex,Math.min(oneHour.length,entryIndex+MAX_HOLD_HOURS+1));
    const trade=simulateTrade({
      side:confirmed.side,entry:confirmed.entry,stop:confirmed.stop,
      targets:[confirmed.target1,confirmed.target2,confirmed.target3],
      candles:tradeCandles,startIndex:0,fee:FEE_PER_SIDE,slippage:SLIPPAGE_PER_SIDE,maxHoldHours:MAX_HOLD_HOURS
    });
    trade.symbol=ticker.symbol; trade.score=confirmed.score; trade.signalTime=signalBar.time;
    trades.push(trade);
    const exitIndex=oneHour.findIndex(c=>c.time===trade.exitTime);
    nextAvailableIndex=Math.max(entryIndex+1,exitIndex+1);
  }
  return {symbol:ticker.symbol,candles1h:oneHour.length,candles4h:fourHour.length,trades,metrics:summarize(trades)};
}

async function main() {
  const endMs=Date.now(), startMs=endMs-DAYS*24*HOUR, fromMs=startMs-15*24*HOUR;
  const tickerData=await getJson(BASE+"/derivatives/api/v3/tickers");
  if (!Array.isArray(tickerData?.tickers)) throw new Error("Kraken tickers response invalid");
  const universe=tickerData.tickers.filter(t=>t?.tag==="perpetual"&&t.suspended!==true&&
    /^(PI|PF)_[A-Z0-9]+USD$/.test(String(t.symbol||""))&&
    Number(t.volumeQuote)>=FUTURES_CONFIG.MIN_QUOTE_VOLUME&&Number(t.last)>0)
    .sort((a,b)=>Number(b.volumeQuote)-Number(a.volumeQuote)).slice(0,SYMBOL_LIMIT);
  if (!universe.length) throw new Error("No eligible Kraken perpetual contracts found");
  const results=[];
  for (const ticker of universe) {
    try { results.push(await backtestSymbol(ticker,fromMs,endMs)); }
    catch(error) { results.push({symbol:ticker.symbol,error:error.message,trades:[],metrics:summarize([])}); }
  }
  const allTrades=results.flatMap(r=>r.trades||[]).sort((a,b)=>a.entryTime-b.entryTime);
  const report={
    generatedAt:new Date().toISOString(),venue:"Kraken Derivatives public historical candles",
    period:{from:new Date(startMs).toISOString(),to:new Date(endMs).toISOString(),days:DAYS},
    settings:{
      symbolsRequested:SYMBOL_LIMIT,symbolsTested:results.filter(r=>!r.error).length,
      feePerSidePct:FEE_PER_SIDE*100,slippagePerSidePct:SLIPPAGE_PER_SIDE*100,
      maxHoldHours:MAX_HOLD_HOURS,targetWeightsPct:[40,35,25],
      sameCandleStopTargetRule:"stop first (conservative)",
      entryRule:"next 1h candle open, adverse slippage applied",
      funding:"excluded (historical funding series not included)",
      signalUses:"historical 1h/4h closed candles; 24h change derived from historical bars; no current funding or future candle data"
    },
    overall:summarize(allTrades),
    symbols:results.map(({trades,...rest})=>rest),trades:allTrades
  };
  await mkdir("artifacts",{recursive:true});
  await writeFile("artifacts/kraken-futures-backtest.json",JSON.stringify(report,null,2));
  const lines=[
    "# Kraken Futures v3.9.0 — Historical Backtest","",
    "Period: "+report.period.from+" to "+report.period.to+" ("+DAYS+" days)",
    "Symbols successfully tested: "+report.settings.symbolsTested+"/"+SYMBOL_LIMIT,
    "Trades: "+report.overall.trades,
    "Win rate: "+report.overall.winRatePct.toFixed(2)+"%",
    "Net result: "+report.overall.netR.toFixed(2)+"R",
    "Expectancy: "+report.overall.expectancyR.toFixed(3)+"R/trade",
    "Profit factor: "+(report.overall.profitFactor===null?"n/a":report.overall.profitFactor.toFixed(2)),
    "Max drawdown: "+report.overall.maxDrawdownR.toFixed(2)+"R","",
    "Costs assumed: "+(FEE_PER_SIDE*100).toFixed(3)+"% fee + "+(SLIPPAGE_PER_SIDE*100).toFixed(3)+"% slippage per side.",
    "Partial exits: 40% at 1.5R, 35% at 2.2R, 25% at 3R. Same-candle stop/target ambiguity is resolved as stop first.",
    "Historical funding is excluded. Simplified price-based simulation; not a live-fill or profitability guarantee.","",
    "| Symbol | 1h candles | 4h candles | Trades | Win rate | Net R | Expectancy | Max DD | Error |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---|",
    ...results.map(r=>"| "+r.symbol+" | "+(r.candles1h||0)+" | "+(r.candles4h||0)+" | "+r.metrics.trades+" | "+r.metrics.winRatePct.toFixed(1)+"% | "+r.metrics.netR.toFixed(2)+" | "+r.metrics.expectancyR.toFixed(3)+" | "+r.metrics.maxDrawdownR.toFixed(2)+" | "+(r.error||"").replaceAll("|","/")+" |")
  ];
  await writeFile("artifacts/kraken-futures-backtest.md",lines.join("\n"));
  console.log(JSON.stringify({ok:true,overall:report.overall,symbols:report.symbols,artifacts:["artifacts/kraken-futures-backtest.json","artifacts/kraken-futures-backtest.md"]},null,2));
}

if (process.argv[1] && import.meta.url === new URL("file://" + process.argv[1]).href) {
  main().catch(error=>{console.error(error);process.exitCode=1;});
}

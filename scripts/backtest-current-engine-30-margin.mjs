import { mkdir, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { analyzeFuturesSymbol, FUTURES_CONFIG, getKrakenFuturesUniverse } from "../src/index.js";
import { evaluateTradeCandle, marginReturnPercent, FUTURES_TRADE_LEVERAGE, FUTURES_MARGIN_PROFIT_TARGET_PERCENT } from "../src/futures-trade-lifecycle.js";

const API = "https://futures.kraken.com/api/charts/v1";
const MS = { "5m": 300000, "15m": 900000, "1h": 3600000, "4h": 14400000, "1d": 86400000 };
const DAYS = Number(process.env.CURRENT_ENGINE_BACKTEST_DAYS || 60);
const MARGIN_USD = 10;
const LEVERAGE = FUTURES_TRADE_LEVERAGE;
const TARGET_MARGIN_PCT = FUTURES_MARGIN_PROFIT_TARGET_PERCENT;
const FEE_PER_SIDE = 0.0005;
const SLIPPAGE_PER_SIDE = 0.0003;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function getJson(url) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const response = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(30000) });
      const body = await response.text();
      if (!response.ok) throw new Error("Kraken HTTP " + response.status + ": " + body.slice(0, 180));
      const data = JSON.parse(body);
      if (data.result === "error" || (Array.isArray(data.errors) && data.errors.length)) {
        throw new Error("Kraken API: " + JSON.stringify(data.errors || data.error));
      }
      return data;
    } catch (error) {
      if (attempt === 4) throw error;
      await sleep(500 * (attempt + 1));
    }
  }
}

async function fetchCandles(symbol, resolution, fromMs, toMs) {
  const interval = MS[resolution];
  const chunkMs = interval * 700;
  const all = [];
  for (let start = fromMs; start < toMs; start += chunkMs) {
    const url = new URL(API + "/trade/" + encodeURIComponent(symbol) + "/" + resolution);
    url.searchParams.set("from", String(Math.floor(start / 1000)));
    url.searchParams.set("to", String(Math.floor(Math.min(toMs, start + chunkMs) / 1000)));
    const data = await getJson(url);
    if (!Array.isArray(data.candles)) throw new Error("Missing " + resolution + " candles for " + symbol);
    for (const row of data.candles) {
      const candle = {
        time: Number(row.time) < 1e12 ? Number(row.time) * 1000 : Number(row.time), open: Number(row.open), high: Number(row.high),
        low: Number(row.low), close: Number(row.close), volume: Number(row.volume)
      };
      if (Number.isFinite(candle.time) &&
          [candle.open, candle.high, candle.low, candle.close, candle.volume].every(Number.isFinite) &&
          candle.open > 0 && candle.low > 0 && candle.high >= Math.max(candle.open, candle.close, candle.low) &&
          candle.volume >= 0 && candle.time + interval <= toMs) all.push(candle);
    }
    await sleep(100);
  }
  return [...new Map(all.map(c => [c.time, c])).values()].sort((a, b) => a.time - b.time);
}

function lowerBound(candles, time) {
  let lo = 0, hi = candles.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (candles[mid].time < time) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function closedCount(candles, interval, cutoff) {
  let lo = 0, hi = candles.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (candles[mid].time + interval <= cutoff) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      try { out[index] = await fn(items[index]); }
      catch (error) { out[index] = { error: String(error?.stack || error?.message || error) }; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

function estimateCosts(entry, exit) {
  const roundTripRate = FEE_PER_SIDE + SLIPPAGE_PER_SIDE;
  const notional = MARGIN_USD * LEVERAGE;
  const costUsd = notional * roundTripRate * (1 + exit / entry);
  return { costUsd, costMarginRoiPct: costUsd / MARGIN_USD * 100 };
}

function simulateTrade(candidate, bars5m, entryTime) {
  const trade = {
    status: "OPEN", side: candidate.side, actualEntry: candidate.entry, entry: candidate.entry,
    initialStop: candidate.stop, currentStop: candidate.stop, stop: candidate.stop
  };
  const start = lowerBound(bars5m, entryTime);
  for (let i = start; i < bars5m.length; i++) {
    const candle = bars5m[i];
    const result = evaluateTradeCandle(trade, { ...candle, time: candle.time + MS["5m"] }, {
      leverage: LEVERAGE, targetMarginPercent: TARGET_MARGIN_PCT
    });
    if (result.changed) {
      const grossMarginRoiPct = Number(result.trade.marginReturnPercent);
      const costs = estimateCosts(candidate.entry, Number(result.trade.exitPrice));
      return {
        symbol: candidate.symbol, status: result.reason, exitReason: result.reason === "CLOSED_PROFIT" ? "TARGET_30_MARGIN" : "STOP",
        entryTime, exitTime: candle.time + MS["5m"], entry: candidate.entry, exit: Number(result.trade.exitPrice),
        stop: candidate.stop, side: candidate.side, score: candidate.score,
        grossMarginRoiPct, costMarginRoiPct: costs.costMarginRoiPct,
        netMarginRoiPct: grossMarginRoiPct - costs.costMarginRoiPct,
        grossPnlUsd: MARGIN_USD * grossMarginRoiPct / 100,
        netPnlUsd: MARGIN_USD * (grossMarginRoiPct - costs.costMarginRoiPct) / 100,
        barsHeld: i - start + 1
      };
    }
  }
  const mark = bars5m.length ? bars5m[bars5m.length - 1].close : candidate.entry;
  const gross = marginReturnPercent(candidate.side, candidate.entry, mark, LEVERAGE) ?? 0;
  const costs = estimateCosts(candidate.entry, mark);
  return {
    symbol: candidate.symbol, status: "OPEN", exitReason: "OPEN_AT_END", entryTime, exitTime: null,
    entry: candidate.entry, mark, stop: candidate.stop, side: candidate.side, score: candidate.score,
    grossMarginRoiPct: gross, costMarginRoiPct: costs.costMarginRoiPct,
    netMarginRoiPct: gross - costs.costMarginRoiPct,
    grossPnlUsd: MARGIN_USD * gross / 100,
    netPnlUsd: MARGIN_USD * (gross - costs.costMarginRoiPct) / 100,
    barsHeld: bars5m.length - start
  };
}

function summarize(trades) {
  const closed = trades.filter(t => t.status !== "OPEN");
  const wins = closed.filter(t => t.status === "CLOSED_PROFIT");
  const losses = closed.filter(t => t.status === "CLOSED_STOP");
  const open = trades.filter(t => t.status === "OPEN");
  const grossProfit = closed.filter(t => t.netPnlUsd > 0).reduce((sum, t) => sum + t.netPnlUsd, 0);
  const grossLoss = Math.abs(closed.filter(t => t.netPnlUsd < 0).reduce((sum, t) => sum + t.netPnlUsd, 0));
  let equity = 0, peak = 0, maxDrawdownUsd = 0;
  for (const trade of [...closed].sort((a, b) => a.exitTime - b.exitTime)) {
    equity += trade.netPnlUsd;
    peak = Math.max(peak, equity);
    maxDrawdownUsd = Math.max(maxDrawdownUsd, peak - equity);
  }
  return {
    eligibleTradesOpened: trades.length,
    closedTrades: closed.length,
    targetWins: wins.length,
    stopLosses: losses.length,
    openAtEnd: open.length,
    winRateClosedPct: closed.length ? wins.length / closed.length * 100 : 0,
    stopRateClosedPct: closed.length ? losses.length / closed.length * 100 : 0,
    grossMarginRoiPctTotal: closed.reduce((sum, t) => sum + t.grossMarginRoiPct, 0),
    netMarginRoiPctTotal: closed.reduce((sum, t) => sum + t.netMarginRoiPct, 0),
    averageNetMarginRoiPct: closed.length ? closed.reduce((sum, t) => sum + t.netMarginRoiPct, 0) / closed.length : 0,
    grossPnlUsd: closed.reduce((sum, t) => sum + t.grossPnlUsd, 0),
    netPnlUsd: closed.reduce((sum, t) => sum + t.netPnlUsd, 0),
    openUnrealizedNetPnlUsd: open.reduce((sum, t) => sum + t.netPnlUsd, 0),
    profitFactorNet: grossLoss ? grossProfit / grossLoss : grossProfit ? null : 0,
    expectancyNetUsd: closed.length ? closed.reduce((sum, t) => sum + t.netPnlUsd, 0) / closed.length : 0,
    maxDrawdownUsd: maxDrawdownUsd,
    maxConcurrentPositions: maxConcurrent(trades)
  };
}

function maxConcurrent(trades) {
  const events = [];
  for (const trade of trades) {
    events.push({ time: trade.entryTime, delta: 1 });
    if (trade.exitTime) events.push({ time: trade.exitTime, delta: -1 });
  }
  events.sort((a, b) => a.time - b.time || a.delta - b.delta);
  let active = 0, max = 0;
  for (const event of events) { active += event.delta; max = Math.max(max, active); }
  return max;
}

async function backtestSymbol(ticker, window) {
  const warmStart = window.startMs - 20 * MS["1d"];
  const [h1, h4, m15, m5] = await Promise.all([
    fetchCandles(ticker.symbol, "1h", warmStart, window.endMs),
    fetchCandles(ticker.symbol, "4h", warmStart, window.endMs),
    fetchCandles(ticker.symbol, "15m", warmStart, window.endMs),
    fetchCandles(ticker.symbol, "5m", window.startMs, window.endMs)
  ]);
  if (h1.length < 100 || h4.length < FUTURES_CONFIG.MIN_CANDLES || m15.length < 120 || !m5.length) {
    throw new Error("Insufficient history: 1h=" + h1.length + " 4h=" + h4.length + " 15m=" + m15.length + " 5m=" + m5.length);
  }
  const coverage = {
    h1: { from: h1[0]?.time, to: h1.at(-1)?.time + MS["1h"], count: h1.length },
    h4: { from: h4[0]?.time, to: h4.at(-1)?.time + MS["4h"], count: h4.length },
    m15: { from: m15[0]?.time, to: m15.at(-1)?.time + MS["15m"], count: m15.length },
    m5: { from: m5[0]?.time, to: m5.at(-1)?.time + MS["5m"], count: m5.length }
  };
  if (coverage.m5.from > window.startMs + MS["5m"] || coverage.m5.to < window.endMs - MS["5m"]) {
    throw new Error("Incomplete 5m coverage for " + ticker.symbol + ": " + JSON.stringify(coverage.m5));
  }

  const baselineCandidates = [];
  const relaxedCandidates = [];
  for (let i = 60; i < h1.length - 1; i++) {
    const bar = h1[i];
    const signalTime = bar.time + MS["1h"];
    if (signalTime < window.startMs || signalTime >= window.endMs) continue;
    const next = h1[i + 1];
    if (next.time !== signalTime) continue;
    const n4 = closedCount(h4, MS["4h"], signalTime);
    const n15 = closedCount(m15, MS["15m"], signalTime);
    if (n4 < FUTURES_CONFIG.MIN_CANDLES || n15 < 40) continue;

    const prior24 = lowerBound(h1, bar.time - MS["1d"]);
    const ref24 = prior24 > 0 ? h1[prior24 - 1].close : null;
    const historicalChange = Number.isFinite(ref24) && ref24 > 0 ? (bar.close / ref24 - 1) * 100 : 0;
    const tickerAtSignal = {
      ...ticker, last: next.open, priceChangePercent: historicalChange,
      quoteVolume: Number(ticker.quoteVolume) || Number(ticker.volumeQuote) || 0,
      premium: {}
    };
    const result = analyzeFuturesSymbol(
      tickerAtSignal,
      h1.slice(0, i + 1),
      h4.slice(0, n4),
      m15.slice(Math.max(0, n15 - 120), n15)
    );
    if (result?.side !== "LONG") continue;
    const candidate = {symbol:ticker.symbol,side:"LONG",score:result.score,entry:Number(result.entry),stop:Number(result.stop),signalTime,signalCandleTime:bar.time,targets:[result.target1,result.target2,result.target3]};
    if (result?.eligible === true) relaxedCandidates.push(candidate);
    if (result?.baselineEligible === true) baselineCandidates.push(candidate);
  }
  return {symbol:ticker.symbol,candles:{h1:h1.length,h4:h4.length,m15:m15.length,m5:m5.length},coverage,baselineCandidates,relaxedCandidates,m5};
}

function selectBullishWindow(daily) {
  const close=daily.map(c=>c.close),ema=Array(close.length).fill(null),alpha=2/51;
  if(close.length<DAYS+60)throw new Error("Insufficient BTC daily history for bullish regime selection");
  let value=close.slice(0,50).reduce((s,x)=>s+x,0)/50;
  for(let i=49;i<close.length;i++){if(i>49)value=close[i]*alpha+value*(1-alpha);ema[i]=value;}
  for(let end=daily.length-1;end>=DAYS+10;end--){
    const start=end-DAYS+1;let valid=true;
    for(let i=start;i<=end;i++)if(!(close[i]>ema[i]&&ema[i]>ema[i-10])){valid=false;break;}
    if(valid)return{startMs:daily[start].time,endMs:daily[end].time+MS["1d"],days:DAYS,btcCloseAboveEma50Pct:100,btcEma50RisingPct:100,startClose:close[start],endClose:close[end],startEma50:ema[start],endEma50:ema[end]};
  }
  throw new Error("No full 60-day BTC bullish regime found; no non-bullish period substituted");
}

async function main() {
  const now=Date.now();
  const daily=await fetchCandles("PF_XBTUSD","1d",now-900*MS["1d"],now);
  const window=selectBullishWindow(daily);
  console.log("BTC bullish 60d window: "+new Date(window.startMs).toISOString()+" -> "+new Date(window.endMs).toISOString());
  const universe = await getKrakenFuturesUniverse();
  if (!universe.length) throw new Error("No Kraken perpetuals passed the production quote-volume filter.");
  console.log("Current eligible Kraken perpetual universe: " + universe.length);

  const symbolResults = await mapLimit(universe, 2, async ticker => {
    console.log("Downloading and analyzing " + ticker.symbol);
    return await backtestSymbol(ticker, window);
  });
  const good = symbolResults.filter(x => !x.error);
  const errors = symbolResults.filter(x => x.error);
  function runPortfolio(field) {
    const byTime=new Map();
    for(const result of good)for(const candidate of result[field]){
      if(!byTime.has(candidate.signalTime))byTime.set(candidate.signalTime,[]);
      byTime.get(candidate.signalTime).push({...candidate,bars5m:result.m5});
    }
    const locks=new Map(),trades=[];let eligibleCandidates=0,droppedByScanCap=0,blockedByOpenTrade=0;
    for(const [signalTime,candidates] of [...byTime.entries()].sort((a,b)=>a[0]-b[0])){
      eligibleCandidates+=candidates.length;candidates.sort((a,b)=>b.score-a.score);
      const selected=candidates.slice(0,FUTURES_CONFIG.MAX_SIGNALS_PER_SCAN);
      droppedByScanCap+=Math.max(0,candidates.length-selected.length);
      for(const candidate of selected){
        const key=candidate.symbol+"|LONG";
        if(signalTime<(locks.get(key)??0)){blockedByOpenTrade++;continue;}
        const trade=simulateTrade(candidate,candidate.bars5m,candidate.signalTime);
        trades.push(trade);locks.set(key,trade.exitTime??Number.POSITIVE_INFINITY);
      }
    }
    const aggregate=summarize(trades);
    const bySymbol=good.map(result=>({symbol:result.symbol,candles:result.candles,eligibleCandidates:result[field].length,metrics:summarize(trades.filter(t=>t.symbol===result.symbol))})).sort((a,b)=>b.metrics.netPnlUsd-a.metrics.netPnlUsd);
    return{counts:{eligibleCandidates,droppedByScanCap,blockedByOpenTrade},aggregate,bySymbol,trades};
  }
  const baseline=runPortfolio("baselineCandidates"),relaxed=runPortfolio("relaxedCandidates");
  const report={
    generatedAt:new Date().toISOString(),
    engine:"Isolated LONG comparison: original strict LONG eligibility vs relaxed LONG eligibility; identical Kraken data and trade lifecycle",
    period:{from:new Date(window.startMs).toISOString(),to:new Date(window.endMs).toISOString(),days:DAYS},
    marketRegime:{benchmark:"Kraken PF_XBTUSD daily",definition:"Every day: close > EMA50 and EMA50 > EMA50 ten days earlier",...window},
    venue:"Kraken Derivatives perpetuals",
    universe:{currentEligibleSymbols:universe.map(t=>t.symbol),count:universe.length,filter:"Current production filter: active perpetuals with quote volume >= 5,000,000 USD"},
    tradeModel:{marginUsd:MARGIN_USD,leverage:LEVERAGE,positionNotionalUsd:MARGIN_USD*LEVERAGE,targetMarginProfitPctGross:TARGET_MARGIN_PCT,underlyingPriceMoveTargetPct:TARGET_MARGIN_PCT/LEVERAGE,targetPriceLogic:"Exact production evaluateTradeCandle() lifecycle logic",stopLogic:"Exact signal stop from analyzeFuturesSymbol()",exitResolution:"5m OHLC; stop-first for same-candle target/stop",entry:"Next 1h candle open",feesAndSlippage:"Estimated 0.05% fee and 0.03% slippage per side; funding omitted",comparison:"Baseline: strictLong, score >=72, volume >=0.75, distance >=0.5%. Relaxed: score >=65, volume >=0.65, distance >=0.3%, RSI 42-72."},
    counts:{testedSymbols:good.length,symbolErrors:errors},
    baseline:{counts:baseline.counts,aggregate:baseline.aggregate,bySymbol:baseline.bySymbol,trades:baseline.trades},
    relaxed:{counts:relaxed.counts,aggregate:relaxed.aggregate,bySymbol:relaxed.bySymbol,trades:relaxed.trades},
    limitations:["Today's eligible Kraken perpetual universe; delisted contracts and historical membership are not represented.","Signals are sampled at next 1h candle open; production scans every 5 minutes, so intrahour timing is approximated.","Historical funding is omitted.","Only a fully confirmed 60-day bullish BTC regime is accepted; no non-bullish substitute."]
  };
  await mkdir("artifacts", { recursive: true });
  await writeFile("artifacts/kraken-long-strict-vs-relaxed-60d.json",JSON.stringify(report,null,2));
  const md=[
    "# Kraken — Strict vs Relaxed LONG comparison","",
    "BTC bullish period: "+report.marketRegime.from+" → "+report.marketRegime.to+" (60 days)",
    "Symbols tested: "+good.length+"/"+universe.length+" | Margin $10 | Leverage 10x | +30% gross margin ROI target","",
    "| Metric | Baseline LONG | Relaxed LONG |","|---|---:|---:|",
    "| Eligible candidates | "+baseline.counts.eligibleCandidates+" | "+relaxed.counts.eligibleCandidates+" |",
    "| Trades opened | "+baseline.aggregate.eligibleTradesOpened+" | "+relaxed.aggregate.eligibleTradesOpened+" |",
    "| Closed trades | "+baseline.aggregate.closedTrades+" | "+relaxed.aggregate.closedTrades+" |",
    "| Wins (+30% ROI before stop) | "+baseline.aggregate.targetWins+" | "+relaxed.aggregate.targetWins+" |",
    "| Stop-first losses | "+baseline.aggregate.stopLosses+" | "+relaxed.aggregate.stopLosses+" |",
    "| Open at end | "+baseline.aggregate.openAtEnd+" | "+relaxed.aggregate.openAtEnd+" |",
    "| Win rate | "+baseline.aggregate.winRateClosedPct.toFixed(2)+"% | "+relaxed.aggregate.winRateClosedPct.toFixed(2)+"% |",
    "| Net PnL after estimated costs | $"+baseline.aggregate.netPnlUsd.toFixed(2)+" | $"+relaxed.aggregate.netPnlUsd.toFixed(2)+" |",
    "| Total net margin ROI | "+baseline.aggregate.netMarginRoiPctTotal.toFixed(2)+"% | "+relaxed.aggregate.netMarginRoiPctTotal.toFixed(2)+"% |",
    "| Average net ROI / closed trade | "+baseline.aggregate.averageNetMarginRoiPct.toFixed(2)+"% | "+relaxed.aggregate.averageNetMarginRoiPct.toFixed(2)+"% |",
    "| Profit factor | "+baseline.aggregate.profitFactorNet+" | "+relaxed.aggregate.profitFactorNet+" |",
    "| Max drawdown | $"+baseline.aggregate.maxDrawdownUsd.toFixed(2)+" | $"+relaxed.aggregate.maxDrawdownUsd.toFixed(2)+" |","",
    "## Baseline by symbol","",
    "| Symbol | Candidates | Trades | Wins | Stops | Win rate | Net PnL |","|---|---:|---:|---:|---:|---:|---:|",
    ...baseline.bySymbol.map(x=>"| "+x.symbol+" | "+x.eligibleCandidates+" | "+x.metrics.eligibleTradesOpened+" | "+x.metrics.targetWins+" | "+x.metrics.stopLosses+" | "+x.metrics.winRateClosedPct.toFixed(2)+"% | $"+x.metrics.netPnlUsd.toFixed(2)+" |"),
    "","## Relaxed by symbol","",
    "| Symbol | Candidates | Trades | Wins | Stops | Win rate | Net PnL |","|---|---:|---:|---:|---:|---:|---:|",
    ...relaxed.bySymbol.map(x=>"| "+x.symbol+" | "+x.eligibleCandidates+" | "+x.metrics.eligibleTradesOpened+" | "+x.metrics.targetWins+" | "+x.metrics.stopLosses+" | "+x.metrics.winRateClosedPct.toFixed(2)+"% | $"+x.metrics.netPnlUsd.toFixed(2)+" |"),
    "","## Limitations",...report.limitations.map(x=>"- "+x)
  ];
  await writeFile("artifacts/kraken-long-strict-vs-relaxed-60d.md",md.join("\n"));
  console.log(JSON.stringify({period:report.period,marketRegime:report.marketRegime,universe:report.universe.count,baseline:{counts:baseline.counts,aggregate:baseline.aggregate},relaxed:{counts:relaxed.counts,aggregate:relaxed.aggregate},symbolErrors:errors},null,2));
  if (!good.length) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}

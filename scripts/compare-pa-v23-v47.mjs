import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzePriceAction } from './vendor/price-action-engine-v2.3.js';
import { analyzeFuturesSymbol, FUTURES_CONFIG } from '../src/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(HERE, '../artifacts/pa-v23-vs-v47');
const BASE = 'https://futures.kraken.com';
const NOW = Date.now();
const SIGNAL_END = NOW;
const DAYS_LIST = [90, 180];
const FIXED_SYMBOLS = ['PF_XBTUSD','PF_XRPUSD','PF_DOTUSD','PF_ETHUSD','PF_UNIUSD','PF_ADAUSD','PF_BCHUSD','PF_SOLUSD','PF_FILUSD','PF_ATOMUSD'];
const SYMBOL_LIMIT = FIXED_SYMBOLS.length;
const WARMUP_DAYS = 30;
const MS = { '15m': 900_000, '1h': 3_600_000, '4h': 14_400_000 };
const SEC = { '15m': 900, '1h': 3600, '4h': 14400 };
const RESOLUTIONS = ['15m', '1h', '4h'];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function getJson(url, attempts = 5) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const response = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'CryptoPumpHunter-ResearchBacktest/1.0' }, signal: AbortSignal.timeout(30_000) });
      const body = await response.text();
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${body.slice(0, 200)}`);
      const json = JSON.parse(body);
      if (json?.result === 'error' || json?.error) throw new Error(JSON.stringify(json.errors || json.error));
      return json;
    } catch (error) {
      lastError = error;
      if (attempt + 1 < attempts) await sleep(500 * (attempt + 1));
    }
  }
  throw new Error(`Kraken request failed: ${url}\n${lastError?.message || lastError}`);
}

async function getUniverse() {
  const data = await getJson(`${BASE}/derivatives/api/v3/tickers`);
  if (!Array.isArray(data?.tickers)) throw new Error('Kraken tickers response did not contain tickers[].');
  const bySymbol = new Map(data.tickers.map(item => [String(item.symbol || '').toUpperCase(), item]));
  const missing = FIXED_SYMBOLS.filter(symbol => !bySymbol.has(symbol));
  if (missing.length) throw new Error(`The fixed 10-symbol comparison universe is unavailable on Kraken: ${missing.join(', ')}. Do not silently replace symbols.`);
  return FIXED_SYMBOLS.map(symbol => {
    const item = bySymbol.get(symbol);
    if (item.tag !== 'perpetual' || item.suspended === true) throw new Error(`${symbol} is not an active perpetual contract.`);
    return { symbol, quoteVolume: Number(item.volumeQuote || 0), last: Number(item.last), currentFundingRate: Number(item.fundingRate) };
  });
}

function normalizeRows(rows, interval) {
  const seen = new Set();
  return (Array.isArray(rows) ? rows : []).map(row => ({
    time: Number(row.time) < 1e12 ? Number(row.time) * 1000 : Number(row.time),
    open: Number(row.open), high: Number(row.high), low: Number(row.low), close: Number(row.close), volume: Number(row.volume ?? 0)
  })).filter(c => Number.isFinite(c.time) && [c.open,c.high,c.low,c.close,c.volume].every(Number.isFinite) &&
    c.open > 0 && c.low > 0 && c.high >= Math.max(c.open,c.close) && c.low <= Math.min(c.open,c.close) && c.volume >= 0)
    .sort((a,b) => a.time-b.time).filter(c => {
      if (seen.has(c.time) || c.time + MS[interval] > NOW) return false;
      seen.add(c.time); return true;
    });
}

async function downloadCandles(symbol, interval, fromMs, toMs) {
  const all = new Map();
  const chunkMs = MS[interval] * 1800;
  for (let start = fromMs; start < toMs; start += chunkMs) {
    const end = Math.min(toMs, start + chunkMs);
    const url = new URL(`${BASE}/api/charts/v1/trade/${encodeURIComponent(symbol)}/${interval}`);
    url.searchParams.set('from', String(Math.floor(start / 1000)));
    url.searchParams.set('to', String(Math.floor(end / 1000)));
    url.searchParams.set('count', '1900');
    const payload = await getJson(url);
    const rows = normalizeRows(payload.candles, interval);
    for (const candle of rows) if (candle.time >= fromMs && candle.time + MS[interval] <= toMs) all.set(candle.time, candle);
    if (payload.more_candles === true && rows.length >= 1900) throw new Error(`${symbol} ${interval}: response still has more candles; pagination chunk must be reduced.`);
    await sleep(120);
  }
  return [...all.values()].sort((a,b) => a.time-b.time);
}

function upperBound(arr, maxStartTime) {
  let lo=0, hi=arr.length;
  while (lo<hi) { const mid=(lo+hi)>>1; if (arr[mid].time<=maxStartTime) lo=mid+1; else hi=mid; }
  return lo;
}
function change24h(candles1h) {
  if (candles1h.length < 25) return 0;
  const now = candles1h.at(-1).close, old = candles1h.at(-25).close;
  return old > 0 ? (now / old - 1) * 100 : 0;
}
function levelShift(signal, fill) {
  const delta = fill - Number(signal.entry);
  return { entry: fill, stop: Number(signal.stop) + delta, target1: Number(signal.target1) + delta,
    target2: Number(signal.target2) + delta, target3: Number(signal.target3) + delta };
}

function addSignal(trade, trades, activeBySymbol) {
  activeBySymbol.set(trade.symbol, trade);
}
function advanceTrade(active, bar, index, trades, activeBySymbol) {
  if (index <= active.entryIndex) return;
  const isLong = active.side === 'LONG';
  const stopGap = isLong ? bar.open <= active.stop : bar.open >= active.stop;
  const stopHit = stopGap || (isLong ? bar.low <= active.stop : bar.high >= active.stop);
  const t1Hit = isLong ? bar.high >= active.target1 : bar.low <= active.target1;
  const t2Hit = isLong ? bar.high >= active.target2 : bar.low <= active.target2;
  const t3Hit = isLong ? bar.high >= active.target3 : bar.low <= active.target3;
  // Conservative OHLC assumption: if stop and any target are touched in one bar, stop is first.
  if (stopHit) {
    active.exitReason='STOP'; active.exitTime=bar.time; active.exitPrice=stopGap ? bar.open : active.stop;
    trades.push(active); activeBySymbol.delete(active.symbol); return;
  }
  if (t1Hit) { active.hitTP1=true; if (!active.tp1Time) active.tp1Time=bar.time; }
  if (t2Hit) { active.hitTP2=true; if (!active.tp2Time) active.tp2Time=bar.time; }
  if (t3Hit) {
    active.hitTP3=true; active.exitReason='TP3'; active.exitTime=bar.time; active.exitPrice=active.target3;
    trades.push(active); activeBySymbol.delete(active.symbol);
  }
}

function createV23Trade(symbol, signal, bar, nextBar, index) {
  const levels = levelShift(signal, nextBar.open);
  if (!(levels.stop > 0 && levels.target1 > 0 && levels.target2 > 0 && levels.target3 > 0)) return null;
  return { engine:'v2.3', symbol, side:signal.side, strategyId:signal.strategyId, strategyName:signal.strategyName,
    score:signal.score, signalTime:bar.time + MS['15m'], entryTime:nextBar.time, entryIndex:index+1,
    ...levels, originalSignalEntry:Number(signal.entry), rewardRisk:signal.rewardRisk,
    hitTP1:false, hitTP2:false, hitTP3:false, exitReason:'OPEN_AT_END' };
}
function createV47Trade(symbol, signal, bar, nextBar, index) {
  const levels = { entry:Number(signal.entry), stop:Number(signal.stop), target1:Number(signal.target1), target2:Number(signal.target2), target3:Number(signal.target3) };
  return { engine:'v4.7', symbol, side:signal.side, score:signal.score, strategyId:'ema-rsi-volume-trend',
    signalTime:bar.time + MS['15m'], entryTime:nextBar.time, entryIndex:index+1, ...levels,
    originalSignalEntry:Number(signal.entry), rewardRisk:signal.rewardRisk,
    hitTP1:false, hitTP2:false, hitTP3:false, exitReason:'OPEN_AT_END' };
}

function runEngine(engine, symbol, candles15, candles1h, candles4h, signalStart, signalEnd, tickerMeta) {
  const trades=[]; const activeBySymbol=new Map(); let lastV47CandleTime=null;
  for (let i=100; i<candles15.length-1; i++) {
    const bar=candles15[i], nextBar=candles15[i+1], closeTime=bar.time+MS['15m'];
    const active=activeBySymbol.get(symbol);
    if (active) { advanceTrade(active,bar,i,trades,activeBySymbol); continue; }
    if (closeTime < signalStart || closeTime > signalEnd) continue;
    const h1End=upperBound(candles1h,closeTime-MS['1h']);
    const h4End=upperBound(candles4h,closeTime-MS['4h']);
    const h1=candles1h.slice(Math.max(0,h1End-240),h1End);
    const h4=candles4h.slice(Math.max(0,h4End-240),h4End);
    const m15=candles15.slice(Math.max(0,i-159),i+1);
    if (h1.length < 60 || h4.length < 60 || m15.length < 40) continue;
    let signal=null, trade=null;
    if (engine==='v2.3') {
      const result=analyzePriceAction({symbol,oneHour:h1,fourHour:h4,fifteenMin:m15,livePrice:nextBar.open});
      signal=(result.signals||[]).find(x=>Number(x.setupTime)===Number(bar.time));
      if (signal) trade=createV23Trade(symbol,signal,bar,nextBar,i);
    } else {
      const h1CandleTime=h1.at(-1).time;
      const ticker={symbol,last:nextBar.open,priceChangePercent:change24h(h1),quoteVolume:tickerMeta.quoteVolume};
      const backtestTargetMultiples = engine === 'v4.7-tp1-1.2'
        ? [1.2, 2.5, 3.5]
        : engine.startsWith('v4.7-tp1.2-2-3-breakout-') || engine === 'v4.7-tp1.2-2-3'
          ? [1.2, 2.0, 3.0]
          : undefined;
      const breakoutMatch = engine.match(/^v4\\.7-tp1\\.2-2-3-breakout-(0\\.2|0\\.3|0\\.4|0\\.5)$/);
      const backtestOptions = {
        ...(backtestTargetMultiples ? {backtestTargetMultiples} : {}),
        ...(breakoutMatch ? {maxBreakoutDistancePct:Number(breakoutMatch[1])} : {})
      };
      const result=analyzeFuturesSymbol(ticker,h1,h4,m15,backtestOptions);
      if (result?.eligible && Number(result.candleTime)===h1CandleTime && h1CandleTime!==lastV47CandleTime) {
        signal=result; trade=createV47Trade(symbol,signal,bar,nextBar,i); lastV47CandleTime=h1CandleTime;
      }
    }
    if (trade) { trade.engine=engine; addSignal(trade,trades,activeBySymbol); }
  }
  for (const trade of activeBySymbol.values()) trades.push(trade);
  return trades;
}

function summarize(trades, universeSymbols, periodDays) {
  const closed=trades.filter(t=>t.exitReason!=='OPEN_AT_END');
  const wins=closed.filter(t=>t.exitReason==='TP3');
  const stops=closed.filter(t=>t.exitReason==='STOP');
  const longs=trades.filter(t=>t.side==='LONG').length;
  const shorts=trades.length-longs;
  const bySymbol = Object.fromEntries(universeSymbols.map(symbol => {
    const ts=trades.filter(t=>t.symbol===symbol);
    const n=ts.length, ss=ts.filter(t=>t.exitReason==='STOP');
    const tp1=ts.filter(t=>t.hitTP1).length, tp3=ts.filter(t=>t.exitReason==='TP3').length;
    const open=ts.filter(t=>t.exitReason==='OPEN_AT_END').length;
    return [symbol,{trades:n,tp1,tp1HitPct:n?+(tp1/n*100).toFixed(2):0,
      tp3,stop:ss.length,stopPct:n?+(ss.length/n*100).toFixed(2):0,
      stoppedBeforeTP1:ss.filter(t=>!t.hitTP1).length,
      stoppedBeforeTP1Pct:n?+(ss.filter(t=>!t.hitTP1).length/n*100).toFixed(2):0,
      open,signalsPer30SymbolDays:+(n*30/periodDays).toFixed(2)}];
  }));
  const activeSymbols=universeSymbols.length;
  const sum=key=>universeSymbols.reduce((v,s)=>v+bySymbol[s][key],0);
  return { totalTrades:trades.length, longs, shorts, closedTrades:closed.length,
    tp3: wins.length, stops:stops.length, hitTP1:trades.filter(t=>t.hitTP1).length,
    hitTP2:trades.filter(t=>t.hitTP2).length, stoppedBeforeTP1:stops.filter(t=>!t.hitTP1).length,
    hitTP1ThenStopped:stops.filter(t=>t.hitTP1).length,
    openAtEnd:trades.filter(t=>t.exitReason==='OPEN_AT_END').length,
    tp3WinRatePct:closed.length?+(wins.length/closed.length*100).toFixed(2):0,
    tp1HitPct:trades.length?+(trades.filter(t=>t.hitTP1).length/trades.length*100).toFixed(2):0,
    stopPct:trades.length?+(stops.length/trades.length*100).toFixed(2):0,
    stoppedBeforeTP1Pct:trades.length?+(stops.filter(t=>!t.hitTP1).length/trades.length*100).toFixed(2):0,
    signalsPer30SymbolDays:+(trades.length*30/(periodDays*activeSymbols)).toFixed(2),
    meanPerSymbolTP1HitPct:+(sum('tp1HitPct')/activeSymbols).toFixed(2),
    meanPerSymbolStoppedBeforeTP1Pct:+(sum('stoppedBeforeTP1Pct')/activeSymbols).toFixed(2),
    bySymbol,
    avgSignalScore:trades.length?+(trades.reduce((s,t)=>s+(Number(t.score)||0),0)/trades.length).toFixed(2):0 };
}

async function main() {
  await fs.mkdir(OUT,{recursive:true});
  console.log('Fetching Kraken Futures perpetual universe...');
  const candidates=await getUniverse();
  const maxDays=Math.max(...DAYS_LIST);
  const dataStart=SIGNAL_END-(maxDays+WARMUP_DAYS)*24*60*60*1000;
  const expectedBars={ '15m':Math.floor((SIGNAL_END-dataStart)/MS['15m']), '1h':Math.floor((SIGNAL_END-dataStart)/MS['1h']), '4h':Math.floor((SIGNAL_END-dataStart)/MS['4h']) };
  const seriesBySymbol={};
  const universe=[];
  const skippedSymbols=[];
  for (const meta of candidates) {
    if (universe.length>=SYMBOL_LIMIT) break;
    console.log(`Checking historical coverage for ${meta.symbol}...`);
    const series={};
    series['4h']=await downloadCandles(meta.symbol,'4h',dataStart,SIGNAL_END);
    const covers180d=series['4h'].length>=expectedBars['4h']*0.90 &&
      series['4h'][0]?.time<=dataStart+2*MS['4h'] &&
      series['4h'].at(-1)?.time>=SIGNAL_END-2*24*60*60*1000;
    if (!covers180d) {
      skippedSymbols.push({symbol:meta.symbol,reason:'less than 90% of the required 210-day 4h history'});
      console.log(`Skipping ${meta.symbol}: insufficient 4h historical coverage (${series['4h'].length}/${expectedBars['4h']}).`);
      continue;
    }
    series['1h']=await downloadCandles(meta.symbol,'1h',dataStart,SIGNAL_END);
    series['15m']=await downloadCandles(meta.symbol,'15m',dataStart,SIGNAL_END);
    const sufficient=['1h','15m'].every(interval=>series[interval].length>=expectedBars[interval]*0.90 &&
      series[interval][0]?.time<=dataStart+2*MS[interval] &&
      series[interval].at(-1)?.time>=SIGNAL_END-2*24*60*60*1000);
    if (!sufficient) {
      skippedSymbols.push({symbol:meta.symbol,reason:'insufficient 1h/15m historical coverage'});
      console.log(`Skipping ${meta.symbol}: incomplete 1h/15m history.`);
      continue;
    }
    universe.push(meta);
    seriesBySymbol[meta.symbol]=series;
    for (const interval of RESOLUTIONS) await fs.writeFile(path.join(OUT,`${meta.symbol}-${interval}.json`),JSON.stringify(series[interval]));
  }
  if (universe.length<SYMBOL_LIMIT) throw new Error(`Only ${universe.length}/${SYMBOL_LIMIT} perpetuals have complete 180-day coverage. Skipped: ${JSON.stringify(skippedSymbols)}`);
  console.log('Selected full-history symbols:',universe.map(x=>x.symbol).join(', '));
  const results={};
  for (const days of DAYS_LIST) {
    const signalStart=SIGNAL_END-days*24*60*60*1000;
    results[`${days}d`]={};
    for (const engine of ['v2.3','v4.7','v4.7-tp1-1.2','v4.7-tp1.2-2-3','v4.7-tp1.2-2-3-breakout-0.2','v4.7-tp1.2-2-3-breakout-0.3','v4.7-tp1.2-2-3-breakout-0.4','v4.7-tp1.2-2-3-breakout-0.5']) {
      let trades=[];
      for (const meta of universe) {
        const s=seriesBySymbol[meta.symbol];
        trades.push(...runEngine(engine,meta.symbol,s['15m'],s['1h'],s['4h'],signalStart,SIGNAL_END,meta));
      }
      trades.sort((a,b)=>a.entryTime-b.entryTime);
      results[`${days}d`][engine]={summary:summarize(trades,universe.map(x=>x.symbol),days),trades};
      console.log(`${days}d ${engine}:`,results[`${days}d`][engine].summary);
    }
  }
  const report={metadata:{source:'Kraken Futures public trade candles',backtestVariants:['v4.7 baseline [1.5,2.5,3.5]','TP1-only [1.2,2.5,3.5]','TP1/TP2/TP3 [1.2,2.0,3.0]','TP1/TP2/TP3 [1.2,2.0,3.0] + confirmed 15m pivot breakout distance <=0.2%, 0.3%, 0.4%, 0.5% (3-left/3-right)'],symbols:universe.map(x=>x.symbol),symbolSelection:'Fixed user-requested 10-symbol universe (BTC, XRP, DOT, ETH, UNI, ADA, BCH, SOL, FIL, ATOM); same exact symbols and dates used for all engines and both periods.',signalWindowsDays:DAYS_LIST,signalEnd:new Date(SIGNAL_END).toISOString(),warmupDays:WARMUP_DAYS,
    execution:'Signals evaluated only on completed 15m candles; only completed 1h/4h candles are visible; entry at next 15m open; v2.3 stop/targets shifted by entry fill delta to preserve original level distances; same 15m exit candles for both engines.',
    exitRule:'No maximum holding time. A trade remains open until stop or TP3. TP1/TP2 are milestones only. If stop and any target are touched in the same 15m candle, stop is assumed first; a gap through stop is filled at the 15m open. Positions still unresolved at latest available candle are marked OPEN_AT_END.',
    constraints:'One concurrent trade per symbol per engine. Historical funding is not available in the candle feed; v4.7 funding adjustment is omitted, matching its no-funding-data branch. Fees, slippage and partial exits are excluded. Historical symbol-universe membership is not reconstructed. A fixed user-requested 10-symbol list is used for both engines; the run fails rather than silently substituting any unavailable or insufficient-history symbol.',skippedSymbols},
    candleCoverage:Object.fromEntries(universe.map(meta=>[meta.symbol,Object.fromEntries(RESOLUTIONS.map(r=>[r,{count:seriesBySymbol[meta.symbol][r].length,first:new Date(seriesBySymbol[meta.symbol][r][0].time).toISOString(),last:new Date(seriesBySymbol[meta.symbol][r].at(-1).time).toISOString()}]))])),results};
  await fs.writeFile(path.join(OUT,'comparison-report.json'),JSON.stringify(report,null,2));
  const lines=['# v2.3 vs v4.7 — Historical signal engine comparison on identical fixed 10-symbol universe','',`Data end: ${report.metadata.signalEnd}`,`Symbols: ${report.metadata.symbols.join(', ')}`,'',
    '| Period | Engine | Trades | Trades / 30 symbol-days | TP1 hit % | Stop % | Stop before TP1 % | Mean per-symbol TP1 % | TP3 win rate |' ,'|---|---|---:|---:|---:|---:|---:|---:|---:|'];
  for (const days of DAYS_LIST) for (const engine of ['v2.3','v4.7','v4.7-tp1-1.2','v4.7-tp1.2-2-3','v4.7-tp1.2-2-3-breakout-0.2','v4.7-tp1.2-2-3-breakout-0.3','v4.7-tp1.2-2-3-breakout-0.4','v4.7-tp1.2-2-3-breakout-0.5']) { const s=results[`${days}d`][engine].summary; lines.push(`| ${days}d | ${engine} | ${s.totalTrades} | ${s.signalsPer30SymbolDays} | ${s.tp1HitPct}% | ${s.stopPct}% | ${s.stoppedBeforeTP1Pct}% | ${s.meanPerSymbolTP1HitPct}% | ${s.tp3WinRatePct}% |`); }
  lines.push('','## Per-symbol normalized results','', '| Period | Engine | Symbol | Trades | TP1 hit % | Stop before TP1 % | Signals / 30 symbol-days |','|---|---|---|---:|---:|---:|---:|');
  for (const days of DAYS_LIST) for (const engine of ['v2.3','v4.7','v4.7-tp1-1.2','v4.7-tp1.2-2-3','v4.7-tp1.2-2-3-breakout-0.2','v4.7-tp1.2-2-3-breakout-0.3','v4.7-tp1.2-2-3-breakout-0.4','v4.7-tp1.2-2-3-breakout-0.5']) for (const [symbol,m] of Object.entries(results[`${days}d`][engine].summary.bySymbol)) lines.push(`| ${days}d | ${engine} | ${symbol} | ${m.trades} | ${m.tp1HitPct}% | ${m.stoppedBeforeTP1Pct}% | ${m.signalsPer30SymbolDays} |`);
  lines.push('','## Methodology','',report.metadata.execution,report.metadata.exitRule,'',report.metadata.constraints,'','Full trade ledger and raw candle files are in the workflow artifact.');
  await fs.writeFile(path.join(OUT,'comparison-report.md'),lines.join('\n'));
  console.log('\n'+lines.join('\n'));
}
main().catch(error=>{console.error(error.stack||error);process.exitCode=1;});
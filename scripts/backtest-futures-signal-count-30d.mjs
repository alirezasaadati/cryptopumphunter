import { mkdir, writeFile } from "node:fs/promises";
import { getKrakenFuturesUniverse, analyzeFuturesSymbol, FUTURES_CONFIG } from "../src/index.js";

const BASE = "https://futures.kraken.com";
const HOUR = 60 * 60 * 1000;
const FIVE_MIN = 5 * 60 * 1000;
const FOUR_HOURS = 4 * HOUR;
const FIFTEEN_MIN = 15 * FIVE_MIN;
const FIVE_DAYS = 5 * 24 * HOUR;
const DAYS = 30;
const WARMUP_DAYS = 15;

async function pause(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function getJson(url) {
  const response = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(30000)
  });
  const body = await response.text();
  if (!response.ok) throw new Error("HTTP " + response.status + " for " + url + ": " + body.slice(0, 180));
  let data;
  try { data = JSON.parse(body); } catch { throw new Error("Invalid JSON from " + url); }
  if (data?.result === "error" || (Array.isArray(data?.errors) && data.errors.length)) {
    throw new Error("Kraken API error: " + JSON.stringify(data.errors || data.error));
  }
  return data;
}

function normalizeCandles(rows, intervalMs, endMs) {
  if (!Array.isArray(rows)) throw new Error("Kraken candles array missing");
  const byTime = new Map();
  for (const row of rows) {
    const rawTime = Number(row.time);
    const candle = {
      time: rawTime < 1e12 ? rawTime * 1000 : rawTime,
      open: Number(row.open), high: Number(row.high), low: Number(row.low),
      close: Number(row.close), volume: Number(row.volume)
    };
    if (
      Number.isFinite(candle.time) && Number.isFinite(candle.open) &&
      Number.isFinite(candle.high) && Number.isFinite(candle.low) &&
      Number.isFinite(candle.close) && Number.isFinite(candle.volume) &&
      candle.open > 0 && candle.close > 0 && candle.low > 0 &&
      candle.high >= candle.low && candle.volume >= 0 &&
      candle.time + intervalMs <= endMs
    ) byTime.set(candle.time, candle);
  }
  return [...byTime.values()].sort((a,b) => a.time-b.time);
}

async function fetchCandles(symbol, resolution, fromMs, toMs, intervalMs) {
  const chunkMs = Math.min(intervalMs * 1800, 200 * HOUR);
  const combined = [];
  for (let start = fromMs; start < toMs; start += chunkMs) {
    const end = Math.min(toMs, start + chunkMs);
    const url = new URL(BASE + "/api/charts/v1/trade/" + encodeURIComponent(symbol) + "/" + resolution);
    url.searchParams.set("from", String(Math.floor(start / 1000)));
    url.searchParams.set("to", String(Math.floor(end / 1000)));
    url.searchParams.set("count", "1900");
    const data = await getJson(url);
    if (data.more_candles === true) {
      throw new Error(symbol + " " + resolution + ": Kraken reported truncated candles.");
    }
    combined.push(...normalizeCandles(data.candles, intervalMs, toMs));
    await pause(90);
  }
  const byTime = new Map(combined.map(c => [c.time, c]));
  return [...byTime.values()].sort((a,b) => a.time-b.time);
}

function lastClosedIndex(candles, scanTime, intervalMs) {
  let low = 0, high = candles.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (candles[mid].time + intervalMs <= scanTime) low = mid + 1;
    else high = mid;
  }
  return low - 1;
}

function tailAt(candles, index, limit = FUTURES_CONFIG.KLINE_LIMIT) {
  if (index < 0) return [];
  return candles.slice(Math.max(0, index - limit + 1), index + 1);
}

function ema(values, period) {
  if (values.length < period) return null;
  const multiplier = 2 / (period + 1);
  let value = values.slice(0, period).reduce((a,b) => a+b, 0) / period;
  for (let i = period; i < values.length; i++) value = values[i] * multiplier + value * (1-multiplier);
  return value;
}

function fourHourTrend(candles) {
  if (!Array.isArray(candles) || candles.length < FUTURES_CONFIG.MIN_CANDLES) return null;
  const closes = candles.map(c => c.close);
  const lastClose = closes.at(-1);
  const fast = ema(closes,20), prevFast = ema(closes.slice(0,-1),20), slow = ema(closes,50);
  if (![fast,prevFast,slow,lastClose].every(Number.isFinite)) return null;
  if (fast > slow && lastClose > fast && fast >= prevFast) return "BULLISH";
  if (fast < slow && lastClose < fast && fast <= prevFast) return "BEARISH";
  return "NEUTRAL";
}

function marketRegime(analyzed) {
  const samples = analyzed.filter(x => ["BULLISH","BEARISH","NEUTRAL"].includes(x?.fourHourTrend));
  const total = samples.length || 1;
  const bullish = samples.filter(x => x.fourHourTrend === "BULLISH").length / total;
  const bearish = samples.filter(x => x.fourHourTrend === "BEARISH").length / total;
  if (bullish >= 0.65) return "BULLISH";
  if (bearish >= 0.65) return "BEARISH";
  if (bullish - bearish >= 0.10) return "LEAN_BULLISH";
  if (bearish - bullish >= 0.10) return "LEAN_BEARISH";
  return "NEUTRAL";
}

function applyRegimePriority(items, regime) {
  for (const item of items) {
    if (item?.eligible !== true || !item.side) continue;
    const aligned = (regime === "BULLISH" && item.side === "LONG") || (regime === "BEARISH" && item.side === "SHORT");
    const leaningAligned = (regime === "LEAN_BULLISH" && item.side === "LONG") || (regime === "LEAN_BEARISH" && item.side === "SHORT");
    const opposing = (regime === "BULLISH" && item.side === "SHORT") || (regime === "BEARISH" && item.side === "LONG");
    const leaningOpposing = (regime === "LEAN_BULLISH" && item.side === "SHORT") || (regime === "LEAN_BEARISH" && item.side === "LONG");
    const adjustment = aligned ? 8 : leaningAligned ? 5 : opposing ? -8 : leaningOpposing ? -5 : 0;
    item.priorityScore = Math.max(0, Math.min(125, Math.round(Number(item.priorityScore ?? item.score) + adjustment)));
  }
}

function historical24hChange(candles, index) {
  const old = candles[index - 24], current = candles[index];
  return !old || old.close <= 0 ? 0 : (current.close / old.close - 1) * 100;
}

function historicalQuoteVolume(candles, index) {
  const window = candles.slice(Math.max(0,index-23),index+1);
  if (window.length < 24) return 0;
  return window.reduce((sum,c) => sum + c.volume * c.close, 0);
}

async function main() {
  const endMs = Date.now();
  const testStart = endMs - DAYS * 24 * HOUR;
  const dataStart = testStart - WARMUP_DAYS * 24 * HOUR;
  const universe = await getKrakenFuturesUniverse();
  if (!universe.length) throw new Error("Kraken returned no current liquid perpetual symbols.");
  console.log("Current liquid Kraken perpetual universe:", universe.length);

  const market = new Map();
  for (const ticker of universe) {
    const symbol = ticker.symbol;
    try {
      const [m5,m15,h1,h4] = await Promise.all([
        fetchCandles(symbol,"5m",dataStart,endMs,FIVE_MIN),
        fetchCandles(symbol,"15m",dataStart,endMs,FIFTEEN_MIN),
        fetchCandles(symbol,"1h",dataStart,endMs,HOUR),
        fetchCandles(symbol,"4h",dataStart,endMs,FOUR_HOURS)
      ]);
      if (m5.length < 100 || m15.length < FUTURES_CONFIG.MIN_CANDLES ||
          h1.length < FUTURES_CONFIG.MIN_CANDLES || h4.length < FUTURES_CONFIG.MIN_CANDLES) {
        throw new Error("insufficient candles 5m="+m5.length+" 15m="+m15.length+" 1h="+h1.length+" 4h="+h4.length);
      }
      const coverage = [
        [m5,FIVE_MIN,"5m"], [m15,FIFTEEN_MIN,"15m"],
        [h1,HOUR,"1h"], [h4,FOUR_HOURS,"4h"]
      ];
      const incomplete = coverage.find(([candles,interval]) => candles[0].time > dataStart + interval * 2);
      if (incomplete) {
        throw new Error("incomplete 45-day history for "+incomplete[2]+"; earliest candle="+new Date(incomplete[0][0].time).toISOString());
      }
      market.set(symbol,{ticker,m5,m15,h1,h4});
      console.log("Loaded",symbol,{m5:m5.length,m15:m15.length,h1:h1.length,h4:h4.length});
    } catch (error) {
      console.error("DATA_SKIP",symbol,String(error?.message||error));
    }
  }
  if (!market.size) throw new Error("No symbol had sufficient historical candles.");

  const btcMarket = market.get("PF_XBTUSD");
  let btc4h = btcMarket?.h4;
  if (!btc4h) btc4h = await fetchCandles("PF_XBTUSD","4h",dataStart,endMs,FOUR_HOURS);
  if (btc4h.length < FUTURES_CONFIG.MIN_CANDLES) throw new Error("Insufficient BTC 4h candles.");

  const seen = new Set();
  const selected = [];
  const bySymbol = {};
  let scanCount = 0, candidateCount = 0, skippedNoData = 0;
  const firstScan = Math.ceil(testStart / FIVE_MIN) * FIVE_MIN;

  for (let scanTime = firstScan; scanTime <= endMs; scanTime += FIVE_MIN) {
    scanCount++;
    const btcIndex = lastClosedIndex(btc4h,scanTime,FOUR_HOURS);
    const btcTrend = fourHourTrend(tailAt(btc4h,btcIndex));
    if (!btcTrend) { skippedNoData++; continue; }

    const analyzed = [];
    for (const [symbol,data] of market) {
      const i5 = lastClosedIndex(data.m5,scanTime,FIVE_MIN);
      const i15 = lastClosedIndex(data.m15,scanTime,FIFTEEN_MIN);
      const i1 = lastClosedIndex(data.h1,scanTime,HOUR);
      const i4 = lastClosedIndex(data.h4,scanTime,FOUR_HOURS);
      if (i5 < 0 || i15 < 0 || i1 < 60 || i4 < FUTURES_CONFIG.MIN_CANDLES-1) {
        analyzed.push({symbol,rejected:"insufficient historical candles"});
        skippedNoData++;
        continue;
      }
      const candles1h = tailAt(data.h1,i1);
      const candles4h = tailAt(data.h4,i4);
      const candles15m = tailAt(data.m15,i15);
      const quoteVolume = historicalQuoteVolume(data.h1,i1);
      if (quoteVolume < FUTURES_CONFIG.MIN_QUOTE_VOLUME) {
        analyzed.push({symbol,rejected:"below historical 24h quote-volume threshold"});
        continue;
      }
      const last = data.m5[i5].close;
      const tickerAtScan = {
        ...data.ticker,
        symbol,
        last,
        quoteVolume,
        priceChangePercent:historical24hChange(data.h1,i1),
        premium:{lastFundingRate:null}
      };
      try {
        analyzed.push(analyzeFuturesSymbol(tickerAtScan,candles1h,candles4h,candles15m,{
          btcFourHourTrend:btcTrend,
          requireBtcFourHourAlignment:true
        }));
      } catch(error) {
        analyzed.push({symbol,rejected:String(error?.message||error)});
      }
    }

    const regime = marketRegime(analyzed);
    const eligible = analyzed.filter(x => x?.eligible === true && x.side);
    applyRegimePriority(eligible,regime);
    eligible.sort((a,b) =>
      Number(a.riskLevel === "HIGH_RISK") - Number(b.riskLevel === "HIGH_RISK") ||
      Number(b.priorityScore ?? b.score) - Number(a.priorityScore ?? a.score) ||
      a.symbol.localeCompare(b.symbol)
    );
    candidateCount += eligible.length;

    for (const item of eligible.slice(0,FUTURES_CONFIG.MAX_SIGNALS_PER_SCAN)) {
      const candleTime = Number(item.candleTime);
      const fingerprint = [item.symbol,item.side,"kraken-futures-engine",candleTime].join("|");
      if (seen.has(fingerprint)) continue;
      seen.add(fingerprint);
      selected.push({
        symbol:item.symbol,side:item.side,riskLevel:item.riskLevel,
        score:item.score,priorityScore:item.priorityScore,
        candleTime,scanTime,entry:item.entry
      });
      bySymbol[item.symbol] = (bySymbol[item.symbol] || 0) + 1;
    }
  }

  const bySide = {
    LONG:selected.filter(x=>x.side==="LONG").length,
    SHORT:selected.filter(x=>x.side==="SHORT").length
  };
  const byRisk = {
    STANDARD:selected.filter(x=>x.riskLevel!=="HIGH_RISK").length,
    HIGH_RISK:selected.filter(x=>x.riskLevel==="HIGH_RISK").length
  };
  const report = {
    generatedAt:new Date().toISOString(),
    period:{from:new Date(testStart).toISOString(),to:new Date(endMs).toISOString(),days:DAYS},
    method:"Count-only replay of the live signal engine on Kraken historical candles at each 5-minute scheduled scan. Includes the live BTC 4h alignment, market-regime priority adjustment, six-signal scan cap, and signal fingerprint deduplication.",
    entryPrice:"Engine entry only; Telegram display offset (SHORT +1%, LONG -1.5%) is not applied.",
    settings:{
      symbolsAvailable:universe.length,symbolsWithData:market.size,scans:scanCount,
      scanIntervalMinutes:5,maxSignalsPerScan:FUTURES_CONFIG.MAX_SIGNALS_PER_SCAN,
      candleWindow:FUTURES_CONFIG.KLINE_LIMIT,feeAndPnlSimulation:false,
      historicalFunding:"not available in this replay; funding penalty is not applied",
      universe:"current active/liquid Kraken perpetual universe replayed across the full 30 days; historical listings and delisted symbols are not reconstructed",
      quoteVolume:"estimated from 1h base volume × close over the rolling 24h window",
      tickerPrice:"latest closed 5m candle close used as a proxy for live ticker.last"
    },
    totalSignals:selected.length,bySide,byRisk,bySymbol,
    diagnostics:{candidateEvaluations:candidateCount,scansWithoutBtcData:skippedNoData,symbolsFailed:[...universe.map(x=>x.symbol).filter(x=>!market.has(x))]},
    signals:selected
  };

  await mkdir("artifacts",{recursive:true});
  await writeFile("artifacts/futures-signal-count-30d.json",JSON.stringify(report,null,2));
  const lines=[
    "# Futures signal count — 30-day replay","",
    "Period: "+report.period.from+" to "+report.period.to,
    "Total signals selected: "+report.totalSignals,
    "LONG: "+bySide.LONG+" | SHORT: "+bySide.SHORT,
    "STANDARD: "+byRisk.STANDARD+" | HIGH_RISK: "+byRisk.HIGH_RISK,
    "Symbols: "+market.size+"/"+universe.length,
    "Scheduled scans: "+scanCount,
    "",
    "Telegram display entry offset was not applied. Engine entry levels were used.",
    "This is a count-only signal replay, not a filled-order or PnL simulation.",
    "Limitations: current universe is reused historically; 24h quote volume is estimated from candles; current historical funding is unavailable; 5m close proxies the live ticker snapshot.",
    "",
    "| Symbol | Signals |","|---|---:|",
    ...Object.entries(bySymbol).sort((a,b)=>b[1]-a[1]).map(([s,n])=>"| "+s+" | "+n+" |")
  ];
  await writeFile("artifacts/futures-signal-count-30d.md",lines.join("\n"));
  console.log(JSON.stringify({
    ok:true,totalSignals:report.totalSignals,bySide,byRisk,
    symbols:market.size+"/"+universe.length,scans:scanCount,
    diagnostics:report.diagnostics
  },null,2));
}

main().catch(error=>{console.error(error);process.exitCode=1;});

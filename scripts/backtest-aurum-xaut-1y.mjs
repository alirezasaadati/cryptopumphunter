import { analyzeAurum, AURUM_CONFIG } from "../experimental/aurum/aurum_fixed/aurum-engine.js";
import { mkdir, writeFile } from "node:fs/promises";

const BASE = "https://api.kraken.com/0/public/Trades";
const BAR15 = 15 * 60;
const BAR4H = 4 * 60 * 60;
const DAY = 86400;
const END = Math.floor(Date.now() / 1000);
const START = END - 365 * DAY;
const WARMUP = START - 30 * DAY;
const FEE = Number(process.env.AURUM_TAKER_FEE ?? 0.008); // Kraken spot Tier-1 taker assumption, per side
const SLIPPAGE = Number(process.env.AURUM_SLIPPAGE ?? 0.0005); // 5 bps per side
const MAX_HOLD_BARS = 96; // 24h on 15m candles
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function getJson(url) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const response = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(30000) });
    const body = await response.text();
    if (!response.ok) {
      if (response.status === 429 || response.status >= 500) { await sleep(1500 * (attempt + 1)); continue; }
      throw new Error(`Kraken HTTP ${response.status}: ${body.slice(0, 300)}`);
    }
    const data = JSON.parse(body);
    if (data.error?.length) {
      const message = data.error.join("; ");
      if (/Too many requests|rate limit/i.test(message)) { await sleep(2000 * (attempt + 1)); continue; }
      throw new Error("Kraken API: " + message);
    }
    return data;
  }
  throw new Error("Kraken API retries exhausted");
}

async function loadTrades() {
  let cursor = (BigInt(WARMUP) * 1000000000n - 1n).toString();
  const all = [];
  let pages = 0, done = false;
  while (!done) {
    const url = new URL(BASE);
    url.searchParams.set("pair", "XAUTUSD");
    url.searchParams.set("since", cursor);
    const data = await getJson(url);
    const result = data.result || {};
    const rows = Object.entries(result).find(([key, value]) => key !== "last" && Array.isArray(value))?.[1] || [];
    const next = String(result.last ?? cursor);
    if (!rows.length) break;
    let maxTime = -Infinity;
    for (const row of rows) {
      const time = Number(row[2]), price = Number(row[0]), volume = Number(row[1]);
      if (Number.isFinite(time)) maxTime = Math.max(maxTime, time);
      if (time >= WARMUP && time < END && price > 0 && volume >= 0) {
        all.push({ time, price, volume, side: row[3] });
      }
    }
    pages++;
    if (pages % 10 === 0) console.log(`Kraken trades pages: ${pages}; trades retained: ${all.length}`);
    if (maxTime >= END || BigInt(next) <= BigInt(cursor)) done = true;
    else cursor = next;
    if (!done) await sleep(1050);
    if (pages > 10000) throw new Error("Safety stop: more than 10,000 trade pages");
  }
  all.sort((a,b) => a.time - b.time);
  const deduped = [];
  let lastKey = "";
  for (const t of all) {
    const key = [t.time,t.price,t.volume,t.side].join("|");
    if (key !== lastKey) deduped.push(t);
    lastKey = key;
  }
  if (deduped.length < 1000) throw new Error(`Insufficient Kraken trade history: only ${deduped.length} trades`);
  return { trades: deduped, pages };
}

function aggregate(trades, intervalSec, fromSec, toSec) {
  const buckets = new Map();
  for (const t of trades) {
    const ts = Math.floor(t.time / intervalSec) * intervalSec;
    let b = buckets.get(ts);
    if (!b) buckets.set(ts, b = { timestamp: ts * 1000, open: t.price, high: t.price, low: t.price, close: t.price, volume: 0 });
    b.high = Math.max(b.high, t.price);
    b.low = Math.min(b.low, t.price);
    b.close = t.price;
    b.volume += t.volume;
  }
  const first = Math.floor(fromSec / intervalSec) * intervalSec;
  const last = Math.floor((toSec - 1) / intervalSec) * intervalSec;
  const out = [];
  let previousClose = null;
  for (let ts = first; ts <= last; ts += intervalSec) {
    const b = buckets.get(ts);
    if (b) {
      out.push(b);
      previousClose = b.close;
    } else if (previousClose != null) {
      out.push({ timestamp: ts * 1000, open: previousClose, high: previousClose, low: previousClose, close: previousClose, volume: 0 });
    }
  }
  return out;
}

function simulate(signal, bars, entryIndex) {
  const dir = signal.side === "LONG" ? 1 : -1;
  const next = bars[entryIndex];
  const rawEntry = next.open;
  const drift = Math.abs(rawEntry - signal.entry) / signal.atr15m;
  if (drift > AURUM_CONFIG.maxEntryDriftAtr) return { skipped: "next_open_gap" };
  const entry = rawEntry * (1 + dir * SLIPPAGE);
  const stop = signal.stop;
  const risk = dir * (entry - stop);
  if (!(risk > 0) || !Number.isFinite(risk)) return { skipped: "invalid_risk" };
  const target = entry + dir * risk * AURUM_CONFIG.tp1R;
  const endIndex = Math.min(bars.length - 1, entryIndex + MAX_HOLD_BARS);
  let exitRaw = null, exitReason = null, exitIndex = endIndex;
  for (let i = entryIndex; i <= endIndex; i++) {
    const b = bars[i];
    const stopGap = dir === 1 ? b.open <= stop : b.open >= stop;
    const stopHit = dir === 1 ? b.low <= stop : b.high >= stop;
    const targetHit = dir === 1 ? b.high >= target : b.low <= target;
    if (stopGap || stopHit) {
      exitRaw = stopGap ? b.open : stop;
      exitReason = "STOP";
      exitIndex = i;
      break;
    }
    // Conservative OHLC assumption: if both levels could be touched in one bar, stop is checked first.
    if (targetHit) {
      exitRaw = target;
      exitReason = "TP1";
      exitIndex = i;
      break;
    }
    if (i === endIndex) {
      exitRaw = b.close;
      exitReason = "TIME_EXIT";
    }
  }
  const exit = exitRaw * (1 - dir * SLIPPAGE);
  const grossR = dir * (exit - entry) / risk;
  const feesR = FEE * (entry + exit) / risk;
  return {
    skipped: null, side: signal.side, entry, stop, target, exit,
    riskPct: risk / entry * 100, grossR, feesR, netR: grossR - feesR,
    exitReason, signalTime: bars[entryIndex - 1].timestamp,
    entryTime: next.timestamp, exitTime: bars[exitIndex].timestamp,
    holdBars: exitIndex - entryIndex, score: signal.score, session: signal.session
  };
}

function metrics(trades) {
  const wins = trades.filter(t => t.netR > 0), losses = trades.filter(t => t.netR < 0);
  const grossWin = wins.reduce((s,t)=>s+t.netR,0);
  const grossLoss = Math.abs(losses.reduce((s,t)=>s+t.netR,0));
  let equity = 0, peak = 0, maxDD = 0;
  for (const t of trades) { equity += t.netR; peak = Math.max(peak,equity); maxDD = Math.max(maxDD,peak-equity); }
  return {
    trades: trades.length, wins: wins.length, losses: losses.length,
    breakeven: trades.length - wins.length - losses.length,
    winRatePct: trades.length ? wins.length / trades.length * 100 : 0,
    grossR: trades.reduce((s,t)=>s+t.grossR,0),
    feesR: trades.reduce((s,t)=>s+t.feesR,0),
    netR: trades.reduce((s,t)=>s+t.netR,0),
    expectancyR: trades.length ? trades.reduce((s,t)=>s+t.netR,0) / trades.length : 0,
    profitFactor: grossLoss ? grossWin / grossLoss : grossWin ? null : 0,
    maxDrawdownR: maxDD,
    averageHoldHours: trades.length ? trades.reduce((s,t)=>s+t.holdBars,0) * 0.25 / trades.length : 0,
    bySide: Object.fromEntries(["LONG","SHORT"].map(side => {
      const xs = trades.filter(t=>t.side===side);
      const w=xs.filter(t=>t.netR>0), l=xs.filter(t=>t.netR<0);
      const gw=w.reduce((s,t)=>s+t.netR,0), gl=Math.abs(l.reduce((s,t)=>s+t.netR,0));
      return [side,{trades:xs.length,wins:w.length,losses:l.length,winRatePct:xs.length?w.length/xs.length*100:0,netR:xs.reduce((s,t)=>s+t.netR,0),profitFactor:gl?gw/gl:gw?null:0}];
    }))
  };
}

async function main() {
  console.log("Downloading XAUT/USD historical trades from Kraken...");
  const { trades, pages } = await loadTrades();
  console.log(`Received ${trades.length} trades across ${pages} pages.`);
  const candles15 = aggregate(trades, BAR15, WARMUP, END);
  const candles4h = aggregate(trades, BAR4H, WARMUP, END);
  const firstTestIndex = candles15.findIndex(c => c.timestamp >= START * 1000);
  if (firstTestIndex < 120 || candles4h.length < 100) throw new Error("Not enough warm-up candles to start a valid backtest");
  let state = {};
  const tradesOut = [];
  let signals = 0, skippedOverlap = 0, skippedGap = 0, skippedRisk = 0;
  let busyUntil = -1, h4Index = 0;
  for (let i = firstTestIndex; i < candles15.length - 1; i++) {
    const bar = candles15[i];
    while (h4Index < candles4h.length && candles4h[h4Index].timestamp + BAR4H * 1000 <= bar.timestamp) h4Index++;
    const closed4h = candles4h.slice(0, h4Index);
    if (closed4h.length < 60) continue;
    const c15 = candles15.slice(Math.max(0, i - 119), i + 1);
    const result = analyzeAurum({
      symbol: "XAUTUSD", candles15m: c15, candles4h: closed4h,
      price: bar.close, lastCandleClosed: true, state
    });
    if (result.nextState) state = result.nextState;
    if (!result.eligible) continue;
    signals++;
    if (i <= busyUntil) { skippedOverlap++; continue; }
    const simulated = simulate(result, candles15, i + 1);
    if (simulated.skipped === "next_open_gap") { skippedGap++; continue; }
    if (simulated.skipped) { skippedRisk++; continue; }
    tradesOut.push(simulated);
    busyUntil = Math.max(i + 1, Math.floor((simulated.exitTime - candles15[0].timestamp) / (BAR15 * 1000)));
    if (signals % 25 === 0) console.log(`Signals: ${signals}; executed trades: ${tradesOut.length}`);
  }
  const report = {
    strategy: "Aurum v1.1",
    symbol: "XAUT/USD",
    exchange: "Kraken Spot",
    period: { start: new Date(START * 1000).toISOString(), end: new Date(END * 1000).toISOString() },
    data: { source: "Kraken public REST Trades endpoint", rawTrades: trades.length, tradePages: pages, candles15m: candles15.length, candles4h: candles4h.length, missingIntervalsFilledFlatAtPreviousClose: true },
    executionAssumptions: {
      entry: "next 15m candle open after a closed-candle signal",
      exit: "all-out at TP1 (1R), stop, or 24h time exit",
      sameCandleAmbiguity: "stop checked before target",
      feePerSide: FEE, slippagePerSide: SLIPPAGE,
      feeNote: "Default fee is Kraken Spot Crypto Tier-1 taker rate; replace AURUM_TAKER_FEE with the user's actual tier.",
      management: "TP2/TP3 and BE/trailing settings are not applied because the supplied engine does not define partial-exit weights or trailing-stop mechanics."
    },
    counts: { signals, executedTrades: tradesOut.length, skippedOverlap, skippedNextOpenGap: skippedGap, skippedInvalidRisk: skippedRisk },
    metrics: metrics(tradesOut),
    trades: tradesOut
  };
  await mkdir("artifacts", { recursive: true });
  await writeFile("artifacts/aurum-xaut-1y-report.json", JSON.stringify(report, null, 2));
  const cols = ["side","entry","stop","target","exit","grossR","feesR","netR","exitReason","signalTime","entryTime","exitTime","holdBars","score","session"];
  const csv = [cols.join(","), ...tradesOut.map(t=>cols.map(k=>JSON.stringify(t[k] ?? "")).join(","))].join("\n");
  await writeFile("artifacts/aurum-xaut-1y-trades.csv", csv);
  const m = report.metrics;
  const md = [
    "# Aurum v1.1 — XAUT/USD 1-year Kraken backtest",
    `Period: ${report.period.start} → ${report.period.end}`,
    `Trades downloaded: ${trades.length} | 15m candles: ${candles15.length} | 4h candles: ${candles4h.length}`,
    `Signals: ${signals} | Executed: ${tradesOut.length} | Overlap skipped: ${skippedOverlap} | Gap skipped: ${skippedGap}`,
    `Win rate: ${m.winRatePct.toFixed(2)}% | Net R: ${m.netR.toFixed(3)} | PF: ${m.profitFactor == null ? "∞" : m.profitFactor.toFixed(3)} | Max DD: ${m.maxDrawdownR.toFixed(3)}R`,
    `Gross R: ${m.grossR.toFixed(3)} | Fees R: ${m.feesR.toFixed(3)} | Expectancy: ${m.expectancyR.toFixed(4)}R/trade`,
    `Fee/side: ${(FEE*100).toFixed(3)}% | Slippage/side: ${(SLIPPAGE*100).toFixed(3)}%`,
    "",
    "Execution assumptions: next 15m open entry; all-out at TP1/SL/24h time exit; stop-first for same-candle ambiguity.",
    "TP2/TP3 and BE/trailing are excluded because the supplied signal engine does not specify position sizing across targets or a trailing-stop algorithm."
  ].join("\n");
  await writeFile("artifacts/aurum-xaut-1y-report.md", md);
  console.log(md);
}
main().catch(error => { console.error(error); process.exitCode = 1; });

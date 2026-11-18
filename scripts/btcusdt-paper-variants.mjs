import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { analyzeFuturesSymbol } from "../src/index.js";
import { passesCompression, passesAtrCap, passesBreakoutBody } from "../src/futures-filter-experiments.js";
import { passesVolumeThreshold, isLateEntry, hasPullbackOrBreakout, passesEntryFreshness } from "../src/futures-entry-experiments.js";\nimport { detectOneHourBOS, buildPriceActionSignal } from "./btcusdt-price-action.mjs";

const BASE = "https://fapi.binance.com";
const SYMBOL = "BTCUSDT";
const STATE_PATH = process.env.BTC_PAPER_STATE || "./artifacts/btcusdt-paper-state.json";
const FEE = 0.0005;
const SLIPPAGE = 0.0003;
const MAX_PENDING_15M = 4;
const MAX_HOLD_15M = 288; // 72 hours
const VARIANTS = [
  { id: "A_baseline", label: "Baseline", minVolume: 0.75 },
  { id: "B_all_filters", label: "All filters", minVolume: 1.2, compression: 0.8, atrCap: 5, bodyRatio: 1.2, requireSetup: true, avoidLate: true },
  { id: "C_avoid_late", label: "Avoid late entry only", minVolume: 0.75, avoidLate: true }
];

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const finite = (...xs) => xs.every(Number.isFinite);
function ema(values, period = 20) {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let v = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) v = values[i] * k + v * (1 - k);
  return v;
}
async function fetchCandles(interval, limit = 500) {
  const url = `${BASE}/fapi/v1/klines?symbol=${SYMBOL}&interval=${interval}&limit=${limit}`;
  const res = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`Binance ${interval} HTTP ${res.status}`);
  const rows = await res.json();
  if (!Array.isArray(rows)) throw new Error(`Invalid ${interval} kline payload`);
  return rows.map(r => ({ time:+r[0], open:+r[1], high:+r[2], low:+r[3], close:+r[4], volume:+r[5], closeTime:+r[6] }))
    .filter(c => finite(c.time,c.open,c.high,c.low,c.close,c.volume,c.closeTime) && c.open>0 && c.low>0 && c.high>=c.low && c.close>0 && c.volume>=0)
    .sort((a,b)=>a.time-b.time);
}
async function loadState() {
  try { return JSON.parse(await readFile(STATE_PATH, "utf8")); }
  catch (e) { if (e.code !== "ENOENT") throw e; }
  return { version:1, symbol:SYMBOL, createdAt:new Date().toISOString(), last1hTime:0, last15mTime:0,
    variants:Object.fromEntries(VARIANTS.map(v=>[v.id,{pending:null,open:null,trades:[]}])) };
}
async function saveState(state) {
  await mkdir(dirname(STATE_PATH), { recursive: true });
  const tmp = STATE_PATH + ".tmp";
  await writeFile(tmp, JSON.stringify(state,null,2));
  await rename(tmp, STATE_PATH);
}
function filterPasses(v, sig, h1, idx) {
  if (!passesVolumeThreshold(sig.volumeRatio, v.minVolume)) return false;
  if (v.compression && !passesCompression(h1,idx,v.compression)) return false;
  if (v.atrCap && !passesAtrCap(sig.atr,sig.entry,v.atrCap)) return false;
  if (v.bodyRatio && !passesBreakoutBody(h1,idx,v.bodyRatio)) return false;
  if (v.avoidLate && isLateEntry({side:sig.side,entry:sig.entry,ema20:sig.ema20,atr:sig.atr})) return false;
  if (v.requireSetup && !hasPullbackOrBreakout({side:sig.side,candles:h1.slice(0,idx+1),ema20:sig.ema20,atr:sig.atr,lookback:20})) return false;
  return true;
}
function confirm15m(side, candle, history) {
  const e20 = ema(history.map(x=>x.close),20);
  if (!Number.isFinite(e20)) return false;
  return side === "LONG"
    ? candle.close > e20 && candle.close > candle.open
    : candle.close < e20 && candle.close < candle.open;
}
function startTrade(side, signal, candle, nextBar) {
  if (!nextBar || !(nextBar.open > 0)) return null;
  const dir = side === "LONG" ? 1 : -1;
  if (!passesEntryFreshness(signal.entry,nextBar.open,0.35)) return null;
  const entry = nextBar.open * (1 + dir * SLIPPAGE);
  const shift = entry - signal.entry;
  const stop = signal.stop + shift;
  const targets = [signal.target1+shift,signal.target2+shift,signal.target3+shift];
  const risk = dir === 1 ? entry-stop : stop-entry;
  if (!(risk>0) || !finite(entry,stop,...targets)) return null;
  return { side, entry, stop, targets, risk, openedAt:new Date(nextBar.time).toISOString(),
    entryTime:nextBar.time, remaining:1, netR:0, targetHits:[], barsHeld:0, signalTime:signal.candleTime };
}
function closeR(trade, rawPrice, fraction, reason, time) {
  const dir = trade.side === "LONG" ? 1 : -1;
  const fill = rawPrice * (1-dir*SLIPPAGE);
  const feeR = FEE * (trade.entry+fill) / trade.risk;
  trade.netR += fraction * (dir*(fill-trade.entry)/trade.risk-feeR);
  trade.remaining = Math.max(0,trade.remaining-fraction);
  if (trade.remaining < 1e-8) {
    trade.remaining=0;
    trade.closedAt=new Date(time).toISOString();
    trade.exitReason=reason;
  }
}
function updateTrade(trade, bar) {
  const dir = trade.side === "LONG" ? 1 : -1;
  const stopHit = dir===1 ? bar.low<=trade.stop : bar.high>=trade.stop;
  if (stopHit) { closeR(trade,trade.stop,trade.remaining,"STOP",bar.time); return; }
  const weights=[.4,.35,.25];
  for(let i=0;i<3 && trade.remaining>1e-8;i++) {
    if(trade.targetHits.includes(i)) continue;
    const hit=dir===1?bar.high>=trade.targets[i]:bar.low<=trade.targets[i];
    if(hit) { const fraction=Math.min(weights[i],trade.remaining); closeR(trade,trade.targets[i],fraction,"TARGET_"+(i+1),bar.time); trade.targetHits.push(i); }
  }
  trade.barsHeld++;
  if(trade.remaining>1e-8 && trade.barsHeld>=MAX_HOLD_15M) closeR(trade,bar.close,trade.remaining,"TIME_EXIT",bar.time);
}
function stats(trades) {
  const wins=trades.filter(t=>t.netR>0), losses=trades.filter(t=>t.netR<0);
  const grossWin=wins.reduce((s,t)=>s+t.netR,0), grossLoss=Math.abs(losses.reduce((s,t)=>s+t.netR,0));
  let equity=0,peak=0,dd=0;
  for(const t of trades){equity+=t.netR;peak=Math.max(peak,equity);dd=Math.max(dd,peak-equity);}
  return {trades:trades.length,wins:wins.length,winRatePct:trades.length?100*wins.length/trades.length:0,
    netR:trades.reduce((s,t)=>s+t.netR,0),expectancyR:trades.length?trades.reduce((s,t)=>s+t.netR,0)/trades.length:0,
    profitFactor:grossLoss?grossWin/grossLoss:grossWin?null:0,maxDrawdownR:dd};
}
async function cycle() {
  const [h1raw,h4raw,m15raw]=await Promise.all([fetchCandles("1h"),fetchCandles("4h"),fetchCandles("15m")]);
  const now=Date.now();
  const h1=h1raw.filter(c=>c.closeTime<now), h4=h4raw.filter(c=>c.closeTime<now), m15=m15raw.filter(c=>c.closeTime<now);
  const forming=m15raw.find(c=>c.time===m15raw.at(-1)?.time && c.closeTime>=now);
  if(h1.length<130||h4.length<60||m15.length<40) throw new Error("Insufficient closed candles for 4H/1H/15M analysis.");
  const state=await loadState();
  const latest1h=h1.at(-1), idx=h1.length-1;
  // First launch only establishes a clean live checkpoint; never backfill signals.
  if (!state.last15mTime) {
    state.last15mTime=m15.at(-1).time;
    state.last1hTime=latest1h.time;
    await saveState(state);
    console.log(JSON.stringify({ok:true,mode:"INITIALIZED — waiting for the next closed 1H/15M candles",symbol:SYMBOL,checkpoint15m:state.last15mTime,checkpoint1h:state.last1hTime},null,2));
    return;
  }
  let signal=null;
  if(latest1h.time>state.last1hTime) {
    const change=(latest1h.close/h1[Math.max(0,idx-24)].close-1)*100;
    const ticker={symbol:SYMBOL,last:latest1h.close,quoteVolume:0,priceChangePercent:change,premium:{lastFundingRate:null}};
    const candidate=analyzeFuturesSymbol(ticker,h1,h4);
    if(candidate?.eligible) signal=candidate;
    state.last1hTime=latest1h.time;
    for(const v of VARIANTS) {
      const slot=state.variants[v.id];
      slot.pending=signal && filterPasses(v,signal,h1,idx)
        ? { ...signal, createdAt:latest1h.closeTime, expiresAt:latest1h.closeTime+MAX_PENDING_15M*15*60000, variant:v.id }
        : null;
    }
  }
  const newBars=m15.filter(c=>c.time>state.last15mTime);
  for(const bar of newBars) {
    const barIndex=m15.findIndex(x=>x.time===bar.time);
    for(const v of VARIANTS) {
      const slot=state.variants[v.id];
      if(slot.open && bar.time>slot.open.entryTime) {
        updateTrade(slot.open,bar);
        if(slot.open.remaining<=1e-8) { slot.trades.push(slot.open); slot.open=null; }
      }
      if(!slot.open && slot.pending && bar.closeTime>=slot.pending.createdAt) {
        if(bar.closeTime>slot.pending.expiresAt) slot.pending=null;
        else if(confirm15m(slot.pending.side,bar,m15.slice(Math.max(0,barIndex-40),barIndex+1))) {
          const nextBar=m15raw.find(x=>x.time===bar.time+15*60000) || (forming?.time===bar.time+15*60000?forming:null);
          if(nextBar) {
            slot.open=startTrade(slot.pending.side,slot.pending,bar,nextBar);
            slot.pending=null;
          }
        }
      }
    }
    state.last15mTime=bar.time;
  }
  await saveState(state);
  const report={at:new Date().toISOString(),symbol:SYMBOL,exchange:"Binance USD-M public market data",mode:"PAPER ONLY — no order endpoints or credentials",
    architecture:"A-C: existing analyzer + 15M EMA/candle confirmation. D: pure PA — 4H HH/HL or LH/LL, 1H BOS, 15M liquidity sweep/reclaim + close through prior bar; entry next 15M open.",
    costs:{feePerSidePct:FEE*100,slippagePerSidePct:SLIPPAGE*100,funding:"not included"},
    latestClosed:{h4:h4.at(-1).time,h1:latest1h.time,m15:m15.at(-1).time},
    variants:Object.fromEntries(VARIANTS.map(v=>{const s=state.variants[v.id];return[v.id,{label:v.label,...stats(s.trades),open:Boolean(s.open),pending:Boolean(s.pending),openTrade:s.open?{side:s.open.side,entry:s.open.entry,stop:s.open.stop,targets:s.open.targets,openedAt:s.open.openedAt}:null}]}))};
  console.log(JSON.stringify(report,null,2));
}
if (process.argv.includes("--watch")) {
  for (;;) { try { await cycle(); } catch(e) { console.error("Paper cycle failed:",e.message); } await sleep(15*60*1000); }
} else {
  await cycle();
}

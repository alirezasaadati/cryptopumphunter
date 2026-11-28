import { mkdir, writeFile } from "node:fs/promises";

const BASE = "https://fapi.binance.com";
const SYMBOL = "BTCUSDT";
const INTERVAL = "1m";
const DAYS = 30;
const INITIAL_EQUITY = 10000;
const POSITION_PCT = 0.10;
const EMA_LEN = 20;
const PIVOT_LEN = 10;
const VOL_MULT = 1.5;
const RR = 2.0;
const SL_BUFFER = 0.001;
const MINUTE = 60_000;

async function getJson(url) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(30000) });
    const body = await res.text();
    if (res.ok) return JSON.parse(body);
    if (![429, 500, 502, 503, 504].includes(res.status) || attempt === 4) {
      throw new Error("Binance API HTTP " + res.status + ": " + body.slice(0, 300));
    }
    await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
  }
}

async function loadCandles() {
  const end = Date.now();
  const start = end - DAYS * 86400_000;
  const warmupStart = start - 300 * MINUTE;
  const rows = [];
  let cursor = warmupStart;
  while (cursor < end) {
    const url = new URL(BASE + "/fapi/v1/klines");
    url.searchParams.set("symbol", SYMBOL);
    url.searchParams.set("interval", INTERVAL);
    url.searchParams.set("startTime", String(cursor));
    url.searchParams.set("endTime", String(end));
    url.searchParams.set("limit", "1500");
    const batch = await getJson(url);
    if (!Array.isArray(batch)) throw new Error("Unexpected Binance klines response: " + JSON.stringify(batch).slice(0, 300));
    if (!batch.length) break;
    rows.push(...batch);
    const lastOpen = Number(batch[batch.length - 1][0]);
    cursor = lastOpen + MINUTE;
    if (batch.length < 1500) break;
  }
  const unique = new Map();
  for (const r of rows) {
    const c = { time: Number(r[0]), open: +r[1], high: +r[2], low: +r[3], close: +r[4], volume: +r[5], closeTime: Number(r[6]) };
    if (c.time + MINUTE <= end && [c.open,c.high,c.low,c.close,c.volume].every(Number.isFinite)) unique.set(c.time, c);
  }
  return { candles: [...unique.values()].sort((a,b)=>a.time-b.time), start, end, warmupStart };
}

function buildIndicators(c) {
  const ema = Array(c.length).fill(null);
  const avgVol = Array(c.length).fill(null);
  let e = null, volSum = 0;
  for (let i=0;i<c.length;i++) {
    e = e === null ? c[i].close : (2/(EMA_LEN+1))*c[i].close + (1-2/(EMA_LEN+1))*e;
    ema[i] = e;
    volSum += c[i].volume;
    if (i >= 20) volSum -= c[i-20].volume;
    if (i >= 19) avgVol[i] = volSum / 20;
  }
  return { ema, avgVol };
}

function confirmedPivot(c, idx, kind) {
  const candidate = c[idx];
  const left = c.slice(idx-PIVOT_LEN, idx);
  const right = c.slice(idx+1, idx+PIVOT_LEN+1);
  if (left.length !== PIVOT_LEN || right.length !== PIVOT_LEN) return null;
  if (kind === "high") {
    const max = Math.max(...left.map(x=>x.high), ...right.map(x=>x.high));
    return candidate.high > max ? candidate.high : null;
  }
  const min = Math.min(...left.map(x=>x.low), ...right.map(x=>x.low));
  return candidate.low < min ? candidate.low : null;
}

function candlePath(c) {
  // TradingView broker-emulator OHLC path: O-H-L-C when open is nearer high, else O-L-H-C.
  return Math.abs(c.open-c.high) < Math.abs(c.open-c.low)
    ? [c.open,c.high,c.low,c.close]
    : [c.open,c.low,c.high,c.close];
}

function resolveExit(pos, c) {
  const path = candlePath(c);
  const stop = pos.stop, target = pos.target;
  if (pos.side === "LONG") {
    if (c.open <= stop) return { price:c.open, reason:"STOP_GAP" };
    if (c.open >= target) return { price:c.open, reason:"TARGET_GAP" };
    for (let k=1;k<path.length;k++) {
      const a=path[k-1], b=path[k];
      if (b < a) {
        if (stop >= b && stop <= a) return {price:stop,reason:"STOP"};
      } else if (b > a) {
        if (target >= a && target <= b) return {price:target,reason:"TARGET"};
      }
    }
  } else {
    if (c.open >= stop) return { price:c.open, reason:"STOP_GAP" };
    if (c.open <= target) return { price:c.open, reason:"TARGET_GAP" };
    for (let k=1;k<path.length;k++) {
      const a=path[k-1], b=path[k];
      if (b > a) {
        if (stop >= a && stop <= b) return {price:stop,reason:"STOP"};
      } else if (b < a) {
        if (target <= a && target >= b) return {price:target,reason:"TARGET"};
      }
    }
  }
  return null;
}

function summarize(trades, initialEquity) {
  const wins=trades.filter(t=>t.pnl>0), losses=trades.filter(t=>t.pnl<0);
  const grossWin=wins.reduce((s,t)=>s+t.pnl,0), grossLoss=Math.abs(losses.reduce((s,t)=>s+t.pnl,0));
  let eq=initialEquity, peak=initialEquity, maxDD=0;
  for (const t of trades) { eq+=t.pnl; peak=Math.max(peak,eq); maxDD=Math.max(maxDD,peak-eq); }
  return {
    trades:trades.length, wins:wins.length, losses:losses.length,
    winRatePct:trades.length?100*wins.length/trades.length:0,
    grossProfitUSD:grossWin, grossLossUSD:grossLoss,
    profitFactor:grossLoss?grossWin/grossLoss:(grossWin?null:0),
    netPnLUSD:trades.reduce((s,t)=>s+t.pnl,0),
    returnPct:100*(eq-initialEquity)/initialEquity,
    endingEquityUSD:eq, maxDrawdownUSD:maxDD,
    maxDrawdownPct:peak?100*maxDD/peak:0,
    expectancyUSD:trades.length?trades.reduce((s,t)=>s+t.pnl,0)/trades.length:0,
    averageR:trades.length?trades.reduce((s,t)=>s+t.rMultiple,0)/trades.length:0
  };
}

function runBacktest(c, dataStart) {
  const {ema,avgVol}=buildIndicators(c);
  let support=null, resistance=null, equity=INITIAL_EQUITY, pending=null, position=null;
  const trades=[];
  const testStart=dataStart;
  for (let i=0;i<c.length;i++) {
    const bar=c[i];
    const wasInPosition=!!position || !!pending;

    if (pending && i===pending.entryIndex) {
      const fill=bar.open;
      const qty=(equity*POSITION_PCT)/fill;
      position={...pending,entry:fill,qty,entryTime:bar.time,entryEquity:equity};
      pending=null;
    }

    if (position) {
      const exit=resolveExit(position,bar);
      if (exit) {
        const pnl=position.side==="LONG"?(exit.price-position.entry)*position.qty:(position.entry-exit.price)*position.qty;
        const riskPerUnit=Math.abs(position.signalClose-position.stop);
        const riskUSD=riskPerUnit*position.qty;
        equity+=pnl;
        trades.push({
          side:position.side, signalTime:position.signalTime, entryTime:position.entryTime,
          exitTime:bar.time, signalClose:position.signalClose, entry:position.entry,
          stop:position.stop,target:position.target,exit:exit.price,exitReason:exit.reason,
          qty:position.qty,notionalUSD:position.entry*position.qty,pnl,
          rMultiple:riskUSD?pnl/riskUSD:0,equityAfter:equity
        });
        position=null;
      }
    }

    // Pine pivots become available only after the right-side confirmation bars have closed.
    if (i>=2*PIVOT_LEN) {
      const pivotIndex=i-PIVOT_LEN;
      const ph=confirmedPivot(c,pivotIndex,"high");
      const pl=confirmedPivot(c,pivotIndex,"low");
      if (ph!==null) resistance=ph;
      if (pl!==null) support=pl;
    }

    if (bar.time < testStart || i===c.length-1 || wasInPosition || position || pending) continue;
    if (ema[i]===null || avgVol[i]===null || support===null || resistance===null) continue;
    const range=bar.high-bar.low;
    if (!(range>0)) continue;
    const highVolume=bar.volume>avgVol[i]*VOL_MULT;
    const bullish=bar.close>bar.open && bar.close>ema[i] && (bar.close-bar.open)>range*0.6;
    const bearish=bar.close<bar.open && bar.close<ema[i] && (bar.open-bar.close)>range*0.6;
    const nearSupport=bar.low<=support*1.001 && bar.close>support;
    const nearResistance=bar.high>=resistance*0.999 && bar.close<resistance;
    const longSignal=nearSupport && bar.close>ema[i] && bullish && highVolume;
    const shortSignal=nearResistance && bar.close<ema[i] && bearish && highVolume;
    if (longSignal) {
      const stop=support*(1-SL_BUFFER), risk=bar.close-stop;
      if (risk>0) pending={side:"LONG",signalTime:bar.time,signalClose:bar.close,stop,target:bar.close+risk*RR,entryIndex:i+1};
    } else if (shortSignal) {
      const stop=resistance*(1+SL_BUFFER), risk=stop-bar.close;
      if (risk>0) pending={side:"SHORT",signalTime:bar.time,signalClose:bar.close,stop,target:bar.close-risk*RR,entryIndex:i+1};
    }
  }
  return trades;
}

async function main() {
  const loaded=await loadCandles();
  const {candles,start,end,warmupStart}=loaded;
  if (candles.length<30_000) throw new Error("Insufficient 1m history: received "+candles.length+" candles");
  const trades=runBacktest(candles,start);
  const long=trades.filter(t=>t.side==="LONG"), short=trades.filter(t=>t.side==="SHORT");
  const report={
    generatedAt:new Date().toISOString(),venue:"Binance USDⓈ-M Futures public klines",
    market:SYMBOL,interval:"1m",period:{from:new Date(start).toISOString(),to:new Date(end).toISOString(),days:DAYS},
    data:{candles: candles.length,first:new Date(candles[0].time).toISOString(),last:new Date(candles[candles.length-1].time).toISOString(),warmupCandles:candles.filter(x=>x.time<start).length},
    strategy:{emaLength:EMA_LEN,pivotLength:PIVOT_LEN,volumeMultiplier:VOL_MULT,rrRatio:RR,stopBufferPct:SL_BUFFER*100,positionSizePct:POSITION_PCT*100,initialCapitalUSD:INITIAL_EQUITY,feesPct:0,slippagePct:0},
    execution:"Pine default market-entry timing: signal at candle close, entry at next candle open. SL/TP are calculated from signal close. OHLC path follows TradingView broker-emulator nearest-extreme assumption. No commission, slippage, or funding because the supplied Pine strategy specifies none.",
    combined:summarize(trades,INITIAL_EQUITY),long:summarize(long,INITIAL_EQUITY),short:summarize(short,INITIAL_EQUITY),
    trades
  };
  await mkdir("artifacts",{recursive:true});
  await writeFile("artifacts/pine-btcusdt-1m-30d.json",JSON.stringify(report,null,2));
  const md=[
    "# Pine Script BTCUSDT 1m — 30-day backtest","",
    "Period: "+report.period.from+" to "+report.period.to,
    "Candles: "+candles.length+" (including warm-up)",
    "Venue: Binance USDⓈ-M Futures",
    "Execution: next-bar open; SL/TP levels derived from signal close; no fees/slippage/funding.",
    "",
    "| Metric | Combined | LONG | SHORT |",
    "|---|---:|---:|---:|",
    ...["trades","winRatePct","profitFactor","netPnLUSD","returnPct","maxDrawdownUSD","maxDrawdownPct","expectancyUSD","averageR"].map(k=>"| "+k+" | "+[report.combined,report.long,report.short].map(x=>typeof x[k]==="number"?x[k].toFixed(4):x[k]).join(" | ")+" |"),
    "",
    "This report tests the supplied Pine rules as written. It is a historical simulation, not a guarantee of future results."
  ];
  await writeFile("artifacts/pine-btcusdt-1m-30d.md",md.join("\n"));
  console.log(JSON.stringify({ok:true,market:report.market,interval:report.interval,period:report.period,data:report.data,combined:report.combined,long:report.long,short:report.short},null,2));
}
main().catch(err=>{console.error(err);process.exitCode=1;});

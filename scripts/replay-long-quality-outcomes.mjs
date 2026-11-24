import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { analyzeFuturesSymbol } from "../src/index.js";

const DATA = "data/historical-kraken";
const cases = [
  { id:"ADA_WIN_20261123_1730_IR", symbol:"PF_ADAUSD", time:"2026-11-23T14:00:00Z", entry:0.1514, outcome:"WIN", reportedRoi:29.21 },
  { id:"PUMP_WIN_20261122_2030_IR", symbol:"PF_PUMPUSD", time:"2026-11-22T17:00:00Z", entry:0.002563, outcome:"WIN", reportedRoi:41.89 },
  { id:"NEAR_WIN_20261123_1730_IR", symbol:"PF_NEARUSD", time:"2026-11-23T14:00:00Z", entry:3.123, outcome:"WIN", reportedRoi:28.73 },
  { id:"ZEC_WIN_20261123_1730_IR", symbol:"PF_ZECUSD", time:"2026-11-23T14:00:00Z", entry:838.09, outcome:"WIN", reportedRoi:12.76 },
  { id:"ZEC_STOP_20261123_2230_IR", symbol:"PF_ZECUSD", time:"2026-11-23T19:00:00Z", entry:815.82, stop:780.59035714, outcome:"STOP" },
  { id:"INJ_STOP_20261123_0930_IR", symbol:"PF_INJUSD", time:"2026-11-23T06:00:00Z", entry:6.636, stop:6.349, outcome:"STOP", score:60 },
  { id:"SOL_STOP_20261123_2100_IR", symbol:"PF_SOLUSD", time:"2026-11-23T17:30:00Z", entry:73.90, stop:71.75, outcome:"STOP", score:60 },
  { id:"NEAR_STOP_20261123_1825_IR", symbol:"PF_NEARUSD", time:"2026-11-23T14:55:00Z", entry:3.1721, stop:2.9665, outcome:"STOP", score:57 },
  { id:"ETH_STOP_20261123_1730_IR", symbol:"PF_ETHUSD", time:"2026-11-23T14:00:00Z", entry:1807.30, stop:1711.60, outcome:"STOP", score:57 }
];

const profiles = [
  { name:"baseline", config:null },
  { name:"four-hour-stronger", config:{ name:"four-hour-stronger", additionalFourHourOppositionPenalty:4 } },
  { name:"15m-momentum", config:{ name:"15m-momentum", noMomentumPenalty:6, noMomentumNoPullbackPenalty:10, unavailable15mPenalty:3 } },
  { name:"combined", config:{ name:"combined", additionalFourHourOppositionPenalty:4, noMomentumPenalty:6, noMomentumNoPullbackPenalty:10, unavailable15mPenalty:3 } }
];
const intervalMs = { "15m":900000, "1h":3600000, "4h":14400000 };

async function load(symbol, interval) {
  return JSON.parse(await readFile(join(DATA, `${symbol}-${interval}.json`), "utf8")).candles;
}
function closedBefore(rows, interval, timeMs) {
  return rows.filter(c => c.time + intervalMs[interval] <= timeMs);
}
function outcomePath(rows, timeMs) {
  return rows.filter(c => c.time >= timeMs && c.time < timeMs + 24*3600000);
}
function firstIndex(rows, predicate) {
  const index = rows.findIndex(predicate);
  return index < 0 ? null : index;
}
function pct(value, base) { return (value/base - 1)*100; }
function utc(ms) { return ms == null ? null : new Date(ms).toISOString(); }

const report = {
  source:"Kraken Futures trade candles downloaded by GitHub Actions",
  method:"Exact engine replay on candles closed before each recorded entry; ticker quote volume and 24h change are reconstructed from 1h candles; historical funding is unavailable. Outcome path uses 15m trade candles after the entry timestamp.",
  targetPriceMovePct:[2,3],
  trades:[]
};

for (const trade of cases) {
  const t = Date.parse(trade.time);
  const [all15,all1h,all4h] = await Promise.all([
    load(trade.symbol,"15m"), load(trade.symbol,"1h"), load(trade.symbol,"4h")
  ]);
  const c15 = closedBefore(all15,"15m",t);
  const c1h = closedBefore(all1h,"1h",t);
  const c4h = closedBefore(all4h,"4h",t);
  const after = outcomePath(all15,t);
  const last1h = c1h.at(-1);
  const prev24 = c1h.at(-25);
  const quoteVolume = c1h.slice(-24).reduce((sum,c)=>sum+c.volume*c.close,0);
  const change24h = prev24 && last1h ? (last1h.close/prev24.close-1)*100 : 0;
  const ticker = {
    symbol:trade.symbol,
    last:last1h?.close,
    quoteVolume,
    priceChangePercent:change24h,
    premium:{}
  };
  const engine = {};
  for (const p of profiles) {
    try {
      const result = analyzeFuturesSymbol(ticker,c1h,c4h,c15,p.config ? {longQualityProfile:p.config} : {});
      engine[p.name] = {
        side:result.side || null,
        eligible:result.eligible === true,
        riskLevel:result.riskLevel || null,
        score:result.score ?? null,
        baseScore:result.baseScore ?? null,
        priorityScore:result.priorityScore ?? null,
        rejected:result.rejected || null,
        fourHourTrend:result.fourHourTrend || null,
        fourHourOpposes:result.fourHourOpposes ?? result.entryDiagnostics?.fourHourOpposes ?? null,
        momentumConfirmed:result.entryDiagnostics?.momentumConfirmed ?? null,
        pullbackConfirmed:result.entryDiagnostics?.pullbackConfirmed ?? null,
        longQualityPenalty:result.longQualityPenalty ?? 0,
        scoreBeforeLongQualityPenalty:result.scoreBeforeLongQualityPenalty ?? null
      };
    } catch (error) {
      engine[p.name] = { error:String(error?.message || error) };
    }
  }

  const target2 = trade.entry*1.02;
  const target3 = trade.entry*1.03;
  const i2 = firstIndex(after,c=>c.high>=target2);
  const i3 = firstIndex(after,c=>c.high>=target3);
  const is = trade.stop == null ? null : firstIndex(after,c=>c.low<=trade.stop);
  const maxHigh = after.length ? Math.max(...after.map(c=>c.high)) : null;
  const minLow = after.length ? Math.min(...after.map(c=>c.low)) : null;
  const tradePath = is == null ? after : after.slice(0,is+1);
  const maxHighUntilExit = tradePath.length ? Math.max(...tradePath.map(c=>c.high)) : null;
  const minLowUntilExit = tradePath.length ? Math.min(...tradePath.map(c=>c.low)) : null;
  const exactEntryBar = all15.find(c=>c.time===t) || all15.filter(c=>c.time<t).at(-1) || null;
  const priceVsBarOpenPct = exactEntryBar ? pct(trade.entry,exactEntryBar.open) : null;
  const first2 = i2 == null ? null : after[i2];
  const first3 = i3 == null ? null : after[i3];
  const stopBar = is == null ? null : after[is];
  const stopBefore2 = is != null && (i2 == null || is < i2);
  const stopBefore3 = is != null && (i3 == null || is < i3);
  const target2SameBarAsStop = is != null && i2 === is;
  const target3SameBarAsStop = is != null && i3 === is;
  report.trades.push({
    ...trade,
    entryTimeUtc:trade.time,
    candlesAvailable:{ "15m":c15.length, "1h":c1h.length, "4h":c4h.length, future15m:after.length },
    reconstructedTicker:{ last:last1h?.close ?? null, quoteVolume24h:Math.round(quoteVolume), change24hPct:Number(change24h.toFixed(3)), funding:"unavailable historically" },
    engine,
    pricePath24h:{
      coverageHours:Number((after.length*0.25).toFixed(2)),
      mfePct:maxHigh==null?null:Number(pct(maxHigh,trade.entry).toFixed(3)),
      maePct:minLow==null?null:Number(pct(minLow,trade.entry).toFixed(3)),
      mfeUntilStopPct:maxHighUntilExit==null?null:Number(pct(maxHighUntilExit,trade.entry).toFixed(3)),
      maeUntilStopPct:minLowUntilExit==null?null:Number(pct(minLowUntilExit,trade.entry).toFixed(3)),
      barsUntilStop:is==null?null:is+1,
      first2PctTargetUtc:first2?utc(first2.time):null,
      first3PctTargetUtc:first3?utc(first3.time):null,
      stopTouchUtc:stopBar?utc(stopBar.time):null,
      stopBefore2Pct:stopBefore2,
      stopBefore3Pct:stopBefore3,
      target2SameBarAsStop,
      target3SameBarAsStop,
      entryPriceVsKraken15mBarOpenPct:priceVsBarOpenPct==null?null:Number(priceVsBarOpenPct.toFixed(3))
    }
  });
}

await writeFile(join(DATA,"long-quality-replay-report.json"),JSON.stringify(report,null,2));
const summary = report.trades.map(t => ({
  id:t.id, outcome:t.outcome,
  baseline:t.engine.baseline?.eligible ? t.engine.baseline.score : t.engine.baseline?.rejected || "not eligible",
  fourHour:t.engine["four-hour-stronger"]?.eligible ? t.engine["four-hour-stronger"].score : t.engine["four-hour-stronger"]?.rejected || "not eligible",
  momentum:t.engine["15m-momentum"]?.eligible ? t.engine["15m-momentum"].score : t.engine["15m-momentum"]?.rejected || "not eligible",
  combined:t.engine.combined?.eligible ? t.engine.combined.score : t.engine.combined?.rejected || "not eligible",
  mfe24h:t.pricePath24h.mfePct, first2:t.pricePath24h.first2PctTargetUtc,
  stop:t.pricePath24h.stopTouchUtc, stopBefore2:t.pricePath24h.stopBefore2Pct,
  priceGap:t.pricePath24h.entryPriceVsKraken15mBarOpenPct
}));
console.log(JSON.stringify(summary,null,2));

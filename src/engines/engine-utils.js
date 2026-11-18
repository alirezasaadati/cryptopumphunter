export const ENGINE_CONFIG = Object.freeze({
  INTERVAL: "15m",
  MIN_CANDLES: 80,
  MIN_QUOTE_VOLUME: 5_000_000,
  ENTRY2_OFFSET_PCT: 2.8,
  A_TARGETS_PCT: [1, 3, 6, 10, 14],
  MIN_SCORE: 60,
  MAX_SCORE: 98
});

const finite = value => Number.isFinite(Number(value));
export function validateCandles(candles, min = ENGINE_CONFIG.MIN_CANDLES) {
  if (!Array.isArray(candles) || candles.length < min) return false;
  let previous = -Infinity;
  for (const c of candles) {
    if (!c || ![c.time,c.open,c.high,c.low,c.close,c.volume].every(finite)) return false;
    if (!(c.time > previous && c.open > 0 && c.low > 0 && c.volume >= 0 &&
      c.high >= Math.max(c.open,c.close) && c.low <= Math.min(c.open,c.close))) return false;
    previous = c.time;
  }
  return true;
}
export function ema(values, period) {
  if (!Array.isArray(values) || values.length < period || period < 1) return null;
  const alpha = 2 / (period + 1);
  let result = values.slice(0, period).reduce((a,b)=>a+b,0) / period;
  for (const value of values.slice(period)) result = value * alpha + result * (1-alpha);
  return result;
}
export function rsi(values, period = 14) {
  if (!Array.isArray(values) || values.length <= period) return null;
  let gains = 0, losses = 0;
  for (let i=1;i<=period;i++) {
    const change=values[i]-values[i-1];
    if(change>0) gains+=change; else losses-=change;
  }
  let avgGain=gains/period, avgLoss=losses/period;
  for(let i=period+1;i<values.length;i++){
    const change=values[i]-values[i-1];
    avgGain=(avgGain*(period-1)+Math.max(0,change))/period;
    avgLoss=(avgLoss*(period-1)+Math.max(0,-change))/period;
  }
  if(avgLoss===0) return 100;
  return 100-(100/(1+avgGain/avgLoss));
}
export function atr(candles, period = 14) {
  if (!Array.isArray(candles) || candles.length <= period) return null;
  const trs=[];
  for(let i=1;i<candles.length;i++){
    const c=candles[i], prev=candles[i-1];
    trs.push(Math.max(c.high-c.low,Math.abs(c.high-prev.close),Math.abs(c.low-prev.close)));
  }
  return trs.slice(-period).reduce((a,b)=>a+b,0)/period;
}
export function volumeRatio(candles, period = 20) {
  if (!Array.isArray(candles) || candles.length <= period) return null;
  const sample=candles.slice(-(period+1),-1);
  const avg=sample.reduce((s,c)=>s+c.volume,0)/sample.length;
  return avg>0 ? candles.at(-1).volume/avg : null;
}
export function swings(candles, lookback = 20) {
  const sample=candles.slice(-lookback-1,-1);
  return {
    high: sample.length ? Math.max(...sample.map(c=>c.high)) : null,
    low: sample.length ? Math.min(...sample.map(c=>c.low)) : null
  };
}
export function scoreSignal({trend,momentum,volume,entry,context}) {
  const points = [
    [trend,25],[momentum,20],[volume,20],[entry,20],[context,15]
  ];
  return Math.min(ENGINE_CONFIG.MAX_SCORE, points.reduce((sum,[ok,weight])=>sum+(ok?weight:0),0));
}
export function roundPrice(value) {
  return Number.isFinite(value) ? Number(value.toPrecision(8)) : null;
}
export function makeSignalBase({engine,symbol,side,entry,stop,score,reason,candleTime,context={}}) {
  const risk=side==="LONG" ? entry-stop : stop-entry;
  if (!(entry>0 && risk>0 && Number.isFinite(risk))) return null;
  return {engine,symbol,side,entry:roundPrice(entry),stop:roundPrice(stop),riskPct:risk/entry*100,
    score,reason,candleTime,context,timeframe:"15m",status:"experimental"};
}

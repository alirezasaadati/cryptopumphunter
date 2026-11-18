import fs from "node:fs/promises";

const BASE = "https://futures.kraken.com/api/charts/v1";
const CANDIDATES = [
  "PI_XBTUSD", "PF_XBTUSD", "PF_ETHUSD", "PF_SOLUSD", "PF_XRPUSD",
  "PF_DOGEUSD", "PF_ADAUSD", "PF_LINKUSD", "PF_AVAXUSD", "PF_DOTUSD"
];
const INTERVAL_SECONDS = 900;
const DAY = 86400;
const end = Math.floor(Date.now() / 1000);
const start = end - 90 * DAY;
const report = {
  generatedAt: new Date().toISOString(),
  source: "Kraken Futures public charts API",
  timeframe: "15m",
  requestedDays: 90,
  start: new Date(start * 1000).toISOString(),
  end: new Date(end * 1000).toISOString(),
  symbols: [],
  notes: [
    "This is a data-availability audit, not a strategy backtest.",
    "Current contract availability is not proof of historical universe completeness.",
    "Candle volume units differ by contract; quote-turnover estimates are not used as a liquidity pass until contract multipliers are verified."
  ]
};

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function getJson(url) {
  let lastError;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const response = await fetch(url, {headers: {"accept":"application/json"}});
      if (!response.ok) throw new Error("HTTP " + response.status);
      return await response.json();
    } catch (error) {
      lastError = error;
      await sleep(500 * (attempt + 1));
    }
  }
  throw lastError;
}

const tickersPayload = await getJson("https://futures.kraken.com/derivatives/api/v3/tickers");
const tickers = tickersPayload.tickers ?? [];
const listed = new Set(tickers.map(t => t.symbol).filter(Boolean));

for (const symbol of CANDIDATES) {
  const item = {symbol, listedNow: listed.has(symbol), candles: 0, missingIntervals: null,
    duplicateTimestamps: 0, invalidCandles: 0, firstCandle: null, lastCandle: null,
    complete90d: false, error: null};
  if (!item.listedNow) {
    item.error = "Candidate not present in current ticker universe";
    report.symbols.push(item);
    continue;
  }
  const byTime = new Map();
  try {
    for (let from = start; from < end; from += 7 * DAY) {
      const to = Math.min(end, from + 7 * DAY);
      const url = `${BASE}/trade/${symbol}/15m?from=${from}&to=${to}&count=1000`;
      const payload = await getJson(url);
      for (const c of (payload.candles ?? [])) {
        const time = Number(c.time);
        const candle = {time, open:Number(c.open), high:Number(c.high), low:Number(c.low),
          close:Number(c.close), volume:Number(c.volume)};
        if (byTime.has(time)) item.duplicateTimestamps++;
        byTime.set(time, candle);
      }
      await sleep(180);
    }
    const candles = [...byTime.values()].sort((a,b)=>a.time-b.time);
    item.candles = candles.length;
    item.firstCandle = candles.length ? new Date(candles[0].time).toISOString() : null;
    item.lastCandle = candles.length ? new Date(candles.at(-1).time).toISOString() : null;
    item.invalidCandles = candles.filter(c =>
      ![c.time,c.open,c.high,c.low,c.close,c.volume].every(Number.isFinite) ||
      c.open<=0 || c.low<=0 || c.volume<0 ||
      c.high<Math.max(c.open,c.close) || c.low>Math.min(c.open,c.close)
    ).length;
    let missing = 0;
    for (let i=1;i<candles.length;i++) {
      const delta = (candles[i].time-candles[i-1].time)/1000;
      if (delta > INTERVAL_SECONDS) missing += Math.max(0,Math.round(delta/INTERVAL_SECONDS)-1);
    }
    item.missingIntervals = missing;
    const expected = Math.floor((end-start)/INTERVAL_SECONDS);
    item.complete90d = candles.length >= expected * 0.98 && item.invalidCandles===0;
    item.expectedCandlesApprox = expected;
    item.coveragePct = Number((candles.length/expected*100).toFixed(2));
  } catch (error) {
    item.error = String(error?.message ?? error);
  }
  report.symbols.push(item);
}

report.summary = {
  candidates: CANDIDATES.length,
  listedNow: report.symbols.filter(s=>s.listedNow).length,
  withErrors: report.symbols.filter(s=>s.error).length,
  passingCoverage: report.symbols.filter(s=>s.complete90d).length,
  totalCandles: report.symbols.reduce((n,s)=>n+s.candles,0)
};
await fs.mkdir("artifacts", {recursive:true});
await fs.writeFile("artifacts/kraken-15m-data-audit.json", JSON.stringify(report,null,2));
console.log(JSON.stringify(report.summary,null,2));
for (const s of report.symbols) console.log([
  s.symbol, s.listedNow ? "listed" : "not-listed", s.candles,
  s.coveragePct ?? "—", s.missingIntervals ?? "—", s.invalidCandles,
  s.error ?? ""
].join("\t"));
if (report.summary.passingCoverage === 0) process.exitCode = 1;

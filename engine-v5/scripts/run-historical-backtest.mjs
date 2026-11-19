import { writeFile } from "node:fs/promises";
import { fetchBinanceKlines } from "../src/backtest/binance-history.js";
import { runHistoricalComparison } from "../src/backtest/replay.js";

const days = Number(process.env.BACKTEST_DAYS || 90);
const symbols = (process.env.BACKTEST_SYMBOLS || "BTCUSDT,ETHUSDT,SOLUSDT").split(",").map(x=>x.trim().toUpperCase()).filter(Boolean);
const endTime = Date.now();
const dataset = {};
for (const symbol of symbols) {
  console.log(`Downloading ${days} days of 5m candles for ${symbol}...`);
  dataset[symbol] = await fetchBinanceKlines({ symbol, interval:"5m", days, endTime, onPage: p=>console.log(`  ${p.rows} candles fetched`) });
  console.log(`  complete: ${dataset[symbol].length} candles`);
  if (dataset[symbol].length < 5000) throw new Error(`Insufficient historical candles for ${symbol}`);
}
const report = runHistoricalComparison(dataset);
const file = "historical-backtest-report.json";
await writeFile(file, JSON.stringify(report,null,2));
console.log("\nHISTORICAL BACKTEST SUMMARY");
console.log(JSON.stringify({ periodDays:days, symbols, candleCounts:Object.fromEntries(Object.entries(dataset).map(([k,v])=>[k,v.length])), models:report.models, assumptions:report.assumptions },null,2));
console.log(`Full trade-level report: ${file}`);

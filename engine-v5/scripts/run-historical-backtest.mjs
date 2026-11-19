import { writeFile } from "node:fs/promises";
import { fetchOkxKlines } from "../src/backtest/okx-history.js";
import { runHistoricalComparison } from "../src/backtest/replay.js";

const days = Number(process.env.BACKTEST_DAYS || 90);
const instruments = (process.env.BACKTEST_INSTRUMENTS || "BTC-USDT-SWAP,ETH-USDT-SWAP,SOL-USDT-SWAP").split(",").map(x=>x.trim().toUpperCase()).filter(Boolean);
const endTime = Date.now();
const dataset = {};
for (const instId of instruments) {
  console.log(`Downloading ${days} days of OKX 5m history for ${instId}...`);
  dataset[instId] = await fetchOkxKlines({ instId, bar:"5m", days, endTime, onPage:p=>console.log(`  ${p.rows} candles fetched; oldest page timestamp ${p.oldest}`) });
  console.log(`  complete: ${dataset[instId].length} completed candles`);
  if (dataset[instId].length < 5000) throw new Error(`Insufficient historical candles for ${instId}: ${dataset[instId].length}`);
}
const splitTime = endTime - Math.floor(days / 2) * 86400000;
const report = runHistoricalComparison(dataset, splitTime);
const file = "historical-backtest-report.json";
await writeFile(file, JSON.stringify(report,null,2));
console.log("\nHISTORICAL BACKTEST SUMMARY");
console.log(JSON.stringify({
  source:"OKX public historical candles", periodDays:days, instruments,
  candleCounts:Object.fromEntries(Object.entries(dataset).map(([k,v])=>[k,v.length])),
  models:report.models, walkForward:report.walkForward, assumptions:report.assumptions
},null,2));
console.log(`Full trade-level report: ${file}`);

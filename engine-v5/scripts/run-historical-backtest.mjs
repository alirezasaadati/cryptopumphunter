import { writeFile } from "node:fs/promises";
import { fetchKrakenFuturesCandles } from "../src/backtest/kraken-history.js";
import { runHistoricalComparison } from "../src/backtest/replay.js";
const days=Number(process.env.BACKTEST_DAYS||90);
const instruments=(process.env.BACKTEST_INSTRUMENTS||"PF_XBTUSD,PF_ETHUSD,PF_SOLUSD").split(",").map(x=>x.trim().toUpperCase()).filter(Boolean);
const endTime=Date.now(),dataset={};
for(const symbol of instruments){
 console.log(`Downloading ${days} days of Kraken Futures 5m history for ${symbol}...`);
 dataset[symbol]=await fetchKrakenFuturesCandles({symbol,resolution:"5m",days,endTime});
 console.log(`  complete: ${dataset[symbol].length} candles`);
 if(dataset[symbol].length<5000)throw new Error(`Insufficient Kraken historical candles for ${symbol}: ${dataset[symbol].length}`);
}
const splitTime=endTime-Math.floor(days/2)*86400000;
const report=runHistoricalComparison(dataset,splitTime);
await writeFile("historical-backtest-report.json",JSON.stringify(report,null,2));
console.log(JSON.stringify({source:"Kraken Futures public Charts API (trade candles)",periodDays:days,instruments,candleCounts:Object.fromEntries(Object.entries(dataset).map(([k,v])=>[k,v.length])),models:report.models,walkForward:report.walkForward,assumptions:report.assumptions},null,2));
console.log("Full trade-level report: historical-backtest-report.json");

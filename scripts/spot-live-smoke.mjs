import { runSpotScan } from "../src/spot-engine.js";

const started = Date.now();
const result = await runSpotScan();
console.log("=== LIVE KRAKEN SPOT DATA SMOKE TEST ===");
console.log(result.report);
console.log("Eligible opportunities:", result.opportunities.length);
console.log("Elapsed seconds:", ((Date.now() - started) / 1000).toFixed(1));
if (/^❌/.test(result.report)) {
  console.error("Spot live-data smoke test failed.");
  process.exitCode = 1;
}

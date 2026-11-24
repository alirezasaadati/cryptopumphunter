import { writeFile } from "node:fs/promises";
import { runFuturesEntryDiagnostics } from "../src/index.js";

const report = await runFuturesEntryDiagnostics({}, { directMarketData: true });
const output = JSON.stringify(report, null, 2);
await writeFile("/tmp/futures-entry-diagnostics.json", output);
console.log(output);

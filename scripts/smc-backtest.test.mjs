import test from "node:test";
import { execFileSync } from "node:child_process";

test("BTCUSDT one-year SMC backtest (technical layer; historical news excluded)", {
  timeout: 80 * 60 * 1000
}, () => {
  execFileSync(process.execPath, ["scripts/smc-backtest.mjs"], {
    stdio: "inherit",
    timeout: 75 * 60 * 1000,
    env: { ...process.env, NODE_OPTIONS: "--max-old-space-size=4096" }
  });
});

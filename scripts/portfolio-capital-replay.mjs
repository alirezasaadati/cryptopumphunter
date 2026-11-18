import fs from "node:fs/promises";
import { replayPortfolio } from "../src/engines/portfolio-replay.js";
const inputPath=process.env.PORTFOLIO_INPUT??"artifacts/dual-engine-backtest.json";
const outputPath=process.env.PORTFOLIO_OUTPUT??"artifacts/portfolio-capital-replay.json";
const engineName=process.env.PORTFOLIO_ENGINE??"B_SHORT_ONLY";
const report=JSON.parse(await fs.readFile(inputPath,"utf8"));
const engine=report.engines?.[engineName];
if(!engine||!Array.isArray(engine.trades)) throw new Error(`Missing trades for engine ${engineName}`);
const baseConfig={
 initialCapitalUsd:Number(process.env.PORTFOLIO_INITIAL_CAPITAL_USD??10),
 leverage:Number(process.env.PORTFOLIO_LEVERAGE??10),
 maxConcurrentTrades:Number(process.env.PORTFOLIO_MAX_CONCURRENT??2),
 sourceEntryNotionalUsd:Number(report.methodology?.entryNotionalPerLegUsd??100)
};
const margins=(process.env.PORTFOLIO_MARGIN_SCENARIOS??"1,2,5").split(",").map(Number);
if(margins.some(x=>!Number.isFinite(x)||x<=0)) throw new Error("Invalid PORTFOLIO_MARGIN_SCENARIOS");
const splitAt=Date.parse(report.window?.splitAt);
if(!Number.isFinite(splitAt)) throw new Error("Missing valid walk-forward splitAt");
const developmentTrades=engine.trades.filter(t=>t.candleTime<splitAt&&t.status==="closed"&&Number.isFinite(t.closedAt)&&t.closedAt<splitAt);
const holdoutTrades=engine.trades.filter(t=>t.candleTime>=splitAt);
const scenarios=margins.map(margin=>{
 const config={...baseConfig,marginPerTradeUsd:margin};
 return {
  marginPerTradeUsd:margin,
  fullWindow:replayPortfolio(engine.trades,config),
  development:replayPortfolio(developmentTrades,config),
  holdout:replayPortfolio(holdoutTrades,config)
 };
});
const output={generatedAt:new Date().toISOString(),source:inputPath,sourceWindow:report.window,sourceEngine:engineName,sourceStructureMode:report.engineBStructureMode??null,sourceSummary:engine.summary,periodDefinition:"Development includes only closed trades opened and closed before splitAt. Holdout includes trades whose signal candleTime is at or after splitAt. Each period starts with a fresh initial capital balance.",baseConfig,scenarios};
await fs.mkdir("artifacts",{recursive:true}); await fs.writeFile(outputPath,JSON.stringify(output,null,2));
console.log(JSON.stringify({sourceEngine:engineName,sourceStructureMode:output.sourceStructureMode,baseConfig,scenarios:scenarios.map(s=>({marginPerTradeUsd:s.marginPerTradeUsd,full:{accepted:s.fullWindow.accepted,closed:s.fullWindow.closed,wins:s.fullWindow.wins,losses:s.fullWindow.losses,netPnlUsd:s.fullWindow.netPnlUsd,endingCashUsd:s.fullWindow.endingCashUsd,profitFactor:s.fullWindow.profitFactor,maxDrawdownUsd:s.fullWindow.maxDrawdownUsd},development:{accepted:s.development.accepted,netPnlUsd:s.development.netPnlUsd,profitFactor:s.development.profitFactor},holdout:{accepted:s.holdout.accepted,closed:s.holdout.closed,netPnlUsd:s.holdout.netPnlUsd,profitFactor:s.holdout.profitFactor,maxDrawdownUsd:s.holdout.maxDrawdownUsd}}))},null,2));

import fs from "node:fs/promises";
import { replayPortfolio } from "../src/engines/portfolio-replay.js";
const inputPath=process.env.PORTFOLIO_INPUT??"artifacts/dual-engine-backtest.json";
const outputPath=process.env.PORTFOLIO_OUTPUT??"artifacts/portfolio-capital-replay.json";
const engineName=process.env.PORTFOLIO_ENGINE??"B_SHORT_ONLY";
const report=JSON.parse(await fs.readFile(inputPath,"utf8"));
const engine=report.engines?.[engineName];
if(!engine||!Array.isArray(engine.trades)) throw new Error(`Missing trades for engine ${engineName}`);
const result=replayPortfolio(engine.trades,{
 initialCapitalUsd:Number(process.env.PORTFOLIO_INITIAL_CAPITAL_USD??10),
 marginPerTradeUsd:Number(process.env.PORTFOLIO_MARGIN_PER_TRADE_USD??5),
 leverage:Number(process.env.PORTFOLIO_LEVERAGE??10),
 maxConcurrentTrades:Number(process.env.PORTFOLIO_MAX_CONCURRENT??2),
 sourceEntryNotionalUsd:Number(report.methodology?.entryNotionalPerLegUsd??100)
});
const output={generatedAt:new Date().toISOString(),source:inputPath,sourceWindow:report.window,sourceEngine:engineName,sourceStructureMode:report.engineBStructureMode??null,sourceSummary:engine.summary,...result};
await fs.mkdir("artifacts",{recursive:true}); await fs.writeFile(outputPath,JSON.stringify(output,null,2));
console.log(JSON.stringify({sourceEngine:engineName,sourceStructureMode:output.sourceStructureMode,config:result.config,accepted:result.accepted,closed:result.closed,openAtEnd:result.openAtEnd,rejected:result.rejected,rejectionReasons:result.rejectionReasons,wins:result.wins,losses:result.losses,winRatePct:result.winRatePct,grossProfitUsd:result.grossProfitUsd,grossLossUsd:result.grossLossUsd,netPnlUsd:result.netPnlUsd,endingCashUsd:result.endingCashUsd,availableFreeMarginUsd:result.availableFreeMarginUsd,profitFactor:result.profitFactor,maxDrawdownUsd:result.maxDrawdownUsd,maxConcurrentObserved:result.maxConcurrentObserved,warnings:result.warnings},null,2));

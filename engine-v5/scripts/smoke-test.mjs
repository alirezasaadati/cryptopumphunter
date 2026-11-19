import { createExchangeAdapters } from "../src/exchanges/index.js";
const adapters=createExchangeAdapters(),startedAt=Date.now();
const results=await Promise.all(adapters.map(async adapter=>{const started=Date.now();try{const result=await adapter.fetchOverview();const instruments=(result.instruments||[]).filter(x=>x&&x.nativeSymbol&&x.exchange);const tickers=(result.tickers||[]).filter(x=>x&&x.nativeSymbol&&Number.isFinite(x.last)&&x.last>0);return {exchange:adapter.id,status:instruments.length&&tickers.length?"PASS":"WARN",instruments:instruments.length,tickers:tickers.length,elapsedMs:Date.now()-started};}catch(error){return {exchange:adapter.id,status:"FAIL",elapsedMs:Date.now()-started,error:String(error?.message||error).slice(0,240)};}}));
for(const r of results)console.log(JSON.stringify(r));
const passed=results.filter(x=>x.status==="PASS").length,failed=results.filter(x=>x.status==="FAIL").length;
console.log(JSON.stringify({summary:true,passed,failed,warnings:results.length-passed-failed,totalElapsedMs:Date.now()-startedAt}));
if(failed>0||passed===0)process.exitCode=1;

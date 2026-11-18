import {readFile,writeFile} from "node:fs/promises";

const input=JSON.parse(await readFile("artifacts/fibonacci-ichimoku-backtest.json","utf8"));
const START=Number(process.env.PORTFOLIO_START_USD||10);
const MARGIN=Number(process.env.PORTFOLIO_MARGIN_USD||1);
const LEV=Number(process.env.PORTFOLIO_LEVERAGE||10);
const MAX_OPEN=Number(process.env.PORTFOLIO_MAX_OPEN||2);
const NOTIONAL=MARGIN*LEV;

function replay(trades){
  const ordered=[...trades].sort((a,b)=>a.entryTime-b.entryTime||a.exitTime-b.exitTime);
  let cash=START,peak=START,maxDD=0,maxOpen=0,rejected=0;
  const active=[],closed=[];
  for(const t of ordered){
    for(let i=active.length-1;i>=0;i--){
      if(active[i].exitTime<=t.entryTime){
        const x=active.splice(i,1)[0];cash+=x.pnl;closed.push(x);
        peak=Math.max(peak,cash);maxDD=Math.max(maxDD,peak-cash);
      }
    }
    if(active.length>=MAX_OPEN||cash-active.length*MARGIN<MARGIN-1e-9){rejected++;continue;}
    const scale=NOTIONAL>0?NOTIONAL/(MARGIN*LEV):1;
    active.push({...t,pnl:t.netPnlUsd*scale});
    maxOpen=Math.max(maxOpen,active.length);
  }
  active.sort((a,b)=>a.exitTime-b.exitTime);
  for(const x of active){cash+=x.pnl;closed.push(x);peak=Math.max(peak,cash);maxDD=Math.max(maxDD,peak-cash);}
  const wins=closed.filter(x=>x.pnl>0),losses=closed.filter(x=>x.pnl<0);
  const gp=wins.reduce((s,x)=>s+x.pnl,0),gl=-losses.reduce((s,x)=>s+x.pnl,0);
  return {startCapitalUsd:START,endCapitalUsd:cash,netPnlUsd:cash-START,returnPct:(cash/START-1)*100,acceptedTrades:closed.length,rejectedForCapacity:rejected,winRatePct:closed.length?100*wins.length/closed.length:0,profitFactor:gl?gp/gl:gp?null:0,maxDrawdownUsd:maxDD,maxDrawdownPct:peak?maxDD/peak*100:0,maxConcurrentPositions:maxOpen,marginPerTradeUsd:MARGIN,leverage:LEV,notionalPerTradeUsd:NOTIONAL,maxOpenPositions:MAX_OPEN};
}
const variants=input.tradeLogs||{};
const results=Object.entries(variants).map(([name,trades])=>({variant:name,...replay(trades)}));
const out={generatedAt:new Date().toISOString(),method:"Chronological portfolio replay; fixed $1 margin per accepted trade; 10x leverage; max 2 simultaneous positions; $10 initial equity; rejected entries when capacity or free margin unavailable; no compounding of position size; realized PnL credited at exit.",sourcePeriod:input.period,settings:{startCapitalUsd:START,marginUsd:MARGIN,leverage:LEV,maxConcurrent:MAX_OPEN},results};
await writeFile("artifacts/fibonacci-ichimoku-portfolio.json",JSON.stringify(out,null,2));
const lines=["# Fibonacci + Ichimoku Portfolio-Constrained Replay","",out.method,"",`Source period: ${input.period.from} - ${input.period.to}`,"", "| Model | Accepted | Rejected | Win% | Net PnL | End capital | Return% | PF | Max DD | Max open |","|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|",...results.map(r=>`| ${r.variant} | ${r.acceptedTrades} | ${r.rejectedForCapacity} | ${r.winRatePct.toFixed(1)} | $${r.netPnlUsd.toFixed(3)} | $${r.endCapitalUsd.toFixed(3)} | ${r.returnPct.toFixed(2)} | ${r.profitFactor===null?"n/a":r.profitFactor.toFixed(2)} | $${r.maxDrawdownUsd.toFixed(3)} (${r.maxDrawdownPct.toFixed(1)}%) | ${r.maxConcurrentPositions} |`)];
await writeFile("artifacts/fibonacci-ichimoku-portfolio.md",lines.join("\n"));
console.log(JSON.stringify(out,null,2));

// Bounded risk sizing and portfolio admission for the independent research backtest.
export function sizePosition(entry, stop, {riskBudgetUsd=10,maxNotionalUsd=100}={}) {
  const e=Number(entry), st=Number(stop), risk=Math.abs(e-st);
  if(!(e>0)||!(risk>0)||!(riskBudgetUsd>0)||!(maxNotionalUsd>0)) return null;
  const qty=Math.min(riskBudgetUsd/risk,maxNotionalUsd/e);
  const notionalUsd=qty*e, plannedRiskUsd=qty*risk;
  if(!(qty>0)||!Number.isFinite(qty)||!Number.isFinite(notionalUsd)) return null;
  return {qty,notionalUsd,marginAt10xUsd:notionalUsd/10,plannedRiskUsd,capApplied:qty*e<=(maxNotionalUsd+1e-8)&&plannedRiskUsd<riskBudgetUsd-1e-8};
}
export function selectPortfolioTrades(trades,{maxConcurrent=5}={}) {
  const accepted=[],rejected=[],active=[];let peakConcurrent=0;
  for(const trade of [...trades].sort((a,b)=>a.entryTime-b.entryTime||a.symbol.localeCompare(b.symbol))) {
    for(let i=active.length-1;i>=0;i--) if(active[i].exitTime<=trade.entryTime) active.splice(i,1);
    const sameSymbol=active.some(t=>t.symbol===trade.symbol);
    if(active.length>=maxConcurrent||sameSymbol){rejected.push(trade);continue;}
    accepted.push(trade);active.push(trade);peakConcurrent=Math.max(peakConcurrent,active.length);
  }
  return {accepted,rejected,peakConcurrent};
}

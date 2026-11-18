export const DEFAULT_PORTFOLIO_CONFIG = Object.freeze({ initialCapitalUsd: 10, marginPerTradeUsd: 5, leverage: 10, maxConcurrentTrades: 2, candleIntervalMs: 900000, sourceEntryNotionalUsd: 100 });

export function replayPortfolio(trades, config = {}) {
  const cfg = { ...DEFAULT_PORTFOLIO_CONFIG, ...config };
  for (const key of ["initialCapitalUsd", "marginPerTradeUsd", "leverage", "maxConcurrentTrades", "candleIntervalMs", "sourceEntryNotionalUsd"]) {
    if (!(Number.isFinite(cfg[key]) && cfg[key] > 0)) throw new TypeError(`Invalid ${key}`);
  }
  if (!Number.isInteger(cfg.maxConcurrentTrades)) throw new TypeError("maxConcurrentTrades must be an integer");
  const pnlScale = cfg.marginPerTradeUsd * cfg.leverage / cfg.sourceEntryNotionalUsd;
  const candidates = trades.filter(t => t && ["closed", "open"].includes(t.status) && Number.isFinite(t.candleTime) && Number.isFinite(t.netPnl))
    .map(t => ({ ...t, entryTime: t.candleTime + cfg.candleIntervalMs, exitTime: t.status === "closed" && Number.isFinite(t.closedAt) ? t.closedAt : Number.POSITIVE_INFINITY, scaledNetPnlUsd: t.status === "closed" ? t.netPnl * pnlScale : null }))
    .sort((a,b) => a.entryTime-b.entryTime || String(a.symbol).localeCompare(String(b.symbol)));
  let cashUsd = cfg.initialCapitalUsd, peakEquityUsd = cashUsd, maxDrawdownUsd = 0, maxConcurrentObserved = 0;
  const open = [], accepted = [], rejected = [], closed = [];
  function settleThrough(time) {
    const due = open.filter(p => Number.isFinite(p.exitTime) && p.exitTime <= time).sort((a,b) => a.exitTime-b.exitTime);
    for (const p of due) {
      cashUsd += p.scaledNetPnlUsd;
      open.splice(open.indexOf(p),1); closed.push(p);
      peakEquityUsd = Math.max(peakEquityUsd,cashUsd);
      maxDrawdownUsd = Math.max(maxDrawdownUsd,peakEquityUsd-cashUsd);
    }
  }
  for (const t of candidates) {
    settleThrough(t.entryTime);
    if (open.some(p => p.symbol === t.symbol)) { rejected.push({symbol:t.symbol,candleTime:t.candleTime,reason:"symbol_already_open"}); continue; }
    if (open.length >= cfg.maxConcurrentTrades) { rejected.push({symbol:t.symbol,candleTime:t.candleTime,reason:"max_concurrent_reached"}); continue; }
    if (cashUsd - open.length*cfg.marginPerTradeUsd + 1e-9 < cfg.marginPerTradeUsd) { rejected.push({symbol:t.symbol,candleTime:t.candleTime,reason:"insufficient_free_margin"}); continue; }
    const p = {symbol:t.symbol,side:t.side,entryTime:t.entryTime,exitTime:t.exitTime,status:t.status,marginUsd:cfg.marginPerTradeUsd,notionalUsd:cfg.marginPerTradeUsd*cfg.leverage,sourceNetPnlUsd:t.status==="closed"?t.netPnl:null,scaledNetPnlUsd:t.scaledNetPnlUsd};
    open.push(p); accepted.push(p); maxConcurrentObserved=Math.max(maxConcurrentObserved,open.length);
  }
  settleThrough(Number.POSITIVE_INFINITY);
  const wins=closed.filter(t=>t.scaledNetPnlUsd>0), losses=closed.filter(t=>t.scaledNetPnlUsd<0);
  const grossProfitUsd=wins.reduce((s,t)=>s+t.scaledNetPnlUsd,0), grossLossUsd=Math.abs(losses.reduce((s,t)=>s+t.scaledNetPnlUsd,0));
  const netPnlUsd=closed.reduce((s,t)=>s+t.scaledNetPnlUsd,0);
  const reasons=[...new Set(rejected.map(r=>r.reason))];
  return {
    config:cfg,pnlScale,sourceTrades:trades.length,candidates:candidates.length,accepted:accepted.length,closed:closed.length,openAtEnd:open.length,rejected:rejected.length,
    rejectionReasons:Object.fromEntries(reasons.map(r=>[r,rejected.filter(x=>x.reason===r).length])),
    wins:wins.length,losses:losses.length,winRatePct:closed.length?Number((wins.length/closed.length*100).toFixed(2)):null,
    grossProfitUsd:Number(grossProfitUsd.toFixed(6)),grossLossUsd:Number(grossLossUsd.toFixed(6)),netPnlUsd:Number(netPnlUsd.toFixed(6)),
    endingCashUsd:Number(cashUsd.toFixed(6)),availableFreeMarginUsd:Number((cashUsd-open.length*cfg.marginPerTradeUsd).toFixed(6)),
    profitFactor:grossLossUsd?Number((grossProfitUsd/grossLossUsd).toFixed(4)):grossProfitUsd?null:0,
    maxDrawdownUsd:Number(maxDrawdownUsd.toFixed(6)),maxConcurrentObserved,
    openPositions:open.map(({symbol,side,entryTime,marginUsd,notionalUsd})=>({symbol,side,entryTime,marginUsd,notionalUsd})),rejectedTrades:rejected,
    warnings:["PnL is linearly scaled from source notional, not a fresh $50 candle-level simulation.","Fees, slippage and funding are included only as present in source trade netPnl.","Exchange-specific maintenance margin and liquidation rules are not modeled.","Drawdown uses realized cash only; intratrade and unrealized equity drawdown are unavailable."]
  };
}

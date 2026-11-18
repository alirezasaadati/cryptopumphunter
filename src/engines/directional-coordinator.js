// Enforce one active directional trade per symbol across the LONG and SHORT engines.
// Candidates are processed chronologically; same-candle ties use score, then LONG engine A.
export function resolveExclusiveDirectionalTrades(longTrades, shortTrades) {
  const candidates = [
    ...longTrades.map(trade => ({ ...trade, engine: "A_LONG_ONLY" })),
    ...shortTrades.map(trade => ({ ...trade, engine: "B_SHORT_ONLY" }))
  ].sort((a, b) => (a.candleTime ?? 0) - (b.candleTime ?? 0) ||
    (b.score ?? 0) - (a.score ?? 0) || (a.engine === "A_LONG_ONLY" ? -1 : 1));
  const accepted = [], rejected = [], activeUntil = new Map();
  for (const trade of candidates) {
    const symbol = trade.symbol;
    const until = activeUntil.get(symbol) ?? -Infinity;
    if ((trade.candleTime ?? 0) <= until) {
      rejected.push({ ...trade, status: "symbol_direction_conflict",
        conflictWith: activeUntil.get(symbol) });
      continue;
    }
    accepted.push(trade);
    activeUntil.set(symbol, trade.status === "closed" && Number.isFinite(trade.closedAt)
      ? trade.closedAt : Infinity);
  }
  return {
    longTrades: accepted.filter(t => t.engine === "A_LONG_ONLY"),
    shortTrades: accepted.filter(t => t.engine === "B_SHORT_ONLY"),
    rejected
  };
}

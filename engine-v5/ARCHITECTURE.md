# Crypto Pump Hunter — Engine V5 Architecture

## Status and isolation
- Design-only branch; production `main` and current Worker are untouched.
- Separate Worker, entry point, D1, and R2.
- No KV binding or KV read/write path.
- Paper trading only; no live order placement.

## Product goals
1. Kraken-only market intelligence using Kraken Spot and Futures.
2. Two independent futures strategy profiles on identical data:
   - Model A: quality-first, stricter confirmation, lower frequency.
   - Model B: opportunity-first, more permissive filters, higher risk.
3. Separate pump/dump early-warning evaluator.
4. Realistic paper results after fees, slippage, funding, and entry expiry.

## Components
1. Kraken public-data adapter with symbol mapping, timestamps, rate limits, and health.
2. Liquidity/spread/listing-age/data-quality instrument universe.
3. Staged REST bootstrap and WebSocket streams; never sweep all symbols every minute.
4. Feature engine: candles, volatility, relative volume, depth, trade imbalance, OI, funding, basis, and available on-chain metrics. Missing data is unavailable, never zero.
5. Multi-timeframe context: 4h Fibonacci structure, 1h validation, 15m/5m entries; closed candles only.
6. Opportunity engines: pullback, continuation, breakout, pump/dump warning.
7. Entry/risk: Entry 1/2, invalidation, SL/targets, sizing, entry drift, no-trade conditions.
8. Ranking and paper execution with fees, slippage, funding, partial targets, conservative stop/target ordering, expiry.
9. Immutable analytics records; no silent self-modification.

## Strategy comparison
- A and B receive the same Kraken universe, snapshots, and event timeline.
- Compare signal count, win rate, expectancy, net PnL, profit factor, drawdown, average R, costs, and long/short breakdown.
- Target at least 100 closed paper trades per model before strong conclusions; disclose uncertainty below that.
- Evaluate pump detection separately by lead time, false positives, precision/recall, and missed events.

## Storage
- D1: compact metadata, decisions, signals, paper trades, events, aggregates.
- R2: compressed historical candles and raw archives.
- KV: not bound and not used.
- Never reuse current bot resources.

## Reliability
Per-endpoint budgets, backoff, circuit breakers; validate contract status, quote currency, precision, and timestamp skew. Reject stale, low-liquidity, excessive-spread, or contradictory data. No production bot changes.

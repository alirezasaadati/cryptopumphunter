# Crypto Pump Hunter — Engine V5 Architecture (Design)

## Status and isolation
- This branch is design-only. The production `main` branch and current Worker are not modified.
- Engine V5 is a separate Worker with a separate deployment name, entry point, D1 database, and R2 bucket.
- Engine V5 has **no KV binding and no KV read/write path**.
- No live orders are placed. All strategy evaluation starts in paper-trading mode.

## Product goals
1. Multi-exchange market intelligence using **OKX and Kraken only**.
2. Two independent futures strategy profiles tested on the same market events:
   - Model A: quality-first, stricter confirmation and higher score threshold.
   - Model B: opportunity-first, more permissive filters and explicitly higher risk.
3. A separate pump/dump early-warning evaluator.
4. Explainable decisions and realistic paper-trading results after fees, slippage, funding, and entry-window expiry.

## Logical components
1. **Exchange adapters** — normalized public market data from OKX and Kraken. Spot and perpetual instruments are distinct. Each adapter owns symbol mapping, timestamp normalization, rate-limit handling, and health reporting.
2. **Instrument universe** — liquidity, spread, listing age, contract availability, market integrity and data-quality gates. Separate core and discovery universes.
3. **Market data pipeline** — prefer exchange WebSocket streams where practical; use REST for bootstrap and reconciliation. Do not poll every symbol every minute.
4. **Feature engine** — candle structure, realized volatility, relative volume, spread/depth, aggressive trade imbalance, open interest, funding, basis, and available on-chain signals. Missing data is unavailable, never zero.
5. **Multi-timeframe context** — 4h primary structure and Fibonacci swing; 1h validation; 15m/5m entry triggers. Use closed candles and avoid look-ahead.
6. **Opportunity engines** — Fibonacci/pullback, trend continuation, confirmed breakout, and pump/dump early-warning.
7. **Entry and risk engine** — entry zones, Entry 1/2 rules, invalidation, stop, targets, sizing assumptions, entry drift and no-trade conditions.
8. **Ranking** — rank eligible candidates; watchlists are not trade guarantees.
9. **Paper execution and evaluation** — realistic fills, fees, slippage, funding, partial targets, conservative stop/target ordering, and expiry.
10. **Analytics memory** — immutable signal/trade/event records; no silent self-modification.

## Strategy comparison rules
- A and B receive the same eligible universe, data snapshot, and event timeline.
- Record rejected opportunities and rejection reasons.
- Compare signal count, win rate, expectancy, net PnL, profit factor, drawdown, average R, costs, and long/short breakdown.
- Target at least 100 closed paper trades per model before strong conclusions; report uncertainty if sample size is insufficient.
- Evaluate pump detection separately using lead time, false positives, precision/recall, and missed-event review.

## Storage and isolation
- **D1**: normalized metadata, runs, candidates, decisions, signals, paper trades, events, experiments, and aggregates.
- **R2**: compressed historical candles and larger raw archives.
- **KV**: not bound and not used by V5.
- Never reuse the current bot's D1, R2, KV, secrets, or Worker.

## Reliability and safety
- Per-exchange request budgets, backoff, circuit breakers, and health status.
- Validate symbol status, contract type, quote currency, precision, and timestamp skew.
- Reject low-liquidity, excessive-spread, stale-data, and abnormal-slippage candidates.
- No signal when required data is missing, contradictory, or stale.
- No live trading credentials or order-placement code in the initial version.
- No changes to the current production bot.

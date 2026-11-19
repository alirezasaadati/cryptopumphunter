# Crypto Pump Hunter — Engine V5 Architecture (Design)

## Status and isolation
- This branch is design-only. The production `main` branch and current Worker are not modified.
- Engine V5 will be a separate Worker with a separate deployment name, entry point, D1 database, and R2 bucket.
- Engine V5 has **no KV binding and no KV read/write path**. A KV outage or quota limit in the existing bot must not affect V5.
- No live orders are placed. All strategy evaluation starts in paper-trading mode.

## Product goals
1. Multi-exchange market intelligence for spot and perpetual futures.
2. Two independent futures strategy profiles tested on the same market events:
   - Model A: quality-first, stricter confirmation and higher score threshold.
   - Model B: opportunity-first, more permissive filters and explicitly higher risk.
3. A separate pump/dump early-warning evaluator that measures preparation and early-move detection, not just late breakouts.
4. Explainable decisions, durable audit records, and realistic paper-trading results after fees, slippage, funding, and entry-window expiry.

## Logical components
1. **Exchange adapters** — normalized public market data from Binance, Bybit, OKX, and Kraken. Spot and perpetual instruments are distinct markets. Each adapter owns symbol mapping, timestamp normalization, rate-limit handling, retry/backoff, and health reporting.
2. **Instrument universe** — liquidity, spread, listing age, contract availability, market integrity and minimum data-quality gates. Separate universes:
   - Core: sufficiently liquid, established instruments for professional futures signals.
   - Discovery: newer/smaller instruments for pump/dump monitoring, with stricter manipulation and liquidity checks.
3. **Market data pipeline** — prefer exchange WebSocket streams where practical; use REST for bootstrap, reconciliation, and slower metrics. Do not poll every symbol on every exchange every minute. Use staged discovery, subscriptions for shortlisted symbols, and adaptive sampling under rate limits.
4. **Feature engine** — candle structure, realized volatility, relative volume, spread/depth, aggressive trade imbalance, open interest, funding, basis, and available on-chain/large-wallet signals. Missing data is explicitly marked unavailable; it is never treated as zero.
5. **Multi-timeframe context** — 4h establishes the primary structure and Fibonacci swing; 1h validates context and confluence; 15m/5m evaluate entry triggers. Use only closed candles for confirmed pivots and avoid look-ahead/repainting.
6. **Opportunity engines**:
   - Fibonacci/pullback path.
   - Trend-continuation path.
   - Confirmed-breakout path.
   - Pump/dump preparation and early-move detector.
7. **Entry and risk engine** — entry zones, Entry 1/2 rules, invalidation, stop, targets, position sizing assumptions, maximum entry drift, minimum reward/risk, and no-trade conditions.
8. **Ranking** — continuously rank eligible candidates. The top 20 are a watchlist, not a hard limit on discovery or a guarantee of a trade. Re-rank on new material data and expire stale candidates.
9. **Paper execution and evaluation** — deterministic event ordering, realistic fills, fees, slippage, funding, partial targets, stop priority when candle data cannot establish event order, and expiry rules.
10. **Analytics memory** — compare models and experiments using immutable signal/trade/event records. The system may recommend parameter changes, but it must not silently self-modify a running model.

## Scan cadence
- Every minute: refresh ranking inputs and abnormal-move candidates using cached/streamed data; not a full REST sweep.
- 5m/15m: evaluate entry triggers on completed candles and any explicitly defined intrabar trigger.
- 1h/4h: recalculate context after candle close.
- WebSocket events may update short-term features between scheduled jobs.
- Every scan and decision records data timestamps and staleness; stale inputs block or downgrade a decision.

## Strategy comparison rules
- A and B receive the same eligible instrument universe, market-data snapshot, and event timeline.
- Keep strategy versions and configuration hashes immutable per experiment.
- Record rejected opportunities and rejection reasons, not only issued signals.
- Compare signal count, trade count, win rate, expectancy, net PnL, profit factor, max drawdown, average R, fees/funding, and long/short breakdown.
- Target at least 100 closed paper trades per model before a strong comparison; if not reached, report sample size and uncertainty rather than declaring a winner.
- Pump detector is evaluated separately using pre-defined event windows, lead time, false-positive rate, precision/recall, and missed-event review. It is not scored as a profitable trade unless a separate executable strategy enters.

## Storage and isolation
- **D1**: normalized metadata, runs, candidates, decisions, signals, paper trades, trade events, experiments, and aggregate metrics.
- **R2**: optional compressed historical candles, order-book/trade archives, and large raw snapshots. Keep only data needed for replay and audit; apply retention policies.
- **In-memory / Durable Object state**: short-lived caches, stream coordination, and rate-limit coordination. Durable Objects are not a replacement for durable trade history.
- **KV**: not bound and not used by Engine V5.
- A D1/R2 write failure must be surfaced. The engine must not claim a signal is durably recorded or include it in performance statistics if the required record was not persisted. Data ingestion may continue in a degraded mode with an explicit health status and bounded retry/outbox strategy.

## Reliability and safety gates
- Per-exchange request budgets, exponential backoff, circuit breakers, and exchange health status.
- Validate symbol status, contract type, quote currency, tick/lot sizes, min notional, and timestamp skew.
- Reject low-liquidity, excessive-spread, suspicious-volume, stale-data, and abnormal-slippage candidates.
- No signal when required data is missing, contradictory, or stale.
- No live trading credentials or order-placement code in the initial version.
- Separate test/staging/production resources; never reuse the existing bot's D1, R2, KV, secrets, or Worker binding.

## Proposed project layout (implementation phase)
```
engine-v5/
  src/
    index.js
    config/
    exchanges/
    universe/
    ingestion/
    features/
    analysis/
    strategies/
    entries/
    risk/
    ranking/
    paper/
    analytics/
    storage/
  migrations/
    0001_initial.sql
  scripts/
  tests/
  wrangler.toml
  README.md
```

## Open technical choices to validate before implementation
- Exact data providers and availability for open interest, funding, order-book depth, and on-chain/whale data.
- Supported instruments and minimum liquidity thresholds per exchange.
- Whether WebSocket ingestion uses Durable Objects, a dedicated stream service, or scheduled REST only for the first prototype.
- D1 and R2 retention, expected rows/day, storage and request budget.
- Backtest/paper fill model and exact entry-window rules.

## Non-goals for the first release
- No guaranteed prediction of pumps or dumps.
- No autonomous parameter changes.
- No live order execution.
- No dependency on Cloudflare KV.
- No changes to the current production bot.

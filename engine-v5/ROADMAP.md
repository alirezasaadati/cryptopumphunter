# Engine V5 Implementation Roadmap

This is a staged plan. A stage is not considered complete until its tests and acceptance checks pass.

## Stage 0 — Design and isolation (current)
- [x] Create a separate design branch.
- [x] Document architecture and KV-free storage boundaries.
- [x] Draft an isolated D1 schema.
- [ ] Review data-provider coverage and operational limits.
- [ ] Approve the initial instrument and liquidity rules.

Acceptance: no files in the production bot entry point or production Wrangler configuration are changed.

## Stage 1 — Standalone foundation
- Create a separate `engine-v5/src/index.js` and `engine-v5/wrangler.toml`.
- Bind a newly created, dedicated D1 database and a dedicated R2 bucket.
- Do not define an APP_KV or other KV binding.
- Add health endpoint, config validation, schema migration runner, structured logs, and tests.
- Confirm the Engine V5 Worker name and routes cannot replace the current Worker.

Acceptance: deployable in a non-production environment with no KV binding and no secrets for live trading.

## Stage 2 — Exchange data adapters
- Implement read-only public market data adapters.
- Start with instrument metadata, ticker, candles, trades, order book, funding, and open interest only where the exchange exposes reliable endpoints.
- Normalize timestamps, symbols, market types, precision, and errors.
- Add per-exchange rate budgets, backoff, circuit breakers, staleness checks, and replayable fixtures.

Acceptance: deterministic adapter tests and measured request budgets; one exchange outage does not stop other adapters.

## Stage 3 — Universe and market features
- Separate core liquid futures universe from discovery universe.
- Apply listing/status, spread, depth, quote-volume, and data-quality filters.
- Calculate relative volume, volatility compression/expansion, trade imbalance, and derivatives features.
- Mark unavailable provider data as unavailable, not zero.

Acceptance: every candidate has an auditable feature snapshot and explicit data-quality status.

## Stage 4 — Analysis and opportunity detection
- Implement confirmed swing-point detection and non-repainting 4h/1h Fibonacci context.
- Implement trend continuation and confirmed breakout paths.
- Implement pump/dump preparation and early-stage detection.
- Add whale/on-chain signals only when a trusted provider and attribution quality are available.
- Build dynamic top-20 watchlist with expiry and missed-opportunity labels.

Acceptance: historical replay tests show no future-data leakage; candidate explanations are stored.

## Stage 5 — Entry, risk, and paper execution
- Implement 15m/5m entry confirmation and Entry 1/Entry 2 rules.
- Freeze Model A and Model B configuration versions for each experiment.
- Simulate fills, spread, slippage, fees, funding, partial exits, stop/target ordering, and entry expiry.
- Never send live orders.

Acceptance: deterministic paper-trade replay with reproducible PnL and trade-event ledger.

## Stage 6 — Evaluation and calibration
- Run A and B simultaneously on the same data and eligible universe.
- Evaluate the pump detector independently from trading PnL.
- Report sample sizes, win rate, expectancy, net PnL, profit factor, drawdown, average R, costs, and LONG/SHORT splits.
- Target at least 100 closed trades per model; do not declare a winner on inadequate samples.
- Propose parameter changes as a new immutable experiment; never silently modify a running strategy.

Acceptance: reproducible comparison report and documented limitations.

## Stage 7 — Controlled integration (only after approval)
- Decide whether any V5 outputs should be surfaced to Telegram.
- Keep the current bot and V5 engine independently deployable and independently rollbackable.
- No production integration or replacement without explicit approval and a completed validation report.

## Operational guardrails
- KV is not used by any Engine V5 code or runtime binding.
- D1 stores compact, queryable state; R2 stores bulky replay/archive data.
- Do not store every tick or full order book in D1.
- Apply retention, sampling, batching, and write budgets before enabling broad coverage.
- On required persistence failure, mark the run degraded and do not count an unpersisted signal/trade in performance statistics.

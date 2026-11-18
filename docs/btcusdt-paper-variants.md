# BTCUSDT paper comparison — isolated research

This runner compares three independent paper portfolios on **BTCUSDT only**:

- `A_baseline`: current strict 1H/4H analyzer with no added ablation filters.
- `B_all_filters`: volume >= 1.2x, compression <= 0.8x, ATR cap 5%, candle body >= 1.2x prior average, pullback-or-breakout setup, and avoid-late-entry.
- `C_avoid_late`: baseline plus avoid-late-entry only.

## Timeframe design

- 4H: market regime confirmation (the existing analyzer checks 4H EMA20/EMA50).
- 1H: directional signal and existing entry/stop/target calculation.
- 15m: wait for a closed candle in the signal direction above/below EMA20, then paper-enter at the next 15m candle open, provided drift from the 1H reference entry is no more than 0.35%.

The 15m confirmation is a new execution rule and must be evaluated as such; it was not part of the prior 180-day hourly filter ablation.

## Run locally

Requires Node.js 22+ and network access to Binance public USD-M market-data endpoints. No API keys are needed.

```sh
npm install
npm test
node scripts/btcusdt-paper-variants.mjs
node scripts/btcusdt-paper-variants.mjs --watch
```

The first run creates a clean checkpoint and does not backfill historical trades. `--watch` polls every 15 minutes. State is stored in `artifacts/btcusdt-paper-state.json`; back it up to resume after moving machines. Set `BTC_PAPER_STATE` to choose another path.

## Accounting and safety

- Paper-only: no private credentials, order endpoints, or live orders.
- Fee assumption: 0.05% per side; adverse slippage: 0.03% per side.
- Funding is not included; liquidation/mark-price modeling is not included.
- Stop is evaluated before targets when both occur in one 15m candle.
- Partial targets: 40% / 35% / 25%; maximum hold: 72 hours.
- Entry is next 15m open after confirmation, with adverse slippage.
- Each variant has its own pending signal, open position, and closed-trade ledger.

**Exchange caveat:** this research runner uses Binance USD-M BTCUSDT public data. The production bot currently uses Kraken Derivatives. This does not change production configuration or make the two venues interchangeable.

Do not promote any variant based on a handful of trades. Review trade count, expectancy, profit factor, drawdown, long/short breakdown, and behavior across different market regimes before considering any production change.

# Crypto Pump Hunter Engine V5

Standalone isolated engine; not imported by the current production bot.

## Status
**Foundation and read-only Kraken adapter — not deployed and not scanning markets.**
- Separate Worker: `cryptopumphunter-engine-v5`
- Dedicated D1: `ENGINE_DB`; dedicated R2: `ENGINE_ARCHIVE`
- No KV binding or KV dependency
- Paper mode only; no live trading or order placement
- Health endpoint is the only implemented Worker route

## Market data
Only **Kraken Spot and Kraken Futures** are included. Binance, Bybit, and OKX are excluded from V5 adapters, smoke tests, and historical backtests. Historical replay uses Kraken Futures trade candles from the official Charts API; no other exchange's data may be substituted.

## Checks
```bash
npm test
npm run smoke
npm run backtest
```
Unit tests use mocks. Smoke and historical replay contact public Kraken endpoints and may fail due to API availability or schema changes. Validate live data before enabling collection.

## Before Cloudflare deployment
1. Create a new D1 database and R2 bucket for V5.
2. Replace the D1 placeholder in `wrangler.toml`.
3. Apply migrations only to the new V5 D1.
4. Deploy only the V5 configuration.
Never reuse the production bot's KV, D1, R2, secrets, Durable Objects, or Worker.

## Design documents
- [Architecture](ARCHITECTURE.md)
- [Data sources](DATA_SOURCES.md)
- [Roadmap](ROADMAP.md)
- [Initial D1 schema](migrations/0001_initial.sql)

# Crypto Pump Hunter Engine V5

This directory is a standalone, isolated engine project. It is not imported by the current production bot.

## Current status

**Foundation only — not deployed and not scanning markets.**

- Separate Worker name: `cryptopumphunter-engine-v5`
- Separate entry point: `engine-v5/src/index.js`
- Dedicated D1 binding: `ENGINE_DB`
- Dedicated R2 binding: `ENGINE_ARCHIVE`
- No KV namespace binding and no KV dependency
- Paper mode only; no live trading or order placement
- The health endpoint is the only implemented route

## Public exchange adapters

Read-only adapters are implemented under `src/exchanges/` for:
- Binance Spot and USDⓈ-M perpetual markets
- Bybit Spot and Linear markets
- OKX Spot and SWAP markets
- Kraken Spot and Futures public market data

They normalize instrument metadata and 24-hour ticker snapshots. Selective enrichment methods exist for some derivatives metrics and order-book reads. These adapters are not yet connected to a scheduled scanner or D1 persistence. Kraken Futures symbol mapping and every live response shape still require read-only smoke tests before broad collection.

The HTTP layer has bounded request timeouts and classifies rate limits; it intentionally does not retry 429 responses automatically. A future scheduler must respect each exchange's retry-after/rate-limit headers and request budget.

## Local checks

From this directory:

```bash
npm test
```

The current tests cover only the foundation health endpoint and 404 handling. They do not test market data, exchange adapters, strategy logic, or trading performance.

## Before any Cloudflare deployment

1. Create a **new** D1 database for Engine V5.
2. Create a **new** R2 bucket for Engine V5.
3. Replace the D1 placeholder ID in `wrangler.toml` with that new database ID.
4. Confirm the Worker name is distinct from the production bot.
5. Apply the V5 migration only to the new V5 D1 database.
6. Deploy only this configuration, never the production bot configuration.

Do not reuse the current bot's KV, D1, R2, secrets, Durable Objects, or Worker.

## Design documents

- [Architecture](ARCHITECTURE.md)
- [Implementation roadmap](ROADMAP.md)
- [Initial D1 schema](migrations/0001_initial.sql)

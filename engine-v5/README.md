# Crypto Pump Hunter Engine V5

This directory is a standalone, isolated engine project. It is not imported by the current production bot.

## Current status

**Foundation and read-only exchange adapters — not deployed and not scanning markets.**

- Separate Worker name: `cryptopumphunter-engine-v5`
- Dedicated D1 binding: `ENGINE_DB`
- Dedicated R2 binding: `ENGINE_ARCHIVE`
- No KV namespace binding and no KV dependency
- Paper mode only; no live trading or order placement
- The health endpoint is the only implemented Worker route

## Supported public exchanges

Only these two exchanges are currently included:
- **OKX:** Spot and SWAP public market data
- **Kraken:** Spot and Futures public market data

Binance and Bybit adapters have been removed from V5. The historical replay data source is handled separately and is not an enabled live exchange adapter.

Adapters normalize instrument metadata and 24-hour ticker snapshots. Selective enrichment methods exist for derivatives metrics and order-book reads. They are not yet connected to a scheduled scanner or D1 persistence. Live response validation is still required before broad collection.

The HTTP layer has bounded request timeouts and classifies rate limits; it intentionally does not retry 429 responses automatically. A future scheduler must respect each exchange's retry-after/rate-limit headers and request budget.

## Checks

From this directory:

```bash
npm test
npm run smoke
```

The unit tests use mocked API responses. The smoke test contacts public endpoints and may fail because of regional restrictions, exchange outages, or API changes. A successful smoke test is required before enabling collection.

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
- [Data sources](DATA_SOURCES.md)
- [Implementation roadmap](ROADMAP.md)
- [Initial D1 schema](migrations/0001_initial.sql)

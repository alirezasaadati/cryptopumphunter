# Engine V5 — Data Sources and Infrastructure Constraints

Reviewed against official documentation on 2026-11-19. Validate endpoint schemas and limits before release.

## Supported exchange market-data coverage

| Exchange | Instruments | Market data | Derivatives data |
|---|---|---|---|
| OKX Spot + SWAP | Public instruments endpoint | Tickers, candles, trades, order books, WebSocket channels | Open interest, current/historical funding, mark/index data |
| Kraken Spot + Futures | Asset pairs and futures instruments | Trades, OHLC, order book, ticker | Futures analytics include open interest, aggressor differential, liquidation volume, long/short information, CVD and funding where supported |

**Binance and Bybit are intentionally excluded from Engine V5.** They must not be called by the live scanner, smoke test, or future scheduled collection.

## Official documentation

- OKX API documentation: https://www.okx.com/docs-v5/en/
- OKX market-data guide: https://app.okx.com/docs-v5/trick_en/
- Kraken API portal: https://www.kraken.com/pro/trading-api
- Kraken Futures market analytics: https://docs.kraken.com/api/docs/futures-api/charts/market-analytics

## Whale and capital-flow data boundaries

Do not label every large exchange trade or large order as a whale transaction.
- Exchange-observable signals: large prints, trade imbalance, top-trader analytics when supplied by the venue, order-book depth changes, open-interest changes, liquidations and price/volume divergence.
- On-chain wallet transfers and exchange flows require separate chain-specific providers and attribution confidence.
- Missing on-chain data is unavailable, never a neutral or directional value.

## Cloudflare storage and runtime implications

### D1
Official limits: https://developers.cloudflare.com/d1/platform/limits/
- D1 is for compact normalized state, decisions, signals, trade ledgers and aggregates — not every tick or full order-book update.
- Use indexed queries, batched writes, bounded retention, and periodic aggregates.

### R2
Official limits: https://developers.cloudflare.com/r2/platform/limits/
Official pricing: https://developers.cloudflare.com/r2/pricing/
- R2 is suitable for compressed replay datasets and raw archives.
- Write chunked, time-partitioned objects rather than one object per event.

### Workers
Official limits: https://developers.cloudflare.com/workers/platform/limits/
- Cron invocations have finite execution limits. Do not perform a full REST sweep every minute.
- Use staged scans, subscriptions for shortlisted symbols, request budgets, and resumable batches.
- Confirm account plan limits before sizing.

## Initial collection policy

1. Refresh instrument metadata on a slower cadence.
2. Obtain broad ticker data with bulk endpoints where supported.
3. Stream or sample only the eligible universe and watchlist.
4. Fetch expensive features selectively.
5. Persist compact snapshots at decision points, not every incoming event.
6. Archive replay data to R2 in batches.
7. Enforce per-endpoint rate budgets and staleness limits independently for OKX and Kraken.

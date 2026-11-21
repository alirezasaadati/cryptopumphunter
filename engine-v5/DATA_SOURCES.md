# Engine V5 — Data Sources

Reviewed 2026-11-19; validate endpoint schemas and limits before release.

## Supported venue
| Exchange | Markets | Data |
|---|---|---|
| Kraken | Spot + Futures | Instruments, tickers, trades, OHLC, order book; Futures historical trade candles and analytics |

**Binance, Bybit, and OKX are excluded** from adapters, smoke tests, live collection, and historical replay.

## Official documentation
- Kraken API: https://www.kraken.com/pro/trading-api
- Futures candles: https://docs.kraken.com/api/docs/futures-api/charts/candles
- Futures analytics: https://docs.kraken.com/api/docs/futures-api/charts/market-analytics
- Historical OHLCVT: https://support.kraken.com/articles/360047124832-downloadable-historical-ohlcvt-open-high-low-volume-trades-data

## Data boundaries
Large exchange prints are not automatically wallet/whale transactions. On-chain transfers and exchange flows require separate providers and attribution confidence. Missing data is unavailable, never zero.

## Cloudflare
D1 stores compact normalized state and trade ledgers, not every tick. R2 stores compressed replay archives. Workers need staged scans, bounded execution, resumable batches, and endpoint-specific rate budgets. Never reuse production bot resources.

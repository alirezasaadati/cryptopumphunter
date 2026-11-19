# Engine V5 — Data Sources and Infrastructure Constraints

Reviewed against official documentation on 2026-11-19. Endpoint names and limits can change; adapter implementations must validate the live specification and response schema before release.

## Exchange market-data coverage

| Exchange | Instrument metadata | Market data | Derivatives / positioning data | Initial adapter notes |
|---|---|---|---|---|
| Binance USDⓈ-M Futures + Spot | Exchange info / symbol metadata | Tickers, klines, trades, order book | Current and historical open interest, funding-rate history | Request weights differ by endpoint. Do not query OI history for every symbol every minute. |
| Bybit V5 Spot + Linear/Inverse | `/v5/market/instruments-info` | Tickers, klines, order book, public recent trades | Open interest, funding history, long/short ratio (where available) | V5 unifies product categories; pagination and category must be handled explicitly. |
| OKX Spot + SWAP/Futures | `/api/v5/public/instruments` | Tickers, candles, trades, order books; public WebSocket channels | Open interest, current and historical funding, mark/index data | Public WebSocket streams are preferred for high-frequency updates; some advanced order-book channels have account/VIP restrictions. |
| Kraken Spot + Futures | Instrument/ticker and market-data endpoints | Trades, OHLC, order book, ticker | Futures analytics include open interest, aggressor differential, liquidation volume, long/short information, CVD, top traders, liquidity, slippage, basis and funding where supported | Kraken Futures analytics are especially useful for research; analytics availability is symbol/type dependent. |

## Official documentation

- Binance USDⓈ-M Futures market-data REST documentation: https://developers.binance.info/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/market-data
- Bybit V5 API introduction: https://bybit-exchange.github.io/docs/v5/intro
- Bybit market endpoint catalog: https://bybit-exchange.github.io/docs/api-explorer/v5/market/market
- Bybit instrument information: https://bybit-exchange.github.io/docs/v5/market/instrument
- Bybit tickers: https://bybit-exchange.github.io/docs/v5/market/tickers
- OKX API documentation: https://www.okx.com/docs-v5/en/
- OKX market-data guide: https://app.okx.com/docs-v5/trick_en/
- Kraken API portal: https://www.kraken.com/pro/trading-api
- Kraken Futures market analytics: https://docs.kraken.com/api/docs/futures-api/charts/market-analytics

## Whale and capital-flow data boundaries

Do not label every large exchange trade or large order as a "whale transaction".
- Exchange-observable signals: large prints, trade imbalance, top-trader analytics when supplied by the venue, order-book depth changes, open-interest changes, liquidations and cross-venue price/volume divergence.
- On-chain signals: wallet transfers, exchange inflows/outflows and attributed entity flows require chain-specific data providers and attribution confidence. These are not supplied consistently by exchange market-data APIs.
- Provider selection, supported chains, historical depth, update latency, licensing and cost must be evaluated before enabling on-chain whale scoring.
- Missing on-chain data is "unavailable", never a neutral or bearish/bullish value.

## Cloudflare storage and runtime implications

### D1
Official limits: https://developers.cloudflare.com/d1/platform/limits/
- Current documentation lists a 500 MB maximum database size on Workers Free and 10 GB per database on Workers Paid.
- D1 is single-threaded per database. Throughput depends on query duration.
- Therefore, D1 is for compact normalized state, decisions, signals, trade ledgers and aggregates — not every tick or every full order-book update.
- Use indexed queries, batched writes, bounded retention, and periodic aggregate calculations.
- Confirm the account plan and actual limits before estimating capacity or cost.

### R2
Official limits: https://developers.cloudflare.com/r2/platform/limits/
Official pricing: https://developers.cloudflare.com/r2/pricing/
- R2 is suitable for larger replay datasets and compressed raw archives.
- Object storage is not a live tick database. Write chunked, time-partitioned objects rather than one object per event.
- R2 has operation pricing and limits; archive frequency and retrieval patterns must be budgeted.

### Workers
Official limits: https://developers.cloudflare.com/workers/platform/limits/
- Cron invocations have finite execution limits; a minute schedule is not permission to perform a full REST scan of every market on every exchange.
- Use a bounded work queue / staged scan, streaming subscriptions where appropriate, request budgets, and resumable batches.
- Workers Free and Paid have materially different request, CPU and subrequest limits. Confirm the actual account plan before sizing the system.

## Initial collection policy

1. Bootstrap and refresh instrument metadata on a slower cadence and on exchange status changes.
2. Obtain broad ticker data with bulk endpoints where supported.
3. Maintain short-lived streaming or sampled data only for the eligible universe and watchlist.
4. Fetch expensive features (depth, OI history, funding history, top-trader analytics) selectively for shortlisted instruments.
5. Persist compact snapshots at decision points and periodic intervals, not every incoming event.
6. Archive raw/replay data to R2 in batches only when it is needed for reproducibility.
7. Enforce per-endpoint rate budgets and staleness limits independently for each exchange.

# Crypto Pump Hunter V4

Telegram/Cloudflare Worker migration of the legacy Crypto Pump Hunter engine.

## Included features
- Manual multi-coin spot market scan, market analysis, watchlist and connection status.
- Kraken Derivatives perpetual futures scanner (LONG/SHORT) using 4H context, 1H market structure and 15M entry confirmation using Price Action only.
- Original Telegram menus, membership approval, member administration, invite and about screens.
- No exchange trading keys and no order placement.

## Signal and trade lifecycle safeguards
- The scanner creates an internal signal-evaluation tracking record; it does not read exchange positions or confirm actual fills.
- Open tracking records are monitored automatically using closed 5-minute candles. This is simulated lifecycle tracking, not exchange order execution or live position reconciliation.
- Staged exits use 1/3 of the initial position at 1.5R, another 1/3 at 2.5R, and the remainder at 3.5R.
- At +1R the bot only suggests a fee-buffered break-even stop; it does not change the tracked stop automatically. After manually changing the stop in the exchange, the owner must synchronize the actual stop with `/set_stop TRADE_ID PRICE`.
- `/open_trades` displays internal open-trade records, IDs and tracked stop levels for owner-only reconciliation.
- `/set_stop` updates only the bot's internal tracking record. It never places, modifies or cancels an exchange order.
- The owner can close an internal tracking record with `/close_trade TRADE_ID`; this does not close an exchange position.
- Reported R and return results are theoretical and exclude fees, funding, slippage and missed intrabar price touches.

## Futures signal strategy
- 1H trend and structure, 4H directional confirmation, and 15M entry confirmation.
- EMA20/EMA50, RSI14 and ATR14 are used alongside volume ratio, 24-hour price change, funding and liquidity filters.
- The engine includes standard and high-risk eligibility paths; a high-risk candidate is not equivalent to a standard setup.
- Kraken Derivatives is the only Futures data provider; there is no fallback provider.

## Runtime configuration
Cloudflare Worker name: `cryptopumphunter`

Required Worker secrets:
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_WEBHOOK_SECRET`
- `OWNER_TELEGRAM_ID`

KV binding: `APP_KV`

The bot is analytical only. It never submits, modifies or cancels exchange orders.

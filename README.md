# Crypto Pump Hunter V4

Telegram/Cloudflare Worker migration of the legacy Crypto Pump Hunter engine.

## Included features
- Manual multi-coin spot market scan, market analysis, watchlist and connection status.
- Kraken Derivatives perpetual futures scanner (LONG/SHORT) using 1H trend, 4H confirmation and 15M entry timing.
- Original Telegram menus, membership approval, member administration, invite and about screens.
- No exchange trading keys and no order placement.

## Signal and trade lifecycle safeguards
- Futures signals are valid for 60 minutes for a new entry.
- A signal is rejected when the live ticker differs from the closed-candle reference by more than 0.35%.
- Entry is not recorded until the user confirms the signal and sends the actual fill price using `/fill SIGNAL_ID ACTUAL_PRICE`.
- Open trades are stored separately from new scan results. A rejected signal on a later scan cannot alter an existing trade.
- Open trades are checked by the scheduled futures scan using closed 5M candles; monitoring is periodic, not continuous or exchange-native.
- Model exits scale one-third / one-third / remainder at 1.5R / 2.5R / 3.5R. The bot never moves an exchange stop automatically. After manually changing a stop in the exchange, the owner can synchronize the tracking record with `/confirm_stop <ID> <PRICE>`. This command only updates the bot's internal tracking; it does not place or modify exchange orders.
- Reported R results are theoretical and exclude fees, funding, slippage and missed intrabar price touches.

## Futures signal strategy
- The current futures engine combines 1H/4H trend context with 15M entry confirmation.
- EMA20/EMA50, RSI14 and ATR14 are used in trend, momentum, risk and entry evaluation. Volume ratio, 24H change and funding are also used in scoring or filters.
- The scanner is not a Price-Action-only strategy; the live engine's technical-indicator rules are authoritative.
- Kraken Derivatives is the only Futures data provider; there is no fallback provider.

## Runtime configuration
Cloudflare Worker name: `cryptopumphunter`

Required Worker secrets:
- `BOT_TOKEN`
- `WEBHOOK_SECRET`
- `OWNER_TELEGRAM_ID`
- `SIGNAL_DELIVERY_AUTH_SECRET`

KV binding: `APP_KV`

The bot is analytical only. It never submits, modifies or cancels exchange orders.

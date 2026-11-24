# Crypto Pump Hunter V4

Telegram/Cloudflare Worker migration of the legacy Crypto Pump Hunter engine.

## Included features
- Manual multi-coin spot market scan, market analysis, watchlist and connection status.
- Kraken Derivatives perpetual futures scanner (LONG/SHORT) using 4H context, 1H market structure and 15M entry confirmation using Price Action only.
- Original Telegram menus, membership approval, member administration, invite and about screens.
- No exchange trading keys and no order placement.

## Signal and trade lifecycle safeguards
- Futures signals are valid for 60 minutes for a new entry.
- A signal is rejected when the live ticker differs from the closed-candle reference by more than 0.35%.
- Entry is not recorded until the user confirms the signal and sends the actual fill price using `/fill SIGNAL_ID ACTUAL_PRICE`.
- Open trades are stored separately from new scan results. A rejected signal on a later scan cannot alter an existing trade.
- Open trades are checked when a manual futures scan runs; this is not continuous real-time monitoring.
- Model exits scale 40% / 35% / 25% at 1.5R / 2.2R / 3.0R. At +0.75R (halfway to TP1), the bot prompts the user to consider moving the remaining stop to entry; after TP1 it prompts again if needed. The user must move the stop manually in the exchange and confirm it in Telegram.
- Reported R results are theoretical and exclude fees, funding, slippage and missed intrabar price touches.

## Price Action strategy
- Market Structure (HH/HL, LH/LL, BOS and CHOCH), support/resistance rejection, breakout and retest, and candlestick confirmation.
- Futures entries are based on Price Action; RSI, EMA, MACD, ATR, volume and funding are not used as entry filters or scores.
- Kraken Derivatives is the only Futures data provider; there is no fallback provider.

## Runtime configuration
Cloudflare Worker name: `cryptopumphunter`

Required Worker secrets:
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_WEBHOOK_SECRET`
- `OWNER_TELEGRAM_ID`

KV binding: `APP_KV`

The bot is analytical only. It never submits, modifies or cancels exchange orders.

<!-- CI baseline validation: documentation-only change; no runtime code changes. -->

# BTCUSDT Model D — Pure Price Action

Model D is an independent paper-only BTCUSDT strategy. It does not call the production analyzer and does not use EMA, RSI, MACD, ATR, volume filters, or other indicators.

## Signal sequence
1. **4H regime:** two confirmed swing highs and two confirmed swing lows. LONG requires higher highs and higher lows; SHORT requires lower highs and lower lows. Mixed/incomplete structure is neutral.
2. **1H direction:** a candle close through the latest confirmed 1H swing high/low (BOS), only in the direction of the 4H regime. The previous 1H close must still be on the unbroken side.
3. **15M entry:** a liquidity sweep of the previous eight closed candles, reclaim of the swept level, and close beyond the previous candle's opposite extreme. Entry is at the next 15M open.
4. **Risk:** stop beyond the sweep candle extreme. Setups with stop distance above 2% of signal close are rejected. Targets are 1R, 1.75R, and 2.5R, managed by the same paper simulator as A/B/C.

## Comparison controls
- Same BTCUSDT Binance USD-M candles, next-15M-open fills, fee, slippage, partial exits, and max holding time as A/B/C.
- D has a separate pending/open/trade ledger.
- A/B/C retain their existing analyzer and EMA20 15M confirmation.
- The experiment remains paper-only; no keys, order endpoints, production Worker, or live bot behavior are changed.
- Funding and liquidation are not modeled. Results are not evidence of profitability until sufficient closed trades and out-of-sample data exist.

## State
The four-engine run uses `artifacts/btcusdt-four-engine-state.json` and a separate GitHub Actions cache namespace so it cannot reuse or overwrite the three-model run's ledger.


Implementation status: the engine is integrated into the isolated four-model paper runner; automated checks are being rerun after fixture corrections.

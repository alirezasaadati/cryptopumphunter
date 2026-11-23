# Rabbit — Bull Rally Correction SHORT Engine

Rabbit is an experimental counter-trend SHORT strategy. Its only intended regime is a strong, aligned bullish trend on both 1h and 4h. It attempts to capture the first confirmed pullback after an unusually strong 15m rally; it does not predict tops.

## Signal sequence

1. Require 1h and 4h bullish structure: EMA20 above EMA50 and latest closed candle above EMA20 on both timeframes.
2. Detect a recent 8-candle 15m impulse: at least 2.2% and 2.6 ATR from the start of the impulse.
3. Require meaningful overextension: impulse high at least 1.35 ATR above 15m EMA20.
4. Require a closed bearish 15m confirmation candle that closes below the lows of the prior two candles and below EMA9.
5. Require RSI(14) >= 68 and confirmation-candle volume >= 0.75x the prior 20-candle average.
6. Reject stale entries (>0.8% drift), and reject structural stop risk outside 0.2%-5.0%.
7. Place the initial stop above the recent impulse swing high plus 0.2 ATR. Targets are 1R, 1.5R and 2R; first backtest version evaluates full close at 1R to isolate signal quality.

## Explicit non-goals

- No short merely because RSI is high.
- No short while either 1h or 4h trend is not bullish.
- No changes to Kraken/V4.8 strategy logic.
- No production scan integration, alert delivery, or order execution in this initial research stage.

## Validation

Run npm test for pure unit tests. The historical backtest is separate and reports 90d and 180d outcomes using Kraken 5m OHLC, next-5m-open entries, stop-first handling when target and stop occur in the same 5m candle, and a six-hour maximum holding period. Fees, funding, slippage, liquidation and current-volume universe survivorship bias are reported as limitations.

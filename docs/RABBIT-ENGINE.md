# Rabbit v2 — Bull Rally Correction SHORT Engine

Rabbit v2 is an experimental counter-trend SHORT strategy for temporary corrections during an aligned bullish market. It is analysis-only: it does not place orders, deliver alerts, or modify the Kraken/V4.8 engine.

## Signal sequence

1. Require a confirmed bullish BTC 4h regime.
2. Require aligned bullish structure on the traded symbol: 1h and 4h EMA20 above EMA50, with each latest closed candle above EMA20.
3. Search for an 8-candle 15m impulse ending at a fresh strict high. The peak must be no more than four completed 15m bars before the current confirmation candle.
4. Measure the impulse from the open of its first candle to the peak high. Defaults: at least 1.5%, at least 1.8 ATR, and at least 1.2 ATR above EMA20 calculated only from candles before the impulse. RSI(14) is measured at the peak and must be at least 65.
5. Require a closed bearish 15m confirmation candle below EMA9. By default it must also close below the lows of the two preceding candles; this can be disabled for controlled comparison tests.
6. Require confirmation volume at least 0.7x the prior 20-candle average.
7. Reject excessive entry drift (default 1.5%) and structural stop risk outside the configured 0.2%-7.0% range.
8. Stop is above the registered impulse high plus 0.2 ATR measured at the peak. Targets are 1R, 1.5R and 2R; the historical harness currently evaluates a full close at 1R.

## State contract

The engine is pure and returns `nextState` on both eligible and rejected evaluations. The caller must persist that object for every symbol and pass it back as `input.state` on the next candle. The backtest harness does this independently for each symbol.

Each setup is identified by the absolute timestamp of its peak, not an array index. A setup expires after the configured correction delay. A newer valid impulse replaces an older setup even when the newer absolute high is lower. A consumed setup cannot emit a duplicate signal, but does not block a later independent impulse.

15m candle objects must include `time`, `timestamp`, or `openTime` in Unix seconds or milliseconds. Pass only completed candles. OHLCV values are validated before indicator calculations.

## Validation and backtest

Run `node --test scripts/rabbit-engine.test.mjs` for the Rabbit unit suite. Run `node scripts/backtest-rabbit.mjs` for 90d and 180d Kraken Futures tests. The harness:
- processes warm-up candles to initialize setup state and carry any still-open trade lock into each measured window;
- enters at the next 5m candle open after the 15m signal closes;
- records rejection-reason counts;
- uses stop-first handling when stop and target are both touched in one 5m candle;
- uses a six-hour maximum holding period, $10 margin and 10x leverage.

Backtest limitations: fees, slippage, funding, liquidation and portfolio-margin effects are excluded. The top-eight current-volume universe introduces survivorship bias. This is research-only and must not be connected to production signal delivery or order execution without a separate review.

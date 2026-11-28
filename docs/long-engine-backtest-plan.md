# Conservative LONG Engine Research Plan

## Scope and safety boundaries

- Research-only branch: `research/long-engine-conservative-20261128`.
- The existing SHORT strategy, scoring, entry/exit rules, risk controls, and publication paths must remain unchanged.
- LONG signals must not enter production delivery, archives, queues, or member notifications.
- All experiments run offline against historical data or in paper/simulation mode.

## Target trading design

- Entry timeframe: 5 minutes.
- Trend confirmation timeframe: 15 minutes.
- Style: conservative; lower signal frequency is acceptable in exchange for stronger selectivity.
- Initial setup families:
  1. Resistance breakout with a fully closed confirmation candle.
  2. Breakout followed by a successful retest of the broken level.
  3. Pullback completion within an established 15-minute uptrend.

## Candidate filters (hypotheses, not fixed truths)

- 15m trend structure: EMA 20 above EMA 50 and positive EMA 50 slope.
- Directional strength: DI+ above DI-, with ADX threshold tested rather than assumed.
- 5m entry confirmation: closed-candle structure and momentum confirmation.
- Volume: relative volume compared with a rolling baseline.
- BTC regime: market context is a risk modifier, not a blanket permission for every altcoin.
- Volatility/risk: ATR-based stop distance and minimum reward-to-risk feasibility.

Thresholds must be selected only on training/validation windows and then evaluated on untouched out-of-sample periods.

## Backtest correctness requirements

- Use only closed candles; no intrabar look-ahead.
- Align 5m entries to the latest fully closed 15m candle available at that timestamp.
- Model fees on entry and exit, slippage, funding where relevant, and realistic fill assumptions.
- Prevent duplicate entries and overlapping positions per symbol unless explicitly tested.
- Apply symbol universe and liquidity filters using information available at the time, avoiding survivorship bias where data permits.
- Record rejected candidates and rejection reasons, not only executed trades.
- Separate setup-family results and filter-ablation results.

## Experiment sequence

1. Verify historical data coverage, timestamp alignment, missing candles, and symbol universe.
2. Establish a simple baseline for each of the three setup families independently.
3. Add filters one at a time (ablation) to measure incremental value.
4. Tune thresholds on training/validation data only.
5. Run walk-forward and untouched out-of-sample evaluation.
6. Stress test fees, slippage, volatility regimes, and BTC market regimes.
7. Paper-run without production publication.

## Required report

For each setup and combined configuration report:
- trade count and signal count;
- win rate;
- gross and net profit factor;
- expectancy in R;
- average win/loss in R;
- maximum drawdown in R and percent;
- consecutive losses;
- exposure and holding time;
- fee/slippage sensitivity;
- results by symbol, month, volatility regime, and BTC regime;
- out-of-sample and walk-forward results.

## Initial acceptance gates (provisional)

These are research gates, not performance promises:
- positive net expectancy out of sample;
- net profit factor above 1.5 as an initial target;
- drawdown within a pre-agreed risk budget;
- results not dominated by a small number of trades or a single symbol/regime;
- stable behavior under conservative fee and slippage assumptions.

No production activation or change to the SHORT-only publication policy is included in this research phase.

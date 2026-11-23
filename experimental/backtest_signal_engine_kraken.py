#!/usr/bin/env python3
# Isolated historical test: calls the unchanged build()/make_signal() from experimental/signal_engine.py.
import json, os, re, time, sys, importlib.util
from datetime import datetime, timezone
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import numpy as np
import pandas as pd
import requests
_spec = importlib.util.spec_from_file_location('signal_engine_original', Path(__file__).with_name('signal_engine.py'))
engine = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(engine)

BASE = "https://futures.kraken.com"
RES_MS = {"15m": 900_000, "1h": 3_600_000}
DAYS = int(os.getenv("SIGNAL_BACKTEST_DAYS", "60"))
SYMBOL_LIMIT = int(os.getenv("SIGNAL_BACKTEST_SYMBOLS", "10"))
WARMUP_DAYS = 15
FEE_R = 0.05
MAX_BARS = engine.BACKTEST_MAX_BARS
SESSION = requests.Session()
SESSION.headers.update({"accept": "application/json", "user-agent": "signal-engine-isolated-backtest/1.0"})

def get_json(url, params=None):
    last = None
    for attempt in range(5):
        try:
            r = SESSION.get(url, params=params, timeout=35)
            if r.status_code == 429 or r.status_code >= 500:
                time.sleep(1.5 * (attempt + 1))
                continue
            r.raise_for_status()
            data = r.json()
            if data.get("result") == "error" or data.get("errors"):
                raise RuntimeError(f"Kraken API error: {data.get('errors') or data.get('error')}")
            return data
        except Exception as e:
            last = e
            if attempt < 4:
                time.sleep(1.2 * (attempt + 1))
    raise RuntimeError(f"Kraken request failed: {last}")

def get_universe():
    payload = get_json(BASE + "/derivatives/api/v3/tickers")
    tickers = payload.get("tickers")
    if not isinstance(tickers, list):
        raise RuntimeError("Kraken tickers response did not contain a tickers array")
    eligible = []
    for t in tickers:
        sym = str(t.get("symbol", ""))
        if t.get("tag") != "perpetual" or t.get("suspended") is True:
            continue
        if not re.match(r"^(PF|PI)_[A-Z0-9]+USD$", sym):
            continue
        vol = float(t.get("volumeQuote") or 0)
        if vol > 0 and float(t.get("last") or 0) > 0:
            eligible.append((vol, t))
    eligible.sort(key=lambda x: x[0], reverse=True)
    return [x[1] for x in eligible[:SYMBOL_LIMIT]]

def fetch_candles(symbol, resolution, start_ms, end_ms):
    step = RES_MS[resolution]
    chunk_ms = step * 1700
    out = []
    for start in range(start_ms, end_ms, chunk_ms):
        end = min(end_ms, start + chunk_ms)
        data = get_json(
            BASE + "/api/charts/v1/trade/" + requests.utils.quote(symbol, safe="") + "/" + resolution,
            {"from": int(start / 1000), "to": int(end / 1000), "count": 1800}
        )
        rows = data.get("candles")
        if not isinstance(rows, list):
            raise RuntimeError(f"{symbol} {resolution}: missing candles array")
        for x in rows:
            ts = float(x["time"])
            ts_ms = int(ts * 1000 if ts < 1e12 else ts)
            if ts_ms + step > int(datetime.now(timezone.utc).timestamp() * 1000):
                continue
            row = {
                "open_time": pd.Timestamp(ts_ms, unit="ms"),
                "close_time": pd.Timestamp(ts_ms + step, unit="ms"),
                "open": float(x["open"]), "high": float(x["high"]),
                "low": float(x["low"]), "close": float(x["close"]),
                "volume": float(x["volume"])
            }
            if min(row["open"], row["high"], row["low"], row["close"]) <= 0:
                continue
            if row["high"] < row["low"] or row["volume"] < 0:
                continue
            out.append(row)
        if data.get("more_candles") is True:
            raise RuntimeError(f"{symbol} {resolution}: Kraken reports incomplete candle chunk")
    df = pd.DataFrame(out)
    if df.empty:
        return df
    df = df.drop_duplicates("open_time").sort_values("open_time").reset_index(drop=True)
    return df[["open_time", "close_time", "open", "high", "low", "close", "volume"]]

def calc_symbol(ticker, test_start_ms, end_ms):
    symbol = ticker["symbol"]
    warm_start = test_start_ms - WARMUP_DAYS * 86_400_000
    ltf = fetch_candles(symbol, "15m", warm_start, end_ms)
    htf = fetch_candles(symbol, "1h", warm_start, end_ms)
    if len(ltf) < 250 or len(htf) < 250:
        raise RuntimeError(f"insufficient history: 15m={len(ltf)}, 1h={len(htf)}")

    # The signal calculation below is the original source file's build() and make_signal().
    d = engine.build(ltf, htf).reset_index(drop=True)
    trades = []
    i, n = 210, len(d)
    while i < n - 2:
        row = d.iloc[i]
        signal = engine.make_signal(symbol, row)
        if not signal:
            i += 1
            continue
        signal_time = pd.Timestamp(row["close_time"])
        if signal_time.timestamp() * 1000 < test_start_ms:
            i += 1
            continue
        entry = float(d.iloc[i + 1]["open"])
        risk = engine.ATR_SL_MULT * float(row["atr"])
        if not np.isfinite(risk) or risk <= 0:
            i += 1
            continue
        is_long = signal["side"] == "LONG"
        stop = entry - risk if is_long else entry + risk
        target = entry + risk * engine.BACKTEST_RR if is_long else entry - risk * engine.BACKTEST_RR
        outcome, end_i = None, i + 1
        for j in range(i + 1, min(i + 1 + MAX_BARS, n)):
            c = d.iloc[j]
            hit_sl = float(c["low"]) <= stop if is_long else float(c["high"]) >= stop
            hit_tp = float(c["high"]) >= target if is_long else float(c["low"]) <= target
            if hit_sl:  # preserve source's conservative stop-first same-candle rule
                outcome, end_i = -1.0, j
                break
            if hit_tp:
                outcome, end_i = float(engine.BACKTEST_RR), j
                break
        if outcome is None:
            end_i = min(i + MAX_BARS, n - 1)
            px = float(d.iloc[end_i]["close"])
            outcome = ((px - entry) if is_long else (entry - px)) / risk
        outcome -= FEE_R  # preserve source's approximate 0.05R cost
        trades.append({
            "symbol": symbol, "side": signal["side"],
            "signal_time": signal_time.isoformat(),
            "entry": entry, "stop": stop, "target": target,
            "exit_time": pd.Timestamp(d.iloc[end_i]["close_time"]).isoformat(),
            "net_R": round(float(outcome), 6),
            "exit_type": "STOP" if outcome <= -1.0 - FEE_R + 1e-8 else
                         "TARGET" if abs(outcome - (engine.BACKTEST_RR - FEE_R)) < 1e-8 else "TIMEOUT"
        })
        i = end_i + 1
    return {"symbol": symbol, "candles_15m": len(ltf), "candles_1h": len(htf), "trades": trades}

def metrics(trades):
    if not trades:
        return {"trades": 0, "win_rate_pct": None, "avg_R": None, "profit_factor": None, "total_R": 0}
    r = np.array([float(t["net_R"]) for t in trades], dtype=float)
    wins, losses = r[r > 0], r[r <= 0]
    pf = float(wins.sum() / abs(losses.sum())) if len(losses) and abs(losses.sum()) > 0 else (None if not len(wins) else "Infinity")
    eq = np.cumsum(r)
    peak = np.maximum.accumulate(np.r_[0.0, eq])
    dd = peak[1:] - eq
    return {
        "trades": int(len(r)),
        "wins": int((r > 0).sum()), "losses": int((r <= 0).sum()),
        "win_rate_pct": round(float((r > 0).mean() * 100), 2),
        "avg_R": round(float(r.mean()), 4),
        "profit_factor": round(pf, 4) if isinstance(pf, float) else pf,
        "total_R": round(float(r.sum()), 4),
        "max_drawdown_R": round(float(dd.max()) if len(dd) else 0, 4),
        "long_trades": int(sum(t["side"] == "LONG" for t in trades)),
        "short_trades": int(sum(t["side"] == "SHORT" for t in trades))
    }

def main():
    end_ms = int(datetime.now(timezone.utc).timestamp() * 1000)
    test_start_ms = end_ms - DAYS * 86_400_000
    universe = get_universe()
    results, errors = [], []
    for ticker in universe:
        try:
            results.append(calc_symbol(ticker, test_start_ms, end_ms))
        except Exception as e:
            errors.append({"symbol": ticker.get("symbol"), "error": str(e)})
    all_trades = [t for x in results for t in x["trades"]]
    all_trades.sort(key=lambda x: x["signal_time"])
    by_symbol = []
    for x in results:
        by_symbol.append({
            "symbol": x["symbol"], "candles_15m": x["candles_15m"],
            "candles_1h": x["candles_1h"], **metrics(x["trades"])
        })
    report = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "source_file": "experimental/signal_engine.py (copied unchanged from uploaded file)",
        "venue": "Kraken Futures public OHLC candles",
        "period_days": DAYS,
        "period_start": datetime.fromtimestamp(test_start_ms/1000, timezone.utc).isoformat(),
        "period_end": datetime.fromtimestamp(end_ms/1000, timezone.utc).isoformat(),
        "symbols_requested": SYMBOL_LIMIT, "symbols_tested": len(results),
        "strategy_parameters": {
            "LTF": engine.LTF, "HTF": engine.HTF, "ATR_SL_MULT": engine.ATR_SL_MULT,
            "BACKTEST_RR": engine.BACKTEST_RR, "BACKTEST_MAX_BARS": MAX_BARS,
            "ADX_MIN": engine.ADX_MIN, "VOL_MULT": engine.VOL_MULT, "fee_R": FEE_R
        },
        "execution_assumptions": "Signal on closed 15m candle; entry at next 15m open; stop-first if stop and target touch in same candle; maximum 48 bars; mark-to-market at horizon; subtract 0.05R.",
        "metrics": metrics(all_trades), "by_symbol": by_symbol,
        "errors": errors, "trades": all_trades
    }
    Path("artifacts").mkdir(exist_ok=True)
    Path("artifacts/signal-engine-kraken-backtest.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    lines = [
        "# Signal engine — Kraken Futures historical backtest", "",
        f"Period: {report['period_start']} to {report['period_end']} ({DAYS} days)",
        f"Symbols tested: {len(results)}/{SYMBOL_LIMIT}", "",
        "| Metric | Result |", "|---|---:|",
        f"| Trades | {report['metrics']['trades']} |",
        f"| Win rate | {report['metrics']['win_rate_pct']}% |",
        f"| Average R | {report['metrics']['avg_R']} |",
        f"| Profit factor | {report['metrics']['profit_factor']} |",
        f"| Total R | {report['metrics']['total_R']} |",
        f"| Max drawdown (R) | {report['metrics'].get('max_drawdown_R')} |",
        f"| LONG / SHORT | {report['metrics'].get('long_trades')} / {report['metrics'].get('short_trades')} |", "",
        "| Symbol | Trades | Win rate | Avg R | PF | Total R |",
        "|---|---:|---:|---:|---:|---:|"
    ]
    for x in by_symbol:
        lines.append(f"| {x['symbol']} | {x['trades']} | {x['win_rate_pct']} | {x['avg_R']} | {x['profit_factor']} | {x['total_R']} |")
    lines += ["", "## Errors"] + [f"- {x['symbol']}: {x['error']}" for x in errors]
    lines += ["", "## Method notes", report["execution_assumptions"],
              "The signal calculation is delegated to the uploaded source file's unchanged build() and make_signal() functions. No Binance candles are used. The universe is selected by current Kraken perpetual quote volume, so survivorship/universe bias applies. Funding, liquidation, and exchange fees beyond the source's fixed 0.05R estimate are not modeled."]
    Path("artifacts/signal-engine-kraken-backtest.md").write_text("\n".join(lines), encoding="utf-8")
    print(json.dumps({"metrics": report["metrics"], "symbols_tested": len(results), "by_symbol": by_symbol, "errors": errors}, indent=2))
    if not results:
        raise SystemExit("No symbols completed successfully; inspect the error list.")

if __name__ == "__main__":
    main()

# Trigger isolated workflow after workflow registration on default branch.

# Workflow registration is now present on default branch; rerun with corrected setup.

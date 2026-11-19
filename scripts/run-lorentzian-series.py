#!/usr/bin/env python3
"""Run parity-tested jdehorty Lorentzian Classification configurations on OHLC CSV."""
import csv, json, sys
from pathlib import Path
from lorentzian_classification import Bar, Settings, calculate

src, dst, timeframe = sys.argv[1], sys.argv[2], sys.argv[3]
with open(src, newline="") as f:
    rows = list(csv.DictReader(f))
bars = [Bar(time=str(x["time"]), open=float(x["open"]), high=float(x["high"]),
            low=float(x["low"]), close=float(x["close"])) for x in rows]
configs = {
 "h1_default": {},
 "h1_no_kernel": {"use_kernel_filter": False},
 "h1_k12": {"neighbors_count": 12},
 "h1_features4": {"feature_count": 4},
 "m15_default": {},
 "m15_no_kernel": {"use_kernel_filter": False},
}
history_limit = 4000 if timeframe == "h1" else 2000
configs = {k: {"max_bars_back": history_limit, **v} for k,v in configs.items() if k.startswith(timeframe + "_")}
out = {"bar_count": len(bars), "variants": {}}
for name, overrides in configs.items():
    settings = Settings.from_mapping(overrides)
    results = calculate(bars, settings)
    out["variants"][name] = [
      {"direction": int(x.direction), "buy": bool(x.buy), "sell": bool(x.sell),
       "prediction": int(x.prediction), "kernel": float(x.kernel) if x.kernel == x.kernel else None}
      for x in results
    ]
with open(dst, "w") as f:
    json.dump(out, f, separators=(",", ":"))
print(json.dumps({"bars": len(bars), "variants": list(configs)}))

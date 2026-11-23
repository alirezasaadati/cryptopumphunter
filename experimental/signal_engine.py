# -*- coding: utf-8 -*-
"""
موتور سیگنال لانگ/شورت (Trend-Pullback + فیلتر تایم‌فریم بالاتر)
- دیتا: Binance Futures (API عمومی، بدون نیاز به کلید)
- سیگنال: فقط روی کندل «بسته‌شده» (بدون ریپینت)
- خروجی: پیام تلگرام با ورود / حد ضرر / تارگت‌ها
- بک‌تست داخلی برای سنجش وین‌ریت واقعی روی هر جفت‌ارز

نصب:  pip install pandas numpy requests
اجرا (مستقل):  python signal_engine.py
بک‌تست:        python signal_engine.py backtest
"""

import sys
import time
import threading
import logging
import requests
import numpy as np
import pandas as pd

# ============================ تنظیمات ============================
TELEGRAM_TOKEN = "PUT_YOUR_BOT_TOKEN"
TELEGRAM_CHAT_ID = "PUT_YOUR_CHAT_ID"      # آیدی چت/کانال/گروه

BASE_URL = "https://fapi.binance.com"      # اگر مسدود بود: آدرس پروکسی/صرافی دیگر
SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT",
           "ADAUSDT", "DOGEUSDT", "AVAXUSDT", "LINKUSDT", "TRXUSDT"]

LTF = "15m"          # تایم‌فریم ورود
HTF = "1h"           # تایم‌فریم فیلتر روند
CANDLES = 500
SCAN_EVERY_SEC = 30

ATR_SL_MULT = 1.5    # حد ضرر = 1.5 × ATR
RR_TP1 = 1.5         # تارگت اول (نسبت ریسک به ریوارد)
RR_TP2 = 2.5         # تارگت دوم
ADX_MIN = 22         # حداقل قدرت روند
VOL_MULT = 1.1       # حجم باید از میانگین بیشتر باشد
BACKTEST_RR = RR_TP1
BACKTEST_MAX_BARS = 48

logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s | %(levelname)s | %(message)s")
log = logging.getLogger("signals")


# ============================ دیتا ============================
def fetch_klines(symbol, interval, limit=CANDLES):
    r = requests.get(f"{BASE_URL}/fapi/v1/klines",
                     params={"symbol": symbol, "interval": interval, "limit": limit},
                     timeout=15)
    r.raise_for_status()
    cols = ["open_time", "open", "high", "low", "close", "volume", "close_time",
            "qv", "trades", "tbb", "tbq", "ignore"]
    df = pd.DataFrame(r.json(), columns=cols)
    for c in ["open", "high", "low", "close", "volume"]:
        df[c] = df[c].astype(float)
    df["close_time"] = pd.to_datetime(df["close_time"], unit="ms")
    df["open_time"] = pd.to_datetime(df["open_time"], unit="ms")
    # کندل آخر هنوز باز است -> حذف
    now = pd.Timestamp.utcnow().tz_localize(None)
    df = df[df["close_time"] < now].reset_index(drop=True)
    return df[["open_time", "close_time", "open", "high", "low", "close", "volume"]]


# ============================ اندیکاتورها ============================
def ema(s, n):
    return s.ewm(span=n, adjust=False).mean()


def rsi(close, n=14):
    d = close.diff()
    up = d.clip(lower=0).ewm(alpha=1 / n, adjust=False).mean()
    dn = (-d.clip(upper=0)).ewm(alpha=1 / n, adjust=False).mean()
    rs = up / dn.replace(0, np.nan)
    return 100 - 100 / (1 + rs)


def atr(df, n=14):
    pc = df["close"].shift(1)
    tr = pd.concat([df["high"] - df["low"],
                    (df["high"] - pc).abs(),
                    (df["low"] - pc).abs()], axis=1).max(axis=1)
    return tr.ewm(alpha=1 / n, adjust=False).mean()


def adx(df, n=14):
    up = df["high"].diff()
    dn = -df["low"].diff()
    plus = np.where((up > dn) & (up > 0), up, 0.0)
    minus = np.where((dn > up) & (dn > 0), dn, 0.0)
    a = atr(df, n)
    pdi = 100 * pd.Series(plus, index=df.index).ewm(alpha=1 / n, adjust=False).mean() / a
    mdi = 100 * pd.Series(minus, index=df.index).ewm(alpha=1 / n, adjust=False).mean() / a
    dx = 100 * (pdi - mdi).abs() / (pdi + mdi).replace(0, np.nan)
    return dx.ewm(alpha=1 / n, adjust=False).mean()


# ============================ منطق سیگنال ============================
def build(ltf: pd.DataFrame, htf: pd.DataFrame) -> pd.DataFrame:
    """اندیکاتورها + ستون‌های long_sig / short_sig را می‌سازد."""
    h = htf.copy()
    h["e50"], h["e200"] = ema(h["close"], 50), ema(h["close"], 200)
    h["htf_trend"] = np.where((h["close"] > h["e200"]) & (h["e50"] > h["e200"]), 1,
                      np.where((h["close"] < h["e200"]) & (h["e50"] < h["e200"]), -1, 0))

    d = ltf.copy()
    d["ema20"], d["ema50"], d["ema200"] = ema(d["close"], 20), ema(d["close"], 50), ema(d["close"], 200)
    d["rsi"] = rsi(d["close"])
    d["atr"] = atr(d)
    d["adx"] = adx(d)
    macd = ema(d["close"], 12) - ema(d["close"], 26)
    d["hist"] = macd - ema(macd, 9)
    d["vol_ma"] = d["volume"].rolling(20).mean()
    d["rsi_min5"] = d["rsi"].rolling(5).min().shift(1)
    d["rsi_max5"] = d["rsi"].rolling(5).max().shift(1)

    # فقط تایم‌فریم بالای «بسته‌شده» به کندل فعلی نسبت داده می‌شود (بدون نگاه به آینده)
    d = pd.merge_asof(d.sort_values("close_time"),
                      h[["close_time", "htf_trend"]].sort_values("close_time"),
                      on="close_time", direction="backward")
    d["htf_trend"] = d["htf_trend"].fillna(0)

    not_extended = (d["close"] - d["ema20"]).abs() < 2 * d["atr"]
    strong = (d["adx"] > ADX_MIN) & (d["volume"] > d["vol_ma"] * VOL_MULT)

    d["long_sig"] = (
        (d["htf_trend"] == 1) & (d["ema20"] > d["ema50"]) & (d["ema50"] > d["ema200"])
        & (d["rsi_min5"] < 45) & (d["rsi"] > 50)
        & (d["close"] > d["ema20"]) & (d["close"] > d["open"])
        & (d["hist"] > d["hist"].shift(1)) & strong & not_extended
    )
    d["short_sig"] = (
        (d["htf_trend"] == -1) & (d["ema20"] < d["ema50"]) & (d["ema50"] < d["ema200"])
        & (d["rsi_max5"] > 55) & (d["rsi"] < 50)
        & (d["close"] < d["ema20"]) & (d["close"] < d["open"])
        & (d["hist"] < d["hist"].shift(1)) & strong & not_extended
    )
    return d


def make_signal(symbol, row):
    side = "LONG" if row["long_sig"] else "SHORT" if row["short_sig"] else None
    if not side:
        return None
    entry, a = row["close"], row["atr"]
    risk = ATR_SL_MULT * a
    sgn = 1 if side == "LONG" else -1
    return {
        "symbol": symbol, "side": side, "time": row["close_time"],
        "entry": entry,
        "sl": entry - sgn * risk,
        "tp1": entry + sgn * risk * RR_TP1,
        "tp2": entry + sgn * risk * RR_TP2,
        "rsi": row["rsi"], "adx": row["adx"],
    }


def fmt_price(p):
    return f"{p:.6f}".rstrip("0").rstrip(".") if p < 1 else f"{p:,.4f}".rstrip("0").rstrip(".")


def format_message(s):
    emoji = "🟢" if s["side"] == "LONG" else "🔴"
    return (
        f"{emoji} <b>سیگنال {s['side']}</b> — <code>{s['symbol']}</code>\n"
        f"⏱ تایم‌فریم: {LTF} (فیلتر روند {HTF})\n\n"
        f"📍 ورود: <code>{fmt_price(s['entry'])}</code>\n"
        f"🛑 حد ضرر: <code>{fmt_price(s['sl'])}</code>\n"
        f"🎯 تارگت ۱: <code>{fmt_price(s['tp1'])}</code>\n"
        f"🎯 تارگت ۲: <code>{fmt_price(s['tp2'])}</code>\n\n"
        f"RSI: {s['rsi']:.1f} | ADX: {s['adx']:.1f}\n"
        f"⚠️ ریسک هر معامله حداکثر ۱٪ سرمایه. توصیه مالی نیست."
    )


# ============================ تلگرام ============================
def telegram_send(text):
    try:
        r = requests.post(
            f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/sendMessage",
            json={"chat_id": TELEGRAM_CHAT_ID, "text": text, "parse_mode": "HTML"},
            timeout=15)
        if not r.ok:
            log.error("Telegram error: %s", r.text)
    except Exception as e:
        log.error("Telegram send failed: %s", e)


# ============================ اسکنر ============================
_last_signal_time = {}   # جلوگیری از ارسال تکراری


def scan_once(send=telegram_send):
    for sym in SYMBOLS:
        try:
            ltf, htf = fetch_klines(sym, LTF), fetch_klines(sym, HTF)
            if len(ltf) < 250 or len(htf) < 250:
                continue
            d = build(ltf, htf)
            row = d.iloc[-1]                       # آخرین کندل بسته‌شده
            sig = make_signal(sym, row)
            if sig and _last_signal_time.get(sym) != sig["time"]:
                _last_signal_time[sym] = sig["time"]
                log.info("Signal %s %s", sym, sig["side"])
                send(format_message(sig))
        except Exception as e:
            log.warning("scan %s failed: %s", sym, e)
        time.sleep(0.3)


def run_forever(send=telegram_send):
    log.info("Scanner started on %d symbols", len(SYMBOLS))
    while True:
        t0 = time.time()
        scan_once(send)
        time.sleep(max(1, SCAN_EVERY_SEC - (time.time() - t0)))


def start_in_background(send=telegram_send):
    """برای اضافه کردن به ربات فعلی‌ات: start_in_background(your_send_func)"""
    t = threading.Thread(target=run_forever, args=(send,), daemon=True)
    t.start()
    return t


# ============================ بک‌تست ============================
def backtest(symbol, rr=BACKTEST_RR):
    ltf, htf = fetch_klines(symbol, LTF, 1500), fetch_klines(symbol, HTF, 1500)
    d = build(ltf, htf).reset_index(drop=True)
    results, i, n = [], 210, len(d)
    while i < n - 2:
        r = d.iloc[i]
        sig = make_signal(symbol, r)
        if not sig:
            i += 1
            continue
        entry = d.iloc[i + 1]["open"]              # ورود واقعی‌تر: باز شدن کندل بعد
        risk = ATR_SL_MULT * r["atr"]
        long = sig["side"] == "LONG"
        sl = entry - risk if long else entry + risk
        tp = entry + risk * rr if long else entry - risk * rr
        outcome, end = None, i + 1
        for j in range(i + 1, min(i + 1 + BACKTEST_MAX_BARS, n)):
            c = d.iloc[j]
            hit_sl = c["low"] <= sl if long else c["high"] >= sl
            hit_tp = c["high"] >= tp if long else c["low"] <= tp
            if hit_sl:                              # محافظه‌کارانه: اگر هر دو، ضرر
                outcome, end = -1.0, j
                break
            if hit_tp:
                outcome, end = rr, j
                break
        if outcome is None:
            end = min(i + BACKTEST_MAX_BARS, n - 1)
            px = d.iloc[end]["close"]
            outcome = ((px - entry) if long else (entry - px)) / risk
        outcome -= 0.05                             # هزینه کارمزد/اسلیپیج تقریبی (R)
        results.append(outcome)
        i = end + 1
    if not results:
        return {"symbol": symbol, "trades": 0}
    res = np.array(results)
    wins, losses = res[res > 0], res[res <= 0]
    return {
        "symbol": symbol, "trades": len(res),
        "winrate_%": round(100 * len(wins) / len(res), 1),
        "avg_R": round(res.mean(), 3),
        "profit_factor": round(wins.sum() / abs(losses.sum()), 2) if len(losses) else float("inf"),
        "total_R": round(res.sum(), 2),
    }


def run_backtest():
    rows = []
    for s in SYMBOLS:
        try:
            rows.append(backtest(s))
        except Exception as e:
            log.warning("backtest %s failed: %s", s, e)
    print(pd.DataFrame(rows).to_string(index=False))


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "backtest":
        run_backtest()
    else:
        run_forever()
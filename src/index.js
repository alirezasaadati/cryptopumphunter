
const API = "https://api.telegram.org";
const COINLORE = "https://api.coinlore.net/api";
const KRAKEN = "https://api.kraken.com/0/public";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return new Response("Crypto Pump Hunter is running.");
    }

    // Test market-data sources
    if (url.pathname === "/testdata" && request.method === "GET") {
      if (!env.SETUP_KEY || url.searchParams.get("key") !== env.SETUP_KEY) {
        return new Response("Unauthorized", { status: 401 });
      }

      const [kraken, coinlore] = await Promise.all([
        fetch(KRAKEN + "/Time").catch(() => null),
        fetch(COINLORE + "/tickers/?start=0&limit=10").catch(() => null)
      ]);

      let krakenOK = false;
      let coinloreCount = null;

      if (kraken?.ok) {
        const data = await kraken.json();
        krakenOK = !data.error?.length && !!data.result?.unixtime;
      }

      if (coinlore?.ok) {
        const data = await coinlore.json();
        coinloreCount = Array.isArray(data.data) ? data.data.length : null;
      }

      return Response.json({
        kraken: {
          ok: krakenOK,
          status: kraken?.status ?? "network_error"
        },
        coinlore: {
          ok: coinloreCount !== null,
          status: coinlore?.status ?? "network_error",
          assets: coinloreCount
        }
      });
    }

    // Register Telegram webhook
    if (url.pathname === "/register" && request.method === "GET") {
      if (!env.SETUP_KEY || url.searchParams.get("key") !== env.SETUP_KEY) {
        return new Response("Unauthorized", { status: 401 });
      }

      const result = await telegram(env, "setWebhook", {
        url: url.origin + "/telegram",
        secret_token: env.WEBHOOK_SECRET,
        allowed_updates: ["message"]
      });

      return Response.json(result);
    }

    // Telegram webhook
    if (url.pathname === "/telegram" && request.method === "POST") {
      if (
        !env.WEBHOOK_SECRET ||
        request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.WEBHOOK_SECRET
      ) {
        return new Response("Forbidden", { status: 403 });
      }

      const update = await request.json();
      const message = update.message;

      if (!message?.text) return new Response("OK");

      const chatId = String(message.chat.id);
      const ownerId = String(env.OWNER_ID);

      if (chatId !== ownerId || String(message.from?.id) !== ownerId) {
        ctx.waitUntil(sendMessage(env, chatId, "⛔ این ربات خصوصی است."));
        return new Response("OK");
      }

      const command = message.text.trim().split(/\s+/)[0].split("@")[0];

      if (command === "/start") {
        ctx.waitUntil(sendMessage(
          env,
          chatId,
          "🚀 Crypto Pump Hunter نسخه جدید فعال شد!\n\n" +
          "/scan - اسکن بازار\n" +
          "/status - وضعیت ربات\n" +
          "/help - راهنما"
        ));
      } else if (command === "/status") {
        ctx.waitUntil(sendMessage(
          env,
          chatId,
          "✅ ربات فعال است.\nاسکن فقط با دستور /scan انجام می‌شود."
        ));
      } else if (command === "/help") {
        ctx.waitUntil(sendMessage(
          env,
          chatId,
          "دستورهای ربات:\n/scan - شروع اسکن بازار\n/status - وضعیت ربات"
        ));
      } else if (command === "/scan") {
        ctx.waitUntil((async () => {
          await sendMessage(env, chatId, "🔎 اسکن بازار شروع شد...");
          await runScan(env, chatId);
        })());
      }

      return new Response("OK");
    }

    return new Response("Not found", { status: 404 });
  }
};

// ---------------- TELEGRAM ----------------

async function telegram(env, method, body) {
  const response = await fetch(`${API}/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  return response.json();
}

async function sendMessage(env, chatId, text) {
  return telegram(env, "sendMessage", {
    chat_id: chatId,
    text,
    disable_web_page_preview: true
  });
}

// ---------------- MARKET DATA ----------------

async function getCoinLore() {
  const pages = [0, 100, 200, 300, 400];

  const responses = await Promise.allSettled(
    pages.map(async start => {
      const response = await fetch(
        `${COINLORE}/tickers/?start=${start}&limit=100`
      );

      if (!response.ok) {
        throw new Error("CoinLore HTTP " + response.status);
      }

      const data = await response.json();
      return Array.isArray(data.data) ? data.data : [];
    })
  );

  const coins = responses.flatMap(r =>
    r.status === "fulfilled" ? r.value : []
  );

  if (!coins.length) {
    throw new Error("CoinLore unavailable");
  }

  return coins;
}

async function getKrakenPairs() {
  const response = await fetch(KRAKEN + "/AssetPairs");

  if (!response.ok) {
    throw new Error("Kraken AssetPairs HTTP " + response.status);
  }

  const data = await response.json();

  if (data.error?.length) {
    throw new Error("Kraken: " + data.error.join(", "));
  }

  return data.result || {};
}

// ---------------- SYMBOL MATCHING ----------------

function normalizeSymbol(symbol) {
  const s = String(symbol || "").toUpperCase();

  const aliases = {
    XBT: "BTC",
    XXBT: "BTC",
    XDG: "DOGE",
    XXDG: "DOGE",
    XETH: "ETH",
    XXLM: "XLM",
    XXRP: "XRP"
  };

  return aliases[s] || s;
}

function findKrakenPair(symbol, pairs) {
  const target = normalizeSymbol(symbol);
  const matches = [];

  for (const [key, pair] of Object.entries(pairs)) {
    if (!pair.wsname || !pair.altname) continue;
    if (pair.status && pair.status !== "online") continue;

    const parts = pair.wsname.split("/");
    if (parts.length !== 2) continue;

    const base = normalizeSymbol(parts[0]);
    const quote = parts[1].toUpperCase();

    if (base !== target) continue;
    if (!["USD", "USDT", "USDC"].includes(quote)) continue;

    const priority = quote === "USD" ? 0 : quote === "USDT" ? 1 : 2;

    matches.push({
      key,
      altname: pair.altname,
      priority
    });
  }

  matches.sort((a, b) => a.priority - b.priority);
  return matches[0] || null;
}

// ---------------- KRAKEN CANDLES ----------------

async function getCandles(pair) {
  const url =
    `${KRAKEN}/OHLC?pair=${encodeURIComponent(pair)}&interval=60`;

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error("Kraken OHLC HTTP " + response.status);
  }

  const data = await response.json();

  if (data.error?.length) {
    throw new Error(data.error.join(", "));
  }

  const key = Object.keys(data.result || {})
    .find(k => k !== "last");

  if (!key) throw new Error("No candle data");

  const candles = data.result[key];

  // Remove the currently forming candle
  return candles.slice(0, -1).map(c => ({
    time: Number(c[0]),
    open: Number(c[1]),
    high: Number(c[2]),
    low: Number(c[3]),
    close: Number(c[4]),
    volume: Number(c[6])
  })).filter(c =>
    c.close > 0 &&
    c.high > 0 &&
    c.low > 0
  );
}

// ---------------- TECHNICAL INDICATORS ----------------

function calculateEMA(values, period) {
  if (values.length < period) return null;

  const multiplier = 2 / (period + 1);

  let ema = values
    .slice(0, period)
    .reduce((a, b) => a + b, 0) / period;

  for (let i = period; i < values.length; i++) {
    ema = (values[i] - ema) * multiplier + ema;
  }

  return ema;
}

function calculateRSI(values, period = 14) {
  if (values.length <= period) return null;

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const diff = values[i] - values[i - 1];

    if (diff > 0) gains += diff;
    else losses -= diff;
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (let i = period + 1; i < values.length; i++) {
    const diff = values[i] - values[i - 1];

    avgGain = (avgGain * (period - 1) + Math.max(diff, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-diff, 0)) / period;
  }

  if (avgLoss === 0) return 100;

  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

// ---------------- ANALYSIS ----------------

function analyzeCoin(coin, candles) {
  if (!candles || candles.length < 55) return null;

  const closes = candles.map(c => c.close);
  const price = closes[closes.length - 1];

  const ema20 = calculateEMA(closes, 20);
  const ema50 = calculateEMA(closes, 50);
  const rsi = calculateRSI(closes, 14);

  if (!ema20 || !ema50 || rsi === null) return null;

  const recent = candles.slice(-24);
  const previous = candles.slice(-24, -6);

  const support = Math.min(...recent.map(c => c.low));
  const resistance = Math.max(...recent.slice(0, -1).map(c => c.high));

  const recentVolume = candles.slice(-6)
    .reduce((sum, c) => sum + c.volume, 0) / 6;

  const previousVolume = previous.length
    ? previous.reduce((sum, c) => sum + c.volume, 0) / previous.length
    : 0;

  const volumeRatio = previousVolume > 0
    ? recentVolume / previousVolume
    : 0;

  const rangeHigh = Math.max(...recent.map(c => c.high));
  const rangeLow = Math.min(...recent.map(c => c.low));

  const rangePercent = ((rangeHigh - rangeLow) / price) * 100;

  const nearSupport = price > 0 &&
    ((price - support) / price) * 100 <= 2.5;

  const breakout = price > resistance * 1.002 &&
    volumeRatio >= 1.5;

  const unusualVolume = volumeRatio >= 1.5;

  const accumulation =
    rangePercent < 8 &&
    volumeRatio >= 1.2 &&
    rsi >= 40 &&
    rsi <= 62;

  let score = 30;
  const reasons = [];

  if (volumeRatio >= 2) {
    score += 15;
    reasons.push("جهش حجم معاملات");
  } else if (volumeRatio >= 1.5) {
    score += 9;
    reasons.push("افزایش حجم معاملات");
  }

  if (rsi >= 45 && rsi <= 65) {
    score += 10;
    reasons.push("RSI مناسب");
  } else if (rsi > 70) {
    score -= 10;
    reasons.push("RSI در محدوده اشباع خرید");
  } else if (rsi < 30) {
    score += 3;
    reasons.push("RSI در محدوده اشباع فروش");
  }

  if (price > ema20 && ema20 > ema50) {
    score += 15;
    reasons.push("روند صعودی EMA");
  } else if (price > ema20) {
    score += 6;
    reasons.push("قیمت بالاتر از EMA20");
  } else {
    score -= 5;
  }

  if (accumulation) {
    score += 12;
    reasons.push("احتمال فشردگی و انباشت");
  }

  if (nearSupport) {
    score += 8;
    reasons.push("نزدیک حمایت");
  }

  if (breakout) {
    score += 12;
    reasons.push("شکست مقاومت همراه حجم");
  }

  if (coin.change24 < -15) score -= 10;

  score = Math.max(0, Math.min(100, score));

  const stop = Math.min(
    support * 0.985,
    price * 0.94
  );

  const risk = price - stop;

  const target1 = price + risk * 1.5;
  const target2 = price + risk * 2.5;

  let entry = "انتظار برای پولبک به EMA20";

  if (nearSupport) {
    entry = "بررسی ورود نزدیک حمایت";
  } else if (breakout) {
    entry = "انتظار برای تثبیت بالای مقاومت شکسته‌شده";
  }

  return {
    name: coin.name,
    symbol: coin.symbol,
    price,
    marketCap: coin.marketCap,
    volume24: coin.volume24,
    change24: coin.change24,
    rsi,
    ema20,
    ema50,
    support,
    resistance,
    stop,
    target1,
    target2,
    volumeRatio,
    accumulation,
    unusualVolume,
    breakout,
    score,
    entry,
    reasons
  };
}

// ---------------- FULL SCAN ----------------

async function runScan(env, chatId) {
  try {
    await sendMessage(
      env,
      chatId,
      "📡 دریافت اطلاعات بازار و بررسی منابع..."
    );

    const sourceResults = await Promise.allSettled([
      getCoinLore(),
      getKrakenPairs()
    ]);

    const coins = sourceResults[0].status === "fulfilled"
      ? sourceResults[0].value
      : [];

    const pairs = sourceResults[1].status === "fulfilled"
      ? sourceResults[1].value
      : {};

    if (!coins.length) {
      await sendMessage(
        env,
        chatId,
        "❌ دریافت اطلاعات CoinLore ناموفق بود.\n" +
        String(sourceResults[0].reason || "")
      );
      return;
    }

    if (!Object.keys(pairs).length) {
      await sendMessage(
        env,
        chatId,
        "❌ دریافت فهرست جفت‌های معاملاتی Kraken ناموفق بود."
      );
      return;
    }

    // Market-cap and liquidity filters
    const candidates = coins.map(c => ({
      name: c.name,
      symbol: String(c.symbol || "").toUpperCase(),
      price: Number(c.price_usd || 0),
      marketCap: Number(c.market_cap_usd || 0),
      volume24: Number(c.volume24 || 0),
      change24: Number(c.percent_change_24h || 0),
      change1h: Number(c.percent_change_1h || 0),
      change7d: Number(c.percent_change_7d || 0)
    })).filter(c =>
      c.symbol &&
      c.price > 0 &&
      c.marketCap >= 5000000 &&
      c.marketCap <= 500000000 &&
      c.volume24 >= 100000
    );

    // Sort by liquidity relative to market cap
    candidates.sort((a, b) =>
      (b.volume24 / b.marketCap) -
      (a.volume24 / a.marketCap)
    );

    // Only analyze a limited number of Kraken pairs
    const selected = [];

    for (const coin of candidates) {
      const pair = findKrakenPair(coin.symbol, pairs);
      if (!pair) continue;

      selected.push({ coin, pair });

      if (selected.length >= 12) break;
    }

    if (!selected.length) {
      await sendMessage(
        env,
        chatId,
        "⚠️ ارز مناسبی با جفت معاملاتی قابل بررسی در Kraken پیدا نشد."
      );
      return;
    }

    await sendMessage(
      env,
      chatId,
      `📊 ${selected.length} ارز برای تحلیل تکنیکال انتخاب شدند...`
    );

    const analyzed = [];

    // Sequential requests to reduce API pressure
    for (const item of selected) {
      try {
        const candles = await getCandles(item.pair.altname);
        const result = analyzeCoin(item.coin, candles);

        if (result) analyzed.push(result);
      } catch (error) {
        // Continue scanning other coins
      }
    }

    if (!analyzed.length) {
      await sendMessage(
        env,
        chatId,
        "❌ اطلاعات کندل کافی از Kraken دریافت نشد."
      );
      return;
    }

    analyzed.sort((a, b) => b.score - a.score);

    const top = analyzed.slice(0, 10);

    let output = "🚀 CRYPTO PUMP HUNTER\n";
    output += "━━━━━━━━━━━━━━━━━━\n";
    output += `فرصت‌های تحلیل‌شده: ${analyzed.length}\n`;
    output += "فیلتر مارکت‌کپ: 5 تا 500 میلیون دلار\n\n";

    for (let i = 0; i < top.length; i++) {
      const c = top[i];

      output += `${i + 1}) ${c.name} (${c.symbol})\n`;
      output += `💵 قیمت: $${formatPrice(c.price)}\n`;
      output += `🏦 مارکت‌کپ: $${compact(c.marketCap)}\n`;
      output += `📊 تغییر 24h: ${c.change24.toFixed(2)}%\n`;
      output += `📈 RSI: ${c.rsi.toFixed(1)}\n`;
      output += `EMA20: $${formatPrice(c.ema20)}\n`;
      output += `EMA50: $${formatPrice(c.ema50)}\n`;
      output += `📦 نسبت حجم اخیر: ${c.volumeRatio.toFixed(2)}x\n`;
      output += `🟢 حمایت: $${formatPrice(c.support)}\n`;
      output += `🔴 مقاومت: $${formatPrice(c.resistance)}\n`;
      output += `🎯 امتیاز: ${c.score}/100\n`;
      output += `📍 ورود: ${c.entry}\n`;
      output += `🛑 حد ضرر محاسباتی: $${formatPrice(c.stop)}\n`;
      output += `🎯 هدف اول: $${formatPrice(c.target1)}\n`;
      output += `🎯 هدف دوم: $${formatPrice(c.target2)}\n`;

      if (c.accumulation) output += "🧩 احتمال انباشت: بله\n";
      if (c.unusualVolume) output += "🔥 حجم غیرعادی: بله\n";
      if (c.breakout) output += "🚀 شکست مقاومت: بله\n";

      output += `🧠 دلایل: ${c.reasons.join("، ") || "سیگنال محدود"}\n`;
      output += "━━━━━━━━━━━━━━━━━━\n";
    }

    output +=
      "\n⚠️ این خروجی تحلیل الگوریتمی است، نه تضمین سود.\n" +
      "تحلیل تکنیکال فقط برای جفت‌های قابل دسترس Kraken انجام شده است.";

    await sendMessage(env, chatId, output);

  } catch (error) {
    await sendMessage(
      env,
      chatId,
      "❌ خطا در اسکن:\n" + String(error).slice(0, 500)
    );
  }
}

// ---------------- FORMATTING ----------------

function compact(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return Number(n).toFixed(0);
}

function formatPrice(n) {
  if (!Number.isFinite(n)) return "N/A";
  if (n >= 1000) return n.toFixed(2);
  if (n >= 1) return n.toFixed(4);
  if (n >= 0.01) return n.toFixed(5);
  return n.toPrecision(5);
}

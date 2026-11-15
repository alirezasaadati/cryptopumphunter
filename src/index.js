
const CONFIG = {
  COINLORE_PAGES: [0, 100, 200],
  MAX_CANDIDATES: 24,
  MAX_RESULTS: 10,
  CONCURRENCY: 3,
  MIN_MARKET_CAP: 1000000,
  MAX_MARKET_CAP: 500000000,
  MIN_VOLUME: 100000,
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return new Response("Crypto Pump Hunter is running.");
    }

    if (url.pathname === "/testdata" && request.method === "GET") {
      if (!env.SETUP_KEY || url.searchParams.get("key") !== env.SETUP_KEY) {
        return new Response("Unauthorized", { status: 401 });
      }

      const [kraken, coinlore] = await Promise.all([
        fetch("https://api.kraken.com/0/public/Time").catch(() => null),
        fetch("https://api.coinlore.net/api/tickers/?start=0&limit=10").catch(() => null)
      ]);

      let krakenTime = null;
      let coinCount = null;

      if (kraken?.ok) {
        const data = await kraken.json();
        krakenTime = data.result?.unixtime ?? null;
      }

      if (coinlore?.ok) {
        const data = await coinlore.json();
        coinCount = data.data?.length ?? null;
      }

      return Response.json({
        kraken: {
          ok: krakenTime !== null,
          status: kraken?.status ?? "network_error"
        },
        coinlore: {
          ok: coinCount !== null,
          status: coinlore?.status ?? "network_error",
          assets: coinCount
        }
      });
    }

    if (url.pathname === "/register" && request.method === "GET") {
      if (!env.SETUP_KEY || url.searchParams.get("key") !== env.SETUP_KEY) {
        return new Response("Unauthorized", { status: 401 });
      }

      if (!env.BOT_TOKEN || !env.WEBHOOK_SECRET) {
        return Response.json({ ok: false, error: "Missing bot settings" });
      }

      const webhookURL = `${url.origin}/telegram`;

      const result = await telegramAPI(env, "setWebhook", {
        url: webhookURL,
        secret_token: env.WEBHOOK_SECRET,
        allowed_updates: ["message"]
      });

      return Response.json(result);
    }

    if (url.pathname === "/telegram" && request.method === "POST") {
      if (
        !env.WEBHOOK_SECRET ||
        request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.WEBHOOK_SECRET
      ) {
        return new Response("Unauthorized", { status: 401 });
      }

      const update = await request.json().catch(() => null);
      const message = update?.message;
      const chatId = message?.chat?.id;
      const text = (message?.text || "").trim();

      if (!chatId || !text) {
        return new Response("OK");
      }

      if (text === "/start" || text === "/help") {
        await sendMessage(env, chatId,
          "🤖 <b>Crypto Pump Hunter</b>\n\n" +
          "/scan - شروع اسکن بازار\n" +
          "/status - وضعیت ربات\n" +
          "/help - راهنما\n\n" +
          "اسکن فقط با دستور شما اجرا می‌شود."
        );
        return new Response("OK");
      }

      if (text === "/status") {
        await sendMessage(env, chatId,
          "✅ ربات فعال است.\n" +
          "📊 منابع داده: Kraken و CoinLore\n" +
          "⏱ اسکن فقط با دستور /scan انجام می‌شود."
        );
        return new Response("OK");
      }

      if (text === "/scan") {
        if (env.OWNER_ID && String(chatId) !== String(env.OWNER_ID)) {
          await sendMessage(env, chatId, "⛔ اجازه استفاده از اسکن را ندارید.");
          return new Response("OK");
        }

        await sendMessage(env, chatId,
          "🔎 اسکن بازار شروع شد...\n" +
          "لطفاً کمی صبر کنید."
        );

        try {
          const report = await runScan();
          await sendLongMessage(env, chatId, report);
        } catch (error) {
          await sendMessage(env, chatId,
            "❌ خطا در اسکن بازار:\n" + escapeHTML(error.message || "Unknown error")
          );
        }

        return new Response("OK");
      }

      return new Response("OK");
    }

    return new Response("Not found", { status: 404 });
  }
};

async function telegramAPI(env, method, body) {
  const response = await fetch(
    `https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    }
  );

  return await response.json();
}

async function sendMessage(env, chatId, text) {
  return telegramAPI(env, "sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true
  });
}

async function sendLongMessage(env, chatId, text) {
  const limit = 3800;

  for (let i = 0; i < text.length; i += limit) {
    await sendMessage(env, chatId, text.slice(i, i + limit));
  }
}

function escapeHTML(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

async function fetchJSON(url) {
  const response = await fetch(url, {
    headers: { "Accept": "application/json" }
  });

  if (!response.ok) {
    throw new Error(`API HTTP ${response.status}`);
  }

  return response.json();
}

async function getCoinLoreCoins() {
  const pages = await Promise.all(
    CONFIG.COINLORE_PAGES.map(async start => {
      try {
        const result = await fetchJSON(
          `https://api.coinlore.net/api/tickers/?start=${start}&limit=100`
        );
        return result.data || [];
      } catch {
        return [];
      }
    })
  );

  const coins = pages.flat();

  const unique = new Map();
  for (const coin of coins) {
    if (coin.symbol && !unique.has(coin.symbol)) {
      unique.set(coin.symbol, coin);
    }
  }

  return [...unique.values()];
}

async function getKrakenPairs() {
  const data = await fetchJSON(
    "https://api.kraken.com/0/public/AssetPairs"
  );

  if (data.error?.length) {
    throw new Error("Kraken pair list unavailable");
  }

  return Object.values(data.result || {});
}

function normalizeSymbol(symbol) {
  const value = String(symbol || "").toUpperCase();
  return value === "XBT" ? "BTC" : value;
}

function findKrakenPair(symbol, pairs) {
  const wanted = normalizeSymbol(symbol);

  const matches = pairs.filter(pair => {
    const wsname = pair.wsname || "";
    const parts = wsname.split("/");
    if (parts.length !== 2) return false;

    const base = normalizeSymbol(parts[0]);
    const quote = parts[1].toUpperCase();

    return base === wanted && ["USD", "USDT"].includes(quote);
  });

  if (!matches.length) return null;

  matches.sort((a, b) => {
    const aq = (a.wsname || "").endsWith("/USD") ? 0 : 1;
    const bq = (b.wsname || "").endsWith("/USD") ? 0 : 1;
    return aq - bq;
  });

  return matches[0].altname || matches[0].wsname;
}

async function getCandles(pair) {
  const url =
    `https://api.kraken.com/0/public/OHLC?pair=${encodeURIComponent(pair)}&interval=60`;

  const data = await fetchJSON(url);

  if (data.error?.length) {
    throw new Error("Kraken candle error");
  }

  const key = Object.keys(data.result || {}).find(k => k !== "last");
  if (!key || !data.result[key]) {
    throw new Error("No candle data");
  }

  return data.result[key].map(row => ({
    time: Number(row[0]),
    open: Number(row[1]),
    high: Number(row[2]),
    low: Number(row[3]),
    close: Number(row[4]),
    volume: Number(row[6])
  }));
}

function calculateEMA(values, period) {
  if (values.length < period) return null;

  const multiplier = 2 / (period + 1);
  let ema = values.slice(0, period).reduce((a, b) => a + b, 0) / period;

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
    const change = values[i] - values[i - 1];
    if (change > 0) gains += change;
    else losses -= change;
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (let i = period + 1; i < values.length; i++) {
    const change = values[i] - values[i - 1];
    const gain = Math.max(change, 0);
    const loss = Math.max(-change, 0);

    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgLoss === 0) return 100;

  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

function analyzeCandles(candles) {
  if (!candles || candles.length < 60) {
    throw new Error("Not enough candle history");
  }

  // آخرین کندل ممکن است هنوز بسته نشده باشد.
  const closed = candles.slice(0, -1);

  const closes = closed.map(c => c.close);
  const last = closed[closed.length - 1];
  const price = last.close;

  const ema20 = calculateEMA(closes, 20);
  const ema50 = calculateEMA(closes, 50);
  const rsi = calculateRSI(closes, 14);

  const recent = closed.slice(-24);
  const support = Math.min(...recent.map(c => c.low));
  const resistance = Math.max(...recent.map(c => c.high));

  const previousVolumes = closed.slice(-22, -2).map(c => c.volume);
  const averageVolume =
    previousVolumes.reduce((a, b) => a + b, 0) /
    Math.max(previousVolumes.length, 1);

  const lastVolume = closed[closed.length - 1].volume;
  const volumeRatio = averageVolume > 0
    ? lastVolume / averageVolume
    : 0;

  const rangePercent = price > 0
    ? ((resistance - support) / price) * 100
    : 0;

  const trend = ema20 > ema50 && price > ema20
    ? "صعودی"
    : ema20 < ema50 && price < ema20
      ? "نزولی"
      : "خنثی";

  const accumulation =
    rangePercent < 8 &&
    volumeRatio > 1.2 &&
    rsi !== null &&
    rsi >= 35 &&
    rsi <= 60;

  let score = 0;

  if (trend === "صعودی") score += 25;
  if (rsi >= 45 && rsi <= 65) score += 20;
  if (volumeRatio >= 1.5) score += 20;
  if (price > support * 1.02) score += 10;
  if (ema20 > ema50) score += 15;
  if (accumulation) score += 10;

  const entry = price;
  const stop = Math.min(support * 0.98, entry * 0.96);
  const risk = entry - stop;

  const target1 = Math.max(resistance, entry + risk * 1.5);
  const target2 = entry + risk * 2.5;
  const target3 = entry + risk * 3.5;

  return {
    price,
    rsi,
    ema20,
    ema50,
    support,
    resistance,
    volumeRatio,
    trend,
    accumulation,
    score,
    entry,
    stop,
    target1,
    target2,
    target3
  };
}

function formatPrice(value) {
  if (!Number.isFinite(value)) return "نامشخص";

  if (value >= 1000) {
    return value.toLocaleString("en-US", { maximumFractionDigits: 2 });
  }

  if (value >= 1) return value.toFixed(4);
  if (value >= 0.01) return value.toFixed(5);
  if (value >= 0.0001) return value.toFixed(7);

  return value.toExponential(3);
}

function formatMoney(value) {
  if (!Number.isFinite(value)) return "نامشخص";

  if (value >= 1e9) return "$" + (value / 1e9).toFixed(2) + "B";
  if (value >= 1e6) return "$" + (value / 1e6).toFixed(2) + "M";
  return "$" + Math.round(value / 1000) + "K";
}

async function mapWithConcurrency(items, limit, callback) {
  const results = new Array(items.length);
  let next = 0;

  async function worker() {
    while (true) {
      const index = next++;
      if (index >= items.length) return;

      try {
        results[index] = await callback(items[index]);
      } catch {
        results[index] = null;
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker())
  );

  return results;
}

async function runScan() {
  const [coins, pairs] = await Promise.all([
    getCoinLoreCoins(),
    getKrakenPairs()
  ]);

  if (!coins.length) {
    throw new Error("CoinLore did not return coin data");
  }

  const candidates = coins
    .map(coin => ({
      ...coin,
      cap: Number(coin.market_cap_usd || 0),
      volume: Number(coin.volume24 || 0)
    }))
    .filter(coin =>
      coin.cap >= CONFIG.MIN_MARKET_CAP &&
      coin.cap <= CONFIG.MAX_MARKET_CAP &&
      coin.volume >= CONFIG.MIN_VOLUME
    )
    .sort((a, b) => b.volume - a.volume)
    .slice(0, CONFIG.MAX_CANDIDATES);

  if (!candidates.length) {
    throw new Error("No coins passed the market-cap and volume filters");
  }

  const analyzed = await mapWithConcurrency(
    candidates,
    CONFIG.CONCURRENCY,
    async coin => {
      const pair = findKrakenPair(coin.symbol, pairs);
      if (!pair) return null;

      const candles = await getCandles(pair);
      const analysis = analyzeCandles(candles);

      return {
        name: coin.name,
        symbol: coin.symbol,
        cap: coin.cap,
        volume: coin.volume,
        change24: Number(coin.percent_change_24h || 0),
        change7d: Number(coin.percent_change_7d || 0),
        ...analysis
      };
    }
  );

  const results = analyzed
    .filter(Boolean)
    .sort((a, b) => b.score - a.score)
    .slice(0, CONFIG.MAX_RESULTS);

  if (!results.length) {
    throw new Error("No coins had usable Kraken candle data");
  }

  let report =
    "🚀 <b>CRYPTO PUMP HUNTER</b>\n" +
    "━━━━━━━━━━━━━━━━━━\n" +
    "📊 فیلتر ارزش بازار: 1M تا 500M دلار\n" +
    "⏱ تحلیل تکنیکال: کندل یک‌ساعته\n" +
    "🔎 تعداد فرصت‌های پیدا شده: " + results.length + "\n\n";

  results.forEach((coin, index) => {
    const rsiText = coin.rsi === null ? "N/A" : coin.rsi.toFixed(1);

    report +=
      `<b>${index + 1}. ${escapeHTML(coin.name)} (${escapeHTML(coin.symbol)})</b>\n` +
      `⭐ امتیاز: ${coin.score}/100\n` +
      `💵 قیمت: $${formatPrice(coin.price)}\n` +
      `🏦 مارکت‌کپ: ${formatMoney(coin.cap)}\n` +
      `📈 تغییر 24h: ${coin.change24.toFixed(2)}%\n` +
      `📊 روند: ${coin.trend}\n` +
      `RSI: ${rsiText}\n` +
      `EMA20: $${formatPrice(coin.ema20)}\n` +
      `EMA50: $${formatPrice(coin.ema50)}\n` +
      `🔊 حجم نسبت به میانگین: ${coin.volumeRatio.toFixed(2)}x\n` +
      `🟢 حمایت: $${formatPrice(coin.support)}\n` +
      `🔴 مقاومت: $${formatPrice(coin.resistance)}\n` +
      `🎯 ورود بررسی: $${formatPrice(coin.entry)}\n` +
      `🛑 حد ضرر محاسباتی: $${formatPrice(coin.stop)}\n` +
      `🎯 هدف 1: $${formatPrice(coin.target1)}\n` +
      `🎯 هدف 2: $${formatPrice(coin.target2)}\n` +
      `🎯 هدف 3: $${formatPrice(coin.target3)}\n` +
      `🔍 انباشت احتمالی: ${coin.accumulation ? "مشاهده شد" : "تأیید نشد"}\n` +
      "━━━━━━━━━━━━━━━━━━\n";
  });

  report +=
    "\n⚠️ <b>هشدار:</b> این خروجی پیشنهاد قطعی خرید نیست.\n" +
    "انباشت بر اساس قیمت و حجم تخمین زده می‌شود، نه ردیابی کیف‌پول نهنگ‌ها.\n" +
    "قیمت ورود و اهداف، سطوح محاسباتی هستند و باید پیش از معامله بررسی شوند.";

  return report;
}

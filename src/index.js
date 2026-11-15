
const CONFIG = {
  MARKET_CAP_MIN: 1000000,
  MARKET_CAP_MAX: 500000000,
  DAILY_VOLUME_MIN: 250000,
  MAX_CANDIDATES: 35,
  MAX_RESULTS: 5,
  CONCURRENCY: 2,
  MIN_SCORE: 65
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return new Response("Crypto Pump Hunter V2 is running.");
    }

    if (url.pathname === "/testdata" && request.method === "GET") {
      if (!env.SETUP_KEY || url.searchParams.get("key") !== env.SETUP_KEY) {
        return new Response("Unauthorized", { status: 401 });
      }

      const [kraken, coinlore] = await Promise.all([
        fetch("https://api.kraken.com/0/public/Time").catch(() => null),
        fetch("https://api.coinlore.net/api/tickers/?start=0&limit=10").catch(() => null)
      ]);

      let k = null;
      let c = null;

      if (kraken?.ok) {
        const data = await kraken.json();
        k = data.result?.unixtime ?? null;
      }

      if (coinlore?.ok) {
        const data = await coinlore.json();
        c = data.data?.length ?? null;
      }

      return Response.json({
        kraken: { ok: k !== null, status: kraken?.status ?? "network_error" },
        coinlore: { ok: c !== null, status: coinlore?.status ?? "network_error", assets: c }
      });
    }

    if (url.pathname === "/register" && request.method === "GET") {
      if (!env.SETUP_KEY || url.searchParams.get("key") !== env.SETUP_KEY) {
        return new Response("Unauthorized", { status: 401 });
      }

      if (!env.BOT_TOKEN || !env.WEBHOOK_SECRET) {
        return Response.json({ ok: false, error: "Missing bot settings" });
      }

      return Response.json(await telegramAPI(env, "setWebhook", {
        url: `${url.origin}/telegram`,
        secret_token: env.WEBHOOK_SECRET,
        allowed_updates: ["message"]
      }));
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
      const command = (message?.text || "").trim().split(/\s+/)[0].toLowerCase();

      if (!chatId || !command) return new Response("OK");

      if (command === "/start" || command === "/help") {
        await sendMessage(env, chatId,
          "🤖 <b>Crypto Pump Hunter V2</b>\n\n" +
          "/scan - اسکن دستی بازار\n" +
          "/status - وضعیت ربات\n" +
          "/help - راهنما\n\n" +
          "اسکن فقط با دستور شما انجام می‌شود."
        );
        return new Response("OK");
      }

      if (command === "/status") {
        await sendMessage(env, chatId,
          "✅ ربات فعال است.\n" +
          "📊 منابع: Kraken + CoinLore\n" +
          "🧠 نسخه تحلیل: V2\n" +
          "⏱ اسکن فقط با /scan"
        );
        return new Response("OK");
      }

      if (command === "/scan") {
        if (env.OWNER_ID && String(chatId) !== String(env.OWNER_ID)) {
          await sendMessage(env, chatId, "⛔ اجازه اسکن ندارید.");
          return new Response("OK");
        }

        await sendMessage(env, chatId,
          "🔎 اسکن هوشمند V2 شروع شد...\n" +
          "در حال بررسی روند، حجم، RSI، حمایت و مقاومت."
        );

        try {
          const report = await runScan();
          await sendLongMessage(env, chatId, report);
        } catch (error) {
          await sendMessage(env, chatId,
            "❌ خطا در اسکن:\n" + escapeHTML(error.message || "Unknown error")
          );
        }

        return new Response("OK");
      }

      return new Response("دستور نامعتبر است. /help");
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

  return response.json();
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
  const chunks = text.match(/[\s\S]{1,3800}/g) || [text];

  for (const chunk of chunks) {
    await sendMessage(env, chatId, chunk);
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

async function getCoins() {
  const starts = [0, 100, 200, 300, 400];

  const pages = await Promise.all(starts.map(async start => {
    try {
      const data = await fetchJSON(
        `https://api.coinlore.net/api/tickers/?start=${start}&limit=100`
      );
      return data.data || [];
    } catch {
      return [];
    }
  }));

  const unique = new Map();

  for (const coin of pages.flat()) {
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

function findPair(symbol, pairs) {
  const wanted = normalizeSymbol(symbol);

  const matches = pairs.filter(pair => {
    const parts = (pair.wsname || "").split("/");
    if (parts.length !== 2) return false;

    return normalizeSymbol(parts[0]) === wanted &&
      ["USD", "USDT"].includes(parts[1].toUpperCase());
  });

  if (!matches.length) return null;

  matches.sort((a, b) =>
    (a.wsname.endsWith("/USD") ? 0 : 1) -
    (b.wsname.endsWith("/USD") ? 0 : 1)
  );

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
  if (!key) throw new Error("No candle data");

  return data.result[key].map(row => ({
    time: Number(row[0]),
    open: Number(row[1]),
    high: Number(row[2]),
    low: Number(row[3]),
    close: Number(row[4]),
    volume: Number(row[6])
  }));
}

function ema(values, period) {
  if (values.length < period) return null;

  const multiplier = 2 / (period + 1);
  let result = values.slice(0, period).reduce((a, b) => a + b, 0) / period;

  for (let i = period; i < values.length; i++) {
    result = (values[i] - result) * multiplier + result;
  }

  return result;
}

function rsi(values, period = 14) {
  if (values.length <= period) return null;

  let gain = 0;
  let loss = 0;

  for (let i = 1; i <= period; i++) {
    const change = values[i] - values[i - 1];
    gain += Math.max(change, 0);
    loss += Math.max(-change, 0);
  }

  let avgGain = gain / period;
  let avgLoss = loss / period;

  for (let i = period + 1; i < values.length; i++) {
    const change = values[i] - values[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(change, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-change, 0)) / period;
  }

  if (avgLoss === 0) return 100;

  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function average(values) {
  if (!values.length) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function findLevels(candles, price) {
  const recent = candles.slice(-48);
  const lows = [];
  const highs = [];

  for (let i = 1; i < recent.length - 1; i++) {
    if (
      recent[i].low < recent[i - 1].low &&
      recent[i].low < recent[i + 1].low
    ) lows.push(recent[i].low);

    if (
      recent[i].high > recent[i - 1].high &&
      recent[i].high > recent[i + 1].high
    ) highs.push(recent[i].high);
  }

  const supports = lows.filter(x => x < price).sort((a, b) => b - a);
  const resistances = highs.filter(x => x > price).sort((a, b) => a - b);

  return {
    support: supports[0] ?? Math.min(...recent.map(c => c.low)),
    resistance: resistances[0] ?? Math.max(...recent.map(c => c.high))
  };
}

function analyze(candles, coin) {
  if (candles.length < 80) throw new Error("Insufficient candle history");

  // آخرین کندل Kraken ممکن است هنوز بسته نشده باشد.
  const closed = candles.slice(0, -1);
  const closes = closed.map(c => c.close);
  const last = closed[closed.length - 1];
  const previous = closed[closed.length - 2];
  const price = last.close;

  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  const currentRSI = rsi(closes);
  const levels = findLevels(closed, price);

  const volumeHistory = closed.slice(-21, -1).map(c => c.volume);
  const avgVolume = average(volumeHistory);
  const volumeRatio = avgVolume > 0 ? last.volume / avgVolume : 0;

  const recentRange = closed.slice(-25, -1);
  const priorResistance = Math.max(...recentRange.map(c => c.high));
  const nearSupport = levels.support > 0
    ? (price - levels.support) / price
    : 1;

  const bullishCandle = last.close > last.open;
  const bullishTrend = ema20 > ema50 && price > ema20;
  const dailyChange = Number(coin.percent_change_24h || 0);
  const volumeToCap = coin.volume / Math.max(coin.cap, 1);

  const breakout =
    price > priorResistance * 1.002 &&
    volumeRatio >= 1.5 &&
    bullishCandle;

  const pullback =
    bullishTrend &&
    Math.abs(price - ema20) / price <= 0.015 &&
    currentRSI >= 45 &&
    currentRSI <= 67 &&
    bullishCandle;

  const supportBounce =
    nearSupport <= 0.015 &&
    bullishCandle &&
    currentRSI >= 40 &&
    currentRSI <= 62;

  let setup = "بدون الگوی ورود";
  if (breakout) setup = "شکست مقاومت";
  else if (pullback) setup = "پولبک به EMA20";
  else if (supportBounce) setup = "برگشت از حمایت";

  let score = 0;

  // روند: حداکثر 25 امتیاز
  if (price > ema20) score += 8;
  if (ema20 > ema50) score += 12;
  if (ema20 > ema50 && price > ema20) score += 5;

  // RSI: حداکثر 15 امتیاز
  if (currentRSI >= 50 && currentRSI <= 65) score += 15;
  else if (currentRSI >= 45 && currentRSI < 50) score += 10;
  else if (currentRSI > 65 && currentRSI <= 70) score += 7;
  else if (currentRSI >= 40 && currentRSI < 45) score += 5;

  // حجم: حداکثر 20 امتیاز
  if (volumeRatio >= 2) score += 20;
  else if (volumeRatio >= 1.5) score += 16;
  else if (volumeRatio >= 1.2) score += 12;
  else if (volumeRatio >= 0.9) score += 7;

  // نقدشوندگی: حداکثر 10 امتیاز
  if (volumeToCap >= 0.10) score += 10;
  else if (volumeToCap >= 0.05) score += 8;
  else if (volumeToCap >= 0.02) score += 5;
  else if (volumeToCap >= 0.01) score += 2;

  // رفتار روزانه: حداکثر 10 امتیاز
  if (dailyChange > 3) score += 10;
  else if (dailyChange > 1) score += 8;
  else if (dailyChange > 0) score += 6;
  else if (dailyChange > -2) score += 3;

  // ساختار قیمت: حداکثر 20 امتیاز
  if (breakout) score += 20;
  else if (pullback) score += 17;
  else if (supportBounce) score += 14;
  else if (price > levels.support && nearSupport < 0.04) score += 5;

  score = Math.min(100, score);

  const entry = price;
  const support = levels.support;
  const resistance = levels.resistance;

  const stop = Math.min(
    support * 0.99,
    entry * 0.97
  );

  const risk = entry - stop;
  const target1 = Math.max(resistance, entry + risk * 1.5);
  const target2 = entry + risk * 2.5;
  const target3 = entry + risk * 3.5;

  const rewardRisk = risk > 0 ? (target1 - entry) / risk : 0;

  const eligible =
    score >= CONFIG.MIN_SCORE &&
    setup !== "بدون الگوی ورود" &&
    volumeRatio >= 0.9 &&
    rewardRisk >= 1.5 &&
    stop < entry;

  return {
    price,
    ema20,
    ema50,
    rsi: currentRSI,
    volumeRatio,
    volumeToCap,
    dailyChange,
    support,
    resistance,
    setup,
    score,
    entry,
    stop,
    target1,
    target2,
    target3,
    rewardRisk,
    eligible,
    bullishTrend,
    breakout,
    pullback,
    supportBounce
  };
}

function fmt(value) {
  if (!Number.isFinite(value)) return "N/A";
  if (value >= 1000) return value.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (value >= 1) return value.toFixed(4);
  if (value >= 0.01) return value.toFixed(5);
  if (value >= 0.0001) return value.toFixed(7);
  return value.toExponential(3);
}

function money(value) {
  if (value >= 1e9) return "$" + (value / 1e9).toFixed(2) + "B";
  if (value >= 1e6) return "$" + (value / 1e6).toFixed(2) + "M";
  return "$" + Math.round(value / 1000) + "K";
}

async function mapConcurrent(items, limit, callback) {
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
    Array.from({ length: Math.min(limit, items.length) }, worker)
  );

  return results;
}

async function runScan() {
  const [coins, pairs] = await Promise.all([
    getCoins(),
    getKrakenPairs()
  ]);

  const candidates = coins
    .map(coin => ({
      ...coin,
      cap: Number(coin.market_cap_usd || 0),
      volume: Number(coin.volume24 || 0)
    }))
    .filter(coin =>
      coin.cap >= CONFIG.MARKET_CAP_MIN &&
      coin.cap <= CONFIG.MARKET_CAP_MAX &&
      coin.volume >= CONFIG.DAILY_VOLUME_MIN
    )
    .sort((a, b) => b.volume - a.volume)
    .slice(0, CONFIG.MAX_CANDIDATES);

  const analyzed = await mapConcurrent(
    candidates,
    CONFIG.CONCURRENCY,
    async coin => {
      const pair = findPair(coin.symbol, pairs);
      if (!pair) return null;

      const candles = await getCandles(pair);
      return {
        name: coin.name,
        symbol: coin.symbol,
        cap: coin.cap,
        volume: coin.volume,
        analysis: analyze(candles, coin)
      };
    }
  );

  const usable = analyzed.filter(Boolean);

  if (!usable.length) {
    throw new Error("No usable Kraken candle data for selected coins");
  }

  const qualified = usable
    .filter(item => item.analysis.eligible)
    .sort((a, b) => b.analysis.score - a.analysis.score)
    .slice(0, CONFIG.MAX_RESULTS);

  const watchlist = usable
    .filter(item => !item.analysis.eligible)
    .sort((a, b) => b.analysis.score - a.analysis.score)
    .slice(0, 5);

  let report =
    "🚀 <b>CRYPTO PUMP HUNTER V2</b>\n" +
    "━━━━━━━━━━━━━━━━━━\n" +
    "📊 فیلتر مارکت‌کپ: 1M تا 500M دلار\n" +
    "⏱ تایم‌فریم: یک‌ساعته\n" +
    "🔎 ارزهای دارای داده معتبر: " + usable.length + "\n" +
    "✅ فرصت‌های واجد شرایط: " + qualified.length + "\n\n";

  if (qualified.length) {
    report += "🟢 <b>فرصت‌های دارای شرایط ورود</b>\n\n";

    qualified.forEach((item, index) => {
      const a = item.analysis;

      report +=
        `<b>${index + 1}. ${escapeHTML(item.name)} (${escapeHTML(item.symbol)})</b>\n` +
        `⭐ امتیاز: ${a.score}/100\n` +
        `📌 الگو: ${a.setup}\n` +
        `💵 قیمت بررسی: $${fmt(a.price)}\n` +
        `🏦 مارکت‌کپ: ${money(item.cap)}\n` +
        `📈 تغییر 24h: ${a.dailyChange.toFixed(2)}%\n` +
        `📊 RSI: ${a.rsi.toFixed(1)}\n` +
        `EMA20: $${fmt(a.ema20)}\n` +
        `EMA50: $${fmt(a.ema50)}\n` +
        `🔊 نسبت حجم یک‌ساعته: ${a.volumeRatio.toFixed(2)}x\n` +
        `🟢 حمایت: $${fmt(a.support)}\n` +
        `🔴 مقاومت: $${fmt(a.resistance)}\n` +
        `🎯 ورود مشروط: $${fmt(a.entry)}\n` +
        `🛑 حد ضرر محاسباتی: $${fmt(a.stop)}\n` +
        `🎯 هدف 1: $${fmt(a.target1)}\n` +
        `🎯 هدف 2: $${fmt(a.target2)}\n` +
        `🎯 هدف 3: $${fmt(a.target3)}\n` +
        `⚖️ نسبت سود به ریسک تا هدف اول: ${a.rewardRisk.toFixed(2)}\n` +
        "━━━━━━━━━━━━━━━━━━\n";
    });
  } else {
    report +=
      "⛔ <b>فعلاً سیگنال ورود معتبر پیدا نشد.</b>\n" +
      "هیچ ارزی تمام شروط لازم را هم‌زمان نداشت.\n" +
      "بهتر است برای ورود عجله نکنی.\n\n";
  }

  if (watchlist.length) {
    report += "🟡 <b>فهرست تحت نظر (بدون سیگنال خرید)</b>\n\n";

    watchlist.forEach((item, index) => {
      const a = item.analysis;

      report +=
        `${index + 1}. <b>${escapeHTML(item.name)} (${escapeHTML(item.symbol)})</b>\n` +
        `امتیاز: ${a.score}/100 | الگو: ${a.setup}\n` +
        `قیمت: $${fmt(a.price)} | RSI: ${a.rsi.toFixed(1)}\n` +
        `حجم ساعتی: ${a.volumeRatio.toFixed(2)}x\n\n`;
    });
  }

  report +=
    "━━━━━━━━━━━━━━━━━━\n" +
    "⚠️ این تحلیل خودکار است و سود را تضمین نمی‌کند.\n" +
    "ورود مشروط به بررسی نمودار زنده و تأیید کندل است.\n" +
    "سطوح و امتیازها ابزار غربالگری هستند، نه توصیه مالی.\n" +
    "انباشت کیف‌پول‌های بزرگ با این منابع قابل تأیید نیست.";

  return report;
}

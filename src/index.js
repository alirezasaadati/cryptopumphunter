
const CONFIG = {
  VERSION: "3.4",
  MIN_MARKET_CAP: 1_000_000,
  MAX_MARKET_CAP: 500_000_000,
  MIN_DAILY_VOLUME: 250_000,
  MAX_CANDIDATES: 60,
  MAX_RESULTS: 5,
  WATCHLIST_SIZE: 5,
  DIAGNOSTIC_SIZE: 8,
  CONCURRENCY: 2,
  MIN_SCORE: 65,
  MIN_REWARD_RISK: 1.5,
  CANDLE_INTERVAL: 60,
  MIN_CANDLES: 55,
  COINLORE_PAGES: [0, 100, 200, 300, 400, 500, 600, 700, 800, 900]
};

const TELEGRAM_API = "https://api.telegram.org";
const seenUpdates = new Set();

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return json({
        ok: true,
        service: "Crypto Pump Hunter",
        version: CONFIG.VERSION,
        mode: "Manual scan only"
      });
    }

    if (request.method === "GET" && url.pathname === "/testdata") {
      if (!authorizedSetup(url, env)) {
        return json({ ok: false, error: "Unauthorized" }, 401);
      }
      return json(await testDataSources());
    }

    if (request.method === "GET" && url.pathname === "/register") {
      if (!authorizedSetup(url, env)) {
        return json({ ok: false, error: "Unauthorized" }, 401);
      }
      return registerWebhook(request, env);
    }

    if (request.method === "POST" && url.pathname === "/telegram") {
      if (
        env.WEBHOOK_SECRET &&
        request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.WEBHOOK_SECRET
      ) {
        return new Response("Unauthorized", { status: 401 });
      }

      let update;
      try {
        update = await request.json();
      } catch {
        return new Response("Bad Request", { status: 400 });
      }

      const updateId = update.update_id;

      if (updateId !== undefined) {
        if (seenUpdates.has(updateId)) return new Response("OK");

        seenUpdates.add(updateId);

        if (seenUpdates.size > 500) {
          seenUpdates.delete(seenUpdates.values().next().value);
        }
      }

      const message = update.message || update.edited_message;

      if (!message?.chat?.id || !message.text) {
        return new Response("OK");
      }

      const chatId = message.chat.id;
      const command = message.text
        .trim()
        .split(/\s+/)[0]
        .split("@")[0]
        .toLowerCase();

      ctx.waitUntil(handleTelegramCommand(command, chatId, env));
      return new Response("OK");
    }

    return new Response("Not Found", { status: 404 });
  }
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}

function authorizedSetup(url, env) {
  return Boolean(
    env.SETUP_KEY &&
    url.searchParams.get("key") === env.SETUP_KEY
  );
}

async function fetchJson(url, label) {
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "CryptoPumpHunter/3.4"
    }
  });

  const body = await response.text();

  let data;
  try {
    data = JSON.parse(body);
  } catch {
    throw new Error(
      `${label}: پاسخ JSON معتبر نیست؛ HTTP ${response.status}`
    );
  }

  if (!response.ok) {
    throw new Error(`${label}: HTTP ${response.status}`);
  }

  return data;
}

async function telegram(method, env, body) {
  if (!env.BOT_TOKEN) throw new Error("BOT_TOKEN تنظیم نشده است.");

  const response = await fetch(
    `${TELEGRAM_API}/bot${env.BOT_TOKEN}/${method}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    }
  );

  const data = await response.json();

  if (!response.ok || !data.ok) {
    throw new Error(data.description || `Telegram HTTP ${response.status}`);
  }

  return data;
}

async function sendMessage(env, chatId, text) {
  return telegram("sendMessage", env, {
    chat_id: chatId,
    text,
    disable_web_page_preview: true
  });
}

async function sendLongMessage(env, chatId, text) {
  const maxLength = 3500;
  let chunk = "";

  for (const line of text.split("\n")) {
    if (line.length > maxLength) {
      if (chunk) {
        await sendMessage(env, chatId, chunk);
        chunk = "";
      }

      for (let i = 0; i < line.length; i += maxLength) {
        await sendMessage(env, chatId, line.slice(i, i + maxLength));
      }
      continue;
    }

    if (chunk.length + line.length + 1 > maxLength) {
      await sendMessage(env, chatId, chunk);
      chunk = "";
    }

    chunk += (chunk ? "\n" : "") + line;
  }

  if (chunk) await sendMessage(env, chatId, chunk);
}

async function handleTelegramCommand(command, chatId, env) {
  try {
    if (command === "/start") {
      await sendMessage(
        env,
        chatId,
        "🚀 به Crypto Pump Hunter خوش آمدی.\n\n" +
        "برای اسکن بازار دستور /scan را بفرست.\n" +
        "راهنما: /help"
      );
      return;
    }

    if (command === "/help") {
      await sendMessage(
        env,
        chatId,
        "📘 راهنمای ربات\n\n" +
        "/scan - اسکن بازار\n" +
        "/status - وضعیت ربات\n" +
        "/help - راهنما\n\n" +
        "اسکن فقط با دستور دستی /scan انجام می‌شود."
      );
      return;
    }

    if (command === "/status") {
      await sendMessage(
        env,
        chatId,
        `🟢 ربات فعال است.\nنسخه: V${CONFIG.VERSION}\n` +
        "حالت اسکن: دستی\nمنابع: CoinLore و Kraken"
      );
      return;
    }

    if (command === "/scan") {
      if (env.OWNER_ID && String(chatId) !== String(env.OWNER_ID)) {
        await sendMessage(env, chatId, "⛔ اجازه اسکن ندارید.");
        return;
      }

      await sendMessage(
        env,
        chatId,
        `🔎 اسکن هوشمند V${CONFIG.VERSION} شروع شد...\n` +
        "در حال دریافت داده‌ها و بررسی روند، حجم، RSI و سطوح قیمتی."
      );

      const report = await runScan();
      await sendLongMessage(env, chatId, report);
    }
  } catch (error) {
    try {
      await sendMessage(
        env,
        chatId,
        "❌ خطا در اجرای دستور:\n" +
        String(error.message || "Unknown error").slice(0, 1000)
      );
    } catch {
      // Ignore Telegram reporting errors.
    }
  }
}

async function registerWebhook(request, env) {
  if (!env.BOT_TOKEN) {
    return json({ ok: false, error: "BOT_TOKEN تنظیم نشده است." }, 400);
  }

  if (
    env.WEBHOOK_SECRET &&
    !/^[A-Za-z0-9_-]{1,256}$/.test(env.WEBHOOK_SECRET)
  ) {
    return json({
      ok: false,
      error: "WEBHOOK_SECRET فقط باید شامل حروف انگلیسی، عدد، _ یا - باشد."
    }, 400);
  }

  const webhookUrl = new URL("/telegram", request.url).toString();

  try {
    const body = {
      url: webhookUrl,
      allowed_updates: ["message"],
      max_connections: 5
    };

    if (env.WEBHOOK_SECRET) {
      body.secret_token = env.WEBHOOK_SECRET;
    }

    const result = await telegram("setWebhook", env, body);

    return json({
      ok: true,
      result: result.result,
      description: result.description || "Webhook registered"
    });
  } catch (error) {
    return json({ ok: false, error: error.message }, 500);
  }
}

// ---------------- DATA SOURCES ----------------

function extractCoinLoreAssets(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.coins)) return payload.coins;
  if (Array.isArray(payload?.data?.coins)) return payload.data.coins;
  return [];
}

async function fetchCoinLore(start, limit = 100) {
  const url =
    `https://api.coinlore.net/api/tickers/?start=${start}&limit=${limit}`;

  const payload = await fetchJson(url, "CoinLore");
  const assets = extractCoinLoreAssets(payload);

  if (!assets.length) {
    throw new Error(`CoinLore صفحه ${start} داده قابل استفاده ندارد.`);
  }

  return {
    assets,
    totalCoins: payload?.info?.coins_num ?? null
  };
}

async function getCoins() {
  const all = [];
  const seen = new Set();
  const errors = [];

  const pages = await mapLimit(
    CONFIG.COINLORE_PAGES,
    CONFIG.CONCURRENCY,
    async start => {
      try {
        const result = await fetchCoinLore(start, 100);
        return { start, assets: result.assets, error: null };
      } catch (error) {
        return { start, assets: [], error: error.message };
      }
    }
  );

  for (const page of pages) {
    if (page.error) {
      errors.push(page.error);
      continue;
    }

    for (const coin of page.assets) {
      const id = String(coin.id || coin.symbol || "").toLowerCase();
      if (!id || seen.has(id)) continue;

      seen.add(id);
      all.push(coin);
    }
  }

  return { coins: all, errors };
}

async function getKrakenPairs() {
  const data = await fetchJson(
    "https://api.kraken.com/0/public/AssetPairs",
    "Kraken AssetPairs"
  );

  if (data.error?.length) {
    throw new Error(data.error.join(", "));
  }

  return data.result || {};
}

function normalizeSymbol(symbol) {
  let value = String(symbol || "").toUpperCase().trim();
  if (value === "BTC") value = "XBT";
  return value.replace(/[^A-Z0-9]/g, "");
}

function findKrakenPair(coin, pairs) {
  const symbol = normalizeSymbol(coin.symbol);
  if (!symbol) return null;

  for (const [key, pair] of Object.entries(pairs)) {
    const wsname = String(pair.wsname || "").toUpperCase();
    const altname = String(pair.altname || "").toUpperCase();

    const parts = wsname.split("/");
    const base = normalizeSymbol(parts[0] || "");
    const quote = parts[1] || "";

    if (base === symbol && (quote === "USD" || quote === "USDT")) {
      return pair.altname || key;
    }

    if (altname === `${symbol}USD` || altname === `${symbol}USDT`) {
      return pair.altname || key;
    }
  }

  return null;
}

async function getCandles(pair) {
  const url =
    "https://api.kraken.com/0/public/OHLC" +
    `?pair=${encodeURIComponent(pair)}&interval=${CONFIG.CANDLE_INTERVAL}`;

  const data = await fetchJson(url, "Kraken OHLC");

  if (data.error?.length) {
    throw new Error(data.error.join(", "));
  }

  const result = data.result || {};
  const key = Object.keys(result).find(name => name !== "last");

  if (!key || !Array.isArray(result[key])) {
    throw new Error("کندل‌های Kraken موجود نیستند.");
  }

  // آخرین ردیف، کندل در حال تشکیل است؛ حذف می‌شود.
  const candles = result[key]
    .slice(0, -1)
    .map(row => ({
      time: Number(row[0]),
      open: Number(row[1]),
      high: Number(row[2]),
      low: Number(row[3]),
      close: Number(row[4]),
      volume: Number(row[6])
    }))
    .filter(c =>
      Number.isFinite(c.close) &&
      c.close > 0 &&
      c.high >= c.low &&
      c.low > 0
    );

  return candles;
}

async function testDataSources() {
  const result = {
    version: CONFIG.VERSION,
    coinlore: { ok: false },
    kraken: { ok: false }
  };

  try {
    const coins = await fetchCoinLore(0, 10);
    result.coinlore = {
      ok: true,
      assets: coins.assets.length,
      sample: coins.assets.slice(0, 3).map(c => ({
        name: c.name,
        symbol: c.symbol,
        price_usd: c.price_usd,
        market_cap_usd: c.market_cap_usd,
        volume24: c.volume24
      }))
    };
  } catch (error) {
    result.coinlore = { ok: false, error: error.message };
  }

  try {
    const pairs = await getKrakenPairs();
    result.kraken = {
      ok: true,
      pairs: Object.keys(pairs).length
    };
  } catch (error) {
    result.kraken = { ok: false, error: error.message };
  }

  return result;
}

// ---------------- INDICATORS ----------------

function ema(values, period) {
  if (values.length < period) return null;

  const multiplier = 2 / (period + 1);
  let value =
    values.slice(0, period).reduce((a, b) => a + b, 0) / period;

  for (let i = period; i < values.length; i++) {
    value = values[i] * multiplier + value * (1 - multiplier);
  }

  return value;
}

function rsi(values, period = 14) {
  if (values.length <= period) return null;

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const change = values[i] - values[i - 1];
    gains += Math.max(change, 0);
    losses += Math.max(-change, 0);
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (let i = period + 1; i < values.length; i++) {
    const change = values[i] - values[i - 1];

    avgGain =
      (avgGain * (period - 1) + Math.max(change, 0)) / period;

    avgLoss =
      (avgLoss * (period - 1) + Math.max(-change, 0)) / period;
  }

  if (avgLoss === 0) return 100;
  if (avgGain === 0) return 0;

  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function average(values) {
  if (!values.length) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function findLevels(candles) {
  // کندل جاری در محاسبه سقف و کف قبلی دخالت ندارد.
  const recent = candles.slice(-31, -1);

  if (recent.length < 10) {
    throw new Error("کندل کافی برای محاسبه حمایت و مقاومت وجود ندارد.");
  }

  return {
    support: Math.min(...recent.map(c => c.low)),
    resistance: Math.max(...recent.map(c => c.high)),
    rangeHigh: Math.max(...recent.map(c => c.high)),
    rangeLow: Math.min(...recent.map(c => c.low))
  };
}

function analyzeCoin(coin, candles) {
  if (candles.length < CONFIG.MIN_CANDLES) {
    throw new Error("تعداد کندل کافی نیست.");
  }

  const closes = candles.map(c => c.close);
  const last = candles[candles.length - 1];
  const previous = candles[candles.length - 2];

  const current = last.close;
  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  const rsi14 = rsi(closes, 14);

  if ([ema20, ema50, rsi14].some(v => v === null)) {
    throw new Error("محاسبه اندیکاتورها ناموفق بود.");
  }

  const levels = findLevels(candles);
  const { support, resistance, rangeHigh, rangeLow } = levels;

  const previousVolumes = candles.slice(-21, -1).map(c => c.volume);
  const avgVolume = average(previousVolumes);
  const volumeRatio = avgVolume > 0 ? last.volume / avgVolume : 0;

  const trendUp = ema20 > ema50;
  const aboveEMA20 = current > ema20;
  const aboveEMA50 = current > ema50;

  const dailyVolume = Number(coin.volume24) || 0;
  const dailyChange = Number(coin.percent_change_24h) || 0;

  let score = 0;
  const reasons = [];

  if (trendUp) score += 25;
  else reasons.push("EMA20 بالاتر از EMA50 نیست");

  if (rsi14 >= 45 && rsi14 <= 68) score += 15;
  else if (rsi14 > 68 && rsi14 <= 75) {
    score += 7;
    reasons.push("RSI بالا است؛ احتمال ورود دیرهنگام");
  } else if (rsi14 > 75) {
    reasons.push("RSI بیش از حد بالا است");
  } else {
    reasons.push("قدرت RSI کافی نیست");
  }

  if (volumeRatio >= 1.5) score += 20;
  else if (volumeRatio >= 1.1) score += 15;
  else if (volumeRatio >= 0.9) score += 10;
  else reasons.push("حجم کندل اخیر پایین است");

  if (dailyVolume >= 1_000_000) score += 10;
  else if (dailyVolume >= 500_000) score += 7;
  else score += 4;

  if (dailyChange > 0 && dailyChange < 12) score += 10;
  else if (dailyChange >= 12) {
    score += 5;
    reasons.push("رشد روزانه زیاد است");
  } else {
    reasons.push("تغییرات روزانه مثبت نیست");
  }

  if (aboveEMA20 && aboveEMA50) score += 20;
  else if (aboveEMA20 || aboveEMA50) score += 10;
  else reasons.push("قیمت زیر EMA20 و EMA50 است");

  score = Math.min(100, score);

  // تعیین ستاپ
  let setup = "بدون ستاپ";

  const breakout = current > resistance * 1.002 &&
    previous.close <= resistance * 1.005 &&
    volumeRatio >= 1.1 &&
    trendUp;

  const pullback = trendUp &&
    current > ema20 &&
    last.low <= ema20 * 1.01 &&
    current > last.open;

  const supportBounce = last.low <= support * 1.015 &&
    current > support * 1.01 &&
    current > last.open;

  if (breakout) {
    setup = "شکست مقاومت";
  } else if (pullback) {
    setup = "پولبک به EMA20";
  } else if (supportBounce) {
    setup = "واکنش به حمایت";
  }

  const recentLow = Math.min(
    ...candles.slice(-8, -1).map(c => c.low)
  );

  const entry = current;
  let stop;

  if (setup === "شکست مقاومت") {
    stop = Math.min(resistance * 0.99, recentLow * 0.995);
  } else if (setup === "پولبک به EMA20") {
    stop = Math.min(ema20 * 0.985, recentLow * 0.995);
  } else if (setup === "واکنش به حمایت") {
    stop = Math.min(support * 0.985, recentLow * 0.995);
  } else {
    stop = Math.min(support * 0.99, recentLow * 0.995);
  }

  const risk = entry - stop;
  const validStop = Number.isFinite(risk) && risk > 0;

  let target1 = resistance;

  // در شکست مقاومت، مقاومت قبلی دیگر هدف معتبر نیست.
  // هدف اول با ارتفاع محدوده نوسان قبلی محاسبه می‌شود.
  if (setup === "شکست مقاومت") {
    const rangeHeight = Math.max(rangeHigh - rangeLow, entry * 0.01);
    target1 = entry + rangeHeight;
  }

  // اگر مقاومت نزدیک باشد، هدف اول باید حداقل 1.5R فاصله داشته باشد.
  if (validStop && target1 <= entry) {
    target1 = entry + risk * 1.5;
  }

  const rewardRisk = validStop
    ? (target1 - entry) / risk
    : 0;

  const target2 = validStop ? entry + risk * 2.5 : 0;
  const target3 = validStop ? entry + risk * 3.5 : 0;

  if (!validStop) reasons.push("حد ضرر معتبر محاسبه نشد");
  if (setup === "بدون ستاپ") reasons.push("الگوی ورود مشخصی وجود ندارد");

  if (rewardRisk < CONFIG.MIN_REWARD_RISK) {
    reasons.push("نسبت سود به ریسک کمتر از حداقل تعیین‌شده است");
  }

  if (score < CONFIG.MIN_SCORE) {
    reasons.push(`امتیاز کمتر از ${CONFIG.MIN_SCORE} است`);
  }

  const eligible =
    score >= CONFIG.MIN_SCORE &&
    setup !== "بدون ستاپ" &&
    volumeRatio >= 0.9 &&
    validStop &&
    rewardRisk >= CONFIG.MIN_REWARD_RISK;

  return {
    coin,
    current,
    score,
    rsi: rsi14,
    ema20,
    ema50,
    support,
    resistance,
    volumeRatio,
    trend: trendUp ? "صعودی" : "خنثی یا نزولی",
    setup,
    entry,
    stop,
    target1,
    target2,
    target3,
    rewardRisk,
    eligible,
    reasons
  };
}

// ---------------- SCAN ENGINE ----------------

async function runScan() {
  const started = Date.now();

  const coinResult = await getCoins();
  const coins = coinResult.coins;

  if (!coins.length) {
    return (
      "❌ دریافت اطلاعات بازار ناموفق بود.\n" +
      "CoinLore هیچ فهرست ارز قابل استفاده‌ای برنگرداند.\n\n" +
      "خطاها:\n" + coinResult.errors.slice(0, 5).join("\n")
    );
  }

  const candidates = coins
    .filter(coin => {
      const cap = Number(coin.market_cap_usd);
      const volume = Number(coin.volume24);
      const price = Number(coin.price_usd);

      return (
        Number.isFinite(cap) &&
        Number.isFinite(volume) &&
        Number.isFinite(price) &&
        cap >= CONFIG.MIN_MARKET_CAP &&
        cap <= CONFIG.MAX_MARKET_CAP &&
        volume >= CONFIG.MIN_DAILY_VOLUME &&
        price > 0
      );
    })
    .sort((a, b) => Number(b.volume24) - Number(a.volume24))
    .slice(0, CONFIG.MAX_CANDIDATES);

  if (!candidates.length) {
    return (
      `⚠️ از ${coins.length} ارز دریافتی، هیچ ارزی با فیلترهای اولیه ` +
      "مطابقت نداشت."
    );
  }

  let pairs;

  try {
    pairs = await getKrakenPairs();
  } catch (error) {
    return `❌ دریافت جفت‌ارزهای Kraken ناموفق بود:\n${error.message}`;
  }

  const analyzed = await mapLimit(
    candidates,
    CONFIG.CONCURRENCY,
    async coin => {
      try {
        const pair = findKrakenPair(coin, pairs);

        if (!pair) {
          return {
            coin,
            rejected: "جفت معاملاتی USD/USDT در Kraken پیدا نشد"
          };
        }

        const candles = await getCandles(pair);

        if (candles.length < CONFIG.MIN_CANDLES) {
          return {
            coin,
            rejected: `کندل کافی نیست؛ تعداد موجود: ${candles.length}`
          };
        }

        return analyzeCoin(coin, candles);
      } catch (error) {
        return {
          coin,
          rejected: error.message || "خطای ناشناخته در تحلیل"
        };
      }
    }
  );

  const valid = analyzed
    .filter(item => item?.eligible)
    .sort((a, b) => b.score - a.score)
    .slice(0, CONFIG.MAX_RESULTS);

  const watchlist = analyzed
    .filter(item => item && !item.eligible && item.score !== undefined)
    .sort((a, b) => b.score - a.score)
    .slice(0, CONFIG.WATCHLIST_SIZE);

  const diagnostics = analyzed
    .filter(item => item && !item.eligible)
    .sort((a, b) => (b.score || 0) - (a.score || 0))
    .slice(0, CONFIG.DIAGNOSTIC_SIZE);

  const matchedPairs = analyzed.filter(item => item && item.score !== undefined).length;
  const noPair = analyzed.filter(
    item => item?.rejected?.includes("جفت معاملاتی")
  ).length;

  let report =
    `🚀 CRYPTO PUMP HUNTER V${CONFIG.VERSION}\n` +
    "━━━━━━━━━━━━━━━━━━\n\n" +
    "📊 ارزش بازار: 1M تا 500M دلار\n" +
    "💧 حداقل حجم روزانه: 250K دلار\n" +
    "⏱ تایم‌فریم: 1 ساعت\n" +
    `📥 ارزهای دریافت‌شده: ${coins.length}\n` +
    `🔎 کاندیداهای فیلترشده: ${candidates.length}\n` +
    `📈 دارای داده کندل معتبر: ${matchedPairs}\n` +
    `🔗 بدون جفت معاملاتی Kraken: ${noPair}\n` +
    `⭐ سیگنال‌های واجد شرایط: ${valid.length}\n\n`;

  if (valid.length) {
    report += "🔥 سیگنال‌های واجد شرایط\n━━━━━━━━━━━━━━━━━━\n\n";
    for (const item of valid) {
      report += formatCoin(item, true) + "\n";
    }
  } else {
    report +=
      "⚠️ در این اسکن هیچ سیگنالی تمام شرایط ورود را نداشت.\n\n";
  }

  if (watchlist.length) {
    report += "👀 واچ‌لیست\n━━━━━━━━━━━━━━━━━━\n\n";
    for (const item of watchlist) {
      report += formatCoin(item, false) + "\n";
    }
  }

  if (diagnostics.length) {
    report += "🧪 دلایل رد شدن یا ناقص بودن شرایط\n━━━━━━━━━━━━━━━━━━\n";

    for (const item of diagnostics) {
      const name = item.coin
        ? `${item.coin.name} (${item.coin.symbol})`
        : "Unknown";

      const reason = item.reasons?.length
        ? item.reasons.join("، ")
        : item.rejected || "شرایط ورود کامل نیست";

      report +=
        `• ${name} | امتیاز: ${item.score ?? "-"}\n` +
        `  دلیل: ${reason}\n`;
    }
  }

  if (coinResult.errors.length) {
    report +=
      "\n⚠️ خطا در بعضی صفحات CoinLore: " +
      `${coinResult.errors.length} صفحه ناموفق بود.\n`;
  }

  report +=
    "\n━━━━━━━━━━━━━━━━━━\n" +
    `⏱ زمان اسکن: ${Math.round((Date.now() - started) / 1000)} ثانیه\n` +
    "📌 منابع: CoinLore و Kraken\n" +
    "⚠️ سیگنال‌ها احتمالی‌اند و تضمین سود نیستند.";

  return report;
}

// ---------------- REPORT FORMAT ----------------

function formatPrice(value) {
  if (!Number.isFinite(value)) return "-";
  if (value >= 1000) return value.toFixed(2);
  if (value >= 1) return value.toFixed(4);
  if (value >= 0.01) return value.toFixed(5);
  if (value >= 0.0001) return value.toFixed(7);
  return value.toExponential(3);
}

function formatCoin(item, isSignal) {
  const coin = item.coin;

  let text =
    `🪙 ${coin.name} (${coin.symbol})\n` +
    `⭐ امتیاز: ${item.score}/100\n` +
    `💵 قیمت فعلی: $${formatPrice(item.current)}\n` +
    `📈 روند: ${item.trend}\n` +
    `📊 RSI: ${item.rsi.toFixed(1)}\n` +
    `📉 نسبت حجم: ${item.volumeRatio.toFixed(2)}x\n` +
    `🧩 الگو: ${item.setup}\n` +
    `🟢 حمایت: $${formatPrice(item.support)}\n` +
    `🔴 مقاومت قبلی: $${formatPrice(item.resistance)}\n`;

  if (isSignal) {
    text +=
      `\n🎯 قیمت بررسی/ورود: $${formatPrice(item.entry)}` +
      `\n🛑 حد ضرر: $${formatPrice(item.stop)}` +
      `\n🥇 هدف اول: $${formatPrice(item.target1)}` +
      `\n🥈 هدف دوم: $${formatPrice(item.target2)}` +
      `\n🥉 هدف سوم: $${formatPrice(item.target3)}` +
      `\n⚖️ نسبت سود به ریسک: ${item.rewardRisk.toFixed(2)}R\n`;
  } else {
    text +=
      "\n👀 وضعیت: فقط زیر نظر بگیر؛ سیگنال خرید نیست." +
      `\n📍 قیمت بررسی: $${formatPrice(item.entry)}` +
      `\n🛑 حد ضرر فرضی: $${formatPrice(item.stop)}` +
      `\n🎯 هدف محاسباتی اول: $${formatPrice(item.target1)}` +
      `\n⚖️ نسبت سود به ریسک: ${item.rewardRisk.toFixed(2)}R\n`;
  }

  return text;
}

// ---------------- CONCURRENCY ----------------

async function mapLimit(items, limit, callback) {
  const results = new Array(items.length);
  let index = 0;

  async function worker() {
    while (true) {
      const currentIndex = index++;
      if (currentIndex >= items.length) return;

      try {
        results[currentIndex] = await callback(items[currentIndex]);
      } catch (error) {
        results[currentIndex] = {
          rejected: error.message || "خطای پردازش"
        };
      }
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(limit, items.length) },
      () => worker()
    )
  );

  return results;
}

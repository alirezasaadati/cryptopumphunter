
const CONFIG = {
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
        version: "3.2",
        mode: "Manual scan only"
      });
    }

    if (request.method === "GET" && url.pathname === "/testdata") {
      if (!env.SETUP_KEY || url.searchParams.get("key") !== env.SETUP_KEY) {
        return json({ ok: false, error: "Unauthorized" }, 401);
      }

      return json(await testDataSources());
    }

    if (request.method === "GET" && url.pathname === "/register") {
      if (!env.SETUP_KEY || url.searchParams.get("key") !== env.SETUP_KEY) {
        return json({ ok: false, error: "Unauthorized" }, 401);
      }

      return await registerWebhook(request, env);
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
        if (seenUpdates.has(updateId)) {
          return new Response("OK");
        }

        seenUpdates.add(updateId);

        if (seenUpdates.size > 500) {
          seenUpdates.delete(seenUpdates.values().next().value);
        }
      }

      const message = update.message || update.edited_message;

      if (!message || !message.chat || !message.text) {
        return new Response("OK");
      }

      const chatId = message.chat.id;
      const command = message.text.trim().split(/\s+/)[0].split("@")[0].toLowerCase();

      ctx.waitUntil(handleTelegramCommand(command, chatId, env));

      return new Response("OK");
    }

    return new Response("Not Found", { status: 404 });
  }
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

async function telegram(method, env, body) {
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
    throw new Error(data.description || `Telegram API error: ${response.status}`);
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
  const lines = text.split("\n");
  let chunk = "";

  for (const line of lines) {
    if (chunk.length + line.length + 1 > maxLength && chunk) {
      await sendMessage(env, chatId, chunk);
      chunk = "";
    }

    if (line.length > maxLength) {
      if (chunk) {
        await sendMessage(env, chatId, chunk);
        chunk = "";
      }

      for (let i = 0; i < line.length; i += maxLength) {
        await sendMessage(env, chatId, line.slice(i, i + maxLength));
      }
    } else {
      chunk += (chunk ? "\n" : "") + line;
    }
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
        "برای شروع اسکن بازار دستور زیر را ارسال کن:\n/scan\n\n" +
        "راهنما: /help"
      );
      return;
    }

    if (command === "/help") {
      await sendMessage(
        env,
        chatId,
        "📘 راهنمای ربات\n\n" +
        "/scan - اسکن بازار رمزارزها\n" +
        "/status - وضعیت ربات\n" +
        "/help - راهنما\n\n" +
        "اسکن فقط با دستور دستی /scan اجرا می‌شود."
      );
      return;
    }

    if (command === "/status") {
      await sendMessage(
        env,
        chatId,
        "🟢 ربات فعال است.\nنسخه: V3.2\nحالت اسکن: دستی\nمنابع: CoinLore و Kraken"
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
        "🔎 اسکن هوشمند V3.2 شروع شد...\n" +
        "در حال بررسی روند، حجم، RSI، حمایت، مقاومت و نسبت سود به ریسک."
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
      // Ignore reporting errors.
    }
  }
}

async function registerWebhook(request, env) {
  const webhookUrl = new URL("/telegram", request.url).toString();

  try {
    const result = await telegram("setWebhook", env, {
      url: webhookUrl,
      secret_token: env.WEBHOOK_SECRET,
      allowed_updates: ["message"],
      max_connections: 5
    });

    return json({
      ok: true,
      result: result.result,
      description: result.description || "Webhook registered"
    });
  } catch (error) {
    return json({ ok: false, error: error.message }, 500);
  }
}

// CoinLore may return an array directly or an object containing data.
function extractCoinLoreAssets(payload) {
  if (Array.isArray(payload)) return payload;

  if (payload && Array.isArray(payload.data)) {
    return payload.data;
  }

  if (payload && Array.isArray(payload.coins)) {
    return payload.coins;
  }

  if (payload && payload.data && Array.isArray(payload.data.coins)) {
    return payload.data.coins;
  }

  return [];
}

async function testDataSources() {
  const results = {
    kraken: { ok: false },
    coinlore: { ok: false, assets: 0 }
  };

  try {
    const response = await fetch(
      "https://api.kraken.com/0/public/AssetPairs"
    );

    results.kraken.ok = response.ok;
    results.kraken.status = response.status;
  } catch (error) {
    results.kraken.error = error.message;
  }

  try {
    const response = await fetch(
      "https://api.coinlore.net/api/tickers/?start=0&limit=10",
      { headers: { Accept: "application/json" } }
    );

    results.coinlore.status = response.status;
    results.coinlore.ok = response.ok;

    if (response.ok) {
      const payload = await response.json();
      const assets = extractCoinLoreAssets(payload);
      results.coinlore.assets = assets.length;
    }
  } catch (error) {
    results.coinlore.error = error.message;
  }

  return results;
}

async function runScan() {
  const started = Date.now();

  const coins = await getCoins();

  if (!coins.length) {
    return (
      "❌ دریافت اطلاعات بازار ناموفق بود.\n" +
      "CoinLore پاسخ داده، اما فهرست ارزها قابل استخراج نبوده است."
    );
  }

  const candidates = coins
    .filter(coin => {
      const cap = Number(coin.market_cap_usd);
      const volume = Number(coin.volume24);
      const price = Number(coin.price_usd);

      return (
        cap >= CONFIG.MIN_MARKET_CAP &&
        cap <= CONFIG.MAX_MARKET_CAP &&
        volume >= CONFIG.MIN_DAILY_VOLUME &&
        price > 0
      );
    })
    .sort((a, b) => Number(b.volume24) - Number(a.volume24))
    .slice(0, CONFIG.MAX_CANDIDATES);

  if (!candidates.length) {
    return `⚠️ هیچ ارزی از ${coins.length} ارز دریافتی با فیلترهای اولیه مطابقت نداشت.`;
  }

  const pairs = await getKrakenPairs();

  const analyzed = await mapLimit(
    candidates,
    CONFIG.CONCURRENCY,
    async coin => {
      try {
        const pair = findKrakenPair(coin, pairs);

        if (!pair) {
          return { coin, rejected: "جفت معاملاتی USD در Kraken پیدا نشد" };
        }

        const candles = await getCandles(pair);

        if (!candles || candles.length < 55) {
          return { coin, rejected: "تعداد کندل کافی نیست" };
        }

        return analyzeCoin(coin, candles);
      } catch (error) {
        return { coin, rejected: error.message || "خطای تحلیل" };
      }
    }
  );

  const valid = analyzed
    .filter(item => item && item.eligible)
    .sort((a, b) => b.score - a.score);

  const watchlist = analyzed
    .filter(item => item && !item.eligible && item.score !== undefined)
    .sort((a, b) => b.score - a.score)
    .slice(0, CONFIG.WATCHLIST_SIZE);

  const diagnostics = analyzed
    .filter(item => item && !item.eligible)
    .sort((a, b) => (b.score || 0) - (a.score || 0))
    .slice(0, CONFIG.DIAGNOSTIC_SIZE);

  let report =
    "🚀 CRYPTO PUMP HUNTER V3.2\n" +
    "━━━━━━━━━━━━━━━━━━\n\n" +
    "📊 فیلتر ارزش بازار: 1M تا 500M دلار\n" +
    "💧 حداقل حجم روزانه: 250K دلار\n" +
    "⏱ تایم‌فریم: 1 ساعت\n" +
    `🔎 ارزهای دریافت‌شده: ${coins.length}\n` +
    `🔬 ارزهای بررسی‌شده: ${analyzed.length}\n` +
    `⭐ سیگنال‌های واجد شرایط: ${valid.length}\n\n`;

  if (valid.length) {
    report += "🔥 سیگنال‌های واجد شرایط\n━━━━━━━━━━━━━━━━━━\n\n";

    for (const item of valid.slice(0, CONFIG.MAX_RESULTS)) {
      report += formatCoin(item, true) + "\n";
    }
  } else {
    report += "⚠️ در این اسکن هیچ سیگنال خریدی تمام شرایط را نداشت.\n\n";
  }

  if (watchlist.length) {
    report += "👀 واچ‌لیست و فرصت‌های در حال شکل‌گیری\n━━━━━━━━━━━━━━━━━━\n\n";

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

      report += `• ${name} | امتیاز: ${item.score ?? "-"}\n  دلیل: ${reason}\n`;
    }
  }

  const seconds = Math.round((Date.now() - started) / 1000);

  report +=
    "\n━━━━━━━━━━━━━━━━━━\n" +
    `⏱ زمان اسکن: ${seconds} ثانیه\n` +
    "📌 منابع: CoinLore و Kraken\n" +
    "⚠️ این خروجی توصیه قطعی سرمایه‌گذاری نیست.";

  return report;
}

async function getCoins() {
  const all = [];
  const seen = new Set();

  for (const start of CONFIG.COINLORE_PAGES) {
    try {
      const response = await fetch(
        `https://api.coinlore.net/api/tickers/?start=${start}&limit=100`,
        { headers: { Accept: "application/json" } }
      );

      if (!response.ok) continue;

      const payload = await response.json();
      const assets = extractCoinLoreAssets(payload);

      for (const coin of assets) {
        const id = String(coin.id || coin.symbol || "");

        if (!id || seen.has(id)) continue;

        seen.add(id);
        all.push(coin);
      }
    } catch {
      // Continue with the next page.
    }
  }

  return all;
}

async function getKrakenPairs() {
  const response = await fetch(
    "https://api.kraken.com/0/public/AssetPairs"
  );

  if (!response.ok) {
    throw new Error(`دریافت جفت‌ارزهای Kraken ناموفق بود: ${response.status}`);
  }

  const data = await response.json();

  if (data.error && data.error.length) {
    throw new Error(data.error.join(", "));
  }

  return data.result || {};
}

function normalizeSymbol(symbol) {
  let value = String(symbol || "").toUpperCase();

  if (value === "BTC") value = "XBT";

  return value.replace(/[^A-Z0-9]/g, "");
}

function findKrakenPair(coin, pairs) {
  const symbol = normalizeSymbol(coin.symbol);

  for (const [key, pair] of Object.entries(pairs)) {
    const wsname = String(pair.wsname || "").toUpperCase();
    const altname = String(pair.altname || "").toUpperCase();

    const base = normalizeSymbol(wsname.split("/")[0] || "");
    const quote = wsname.split("/")[1] || "";

    if (
      base === symbol &&
      (quote === "USD" || quote === "USDT")
    ) {
      return pair.altname || key;
    }

    if (
      altname === `${symbol}USD` ||
      altname === `${symbol}USDT`
    ) {
      return pair.altname || key;
    }
  }

  return null;
}

async function getCandles(pair) {
  const url =
    "https://api.kraken.com/0/public/OHLC" +
    `?pair=${encodeURIComponent(pair)}&interval=60`;

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`خطای دریافت کندل Kraken: ${response.status}`);
  }

  const data = await response.json();

  if (data.error && data.error.length) {
    throw new Error(data.error.join(", "));
  }

  const result = data.result || {};
  const key = Object.keys(result).find(name => name !== "last");

  if (!key || !Array.isArray(result[key])) {
    throw new Error("اطلاعات کندل موجود نیست.");
  }

  return result[key]
    .slice(0, -1)
    .map(row => ({
      time: Number(row[0]),
      open: Number(row[1]),
      high: Number(row[2]),
      low: Number(row[3]),
      close: Number(row[4]),
      volume: Number(row[6])
    }))
    .filter(candle =>
      candle.close > 0 &&
      candle.high > 0 &&
      candle.low > 0
    );
}

function ema(values, period) {
  if (values.length < period) return null;

  const multiplier = 2 / (period + 1);

  let result =
    values.slice(0, period).reduce((sum, value) => sum + value, 0) /
    period;

  for (let i = period; i < values.length; i++) {
    result = values[i] * multiplier + result * (1 - multiplier);
  }

  return result;
}

function rsi(values, period = 14) {
  if (values.length <= period) return null;

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const change = values[i] - values[i - 1];

    if (change > 0) gains += change;
    else losses += Math.abs(change);
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
  return 100 - 100 / (1 + rs);
}

function findLevels(candles) {
  const recent = candles.slice(-31, -1);

  if (recent.length < 10) {
    throw new Error("کندل کافی برای محاسبه سطوح وجود ندارد.");
  }

  return {
    support: Math.min(...recent.map(c => c.low)),
    resistance: Math.max(...recent.map(c => c.high))
  };
}

function analyzeCoin(coin, candles) {
  const closes = candles.map(c => c.close);
  const last = candles[candles.length - 1];

  const current = last.close;
  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  const rsi14 = rsi(closes, 14);

  if (ema20 === null || ema50 === null || rsi14 === null) {
    throw new Error("اندیکاتورهای کافی محاسبه نشدند.");
  }

  const { support, resistance } = findLevels(candles);

  const previousVolumes = candles.slice(-21, -1).map(c => c.volume);

  const avgVolume = previousVolumes.length
    ? previousVolumes.reduce((a, b) => a + b, 0) / previousVolumes.length
    : 0;

  const volumeRatio = avgVolume > 0 ? last.volume / avgVolume : 0;

  const trendUp = ema20 > ema50;
  const aboveEMA20 = current > ema20;
  const aboveEMA50 = current > ema50;

  let score = 0;
  const reasons = [];

  if (trendUp) score += 25;
  else reasons.push("روند EMA20 بالاتر از EMA50 نیست");

  if (rsi14 >= 45 && rsi14 <= 68) score += 15;
  else if (rsi14 > 68) {
    score += 5;
    reasons.push("RSI نسبتاً بالا است");
  } else {
    reasons.push("قدرت RSI کافی نیست");
  }

  if (volumeRatio >= 1.5) score += 20;
  else if (volumeRatio >= 1.1) score += 15;
  else if (volumeRatio >= 0.9) {
    score += 10;
    reasons.push("افزایش حجم هنوز تأیید نشده است");
  } else {
    reasons.push("حجم معاملات پایین است");
  }

  const dailyVolume = Number(coin.volume24);

  if (dailyVolume >= 1_000_000) score += 10;
  else if (dailyVolume >= 500_000) score += 7;
  else score += 4;

  const dailyChange = Number(coin.percent_change_24h);

  if (dailyChange > 0 && dailyChange < 12) score += 10;
  else if (dailyChange >= 12) {
    score += 5;
    reasons.push("رشد روزانه زیاد است؛ احتمال ورود دیرهنگام");
  } else {
    reasons.push("تغییرات روزانه هنوز مثبت نیست");
  }

  if (aboveEMA20 && aboveEMA50) score += 20;
  else if (aboveEMA20 || aboveEMA50) score += 10;
  else reasons.push("قیمت زیر میانگین‌های متحرک است");

  score = Math.min(100, score);

  let setup = "بدون ستاپ";

  if (
    current > resistance * 1.002 &&
    volumeRatio >= 1.1 &&
    trendUp
  ) {
    setup = "شکست مقاومت";
  } else if (
    trendUp &&
    current > ema20 &&
    last.low <= ema20 * 1.01
  ) {
    setup = "پولبک به EMA20";
  } else if (
    last.low <= support * 1.015 &&
    current > support * 1.01 &&
    current > last.open
  ) {
    setup = "واکنش به حمایت";
  }

  const recentLow = Math.min(
    ...candles.slice(-8).map(c => c.low)
  );

  let entry = current;
  let stop = Math.min(support * 0.99, recentLow * 0.995);

  if (setup === "پولبک به EMA20") {
    stop = Math.min(ema20 * 0.985, recentLow * 0.995);
  }

  if (setup === "واکنش به حمایت") {
    stop = Math.min(support * 0.985, recentLow * 0.995);
  }

  const risk = entry - stop;
  const validStop = risk > 0;
  const validResistance = resistance > entry;

  const rewardRisk =
    validStop && validResistance
      ? (resistance - entry) / risk
      : 0;

  if (!validStop) reasons.push("حد ضرر معتبر محاسبه نشد");
  if (!validResistance) reasons.push("مقاومت بالاتر از قیمت ورود نیست");

  if (rewardRisk < CONFIG.MIN_REWARD_RISK) {
    reasons.push("نسبت سود به ریسک کمتر از 1.5 است");
  }

  if (setup === "بدون ستاپ") {
    reasons.push("الگوی ورود مشخصی تشکیل نشده است");
  }

  if (score < CONFIG.MIN_SCORE) {
    reasons.push(`امتیاز کمتر از ${CONFIG.MIN_SCORE} است`);
  }

  const eligible =
    score >= CONFIG.MIN_SCORE &&
    setup !== "بدون ستاپ" &&
    volumeRatio >= 0.9 &&
    validStop &&
    validResistance &&
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
    target1: resistance,
    target2: entry + risk * 2.5,
    target3: entry + risk * 3.5,
    rewardRisk,
    eligible,
    reasons
  };
}

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
    `🔴 مقاومت: $${formatPrice(item.resistance)}\n`;

  if (isSignal) {
    text +=
      `\n🎯 محدوده ورود: $${formatPrice(item.entry)}` +
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
      `\n🎯 مقاومت هدف: $${formatPrice(item.target1)}` +
      `\n⚖️ نسبت سود به ریسک: ${item.rewardRisk.toFixed(2)}R\n`;
  }

  return text;
}

async function mapLimit(items, limit, callback) {
  const results = new Array(items.length);
  let index = 0;

  async function worker() {
    while (true) {
      const currentIndex = index++;

      if (currentIndex >= items.length) return;

      results[currentIndex] = await callback(items[currentIndex]);
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


const API = "https://api.telegram.org";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
if (url.pathname === "/testdata" && request.method === "GET") {
  if (!env.SETUP_KEY || url.searchParams.get("key") !== env.SETUP_KEY) {
    return new Response("Unauthorized", { status: 401 });
  }

  const [binance, paprika] = await Promise.all([
    fetch("https://data-api.binance.vision/api/v3/ping").catch(() => null),
    fetch("https://api.coinpaprika.com/v1/tickers").catch(() => null)
  ]);

  let assetCount = null;

  if (paprika && paprika.ok) {
    const data = await paprika.json();
    assetCount = Array.isArray(data) ? data.length : null;
  }

  return Response.json({
    binance: {
      ok: !!binance?.ok,
      status: binance?.status ?? "network_error"
    },
    coinpaprika: {
      ok: !!paprika?.ok,
      status: paprika?.status ?? "network_error",
      assets: assetCount
    }
  });
}
    if (url.pathname === "/") {
      return new Response("Crypto Pump Hunter is running.");
    }

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

    if (url.pathname === "/telegram" && request.method === "POST") {
      if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.WEBHOOK_SECRET) {
        return new Response("Forbidden", { status: 403 });
      }

      const update = await request.json();
      const message = update.message;
      if (!message || !message.text) return new Response("OK");

      const chatId = String(message.chat.id);
      const ownerId = String(env.OWNER_ID);

      if (chatId !== ownerId || String(message.from.id) !== ownerId) {
        ctx.waitUntil(sendMessage(env, chatId, "⛔ این ربات خصوصی است."));
        return new Response("OK");
      }

      const command = message.text.trim().split(/\s+/)[0].split("@")[0];

      if (command === "/start") {
        ctx.waitUntil(sendMessage(env, chatId,
          "🚀 Crypto Pump Hunter فعال شد!\n\n/scan - اسکن بازار\n/status - وضعیت ربات\n/help - راهنما"
        ));
      } else if (command === "/help") {
        ctx.waitUntil(sendMessage(env, chatId,
          "دستورهای ربات:\n/scan - شروع اسکن بازار\n/status - بررسی فعال بودن ربات"
        ));
      } else if (command === "/status") {
        ctx.waitUntil(sendMessage(env, chatId,
          "✅ ربات فعال است.\nاسکن فقط با دستور /scan انجام می‌شود."
        ));
      } else if (command === "/scan") {
        ctx.waitUntil((async () => {
          await sendMessage(env, chatId, "🔎 اسکن شروع شد؛ لطفاً چند لحظه صبر کن...");
          await runScan(env, chatId);
        })());
      }

      return new Response("OK");
    }

    return new Response("Not found", { status: 404 });
  }
};

async function telegram(env, method, body) {
  const response = await fetch(`${API}/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  return await response.json();
}

async function sendMessage(env, chatId, text) {
  return telegram(env, "sendMessage", {
    chat_id: chatId,
    text,
    disable_web_page_preview: true
  });
}

async function runScan(env, chatId) {
  await sendMessage(env, chatId, "📡 در حال بررسی منابع بازار هستم...");

  const results = await Promise.allSettled([
    scanCoinGecko(),
    scanDexScreener()
  ]);

  const all = results.flatMap(result =>
    result.status === "fulfilled" ? result.value : []
  );

  const errors = results
    .filter(result => result.status === "rejected")
    .map(result => String(result.reason).slice(0, 100));

  if (!all.length) {
    await sendMessage(env, chatId,
      "❌ در حال حاضر داده‌ای دریافت نشد.\n" +
      (errors.length ? errors.join("\n") : "منابع داده نتیجه‌ای برنگرداندند.")
    );
    return;
  }

  const unique = new Map();

  for (const coin of all) {
    const key = `${coin.source}:${coin.symbol}`;
    if (!unique.has(key) || coin.score > unique.get(key).score) {
      unique.set(key, coin);
    }
  }

  const top = [...unique.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);

  let output = "🚀 CRYPTO PUMP HUNTER\n";
  output += "━━━━━━━━━━━━━━━━━━\n";
  output += `فرصت‌های برتر: ${top.length}\n`;
  output += "امتیازها الگوریتمی‌اند و تضمین رشد نیستند.\n\n";

  for (let i = 0; i < top.length; i++) {
    const c = top[i];
    output += `${i + 1}) ${c.name} (${c.symbol})\n`;
    output += `💵 قیمت: $${formatPrice(c.price)}\n`;
    output += `📊 تغییر ۲۴ساعته: ${c.change.toFixed(2)}%\n`;
    output += `📈 حجم ۲۴ساعته: $${compact(c.volume)}\n`;
    output += `🎯 امتیاز: ${c.score}/100 | ${c.source}\n`;
    output += `🧠 دلیل: ${c.reason}\n\n`;
  }

  if (errors.length) {
    output += "⚠️ برخی منابع در دسترس نبودند؛ نتایج محدود است.\n";
  }

  output += "قبل از خرید، نقدینگی، قرارداد و نمودار را بررسی کن.";
  await sendMessage(env, chatId, output);
}

async function scanCoinGecko() {
  const pages = await Promise.allSettled([1, 2].map(async page => {
    const url = "https://api.coingecko.com/api/v3/coins/markets" +
      `?vs_currency=usd&order=volume_desc&per_page=100&page=${page}` +
      "&sparkline=false&price_change_percentage=24h,7d";

    const response = await fetch(url, {
      headers: { "accept": "application/json" }
    });

    if (!response.ok) throw new Error("CoinGecko HTTP " + response.status);
    return response.json();
  }));

  const coins = pages.flatMap(result =>
    result.status === "fulfilled" ? result.value : []
  );

  if (!coins.length) throw new Error("CoinGecko unavailable");

  return coins.filter(c =>
    c.current_price &&
    c.market_cap >= 1000000 &&
    c.market_cap <= 500000000 &&
    c.total_volume >= 100000 &&
    c.symbol
  ).map(c => {
    const change = Number(c.price_change_percentage_24h || 0);
    const change7d = Number(c.price_change_percentage_7d_in_currency || 0);
    const ratio = c.total_volume / Math.max(c.market_cap, 1);

    let score = 35;
    if (ratio > 0.15) score += 15;
    if (ratio > 0.30) score += 10;
    if (change > 0 && change < 8) score += 12;
    if (change >= 8 && change < 15) score += 7;
    if (change7d > 0) score += 8;
    if (change7d > 10) score += 5;
    if (change < -12) score -= 15;
    if (c.total_volume > 1000000) score += 5;

    return {
      name: c.name,
      symbol: c.symbol.toUpperCase(),
      price: c.current_price,
      change,
      volume: c.total_volume,
      score: Math.max(0, Math.min(100, score)),
      source: "CoinGecko",
      reason: `نسبت حجم به مارکت‌کپ ${(ratio * 100).toFixed(1)}%`
    };
  });
}

async function scanDexScreener() {
  const response = await fetch(
    "https://api.dexscreener.com/token-profiles/latest/v1"
  );
  if (!response.ok) throw new Error("DexScreener HTTP " + response.status);

  const profiles = await response.json();
  const tokens = (Array.isArray(profiles) ? profiles : [])
    .filter(p => p.chainId && p.tokenAddress)
    .slice(0, 15);

  const results = await Promise.all(tokens.map(async token => {
    try {
      const r = await fetch(
        `https://api.dexscreener.com/token-pairs/v1/${token.chainId}/${token.tokenAddress}`
      );
      if (!r.ok) return null;

      const pairs = await r.json();
      if (!Array.isArray(pairs) || !pairs.length) return null;

      const pair = pairs.sort(
        (a, b) => Number(b.liquidity?.usd || 0) - Number(a.liquidity?.usd || 0)
      )[0];

      const liquidity = Number(pair.liquidity?.usd || 0);
      const volume = Number(pair.volume?.h24 || 0);
      const change = Number(pair.priceChange?.h24 || 0);

      if (liquidity < 20000 || volume < 50000) return null;

      let score = 40;
      if (volume / liquidity > 1) score += 15;
      if (volume / liquidity > 2) score += 10;
      if (change > 0 && change < 15) score += 12;
      if (change < -15) score -= 15;
      if (liquidity > 100000) score += 8;

      return {
        name: pair.baseToken?.name || "Unknown",
        symbol: (pair.baseToken?.symbol || "???").toUpperCase(),
        price: Number(pair.priceUsd || 0),
        change,
        volume,
        score: Math.max(0, Math.min(100, score)),
        source: "DEX",
        reason: `نقدینگی $${compact(liquidity)}`
      };
    } catch {
      return null;
    }
  }));

  return results.filter(Boolean);
}

function compact(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return Number(n).toFixed(0);
}

function formatPrice(n) {
  if (n >= 1) return Number(n).toFixed(4);
  if (n >= 0.01) return Number(n).toFixed(5);
  return Number(n).toPrecision(5);
}

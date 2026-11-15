کد ربات ورژن ۳.۶ جدید





const CONFIG = {
  VERSION: "3.6",
  MIN_MARKET_CAP: 1_000_000,
  MAX_MARKET_CAP: 500_000_000,
  MIN_DAILY_VOLUME: 250_000,
  MAX_CANDIDATES: 35,
  MAX_RESULTS: 5,
  WATCHLIST_SIZE: 5,
  DIAGNOSTIC_SIZE: 8,
  CONCURRENCY: 2,
  MIN_SCORE: 65,
  MIN_REWARD_RISK: 1.5,
  CANDLE_INTERVAL: 60,
  MIN_CANDLES: 55,
  COINLORE_PAGES: [0, 100, 200, 300, 400, 500, 600, 700, 800, 900],
  PENDING_TTL: 604800
};

const TELEGRAM_API = "https://api.telegram.org";
const seenUpdates = new Set();

const ABOUT_TEXT =
  "🚀 CRYPTO PUMP HUNTER V3.6\n\n" +
  "طراحی و توسعه: علیرضا سعادتی\n\n" +
  "© تمامی حقوق مادی و معنوی این ربات محفوظ است.\n\n" +
  "هرگونه کپی‌برداری، بازنشر یا استفاده بدون کسب اجازه از صاحب اثر مجاز نیست.";

const MAIN_MENU = {
  inline_keyboard: [
    [{ text: "🚀 اسکن هوشمند بازار", callback_data: "scan" }],
    [{ text: "📊 تحلیل بازار", callback_data: "analysis" }],
    [{ text: "📈 بررسی روندها", callback_data: "trends" }],
    [{ text: "🎯 شکار فرصت‌ها", callback_data: "opportunities" }],
    [{ text: "ℹ️ درباره", callback_data: "about" }]
  ]
};

const BACK_MENU = {
  inline_keyboard: [
    [{ text: "🏠 منوی اصلی", callback_data: "menu" }]
  ]
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return json({
        ok: true,
        service: "Crypto Pump Hunter",
        version: CONFIG.VERSION,
        mode: "Manual scan only",
        kv: Boolean(env.WATCHLIST_KV),
        membership: true
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

      if (update.callback_query) {
        ctx.waitUntil(handleCallback(update.callback_query, env));
        return new Response("OK");
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

      ctx.waitUntil(handleTelegramCommand(command, chatId, env, message));
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
      "User-Agent": `CryptoPumpHunter/${CONFIG.VERSION}`
    }
  });

  const body = await response.text();
  let data;

  try {
    data = JSON.parse(body);
  } catch {
    throw new Error(`${label}: پاسخ JSON معتبر نیست؛ HTTP ${response.status}`);
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

async function sendMessage(env, chatId, text, replyMarkup = null) {
  const body = {
    chat_id: chatId,
    text,
    disable_web_page_preview: true
  };

  if (replyMarkup) body.reply_markup = replyMarkup;

  return telegram("sendMessage", env, body);
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

async function answerCallback(env, callbackId, text = "") {
  try {
    await telegram("answerCallbackQuery", env, {
      callback_query_id: callbackId,
      text,
      show_alert: false
    });
  } catch {
    // Ignore callback acknowledgement errors.
  }
}

// ---------------- SECURITY AND MEMBERSHIP ----------------

function isOwner(chatId, env) {
  return Boolean(
    env.OWNER_ID &&
    String(chatId) === String(env.OWNER_ID)
  );
}

function memberKey(chatId) {
  return `member:${chatId}`;
}

function pendingKey(chatId) {
  return `pending:${chatId}`;
}

async function isApproved(chatId, env) {
  if (isOwner(chatId, env)) return true;

  if (!env.OWNER_ID || !env.WATCHLIST_KV) return false;

  try {
    const member = await env.WATCHLIST_KV.get(memberKey(chatId));
    return Boolean(member);
  } catch {
    return false;
  }
}

async function requestMembership(env, chatId, message) {
  if (isOwner(chatId, env)) {
    await showMenu(env, chatId);
    return;
  }

  if (!env.OWNER_ID || !env.WATCHLIST_KV) {
    await sendMessage(
      env,
      chatId,
      "⚠️ در حال حاضر امکان ثبت درخواست عضویت وجود ندارد.\nلطفاً بعداً دوباره تلاش کنید."
    );
    return;
  }

  if (await isApproved(chatId, env)) {
    await showMenu(env, chatId);
    return;
  }

  try {
    const existing = await env.WATCHLIST_KV.get(pendingKey(chatId));

    if (existing) {
      await sendMessage(
        env,
        chatId,
        "⏳ درخواست عضویت شما قبلاً ثبت شده است.\n\n" +
        "درخواست شما در انتظار بررسی است. پس از تعیین نتیجه، از طریق همین ربات مطلع می‌شوید."
      );
      return;
    }

    const user = message?.from || {};

    const applicant = {
      chatId: String(chatId),
      userId: String(user.id || chatId),
      username: user.username || "",
      firstName: user.first_name || "",
      lastName: user.last_name || "",
      requestedAt: new Date().toISOString()
    };

    await env.WATCHLIST_KV.put(
      pendingKey(chatId),
      JSON.stringify(applicant),
      { expirationTtl: CONFIG.PENDING_TTL }
    );

    const displayName =
      [applicant.firstName, applicant.lastName]
        .filter(Boolean)
        .join(" ") || "نام ثبت نشده";

    const username = applicant.username
      ? `@${applicant.username}`
      : "ندارد";

    const adminText =
      "🔔 درخواست عضویت جدید\n" +
      "━━━━━━━━━━━━━━━━━━\n\n" +
      `👤 نام: ${displayName}\n` +
      `🔗 نام کاربری: ${username}\n` +
      `🆔 شناسه کاربر: ${applicant.userId}\n` +
      `🕒 زمان درخواست: ${applicant.requestedAt}\n\n` +
      "برای تعیین وضعیت درخواست از دکمه‌های زیر استفاده کن.";

    const adminButtons = {
      inline_keyboard: [
        [
          {
            text: "✅ تأیید عضویت",
            callback_data: `approve:${chatId}`
          },
          {
            text: "❌ رد درخواست",
            callback_data: `reject:${chatId}`
          }
        ]
      ]
    };

    await sendMessage(env, env.OWNER_ID, adminText, adminButtons);

    await sendMessage(
      env,
      chatId,
      "✅ درخواست عضویت شما با موفقیت ثبت شد.\n\n" +
      "⏳ درخواست شما در انتظار بررسی است.\n" +
      "پس از تعیین نتیجه، از طریق همین ربات مطلع می‌شوید."
    );
  } catch (error) {
    try {
      await env.WATCHLIST_KV.delete(pendingKey(chatId));
    } catch {
      // Ignore cleanup errors.
    }

    await sendMessage(
      env,
      chatId,
      "❌ ثبت درخواست با مشکل مواجه شد.\nلطفاً کمی بعد دوباره تلاش کنید."
    );
  }
}

async function handleAdminMembershipCallback(query, env) {
  const ownerId = env.OWNER_ID;
  const actorId = query.from?.id;
  const chatId = query.message?.chat?.id;
  const action = query.data || "";

  if (
    !ownerId ||
    String(actorId) !== String(ownerId) ||
    String(chatId) !== String(ownerId)
  ) {
    await answerCallback(env, query.id, "⛔ دسترسی غیرمجاز");
    return true;
  }

  const match = action.match(/^(approve|reject):(-?\d+)$/);

  if (!match) return false;

  const operation = match[1];
  const applicantId = match[2];

  await answerCallback(
    env,
    query.id,
    operation === "approve" ? "در حال تأیید..." : "در حال رد درخواست..."
  );

  if (!env.WATCHLIST_KV) {
    await sendMessage(env, ownerId, "❌ اتصال KV در دسترس نیست.");
    return true;
  }

  try {
    const pending = await env.WATCHLIST_KV.get(
      pendingKey(applicantId),
      "json"
    );

    if (!pending) {
      await sendMessage(
        env,
        ownerId,
        "⚠️ درخواست پیدا نشد یا مهلت آن به پایان رسیده است."
      );
      return true;
    }

    if (operation === "approve") {
      const member = {
        ...pending,
        approvedAt: new Date().toISOString(),
        approved: true
      };

      await env.WATCHLIST_KV.put(
        memberKey(applicantId),
        JSON.stringify(member)
      );

      await env.WATCHLIST_KV.delete(pendingKey(applicantId));

      await sendMessage(
        env,
        applicantId,
        "🎉 عضویت شما تأیید شد.\n\n" +
        "اکنون دسترسی کامل به امکانات ربات برای شما فعال است.\n" +
        "برای شروع دستور /start را ارسال کنید."
      );

      await sendMessage(
        env,
        ownerId,
        "✅ عضویت کاربر با موفقیت تأیید شد."
      );
    } else {
      await env.WATCHLIST_KV.delete(pendingKey(applicantId));

      await sendMessage(
        env,
        applicantId,
        "❌ درخواست عضویت شما تأیید نشد."
      );

      await sendMessage(
        env,
        ownerId,
        "❌ درخواست عضویت رد شد."
      );
    }
  } catch (error) {
    await sendMessage(
      env,
      ownerId,
      "❌ خطا در پردازش درخواست:\n" +
      String(error.message || "Unknown error").slice(0, 500)
    );
  }

  return true;
}
// ---------------- MAIN MENU ----------------

async function showMenu(env, chatId) {
  await sendMessage(
    env,
    chatId,
    `🚀 CRYPTO PUMP HUNTER V${CONFIG.VERSION}\n\n` +
    "از منوی زیر گزینه موردنظر را انتخاب کن:",
    MAIN_MENU
  );
}

async function handleTelegramCommand(command, chatId, env, message) {
  try {
    if (command === "/start" || command === "/menu") {
      await requestMembership(env, chatId, message);
      return;
    }

    if (!(await isApproved(chatId, env))) {
      await requestMembership(env, chatId, message);
      return;
    }

    if (command === "/help") {
      await sendMessage(
        env,
        chatId,
        "📘 راهنمای ربات\n\n" +
        "/start - نمایش منوی اصلی\n" +
        "/scan - اسکن دستی بازار\n" +
        "/status - وضعیت ربات\n" +
        "/help - راهنما\n\n" +
        "اسکن فقط با درخواست دستی شما اجرا می‌شود.",
        MAIN_MENU
      );
      return;
    }

    if (command === "/status") {
      await showStatus(env, chatId);
      return;
    }

    if (command === "/scan") {
      await runScanForChat(env, chatId);
      return;
    }

    await sendMessage(
      env,
      chatId,
      "برای استفاده از ربات، /start را بفرست.",
      MAIN_MENU
    );
  } catch (error) {
    try {
      await sendMessage(
        env,
        chatId,
        "❌ خطا در اجرای دستور:\n" +
        String(error.message || "Unknown error").slice(0, 1000),
        MAIN_MENU
      );
    } catch {
      // Ignore Telegram reporting errors.
    }
  }
}

async function handleCallback(query, env) {
  const chatId = query.message?.chat?.id;
  const action = query.data || "";

  if (!chatId) {
    await answerCallback(env, query.id);
    return;
  }

  if (action.startsWith("approve:") || action.startsWith("reject:")) {
    await handleAdminMembershipCallback(query, env);
    return;
  }

  if (!(await isApproved(chatId, env))) {
    await answerCallback(env, query.id);
    await requestMembership(env, chatId, {
      from: query.from
    });
    return;
  }

  await answerCallback(env, query.id);

  try {
    if (action === "menu") {
      await showMenu(env, chatId);
      return;
    }

    if (action === "scan") {
      await runScanForChat(env, chatId);
      return;
    }

    if (action === "analysis") {
      await showLastAnalysis(env, chatId);
      return;
    }

    if (action === "trends") {
      await runTrendReviewForChat(env, chatId);
      return;
    }

    if (action === "opportunities") {
      await runOpportunityHuntForChat(env, chatId);
      return;
    }

    if (action === "watchlist") {
      await showWatchlist(env, chatId);
      return;
    }

    if (action === "status") {
      await showStatus(env, chatId);
      return;
    }

    if (action === "test") {
      await showConnectionTest(env, chatId);
      return;
    }

    if (action === "settings") {
      await showSettings(env, chatId);
      return;
    }

    if (action === "about") {
      await sendMessage(env, chatId, ABOUT_TEXT, BACK_MENU);
      return;
    }

    await showMenu(env, chatId);
  } catch (error) {
    await sendMessage(
      env,
      chatId,
      "❌ خطا:\n" + String(error.message || error).slice(0, 1000),
      MAIN_MENU
    );
  }
}

async function runScanForChat(env, chatId) {
  if (!(await isApproved(chatId, env))) {
    await sendMessage(env, chatId, "⛔ دسترسی شما فعال نیست.");
    return;
  }

  await sendMessage(
    env,
    chatId,
    `🚀 اسکن هوشمند بازار V${CONFIG.VERSION} شروع شد...\n` +
    "در حال بررسی بازار، روند، حجم، RSI و سطوح قیمتی."
  );

  const result = await runScan(env);
  await sendLongMessage(env, chatId, result.report);

  await sendMessage(
    env,
    chatId,
    "عملیات اسکن به پایان رسید.",
    MAIN_MENU
  );
}

async function showStatus(env, chatId) {
  let lastScan = "هنوز اسکن ذخیره‌شده‌ای وجود ندارد.";

  if (env.WATCHLIST_KV) {
    try {
      const saved = await env.WATCHLIST_KV.get("last_scan", "json");
      if (saved?.timestamp) {
        lastScan = new Date(saved.timestamp).toLocaleString("en-GB", {
          timeZone: "UTC"
        }) + " UTC";
      }
    } catch {
      lastScan = "خواندن اطلاعات اسکن قبلی ناموفق بود.";
    }
  }

  await sendMessage(
    env,
    chatId,
    `🟢 وضعیت Crypto Pump Hunter\n\n` +
    `نسخه: V${CONFIG.VERSION}\n` +
    "حالت اسکن: فقط دستی\n" +
    "منابع داده: CoinLore و Kraken\n" +
    `اتصال KV: ${env.WATCHLIST_KV ? "فعال" : "غیرفعال"}\n` +
    `آخرین اسکن ذخیره‌شده: ${lastScan}`,
    MAIN_MENU
  );
}

async function showSettings(env, chatId) {
  await sendMessage(
    env,
    chatId,
    "⚙️ تنظیمات فعلی ربات\n\n" +
    `📊 حداقل ارزش بازار: $${CONFIG.MIN_MARKET_CAP.toLocaleString("en-US")}\n` +
    `📊 حداکثر ارزش بازار: $${CONFIG.MAX_MARKET_CAP.toLocaleString("en-US")}\n` +
    `💧 حداقل حجم روزانه: $${CONFIG.MIN_DAILY_VOLUME.toLocaleString("en-US")}\n` +
    `🔎 حداکثر کاندیدا: ${CONFIG.MAX_CANDIDATES}\n` +
    `⭐ حداقل امتیاز: ${CONFIG.MIN_SCORE}/100\n` +
    `⚖️ حداقل نسبت سود به ریسک: ${CONFIG.MIN_REWARD_RISK}R\n` +
    `⏱ تایم‌فریم: ${CONFIG.CANDLE_INTERVAL} دقیقه\n` +
    `👀 تعداد واچ‌لیست: ${CONFIG.WATCHLIST_SIZE}\n\n` +
    "این مقادیر در کد ربات تعریف شده‌اند.",
    BACK_MENU
  );
}

async function showLastAnalysis(env, chatId) {
  if (!env.WATCHLIST_KV) {
    await sendMessage(
      env,
      chatId,
      "⚠️ اتصال KV فعال نیست. ابتدا Binding را بررسی کن.",
      MAIN_MENU
    );
    return;
  }

  const saved = await env.WATCHLIST_KV.get("last_scan", "json");

  if (!saved?.report) {
    await sendMessage(
      env,
      chatId,
      "هنوز گزارشی ذخیره نشده است.\nابتدا یک‌بار اسکن بازار را اجرا کن.",
      MAIN_MENU
    );
    return;
  }

  await sendLongMessage(env, chatId, saved.report);
  await sendMessage(env, chatId, "پایان آخرین گزارش ذخیره‌شده.", MAIN_MENU);
}

async function showWatchlist(env, chatId) {
  if (!env.WATCHLIST_KV) {
    await sendMessage(
      env,
      chatId,
      "⚠️ اتصال KV فعال نیست. Binding را در تنظیمات Worker بررسی کن.",
      MAIN_MENU
    );
    return;
  }

  const saved = await env.WATCHLIST_KV.get("last_scan", "json");

  if (!saved?.watchlist?.length) {
    await sendMessage(
      env,
      chatId,
      "👀 واچ‌لیست خالی است.\nپس از اجرای اسکن، ارزهای منتخب اینجا ذخیره می‌شوند.",
      MAIN_MENU
    );
    return;
  }

  let text =
    "👀 واچ‌لیست آخرین اسکن\n" +
    "━━━━━━━━━━━━━━━━━━\n\n";

  for (const item of saved.watchlist) {
    text +=
      `🪙 ${item.name} (${item.symbol})\n` +
      `⭐ امتیاز: ${item.score}/100\n` +
      `💵 قیمت: $${formatPrice(item.current)}\n` +
      `📈 روند: ${item.trend}\n` +
      `📊 RSI: ${Number(item.rsi).toFixed(1)}\n` +
      `🧩 الگو: ${item.setup}\n` +
      `🟢 حمایت: $${formatPrice(item.support)}\n` +
      `🔴 مقاومت: $${formatPrice(item.resistance)}\n` +
      `⚖️ نسبت سود به ریسک: ${Number(item.rewardRisk).toFixed(2)}R\n\n`;
  }

  text += "⚠️ واچ‌لیست سیگنال قطعی خرید نیست.";
  await sendLongMessage(env, chatId, text);
  await sendMessage(env, chatId, "پایان واچ‌لیست.", MAIN_MENU);
}

async function showConnectionTest(env, chatId) {
  await sendMessage(env, chatId, "🔌 در حال بررسی اتصال منابع داده...");

  const result = await testDataSources();

  const coinLore = result.coinlore.ok
    ? `✅ CoinLore: متصل (${result.coinlore.assets} ارز نمونه)`
    : `❌ CoinLore: ${result.coinlore.error}`;

  const kraken = result.kraken.ok
    ? `✅ Kraken: متصل (${result.kraken.pairs} جفت معاملاتی)`
    : `❌ Kraken: ${result.kraken.error}`;

  await sendMessage(
    env,
    chatId,
    "🔌 نتیجه تست اتصال\n\n" +
    coinLore + "\n\n" +
    kraken + "\n\n" +
    `نسخه ربات: V${CONFIG.VERSION}`,
    MAIN_MENU
  );
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
      allowed_updates: ["message", "callback_query"],
      max_connections: 5
    };

    if (env.WEBHOOK_SECRET) {
      body.secret_token = env.WEBHOOK_SECRET;
    }

    const result = await telegram("setWebhook", env, body);

    return json({
      ok: true,
      result: result.result,
      description: result.description || "Webhook registered",
      allowed_updates: ["message", "callback_query"]
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

  if (setup === "شکست مقاومت") {
    const rangeHeight = Math.max(rangeHigh - rangeLow, entry * 0.01);
    target1 = entry + rangeHeight;
  }

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

// ---------------- MARKET TRENDS AND OPPORTUNITIES ----------------

async function getMarketAnalysisData() {
  const coinResult = await getCoins();
  const coins = coinResult.coins;

  if (!coins.length) {
    throw new Error(
      "دریافت فهرست ارزها از CoinLore ناموفق بود. " +
      coinResult.errors.slice(0, 3).join(" | ")
    );
  }

  const candidates = coins
    .filter(coin => {
      const cap = Number(coin.market_cap_usd);
      const volume = Number(coin.volume24);
      const price = Number(coin.price_usd);
      return Number.isFinite(cap) &&
        Number.isFinite(volume) &&
        Number.isFinite(price) &&
        cap >= CONFIG.MIN_MARKET_CAP &&
        cap <= CONFIG.MAX_MARKET_CAP &&
        volume >= CONFIG.MIN_DAILY_VOLUME &&
        price > 0;
    })
    .sort((a, b) => Number(b.volume24) - Number(a.volume24))
    .slice(0, CONFIG.MAX_CANDIDATES);

  if (!candidates.length) {
    return { coins, candidates, analyzed: [], errors: coinResult.errors };
  }

  const pairs = await getKrakenPairs();
  const analyzed = await mapLimit(
    candidates,
    CONFIG.CONCURRENCY,
    async coin => {
      try {
        const pair = findKrakenPair(coin, pairs);
        if (!pair) return { coin, rejected: "جفت معاملاتی USD/USDT در Kraken پیدا نشد" };
        const candles = await getCandles(pair);
        if (candles.length < CONFIG.MIN_CANDLES) {
          return { coin, rejected: `کندل کافی نیست؛ تعداد موجود: ${candles.length}` };
        }
        return analyzeCoin(coin, candles);
      } catch (error) {
        return { coin, rejected: error.message || "خطای ناشناخته در تحلیل" };
      }
    }
  );

  return { coins, candidates, analyzed, errors: coinResult.errors };
}

function classifyTrend(item) {
  if (item.ema20 > item.ema50 && item.current > item.ema20 && item.current > item.ema50) {
    return "صعودی";
  }
  if (item.ema20 < item.ema50 && item.current < item.ema20 && item.current < item.ema50) {
    return "نزولی";
  }
  return "خنثی";
}

function formatTrendItem(item) {
  const change = Number(item.coin.percent_change_24h) || 0;
  return `🪙 ${item.coin.name} (${item.coin.symbol})\n` +
    `💵 قیمت: $${formatPrice(item.current)}\n` +
    `📅 تغییر ۲۴ ساعته: ${change.toFixed(2)}%\n` +
    `📊 RSI: ${item.rsi.toFixed(1)}\n` +
    `EMA20: $${formatPrice(item.ema20)} | EMA50: $${formatPrice(item.ema50)}\n` +
    `💧 حجم روزانه: $${Number(item.coin.volume24 || 0).toLocaleString("en-US")}\n` +
    `📉 نسبت حجم کندل: ${item.volumeRatio.toFixed(2)}x\n` +
    `⭐ امتیاز تحلیلی: ${item.score}/100\n`;
}

async function runTrendReviewForChat(env, chatId) {
  await sendMessage(env, chatId, "📈 در حال بررسی روند ارزهای بازار در تایم‌فریم یک‌ساعته...");
  try {
    const data = await getMarketAnalysisData();
    const valid = data.analyzed.filter(item => item && item.score !== undefined);
    const bullish = valid.filter(item => classifyTrend(item) === "صعودی").sort((a, b) => b.score - a.score).slice(0, 5);
    const bearish = valid.filter(item => classifyTrend(item) === "نزولی").sort((a, b) => b.score - a.score).slice(0, 5);
    const neutral = valid.filter(item => classifyTrend(item) === "خنثی").sort((a, b) => b.score - a.score).slice(0, 5);

    let report = "📈 بررسی روندهای بازار\n━━━━━━━━━━━━━━━━━━\n\n" +
      `📥 ارزهای دریافت‌شده: ${data.coins.length}\n` +
      `🔎 کاندیداهای بررسی‌شده: ${data.candidates.length}\n` +
      `📊 دارای داده تحلیلی معتبر: ${valid.length}\n` +
      "⏱ تایم‌فریم: ۱ ساعت\n\n";

    for (const [title, items, empty] of [
      ["🟢 روندهای صعودی", bullish, "روند صعودی قدرتمندی پیدا نشد."],
      ["🔴 روندهای نزولی", bearish, "روند نزولی قدرتمندی پیدا نشد."],
      ["🟡 روندهای خنثی", neutral, "موردی در این گروه پیدا نشد."]
    ]) {
      report += `${title}\n━━━━━━━━━━━━━━━━━━\n\n`;
      report += items.length ? items.map(formatTrendItem).join("\n") : `${empty}\n\n`;
      report += "\n";
    }

    report += "⚠️ طبقه‌بندی روند بر اساس جایگاه قیمت نسبت به EMA20 و EMA50 است؛ این گزارش سیگنال خرید یا فروش قطعی نیست.";
    if (data.errors.length) report += `\n⚠️ خطا در ${data.errors.length} صفحه CoinLore رخ داد.`;
    await sendLongMessage(env, chatId, report);
    await sendMessage(env, chatId, "پایان بررسی روندها.", MAIN_MENU);
  } catch (error) {
    await sendMessage(env, chatId, "❌ بررسی روندها ناموفق بود:\n" + String(error.message || error).slice(0, 900), MAIN_MENU);
  }
}

function scoreOpportunity(item) {
  const scoreParts = [];
  const supportDistance = item.support > 0
    ? ((item.current - item.support) / item.support) * 100
    : Infinity;
  const dailyChange = Number(item.coin.percent_change_24h) || 0;
  let score = 0;

  if (supportDistance >= 0 && supportDistance <= 3) {
    score += 30;
    scoreParts.push("قیمت حداکثر ۳٪ بالاتر از حمایت است");
  } else if (supportDistance > 3 && supportDistance <= 5) {
    score += 15;
    scoreParts.push("قیمت به محدوده حمایت نزدیک است");
  }

  if (item.volumeRatio >= 1.5) {
    score += 25;
    scoreParts.push("حجم کندل به‌طور محسوسی افزایش یافته");
  } else if (item.volumeRatio >= 1.1) {
    score += 15;
    scoreParts.push("حجم کندل بالاتر از میانگین است");
  }

  if (item.rsi >= 42 && item.rsi <= 65) {
    score += 15;
    scoreParts.push("RSI در محدوده متعادل قرار دارد");
  }

  if (item.current > item.ema20) {
    score += 15;
    scoreParts.push("قیمت بالاتر از EMA20 است");
  }

  if (item.ema20 > item.ema50) {
    score += 15;
    scoreParts.push("EMA20 بالاتر از EMA50 است");
  }

  if (dailyChange > 0 && dailyChange < 12) {
    score += 10;
    scoreParts.push("تغییرات روزانه مثبت و کنترل‌شده است");
  }

  return { score: Math.min(100, score), reasons: scoreParts, supportDistance };
}

async function runOpportunityHuntForChat(env, chatId) {
  await sendMessage(env, chatId, "🎯 در حال جست‌وجوی فرصت‌های اولیه بازار...");
  try {
    const data = await getMarketAnalysisData();
    const opportunities = data.analyzed
      .filter(item => item && item.score !== undefined)
      .map(item => ({ item, opportunity: scoreOpportunity(item) }))
      .filter(entry => entry.opportunity.score >= 35 && !entry.item.eligible)
      .sort((a, b) => b.opportunity.score - a.opportunity.score)
      .slice(0, 8);

    let report = "🎯 شکار فرصت‌های بازار\n━━━━━━━━━━━━━━━━━━\n\n" +
      `📥 ارزهای دریافت‌شده: ${data.coins.length}\n` +
      `🔎 کاندیداهای بررسی‌شده: ${data.candidates.length}\n` +
      `🎯 فرصت‌های اولیه پیدا‌شده: ${opportunities.length}\n` +
      "⏱ تایم‌فریم: ۱ ساعت\n\n";

    if (!opportunities.length) {
      report += "در حال حاضر فرصت اولیه‌ای با حداقل شرایط تعیین‌شده پیدا نشد.\n\n";
    }

    for (const { item, opportunity } of opportunities) {
      const level = opportunity.score >= 70 ? "قوی" : opportunity.score >= 50 ? "متوسط" : "ضعیف";
      report += `🪙 ${item.coin.name} (${item.coin.symbol})\n` +
        `🎯 امتیاز فرصت: ${opportunity.score}/100 (${level})\n` +
        `💵 قیمت فعلی: $${formatPrice(item.current)}\n` +
        `📊 RSI: ${item.rsi.toFixed(1)} | نسبت حجم: ${item.volumeRatio.toFixed(2)}x\n` +
        `🟢 حمایت: $${formatPrice(item.support)}\n` +
        `🔴 مقاومت: $${formatPrice(item.resistance)}\n` +
        `📍 محدوده بررسی ورود: $${formatPrice(item.entry)}\n` +
        `🛑 حد ضرر محاسباتی: $${formatPrice(item.stop)}\n` +
        `🥇 هدف اول: $${formatPrice(item.target1)}\n` +
        `🥈 هدف دوم: $${formatPrice(item.target2)}\n` +
        `🥉 هدف سوم: $${formatPrice(item.target3)}\n` +
        `⚖️ نسبت سود به ریسک محاسباتی: ${item.rewardRisk.toFixed(2)}R\n` +
        `🧩 نشانه‌ها: ${opportunity.reasons.join("؛ ") || "نشانه اولیه کافی ثبت نشد"}\n` +
        "━━━━━━━━━━━━━━━━━━\n\n";
    }

    report += "⚠️ این بخش فرصت‌های اولیه را قبل از تکمیل شرایط سیگنال شناسایی می‌کند. قیمت ورود، حد ضرر و اهداف صرفاً محاسباتی‌اند و به معنی توصیه قطعی خرید نیستند.";
    if (data.errors.length) report += `\n⚠️ خطا در ${data.errors.length} صفحه CoinLore رخ داد.`;
    await sendLongMessage(env, chatId, report);
    await sendMessage(env, chatId, "پایان شکار فرصت‌ها.", MAIN_MENU);
  } catch (error) {
    await sendMessage(env, chatId, "❌ شکار فرصت‌ها ناموفق بود:\n" + String(error.message || error).slice(0, 900), MAIN_MENU);
  }
}
// ---------------- SCAN ENGINE ----------------

async function runScan(env) {
  const started = Date.now();

  const coinResult = await getCoins();
  const coins = coinResult.coins;

  if (!coins.length) {
    return {
      report:
        "❌ دریافت اطلاعات بازار ناموفق بود.\n" +
        "CoinLore هیچ فهرست ارز قابل استفاده‌ای برنگرداند.\n\n" +
        "خطاها:\n" + coinResult.errors.slice(0, 5).join("\n"),
      watchlist: []
    };
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
    return {
      report:
        `⚠️ از ${coins.length} ارز دریافتی، هیچ ارزی با فیلترهای اولیه ` +
        "مطابقت نداشت.",
      watchlist: []
    };
  }

  let pairs;

  try {
    pairs = await getKrakenPairs();
  } catch (error) {
    return {
      report: `❌ دریافت جفت‌ارزهای Kraken ناموفق بود:\n${error.message}`,
      watchlist: []
    };
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

  const matchedPairs = analyzed.filter(
    item => item && item.score !== undefined
  ).length;

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

  const savedWatchlist = watchlist.map(item => ({
    name: item.coin.name,
    symbol: item.coin.symbol,
    current: item.current,
    score: item.score,
    rsi: item.rsi,
    trend: item.trend,
    setup: item.setup,
    support: item.support,
    resistance: item.resistance,
    entry: item.entry,
    stop: item.stop,
    target1: item.target1,
    rewardRisk: item.rewardRisk
  }));

  if (env.WATCHLIST_KV) {
    try {
      await env.WATCHLIST_KV.put(
        "last_scan",
        JSON.stringify({
          version: CONFIG.VERSION,
          timestamp: Date.now(),
          report,
          watchlist: savedWatchlist,
          signalCount: valid.length
        })
      );
    } catch (error) {
      report +=
        "\n⚠️ ذخیره‌سازی واچ‌لیست ناموفق بود: " +
        String(error.message || "خطای KV");
    }
  } else {
    report += "\n⚠️ اتصال KV تنظیم نشده؛ واچ‌لیست ذخیره نشد.";
  }

  return { report, watchlist: savedWatchlist };
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

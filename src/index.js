const CONFIG = {
  VERSION: "3.7",
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
  LEGACY_GRACE_DAYS: 7,
  PAYMENT_QUOTE_MINUTES: 15,
  BSC_CHAIN_ID: 56,
  BSC_CONFIRMATIONS: 15,
  CONTRACT_VERSION: "1.0"
};

const TELEGRAM_API = "https://api.telegram.org";

const PLANS = {
  monthly: { days: 30, priceUsdCents: 1000, title: "یک ماهه" },
  quarterly: { days: 90, priceUsdCents: 2500, title: "سه ماهه" },
  halfyear: { days: 180, priceUsdCents: 4000, title: "شش ماهه" }
};

const CONTRACT_TEXT =
  "قرارداد استفاده از خدمات Crypto Pump Hunter\n\n" +
  "۱. موضوع قرارداد\nاین قرارداد مربوط به استفاده از خدمات تحلیلی، اطلاعات بازار، سیگنال‌ها و ابزارهای نرم‌افزاری Crypto Pump Hunter است.\n\n" +
  "۲. ماهیت تحلیل‌ها\nتحلیل‌ها و سیگنال‌ها صرفاً جنبه اطلاعاتی و تحلیلی دارند و توصیه مالی شخصی یا تضمین سود نیستند.\n\n" +
  "۳. پذیرش ریسک\nکاربر آگاه است که بازار ارزهای دیجیتال دارای ریسک بالا، نوسانات شدید و احتمال از دست رفتن بخشی یا تمام سرمایه است.\n\n" +
  "۴. مسئولیت تصمیم‌گیری\nتمام تصمیمات خرید، فروش، نگهداری یا خروج از معاملات بر عهده خود کاربر است.\n\n" +
  "۵. عدم تضمین سود\nهیچ سود یا بازدهی مشخصی تضمین نمی‌شود.\n\n" +
  "۶. شرایط اشتراک\nدسترسی به امکانات پولی پس از تأیید پرداخت و مطابق مدت پلن خریداری‌شده فعال می‌شود.\n\n" +
  "۷. پذیرش قرارداد\nکاربر با تأیید صریح مفاد قرارداد و امضای الکترونیکی اعلام می‌کند که آن را مطالعه کرده و پذیرفته است.\n\n" +
  "ارائه‌دهنده خدمات: ع.س\n\n" +
  "اطلاعات ثبت‌شده شامل نام و نام خانوادگی، شماره تلفن، شناسه تلگرام، زمان پذیرش و نسخه قرارداد است. این اطلاعات برای ثبت قرارداد و مدیریت اشتراک نگهداری می‌شود.";

const ABOUT_TEXT =
  "🚀 CRYPTO PUMP HUNTER V3.7\n\n" +
  "طراحی و توسعه: ع.س\n\n" +
  "ابزار تحلیل بازار و شناسایی فرصت‌های احتمالی ارزهای دیجیتال.\n" +
  "تحلیل‌ها تضمین سود یا توصیه مالی شخصی نیستند.\n\n" +
  "© تمامی حقوق مادی و معنوی این نرم‌افزار محفوظ است.";

function mainMenu() {
  return {
    inline_keyboard: [
      [
        { text: "🚀 اسکن هوشمند بازار", callback_data: "menu:scan" },
        { text: "📊 تحلیل بازار", callback_data: "menu:analysis" }
      ],
      [
        { text: "🎯 شکار فرصت‌ها", callback_data: "menu:opportunities" },
        { text: "👀 واچ‌لیست", callback_data: "menu:watchlist" }
      ],
      [
        { text: "📈 بررسی روندها", callback_data: "menu:trends" },
        { text: "🔥 ارزهای داغ", callback_data: "menu:hot" }
      ],
      [
        { text: "💎 وضعیت اشتراک", callback_data: "menu:subscription" },
        { text: "💳 خرید اشتراک", callback_data: "subscription:plans" }
      ],
      [
        { text: "📡 وضعیت ربات", callback_data: "menu:status" },
        { text: "🔌 تست اتصال", callback_data: "menu:test" }
      ],
      [
        { text: "⚙️ تنظیمات", callback_data: "menu:settings" },
        { text: "ℹ️ درباره", callback_data: "menu:about" }
      ]
    ]
  };
}

const BACK_MENU = {
  inline_keyboard: [[{ text: "🏠 منوی اصلی", callback_data: "menu:home" }]]
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
        d1: Boolean(env.DB),
        payments: Boolean(env.BNB_WALLET_ADDRESS)
      });
    }

    if (request.method === "GET" && url.pathname === "/testdata") {
      if (!authorizedSetup(url, env)) return json({ ok: false, error: "Unauthorized" }, 401);
      return json(await testDataSources());
    }

    if (request.method === "GET" && url.pathname === "/register") {
      if (!authorizedSetup(url, env)) return json({ ok: false, error: "Unauthorized" }, 401);
      return registerWebhook(request, env);
    }

    if (request.method === "POST" && url.pathname === "/telegram") {
      if (
        env.WEBHOOK_SECRET &&
        request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.WEBHOOK_SECRET
      ) return new Response("Unauthorized", { status: 401 });

      let update;
      try {
        update = await request.json();
      } catch {
        return new Response("Bad Request", { status: 400 });
      }

      if (!env.DB) return new Response("D1 binding DB missing", { status: 500 });

      let claimedUpdate = false;
      try {
        await ensureAuxiliarySchema(env);
        if (update.update_id !== undefined) {
          claimedUpdate = await markUpdateProcessed(env, update.update_id);
          if (!claimedUpdate) return new Response("OK");
        }
      } catch (error) {
        // Fail closed: never process an update if durable deduplication failed.
        return new Response("Database error", { status: 500 });
      }

      try {
        // Complete processing before acknowledging Telegram. If processing fails,
        // release the deduplication claim and return 500 so Telegram can retry.
        await processUpdate(update, env);
        return new Response("OK");
      } catch (error) {
        if (claimedUpdate && update.update_id !== undefined) {
          try {
            await env.DB.prepare("DELETE FROM processed_updates WHERE update_id = ?")
              .bind(String(update.update_id)).run();
          } catch {}
        }
        return new Response("Processing error", { status: 500 });
      }
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
  return Boolean(env.SETUP_KEY && url.searchParams.get("key") === env.SETUP_KEY);
}

async function ensureAuxiliarySchema(env) {
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS contract_acceptances (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      telegram_user_id TEXT NOT NULL,
      full_name TEXT NOT NULL,
      phone TEXT NOT NULL,
      contract_version TEXT NOT NULL,
      contract_hash TEXT NOT NULL,
      accepted_at INTEGER NOT NULL
    )
  `).run();

  await env.DB.prepare(`
    CREATE INDEX IF NOT EXISTS idx_contract_acceptances_chat
    ON contract_acceptances(chat_id, accepted_at)
  `).run();
  await env.DB.prepare(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_tx_hash_unique
  ON payments(tx_hash)
`).run();

  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS processed_updates (
      update_id TEXT PRIMARY KEY,
      processed_at INTEGER NOT NULL
    )
  `).run();

  await env.DB.prepare(`
    CREATE INDEX IF NOT EXISTS idx_orders_tx_hash
    ON orders(tx_hash)
  `).run();
}

async function markUpdateProcessed(env, updateId) {
  const result = await env.DB.prepare(
    "INSERT OR IGNORE INTO processed_updates(update_id, processed_at) VALUES(?, ?)"
  ).bind(String(updateId), Date.now()).run();

  return Number(result.meta?.changes || 0) === 1;
}

async function processUpdate(update, env) {
  try {
    if (update.callback_query) {
      await handleCallback(update.callback_query, env);
      return;
    }

    const message = update.message || update.edited_message;
    if (!message?.chat?.id) return;

    if (message.contact) {
      await handleContactMessage(message, env);
      return;
    }

    if (!message.text) return;

    const chatId = message.chat.id;
    const text = message.text.trim();
    const command = text.split(/\s+/)[0].split("@")[0].toLowerCase();

    if (command.startsWith("/")) {
      await handleTelegramCommand(command, chatId, env, message);
      return;
    }

    await handleUserText(message, env);
  } catch (error) {
    const chatId = update.message?.chat?.id || update.edited_message?.chat?.id ||
      update.callback_query?.message?.chat?.id;
    if (chatId) {
      try {
        await sendMessage(env, chatId, "❌ خطا در پردازش درخواست. لطفاً دوباره تلاش کن.\n" +
          String(error.message || "Unknown error").slice(0, 500), mainMenu());
      } catch {}
    }
    // Propagate so the webhook can release the update claim and return HTTP 500.
    throw error;
  }
}

async function fetchJson(url, label) {
  const response = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": `CryptoPumpHunter/${CONFIG.VERSION}` }
  });
  const body = await response.text();
  let data;
  try {
    data = JSON.parse(body);
  } catch {
    throw new Error(`${label}: پاسخ JSON معتبر نیست؛ HTTP ${response.status}`);
  }
  if (!response.ok) throw new Error(`${label}: HTTP ${response.status}`);
  return data;
}

async function telegram(method, env, body) {
  if (!env.BOT_TOKEN) throw new Error("BOT_TOKEN تنظیم نشده است.");
  const response = await fetch(`${TELEGRAM_API}/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const data = await response.json();
  if (!response.ok || !data.ok) throw new Error(data.description || `Telegram HTTP ${response.status}`);
  return data;
}

async function sendMessage(env, chatId, text, replyMarkup = null) {
  const body = { chat_id: chatId, text, disable_web_page_preview: true };
  if (replyMarkup) body.reply_markup = replyMarkup;
  return telegram("sendMessage", env, body);
}

async function sendLongMessage(env, chatId, text) {
  const maxLength = 3500;
  let chunk = "";
  for (const line of String(text).split("\n")) {
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

async function answerCallback(env, callbackId, text = "", alert = false) {
  try {
    await telegram("answerCallbackQuery", env, {
      callback_query_id: callbackId,
      text,
      show_alert: alert
    });
  } catch {}
}

async function dbRun(env, sql, ...values) {
  return env.DB.prepare(sql).bind(...values).run();
}

async function dbFirst(env, sql, ...values) {
  return env.DB.prepare(sql).bind(...values).first();
}

async function getUser(env, chatId) {
  return dbFirst(env, "SELECT * FROM users WHERE chat_id = ?", String(chatId));
}

async function createOrUpdateUser(env, chatId, userId) {
  const now = Date.now();
  await dbRun(env, `
    INSERT INTO users(chat_id, telegram_user_id, created_at, updated_at)
    VALUES(?, ?, ?, ?)
    ON CONFLICT(chat_id) DO UPDATE SET
      telegram_user_id = excluded.telegram_user_id,
      updated_at = excluded.updated_at
  `, String(chatId), String(userId), now, now);
}

async function beginRegistration(env, message) {
  const chatId = message.chat.id;
  const userId = message.from.id;
  await createOrUpdateUser(env, chatId, userId);
  // Start the one-time transition window on the first V3.7 interaction
  // only when the legacy V3.6 KV membership key already exists.
  await initializeLegacyGrace(env, chatId);
  const user = await getUser(env, chatId);

  if (isOwner(userId, env)) {
    await showMenu(env, chatId);
    return;
  }

  if (!user.full_name) {
    await setFlow(env, chatId, "name");
    await sendMessage(env, chatId,
      "👋 به Crypto Pump Hunter خوش آمدی!\n\nبرای ساخت حساب، نام و نام خانوادگی خود را در یک پیام وارد کن.");
    return;
  }

  if (!user.phone) {
    await requestPhone(env, chatId);
    return;
  }

  if (!isContractCurrent(user)) {
    await showContract(env, chatId);
    return;
  }

  await initializeLegacyGrace(env, chatId);
  await showMenu(env, chatId);
}

async function setFlow(env, chatId, state) {
  if (!env.WATCHLIST_KV) throw new Error("اتصال WATCHLIST_KV فعال نیست.");
  await env.WATCHLIST_KV.put(`flow:${chatId}`, state, { expirationTtl: 86400 });
}

async function getFlow(env, chatId) {
  if (!env.WATCHLIST_KV) return null;
  return env.WATCHLIST_KV.get(`flow:${chatId}`);
}

async function clearFlow(env, chatId) {
  if (env.WATCHLIST_KV) await env.WATCHLIST_KV.delete(`flow:${chatId}`);
}

async function handleUserText(message, env) {
  const chatId = message.chat.id;
  const userId = message.from.id;
  const text = String(message.text || "").trim();

  if (isOwner(userId, env)) {
    await handleTelegramCommand("/menu", chatId, env, message);
    return;
  }

  const flow = await getFlow(env, chatId);
  if (flow === "name") {
    const fullName = text.replace(/\s+/g, " ").trim();
    if (fullName.length < 5 || fullName.length > 100 || fullName.split(" ").length < 2) {
      await sendMessage(env, chatId, "❌ لطفاً نام و نام خانوادگی کامل را وارد کن.");
      return;
    }
    await dbRun(env, "UPDATE users SET full_name = ?, updated_at = ? WHERE chat_id = ?",
      fullName, Date.now(), String(chatId));
    await clearFlow(env, chatId);
    await requestPhone(env, chatId);
    return;
  }

  if (/^0x[a-fA-F0-9]{64}$/.test(text)) {
    await processPaymentTXID(env, chatId, text);
    return;
  }

  await sendMessage(env, chatId,
    "برای ادامه از منوی ربات استفاده کن یا دستور /start را بفرست.",
    mainMenu());
}

async function requestPhone(env, chatId) {
  await setFlow(env, chatId, "phone");
  await telegram("sendMessage", env, {
    chat_id: chatId,
    text: "📱 شماره تلفن خود را با دکمه زیر به اشتراک بگذار. فقط شماره متعلق به حساب تلگرام خودت پذیرفته می‌شود.",
    reply_markup: {
      keyboard: [[{ text: "📱 ارسال شماره تلفن من", request_contact: true }]],
      resize_keyboard: true,
      one_time_keyboard: true
    }
  });
}

async function handleContactMessage(message, env) {
  const chatId = message.chat.id;
  const senderId = message.from?.id;
  const contact = message.contact;
  if (!contact || String(contact.user_id) !== String(senderId)) {
    await sendMessage(env, chatId, "❌ لطفاً شماره متعلق به حساب تلگرام خودت را ارسال کن.");
    return;
  }

  const user = await getUser(env, chatId);
  if (!user || !user.full_name) {
    await sendMessage(env, chatId, "ابتدا /start را بفرست و نام و نام خانوادگی را ثبت کن.");
    return;
  }

  const phone = String(contact.phone_number || "").trim();
  if (!phone || phone.length > 30) {
    await sendMessage(env, chatId, "❌ شماره تلفن معتبر نیست.");
    return;
  }

  await dbRun(env, "UPDATE users SET phone = ?, updated_at = ? WHERE chat_id = ?",
    phone, Date.now(), String(chatId));
  await clearFlow(env, chatId);

  await telegram("sendMessage", env, {
    chat_id: chatId,
    text: "✅ شماره تلفن ثبت شد.",
    reply_markup: { remove_keyboard: true }
  });

  await showContract(env, chatId);
}

function isContractCurrent(user) {
  return Boolean(
    user &&
    user.contract_version === CONFIG.CONTRACT_VERSION &&
    user.contract_hash &&
    user.accepted_at
  );
}

async function getContractHash() {
  const data = new TextEncoder().encode(CONFIG.CONTRACT_VERSION + "\n" + CONTRACT_TEXT);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest)).map(x => x.toString(16).padStart(2, "0")).join("");
}

async function showContract(env, chatId) {
  const user = await getUser(env, chatId);
  if (!user?.full_name || !user?.phone) {
    await sendMessage(env, chatId, "اطلاعات ثبت‌نام کامل نیست. /start را ارسال کن.");
    return;
  }

  await sendLongMessage(env, chatId,
    "📄 " + CONTRACT_TEXT +
    "\n\n━━━━━━━━━━━━━━━━━━\n" +
    `👤 نام: ${user.full_name}\n` +
    `📱 تلفن: ${user.phone}\n` +
    `🆔 شناسه تلگرام: ${user.telegram_user_id}\n\n` +
    "با فشردن دکمه تأیید، پذیرش الکترونیکی خود را ثبت می‌کنی."
  );

  await sendMessage(env, chatId, "آیا مفاد قرارداد را می‌پذیری؟", {
    inline_keyboard: [
      [{ text: "☑️ مطالعه کردم و می‌پذیرم", callback_data: "contract:accept" }],
      [{ text: "❌ انصراف", callback_data: "contract:cancel" }]
    ]
  });
}

async function acceptContract(query, env) {
  const chatId = query.message?.chat?.id;
  const userId = query.from?.id;
  if (!chatId || !userId) return;

  const user = await getUser(env, chatId);
  if (!user || String(user.telegram_user_id) !== String(userId) || !user.full_name || !user.phone) {
    await answerCallback(env, query.id, "اطلاعات ثبت‌نام کامل نیست.", true);
    return;
  }

  const hash = await getContractHash();
  const now = Date.now();

  await env.DB.batch([
    env.DB.prepare(`
      UPDATE users SET contract_version = ?, contract_hash = ?, accepted_at = ?, updated_at = ?
      WHERE chat_id = ?
    `).bind(CONFIG.CONTRACT_VERSION, hash, now, now, String(chatId)),
    env.DB.prepare(`
      INSERT INTO contract_acceptances(
        chat_id, telegram_user_id, full_name, phone,
        contract_version, contract_hash, accepted_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?)
    `).bind(String(chatId), String(userId), user.full_name, user.phone,
      CONFIG.CONTRACT_VERSION, hash, now)
  ]);

  await answerCallback(env, query.id, "قرارداد ثبت شد.");
  await sendMessage(env, chatId,
    "✍️ پذیرش الکترونیکی قرارداد ثبت شد.\n\n" +
    `نسخه: ${CONFIG.CONTRACT_VERSION}\n` +
    `کد ثبت: ${hash.slice(0, 16)}\n\n` +
    "اکنون می‌توانی پلن اشتراک را انتخاب کنی.",
    { inline_keyboard: [[{ text: "💳 مشاهده پلن‌ها", callback_data: "subscription:plans" }]] });
}

function isOwner(userId, env) {
  return Boolean(env.OWNER_ID && String(userId) === String(env.OWNER_ID));
}

async function initializeLegacyGrace(env, chatId) {
  if (!env.WATCHLIST_KV) return null;
  const oldMember = await env.WATCHLIST_KV.get(`member:${chatId}`);
  if (!oldMember) return null;

  const user = await getUser(env, chatId);
  if (!user) return null;
  if (user.legacy_trial_start || user.legacy_trial_end) return user;

  const now = Date.now();
  const end = now + CONFIG.LEGACY_GRACE_DAYS * 86400000;
  await dbRun(env, `
    UPDATE users
    SET legacy_trial_start = ?, legacy_trial_end = ?, updated_at = ?
    WHERE chat_id = ? AND legacy_trial_start IS NULL AND legacy_trial_end IS NULL
  `, now, end, now, String(chatId));
  return getUser(env, chatId);
}

async function getActiveSubscription(env, chatId) {
  return dbFirst(env, `
    SELECT * FROM subscriptions
    WHERE chat_id = ? AND status = 'active' AND expires_at > ?
    LIMIT 1
  `, String(chatId), Date.now());
}

async function checkAccess(env, chatId, userId) {
  if (isOwner(userId, env)) return { allowed: true, type: "owner" };
  const user = await getUser(env, chatId);
  if (!user) return { allowed: false, type: "registration" };

  const subscription = await getActiveSubscription(env, chatId);
  if (subscription) return { allowed: true, type: "subscription", expiresAt: subscription.expires_at };

  const legacy = await initializeLegacyGrace(env, chatId);
  if (legacy?.legacy_trial_end && Number(legacy.legacy_trial_end) > Date.now()) {
    return { allowed: true, type: "legacy_trial", expiresAt: legacy.legacy_trial_end };
  }
  return { allowed: false, type: "expired" };
}

async function requireAccess(env, chatId, userId) {
  const access = await checkAccess(env, chatId, userId);
  if (access.allowed) return true;
  await sendMessage(env, chatId,
    access.type === "registration"
      ? "برای استفاده ابتدا ثبت‌نام را با /start کامل کن."
      : "🔒 اشتراک فعالی نداری. برای ادامه، یکی از پلن‌ها را انتخاب کن.",
    { inline_keyboard: [[{ text: "💳 خرید اشتراک", callback_data: "subscription:plans" }]] });
  return false;
}

async function showSubscriptionStatus(env, chatId, userId) {
  if (isOwner(userId, env)) {
    await sendMessage(env, chatId, "👑 حساب مدیر\n\n✅ دسترسی رایگان و نامحدود");
    return;
  }
  const access = await checkAccess(env, chatId, userId);
  if (access.type === "subscription") {
    await sendMessage(env, chatId,
      "💎 اشتراک فعال است.\n\n" +
      `📅 پایان اشتراک: ${new Date(access.expiresAt).toLocaleString("fa-IR", { timeZone: "Asia/Tehran" })}`,
      mainMenu());
    return;
  }
  if (access.type === "legacy_trial") {
    const days = Math.ceil((access.expiresAt - Date.now()) / 86400000);
    await sendMessage(env, chatId,
      `🎁 دوره انتقال کاربران قدیمی فعال است.\n\n⏳ زمان باقی‌مانده: ${days} روز`,
      mainMenu());
    return;
  }
  await sendMessage(env, chatId, "🔒 اشتراک فعالی ثبت نشده است.", {
    inline_keyboard: [[{ text: "💳 خرید اشتراک", callback_data: "subscription:plans" }]]
  });
}

async function showPlans(env, chatId) {
  await sendMessage(env, chatId,
    "💎 پلن‌های اشتراک Crypto Pump Hunter\n\n" +
    "🥉 یک ماهه — ۱۰ دلار\n" +
    "🥈 سه ماهه — ۲۵ دلار\n" +
    "🥇 شش ماهه — ۴۰ دلار\n\n" +
    "پرداخت فقط با BNB بومی روی شبکه BNB Smart Chain (BEP20) انجام می‌شود.",
    {
      inline_keyboard: [
        [{ text: "🥉 یک ماهه | $10", callback_data: "plan:monthly" }],
        [{ text: "🥈 سه ماهه | $25", callback_data: "plan:quarterly" }],
        [{ text: "🥇 شش ماهه | $40", callback_data: "plan:halfyear" }],
        [{ text: "🏠 منوی اصلی", callback_data: "menu:home" }]
      ]
    });
}

async function getBNBPriceUSD() {
  const sources = [
    "https://api.binance.com/api/v3/ticker/price?symbol=BNBUSDT",
    "https://api.coingecko.com/api/v3/simple/price?ids=binancecoin&vs_currencies=usd"
  ];
  for (let i = 0; i < sources.length; i++) {
    try {
      const response = await fetch(sources[i]);
      if (!response.ok) continue;
      const data = await response.json();
      const price = i === 0 ? Number(data.price) : Number(data?.binancecoin?.usd);
      if (Number.isFinite(price) && price > 0) return price;
    } catch {}
  }
  return null;
}

function decimalToWei(value) {
  const [whole, fraction = ""] = String(value).split(".");
  return (BigInt(whole || "0") * 10n ** 18n +
    BigInt(fraction.padEnd(18, "0").slice(0, 18) || "0")).toString();
}

function weiToBNB(wei) {
  const value = BigInt(wei);
  const whole = value / 10n ** 18n;
  const fraction = (value % 10n ** 18n).toString().padStart(18, "0");
  return `${whole}.${fraction.slice(0, 8)}`;
}

async function createOrder(env, chatId, planKey) {
  const plan = PLANS[planKey];
  if (!plan) {
    await sendMessage(env, chatId, "❌ پلن معتبر نیست.");
    return;
  }

  const user = await getUser(env, chatId);
  if (!user?.full_name || !user?.phone || !isContractCurrent(user)) {
    await sendMessage(env, chatId,
      "ابتدا ثبت‌نام و پذیرش نسخه جاری قرارداد را تکمیل کن.",
      { inline_keyboard: [[{ text: "شروع ثبت‌نام", callback_data: "registration:restart" }]] });
    return;
  }

  const wallet = String(env.BNB_WALLET_ADDRESS || "").trim();
  if (!/^0x[a-fA-F0-9]{40}$/.test(wallet)) {
    await sendMessage(env, chatId, "❌ آدرس کیف پول دریافت BNB در تنظیمات ربات معتبر نیست.");
    return;
  }

  const price = await getBNBPriceUSD();
  if (!price) {
    await sendMessage(env, chatId, "⚠️ دریافت قیمت لحظه‌ای BNB ناموفق بود. بعداً تلاش کن.");
    return;
  }

  // Round up to 8 decimals. The order stores the exact wei amount.
  const usd = plan.priceUsdCents / 100;
  const bnb = Math.ceil((usd / price) * 1e8) / 1e8;
  const amountWei = decimalToWei(bnb.toFixed(8));
  const now = Date.now();
  const expires = now + CONFIG.PAYMENT_QUOTE_MINUTES * 60000;
  const orderId = crypto.randomUUID();

  await dbRun(env, `
    UPDATE orders SET status = 'expired'
    WHERE chat_id = ? AND status = 'pending' AND expires_at < ?
  `, String(chatId), now);

  await dbRun(env, `
    INSERT INTO orders(
      id, chat_id, plan_days, price_usd_cents, bnb_usd_price,
      amount_wei, wallet_address, status, created_at, expires_at
    ) VALUES(?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
  `, orderId, String(chatId), plan.days, plan.priceUsdCents,
    String(price), amountWei, wallet, now, expires);

  await sendMessage(env, chatId,
    "🧾 سفارش پرداخت ساخته شد.\n\n" +
    `📦 پلن: ${plan.title}\n` +
    `💵 مبلغ: $${usd}\n` +
    `📊 قیمت BNB هنگام صدور: $${price.toFixed(2)}\n` +
    `🪙 مبلغ دقیق: ${weiToBNB(amountWei)} BNB\n\n` +
    "🏦 شبکه: BNB Smart Chain (BEP20)\n" +
    `📥 آدرس دریافت:\n${wallet}\n\n` +
    `🆔 سفارش:\n${orderId}\n\n` +
    "⏱ اعتبار: ۱۵ دقیقه\n" +
    "فقط BNB بومی شبکه BSC ارسال کن؛ انتقال USDT یا شبکه دیگر پذیرفته نیست.\n\n" +
    "پس از پرداخت، TXID تراکنش را همین‌جا ارسال کن.",
    { inline_keyboard: [[{ text: "🔄 ساخت سفارش جدید", callback_data: "subscription:plans" }]] });
}

async function bscRpc(method, params, env) {
  const urls = [env.BSC_RPC_URL, "https://bsc-dataseed.binance.org/"]
    .filter(Boolean);
  for (const url of urls) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
      });
      if (!response.ok) continue;
      const data = await response.json();
      if (!data.error && data.result !== undefined) return data.result;
    } catch {}
  }
  throw new Error("BSC_RPC_UNAVAILABLE");
}

async function verifyBNBTransaction(env, txHash, order) {
  if (!/^0x[a-fA-F0-9]{64}$/.test(txHash)) {
    return { ok: false, reason: "شناسه تراکنش معتبر نیست." };
  }

  let tx, receipt, latest;
  try {
    [tx, receipt, latest] = await Promise.all([
      bscRpc("eth_getTransactionByHash", [txHash], env),
      bscRpc("eth_getTransactionReceipt", [txHash], env),
      bscRpc("eth_blockNumber", [], env)
    ]);
  } catch {
    return { ok: false, reason: "ارتباط با شبکه BSC برقرار نشد؛ کمی بعد دوباره تلاش کن." };
  }

  if (!tx || !receipt) return { ok: false, reason: "تراکنش هنوز در شبکه تأیید نشده است." };
  if (Number(BigInt(tx.chainId || "0x0")) !== CONFIG.BSC_CHAIN_ID) {
    return { ok: false, reason: "تراکنش روی شبکه BNB Smart Chain نیست." };
  }
  if (String(tx.to || "").toLowerCase() !== String(order.wallet_address).toLowerCase()) {
    return { ok: false, reason: "آدرس مقصد با آدرس سفارش مطابقت ندارد." };
  }
  if (BigInt(tx.value || "0x0") !== BigInt(order.amount_wei)) {
    return { ok: false, reason: "مبلغ BNB با مبلغ دقیق سفارش مطابقت ندارد." };
  }
  if (receipt.status !== "0x1") return { ok: false, reason: "تراکنش ناموفق است." };
  if (String(receipt.transactionHash).toLowerCase() !== txHash.toLowerCase()) {
    return { ok: false, reason: "رسید تراکنش معتبر نیست." };
  }

  const block = Number(BigInt(receipt.blockNumber));
  const head = Number(BigInt(latest));
  const confirmations = head - block + 1;
  if (!Number.isSafeInteger(confirmations) || confirmations < CONFIG.BSC_CONFIRMATIONS) {
    return {
      ok: false,
      reason: `تعداد تأیید شبکه کافی نیست (${Math.max(0, confirmations)}/${CONFIG.BSC_CONFIRMATIONS}).`
    };
  }

  return {
    ok: true,
    sender: tx.from,
    recipient: tx.to,
    amountWei: String(tx.value),
    blockNumber: block,
    paidAt: Date.now()
  };
}

asasync function processPaymentTXID(env, chatId, txHash) {
  const normalizedHash = String(txHash || "").trim().toLowerCase();

  if (!/^0x[a-f0-9]{64}$/.test(normalizedHash)) {
    await sendMessage(env, chatId, "❌ شناسه تراکنش معتبر نیست.");
    return;
  }

  // 1. بررسی اینکه این TXID قبلاً ثبت شده است یا نه
  const existingPayment = await dbFirst(env, `
    SELECT p.chat_id, p.order_id
    FROM payments p
    WHERE LOWER(p.tx_hash) = ?
    LIMIT 1
  `, normalizedHash);

  if (existingPayment) {
    if (String(existingPayment.chat_id) !== String(chatId)) {
      await sendMessage(env, chatId,
        "❌ این تراکنش قبلاً برای حساب دیگری ثبت شده است.");
      return;
    }

    const existingSubscription = await dbFirst(env, `
      SELECT * FROM subscriptions
      WHERE chat_id = ?
      LIMIT 1
    `, String(chatId));

    if (!existingSubscription) {
      throw new Error("PAYMENT_EXISTS_BUT_SUBSCRIPTION_MISSING");
    }

    await sendMessage(env, chatId,
      "✅ این تراکنش قبلاً ثبت شده است.\n\n" +
      "اشتراک قبلاً فعال شده و پرداخت دوباره تمدید نمی‌شود.",
      mainMenu());
    return;
  }

  // 2. بررسی سفارش پرداخت‌شده‌ای که رکورد پرداخت ندارد
  const paidOrder = await dbFirst(env, `
    SELECT id FROM orders
    WHERE LOWER(tx_hash) = ?
    LIMIT 1
  `, normalizedHash);

  if (paidOrder) {
    throw new Error("PAID_ORDER_WITHOUT_PAYMENT_RECORD");
  }

  // 3. دریافت آخرین سفارش در انتظار پرداخت
  const order = await dbFirst(env, `
    SELECT * FROM orders
    WHERE chat_id = ? AND status = 'pending'
    ORDER BY created_at DESC
    LIMIT 1
  `, String(chatId));

  if (!order) {
    await sendMessage(env, chatId,
      "❌ سفارش پرداخت فعالی پیدا نشد. ابتدا پلن اشتراک را انتخاب کن.");
    return;
  }

  const now = Date.now();

  if (now > Number(order.expires_at)) {
    await dbRun(env, `
      UPDATE orders
      SET status = 'expired'
      WHERE id = ? AND status = 'pending'
    `, order.id);

    await sendMessage(env, chatId,
      "⌛ مهلت سفارش تمام شده است. لطفاً سفارش جدید بساز.");
    return;
  }

  // 4. تأیید تراکنش روی شبکه BSC
  const verification = await verifyBNBTransaction(
    env,
    normalizedHash,
    order
  );

  if (!verification.ok) {
    await sendMessage(env, chatId,
      "⚠️ پرداخت تأیید نشد:\n" + verification.reason);
    return;
  }

  // 5. ثبت اتمیک سفارش، پرداخت و اشتراک
  const results = await env.DB.batch([
    env.DB.prepare(`
      UPDATE orders
      SET status = 'paid', tx_hash = ?
      WHERE id = ?
        AND chat_id = ?
        AND status = 'pending'
        AND expires_at >= ?
    `).bind(
      normalizedHash,
      order.id,
      String(chatId),
      now
    ),

    env.DB.prepare(`
      INSERT OR IGNORE INTO payments(
        order_id,
        chat_id,
        tx_hash,
        sender_address,
        recipient_address,
        amount_wei,
        block_number,
        paid_at
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM orders
        WHERE id = ?
          AND chat_id = ?
          AND status = 'paid'
          AND tx_hash = ?
      )
    `).bind(
      order.id,
      String(chatId),
      normalizedHash,
      verification.sender,
      verification.recipient,
      verification.amountWei,
      verification.blockNumber,
      verification.paidAt,
      order.id,
      String(chatId),
      normalizedHash
    ),

    env.DB.prepare(`
      INSERT INTO subscriptions(
        chat_id,
        plan_days,
        started_at,
        expires_at,
        payment_tx,
        status
      )
      SELECT
        ?,
        ?,
        MAX(
          ?,
          COALESCE(
            (
              SELECT expires_at
              FROM subscriptions
              WHERE chat_id = ?
                AND status = 'active'
            ),
            ?
          )
        ),
        MAX(
          ?,
          COALESCE(
            (
              SELECT expires_at
              FROM subscriptions
              WHERE chat_id = ?
                AND status = 'active'
            ),
            ?
          )
        ) + ? * 86400000,
        ?,
        'active'
      WHERE changes() = 1
        AND EXISTS (
          SELECT 1
          FROM payments
          WHERE order_id = ?
            AND chat_id = ?
            AND tx_hash = ?
        )
      ON CONFLICT(chat_id) DO UPDATE SET
        plan_days = excluded.plan_days,
        started_at = excluded.started_at,
        expires_at = excluded.expires_at,
        payment_tx = excluded.payment_tx,
        status = 'active'
    `).bind(
      String(chatId),
      order.plan_days,
      now,
      String(chatId),
      now,
      now,
      String(chatId),
      now,
      order.plan_days,
      normalizedHash,
      order.id,
      String(chatId),
      normalizedHash
    )
  ]);

  const orderUpdated = Number(results[0]?.meta?.changes || 0);
  const paymentInserted = Number(results[1]?.meta?.changes || 0);
  const subscriptionUpdated = Number(results[2]?.meta?.changes || 0);

  if (
    orderUpdated !== 1 ||
    paymentInserted !== 1 ||
    subscriptionUpdated !== 1
  ) {
    throw new Error(
      `PAYMENT_BATCH_INCOMPLETE: order=${orderUpdated}, payment=${paymentInserted}, subscription=${subscriptionUpdated}`
    );
  }

  // 6. اطمینان از ثبت اشتراک
  const subscription = await getActiveSubscription(env, chatId);

  if (!subscription) {
    throw new Error("SUBSCRIPTION_ACTIVATION_FAILED");
  }

  // 7. پیام موفقیت به کاربر
  await sendMessage(env, chatId,
    "🎉 پرداخت با موفقیت تأیید شد!\n\n" +
    `📦 پلن: ${order.plan_days} روز\n` +
    `🪙 پرداخت: ${weiToBNB(verification.amountWei)} BNB\n` +
    `📅 پایان اشتراک: ${new Date(subscription.expires_at).toLocaleString("fa-IR", {
      timeZone: "Asia/Tehran"
    })}\n` +
    `🔗 TXID: ${normalizedHash}\n\n` +
    "✅ اشتراک تو فعال شد.",
    mainMenu());

  // 8. خطای پیام مدیر نباید باعث پردازش مجدد پرداخت شود
  if (env.OWNER_ID) {
    try {
      await sendMessage(env, env.OWNER_ID,
        "💰 پرداخت جدید تأیید شد.\n\n" +
        `کاربر: ${chatId}\n` +
        `مدت: ${order.plan_days} روز\n` +
        `TXID: ${normalizedHash}`);
    } catch (error) {
      // پرداخت ثبت شده است؛ خطای اعلان مدیر نادیده گرفته می‌شود.
    }
  }
}

async function handleTelegramCommand(command, chatId, env, message) {
  if (command === "/start" || command === "/menu") {
    await beginRegistration(env, message);
    return;
  }

  if (command === "/help") {
    await sendMessage(env, chatId,
      "📘 راهنمای Crypto Pump Hunter\n\n" +
      "/start — شروع و منوی اصلی\n" +
      "/scan — اسکن دستی بازار\n" +
      "/status — وضعیت ربات\n" +
      "/help — راهنما\n\n" +
      "اسکن فقط با درخواست دستی اجرا می‌شود.",
      mainMenu());
    return;
  }

  if (command === "/status") {
    await showStatus(env, chatId, message.from.id);
    return;
  }

  if (command === "/scan") {
    if (!(await requireAccess(env, chatId, message.from.id))) return;
    await runScanForChat(env, chatId, message.from.id);
    return;
  }

  await showMenu(env, chatId);
}

async function handleCallback(query, env) {
  const chatId = query.message?.chat?.id;
  const userId = query.from?.id;
  const action = query.data || "";
  if (!chatId || !userId) {
    await answerCallback(env, query.id);
    return;
  }

  if (action === "contract:cancel") {
    await answerCallback(env, query.id, "قرارداد پذیرفته نشد.");
    await sendMessage(env, chatId, "برای استفاده از امکانات پولی، پذیرش قرارداد لازم است.");
    return;
  }

  if (action === "contract:accept") {
    await acceptContract(query, env);
    return;
  }

  if (action === "registration:restart") {
    await answerCallback(env, query.id);
    const fakeMessage = { chat: { id: chatId }, from: { id: userId } };
    await beginRegistration(env, fakeMessage);
    return;
  }

  if (action === "subscription:plans") {
    await answerCallback(env, query.id);
    await showPlans(env, chatId);
    return;
  }

  if (action.startsWith("plan:")) {
    await answerCallback(env, query.id, "در حال ساخت سفارش...");
    await createOrder(env, chatId, action.slice(5));
    return;
  }

  if (action.startsWith("menu:")) {
    const item = action.slice(5);
    if (item === "home") {
      await answerCallback(env, query.id);
      await showMenu(env, chatId);
      return;
    }
    if (item === "subscription") {
      await answerCallback(env, query.id);
      await showSubscriptionStatus(env, chatId, userId);
      return;
    }
    if (item === "status") {
      await answerCallback(env, query.id);
      await showStatus(env, chatId, userId);
      return;
    }
    if (item === "test") {
      await answerCallback(env, query.id);
      await showConnectionTest(env, chatId);
      return;
    }
    if (item === "settings") {
      await answerCallback(env, query.id);
      await showSettings(env, chatId);
      return;
    }
    if (item === "about") {
      await answerCallback(env, query.id);
      await sendMessage(env, chatId, ABOUT_TEXT, BACK_MENU);
      return;
    }

    await answerCallback(env, query.id);
    if (!(await requireAccess(env, chatId, userId))) return;

    if (item === "scan") {
      await runScanForChat(env, chatId, userId);
    } else if (item === "analysis") {
      await showLastAnalysis(env, chatId);
    } else if (item === "watchlist") {
      await showWatchlist(env, chatId);
    } else if (item === "opportunities") {
      await showOpportunities(env, chatId);
    } else if (item === "trends") {
      await showTrends(env, chatId);
    } else if (item === "hot") {
      await showHotCoins(env, chatId);
    } else {
      await showMenu(env, chatId);
    }
    return;
  }

  await answerCallback(env, query.id);
}

async function showMenu(env, chatId) {
  await sendMessage(env, chatId,
    `🚀 CRYPTO PUMP HUNTER V${CONFIG.VERSION}\n\n` +
    "فرص احتمالی بازار را با تحلیل روند، حجم، RSI و سطوح حمایت و مقاومت بررسی کن.\n\n" +
    "از منوی زیر گزینه موردنظر را انتخاب کن:",
    mainMenu());
}

async function runScanForChat(env, chatId, userId) {
  if (!(await requireAccess(env, chatId, userId ?? chatId))) return;
  await sendMessage(env, chatId,
    `🔎 اسکن هوشمند V${CONFIG.VERSION} شروع شد...\n` +
    "در حال بررسی روند، حجم، RSI، حمایت و مقاومت.");
  const result = await runScan(env);
  await sendLongMessage(env, chatId, result.report);
  await sendMessage(env, chatId, "✅ اسکن به پایان رسید.", mainMenu());
}

async function showStatus(env, chatId, userId) {
  let lastScan = "هنوز اسکن ذخیره‌شده‌ای وجود ندارد.";
  if (env.WATCHLIST_KV) {
    try {
      const saved = await env.WATCHLIST_KV.get("last_scan", "json");
      if (saved?.timestamp) {
        lastScan = new Date(saved.timestamp).toLocaleString("fa-IR", { timeZone: "Asia/Tehran" });
      }
    } catch {
      lastScan = "خواندن اطلاعات اسکن قبلی ناموفق بود.";
    }
  }

  let accessText = "";
  if (userId !== undefined) {
    const access = await checkAccess(env, chatId, userId);
    accessText = access.type === "owner" ? "👑 دسترسی مدیر: نامحدود\n" :
      access.type === "subscription" ? "💎 اشتراک: فعال\n" :
      access.type === "legacy_trial" ? "🎁 دوره انتقال: فعال\n" : "🔒 اشتراک: غیرفعال\n";
  }

  await sendMessage(env, chatId,
    `🟢 وضعیت Crypto Pump Hunter\n\nنسخه: V${CONFIG.VERSION}\nحالت اسکن: فقط دستی\nمنابع داده: CoinLore و Kraken\n` +
    `KV: ${env.WATCHLIST_KV ? "فعال" : "غیرفعال"}\nD1: ${env.DB ? "فعال" : "غیرفعال"}\n` +
    accessText + `آخرین اسکن: ${lastScan}`,
    mainMenu());
}

async function showSettings(env, chatId) {
  await sendMessage(env, chatId,
    "⚙️ تنظیمات فعلی ربات\n\n" +
    `📊 ارزش بازار: $${CONFIG.MIN_MARKET_CAP.toLocaleString("en-US")} تا $${CONFIG.MAX_MARKET_CAP.toLocaleString("en-US")}\n` +
    `💧 حداقل حجم روزانه: $${CONFIG.MIN_DAILY_VOLUME.toLocaleString("en-US")}\n` +
    `🔎 حداکثر کاندیدا: ${CONFIG.MAX_CANDIDATES}\n⭐ حداقل امتیاز: ${CONFIG.MIN_SCORE}/100\n` +
    `⚖️ حداقل نسبت سود به ریسک: ${CONFIG.MIN_REWARD_RISK}R\n⏱ تایم‌فریم: ${CONFIG.CANDLE_INTERVAL} دقیقه\n` +
    `👀 تعداد واچ‌لیست: ${CONFIG.WATCHLIST_SIZE}\n\nاین مقادیر در کد ربات تعریف شده‌اند.",
    BACK_MENU);
}

async function showLastAnalysis(env, chatId) {
  if (!env.WATCHLIST_KV) {
    await sendMessage(env, chatId, "⚠️ اتصال KV فعال نیست.", mainMenu());
    return;
  }
  const saved = await env.WATCHLIST_KV.get("last_scan", "json");
  if (!saved?.report) {
    await sendMessage(env, chatId, "هنوز گزارشی ذخیره نشده است. ابتدا اسکن را اجرا کن.", mainMenu());
    return;
  }
  await sendLongMessage(env, chatId, saved.report);
  await sendMessage(env, chatId, "پایان آخرین گزارش.", mainMenu());
}

async function showWatchlist(env, chatId) {
  if (!env.WATCHLIST_KV) {
    await sendMessage(env, chatId, "⚠️ اتصال KV فعال نیست.", mainMenu());
    return;
  }
  const saved = await env.WATCHLIST_KV.get("last_scan", "json");
  if (!saved?.watchlist?.length) {
    await sendMessage(env, chatId, "👀 واچ‌لیست خالی است. پس از اجرای اسکن، ارزهای منتخب اینجا نمایش داده می‌شوند.", mainMenu());
    return;
  }

  let text = "👀 واچ‌لیست آخرین اسکن\n━━━━━━━━━━━━━━━━━━\n\n";
  for (const item of saved.watchlist) {
    text += `🪙 ${item.name} (${item.symbol})\n⭐ امتیاز: ${item.score}/100\n💵 قیمت: $${formatPrice(item.current)}\n` +
      `📈 روند: ${item.trend}\n📊 RSI: ${Number(item.rsi).toFixed(1)}\n🧩 الگو: ${item.setup}\n` +
      `🟢 حمایت: $${formatPrice(item.support)}\n🔴 مقاومت: $${formatPrice(item.resistance)}\n\n`;
  }
  text += "⚠️ واچ‌لیست سیگنال قطعی خرید نیست.";
  await sendLongMessage(env, chatId, text);
  await sendMessage(env, chatId, "پایان واچ‌لیست.", mainMenu());
}

async function showOpportunities(env, chatId) {
  const saved = env.WATCHLIST_KV ? await env.WATCHLIST_KV.get("last_scan", "json") : null;
  if (!saved?.report) {
    await sendMessage(env, chatId, "برای شکار فرصت‌ها ابتدا اسکن هوشمند را اجرا کن.", mainMenu());
    return;
  }
  await sendMessage(env, chatId,
    "🎯 شکار فرصت‌ها\n\n" +
    "این بخش بر اساس خروجی آخرین اسکن کار می‌کند. فقط ارزهایی که تمام شروط ورود را پاس کرده‌اند، سیگنال محسوب می‌شوند.\n\n" +
    saved.report.slice(0, 3200),
    mainMenu());
}

async function showTrends(env, chatId) {
  const saved = env.WATCHLIST_KV ? await env.WATCHLIST_KV.get("last_scan", "json") : null;
  if (!saved?.watchlist?.length) {
    await sendMessage(env, chatId, "برای بررسی روندها ابتدا اسکن هوشمند را اجرا کن.", mainMenu());
    return;
  }
  const text = "📈 بررسی روندها\n━━━━━━━━━━━━━━━━━━\n\n" +
    saved.watchlist.map(x =>
      `🪙 ${x.name} (${x.symbol})\nروند: ${x.trend}\nامتیاز: ${x.score}/100\nRSI: ${Number(x.rsi).toFixed(1)}\nالگو: ${x.setup}`
    ).join("\n\n");
  await sendLongMessage(env, chatId, text);
  await sendMessage(env, chatId, "پایان بررسی روندها.", mainMenu());
}

async function showHotCoins(env, chatId) {
  const saved = env.WATCHLIST_KV ? await env.WATCHLIST_KV.get("last_scan", "json") : null;
  if (!saved?.watchlist?.length) {
    await sendMessage(env, chatId, "برای مشاهده ارزهای داغ ابتدا اسکن هوشمند را اجرا کن.", mainMenu());
    return;
  }
  const hot = [...saved.watchlist].sort((a, b) => b.score - a.score).slice(0, 5);
  const text = "🔥 ارزهای داغ بر اساس امتیاز آخرین اسکن\n━━━━━━━━━━━━━━━━━━\n\n" +
    hot.map((x, i) =>
      `${i + 1}. ${x.name} (${x.symbol})\n⭐ امتیاز: ${x.score}/100\n📈 روند: ${x.trend}\n📊 RSI: ${Number(x.rsi).toFixed(1)}`
    ).join("\n\n") +
    "\n\nاین فهرست رتبه‌بندی خروجی اسکن است، نه توصیه خرید.";
  await sendLongMessage(env, chatId, text);
  await sendMessage(env, chatId, "پایان فهرست ارزهای داغ.", mainMenu());
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
  await sendMessage(env, chatId,
    "🔌 نتیجه تست اتصال\n\n" + coinLore + "\n\n" + kraken +
    `\n\nنسخه ربات: V${CONFIG.VERSION}`, mainMenu());
}

async function registerWebhook(request, env) {
  if (!env.BOT_TOKEN) return json({ ok: false, error: "BOT_TOKEN تنظیم نشده است." }, 400);
  if (env.WEBHOOK_SECRET && !/^[A-Za-z0-9_-]{1,256}$/.test(env.WEBHOOK_SECRET)) {
    return json({ ok: false, error: "WEBHOOK_SECRET نامعتبر است." }, 400);
  }
  const webhookUrl = new URL("/telegram", request.url).toString();
  try {
    const body = { url: webhookUrl, allowed_updates: ["message", "callback_query"], max_connections: 5 };
    if (env.WEBHOOK_SECRET) body.secret_token = env.WEBHOOK_SECRET;
    const result = await telegram("setWebhook", env, body);
    return json({ ok: true, result: result.result, description: result.description || "Webhook registered" });
  } catch (error) {
    return json({ ok: false, error: error.message }, 500);
  }
}

// ---------------- MARKET DATA ----------------

function extractCoinLoreAssets(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.coins)) return payload.coins;
  if (Array.isArray(payload?.data?.coins)) return payload.data.coins;
  return [];
}

async function fetchCoinLore(start, limit = 100) {
  const payload = await fetchJson(
    `https://api.coinlore.net/api/tickers/?start=${start}&limit=${limit}`,
    "CoinLore"
  );
  const assets = extractCoinLoreAssets(payload);
  if (!assets.length) throw new Error(`CoinLore صفحه ${start} داده قابل استفاده ندارد.`);
  return { assets, totalCoins: payload?.info?.coins_num ?? null };
}

async function getCoins() {
  const all = [];
  const seen = new Set();
  const errors = [];
  const pages = await mapLimit(CONFIG.COINLORE_PAGES, CONFIG.CONCURRENCY, async start => {
    try {
      const result = await fetchCoinLore(start, 100);
      return { start, assets: result.assets, error: null };
    } catch (error) {
      return { start, assets: [], error: error.message };
    }
  });

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
  const data = await fetchJson("https://api.kraken.com/0/public/AssetPairs", "Kraken AssetPairs");
  if (data.error?.length) throw new Error(data.error.join(", "));
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
    if (base === symbol && (quote === "USD" || quote === "USDT")) return pair.altname || key;
    if (altname === `${symbol}USD` || altname === `${symbol}USDT`) return pair.altname || key;
  }
  return null;
}

async function getCandles(pair) {
  const data = await fetchJson(
    `https://api.kraken.com/0/public/OHLC?pair=${encodeURIComponent(pair)}&interval=${CONFIG.CANDLE_INTERVAL}`,
    "Kraken OHLC"
  );
  if (data.error?.length) throw new Error(data.error.join(", "));
  const result = data.result || {};
  const key = Object.keys(result).find(name => name !== "last");
  if (!key || !Array.isArray(result[key])) throw new Error("کندل‌های Kraken موجود نیستند.");
  return result[key].slice(0, -1).map(row => ({
    time: Number(row[0]), open: Number(row[1]), high: Number(row[2]),
    low: Number(row[3]), close: Number(row[4]), volume: Number(row[6])
  })).filter(c =>
    Number.isFinite(c.close) && c.close > 0 && c.high >= c.low && c.low > 0
  );
}

async function testDataSources() {
  const result = { version: CONFIG.VERSION, coinlore: { ok: false }, kraken: { ok: false } };
  try {
    const coins = await fetchCoinLore(0, 10);
    result.coinlore = {
      ok: true, assets: coins.assets.length,
      sample: coins.assets.slice(0, 3).map(c => ({
        name: c.name, symbol: c.symbol, price_usd: c.price_usd,
        market_cap_usd: c.market_cap_usd, volume24: c.volume24
      }))
    };
  } catch (error) {
    result.coinlore = { ok: false, error: error.message };
  }
  try {
    const pairs = await getKrakenPairs();
    result.kraken = { ok: true, pairs: Object.keys(pairs).length };
  } catch (error) {
    result.kraken = { ok: false, error: error.message };
  }
  return result;
}

// ---------------- INDICATORS ----------------

function ema(values, period) {
  if (values.length < period) return null;
  const multiplier = 2 / (period + 1);
  let value = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) {
    value = values[i] * multiplier + value * (1 - multiplier);
  }
  return value;
}

function rsi(values, period = 14) {
  if (values.length <= period) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const change = values[i] - values[i - 1];
    gains += Math.max(change, 0);
    losses += Math.max(-change, 0);
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  for (let i = period + 1; i < values.length; i++) {
    const change = values[i] - values[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(change, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-change, 0)) / period;
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
  if (recent.length < 10) throw new Error("کندل کافی برای محاسبه حمایت و مقاومت وجود ندارد.");
  return {
    support: Math.min(...recent.map(c => c.low)),
    resistance: Math.max(...recent.map(c => c.high)),
    rangeHigh: Math.max(...recent.map(c => c.high)),
    rangeLow: Math.min(...recent.map(c => c.low))
  };
}

function analyzeCoin(coin, candles) {
  if (candles.length < CONFIG.MIN_CANDLES) throw new Error("تعداد کندل کافی نیست.");
  const closes = candles.map(c => c.close);
  const last = candles[candles.length - 1];
  const previous = candles[candles.length - 2];
  const current = last.close;
  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  const rsi14 = rsi(closes, 14);
  if ([ema20, ema50, rsi14].some(v => v === null)) throw new Error("محاسبه اندیکاتورها ناموفق بود.");

  const { support, resistance, rangeHigh, rangeLow } = findLevels(candles);
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
  } else if (rsi14 > 75) reasons.push("RSI بیش از حد بالا است");
  else reasons.push("قدرت RSI کافی نیست");

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
  } else reasons.push("تغییرات روزانه مثبت نیست");

  if (aboveEMA20 && aboveEMA50) score += 20;
  else if (aboveEMA20 || aboveEMA50) score += 10;
  else reasons.push("قیمت زیر EMA20 و EMA50 است");

  score = Math.min(100, score);
  let setup = "بدون ستاپ";
  const breakout = current > resistance * 1.002 &&
    previous.close <= resistance * 1.005 && volumeRatio >= 1.1 && trendUp;
  const pullback = trendUp && current > ema20 && last.low <= ema20 * 1.01 && current > last.open;
  const supportBounce = last.low <= support * 1.015 && current > support * 1.01 && current > last.open;
  if (breakout) setup = "شکست مقاومت";
  else if (pullback) setup = "پولبک به EMA20";
  else if (supportBounce) setup = "واکنش به حمایت";

  const recentLow = Math.min(...candles.slice(-8, -1).map(c => c.low));
  const entry = current;
  let stop;
  if (setup === "شکست مقاومت") stop = Math.min(resistance * 0.99, recentLow * 0.995);
  else if (setup === "پولبک به EMA20") stop = Math.min(ema20 * 0.985, recentLow * 0.995);
  else if (setup === "واکنش به حمایت") stop = Math.min(support * 0.985, recentLow * 0.995);
  else stop = Math.min(support * 0.99, recentLow * 0.995);

  const risk = entry - stop;
  const validStop = Number.isFinite(risk) && risk > 0;
  let target1 = resistance;
  if (setup === "شکست مقاومت") {
    const rangeHeight = Math.max(rangeHigh - rangeLow, entry * 0.01);
    target1 = entry + rangeHeight;
  }
  if (validStop && target1 <= entry) target1 = entry + risk * 1.5;
  const rewardRisk = validStop ? (target1 - entry) / risk : 0;
  const target2 = validStop ? entry + risk * 2.5 : 0;
  const target3 = validStop ? entry + risk * 3.5 : 0;
  if (!validStop) reasons.push("حد ضرر معتبر محاسبه نشد");
  if (setup === "بدون ستاپ") reasons.push("الگوی ورود مشخصی وجود ندارد");
  if (rewardRisk < CONFIG.MIN_REWARD_RISK) reasons.push("نسبت سود به ریسک کمتر از حداقل تعیین‌شده است");

  const eligible = score >= CONFIG.MIN_SCORE &&
    setup !== "بدون ستاپ" && volumeRatio >= 0.9 &&
    validStop && rewardRisk >= CONFIG.MIN_REWARD_RISK;

  return {
    coin, current, score, rsi: rsi14, ema20, ema50, support, resistance,
    volumeRatio, trend: trendUp ? "صعودی" : "خنثی یا نزولی",
    setup, entry, stop, target1, target2, target3, rewardRisk, eligible, reasons
  };
}

// ---------------- SCAN ENGINE ----------------

async function runScan(env) {
  const started = Date.now();
  const coinResult = await getCoins();
  const coins = coinResult.coins;

  if (!coins.length) {
    return {
      report: "❌ دریافت اطلاعات بازار ناموفق بود.\nCoinLore هیچ فهرست ارز قابل استفاده‌ای برنگرداند.\n\nخطاها:\n" +
        coinResult.errors.slice(0, 5).join("\n"),
      watchlist: []
    };
  }

  const candidates = coins.filter(coin => {
    const cap = Number(coin.market_cap_usd);
    const volume = Number(coin.volume24);
    const price = Number(coin.price_usd);
    return Number.isFinite(cap) && Number.isFinite(volume) && Number.isFinite(price) &&
      cap >= CONFIG.MIN_MARKET_CAP && cap <= CONFIG.MAX_MARKET_CAP &&
      volume >= CONFIG.MIN_DAILY_VOLUME && price > 0;
  }).sort((a, b) => Number(b.volume24) - Number(a.volume24))
    .slice(0, CONFIG.MAX_CANDIDATES);

  if (!candidates.length) {
    return { report: `⚠️ از ${coins.length} ارز دریافتی، هیچ ارزی با فیلترهای اولیه مطابقت نداشت.`, watchlist: [] };
  }

  let pairs;
  try {
    pairs = await getKrakenPairs();
  } catch (error) {
    return { report: `❌ دریافت جفت‌ارزهای Kraken ناموفق بود:\n${error.message}`, watchlist: [] };
  }

  const analyzed = await mapLimit(candidates, CONFIG.CONCURRENCY, async coin => {
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
  });

  const valid = analyzed.filter(item => item?.eligible)
    .sort((a, b) => b.score - a.score).slice(0, CONFIG.MAX_RESULTS);
  const watchlist = analyzed.filter(item => item && !item.eligible && item.score !== undefined)
    .sort((a, b) => b.score - a.score).slice(0, CONFIG.WATCHLIST_SIZE);
  const diagnostics = analyzed.filter(item => item && !item.eligible)
    .sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, CONFIG.DIAGNOSTIC_SIZE);
  const matchedPairs = analyzed.filter(item => item && item.score !== undefined).length;
  const noPair = analyzed.filter(item => item?.rejected?.includes("جفت معاملاتی")).length;

  let report =
    `🚀 CRYPTO PUMP HUNTER V${CONFIG.VERSION}\n━━━━━━━━━━━━━━━━━━\n\n` +
    "📊 ارزش بازار: 1M تا 500M دلار\n💧 حداقل حجم روزانه: 250K دلار\n⏱ تایم‌فریم: 1 ساعت\n" +
    `📥 ارزهای دریافت‌شده: ${coins.length}\n🔎 کاندیداهای فیلترشده: ${candidates.length}\n` +
    `📈 دارای داده کندل معتبر: ${matchedPairs}\n🔗 بدون جفت معاملاتی Kraken: ${noPair}\n` +
    `⭐ سیگنال‌های واجد شرایط: ${valid.length}\n\n`;

  if (valid.length) {
    report += "🔥 سیگنال‌های واجد شرایط\n━━━━━━━━━━━━━━━━━━\n\n";
    for (const item of valid) report += formatCoin(item, true) + "\n";
  } else {
    report += "⚠️ در این اسکن هیچ سیگنالی تمام شرایط ورود را نداشت.\n\n";
  }

  if (watchlist.length) {
    report += "👀 واچ‌لیست\n━━━━━━━━━━━━━━━━━━\n\n";
    for (const item of watchlist) report += formatCoin(item, false) + "\n";
  }

  if (diagnostics.length) {
    report += "🧪 دلایل رد شدن یا ناقص بودن شرایط\n━━━━━━━━━━━━━━━━━━\n";
    for (const item of diagnostics) {
      const name = item.coin ? `${item.coin.name} (${item.coin.symbol})` : "Unknown";
      const reason = item.reasons?.length ? item.reasons.join("، ") :
        item.rejected || "شرایط ورود کامل نیست";
      report += `• ${name} | امتیاز: ${item.score ?? "-"}\n  دلیل: ${reason}\n`;
    }
  }

  if (coinResult.errors.length) {
    report += `\n⚠️ خطا در بعضی صفحات CoinLore: ${coinResult.errors.length} صفحه ناموفق بود.\n`;
  }

  report +=
    "\n━━━━━━━━━━━━━━━━━━\n" +
    `⏱ زمان اسکن: ${Math.round((Date.now() - started) / 1000)} ثانیه\n` +
    "📌 منابع: CoinLore و Kraken\n⚠️ سیگنال‌ها احتمالی‌اند و تضمین سود نیستند.";

  const savedWatchlist = watchlist.map(item => ({
    name: item.coin.name, symbol: item.coin.symbol, current: item.current,
    score: item.score, rsi: item.rsi, trend: item.trend, setup: item.setup,
    support: item.support, resistance: item.resistance, entry: item.entry,
    stop: item.stop, target1: item.target1, rewardRisk: item.rewardRisk
  }));

  if (env.WATCHLIST_KV) {
    try {
      await env.WATCHLIST_KV.put("last_scan", JSON.stringify({
        version: CONFIG.VERSION, timestamp: Date.now(), report,
        watchlist: savedWatchlist, signalCount: valid.length
      }));
    } catch (error) {
      report += "\n⚠️ ذخیره‌سازی واچ‌لیست ناموفق بود: " + String(error.message || "خطای KV");
    }
  } else {
    report += "\n⚠️ اتصال KV تنظیم نشده؛ واچ‌لیست ذخیره نشد.";
  }

  return { report, watchlist: savedWatchlist };
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
    `🪙 ${coin.name} (${coin.symbol})\n⭐ امتیاز: ${item.score}/100\n` +
    `💵 قیمت فعلی: $${formatPrice(item.current)}\n📈 روند: ${item.trend}\n` +
    `📊 RSI: ${item.rsi.toFixed(1)}\n📉 نسبت حجم: ${item.volumeRatio.toFixed(2)}x\n` +
    `🧩 الگو: ${item.setup}\n🟢 حمایت: $${formatPrice(item.support)}\n` +
    `🔴 مقاومت قبلی: $${formatPrice(item.resistance)}\n`;

  if (isSignal) {
    text += `\n🎯 قیمت بررسی/ورود: $${formatPrice(item.entry)}` +
      `\n🛑 حد ضرر: $${formatPrice(item.stop)}` +
      `\n🥇 هدف اول: $${formatPrice(item.target1)}` +
      `\n🥈 هدف دوم: $${formatPrice(item.target2)}` +
      `\n🥉 هدف سوم: $${formatPrice(item.target3)}` +
      `\n⚖️ نسبت سود به ریسک: ${item.rewardRisk.toFixed(2)}R\n`;
  } else {
    text += "\n👀 وضعیت: فقط زیر نظر بگیر؛ سیگنال خرید نیست." +
      `\n📍 قیمت بررسی: $${formatPrice(item.entry)}` +
      `\n🛑 حد ضرر فرضی: $${formatPrice(item.stop)}` +
      `\n🎯 هدف محاسباتی اول: $${formatPrice(item.target1)}` +
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
      try {
        results[currentIndex] = await callback(items[currentIndex]);
      } catch (error) {
        results[currentIndex] = { rejected: error.message || "خطای پردازش" };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

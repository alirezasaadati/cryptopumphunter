import { runSpotScan } from "./spot-engine.js";
import { futuresSignalFingerprint, selectUnnotifiedFuturesSignals, futuresAlertStorageKey, formatFuturesSignalAlert, ALERT_TTL_SECONDS } from "./futures-alerts.js";
import { saveIssuedSignal, updateIssuedSignal, listIssuedSignals, issuedSignalSymbols } from "./signal-ledger.js";
import { signalOutboxKey, signalOutboxAction } from "./signal-outbox.js";
import { createSerialExecutor } from "./serial-executor.js";

const CONFIG = {
  VERSION: "4.7.0",
  PENDING_TTL: 604800
};


const TELEGRAM_API = "https://api.telegram.org";

const seenUpdates = new Set();
let telegramKvDedupeUnavailable = false;

export function quotaDayKey(now = Date.now()) { return new Date(now).toISOString().slice(0, 10); }
export function isKvDailyWriteQuotaError(error) {
  const message = String(error?.message || error || "").toLowerCase();
  return message.includes("limit exceeded for the day") || (message.includes("quota") && (message.includes("put") || message.includes("delete")));
}
async function kvWriteGate(env, action, error = null) {
  if (!env.SIGNAL_DELIVERY) return { allowed: true };
  try {
    const stub = env.SIGNAL_DELIVERY.get(env.SIGNAL_DELIVERY.idFromName("global-kv-write-quota"));
    const response = await stub.fetch("https://signal-delivery.internal/kv-write/" + action, {
      method: "POST",
      headers: { "content-type": "application/json", "x-signal-delivery-secret": env.SIGNAL_DELIVERY_SECRET || "" },
      body: JSON.stringify({ day: quotaDayKey(), message: error ? String(error?.message || error).slice(0, 300) : undefined })
    });
    if (!response.ok) throw new Error("KV quota gate returned HTTP " + response.status + "; refusing KV write.");
    const result = await response.json();
    if (typeof result?.allowed !== "boolean") throw new Error("KV quota gate returned an invalid response; refusing KV write.");
    return result;
  } catch (gateError) {
    console.error("KV quota gate unavailable; KV write blocked:", String(gateError?.message || gateError));
    throw new Error("KV quota gate unavailable; write blocked to protect the daily quota.");
  }
}
export function withQuotaAwareKV(env) {
  if (!env.APP_KV) return env;
  if (!env.SIGNAL_DELIVERY) throw new Error("SIGNAL_DELIVERY is required for safe KV quota enforcement.");
  const raw = env.APP_KV;
  const guarded = new Proxy(raw, {
    get(target, property) {
      if (property === "put" || property === "delete") return async (...args) => {
        const gate = await kvWriteGate(env, "allow");
        if (gate?.allowed === false) {
          console.warn("KV write suppressed by daily quota circuit breaker.");
          throw new Error("KV daily write quota is paused until the next UTC day; this change was not saved.");
        }
        try { return await target[property](...args); }
        catch (error) {
          if (isKvDailyWriteQuotaError(error)) {
            await kvWriteGate(env, "pause", error);
            console.error("KV daily write quota reached; writes paused until the next UTC day.");
          }
          throw error;
        }
      };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
  const wrappedEnv = Object.create(env);
  Object.defineProperty(wrappedEnv, "APP_KV", { value: guarded, enumerable: true });
  return wrappedEnv;
}

const ABOUT_TEXT =
  "🤖 تریدیار | دستیار معامله‌گر فیوچرز\n\n" +
  "طراحی و توسعه: علیرضا سعادتی\n\n" +
  "© تمامی حقوق مادی و معنوی این ربات محفوظ است.\n\n" +
  "هرگونه کپی‌برداری، بازنشر یا استفاده بدون کسب اجازه از صاحب اثر مجاز نیست.";

const CAPITAL_MANAGEMENT_TEXT =
  "🚨 <b>نکات مهم مدیریت سرمایه</b> 🚨\n\n" +
  "لطفاً پیش از ورود به هر سیگنال، این موارد را مطالعه کنید.\n\n\n" +
  "<b>1️⃣ مدیریت سرمایه</b>\n\n\n" +
  "🔹 در هر سیگنال حداکثر <b>۱٪ از کل سرمایه ولت</b> را به‌عنوان ریسک معامله در نظر بگیرید.\n\n\n" +
  "🔹 از افزایش حجم بیش از این مقدار خودداری کنید.\n\n\n" +
  "<b>2️⃣ مسئولیت ورود به معاملات</b>\n\n\n" +
  "🔹 مسئولیت تصمیم‌گیری و ورود به سیگنال‌ها بر عهده شماست.\n\n\n" +
  "🔹 هرگز با سرمایه موردنیاز زندگی وارد معاملات نشوید.\n\n\n" +
  "🔹 در صورت نداشتن دانش و تجربه کافی، از ورود به معاملات خودداری کنید.\n\n\n" +
  "🔹 هیچ سیگنالی قطعی یا بدون ریسک نیست؛ احتمال ضرر وجود دارد.\n\n\n" +
  "<b>3️⃣ اهرم و نحوه انجام معامله</b>\n\n\n" +
  "🔹 از اهرم متناسب با ریسک و فاصله حد ضرر استفاده کنید.\n\n\n" +
  "🔹 حالت <b>Isolated</b> و اهرم پایین‌تر معمولاً ریسک لیکویید شدن را کاهش می‌دهد.\n\n\n" +
  "🔹 استفاده از اهرم ۱۰ به‌معنای جلوگیری از لیکویید شدن نیست ، حتما از حد ضرر تعیین شده در سیگنال صادر شده استفاده کنید\n\n\n" +
  "<b>4️⃣ ورود بعد از تارگت اول</b>\n\n\n" +
  "🔹 اگر قیمت به تارگت اول رسیده است، از ورود دیرهنگام به همان سیگنال خودداری کنید.\n\n\n" +
  "<b>5️⃣ سیو سود و مدیریت حد ضرر</b>\n\n\n" +
  "🔹 در تارگت‌ها بخشی از حجم معامله را ببندید و سود را ذخیره کنید.\n\n\n" +
  "🔹 برای تارگت اول، می‌توانید بخش قابل‌توجهی از حجم را خارج کنید و باقی‌مانده را برای تارگت‌های بعدی نگه دارید.\n\n\n" +
  "🔹 پس از حرکت قیمت در جهت معامله، حد ضرر را متناسب با شرایط به نقطه ورود یا محدوده‌ای محافظت‌شده منتقل کنید.\n\n\n" +
  "🔹 میزان خروج در هر تارگت باید طوری تنظیم شود که مجموع حجم‌های بسته‌شده از ۱۰۰٪ بیشتر نشود.\n\n" +
  "⚠️ <b>حفظ سرمایه مهم‌تر از کسب سود است.</b>\n" +
  "هیچ‌گاه برای جبران ضرر، حجم معاملات را افزایش ندهید.";

const MAIN_MENU = {
  inline_keyboard: [
    [
      { text: "📈 سیگنال فیوچرز", callback_data: "futures" }
    ],
    [
      { text: "🔎 اسکن بازار", callback_data: "market_scan" },
      { text: "📊 تحلیل بازار", callback_data: "market_analysis" }
    ],
    [
      { text: "📌 معاملات باز", callback_data: "open_trades" },
      { text: "📚 تاریخچه معاملات", callback_data: "trade_history" },
      { text: "🗂 سیگنال‌های صادرشده", callback_data: "issued_signals" }
    ],
    [{ text: "🛡️ راهنمای مدیریت سرمایه", callback_data: "capital_guide" }],
    [{ text: "📡 وضعیت ربات", callback_data: "status" }],
    [
      { text: "🔌 تست اتصال", callback_data: "test" }
    ],
    [
      { text: "👥 دعوت از دوستان", callback_data: "invite" }
    ],
    [
      { text: "ℹ️ درباره", callback_data: "about" }
    ]
  ]
};

const BACK_MENU = {
  inline_keyboard: [
    [{ text: "🏠 منوی اصلی", callback_data: "menu" }]
  ]
};

export default {
  async scheduled(event, env, ctx) {
    env = withQuotaAwareKV(env);
    ctx.waitUntil(runAutomaticFuturesAlertScan(env));
  },

  async fetch(request, env, ctx) {
    env = withQuotaAwareKV(env);
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return json({
        ok: true,
        service: "Crypto Pump Hunter",
        version: CONFIG.VERSION,
        mode: "Kraken Derivatives Futures signals only",
        kv: Boolean(env.APP_KV),
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
        !(env.TELEGRAM_WEBHOOK_SECRET || env.WEBHOOK_SECRET) ||
        request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== (env.TELEGRAM_WEBHOOK_SECRET || env.WEBHOOK_SECRET)
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
        const key = `telegram:update:${updateId}`;
        if (env.APP_KV && !telegramKvDedupeUnavailable) {
          try {
            if (await env.APP_KV.get(key)) return new Response("OK");
            await env.APP_KV.put(key, "1", { expirationTtl: 86400 });
          } catch (error) {
            // KV daily write quotas must not take the Telegram webhook offline.
            // Fall back to isolate-local deduplication for the rest of this isolate's lifetime.
            telegramKvDedupeUnavailable = true;
            console.error(
              "Telegram update deduplication KV unavailable; using in-memory fallback:",
              String(error?.message || error)
            );
            if (seenUpdates.has(updateId)) return new Response("OK");
            seenUpdates.add(updateId);
            if (seenUpdates.size > 500) seenUpdates.delete(seenUpdates.values().next().value);
          }
        } else {
          if (seenUpdates.has(updateId)) return new Response("OK");
          seenUpdates.add(updateId);
          if (seenUpdates.size > 500) seenUpdates.delete(seenUpdates.values().next().value);
        }
      }

      if (update.callback_query) {
        ctx.waitUntil(handleCallback(update.callback_query, env));
        return new Response("OK");
      }

      const message = update.message || update.edited_message;

      if (!message?.chat?.id) return new Response("OK");
      const chatId = message.chat.id;

      if (!message.text) return new Response("OK");
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
  if (!(env.TELEGRAM_BOT_TOKEN || env.BOT_TOKEN)) throw new Error("BOT_TOKEN تنظیم نشده است.");

  const response = await fetch(
    `${TELEGRAM_API}/bot${(env.TELEGRAM_BOT_TOKEN || env.BOT_TOKEN)}/${method}`,
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

async function sendMessage(env, chatId, text, replyMarkup = null, parseMode = null) {
  const body = {
    chat_id: chatId,
    text,
    disable_web_page_preview: true
  };

  if (replyMarkup) body.reply_markup = replyMarkup;
  if (parseMode) body.parse_mode = parseMode;

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
    (env.OWNER_TELEGRAM_ID || env.OWNER_ID) &&
    String(chatId) === String((env.OWNER_TELEGRAM_ID || env.OWNER_ID))
  );
}

function memberKey(chatId) {
  return `member:${chatId}`;
}

function pendingKey(chatId) {
  return `pending:${chatId}`;
}

async function migrateLegacyMembership(env) {
  if (!env.APP_KV) return;
  const markerKey = "migration:v1-members-to-legacy-format";
  if (await env.APP_KV.get(markerKey)) return;
  const members = await env.APP_KV.get("v1:members", "json") || {};
  for (const [id, member] of Object.entries(members)) {
    if (member?.status === "active") {
      const key = memberKey(id);
      if (!(await env.APP_KV.get(key))) {
        await env.APP_KV.put(key, JSON.stringify({
          ...member, chatId: String(id), userId: String(id),
          approved: true, revoked: false
        }));
      }
    }
  }
  const requests = await env.APP_KV.get("v1:requests", "json") || {};
  for (const [id, request] of Object.entries(requests)) {
    const key = pendingKey(id);
    if (!(await env.APP_KV.get(key))) {
      await env.APP_KV.put(key, JSON.stringify({
        chatId: String(id), userId: String(id),
        username: request?.username || "",
        firstName: request?.name || "",
        lastName: "",
        requestedAt: request?.requestedAt || new Date().toISOString()
      }), { expirationTtl: CONFIG.PENDING_TTL });
    }
  }
  await env.APP_KV.put(markerKey, "1");
}

async function isApproved(chatId, env) {
  if (isOwner(chatId, env)) return true;

  if (!(env.OWNER_TELEGRAM_ID || env.OWNER_ID) || !env.APP_KV) return false;

  try {
    await migrateLegacyMembership(env);
    const member = await env.APP_KV.get(memberKey(chatId), "json");
    return Boolean(member && member.approved !== false && member.revoked !== true);
  } catch {
    return false;
  }
}

async function requestMembership(env, chatId, message) {
  if (isOwner(chatId, env)) {
    await showMenu(env, chatId);
    return;
  }

  if (!(env.OWNER_TELEGRAM_ID || env.OWNER_ID) || !env.APP_KV) {
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
    const existingMember = await env.APP_KV.get(memberKey(chatId), "json");
    if (existingMember?.revoked === true) {
      await sendMessage(
        env,
        chatId,
        "⛔ دسترسی شما توسط مدیر لغو شده است.\nبرای فعال‌سازی مجدد باید مدیر دسترسی شما را دوباره مجاز کند."
      );
      return;
    }
  } catch {
    await sendMessage(env, chatId, "⚠️ بررسی وضعیت عضویت ناموفق بود. لطفاً بعداً تلاش کنید.");
    return;
  }

  try {
    const existing = await env.APP_KV.get(pendingKey(chatId));

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

    await env.APP_KV.put(
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

    await sendMessage(env, (env.OWNER_TELEGRAM_ID || env.OWNER_ID), adminText, adminButtons);

    await sendMessage(
      env,
      chatId,
      "✅ درخواست عضویت شما با موفقیت ثبت شد.\n\n" +
      "⏳ درخواست شما در انتظار بررسی است.\n" +
      "پس از تعیین نتیجه، از طریق همین ربات مطلع می‌شوید."
    );
  } catch (error) {
    try {
      await env.APP_KV.delete(pendingKey(chatId));
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
  const ownerId = (env.OWNER_TELEGRAM_ID || env.OWNER_ID);
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

  if (!env.APP_KV) {
    await sendMessage(env, ownerId, "❌ اتصال KV در دسترس نیست.");
    return true;
  }

  try {
    const pending = await env.APP_KV.get(
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

      await env.APP_KV.put(
        memberKey(applicantId),
        JSON.stringify(member)
      );

      await env.APP_KV.delete(pendingKey(applicantId));

      await sendMessage(
        env,
        applicantId,
        "🎉 به خانواده CRYPTO PUMP HUNTER خوش آمدید!\n\n" +
        "✅ عضویت شما با موفقیت تأیید شد و دسترسی شما فعال است.\n\n" +
        "🚀 از این لحظه می‌توانید از اسکن بازار اسپات و سیگنال‌های تحلیلی فیوچرز استفاده کنید.\n\n" +
        "⚠️ سیگنال‌ها صرفاً تحلیلی هستند؛ قبل از هر معامله مدیریت ریسک را رعایت کنید."
      );
      await showMenu(env, applicantId);

      await sendMessage(
        env,
        ownerId,
        "✅ عضویت کاربر با موفقیت تأیید شد."
      );
    } else {
      await env.APP_KV.delete(pendingKey(applicantId));

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

async function handleOwnerAccessCommand(command, chatId, env, message) {
  if (!["/allow", "/revoke", "/members", "/member"].includes(command)) return false;
  if (!isOwner(chatId, env)) {
    await sendMessage(env, chatId, "⛔ این دستور فقط برای مدیر ربات فعال است.");
    return true;
  }
  if (!env.APP_KV) {
    await sendMessage(env, chatId, "❌ اتصال WATCHLIST_KV فعال نیست؛ ابتدا KV را به Worker متصل کن.");
    return true;
  }

  if (command === "/members") {
    await showMemberList(env, chatId, 0);
    return true;
  }

  if (command === "/member") {
    const targetId = (message?.text || "").trim().split(/\s+/)[1];
    if (!targetId || !/^-?\d+$/.test(targetId)) {
      await sendMessage(env, chatId, "فرمت صحیح: /member 123456789");
    } else {
      await showMemberProfile(env, chatId, targetId);
    }
    return true;
  }

  const targetId = (message?.text || "").trim().split(/\s+/)[1];
  if (!targetId || !/^-?\d+$/.test(targetId)) {
    await sendMessage(env, chatId, `فرمت صحیح: ${command} 123456789`);
    return true;
  }
  if (String(targetId) === String((env.OWNER_TELEGRAM_ID || env.OWNER_ID))) {
    await sendMessage(env, chatId, "⚠️ دسترسی مدیر اصلی قابل لغو نیست.");
    return true;
  }

  try {
    const existing = await env.APP_KV.get(memberKey(targetId), "json") || {};
    if (command === "/allow") {
      const member = { ...existing, chatId: String(targetId), approved: true, revoked: false,
        allowedAt: new Date().toISOString(), allowedBy: String(chatId) };
      await env.APP_KV.put(memberKey(targetId), JSON.stringify(member));
      await env.APP_KV.delete(pendingKey(targetId));
      await sendMessage(env, targetId,
        "🎉 دسترسی شما به CRYPTO PUMP HUNTER توسط مدیر فعال شد.\n\n" +
        "خوش آمدید! اکنون می‌توانید از امکانات ربات استفاده کنید.");
      await showMenu(env, targetId);
      await sendMessage(env, chatId, `✅ کاربر ${targetId} مجاز شد و دسترسی او فعال است.`);
    } else {
      const member = { ...existing, chatId: String(targetId), approved: false, revoked: true,
        revokedAt: new Date().toISOString(), revokedBy: String(chatId) };
      await env.APP_KV.put(memberKey(targetId), JSON.stringify(member));
      await env.APP_KV.delete(pendingKey(targetId));
      await sendMessage(env, targetId, "⛔ دسترسی شما به CRYPTO PUMP HUNTER توسط مدیر لغو شد.");
      await sendMessage(env, chatId, `🚫 دسترسی کاربر ${targetId} لغو شد.`);
    }
  } catch (error) {
    await sendMessage(env, chatId, "❌ خطا در تغییر دسترسی: " + String(error.message || "KV error").slice(0, 500));
  }
  return true;
}

// ---------------- OWNER MEMBER MANAGEMENT UI ----------------
async function showMemberList(env, ownerId, page = 0) {
  if (!isOwner(ownerId, env) || !env.APP_KV) return;
  await migrateLegacyMembership(env);
  const cursorKey = `admin:members:cursor:${ownerId}:${page}`;
  const cursor = page > 0 ? await env.APP_KV.get(cursorKey) : null;
  if (page > 0 && !cursor) {
    await sendMessage(env, ownerId, "صفحه قبلی منقضی شده است؛ فهرست را دوباره باز کن.");
    return;
  }
  const result = await env.APP_KV.list({ prefix: "member:", limit: 10, ...(cursor ? { cursor } : {}) });
  const keyboard = [];
  let active = 0, revoked = 0;
  for (const key of result.keys || []) {
    const id = key.name.slice(7);
    const m = await env.APP_KV.get(key.name, "json") || {};
    const blocked = m.revoked === true || m.approved === false;
    if (blocked) revoked++; else active++;
    const name = [m.firstName, m.lastName].filter(Boolean).join(" ") || "بدون نام";
    keyboard.push([{ text: `${blocked ? "🚫" : "✅"} ${name.slice(0,24)} | ${id}`, callback_data: `mprof:${id}` }]);
  }
  if (result.list_complete === false && result.cursor) {
    await env.APP_KV.put(`admin:members:cursor:${ownerId}:${page+1}`, result.cursor, { expirationTtl: 3600 });
    keyboard.push([{ text: "صفحه بعدی ➡️", callback_data: `members:${page+1}` }]);
  }
  if (page > 0) keyboard.push([{ text: "⬅️ صفحه قبل", callback_data: `members:${page-1}` }]);
  keyboard.push([{ text: "🏠 منوی اصلی", callback_data: "menu" }]);
  await sendMessage(env, ownerId,
    `👥 مدیریت اعضا | صفحه ${page+1}\n━━━━━━━━━━━━━━━━━━\nفعال در این صفحه: ${active}\nلغو دسترسی در این صفحه: ${revoked}\n\nبرای دیدن پروفایل و مدیریت دسترسی روی عضو بزن.`,
    { inline_keyboard: keyboard });
}
async function showMemberProfile(env, ownerId, id) {
  if (!isOwner(ownerId,env) || !env.APP_KV || !/^-?\d+$/.test(id)) return;
  const m=await env.APP_KV.get(memberKey(id),"json");
  if(!m){await sendMessage(env,ownerId,"عضو پیدا نشد.");return;}
  const blocked=m.revoked===true||m.approved===false;
  const name=[m.firstName,m.lastName].filter(Boolean).join(" ")||"ثبت نشده";
  const body=["👤 پروفایل عضو","━━━━━━━━━━━━━━━━━━",`نام: ${name}`,`نام کاربری: ${m.username?"@"+m.username:"ثبت نشده"}`,`شناسه تلگرام: ${m.userId||id}`,`شناسه گفتگو: ${m.chatId||id}`,`وضعیت: ${blocked?"🚫 لغو دسترسی":"✅ مجاز"}`,`درخواست: ${m.requestedAt||"نامشخص"}`,`تأیید: ${m.approvedAt||"ثبت نشده"}`,`آخرین فعال‌سازی: ${m.allowedAt||"ثبت نشده"}`,`لغو دسترسی: ${m.revokedAt||"ثبت نشده"}`].join("\n");
  await sendMessage(env,ownerId,body,{inline_keyboard:[[blocked?{text:"✅ اجازه دسترسی مجدد",callback_data:`mall:${id}`}:{text:"🚫 قطع دسترسی",callback_data:`mrev:${id}`}],[{text:"⬅️ بازگشت",callback_data:"members:"}]]});
}
async function changeMemberAccess(env,ownerId,id,allow) {
  if(!isOwner(ownerId,env)||!env.APP_KV||!/^-?\d+$/.test(id))return;
  if(String(id)===String((env.OWNER_TELEGRAM_ID || env.OWNER_ID))){await sendMessage(env,ownerId,"دسترسی مدیر اصلی قابل تغییر نیست.");return;}
  const m=await env.APP_KV.get(memberKey(id),"json");
  if(!m){await sendMessage(env,ownerId,"عضو پیدا نشد.");return;}
  const next=allow?{...m,approved:true,revoked:false,allowedAt:new Date().toISOString(),allowedBy:String(ownerId)}:{...m,approved:false,revoked:true,revokedAt:new Date().toISOString(),revokedBy:String(ownerId)};
  await env.APP_KV.put(memberKey(id),JSON.stringify(next));
  try{await sendMessage(env,id,allow?"🎉 دسترسی شما دوباره فعال شد.":"⛔ دسترسی شما توسط مدیر لغو شد.");}catch{}
  await showMemberProfile(env,ownerId,id);
}

// ---------------- MAIN MENU ----------------
function menuForChat(env, chatId) {
  const keyboard = MAIN_MENU.inline_keyboard.map(row => row.slice());
  if (isOwner(chatId, env)) keyboard.splice(keyboard.length - 1, 0,
    [{ text: "👥 مدیریت اعضا", callback_data: "members:0" }],
    [{ text: "⚠️ بررسی ارسال‌های نامشخص", callback_data: "outbox:review" }]
  );
  return { inline_keyboard: keyboard };
}
async function configureTelegramMenu(env, chatId) {
  const commands = [
    { command: "start", description: "نمایش منوی اصلی" },
    { command: "menu", description: "نمایش منوی اصلی" },
    { command: "futures", description: "دریافت سیگنال‌های فیوچرز" },
    { command: "status", description: "وضعیت سرویس" },
    { command: "help", description: "راهنمای دستورات" }
  ];
  const tasks = [
    telegram("setMyCommands", env, { commands }),
    telegram("setChatMenuButton", env, { chat_id: chatId, menu_button: { type: "commands" } }),
  ];
  const results = await Promise.allSettled(tasks);
  const failed = results.filter(x => x.status === "rejected");
  if (failed.length) console.error("Telegram menu/profile setup warning:", failed.map(x => x.reason?.message || "Telegram API error"));
}

function welcomeSeenKey(chatId) {
  return `welcome-seen:${chatId}`;
}

async function showMenu(env, chatId, welcome = false) {
  await configureTelegramMenu(env, chatId);
  const messageText = welcome
    ? "🤖 خوش آمدید به تریدیار!"
    : "📋 منوی اصلی تریدیار";
  await sendMessage(env, chatId, messageText, menuForChat(env, chatId));
}

async function handleTelegramCommand(command, chatId, env, message) {
  try {
    if (await handleOwnerAccessCommand(command, chatId, env, message)) return;

    if (command === "/start") {
      await configureTelegramMenu(env, chatId);
      if (await isApproved(chatId, env)) {
        let welcomeAlreadyShown = false;
        if (env.APP_KV) {
          try {
            welcomeAlreadyShown = Boolean(await env.APP_KV.get(welcomeSeenKey(chatId)));
          } catch (error) {
            console.error("Welcome state lookup failed:", error?.message || error);
          }
        }
        await showMenu(env, chatId, !welcomeAlreadyShown);
        if (!welcomeAlreadyShown && env.APP_KV) {
          try {
            await env.APP_KV.put(welcomeSeenKey(chatId), "1");
          } catch (error) {
            console.error("Welcome state save failed:", error?.message || error);
          }
        }
      } else {
        await requestMembership(env, chatId, message);
      }
      return;
    }

    if (command === "/menu") {
      if (await isApproved(chatId, env)) {
        await showMenu(env, chatId);
      } else {
        await requestMembership(env, chatId, message);
      }
      return;
    }

    if (!(await isApproved(chatId, env))) {
      await requestMembership(env, chatId, message);
      return;
    }

    if (command === "/fill") {
      await handleFillCommand(env, chatId, message);
      return;
    }
    if (command === "/help") {
      await sendMessage(
        env,
        chatId,
        "📘 راهنمای تریدیار\n\n" +
        "/start - معرفی و شروع\n" +
        "/menu - نمایش منوی اصلی\n" +
        "/futures - دریافت سیگنال‌های فیوچرز\n" +
        "/scan - اسکن دستی بازار اسپات\n" +
        "/status - وضعیت ربات\n" +
        "/help - راهنما\n\n" +
        "اسکن فقط با درخواست دستی شما اجرا می‌شود.",
        menuForChat(env, chatId)
      );
      return;
    }

    if (command === "/status") {
      await showStatus(env, chatId);
      return;
    }
    if (command === "/futures") {
      await runFuturesSignalsForChat(env, chatId);
      return;
    }

    await sendMessage(
      env,
      chatId,
      "برای استفاده از ربات، /start را بفرست.",
      menuForChat(env, chatId)
    );
  } catch (error) {
    try {
      await sendMessage(
        env,
        chatId,
        "❌ خطا در اجرای دستور:\n" +
        String(error.message || "Unknown error").slice(0, 1000),
        menuForChat(env, chatId)
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

  if (action.startsWith("approve:") || action.startsWith("reject:") ||
      action.startsWith("members:") || action.startsWith("mprof:") ||
      action.startsWith("mrev:") || action.startsWith("mall:") || action.startsWith("outbox:")) {
    if (!isOwner(chatId,env) || String(query.from?.id)!==String((env.OWNER_TELEGRAM_ID || env.OWNER_ID))) {
      await answerCallback(env,query.id,"⛔ دسترسی غیرمجاز"); return;
    }
    if(action.startsWith("approve:")||action.startsWith("reject:")) {
      await handleAdminMembershipCallback(query,env);
    } else {
      await answerCallback(env,query.id);
      if(action.startsWith("members:")) await showMemberList(env,chatId,Number(action.slice(8))||0);
    else if(action.startsWith("mprof:")) await showMemberProfile(env,chatId,action.slice(6));
    else if(action.startsWith("mrev:")) await changeMemberAccess(env,chatId,action.slice(5),false);
      else if(action.startsWith("mall:")) await changeMemberAccess(env,chatId,action.slice(5),true);
      else if(action==="outbox:review") await showUncertainSignalOutbox(env,chatId);
      else if(action.startsWith("outbox:detail:")) await showOutboxSignalDetail(env,chatId,action.slice(14));
      else if(action.startsWith("outbox:confirm:")) await reconcileSignalOutbox(env,chatId,action.slice(15),"confirm_delivered");
      else if(action.startsWith("outbox:retry:")) await reconcileSignalOutbox(env,chatId,action.slice(13),"retry");
    }
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
    if (action === "invite") {
      await sendMessage(env, chatId,
        "🚀 برای حمایت از توسعه و فعال ماندن Crypto Pump Hunter و همچنین بهره‌مندی از مزایای احتمالی ثبت‌نام، از طریق لینک اختصاصی زیر عضو صرافی LBank شوید.\n\n" +
        "🎁 با ثبت‌نام از این لینک، از فرصت دریافت بونوس‌ها و طرح‌های تشویقی صرافی مطلع شوید.\n\n" +
        "🔗 لینک ثبت‌نام:\nhttps://www.lbk.pub/ref/67XF8\n\n" +
        "❤️ حمایت شما به ادامه توسعه امکانات و خدمات بهتر ربات کمک می‌کند.", BACK_MENU);
      return;
    }
    if (action === "futures") {
      await runFuturesSignalsForChat(env, chatId);
      return;
    }
    if (action === "market_scan") {
      await runSpotMarketScanForChat(env, chatId);
      return;
    }
    if (action === "market_analysis") {
      await showLatestMarketAnalysis(env, chatId);
      return;
    }
    if (action === "open_trades") return showOpenFuturesTrades(env, chatId);
    if (action === "trade_history") return showIssuedSignalSymbols(env, chatId, "history");
    if (action === "issued_signals") return showIssuedSignalSymbols(env, chatId, "archive");
    if (action === "ledger:archive") return showIssuedSignalSymbols(env, chatId, "archive");
    if (action === "ledger:history") return showIssuedSignalSymbols(env, chatId, "history");
    if (action.startsWith("ledger:a:")) return showIssuedSignalDetails(env, chatId, action.slice(9), "archive");
    if (action.startsWith("ledger:h:")) return showIssuedSignalDetails(env, chatId, action.slice(9), "history");
    if (action.startsWith("trade:")) return handleTradeAction(action, chatId, env);
    if (action === "capital_guide") {
      await telegram("sendMessage", env, {
        chat_id: chatId,
        text: CAPITAL_MANAGEMENT_TEXT,
        parse_mode: "HTML",
        disable_web_page_preview: true,
        reply_markup: BACK_MENU
      });
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

    if (action === "about") {
      await sendMessage(env, chatId, ABOUT_TEXT, BACK_MENU);
      return;
    }

    await showMenu(env, chatId);
  } catch (error) {
    await sendMessage(
      env,
      chatId,
      "❌ خطا:\n" + String(error.message || "Unknown error").slice(0, 1000),
      menuForChat(env, chatId)
    );
  }
}

async function runSpotMarketScanForChat(env, chatId) {
  if (!env.APP_KV) {
    await sendMessage(env, chatId, "⚠️ اتصال ذخیره‌سازی گزارش بازار در دسترس نیست. Binding مربوط به APP_KV را بررسی کن.", menuForChat(env, chatId));
    return;
  }
  await sendMessage(env, chatId, "🔎 اسکن هوشمند بازار اسپات شروع شد...\nدر حال دریافت اطلاعات CoinLore و بررسی کندل‌های Kraken.");
  try {
    // Invalidate the previous snapshot before starting. If this scan fails or
    // exits early, the analysis button must not present stale data as current.
    await env.APP_KV.put("last_scan", JSON.stringify({
      timestamp: Date.now(),
      analysis: [],
      status: "scan_in_progress"
    }));
    const result = await runSpotScan(env);
    await sendLongMessage(env, chatId, result.report);
    await sendMessage(env, chatId, "✅ عملیات اسکن بازار اسپات به پایان رسید.", menuForChat(env, chatId));
  } catch (error) {
    console.error("Spot market scan failed:", String(error?.stack || error));
    await sendMessage(env, chatId, "❌ اجرای اسکن بازار اسپات ناموفق بود:\n" + String(error?.message || error).slice(0, 900), menuForChat(env, chatId));
  }
}

async function showLatestMarketAnalysis(env, chatId) {
  if (!env.APP_KV) {
    await sendMessage(env, chatId, "⚠️ ذخیره‌سازی گزارش اسکن بازار اسپات در دسترس نیست.", menuForChat(env, chatId));
    return;
  }

  let saved;
  try {
    saved = await env.APP_KV.get("last_scan", "json");
  } catch (error) {
    console.error("Could not load latest spot analysis:", String(error?.message || error));
    await sendMessage(env, chatId, "⚠️ دریافت آخرین تحلیل بازار اسپات ممکن نشد. کمی بعد دوباره تلاش کن.", menuForChat(env, chatId));
    return;
  }

  if (!saved?.timestamp) {
    await sendMessage(env, chatId, "هنوز گزارشی از بازار اسپات ذخیره نشده است. ابتدا «اسکن بازار» را اجرا کن.", menuForChat(env, chatId));
    return;
  }

  const rows = Array.isArray(saved.analysis) ? saved.analysis : [];
  if (!rows.length) {
    await sendMessage(env, chatId,
      "📊 داده‌های تحلیلی اسکن قبلی در نسخه ذخیره‌شده وجود ندارد.\n\nبرای ساخت گزارش تحلیلی مستقل، یک‌بار «اسکن بازار» را اجرا کن؛ سپس دوباره «تحلیل بازار» را بزن.",
      menuForChat(env, chatId));
    return;
  }

  const scannedAt = new Date(saved.timestamp).toLocaleString("fa-IR", { timeZone: "UTC" }) + " UTC";
  const count = rows.length;
  const bullish = rows.filter(x => x.trend === "صعودی").length;
  const bearish = count - bullish;
  const averageRsi = rows.reduce((sum, x) => sum + Number(x.rsi || 0), 0) / count;
  const averageScore = rows.reduce((sum, x) => sum + Number(x.score || 0), 0) / count;
  const volumeStrong = rows.filter(x => Number(x.volumeRatio) >= 1.5).length;
  const withSetup = rows.filter(x => x.setup && x.setup !== "بدون ستاپ").length;
  const eligible = rows.filter(x => x.eligible).sort((a, b) => b.score - a.score);
  const watch = rows.filter(x => !x.eligible && x.score >= 65 && x.trend === "صعودی" && x.setup !== "بدون ستاپ")
    .sort((a, b) => b.score - a.score);
  const caution = rows.filter(x => !x.eligible && (x.trend !== "صعودی" || x.score < 65 || x.setup === "بدون ستاپ" || Number(x.volumeRatio) < 0.9))
    .sort((a, b) => b.score - a.score);

  let marketTone = "ترکیبی و بدون برتری روشن";
  if (bullish / count >= 0.65 && averageRsi >= 50 && averageRsi <= 68) marketTone = "تمایل صعودی در بخش عمده نمادهای بررسی‌شده";
  else if (bullish / count <= 0.35 || averageRsi < 45) marketTone = "ضعیف یا متمایل به نزول";
  else if (averageRsi > 68) marketTone = "دارای مومنتوم بالا؛ احتمال ورود دیرهنگام را در نظر بگیر";

  const price = value => {
    const n = Number(value);
    return Number.isFinite(n) ? "$" + Number(n.toPrecision(7)).toString() : "—";
  };
  const describe = (x, index) => {
    const status = x.eligible
      ? "✅ واجد شرایط ورود طبق فیلتر اسکن"
      : "👀 فقط مناسب زیرنظرگرفتن؛ هنوز سیگنال خرید نیست";
    return (index + 1) + ") " + x.name + " (" + x.symbol + ")\n" +
      "⭐ امتیاز: " + x.score + "/100 | روند: " + x.trend + "\n" +
      "📊 RSI: " + Number(x.rsi).toFixed(1) + " | نسبت حجم: " + Number(x.volumeRatio).toFixed(2) + "x\n" +
      "🧩 الگو: " + (x.setup || "نامشخص") + " | قیمت: " + price(x.current) + "\n" +
      "🟢 حمایت: " + price(x.support) + " | 🔴 مقاومت: " + price(x.resistance) + "\n" +
      status + (x.reasons?.length ? "\n⚠️ نکته: " + x.reasons.slice(0, 2).join("، ") : "");
  };

  let report = "📊 تحلیل مستقل آخرین اسکن بازار اسپات\n" +
    "🕒 زمان داده‌ها: " + scannedAt + "\n" +
    "━━━━━━━━━━━━━━━━━━\n\n" +
    "🌐 تصویر کلی بازارِ بررسی‌شده\n" +
    "• نمادهای دارای داده معتبر: " + count + "\n" +
    "• روند صعودی: " + bullish + " | خنثی/نزولی: " + bearish + "\n" +
    "• میانگین امتیاز: " + averageScore.toFixed(1) + "/100\n" +
    "• میانگین RSI: " + averageRsi.toFixed(1) + "\n" +
    "• نمادهای با نسبت حجم حداقل 1.5x: " + volumeStrong + "\n" +
    "• نمادهای دارای الگوی ورود: " + withSetup + "\n\n" +
    "🧭 جمع‌بندی: " + marketTone + ".\n" +
    "این جمع‌بندی فقط بر اساس نمادهای فیلترشده همین اسکن است، نه کل بازار رمزارزها.\n\n";

  report += "🎯 فرصت‌های واجد شرایط\n━━━━━━━━━━━━━━━━━━\n";
  report += eligible.length
    ? "\n" + eligible.slice(0, 5).map(describe).join("\n\n") + "\n\n"
    : "\nدر این اسکن هیچ نمادی تمام شروط ورود را نداشت؛ بنابراین سیگنال خریدی صادر نشده است.\n\n";

  report += "👀 گزینه‌های قابل‌پیگیری\n━━━━━━━━━━━━━━━━━━\n";
  report += watch.length
    ? "\n" + watch.slice(0, 5).map(describe).join("\n\n") + "\n\n"
    : "\nدر داده‌های این اسکن گزینه‌ای با روند صعودی، امتیاز مناسب و الگوی مشخص برای واچ‌لیست پیدا نشد.\n\n";

  report += "⚠️ موارد نیازمند احتیاط\n━━━━━━━━━━━━━━━━━━\n";
  report += caution.length
    ? "\n" + caution.slice(0, 5).map(x =>
        "• " + x.name + " (" + x.symbol + ") | امتیاز " + x.score +
        " | " + x.trend + " | " + (x.reasons?.slice(0, 2).join("، ") || "شرایط ورود کامل نیست")
      ).join("\n") + "\n\n"
    : "\nمورد شاخصی برای هشدار بر اساس داده‌های ذخیره‌شده ثبت نشده است.\n\n";

  report += "━━━━━━━━━━━━━━━━━━\n" +
    "📌 این گزارش تفسیر داده‌های آخرین اسکن است و اسکن تازه‌ای اجرا نمی‌کند.\n" +
    "⚠️ تحلیل احتمالی است؛ تضمین سود یا توصیه قطعی خرید نیست.";

  await sendLongMessage(env, chatId, report);
  await sendMessage(env, chatId, "✅ تحلیل آخرین اسکن بازار آماده شد.", menuForChat(env, chatId));
}

async function showStatus(env, chatId) {
  let lastScan = "هنوز اسکن فیوچرز ذخیره‌شده‌ای وجود ندارد.";

  if (env.APP_KV) {
    try {
      const saved = await env.APP_KV.get("last_futures_scan", "json");
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
     "حالت فعالیت: فقط موتور سیگنال Kraken Futures\n" +
    `اتصال KV: ${env.APP_KV ? "فعال" : "غیرفعال"}\n` +
    `آخرین اسکن فیوچرز: ${lastScan}`,
    menuForChat(env, chatId)
  );
}

async function showConnectionTest(env, chatId) {
  await sendMessage(env, chatId, "🔌 در حال بررسی اتصال منابع داده...");
  const result = await testDataSources();
  const futures = result.krakenFutures?.ok
    ? `✅ Kraken Futures: متصل (${result.krakenFutures.symbols} قرارداد | نمونه ${result.krakenFutures.sample} | ${result.krakenFutures.candles} کندل 1H)`
    : `❌ Kraken Futures: ${result.krakenFutures?.error || "نامشخص"}`;
  await sendMessage(env, chatId, "🔌 نتیجه تست اتصال\n\n" + futures + "\n\n" + `نسخه ربات: V${CONFIG.VERSION}`, menuForChat(env, chatId));
}
async function registerWebhook(request, env) {
  if (!(env.TELEGRAM_BOT_TOKEN || env.BOT_TOKEN)) {
    return json({ ok: false, error: "BOT_TOKEN تنظیم نشده است." }, 400);
  }

  if (
    !(env.TELEGRAM_WEBHOOK_SECRET || env.WEBHOOK_SECRET) ||
    !/^[A-Za-z0-9_-]{1,256}$/.test((env.TELEGRAM_WEBHOOK_SECRET || env.WEBHOOK_SECRET))
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

    body.secret_token = (env.TELEGRAM_WEBHOOK_SECRET || env.WEBHOOK_SECRET);

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

async function testDataSources() {
  const result = { version: CONFIG.VERSION, krakenFutures: { ok: false } };
  try {
    const tickers = await getKrakenFuturesUniverse();
    const candles = await getKrakenFuturesCandles(tickers[0].symbol, "1h");
    result.krakenFutures = { ok: candles.length > 0, symbols: tickers.length, sample: tickers[0].symbol, candles: candles.length,
      error: candles.length ? undefined : "Kraken Futures کندل بسته‌شده برنگرداند." };
  } catch (error) { result.krakenFutures = { ok: false, error: error.message }; }
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

// ---------------- MULTI-EXCHANGE USDT-M PERPETUAL FUTURES DATA ----------------
// Public market data only. No private credentials and no order endpoints are used.
const FUTURES_CONFIG = {
  BASE_URL: "https://futures.kraken.com/derivatives/api/v3",
  CHARTS_URL: "https://futures.kraken.com/api/charts/v1",
  MAX_SYMBOLS: 24,
  CONCURRENCY: 3,
  MIN_QUOTE_VOLUME: 5_000_000,
  KLINE_LIMIT: 120,
  MIN_CANDLES: 60,
  MIN_SCORE: 72,
  INTERVAL: "1h",
  CONFIRM_INTERVAL: "4h",
  // Notification/manual-fill settings only; they do not alter the v3.8.2 signal rules.
  SIGNAL_TTL_MINUTES: 60,
  MAX_ENTRY_DRIFT_PCT: 0.35
};

const FUTURES_PROVIDER_ORDER = ["Kraken"];

async function krakenFuturesJson(path, label, baseUrl = FUTURES_CONFIG.BASE_URL) {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { Accept: "application/json" }
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
  if (data?.result === "error" || (Array.isArray(data?.errors) && data.errors.length)) {
    throw new Error(`${label}: ${(data.errors || []).join(", ") || data.error || "خطای Kraken"}`);
  }
  return data;
}

function isKrakenPerpetualTicker(item) {
  if (!item || item.tag !== "perpetual" || item.suspended === true) return false;
  const symbol = String(item.symbol || "").toUpperCase();
  // Kraken perpetual contracts use PI_ (inverse) or PF_ (multi-collateral) symbols.
  if (!/^(PI|PF)_[A-Z0-9]+USD$/.test(symbol)) return false;
  const quoteVolume = Number(item.volumeQuote);
  const last = Number(item.last);
  return Number.isFinite(quoteVolume) && quoteVolume >= FUTURES_CONFIG.MIN_QUOTE_VOLUME &&
    Number.isFinite(last) && last > 0;
}

async function getKrakenFuturesUniverse() {
  const data = await krakenFuturesJson("/tickers", "Kraken Futures tickers");
  if (!Array.isArray(data?.tickers)) {
    throw new Error("فهرست نمادهای Kraken Futures معتبر نیست.");
  }
  return data.tickers
    .filter(isKrakenPerpetualTicker)
    .sort((a, b) => Number(b.volumeQuote) - Number(a.volumeQuote))
    .slice(0, FUTURES_CONFIG.MAX_SYMBOLS)
    .map(t => ({
      ...t,
      priceChangePercent: Number(t.change24h) || 0,
      quoteVolume: Number(t.volumeQuote) || 0,
      premium: { lastFundingRate: Number(t.fundingRate) }
    }));
}

async function getKrakenFuturesCandles(symbol, interval) {
  const url = `${FUTURES_CONFIG.CHARTS_URL}/trade/${encodeURIComponent(symbol)}/${encodeURIComponent(interval)}`;
  const data = await krakenFuturesJson(url.replace(FUTURES_CONFIG.CHARTS_URL, ""),
    `Kraken ${symbol} ${interval}`, FUTURES_CONFIG.CHARTS_URL);
  if (!Array.isArray(data?.candles)) {
    throw new Error(`ساختار کندل‌های Kraken برای ${symbol} معتبر نیست.`);
  }
  const candles = data.candles.map(row => ({
    time: Number(row.time) < 1e12 ? Number(row.time) * 1000 : Number(row.time),
    open: Number(row.open),
    high: Number(row.high),
    low: Number(row.low),
    close: Number(row.close),
    volume: Number(row.volume)
  })).filter(c =>
    Number.isFinite(c.time) && Number.isFinite(c.close) && c.close > 0 &&
    Number.isFinite(c.high) && Number.isFinite(c.low) && c.high >= c.low && c.low > 0 &&
    Number.isFinite(c.volume) && c.volume >= 0
  ).sort((a, b) => a.time - b.time);

  // Exclude the currently forming candle. Kraken chart responses may include it.
  const intervalMsMap={"1m":60000,"5m":300000,"15m":900000,"30m":1800000,"1h":3600000,"4h":14400000,"12h":43200000,"1d":86400000,"1w":604800000};
  const intervalMs=intervalMsMap[interval]||3600000;
  const now = Date.now();
  return candles.filter(c => c.time + intervalMs <= now);
}


function normalizeKrakenFuturesUnderlying(symbol) {
  const raw = String(symbol || "").toUpperCase().replace(/^(PI|PF)_/, "").replace(/USD$/, "");
  return raw === "XBT" ? "BTC" : raw;
}

async function getFuturesUniverse() {
  return { exchange: "Kraken", tickers: await getKrakenFuturesUniverse(), fallbackReason: null };
}

async function getFuturesCandles(exchange, symbol, interval) {
  if (exchange !== "Kraken") throw new Error(`منبع داده ناشناخته: ${exchange}`);
  return getKrakenFuturesCandles(symbol, interval);
}

function calculateAtr(candles, period = 14) {
  if (candles.length <= period) return null;
  const ranges = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const prevClose = candles[i - 1].close;
    ranges.push(Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose)));
  }
  const recent = ranges.slice(-period);
  return recent.length === period ? average(recent) : null;
}

function analyzeFuturesSymbol(ticker, candles1h, candles4h) {
  if (candles1h.length < FUTURES_CONFIG.MIN_CANDLES || candles4h.length < FUTURES_CONFIG.MIN_CANDLES) {
    throw new Error("تعداد کندل بسته‌شده برای تحلیل ۱ساعته/۴ساعته کافی نیست.");
  }
  const closes1h = candles1h.map(c => c.close);
  const closes4h = candles4h.map(c => c.close);
  const last = candles1h[candles1h.length - 1];
  const price = last.close;
  const e20 = ema(closes1h, 20);
  const e50 = ema(closes1h, 50);
  const e20_4h = ema(closes4h, 20);
  const e50_4h = ema(closes4h, 50);
  const rsiValue = rsi(closes1h, 14);
  const atr = calculateAtr(candles1h, 14);
  if ([e20, e50, e20_4h, e50_4h, rsiValue, atr].some(v => !Number.isFinite(v)) || atr <= 0) {
    throw new Error("محاسبه اندیکاتورها معتبر نیست.");
  }

  const avgVol = average(candles1h.slice(-21, -1).map(c => c.volume));
  const volumeRatio = avgVol > 0 ? last.volume / avgVol : 0;
  const up1h = e20 > e50 && price > e20;
  const down1h = e20 < e50 && price < e20;
  const up4h = e20_4h > e50_4h;
  const down4h = e20_4h < e50_4h;
  let side = null;
  let score = 0;
  const reasons = [];

  const strictLong = up1h && up4h && rsiValue >= 48 && rsiValue <= 69;
  const strictShort = down1h && down4h && rsiValue >= 31 && rsiValue <= 52;
  const relaxedLong = up1h && !down4h && rsiValue >= 40 && rsiValue <= 75;
  const relaxedShort = down1h && !up4h && rsiValue >= 25 && rsiValue <= 60;
  const strictSetup = strictLong || strictShort;

  if (strictLong || (!strictSetup && relaxedLong)) {
    side = "LONG";
    score = strictSetup ? 45 : 40;
    reasons.push(strictSetup
      ? "روند ۱ساعته و ۴ساعته صعودی است"
      : "ستاپ آزمایشی: روند ۱ساعته صعودی و روند ۴ساعته مخالف نیست",
      "قیمت بالای EMA20 قرار دارد");
    score += rsiValue >= 52 && rsiValue <= 65 ? 15 : 9;
  } else if (strictShort || (!strictSetup && relaxedShort)) {
    side = "SHORT";
    score = strictSetup ? 45 : 40;
    reasons.push(strictSetup
      ? "روند ۱ساعته و ۴ساعته نزولی است"
      : "ستاپ آزمایشی: روند ۱ساعته نزولی و روند ۴ساعته مخالف نیست",
      "قیمت زیر EMA20 قرار دارد");
    score += rsiValue >= 35 && rsiValue <= 48 ? 15 : 9;
  } else {
    return { symbol: ticker.symbol, rejected: "حتی شرایط منعطف آزمایشی روند و RSI نیز تأیید نشد" };
  }

  if (volumeRatio >= 1.5) { score += 18; reasons.push("حجم بالاتر از میانگین است"); }
  else if (volumeRatio >= 1.0) { score += 12; reasons.push("حجم نزدیک یا بالاتر از میانگین است"); }
  else { score += 4; reasons.push("حجم کمتر از میانگین است"); }

  const change = Number(ticker.priceChangePercent) || 0;
  if ((side === "LONG" && change > 0) || (side === "SHORT" && change < 0)) score += 8;
  else score += 3;

  const funding = Number(ticker.premium?.lastFundingRate);
  if (Number.isFinite(funding)) {
    if (side === "LONG" && funding > 0.001) { score -= 5; reasons.push("فاندینگ مثبت و نسبتاً بالا؛ ریسک ازدحام لانگ"); }
    else if (side === "SHORT" && funding < -0.001) { score -= 5; reasons.push("فاندینگ منفی و نسبتاً پایین؛ ریسک ازدحام شورت"); }
    else reasons.push("فاندینگ در محدوده افراطی نیست");
  } else {
    reasons.push("داده فاندینگ در دسترس نبود");
  }

  const swing = candles1h.slice(-8, -1);
  const swingLow = Math.min(...swing.map(c => c.low));
  const swingHigh = Math.max(...swing.map(c => c.high));
  const entry = price;
  let stop = side === "LONG"
    ? Math.min(swingLow, entry - atr * 1.5)
    : Math.max(swingHigh, entry + atr * 1.5);
  // Enforce a positive, bounded risk distance; reject malformed levels.
  const risk = side === "LONG" ? entry - stop : stop - entry;
  const riskPct = risk / entry;
  if (!Number.isFinite(risk) || risk <= 0 || riskPct < 0.002 || riskPct > 0.08) {
    return { symbol: ticker.symbol, rejected: "فاصله حد ضرر غیرمنطقی است؛ سیگنال صادر نشد" };
  }

  const direction = side === "LONG" ? 1 : -1;
  const target1 = entry + direction * risk * 1.5;
  const target2 = entry + direction * risk * 2.5;
  const target3 = entry + direction * risk * 3.5;
  score = Math.max(0, Math.min(100, Math.round(score)));
  const eligible = strictSetup && score >= FUTURES_CONFIG.MIN_SCORE && volumeRatio >= 0.75;
  const experimentalEligible = !eligible && !strictSetup && score >= 55 && volumeRatio >= 0.5;
  return {
    symbol: ticker.symbol,
    side,
    score,
    experimentalEligible,
    price,
    entry,
    stop,
    target1,
    target2,
    target3,
    rewardRisk: 1.5,
    rsi: rsiValue,
    ema20: e20,
    ema50: e50,
    atr,
    volumeRatio,
    funding: Number.isFinite(funding) ? funding : null,
    quoteVolume: Number(ticker.quoteVolume) || 0,
    change24h: change,
    candleTime: last.time,
    reasons,
    eligible
  };
}

function formatPrice(value) {
  const price = Number(value);
  if (!Number.isFinite(price)) return "—";
  return price.toLocaleString("en-US", { maximumFractionDigits: 8 });
}

function formatFuturesSignal(item, index = 1) {
  const sideLabel = item.side === "LONG" ? "🟢 لانگ / Long" : "🔴 شورت / Short";
  const label = item.tier === "EXPERIMENTAL" ? "🟠 سیگنال پر ریسک" : "🟢 سیگنال معتبر";
  const symbol = escapeTelegramHtml(formatFuturesSymbol(item.symbol));
  return `${label}\n\n` +
    `نماد: <b>${symbol}</b>\n\n` +
    `جهت معامله: ${sideLabel}\n\n` +
    `قیمت ورود: <b>${formatSignalPrice(item.entry)}</b>\n\n` +
    `🎯 تارگت اول: <b>${formatSignalPrice(item.target1)}</b>\n` +
    `🎯 تارگت دوم: <b>${formatSignalPrice(item.target2)}</b>\n` +
    `🎯 تارگت سوم: <b>${formatSignalPrice(item.target3)}</b>\n\n` +
    `⛔ حد ضرر: <b>${formatSignalPrice(item.stop)}</b>`;
}

function formatSignalPrice(value) {
  const price = Number(value);
  return Number.isFinite(price)
    ? price.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 8 })
    : "—";
}

function escapeTelegramHtml(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function formatFuturesSymbol(symbol) {
  const normalized = String(symbol || "—").trim().toUpperCase()
    .replace(/^PF_/, "")
    .replace(/\.P$/, "")
    .replace(/[-_/]?(?:USDT|USD)$/, "");
  if (normalized === "XBT") return "BTC";
  if (normalized === "NVDX") return "NVDA";
  return normalized;
}


// V4.6: automatic signal-outcome tracking.
const FUTURES_PENDING_KEY="futures_pending_signals";
const FUTURES_OPEN_KEY="futures_open_trades";
const FUTURES_CLOSED_KEY="futures_closed_trades";
async function readTradeList(env,key){if(!env.APP_KV)throw new Error("APP_KV binding is missing");const raw=await env.APP_KV.get(key);if(!raw)return[];try{const v=JSON.parse(raw);return Array.isArray(v)?v:[]}catch{return[]}}
async function writeTradeList(env,key,value){if(!env.APP_KV)throw new Error("APP_KV binding is missing");await env.APP_KV.put(key,JSON.stringify(value))}
async function savePendingFuturesSignals(env,fresh){
  const now=Date.now(),old=await readTradeList(env,FUTURES_PENDING_KEY),m=new Map();
  for(const x of old.filter(v=>v.expiresAt>now)){const f=futuresSignalFingerprint(x);if(f&&!m.has(f))m.set(f,x)}
  for(const x of fresh){const f=futuresSignalFingerprint(x);if(f&&!m.has(f))m.set(f,x)}
  const merged=[...m.values()].slice(0,150);
  // A scheduled scan runs every five minutes. Do not spend a KV Put when the
  // pending-signal snapshot is byte-for-byte unchanged.
  if(JSON.stringify(merged)!==JSON.stringify(old))await writeTradeList(env,FUTURES_PENDING_KEY,merged);
  return fresh.map(x=>m.get(futuresSignalFingerprint(x))).filter(Boolean)
}
const tradeDir=side=>side==="LONG"?1:-1;
const targetReached=(side,p,t)=>side==="LONG"?p>=t:p<=t;
const stopReached=(side,p,t)=>side==="LONG"?p<=t:p>=t;
const FUTURES_DISPLAY_LEVERAGE=10;
function priceChangePercent(side,entry,exit){const e=Number(entry),x=Number(exit);return Number.isFinite(e)&&e>0&&Number.isFinite(x)?tradeDir(side)*(x-e)/e*100:null}
function leveragedPriceChangePercent(side,entry,exit){const p=priceChangePercent(side,entry,exit);return p===null?null:p*FUTURES_DISPLAY_LEVERAGE}
function formatOutcomePercent(value){if(value===null||value===undefined||value==="")return "—";const n=Number(value);if(!Number.isFinite(n))return "—";const label=n>0?"سود":n<0?"زیان":"سر‌به‌سر";return `${Math.abs(n).toFixed(2)}٪ ${label}`}
function tradeResultR(t,includeRemainder){const risk=Number(t.initialRisk),entry=Number(t.actualEntry);if(!Number.isFinite(risk)||risk<=0||!Number.isFinite(entry)||entry<=0)return null;const levels=[["TP1",.4,Number(t.target1)],["TP2",.35,Number(t.target2)],["TP3",.25,Number(t.target3)]];let r=0,weight=0;for(const[k,w,target]of levels)if((t.tpHits||[]).includes(k)&&Number.isFinite(target)){r+=w*tradeDir(t.side)*(target-entry)/risk;weight+=w}if(includeRemainder)r+=(1-weight)*tradeDir(t.side)*(Number(t.currentStop)-entry)/risk;return r}
function tradeOutcomePercent(t,exitPrice){const e=Number(t.actualEntry??t.entry);if(!Number.isFinite(e)||e<=0)return null;const levels=[["TP1",.4,t.target1],["TP2",.35,t.target2],["TP3",.25,t.target3]];let out=0,w=0;for(const[k,wt,target]of levels)if((t.tpHits||[]).includes(k)&&Number.isFinite(Number(target))){const p=priceChangePercent(t.side,e,target);if(p!==null){out+=wt*p;w+=wt}}if(w<1){const p=priceChangePercent(t.side,e,exitPrice);if(p!==null)out+=(1-w)*p}return out*FUTURES_DISPLAY_LEVERAGE}
function getNewClosedFuturesCandles(candles,lastCheckedCandleTime=0){return(Array.isArray(candles)?candles:[]).filter(c=>Number(c.time)>Number(lastCheckedCandleTime||0)).sort((a,b)=>a.time-b.time)}
function ensureTradeTrackingCheckpoint(trade,now=Date.now()){if(!Number.isFinite(Number(trade?.lastCheckedCandleTime))||Number(trade.lastCheckedCandleTime)<=0){trade.lastCheckedCandleTime=Math.floor(now/60000)*60000;trade.trackingMode=trade.trackingMode||"LEGACY_CONTINUED";return true}return false}
function isValidFuturesSignalLevels(signal){const entry=Number(signal?.entry),stop=Number(signal?.stop),targets=[Number(signal?.target1),Number(signal?.target2),Number(signal?.target3)];if(!signal?.id||!signal?.symbol||!["LONG","SHORT"].includes(signal?.side)||![entry,stop,...targets].every(Number.isFinite)||![entry,stop,...targets].every(v=>v>0))return false;return signal.side==="LONG"?stop<entry&&entry<targets[0]&&targets[0]<targets[1]&&targets[1]<targets[2]:stop>entry&&entry>targets[0]&&targets[0]>targets[1]&&targets[1]>targets[2]}
function createTrackedFuturesTrade(signal,chatId){if(!isValidFuturesSignalLevels(signal))return null;const entry=Number(signal.entry),stop=Number(signal.stop),createdAt=Date.now();return{id:crypto.randomUUID(),signalId:signal.id,chatId:String(chatId),symbol:signal.symbol,exchange:signal.exchange||"Kraken",side:signal.side,tier:signal.tier==="EXPERIMENTAL"?"EXPERIMENTAL":"STANDARD",strategyId:signal.strategyId||"kraken-futures-engine",strategyName:signal.strategyName||"Kraken Futures 3.8.2",reason:signal.reason||"",plannedEntry:entry,actualEntry:entry,initialStop:stop,currentStop:stop,target1:Number(signal.target1),target2:Number(signal.target2),target3:Number(signal.target3),initialRisk:tradeDir(signal.side)*(entry-stop),tpHits:[],status:"OPEN",trackingMode:"SIGNAL_EVALUATION",createdAt:new Date(createdAt).toISOString(),lastPrice:entry,lastCheckedAt:new Date(createdAt).toISOString(),lastCheckedCandleTime:Math.floor(createdAt/60000)*60000}}
async function registerTrackedSignal(env,chatId,signal){
  if(!env.APP_KV||!signal?.id)return false;
  const open=await readTradeList(env,FUTURES_OPEN_KEY),closed=await readTradeList(env,FUTURES_CLOSED_KEY);
  const existing=[...open,...closed].find(t=>String(t.signalId)===String(signal.id)&&String(t.chatId)===String(chatId));
  if(existing){
    // Backfill the permanent ledger for a trade created before the archive write completed.
    await saveIssuedSignal(env.APP_KV,chatId,signal,existing);
    await updateIssuedSignal(env.APP_KV,chatId,existing);
    return false;
  }
  const trade=createTrackedFuturesTrade(signal,chatId);
  if(!trade)return false;
  // Persist the canonical archive first. If the open-list write then fails,
  // a retry can safely rebuild the open-list entry without duplicating the archive.
  await saveIssuedSignal(env.APP_KV,chatId,signal,trade);
  open.unshift(trade);
  await writeTradeList(env,FUTURES_OPEN_KEY,open.slice(0,300));
  return true
}
async function sendAndArchiveFuturesSignalUnlocked(env,chatId,signal,messageText,replyMarkup=null,parseMode="HTML"){
  if(!signal?.id||!signal?.symbol||!["LONG","SHORT"].includes(signal?.side))throw new Error("Signal is missing a valid id, symbol, or direction.");
  if(!isValidFuturesSignalLevels(signal))throw new Error("Signal price levels are invalid or not correctly ordered; refusing to publish an untrackable signal.");
  if(!env.APP_KV)throw new Error("APP_KV is required for durable signal delivery.");
  const key=signalOutboxKey(chatId,signal.id);
  let record=await env.APP_KV.get(key,"json");
  const action=signalOutboxAction(record);
  if(action==="done")return{delivered:true,duplicate:true};
  if(action==="reconcile"){
    throw new Error(`Signal delivery requires reconciliation (${record.status}): ${signal.symbol} ${signal.id}`);
  }
  if(!record){
    record={version:1,chatId:String(chatId),signalId:String(signal.id),symbol:signal.symbol,signal,messageText,replyMarkup,parseMode,status:"QUEUED",createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
    await env.APP_KV.put(key,JSON.stringify(record));
  }
  if(signalOutboxAction(record)==="send"){
    record={...record,status:"SENDING",attemptedAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
    await env.APP_KV.put(key,JSON.stringify(record));
    try{
      const response=await sendMessage(env,chatId,messageText,replyMarkup,parseMode);
      record={...record,status:"SENT",telegramMessageId:response?.result?.message_id??null,sentAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
      await env.APP_KV.put(key,JSON.stringify(record));
    }catch(error){
      // Network failures can be ambiguous: do not blindly resend and risk duplicate alerts.
      record={...record,status:"UNCERTAIN",error:String(error?.message||error).slice(0,500),updatedAt:new Date().toISOString()};
      try{await env.APP_KV.put(key,JSON.stringify(record));}catch(storeError){console.error("Could not persist uncertain signal outbox state:",String(storeError?.message||storeError));}
      throw error;
    }
  }
  await registerTrackedSignal(env,chatId,signal);
  record={...record,status:"ARCHIVED",archivedAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
  await env.APP_KV.put(key,JSON.stringify(record));
  return{delivered:true,duplicate:false};
}

async function sendAndArchiveFuturesSignal(env,chatId,signal,messageText,replyMarkup=null,parseMode="HTML"){
  if(!signal?.id)throw new Error("Signal id is required for coordinated delivery.");
  if(!env.SIGNAL_DELIVERY)throw new Error("SIGNAL_DELIVERY Durable Object binding is required; refusing an uncoordinated send.");
  const key=signalOutboxKey(chatId,signal.id);
  const id=env.SIGNAL_DELIVERY.idFromName(key);
  const stub=env.SIGNAL_DELIVERY.get(id);
  if(!env.SIGNAL_DELIVERY_SECRET)throw new Error("SIGNAL_DELIVERY_SECRET is required for authenticated delivery.");
  const response=await stub.fetch("https://signal-delivery.internal/deliver",{
    method:"POST",
    headers:{"content-type":"application/json","x-signal-delivery-secret":env.SIGNAL_DELIVERY_SECRET},
    body:JSON.stringify({chatId:String(chatId),signal,messageText,replyMarkup,parseMode})
  });
  let payload;
  try{payload=await response.json()}catch{throw new Error("Signal delivery coordinator returned an unreadable response.");}
  if(!response.ok||!payload?.ok)throw new Error(payload?.error||"Signal delivery coordinator failed.");
  return payload.result;
}

export class SignalDeliveryCoordinator {
  constructor(ctx,env){
    this.ctx=ctx;
    this.env=env;
    this.serial=createSerialExecutor();
  }
  async fetch(request){
    const url=new URL(request.url);
    if(request.method!=="POST"||!["/deliver","/reconcile","/scan-lock/acquire","/scan-lock/release","/kv-write/allow","/kv-write/pause"].includes(url.pathname))return new Response("Not found",{status:404});
    const expectedSecret=this.env.SIGNAL_DELIVERY_SECRET;
    const suppliedSecret=request.headers.get("x-signal-delivery-secret");
    if(!expectedSecret||!suppliedSecret||suppliedSecret!==expectedSecret)return Response.json({ok:false,error:"Unauthorized."},{status:401});
    let payload;
    try{payload=await request.json()}catch{return Response.json({ok:false,error:"Invalid JSON payload."},{status:400});}
    return this.serial(async()=>{
      try{
        if(url.pathname==="/kv-write/allow"){
          const today=quotaDayKey();
          const paused=await this.ctx.storage.get("kv-daily-write-pause");
          if(paused?.day===today)return Response.json({ok:true,allowed:false,day:today});
          if(paused?.day&&paused.day!==today)await this.ctx.storage.delete("kv-daily-write-pause");
          return Response.json({ok:true,allowed:true,day:today});
        }
        if(url.pathname==="/kv-write/pause"){
          const today=quotaDayKey();
          await this.ctx.storage.put("kv-daily-write-pause",{day:today,pausedAt:new Date().toISOString(),reason:payload.message||"Daily KV write quota exceeded"});
          return Response.json({ok:true,allowed:false,day:today});
        }
        if((url.pathname==="/deliver"||url.pathname==="/reconcile") && this.env.SIGNAL_DELIVERY){
          const gate=await kvWriteGate(this.env,"allow");
          if(gate?.allowed===false)throw new Error("KV daily write quota is paused until the next UTC day.");
        }
        if(url.pathname==="/scan-lock/acquire"){
          const current=await this.ctx.storage.get("automatic-futures-scan-lock");
          const now=Date.now();
          if(current&&Number(current.expiresAt)>now)return Response.json({ok:true,acquired:false});
          await this.ctx.storage.put("automatic-futures-scan-lock",{acquiredAt:now,expiresAt:now+240000});
          return Response.json({ok:true,acquired:true});
        }
        if(url.pathname==="/scan-lock/release"){
          await this.ctx.storage.delete("automatic-futures-scan-lock");
          return Response.json({ok:true,released:true});
        }
        if(url.pathname==="/deliver"){
          const result=await sendAndArchiveFuturesSignalUnlocked(this.env,payload.chatId,payload.signal,payload.messageText,payload.replyMarkup??null,payload.parseMode??"HTML");
          return Response.json({ok:true,result});
        }
        if(!this.env.APP_KV)throw new Error("APP_KV is required for reconciliation.");
        const chatId=String(payload.chatId), signalId=String(payload.signalId);
        const key=signalOutboxKey(chatId,signalId);
        const record=await this.env.APP_KV.get(key,"json");
        if(!record)throw new Error("Outbox record was not found.");
        if(payload.action==="confirm_delivered"){
          if(record.status==="ARCHIVED")return Response.json({ok:true,result:{alreadyArchived:true}});
          if(!["SENDING","UNCERTAIN","SENT"].includes(record.status))throw new Error("This signal is not awaiting delivery reconciliation.");
          if(!record.signal)throw new Error("This older outbox record has no signal snapshot; it cannot be safely archived automatically.");
          await registerTrackedSignal(this.env,chatId,record.signal);
          const confirmed={...record,status:"ARCHIVED",archivedAt:new Date().toISOString(),updatedAt:new Date().toISOString(),manualConfirmedAt:new Date().toISOString()};
          await this.env.APP_KV.put(key,JSON.stringify(confirmed));
          return Response.json({ok:true,result:{confirmed:true}});
        }
        if(payload.action==="retry"){
          if(!["SENDING","UNCERTAIN"].includes(record.status))throw new Error("Only SENDING or UNCERTAIN records can be retried.");
          if(!record.signal||typeof record.messageText!=="string")throw new Error("This older outbox record has no retry payload.");
          await this.env.APP_KV.put(key,JSON.stringify({...record,status:"QUEUED",retryAuthorizedAt:new Date().toISOString(),updatedAt:new Date().toISOString()}));
          const result=await sendAndArchiveFuturesSignalUnlocked(this.env,chatId,record.signal,record.messageText,record.replyMarkup??null,record.parseMode??"HTML");
          return Response.json({ok:true,result});
        }
        throw new Error("Unknown reconciliation action.");
      }catch(error){
        if(isKvDailyWriteQuotaError(error)){
          if(this.env.SIGNAL_DELIVERY)await kvWriteGate(this.env,"pause",error);
          await this.ctx.storage.put("kv-daily-write-pause",{day:quotaDayKey(),pausedAt:new Date().toISOString(),reason:String(error?.message||error).slice(0,300)});
        }
        return Response.json({ok:false,error:String(error?.message||error).slice(0,500)},{status:409});
      }
    });
  }
}


function outboxSelectionKey(ownerId,token){return "admin:outbox-selection:"+ownerId+":"+token;}

async function showUncertainSignalOutbox(env,ownerId){
  if(!isOwner(ownerId,env)||!env.APP_KV)return;
  const page=await env.APP_KV.list({prefix:"futures:signal-outbox:v1:",limit:1000});
  const records=[];
  for(const item of page.keys||[]){const record=await env.APP_KV.get(item.name,"json");if(record&&["SENDING","UNCERTAIN","SENT"].includes(record.status))records.push(record);}
  records.sort((a,b)=>String(b.updatedAt||b.createdAt||"").localeCompare(String(a.updatedAt||a.createdAt||"")));
  const keyboard=[];
  for(const record of records.slice(0,15)){
    const token=crypto.randomUUID().replace(/-/g,"").slice(0,12);
    await env.APP_KV.put(outboxSelectionKey(ownerId,token),JSON.stringify({chatId:record.chatId,signalId:record.signalId}),{expirationTtl:3600});
    keyboard.push([{text:"⚠️ "+(record.symbol||"Signal")+" · "+record.status,callback_data:"outbox:detail:"+token}]);
  }
  keyboard.push([{text:"🔄 به‌روزرسانی",callback_data:"outbox:review"},{text:"🏠 منوی اصلی",callback_data:"menu"}]);
  const note=page.list_complete===false?"\nنمایش بر اساس اولین ۱۰۰۰ رکورد KV است.":"";
  await sendMessage(env,ownerId,"🛠 بررسی ارسال‌های نیازمند تعیین تکلیف\n━━━━━━━━━━━━━━━━━━\nتعداد موارد نیازمند بررسی: "+records.length+note+"\n\nبرای هر مورد، ابتدا پیام‌های تلگرام را بررسی کن.",{inline_keyboard:keyboard});
}

async function showOutboxSignalDetail(env,ownerId,token){
  if(!isOwner(ownerId,env)||!env.APP_KV)return;
  const selection=await env.APP_KV.get(outboxSelectionKey(ownerId,token),"json");
  if(!selection){await sendMessage(env,ownerId,"این مورد منقضی شده است؛ فهرست را دوباره باز کن.");return;}
  const record=await env.APP_KV.get(signalOutboxKey(selection.chatId,selection.signalId),"json");
  if(!record){await sendMessage(env,ownerId,"رکورد ارسال پیدا نشد.");return;}
  const hasPayload=Boolean(record.signal&&typeof record.messageText==="string");
  const keyboard=[];
  if(["SENDING","UNCERTAIN","SENT"].includes(record.status))keyboard.push([{text:"✅ پیام را در تلگرام دیدم؛ ثبت‌شده محسوب شود",callback_data:"outbox:confirm:"+token}]);
  if(["SENDING","UNCERTAIN"].includes(record.status)&&hasPayload)keyboard.push([{text:"⚠️ پیام را ندیدم؛ تلاش مجدد (احتمال تکرار)",callback_data:"outbox:retry:"+token}]);
  keyboard.push([{text:"⬅️ بازگشت",callback_data:"outbox:review"}]);
  const body=["🔍 جزئیات ارسال","━━━━━━━━━━━━━━━━━━","نماد: "+(record.symbol||"—"),"شناسه گفتگو: "+record.chatId,"شناسه سیگنال: "+record.signalId,"وضعیت: "+record.status,"آخرین به‌روزرسانی: "+(record.updatedAt||"—"),"","اگر پیام در تلگرام دیده می‌شود، گزینه ثبت ارسال‌شده را بزن.","تلاش مجدد فقط وقتی مناسب است که پیام را بررسی کرده باشی؛ در وضعیت نامشخص احتمال ارسال تکراری وجود دارد."];
  if(!hasPayload)body.push("⚠️ این رکورد قدیمی است و اطلاعات کافی برای بازیابی خودکار ندارد.");
  await sendMessage(env,ownerId,body.join("\n"),{inline_keyboard:keyboard});
}

async function reconcileSignalOutbox(env,ownerId,token,action){
  if(!isOwner(ownerId,env)||!env.APP_KV||!env.SIGNAL_DELIVERY)return;
  const selection=await env.APP_KV.get(outboxSelectionKey(ownerId,token),"json");
  if(!selection){await sendMessage(env,ownerId,"این مورد منقضی شده است؛ فهرست را دوباره باز کن.");return;}
  const key=signalOutboxKey(selection.chatId,selection.signalId);
  const stub=env.SIGNAL_DELIVERY.get(env.SIGNAL_DELIVERY.idFromName(key));
  if(!env.SIGNAL_DELIVERY_SECRET){await sendMessage(env,ownerId,"❌ کلید امنیتی ارتباط داخلی تنظیم نشده است.");return;}
   const response=await stub.fetch("https://signal-delivery.internal/reconcile",{method:"POST",headers:{"content-type":"application/json","x-signal-delivery-secret":env.SIGNAL_DELIVERY_SECRET},body:JSON.stringify({...selection,action})});
  let payload={};try{payload=await response.json()}catch{}
  if(!response.ok||!payload.ok){await sendMessage(env,ownerId,"❌ تعیین تکلیف انجام نشد: "+String(payload.error||"خطای نامشخص"));return;}
  await sendMessage(env,ownerId,action==="confirm_delivered"?"✅ سیگنال به‌عنوان ارسال‌شده در آرشیو ثبت شد.":"🔁 تلاش مجدد انجام شد و نتیجه در آرشیو ثبت شد.");
  await showUncertainSignalOutbox(env,ownerId);
}
async function refreshTrackedFuturesTrades(env,chatId=null){
  const open=await readTradeList(env,FUTURES_OPEN_KEY);
  if(!open.length)return{checked:0,closed:0};
  const targets=open.filter(t=>chatId==null||String(t.chatId)===String(chatId));
  if(!targets.length)return{checked:0,closed:0};
  const closed=await readTradeList(env,FUTURES_CLOSED_KEY),remaining=open.slice();
  let checked=0,closedCount=0,openListDirty=false,closedListDirty=false;
  const checkpointNow=Date.now();
  const persistSnapshots=chatId!==null;
  const results=await mapLimit(targets,3,async trade=>{
    try{
      const checkpointChanged=ensureTradeTrackingCheckpoint(trade,checkpointNow);
      const candles=await getKrakenFuturesCandles(trade.symbol,"1m");
      const recent=getNewClosedFuturesCandles(candles,trade.lastCheckedCandleTime);
      let event=null,eventPrice=null,eventCandleTime=null,milestoneChanged=false;
      for(const candle of recent.sort((a,b)=>a.time-b.time)){
        const hi=Number(candle.high),lo=Number(candle.low);
        const stopHit=stopReached(trade.side,hi,trade.currentStop)||stopReached(trade.side,lo,trade.currentStop);
        const hits=[["TP1",Number(trade.target1)],["TP2",Number(trade.target2)],["TP3",Number(trade.target3)]]
          .filter(([,target])=>Number.isFinite(target)&&(targetReached(trade.side,hi,target)||targetReached(trade.side,lo,target)));
        if(stopHit){event="STOP";eventPrice=trade.currentStop;eventCandleTime=candle.time;break}
        for(const[k,target]of hits)if(!trade.tpHits.includes(k)){
          trade.tpHits.push(k);milestoneChanged=true;
          await notifyTradeMilestone(env,trade,k,target);
        }
        if(trade.tpHits.includes("TP3")){event="TP3";eventPrice=trade.target3;eventCandleTime=candle.time;break}
      }
      const latest=recent[recent.length-1];
      if(latest){
        trade.lastPrice=Number(latest.close);
        trade.lastCheckedAt=new Date().toISOString();
        trade.lastCheckedCandleTime=Number(latest.time);
      }
      checked++;
      if(event){
        trade.closedAt=new Date().toISOString();trade.exitPrice=Number(eventPrice);
        trade.outcomeR=tradeResultR(trade,event==="STOP");
        trade.outcomePercent=tradeOutcomePercent(trade,eventPrice);
        trade.closeReason=event==="STOP"?"STOP_LOSS":"TP3";
        trade.status=event==="STOP"?"CLOSED_STOP":"CLOSED_TARGETS";
        trade.resolutionCandleTime=eventCandleTime;
      }
      // Cron checks run every five minutes. Persist only meaningful state
      // transitions (milestones/closures), not every routine price/checkpoint
      // refresh. The user-facing open-trades view may persist a fresh snapshot.
      const dirty=Boolean(event||milestoneChanged||(persistSnapshots&&(latest||checkpointChanged)));
      return{trade,closed:Boolean(event),dirty};
    }catch(error){
      console.error("Tracked futures trade refresh failed:",trade.symbol,String(error?.message||error));
      return{trade,closed:false,dirty:false};
    }
  });
  const closedIds=new Set();
  for(const x of results){
    const i=remaining.findIndex(t=>t.id===x.trade.id);
    if(i>=0){
      remaining[i]=x.trade;
      if(x.dirty){
        openListDirty=true;
        await updateIssuedSignal(env.APP_KV,x.trade.chatId,x.trade);
      }
      if(x.closed){
        closedIds.add(x.trade.id);closed.unshift(x.trade);closedCount++;closedListDirty=true;
      }
    }
  }
  if(openListDirty)await writeTradeList(env,FUTURES_OPEN_KEY,remaining.filter(t=>!closedIds.has(t.id)).slice(0,300));
  if(closedListDirty)await writeTradeList(env,FUTURES_CLOSED_KEY,closed.slice(0,500));
  for(const x of results.filter(v=>v.closed)){
    const t=x.trade,o=Number(t.outcomePercent),label=o>0?"سود":o<0?"ضرر":"سر‌به‌سر";
    await sendMessage(env,t.chatId,`📚 نتیجه سیگنال ${formatFuturesSymbol(t.symbol)}\n━━━━━━━━━━━━━━━━━━\nجهت: ${t.side==="LONG"?"LONG 🟢":"SHORT 🔴"}\nورود سیگنال: ${formatPrice(t.actualEntry)}\nخروج ثبت‌شده: ${formatPrice(t.exitPrice)}\nنتیجه: ${Number.isFinite(o)?formatOutcomePercent(o):"—"}\nR: ${Number.isFinite(t.outcomeR)?(t.outcomeR>=0?"+":"")+t.outcomeR.toFixed(2):"—"}\nTPهای لمس‌شده: ${t.tpHits.join(", ")||"هیچ‌کدام"}\nدلیل بسته‌شدن: ${t.closeReason==="STOP_LOSS"?"حد ضرر":"TP3"}`);
  }
  return{checked,closed:closedCount};
}
async function notifyTradeMilestone(env,trade,key,target){
  const p=leveragedPriceChangePercent(trade.side,trade.actualEntry,target);
  const labels={TP1:"🎯 تارگت اول",TP2:"🎯 تارگت دوم",TP3:"🎯 تارگت سوم"};
  const direction=trade.side==="LONG"?"🟢 لانگ / Long":"🔴 شورت / Short";
  const profit=p===null?"—":`${Math.abs(Number(p)).toFixed(2)}٪`;
  await sendMessage(env,trade.chatId,
    `${labels[key]||key} ${formatFuturesSymbol(trade.symbol)} لمس شد.\nجهت معامله: ${direction}\nقیمت تارگت: ${formatPrice(target)}\n🥳 درصد سود: ${profit}`);
}
async function handleTradeAction(action,chatId,env){const[,op]=action.split(":");if(op==="be")return sendMessage(env,chatId,"ℹ️ در نسخه جدید حد ضرر سیگنال خودکار جابه‌جا نمی‌شود؛ برای ارزیابی منصفانه حد ضرر اولیه ثابت می‌ماند.");if(op==="skip"||op==="enter")return sendMessage(env,chatId,"ℹ️ این نسخه هر سیگنال صادرشده را خودکار در دفتر ارزیابی ثبت می‌کند؛ ثبت دستی لازم نیست.")}
async function handleFillCommand(env,chatId,message){return sendMessage(env,chatId,"ℹ️ ثبت دستی معامله در نسخه جدید غیرفعال است؛ سیگنال‌های صادرشده خودکار در دفتر ارزیابی ثبت می‌شوند.")}
async function showIssuedSignalSymbols(env,chatId,view="archive"){
  if(!env.APP_KV)return sendMessage(env,chatId,"❌ حافظه دائمی در دسترس نیست.",BACK_MENU);
  const records=await listIssuedSignals(env.APP_KV,chatId,{status:view==="history"?undefined:undefined});
  const filtered=view==="history"?records.filter(x=>String(x.status||"").startsWith("CLOSED")):records;
  const symbols=issuedSignalSymbols(filtered);
  if(!symbols.length)return sendMessage(env,chatId,view==="history"?"📚 هنوز سیگنال تکمیل‌شده‌ای در تاریخچه ثبت نشده است.":"🗂 هنوز سیگنالی در آرشیو ثبت نشده است.",BACK_MENU);
  const keyboard=[];
  for(let i=0;i<symbols.length;i+=2)keyboard.push(symbols.slice(i,i+2).map(symbol=>({text:"🪙 "+formatFuturesSymbol(symbol),callback_data:`ledger:${view==="history"?"h":"a"}:${symbol}`})));
  keyboard.push([{text:"🏠 منوی اصلی",callback_data:"menu"}]);
  return sendMessage(env,chatId,view==="history"?"📚 تاریخچه معاملات — انتخاب نماد":"🗂 آرشیو سیگنال‌های صادرشده — انتخاب نماد", {inline_keyboard:keyboard});
}
async function showIssuedSignalDetails(env,chatId,selection,view){
  const [symbol,pageRaw]=String(selection||"").split(":");
  const page=Math.max(0,Number(pageRaw)||0);
  const records=await listIssuedSignals(env.APP_KV,chatId,{symbol});
  const filtered=view==="history"?records.filter(x=>String(x.status||"").startsWith("CLOSED")):records;
  const pageSize=8,totalPages=Math.max(1,Math.ceil(filtered.length/pageSize));
  const items=filtered.slice(page*pageSize,(page+1)*pageSize);
  if(!items.length)return sendMessage(env,chatId,"برای این نماد در این بخش موردی ثبت نشده است.",{inline_keyboard:[[{text:"⬅️ بازگشت به نمادها",callback_data:view==="history"?"ledger:history":"ledger:archive"}],[{text:"🏠 منوی اصلی",callback_data:"menu"}]]});
  const body=items.map(x=>{
    const d=new Date(x.publishedAt||x.createdAt);
    const date=d.toLocaleString("fa-IR",{timeZone:"Asia/Tehran"});
    const status=String(x.status||"OPEN").startsWith("CLOSED")?(x.closeReason==="STOP_LOSS"?"🛑 STOP / استاپ":x.closeReason==="TP3"?"🏁 FULL TARGET / فول تارگت":"بسته‌شده"):"🟢 باز";
    const milestones=(x.tpHits||[]).map(k=>({TP1:"TP1 / تارگت یک",TP2:"TP2 / تارگت دو",TP3:"TP3 / تارگت سه"}[k]||k));
    return `🪙 ${formatFuturesSymbol(x.symbol)} | ${x.side}\n🕒 ${date}\nوضعیت: ${status}\nورود: ${formatPrice(x.entry)} | استاپ: ${formatPrice(x.stop)}\nTP1: ${formatPrice(x.target1)} | TP2: ${formatPrice(x.target2)} | TP3: ${formatPrice(x.target3)}\nتارگت‌های لمس‌شده: ${milestones.join("، ")||"هیچ‌کدام"}${x.exitPrice!==null&&x.exitPrice!==undefined?"\nنتیجه: "+formatOutcomePercent(tradeOutcomePercent({...x,actualEntry:x.entry},x.exitPrice)):""}`;
  }).join("\n\n━━━━━━━━━━━━━━━━━━\n\n");
  const keyboard=[];
  const nav=[];
  if(page>0)nav.push({text:"⬅️ قبلی",callback_data:`ledger:${view==="history"?"h":"a"}:${symbol}:${page-1}`});
  if(page+1<totalPages)nav.push({text:"بعدی ➡️",callback_data:`ledger:${view==="history"?"h":"a"}:${symbol}:${page+1}`});
  if(nav.length)keyboard.push(nav);
  keyboard.push([{text:"⬅️ بازگشت به نمادها",callback_data:view==="history"?"ledger:history":"ledger:archive"}]);
  keyboard.push([{text:"🏠 منوی اصلی",callback_data:"menu"}]);
  const heading=view==="history"?"📚 تاریخچه تکمیل‌شده ":"🗂 آرشیو سیگنال‌های صادرشده ";
  return sendMessage(env,chatId,heading+formatFuturesSymbol(symbol)+` | صفحه ${page+1} از ${totalPages}\n━━━━━━━━━━━━━━━━━━\n`+body,{inline_keyboard:keyboard});
}
async function showOpenFuturesTrades(env,chatId){
  try{await refreshTrackedFuturesTrades(env,chatId)}catch(error){console.error("Open trade refresh failed:",String(error?.stack||error))}
  const list=(await readTradeList(env,FUTURES_OPEN_KEY)).filter(t=>String(t.chatId)===String(chatId));
  if(!list.length)return sendMessage(env,chatId,"📭 معامله بازی در دفتر پیگیری ثبت نشده است.",BACK_MENU);
  const body=list.slice(0,15).map(t=>{
    const p=leveragedPriceChangePercent(t.side,t.actualEntry,t.lastPrice);
    const label=t.tier==="EXPERIMENTAL"?"🟠 سیگنال پر ریسک":"🟢 سیگنال معتبر";
    const direction=t.side==="LONG"?"🟢 لانگ / Long":"🔴 شورت / Short";
    return `${label}\nنماد: ${formatFuturesSymbol(t.symbol)}\nجهت معامله: ${direction}\nورود: ${formatPrice(t.actualEntry)}\nقیمت فعلی: ${formatPrice(t.lastPrice)}\nدرصد سود/زیان فعلی: ${formatOutcomePercent(p)}\n\n🎯 تارگت اول: ${formatPrice(t.target1)}\n🎯 تارگت دوم: ${formatPrice(t.target2)}\n🎯 تارگت سوم: ${formatPrice(t.target3)}\n\n⛔ حد ضرر: ${formatPrice(t.currentStop)}\nتارگت‌های لمس‌شده: ${t.tpHits.join(", ")||"—"}`;
  }).join("\n\n━━━━━━━━━━━━━━━━━━\n\n");
  return sendLongMessage(env,chatId,"📌 معاملات باز / سیگنال‌های در حال ارزیابی\n━━━━━━━━━━━━━━━━━━\n\n"+body+"\n\n⚠️ این دفتر ارزیابی است؛ سفارش واقعی ثبت نمی‌شود.");
}
async function showFuturesTradeHistory(env,chatId){const list=(await readTradeList(env,FUTURES_CLOSED_KEY)).filter(t=>String(t.chatId)===String(chatId)).slice(0,50);if(!list.length)return sendMessage(env,chatId,"📚 هنوز معامله بسته‌شده‌ای ثبت نشده است.",BACK_MENU);const results=list.map(t=>{const computed=tradeOutcomePercent(t,t.exitPrice);return computed===null?Number(t.outcomePercent)||0:computed}),wins=results.filter(v=>v>0).length,losses=results.filter(v=>v<0).length,breakeven=list.length-wins-losses,winRate=list.length?wins/list.length*100:0,tp1=list.filter(t=>t.tpHits?.includes("TP1")).length,tp2=list.filter(t=>t.tpHits?.includes("TP2")).length,tp3=list.filter(t=>t.tpHits?.includes("TP3")).length,avg=results.reduce((s,v)=>s+v,0)/list.length,total=results.reduce((s,v)=>s+v,0);const summary=`📊 آمار عملکرد سیگنال‌ها\n━━━━━━━━━━━━━━━━━━\nکل سیگنال‌های بسته‌شده: ${list.length}\nبرد: ${wins} | باخت: ${losses} | سر‌به‌سر: ${breakeven}\n🏆 Win Rate: ${winRate.toFixed(1)}٪\n📈 میانگین نتیجه هر سیگنال: ${formatOutcomePercent(avg)}\n💰 مجموع نتیجه معاملات: ${formatOutcomePercent(total)}\n🎯 رسیدن به TP1: ${tp1} | TP2: ${tp2} | TP3: ${tp3}\n\n`;const body=list.slice(0,15).map((t,i)=>`${t.tier==="EXPERIMENTAL"?"🟠 سیگنال پر ریسک | ":"🟢 سیگنال معتبر | "}${formatFuturesSymbol(t.symbol)} | ${t.side}\nورود: ${formatPrice(t.actualEntry)} | خروج: ${formatPrice(t.exitPrice)}\nنتیجه: ${formatOutcomePercent(results[i])} | ${Number(t.outcomeR).toFixed(2)}R\nTPها: ${t.tpHits.join(", ")||"—"} | ${t.closeReason==="STOP_LOSS"?"استاپ":"TP3"}`).join("\n\n");return sendLongMessage(env,chatId,summary+"📚 تاریخچه معاملات\n━━━━━━━━━━━━━━━━━━\n"+body)}
async function runAutomaticFuturesAlertScan(env) {
  if (!env.SIGNAL_DELIVERY || !env.SIGNAL_DELIVERY_SECRET) {
    throw new Error("SIGNAL_DELIVERY and SIGNAL_DELIVERY_SECRET are required for scan coordination.");
  }
  const stub = env.SIGNAL_DELIVERY.get(env.SIGNAL_DELIVERY.idFromName("global:automatic-futures-scan-lock"));
  const headers = { "content-type": "application/json", "x-signal-delivery-secret": env.SIGNAL_DELIVERY_SECRET };
  const acquireResponse = await stub.fetch("https://signal-delivery.internal/scan-lock/acquire", { method: "POST", headers, body: "{}" });
  const acquire = await acquireResponse.json();
  if (!acquireResponse.ok || !acquire.ok) throw new Error(acquire.error || "Could not acquire automatic scan lock.");
  if (!acquire.acquired) return { skipped: true, reason: "scan already running" };
  try {
    const tracking = await refreshTrackedFuturesTrades(env);
    const result = await runFuturesSignalScan(env);
    return { scanned: true, signals: (result.signals || []).length, experimentalSignals: result.experimentalSent || 0, checkedTrades: tracking.checked, closedTrades: tracking.closed };
  } finally {
    const releaseResponse = await stub.fetch("https://signal-delivery.internal/scan-lock/release", { method: "POST", headers, body: "{}" });
    if (!releaseResponse.ok) console.error("Could not release automatic scan lock:", releaseResponse.status);
  }
}

async function filterActiveDuplicateFuturesSignals(env, candidates) {
  const now = Date.now();
  const [pending, open] = await Promise.all([
    readTradeList(env, FUTURES_PENDING_KEY),
    readTradeList(env, FUTURES_OPEN_KEY)
  ]);
  const activeKeys = new Set();

  // A pending signal blocks another signal for the same contract and direction
  // until its entry window expires, regardless of the candle fingerprint.
  for (const signal of pending) {
    if (signal?.expiresAt > now && signal?.symbol && ['LONG', 'SHORT'].includes(signal?.side)) {
      activeKeys.add(String(signal.symbol).trim().toUpperCase() + '|' + signal.side);
    }
  }

  // An accepted/open paper trade continues to block repeats even after
  // the original signal's entry window has expired.
  for (const trade of open) {
    if (trade?.tier !== "EXPERIMENTAL" && trade?.status === 'OPEN' && trade?.symbol && ['LONG', 'SHORT'].includes(trade?.side)) {
      activeKeys.add(String(trade.symbol).trim().toUpperCase() + '|' + trade.side);
    }
  }

  const seenThisScan = new Set();
  return (Array.isArray(candidates) ? candidates : []).filter(signal => {
    if (!signal?.symbol || !['LONG', 'SHORT'].includes(signal?.side)) return false;
    const key = String(signal.symbol).trim().toUpperCase() + '|' + signal.side;
    if (activeKeys.has(key) || seenThisScan.has(key)) return false;
    seenThisScan.add(key);
    return true;
  });
}

async function runFuturesSignalScan(env, options = {}) {
  const started = Date.now();
  const universe = await getKrakenFuturesUniverse();
  if (!universe.length) {
    return { report: "⚠️ در Kraken قرارداد دائمی با حجم کافی پیدا نشد.", signals: [] };
  }
  const analyzed = await mapLimit(universe, FUTURES_CONFIG.CONCURRENCY, async ticker => {
    try {
      const [oneHour, fourHour] = await Promise.all([
        getKrakenFuturesCandles(ticker.symbol, FUTURES_CONFIG.INTERVAL),
        getKrakenFuturesCandles(ticker.symbol, FUTURES_CONFIG.CONFIRM_INTERVAL)
      ]);
      return analyzeFuturesSymbol(ticker, oneHour, fourHour);
    } catch (error) {
      return { symbol: ticker.symbol, rejected: error.message || "خطای تحلیل" };
    }
  });
  const createdAt = Date.now();
  const eligibleCandidates = analyzed.filter(x => x?.eligible).sort((a, b) => b.score - a.score);
  const experimentalCandidates = analyzed.filter(x => x?.experimentalEligible)
    .sort((a, b) => b.score - a.score).slice(0, 3);
  const nonDuplicateCandidates = await filterActiveDuplicateFuturesSignals(env, eligibleCandidates);
  const generatedSignals = nonDuplicateCandidates.slice(0, 8)
    .map(x => ({ ...x, id: crypto.randomUUID(), createdAt, expiresAt: createdAt + FUTURES_CONFIG.SIGNAL_TTL_MINUTES * 60000, status: "PENDING" }));
  const signals = await savePendingFuturesSignals(env, generatedSignals);

  // Experimental candidates are delivered only to the owner, clearly labelled,
  // and rate-limited per symbol/direction. They never enter the production signal queue.
  const ownerId = env.OWNER_TELEGRAM_ID || env.OWNER_ID;
  let experimentalSent = 0;
  if (env.APP_KV && ownerId) {
    for (const candidate of experimentalCandidates) {
      const key = `futures:experimental:sent:${candidate.symbol}:${candidate.side}`;
      if (await env.APP_KV.get(key)) continue;
      const signal = {
        ...candidate, id: crypto.randomUUID(), tier: "EXPERIMENTAL",
        createdAt: Date.now(), expiresAt: Date.now() + 60 * 60 * 1000
      };
      try {
        await sendAndArchiveFuturesSignal(env, ownerId, signal, formatExperimentalFuturesSignal(signal));
        await env.APP_KV.put(key, "sent", { expirationTtl: 3600 });
        experimentalSent++;
      } catch (error) {
        console.error("Experimental futures alert failed:", signal.symbol, String(error?.message || error));
      }
    }
  }

  if (env.APP_KV) {
    try {
      await deliverFuturesSignalAlerts(env, signals, options.excludeChatId ?? null);
    } catch (error) {
      console.error("Immediate futures alert dispatch failed:", String(error?.stack || error?.message || error));
    }
  }
  const validData = analyzed.filter(x => x && x.score !== undefined).length;
  const rejected = analyzed.filter(x => x?.rejected).slice(0, 8);
  let report = `📈 CRYPTO PUMP HUNTER V${CONFIG.VERSION} — KRAKEN FUTURES\n` +
    "━━━━━━━━━━━━━━━━━━\n" +
    "🏦 بازار: Kraken Derivatives Perpetual\n" +
    "⏱ تایم‌فریم: 1h با تأیید روند 4h\n" +
    `📥 نمادهای پرحجم بررسی‌شده: ${universe.length}\n` +
    `📊 تحلیل‌های معتبر: ${validData}\n` +
    `⭐ سیگنال‌های واجد شرایط: ${signals.length}\n\n`;
  if (signals.length) {
    report += "🎯 سیگنال‌های فعلی\n━━━━━━━━━━━━━━━━━━\n\n";
    for (const item of signals) report += formatFuturesSignal(item) + "\n━━━━━━━━━━━━━━━━━━\n\n";
  } else {
    report += "⚠️ در این بررسی سیگنالی به حداقل امتیاز و شرایط ورود نرسید. برای جلوگیری از سیگنال ضعیف، موردی صادر نشد.\n\n";
  }
  if (rejected.length) {
    report += "🧪 نمونه دلایل رد نمادها\n";
    for (const item of rejected) report += `• ${item.symbol}: ${item.rejected}\n`;
  }
  report += `\n🕒 زمان تهیه گزارش: ${new Date().toISOString()}\n` +
    `⏱ مدت بررسی: ${Math.round((Date.now() - started) / 1000)} ثانیه\n` +
    "📡 منبع داده: API عمومی Kraken Derivatives Futures\n" +
    "⚠️ سیگنال‌ها تحلیلی‌اند؛ سفارش واقعی ثبت نمی‌شود و سود تضمین نیست. قیمت ممکن است پس از بسته‌شدن کندل تغییر کند.";

  if (env.APP_KV) {
    try {
      await env.APP_KV.put("last_futures_scan", JSON.stringify({
        version: "3.8.2-engine",
        timestamp: Date.now(),
        report,
        signals: signals.map(x => ({
          symbol: x.symbol, side: x.side, score: x.score, entry: x.entry,
          stop: x.stop, target1: x.target1, target2: x.target2, target3: x.target3
        }))
      }));
    } catch (error) {
      report += `\n⚠️ ذخیره گزارش فیوچرز ناموفق بود: ${String(error.message || "KV error")}`;
    }
  }
  return { report, signals, experimentalSent };
}

function formatExperimentalFuturesSignal(item) {
  return formatFuturesSignal({ ...item, tier: "EXPERIMENTAL" }) +
    "\n\n⚠️ این سیگنال فقط برای ارزیابی آزمایشی است؛ برای معامله واقعی استفاده نکن.";
}

async function runFuturesSignalsForChat(env, chatId) {
  if (!(await isApproved(chatId, env))) {
    await sendMessage(env, chatId, "⛔ دسترسی شما فعال نیست.");
    return;
  }
  try {
    const result = await runFuturesSignalScan(env, { excludeChatId: chatId });
    const signals = result.signals || [];
    if (!signals.length) {
      await sendMessage(env, chatId, "در حال حاضر سیگنال معتبری وجود ندارد.", menuForChat(env, chatId));
      return;
    }
    for (let i = 0; i < signals.length; i++) {
      const signal = signals[i];
      await sendAndArchiveFuturesSignal(env, chatId, signal, formatFuturesSignal(signal, i + 1));
    }
  } catch (error) {
    const diagnostic = String(error?.stack || error?.message || error).slice(0, 1800);
    console.error("Manual futures scan failed:", diagnostic);
    // Keep the normal user-facing message concise; expose the exact failure only to the configured owner.
    if (String(chatId) === String((env.OWNER_TELEGRAM_ID || env.OWNER_ID))) {
      try {
        await sendMessage(env, chatId, "🧪 خطای فنی اسکن فیوچرز (فقط مدیر):\n" + diagnostic);
      } catch (diagnosticError) {
        console.error("Could not deliver futures scan diagnostic:", String(diagnosticError?.message || diagnosticError));
      }
    }
    await sendMessage(env, chatId, "⚠️ در حال حاضر دریافت سیگنال ممکن نیست. لطفاً کمی بعد دوباره تلاش کن.", menuForChat(env, chatId));
  }
}


async function refreshOpenFuturesTrades(env,chatId,tickers) {
  const open=await readTradeList(env,FUTURES_OPEN_KEY);if(!open.length)return;
  const prices=new Map((tickers||[]).map(t=>[`${t.exchange || "Kraken"}:${t.symbol}`,Number(t.last)]));
  const closed=await readTradeList(env,FUTURES_CLOSED_KEY),remaining=[];
  for(const t of open) {
    if(String(t.chatId)!==String(chatId)){remaining.push(t);continue;}
    const price=prices.get(`${t.exchange || "Kraken"}:${t.symbol}`);if(!Number.isFinite(price)||price<=0){remaining.push(t);continue;}
    t.lastPrice=price;t.lastCheckedAt=new Date().toISOString();
    if(stopReached(t.side,price,t.currentStop)) {
      t.status="CLOSED_STOP";t.closedAt=new Date().toISOString();t.exitPrice=price;t.outcomeR=tradeResultR(t,true);t.outcomePercent=tradeOutcomePercent(t,price);t.closeReason="STOP_LOSS";
      closed.unshift(t);
      await updateIssuedSignal(env.APP_KV,t.chatId,t);
      await sendMessage(env,chatId,`🛑 ${formatFuturesSymbol(t.symbol)} به حد ضرر فعلی رسید 😞.\nنتیجه: ${formatOutcomePercent(t.outcomePercent)}\n\nبزودی سیگنال جبرانی صادر خواهد شد.`);
      continue;
    }
    const favorableR=tradeDir(t.side)*(price-t.actualEntry)/t.initialRisk;
    if(favorableR>=0.75&&!t.protectionAlerted&&!t.breakEvenConfirmed) {
      t.protectionAlerted=true;
      await sendMessage(env,chatId,`🛡️ قیمت ${formatFuturesSymbol(t.symbol)} به +0.75R رسیده؛ یعنی نصف مسیر تارگت اول. برای جلوگیری از تبدیل سود شناور به زیان، انتقال حد ضرر باقی‌مانده به نقطه ورود را بررسی کن. اگر واقعاً در صرافی انجامش دادی، تأیید کن.`,
        {inline_keyboard:[[{text:"✅ حد ضرر را به ورود منتقل کردم",callback_data:`trade:be:${t.id}`}]]});
    }
    const levels=[["TP1",t.target1],["TP2",t.target2],["TP3",t.target3]],hits=[];
    for(const [key,target] of levels)if(!t.tpHits.includes(key)&&targetReached(t.side,price,target)){t.tpHits.push(key);hits.push(key);}
    for(const hit of hits) {
      const target=hit==="TP1"?t.target1:hit==="TP2"?t.target2:t.target3;
      await notifyTradeMilestone(env,t,hit,target);
    }
    if(t.tpHits.includes("TP3")) {
      t.status="CLOSED_TARGETS";t.closedAt=new Date().toISOString();t.exitPrice=price;t.outcomeR=tradeResultR(t,false);t.outcomePercent=tradeOutcomePercent(t,price);t.closeReason="TP3";
      closed.unshift(t);await updateIssuedSignal(env.APP_KV,t.chatId,t);await sendMessage(env,chatId,`🏁 هر سه تارگت ${formatFuturesSymbol(t.symbol)} لمس شد. نتیجه: ${formatOutcomePercent(t.outcomePercent)} | نتیجه بر اساس ریسک: ${t.outcomeR.toFixed(2)}R.`);continue;
    }
    await updateIssuedSignal(env.APP_KV,t.chatId,t);
    remaining.push(t);
  }
  await writeTradeList(env,FUTURES_OPEN_KEY,remaining);
  await writeTradeList(env,FUTURES_CLOSED_KEY,closed.slice(0,300));
}

async function deliverFuturesSignalAlerts(env, signals, excludeChatId = null) {
  if (!env.APP_KV) throw new Error("APP_KV binding is required for automatic alerts.");
  const queueKey = "futures:auto-alerts:pending-broadcasts";
  let queue = await env.APP_KV.get(queueKey, "json") || [];
  if (!Array.isArray(queue)) queue = [];
  const queuedFingerprints = new Set(queue.map(item => item.fingerprint));
  const fresh = selectUnnotifiedFuturesSignals(signals || [], queuedFingerprints);
  queue = [...queue, ...fresh.map(item => ({ ...item, queuedAt: Date.now() }))].slice(-100);
  if (queue.length && JSON.stringify(queue)!==JSON.stringify(await env.APP_KV.get(queueKey,"json")||[])) {
    await env.APP_KV.put(queueKey, JSON.stringify(queue), { expirationTtl: 86400 });
  }
  if (!queue.length) return { newSignals: 0, recipients: 0, delivered: 0, failed: 0 };

  await migrateLegacyMembership(env);
  const recipients = new Set();
  if (env.OWNER_TELEGRAM_ID || env.OWNER_ID) recipients.add(String(env.OWNER_TELEGRAM_ID || env.OWNER_ID));
  let cursor;
  do {
    const page = await env.APP_KV.list({ prefix: "member:", limit: 1000, ...(cursor ? { cursor } : {}) });
    for (const item of page.keys || []) {
      const chatId = item.name.slice("member:".length);
      const member = await env.APP_KV.get(item.name, "json");
      if (member && member.approved !== false && member.revoked !== true) recipients.add(String(chatId));
    }
    cursor = page.list_complete === false ? page.cursor : null;
  } while (cursor);

  let delivered = 0, failed = 0;
  await mapLimit([...recipients].filter(id => excludeChatId == null || String(id) !== String(excludeChatId)), 4, async chatId => {
    const pending = [];
    for (const item of queue) {
      const key = futuresAlertStorageKey(chatId, item.fingerprint);
      if (!(await env.APP_KV.get(key))) pending.push({ ...item, key });
    }
    if (!pending.length) return;
    try {
      for (let i = 0; i < pending.length; i++) {
        const item = pending[i];
        await sendAndArchiveFuturesSignal(env, chatId, item.signal, formatFuturesSignalAlert(item.signal, i + 1));
        await env.APP_KV.put(item.key, "sent", { expirationTtl: ALERT_TTL_SECONDS });
      }
      delivered++;
    } catch (error) {
      failed++;
      console.error("Immediate futures alert delivery failed", chatId, String(error?.message || error));
    }
  });
  if (failed === 0 && recipients.size > 0) await env.APP_KV.delete(queueKey);
  return { newSignals: fresh.length, queuedSignals: queue.length, recipients: recipients.size, delivered, failed };
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


// Named exports expose pure strategy functions to Node's offline test suite.
// They do not add HTTP routes or enable order execution.
export { FUTURES_CONFIG, FUTURES_PROVIDER_ORDER, isKrakenPerpetualTicker, normalizeKrakenFuturesUnderlying, getKrakenFuturesUniverse, getKrakenFuturesCandles, calculateAtr, analyzeFuturesSymbol, getFuturesUniverse, getFuturesCandles, tradeResultR, priceChangePercent, tradeOutcomePercent, targetReached, stopReached, getNewClosedFuturesCandles, ensureTradeTrackingCheckpoint, isValidFuturesSignalLevels };
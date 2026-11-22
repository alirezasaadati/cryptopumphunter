import { runSpotScan } from "./spot-engine.js";
import { futuresSignalFingerprint, selectUnnotifiedFuturesSignals, futuresAlertStorageKey, formatFuturesSignalAlert, ALERT_TTL_SECONDS } from "./futures-alerts.js";
import { signalOutboxKey, signalOutboxAction } from "./signal-outbox.js";
import { createSerialExecutor } from "./serial-executor.js";
import { evaluateTradeCandle } from "./futures-trade-lifecycle.js";

const CONFIG = {
  VERSION: "10.6.0",
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
      { text: "🗂 سیگنال‌های صادرشده", callback_data: "issued_signals" }
    ],
    [{ text: "🛡️ راهنمای مدیریت سرمایه", callback_data: "capital_guide" }],
    [{ text: "📡 وضعیت ربات", callback_data: "status" }],
    [
      { text: "🔌 تست اتصال", callback_data: "test" }
    ],
    [
      { text: "🔍 پایش معاملات کاربران", callback_data: "invite" }
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

      if(update.chat_join_request){
        ctx.waitUntil(handleArchiveJoinRequest(update.chat_join_request,env));
        return new Response("OK");
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

  // Protect messages for regular users, while allowing the owner to copy
  // their own bot messages. Archive-channel posts remain protected.
  const protectedBody = method === "sendMessage" && !isOwner(body.chat_id, env)
    ? { ...body, protect_content: true }
    : body;

  const response = await fetch(
    `${TELEGRAM_API}/bot${(env.TELEGRAM_BOT_TOKEN || env.BOT_TOKEN)}/${method}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(protectedBody)
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
    const member = await env.APP_KV.get(memberKey(chatId), "json");
    if (member) return Boolean(member.approved !== false && member.revoked !== true);
    const legacy = await env.APP_KV.get("v1:members", "json") || {};
    return legacy[String(chatId)]?.status === "active";
  } catch (error) {
    console.error("Read-only membership check failed:", String(error?.message || error));
    return false;
  }
}
function archiveChannelId(env) {
  const id = String(env.SIGNAL_ARCHIVE_CHANNEL_ID || "").trim();
  return /^-100\d+$/.test(id) ? id : null;
}
async function sendArchiveAccessLink(env, userId) {
  const channelId = archiveChannelId(env);
  if (!channelId) return sendMessage(env,userId,"⚠️ اتصال آرشیو هنوز کامل تنظیم نشده است.",BACK_MENU);
  if (!(await isApproved(userId,env))) return sendMessage(env,userId,"⛔ دسترسی شما به آرشیو فعال نیست.",BACK_MENU);
  try {
    const key="signal-archive:join-request-link";
    let link=null;
    // KV is only a cache here: a temporary KV read/write failure must not
    // prevent Telegram from creating and delivering a valid invite link.
    if(env.APP_KV){
      try { link=await env.APP_KV.get(key); }
      catch(error){ console.error("Archive invite cache read failed:",String(error?.message||error)); }
    }
    if(!link){
      const result=await telegram("createChatInviteLink",env,{chat_id:channelId,name:"Crypto Pump Hunter members",creates_join_request:true});
      link=result?.result?.invite_link;
      if(!link)throw new Error("Telegram did not return invite link");
      if(env.APP_KV){
        try { await env.APP_KV.put(key,link); }
        catch(error){ console.error("Archive invite cache write failed:",String(error?.message||error)); }
      }
    }
    await sendMessage(env,userId,"📚 برای مشاهده آرشیو سیگنال‌ها از لینک زیر وارد کانال شو.\nدرخواست ورودت بر اساس عضویت ربات بررسی می‌شود.\n\n"+link,BACK_MENU);
  } catch(error) {
    console.error("Archive invite link failed:",String(error?.message||error));
    await sendMessage(env,userId,"⚠️ ساخت لینک ورود به آرشیو فعلاً ممکن نشد.",BACK_MENU);
  }
}
async function handleArchiveJoinRequest(request,env) {
  const channelId=archiveChannelId(env);
  if(!channelId||String(request?.chat?.id)!==channelId)return false;
  const userId=request?.from?.id;if(!userId)return true;
  try {
    if(await isApproved(userId,env)){
      await telegram("approveChatJoinRequest",env,{chat_id:channelId,user_id:userId});
      await sendMessage(env,userId,"✅ درخواست ورود به کانال آرشیو تأیید شد.");
    } else {
      await telegram("declineChatJoinRequest",env,{chat_id:channelId,user_id:userId});
      await sendMessage(env,userId,"⛔ فقط اعضای تأییدشده ربات می‌توانند وارد آرشیو شوند.");
    }
  } catch(error){console.error("Archive join request failed:",String(error?.message||error));}
  return true;
}
async function removeArchiveMember(env,userId) {
  const channelId=archiveChannelId(env);
  if(!channelId||!userId||isOwner(userId,env)) {
    return {ok:false,error:"شناسه کانال آرشیو یا شناسه عضو معتبر نیست."};
  }
  try {
    await telegram("banChatMember",env,{chat_id:channelId,user_id:Number(userId),revoke_messages:false});
    return {ok:true};
  } catch(error) {
    const message=String(error?.message||error);
    console.error("Archive removal failed:",message);
    return {ok:false,error:message};
  }
}
async function restoreArchiveMemberEligibility(env,userId) {
  const channelId=archiveChannelId(env);
  if(!channelId||!userId||isOwner(userId,env)) {
    return {ok:false,error:"شناسه کانال آرشیو یا شناسه عضو معتبر نیست."};
  }
  try {
    await telegram("unbanChatMember",env,{chat_id:channelId,user_id:Number(userId),only_if_banned:true});
    return {ok:true};
  } catch(error) {
    const message=String(error?.message||error);
    console.error("Archive unban failed:",message);
    return {ok:false,error:message};
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
      await restoreArchiveMemberEligibility(env, applicantId);

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
      await restoreArchiveMemberEligibility(env,targetId);
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
      await removeArchiveMember(env,targetId);
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
  let m;
  try {
    m=await env.APP_KV.get(memberKey(id),"json");
  } catch(error) {
    const message=String(error?.message||error);
    console.error("Member access lookup failed:",message);
    await sendMessage(env,ownerId,"❌ اطلاعات عضو از KV خوانده نشد؛ هیچ تغییری اعمال نشد.\nعلت: "+message.slice(0,500));
    return;
  }
  if(!m){await sendMessage(env,ownerId,"عضو پیدا نشد.");return;}
  const next=allow?{...m,approved:true,revoked:false,allowedAt:new Date().toISOString(),allowedBy:String(ownerId)}:{...m,approved:false,revoked:true,revokedAt:new Date().toISOString(),revokedBy:String(ownerId)};
  try {
    await env.APP_KV.put(memberKey(id),JSON.stringify(next));
  } catch(error) {
    const message=String(error?.message||error);
    console.error("Member access KV write failed:",message);
    await sendMessage(env,ownerId,"❌ تغییر دسترسی ذخیره نشد؛ هیچ تغییری در وضعیت عضو تأیید نمی‌شود.\nعلت: "+message.slice(0,500));
    return;
  }
  const archiveResult=allow
    ? await restoreArchiveMemberEligibility(env,id)
    : await removeArchiveMember(env,id);
  try {
    await sendMessage(env,id,allow?"🎉 دسترسی شما دوباره فعال شد.":"⛔ دسترسی شما توسط مدیر لغو شد.");
  } catch(error) {
    console.warn("Member access notification failed:",String(error?.message||error));
  }
  if(!archiveResult?.ok) {
    await sendMessage(env,ownerId,
      "⚠️ وضعیت دسترسی در ربات ذخیره شد، اما تغییر دسترسی کانال آرشیو ناموفق بود.\n"+
      "علت: "+String(archiveResult?.error||"خطای نامشخص").slice(0,500));
  } else {
    await sendMessage(env,ownerId,allow
      ?"✅ دسترسی عضو در ربات فعال شد و محدودیت کانال آرشیو برداشته شد."
      :"✅ دسترسی عضو در ربات لغو شد و عضویت او در کانال آرشیو مسدود شد.");
  }
  await showMemberProfile(env,ownerId,id);
}

// ---------------- MAIN MENU ----------------
function menuForChat(env, chatId) {
  const keyboard = MAIN_MENU.inline_keyboard.map(row => row.slice());
  if (isOwner(chatId, env)) keyboard.splice(keyboard.length - 1, 0,
    [{ text: "👥 مدیریت اعضا", callback_data: "members:0" }],
    [{ text: "📊 گزارش سیگنال‌های اخیر", callback_data: "admin:signals" }],
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
      action.startsWith("mrev:") || action.startsWith("mall:") || action.startsWith("outbox:") || action.startsWith("admin:")) {
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
      else if(action==="admin:signals") await showRecentFuturesSignalReport(env,chatId);
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
        "میتوانید از لینک زیر جهت ثبت نام در صرافی البانک\n" +
        "( برای بررسی دقیق علل سود و زیان هر کاربر ) اقدام کنید .\n\n" +
        "🔗 لینک : https://www.lbk.pub/ref/67XF8", BACK_MENU);
      return;
    }
    if (action === "futures") {
      await runFuturesSignalsForChat(env, chatId);
      return;
    }
    if (action === "issued_signals" || action === "ledger:archive" || action === "ledger:history") return sendArchiveAccessLink(env,chatId);
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
      allowed_updates: ["message", "callback_query", "chat_join_request"],
      max_connections: 5
    };

    body.secret_token = (env.TELEGRAM_WEBHOOK_SECRET || env.WEBHOOK_SECRET);

    const result = await telegram("setWebhook", env, body);

    return json({
      ok: true,
      result: result.result,
      description: result.description || "Webhook registered",
      allowed_updates: ["message", "callback_query", "chat_join_request"]
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
  if (!Array.isArray(values) || !Number.isInteger(period) || period <= 0 ||
      values.length <= period || !values.every(Number.isFinite)) return null;

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
  if (avgGain === 0 && avgLoss === 0) return 50;
  if (avgLoss === 0) return 100;
  if (avgGain === 0) return 0;
  const result = 100 - 100 / (1 + avgGain / avgLoss);
  return Number.isFinite(result) ? result : null;
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
  CONCURRENCY: 3,
  MAX_SCAN_DURATION_MS: 180000,
  SCAN_FINALIZATION_RESERVE_MS: 45000,
  REQUEST_TIMEOUT_MS: 12000,
  MAX_SIGNALS_PER_SCAN: 10,
  MIN_QUOTE_VOLUME: 5_000_000,
  KLINE_LIMIT: 120,
  MIN_CANDLES: 100,
  TARGET_1_R: 1.5,
  STOP_BUFFER_ATR: 0.2,
  MAX_RISK_PCT: 2.0,
  MIN_RISK_PCT: 0.5,
  MAX_ATR_PCT: 2.0,
  INTERVAL: "1h",
  SIGNAL_TTL_MINUTES: 60
};

const FUTURES_PROVIDER_ORDER = ["Kraken"];

async function krakenFuturesJson(path, label, baseUrl = FUTURES_CONFIG.BASE_URL) {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(FUTURES_CONFIG.REQUEST_TIMEOUT_MS)
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
    .map(t => ({
      ...t,
      priceChangePercent: Number(t.change24h) || 0,
      quoteVolume: Number(t.volumeQuote) || 0,
      premium: { lastFundingRate: Number(t.fundingRate) }
    }));
}

async function getKrakenFuturesCandles(symbol, interval) {
  const url = `${FUTURES_CONFIG.CHARTS_URL}/trade/${encodeURIComponent(symbol)}/${encodeURIComponent(interval)}?count=${FUTURES_CONFIG.KLINE_LIMIT}`;
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

function evaluateFuturesEntryFilters({ ticker, candles1h, candles15m, side, referencePrice, ema20, atr }) {
  const marketPrice = Number(ticker?.last);
  if (!Number.isFinite(marketPrice) || marketPrice <= 0) {
    return { ok: false, rejected: "قیمت لحظه‌ای بازار معتبر نیست" };
  }
  const driftPct = Math.abs(marketPrice - referencePrice) / referencePrice * 100;
  if (driftPct > FUTURES_CONFIG.MAX_ENTRY_DRIFT_PCT) {
    return { ok: false, rejected: "فاصله قیمت لحظه‌ای تا قیمت تحلیلی بیش از حد مجاز است", driftPct };
  }

  const emaDistanceAtr = Math.abs(marketPrice - ema20) / atr;
  if (emaDistanceAtr > FUTURES_CONFIG.MAX_ENTRY_EMA_DISTANCE_ATR) {
    return { ok: false, rejected: "ورود دیرهنگام است؛ قیمت بیش از حد از EMA20 فاصله دارد", driftPct, emaDistanceAtr };
  }

  const has15mData = Array.isArray(candles15m) && candles15m.length >= 30;
  if (!has15mData) {
    return { ok: true, driftPct, emaDistanceAtr, momentumConfirmed: false, pullbackConfirmed: false, confirmationUnavailable: true };
  }
  const closes15m = candles15m.map(c => c.close);
  const ema9_15m = ema(closes15m, 9);
  const ema21_15m = ema(closes15m, 21);
  const atr15m = calculateAtr(candles15m, 14);
  const last15m = candles15m[candles15m.length - 1];
  const recentPullback = candles15m.slice(-9, -1);
  if (![ema9_15m, ema21_15m, atr15m].every(Number.isFinite) || atr15m <= 0 || !recentPullback.length) {
    return { ok: true, driftPct, emaDistanceAtr, momentumConfirmed: false, pullbackConfirmed: false, confirmationUnavailable: true };
  }

  const aligned = side === "LONG"
    ? ema9_15m > ema21_15m && last15m.close > ema9_15m && last15m.close > last15m.open
    : ema9_15m < ema21_15m && last15m.close < ema9_15m && last15m.close < last15m.open;
  const touchedPullbackZone = side === "LONG"
    ? recentPullback.some(c => c.low <= ema21_15m + atr15m * FUTURES_CONFIG.MAX_PULLBACK_DISTANCE_ATR)
    : recentPullback.some(c => c.high >= ema21_15m - atr15m * FUTURES_CONFIG.MAX_PULLBACK_DISTANCE_ATR);

  const reclaimExtensionAtr = side === "LONG"
    ? (last15m.close - ema9_15m) / atr15m
    : (ema9_15m - last15m.close) / atr15m;
  if (reclaimExtensionAtr > FUTURES_CONFIG.MAX_RECLAIM_EXTENSION_ATR) {
    return { ok: false, rejected: "قیمت پس از حرکت تأییدی بیش از حد از محدوده ورود فاصله گرفته است", driftPct, emaDistanceAtr, reclaimExtensionAtr };
  }

  return { ok: true, driftPct, emaDistanceAtr, reclaimExtensionAtr, ema9_15m, ema21_15m, atr15m,
    momentumConfirmed: aligned, pullbackConfirmed: touchedPullbackZone };
}

function findLatestConfirmed15mPivot(candles, side, left = 3, right = 3) {
  if (!Array.isArray(candles) || candles.length < left + right + 1) return null;
  const field = side === "LONG" ? "high" : "low";
  for (let i = candles.length - right - 1; i >= left; i--) {
    const value = Number(candles[i]?.[field]);
    if (!Number.isFinite(value)) continue;
    let pivot = true;
    for (let j = i - left; j <= i + right; j++) {
      if (j === i) continue;
      const neighbor = Number(candles[j]?.[field]);
      if (!Number.isFinite(neighbor) || (side === "LONG" ? neighbor >= value : neighbor <= value)) {
        pivot = false;
        break;
      }
    }
    if (pivot) return { index: i, time: candles[i].time, price: value, type: side === "LONG" ? "swing_high" : "swing_low" };
  }
  return null;
}

function passesLongDistanceThreshold(side, candles1h, threshold = 0.005) {
  // Keep SHORT behavior unchanged. LONG uses the signal candle close versus
  // the maximum High of the last three completed 1h candles, matching backtests.
  if (side !== "LONG") return true;
  if (!Array.isArray(candles1h) || candles1h.length < 3) return false;
  const last3 = candles1h.slice(-3);
  const referencePrice = Number(last3[2]?.close);
  const maxHigh = Math.max(...last3.map(c => Number(c?.high)));
  if (!Number.isFinite(referencePrice) || !Number.isFinite(maxHigh) || maxHigh <= 0) return false;
  const distance = Math.abs(referencePrice - maxHigh) / maxHigh;
  return Number.isFinite(distance) && distance >= threshold;
}

function analyzeFuturesSymbol(ticker, candles1h, _candles4h = [], _candles15m = [], options = {}) {
  const symbol = ticker?.symbol || "UNKNOWN";
  if (!Array.isArray(candles1h) || candles1h.length < FUTURES_CONFIG.MIN_CANDLES) {
    throw new Error("کندل ۱ ساعته کافی نیست.");
  }
  if (!candles1h.every(c =>
    c && [c.time,c.open,c.high,c.low,c.close].every(v => Number.isFinite(Number(v))) &&
    Number(c.open)>0 && Number(c.low)>0 && Number(c.close)>0 &&
    Number(c.high)>=Math.max(Number(c.open),Number(c.close),Number(c.low)) &&
    Number(c.low)<=Math.min(Number(c.open),Number(c.close))
  )) {
    throw new Error("داده کندل نامعتبر است.");
  }

  const last = candles1h[candles1h.length - 1];
  const prev = candles1h[candles1h.length - 2];
  const closes = candles1h.map(c => Number(c.close));
  const e20 = ema(closes, 20);
  const e50 = ema(closes, 50);
  const rsiValue = rsi(closes, 14);
  const atr = calculateAtr(candles1h, 14);
  if (![e20,e50,rsiValue,atr].every(Number.isFinite) || atr <= 0) {
    throw new Error("اندیکاتورها نامعتبرند.");
  }

  const atrPct = (atr / last.close) * 100;
  if (!Number.isFinite(atrPct)) throw new Error("محاسبه ATR درصدی نامعتبر است.");

  let mode = null;
  let stopPrice = null;
  const distanceToE20 = ((last.close - e20) / e20) * 100;

  // Diagnostic-only condition flags. These mirror the existing entry rules exactly.
  const trendConditions = {
    closeBelowEma50: last.close < e50,
    ema20BelowEma50: e20 < e50,
    rsiBelow40: rsiValue < 40,
    atLeastHalfPercentBelowEma20: distanceToE20 < -0.5
  };
  const isDowntrend = Object.values(trendConditions).every(Boolean);

  const rallyBaseConditions = {
    closeAboveEma50: last.close > e50,
    rsiAbove75: rsiValue > 75
  };
  const isRedCandle = last.close < last.open;
  const bodySize = last.open - last.close;
  const candleRange = last.high - last.low;
  const bodyToRangeRatio = candleRange > 0 ? bodySize / candleRange : 0;
  const rallyCandleConditions = {
    redCandle: isRedCandle,
    currentHighAbovePreviousHigh: last.high > prev.high,
    bodyExceedsHalfCandleRange: candleRange > 0 && bodyToRangeRatio > 0.5
  };
  const entryConditionDiagnostics = {
    close: last.close,
    ema20: e20,
    ema50: e50,
    rsi14: rsiValue,
    distanceToEma20Pct: distanceToE20,
    atrPct,
    trendShort: trendConditions,
    rallyFade: { ...rallyBaseConditions, ...rallyCandleConditions, bodyToRangeRatio }
  };

  if (atrPct > FUTURES_CONFIG.MAX_ATR_PCT) {
    return {
      symbol,
      rejected: `نوسان (ATR) بیش از حد بالاست (${atrPct.toFixed(2)}%).`,
      diagnosticStage: "ATR_FILTER",
      diagnosticDetails: { atrPct, maxAtrPct: FUTURES_CONFIG.MAX_ATR_PCT },
      entryConditionDiagnostics
    };
  }

  if (isDowntrend) {
    mode = "TREND_SHORT";
    const recentHighs = candles1h.slice(-7).map(c => Number(c.high));
    stopPrice = Math.max(...recentHighs) + atr * FUTURES_CONFIG.STOP_BUFFER_ATR;
  } else if (rallyBaseConditions.closeAboveEma50 && rallyBaseConditions.rsiAbove75) {
    if (rallyCandleConditions.redCandle &&
        rallyCandleConditions.currentHighAbovePreviousHigh &&
        rallyCandleConditions.bodyExceedsHalfCandleRange) {
      mode = "RALLY_FADE";
      stopPrice = last.high + atr * FUTURES_CONFIG.STOP_BUFFER_ATR;
    }
  }

  if (!mode) {
    return {
      symbol,
      rejected: "شرایط سخت‌گیرانه ورود فراهم نیست.",
      diagnosticStage: "ENTRY_SETUP",
      entryConditionDiagnostics
    };
  }

  const entrySource = options.backtestEntryOpen !== undefined
    ? options.backtestEntryOpen
    : ticker.last;
  const entry = Number(entrySource);
  if (!Number.isFinite(entry) || entry <= 0) {
    return { symbol, rejected: "قیمت ورود نامعتبر است.", diagnosticStage: "ENTRY_PRICE", entryConditionDiagnostics };
  }
  if (!Number.isFinite(stopPrice) || stopPrice <= 0) {
    return { symbol, rejected: "قیمت استاپ نامعتبر است.", diagnosticStage: "STOP_VALIDATION", entryConditionDiagnostics };
  }

  const risk = stopPrice - entry;
  const riskPct = (risk / entry) * 100;
  if (!Number.isFinite(risk) || !Number.isFinite(riskPct) || risk <= 0) {
    return { symbol, rejected: "استاپ در موقعیت معتبر برای معامله SHORT قرار ندارد.", diagnosticStage: "STOP_SIDE_VALIDATION", diagnosticDetails: { entry, stopPrice, risk, riskPct }, entryConditionDiagnostics };
  }
  if (riskPct > FUTURES_CONFIG.MAX_RISK_PCT || riskPct < FUTURES_CONFIG.MIN_RISK_PCT) {
    return {
      symbol,
      rejected: `ریسک استاپ (${riskPct.toFixed(2)}%) خارج از محدوده مجاز است.`,
      diagnosticStage: "RISK_FILTER",
      diagnosticDetails: { riskPct, minRiskPct: FUTURES_CONFIG.MIN_RISK_PCT, maxRiskPct: FUTURES_CONFIG.MAX_RISK_PCT, entry, stopPrice },
      entryConditionDiagnostics
    };
  }

  const target1 = entry - risk * FUTURES_CONFIG.TARGET_1_R;
  if (!Number.isFinite(target1) || target1 <= 0) {
    return { symbol, rejected: "قیمت تارگت نامعتبر است.", diagnosticStage: "TARGET_VALIDATION", entryConditionDiagnostics };
  }

  // target2/target3 are compatibility levels for the existing display/tracker schema.
  // The v10.6 signal's strategy target remains target1 = 1.5R.
  const target2 = entry - risk * 2.2;
  const target3 = entry - risk * 3.0;
  if (![target2,target3].every(v => Number.isFinite(v) && v > 0) ||
      !(target3 < target2 && target2 < target1 && target1 < entry && entry < stopPrice)) {
    return { symbol, rejected: "سطوح قیمت سیگنال معتبر نیستند.", diagnosticStage: "TARGET_VALIDATION", diagnosticDetails: { entry, stopPrice, target1, target2, target3 }, entryConditionDiagnostics };
  }

  return {
    symbol,
    side: "SHORT",
    mode,
    strategyId: "v10.6-short-hybrid",
    strategyName: "Crypto Pump Hunter v10.6 SHORT Hybrid",
    score: mode === "RALLY_FADE" ? 90 : 80,
    entry,
    stop: stopPrice,
    target1,
    target2,
    target3,
    risk,
    riskPct,
    rewardRisk: FUTURES_CONFIG.TARGET_1_R,
    candleTime: last.time,
    atr,
    rsi: rsiValue,
    ema20: e20,
    ema50: e50,
    eligible: true,
    diagnosticStage: "ELIGIBLE",
    entryConditionDiagnostics: { ...entryConditionDiagnostics, selectedEngine: mode }
  };
}


function formatPrice(value) {
  const price = Number(value);
  if (!Number.isFinite(price)) return "—";
  return price.toLocaleString("en-US", { maximumFractionDigits: 8 });
}

function formatFuturesSignal(item, index = 1) {
  const sideLabel = item.side === "LONG" ? "🟢 لانگ / Long" : "🔴 شورت / Short";
  const label = "🟢 سیگنال معتبر";
  const symbol = escapeTelegramHtml(formatFuturesSymbol(item.symbol));
  return `${label}\n\n` +
    `نماد: <b>${symbol}</b>\n\n` +
    `جهت معامله: ${sideLabel}\n\n` +
    `قیمت ورود: <b>${formatSignalPrice(item.entry)}</b>\n\n` +
    `🎯 تارگت اول (1.5R): <b>${formatSignalPrice(item.target1)}</b>\n\n` +
    `🎯 تارگت دوم (2.2R): <b>${formatSignalPrice(item.target2)}</b>\n\n` +
    `🎯 تارگت سوم (3R): <b>${formatSignalPrice(item.target3)}</b>\n\n` +
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


async function getOpenFuturesTrades(env) {
  if (!env.SIGNAL_DELIVERY || !env.SIGNAL_DELIVERY_SECRET) throw new Error("Durable signal storage is required.");
  const stub = env.SIGNAL_DELIVERY.get(env.SIGNAL_DELIVERY.idFromName("global:active-futures-signals"));
  const response = await stub.fetch("https://signal-delivery.internal/trades/list", {
    method: "POST", headers: { "content-type": "application/json", "x-signal-delivery-secret": env.SIGNAL_DELIVERY_SECRET },
    body: "{}"
  });
  const payload = await response.json();
  if (!response.ok || !payload?.ok || !Array.isArray(payload.trades)) throw new Error(payload?.error || "Durable open-trade retrieval failed.");
  return payload.trades;
}

async function persistFuturesTradeUpdates(env, updates) {
  if (!updates.length) return { updated: 0 };
  const stub = env.SIGNAL_DELIVERY.get(env.SIGNAL_DELIVERY.idFromName("global:active-futures-signals"));
  const response = await stub.fetch("https://signal-delivery.internal/trades/update", {
    method: "POST", headers: { "content-type": "application/json", "x-signal-delivery-secret": env.SIGNAL_DELIVERY_SECRET },
    body: JSON.stringify({ trades: updates })
  });
  const payload = await response.json();
  if (!response.ok || !payload?.ok) throw new Error(payload?.error || "Durable trade update failed.");
  return payload;
}

async function monitorOpenFuturesTrades(env) {
  const trades = await getOpenFuturesTrades(env);
  if (!trades.length) return { checked: 0, closed: 0, errors: 0 };
  const symbols = [...new Set(trades.map(t => t.symbol).filter(Boolean))];
  const updates = [];
  let checked = 0, closed = 0, errors = 0;
  await mapLimit(symbols, 3, async symbol => {
    let candles;
    try {
      candles = await getKrakenFuturesCandles(symbol, "5m");
    } catch (error) {
      errors++;
      console.error("Futures trade monitor candle fetch failed:", symbol, String(error?.message || error));
      return;
    }
    for (const original of trades.filter(t => t.symbol === symbol && t.status === "OPEN")) {
      let trade = { ...original };
      const freshCandles = getNewClosedFuturesCandles(candles, trade.lastCheckedCandleTime);
      if (!freshCandles.length) continue;
      for (const candle of freshCandles) {
        const result = evaluateTradeCandle(trade, { ...candle, time: Number(candle.time) + 300000 });
        trade = {
          ...trade,
          lastPrice: candle.close,
          lastCheckedAt: new Date().toISOString(),
          lastCheckedCandleTime: Number(candle.time)
        };
        checked++;
        if (result.changed) {
          trade = { ...result.trade, lastPrice: candle.close, lastCheckedAt: new Date().toISOString(), lastCheckedCandleTime: Number(candle.time) };
          closed++;
          break;
        }
      }
      updates.push(trade);
    }
  });
  if (updates.length) await persistFuturesTradeUpdates(env, updates);
  return { checked, closed, errors };
}

async function registerPendingFuturesSignals(env, candidates) {
  if (!env.SIGNAL_DELIVERY || !env.SIGNAL_DELIVERY_SECRET) throw new Error("Durable signal storage is required.");
  const stub = env.SIGNAL_DELIVERY.get(env.SIGNAL_DELIVERY.idFromName("global:active-futures-signals"));
  const response = await stub.fetch("https://signal-delivery.internal/signals/register", {
    method: "POST", headers: { "content-type": "application/json", "x-signal-delivery-secret": env.SIGNAL_DELIVERY_SECRET },
    body: JSON.stringify({ signals: Array.isArray(candidates) ? candidates : [] })
  });
  const payload = await response.json();
  if (!response.ok || !payload?.ok || !Array.isArray(payload.signals)) throw new Error(payload?.error || "Durable pending-signal registration failed.");
  return payload.signals;
}
const tradeDir=side=>side==="LONG"?1:-1;
const targetReached=(side,p,t)=>side==="LONG"?p>=t:p<=t;
const stopReached=(side,p,t)=>side==="LONG"?p<=t:p>=t;
function priceChangePercent(side,entry,exit){const e=Number(entry),x=Number(exit);return Number.isFinite(e)&&e>0&&Number.isFinite(x)?tradeDir(side)*(x-e)/e*100:null}
function formatOutcomePercent(value){if(value===null||value===undefined||value==="")return "—";const n=Number(value);if(!Number.isFinite(n))return "—";const label=n>0?"سود":n<0?"زیان":"سر‌به‌سر";return `${Math.abs(n).toFixed(2)}٪ ${label}`}
function tradeResultR(t,includeRemainder){const risk=Number(t.initialRisk),entry=Number(t.actualEntry),target=Number(t.target1);if(!Number.isFinite(risk)||risk<=0||!Number.isFinite(entry)||entry<=0)return null;if((t.tpHits||[]).includes("TP1")&&Number.isFinite(target))return tradeDir(t.side)*(target-entry)/risk;return includeRemainder?tradeDir(t.side)*(Number(t.currentStop)-entry)/risk:0}
function tradeOutcomePercent(t,exitPrice){const e=Number(t.actualEntry??t.entry);if(!Number.isFinite(e)||e<=0)return null;const exit=Number(exitPrice);return priceChangePercent(t.side,e,exit)}
function getNewClosedFuturesCandles(candles,lastCheckedCandleTime=0){return(Array.isArray(candles)?candles:[]).filter(c=>Number(c.time)>Number(lastCheckedCandleTime||0)).sort((a,b)=>a.time-b.time)}
function ensureTradeTrackingCheckpoint(trade,now=Date.now()){if(!Number.isFinite(Number(trade?.lastCheckedCandleTime))||Number(trade.lastCheckedCandleTime)<=0){trade.lastCheckedCandleTime=Math.floor(now/60000)*60000;trade.trackingMode=trade.trackingMode||"LEGACY_CONTINUED";return true}return false}
function isValidFuturesSignalLevels(signal){const entry=Number(signal?.entry),stop=Number(signal?.stop),targets=[Number(signal?.target1),Number(signal?.target2),Number(signal?.target3)];if(!signal?.id||!signal?.symbol||!["LONG","SHORT"].includes(signal?.side)||![entry,stop,...targets].every(Number.isFinite)||![entry,stop,...targets].every(v=>v>0))return false;return signal.side==="LONG"?stop<entry&&entry<targets[0]&&targets[0]<targets[1]&&targets[1]<targets[2]:stop>entry&&entry>targets[0]&&targets[0]>targets[1]&&targets[1]>targets[2]}
function createTrackedFuturesTrade(signal,chatId){if(!isValidFuturesSignalLevels(signal))return null;const entry=Number(signal.entry),stop=Number(signal.stop),createdAt=Date.now();return{id:crypto.randomUUID(),signalId:signal.id,chatId:String(chatId),symbol:signal.symbol,exchange:signal.exchange||"Kraken",side:signal.side,tier:"STANDARD",strategyId:signal.strategyId||"kraken-futures-engine",strategyName:signal.strategyName||"Kraken Futures 3.8.2",reason:signal.reason||"",plannedEntry:entry,actualEntry:entry,initialStop:stop,currentStop:stop,target1:Number(signal.target1),target2:Number(signal.target2),target3:Number(signal.target3),initialRisk:tradeDir(signal.side)*(entry-stop),tpHits:[],status:"OPEN",trackingMode:"SIGNAL_EVALUATION",createdAt:new Date(createdAt).toISOString(),lastPrice:entry,lastCheckedAt:new Date(createdAt).toISOString(),lastCheckedCandleTime:Math.floor(createdAt/60000)*60000}}
async function sendAndArchiveFuturesSignalUnlocked(env,ctx,chatId,signal,messageText,replyMarkup=null,parseMode="HTML"){
  if(!signal?.id||!signal?.symbol||!["LONG","SHORT"].includes(signal?.side))throw new Error("Signal is missing a valid id, symbol, or direction.");
  if(!isValidFuturesSignalLevels(signal))throw new Error("Signal price levels are invalid or not correctly ordered; refusing to publish an untrackable signal.");
  const key="signal-outbox:"+signalOutboxKey(chatId,signal.id);
  let record=await ctx.storage.get(key);
  if(record?.status==="SENT"||record?.status==="ARCHIVED")return{delivered:true,duplicate:true};
  if(record?.status==="SENDING"||record?.status==="UNCERTAIN")throw new Error("Signal delivery is uncertain and requires manual reconciliation; automatic resend is blocked.");
  record={version:2,chatId:String(chatId),signalId:String(signal.id),symbol:signal.symbol,signal,messageText,replyMarkup,parseMode,status:"SENDING",createdAt:record?.createdAt||new Date().toISOString(),attemptedAt:new Date().toISOString()};
  await ctx.storage.put(key,record);
  let response;
  try {
    response=await sendMessage(env,chatId,messageText,replyMarkup,parseMode);
  } catch(error) {
    await ctx.storage.put(key,{...record,status:"UNCERTAIN",error:String(error?.message||error).slice(0,500),updatedAt:new Date().toISOString()});
    throw error;
  }
  record={...record,status:"SENT",telegramMessageId:response?.result?.message_id??null,sentAt:new Date().toISOString()};
  await ctx.storage.put(key,record);
  try {
    const archiveResult=await publishSignalToArchive(env,signal,messageText,parseMode);
    record={...record,archivePublished:archiveResult?.published!==false,archiveMessageId:archiveResult?.messageId??null};
  } catch(error) {
    record={...record,archivePublished:false,archivePublishError:String(error?.message||error).slice(0,500)};
    console.error("Archive failed; private signal delivery remains successful:",signal.symbol,String(error?.message||error));
  }
  record={...record,status:"ARCHIVED",archivedAt:new Date().toISOString()};
  await ctx.storage.put(key,record);
  return{delivered:true,duplicate:false};
}

async function publishSignalToArchive(env,signal,messageText,parseMode="HTML") {
  const channelId=archiveChannelId(env);if(!channelId)return {skipped:true};
  if(!env.SIGNAL_DELIVERY||!env.SIGNAL_DELIVERY_SECRET)throw new Error("Archive publishing requires SIGNAL_DELIVERY coordination.");
  const stub=env.SIGNAL_DELIVERY.get(env.SIGNAL_DELIVERY.idFromName("global:signal-archive-publisher"));
  const response=await stub.fetch("https://signal-delivery.internal/archive-publish",{
    method:"POST",headers:{"content-type":"application/json","x-signal-delivery-secret":env.SIGNAL_DELIVERY_SECRET},
    body:JSON.stringify({channelId,signalId:String(signal.id),messageText,parseMode})
  });
  const payload=await response.json();
  if(!response.ok||!payload?.ok)throw new Error(payload?.error||"Archive publishing failed.");
  return payload.result;
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
    if(request.method!=="POST"||!["/deliver","/reconcile","/archive-publish","/scan-lock/acquire","/scan-lock/release","/kv-write/allow","/kv-write/pause","/signals/register","/signals/list","/trades/list","/trades/update"].includes(url.pathname))return new Response("Not found",{status:404});
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
        if(url.pathname==="/signals/list"){
          const now=Date.now();
          const current=await this.ctx.storage.get("active-futures-pending")||[];
          const active=current.filter(x=>Number(x?.expiresAt)>now&&x?.symbol&&["LONG","SHORT"].includes(x?.side))
            .sort((a,b)=>Number(b?.createdAt||0)-Number(a?.createdAt||0));
          const limit=Math.max(1,Math.min(20,Number(payload.limit)||15));
          return Response.json({ok:true,signals:active.slice(0,limit)});
        }
        if(url.pathname==="/trades/list"){
          const trades=await this.ctx.storage.get("active-futures-trades")||[];
          return Response.json({ok:true,trades:trades.filter(t=>t?.status==="OPEN")});
        }
        if(url.pathname==="/trades/update"){
          const current=await this.ctx.storage.get("active-futures-trades")||[];
          const updates=Array.isArray(payload.trades)?payload.trades:[];
          const byId=new Map(current.map(t=>[String(t.id),t]));
          let updated=0,closed=0;
          const releasedSignalIds=new Set();
          for(const candidate of updates){
            if(!candidate?.id)continue;
            const existing=byId.get(String(candidate.id));
            if(!existing||existing.status!=="OPEN")continue;
            const next={...existing,
              lastPrice:Number(candidate.lastPrice)||existing.lastPrice,
              lastCheckedAt:candidate.lastCheckedAt||existing.lastCheckedAt,
              lastCheckedCandleTime:Math.max(Number(existing.lastCheckedCandleTime)||0,Number(candidate.lastCheckedCandleTime)||0)
            };
            if(["CLOSED_PROFIT","CLOSED_STOP"].includes(candidate.status)){
              next.status=candidate.status;
              next.closeReason=candidate.closeReason||candidate.status;
              next.exitPrice=Number(candidate.exitPrice);
              next.closePriceChangePercent=Number(candidate.closePriceChangePercent);
              next.marginReturnPercent=Number(candidate.marginReturnPercent);
              next.closedAt=candidate.closedAt||new Date().toISOString();
              next.lockReleaseEligible=true;
              releasedSignalIds.add(String(existing.signalId));
              closed++;
            }
            byId.set(String(existing.id),next);
            updated++;
          }
          const all=[...byId.values()];
          const open=all.filter(t=>t.status==="OPEN");
          const history=all.filter(t=>t.status!=="OPEN").slice(-500);
          await this.ctx.storage.put("active-futures-trades",[...open,...history]);
          if(closed){
            const pending=await this.ctx.storage.get("active-futures-pending")||[];
            await this.ctx.storage.put("active-futures-pending",pending.filter(s=>!releasedSignalIds.has(String(s.id))));
          }
          return Response.json({ok:true,updated,closed,open:open.length});
        }
        if(url.pathname==="/signals/register"){
          const now=Date.now();
          const current=await this.ctx.storage.get("active-futures-pending")||[];
          const trades=await this.ctx.storage.get("active-futures-trades")||[];
          const closedSignalIds=new Set(trades.filter(t=>["CLOSED_PROFIT","CLOSED_STOP"].includes(t?.status)).map(t=>String(t.signalId)));
          const active=current.filter(x=>Number(x?.expiresAt)>now&&x?.symbol&&["LONG","SHORT"].includes(x?.side)&&!closedSignalIds.has(String(x?.id)));
          const activeTradeKeys=new Set(trades.filter(t=>t?.status==="OPEN").map(t=>String(t.symbol).trim().toUpperCase()+"|"+t.side));
          const activeKeys=new Set(active.map(x=>String(x.symbol).trim().toUpperCase()+"|"+x.side));
          const seen=new Set();
          const fresh=[];
          const newTrades=[];
          for(const signal of Array.isArray(payload.signals)?payload.signals:[]){
            if(!signal?.id||!signal?.symbol||!["LONG","SHORT"].includes(signal?.side)||!isValidFuturesSignalLevels(signal))continue;
            const key=String(signal.symbol).trim().toUpperCase()+"|"+signal.side;
            if(activeKeys.has(key)||activeTradeKeys.has(key)||seen.has(key))continue;
            seen.add(key);fresh.push(signal);
            const trade=createTrackedFuturesTrade(signal,"signal-evaluation");
            if(trade)newTrades.push(trade);
          }
          const merged=[...active,...fresh].slice(-150);
          if(newTrades.length){
            const open=trades.filter(t=>t?.status==="OPEN");
            const history=trades.filter(t=>t?.status!=="OPEN").slice(-500);
            await this.ctx.storage.put("active-futures-trades",[...open,...history,...newTrades]);
          }
          await this.ctx.storage.put("active-futures-pending",merged);
          return Response.json({ok:true,signals:fresh,trackedTrades:newTrades.length});
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
        if(url.pathname==="/archive-publish"){
          const key="published-signal:"+String(payload.signalId||"");
          const old=await this.ctx.storage.get(key);
          if(old)return Response.json({ok:true,result:{published:false,duplicate:true,messageId:old.messageId}});
          if(!archiveChannelId(this.env)||String(payload.channelId)!==archiveChannelId(this.env))throw new Error("Archive channel ID mismatch.");
          if(!payload.signalId||typeof payload.messageText!=="string")throw new Error("Invalid archive payload.");
          const sent=await telegram("sendMessage",this.env,{chat_id:payload.channelId,text:payload.messageText,parse_mode:payload.parseMode||"HTML",disable_web_page_preview:true,protect_content:true});
          const messageId=sent?.result?.message_id??null;
          await this.ctx.storage.put(key,{messageId,publishedAt:new Date().toISOString()});
          return Response.json({ok:true,result:{published:true,messageId}});
        }
        if(url.pathname==="/deliver"){
          const result=await sendAndArchiveFuturesSignalUnlocked(this.env,this.ctx,payload.chatId,payload.signal,payload.messageText,payload.replyMarkup??null,payload.parseMode??"HTML");
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
          const confirmed={...record,status:"ARCHIVED",archivedAt:new Date().toISOString(),updatedAt:new Date().toISOString(),manualConfirmedAt:new Date().toISOString()};
          await this.env.APP_KV.put(key,JSON.stringify(confirmed));
          return Response.json({ok:true,result:{confirmed:true}});
        }
        if(payload.action==="retry"){
          if(!["SENDING","UNCERTAIN"].includes(record.status))throw new Error("Only SENDING or UNCERTAIN records can be retried.");
          if(!record.signal||typeof record.messageText!=="string")throw new Error("This older outbox record has no retry payload.");
          await this.env.APP_KV.put(key,JSON.stringify({...record,status:"QUEUED",retryAuthorizedAt:new Date().toISOString(),updatedAt:new Date().toISOString()}));
          await this.ctx.storage.put("signal-outbox:"+key,{...record,status:"QUEUED",retryAuthorizedAt:new Date().toISOString()});
          const result=await sendAndArchiveFuturesSignalUnlocked(this.env,this.ctx,chatId,record.signal,record.messageText,record.replyMarkup??null,record.parseMode??"HTML");
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


async function showRecentFuturesSignalReport(env,ownerId){
  if(!isOwner(ownerId,env))return;
  if(!env.SIGNAL_DELIVERY||!env.SIGNAL_DELIVERY_SECRET){
    await sendMessage(env,ownerId,"❌ اتصال امن حافظه سیگنال‌ها در دسترس نیست.");
    return;
  }
  try{
    const stub=env.SIGNAL_DELIVERY.get(env.SIGNAL_DELIVERY.idFromName("global:active-futures-signals"));
    const response=await stub.fetch("https://signal-delivery.internal/signals/list",{
      method:"POST",
      headers:{"content-type":"application/json","x-signal-delivery-secret":env.SIGNAL_DELIVERY_SECRET},
      body:JSON.stringify({limit:15})
    });
    let payload={};
    try{payload=await response.json()}catch{}
    if(!response.ok||!payload?.ok)throw new Error(payload?.error||"دریافت فهرست سیگنال‌ها ناموفق بود.");
    const signals=Array.isArray(payload.signals)?payload.signals:[];
    if(!signals.length){
      await sendMessage(env,ownerId,"📊 در حال حاضر سیگنال فعالی در حافظه موتور وجود ندارد.\nاین گزارش فقط سیگنال‌های هنوز معتبر و منقضی‌نشده را نشان می‌دهد.");
      return;
    }
    const fmt=value=>{
      if(value===null||value===undefined||value==="")return "—";
      const n=Number(value);
      return Number.isFinite(n)?n.toLocaleString("en-US",{maximumFractionDigits:8}):"—";
    };
    const lines=[
      "📊 گزارش مدیریتی سیگنال‌های اخیر",
      "━━━━━━━━━━━━━━━━━━",
      "منبع: حافظه Durable Object موتور فیوچرز",
      "تعداد نمایش: "+signals.length,
      "این گزارش فقط خواندنی است و هیچ داده‌ای در KV ذخیره نمی‌کند.",
      ""
    ];
    for(let i=0;i<signals.length;i++){
      const s=signals[i];
      const side=s.side==="LONG"?"🟢 لانگ":"🔴 شورت";
      const created=Number(s.createdAt);
      const createdText=Number.isFinite(created)&&created>0?new Date(created).toISOString():"نامشخص";
      lines.push(
        (i+1)+") "+formatFuturesSymbol(s.symbol)+" | "+side,
        "امتیاز: "+fmt(s.score)+" از 100",
        "ورود: "+fmt(s.entry)+" | حد ضرر: "+fmt(s.stop),
        "تارگت اول (1.5R): "+fmt(s.target1)+" | تارگت دوم (2.2R): "+fmt(s.target2)+" | تارگت سوم (3R): "+fmt(s.target3),
        "RSI: "+fmt(s.rsi)+" | نسبت حجم: "+fmt(s.volumeRatio)+" | تغییر ۲۴ساعته: "+fmt(s.change24h)+"٪",
        "حجم مظنه: "+fmt(s.quoteVolume)+" USD | فاندینگ: "+fmt(s.funding),
        "زمان ایجاد: "+createdText
      );
      if(Array.isArray(s.reasons)&&s.reasons.length){
        lines.push("دلایل امتیازدهی:");
        for(const reason of s.reasons.slice(0,8))lines.push("• "+String(reason).slice(0,180));
      }
      const d=s.entryDiagnostics;
      if(d&&typeof d==="object"){
        const checks=[
          ["فاصله قیمت تا قیمت تحلیلی",d.driftPct,"٪"],
          ["فاصله از EMA20 بر حسب ATR",d.emaDistanceAtr," ATR"],
          ["تأیید مومنتوم ۱۵دقیقه‌ای",d.momentumConfirmed===true?"بله":d.momentumConfirmed===false?"خیر":"نامشخص",""],
          ["تأیید پولبک ۱۵دقیقه‌ای",d.pullbackConfirmed===true?"بله":d.pullbackConfirmed===false?"خیر":"نامشخص",""]
        ];
        lines.push("کنترل ورود:");
        for(const [label,value,suffix] of checks){
          if(value!==undefined)lines.push("• "+label+": "+(typeof value==="number"?fmt(value)+suffix:value));
        }
      }
      lines.push("━━━━━━━━━━━━━━━━━━","");
    }
    await sendLongMessage(env,ownerId,lines.join("\n"));
  }catch(error){
    console.error("Admin recent signal report failed:",String(error?.stack||error));
    await sendMessage(env,ownerId,"❌ ساخت گزارش مدیریتی ناموفق بود:\n"+String(error?.message||error).slice(0,500));
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
async function handleFillCommand(env,chatId,message){return sendMessage(env,chatId,"ℹ️ ثبت و پیگیری نتایج معاملات در این نسخه غیرفعال است.")}
async function notifyOwnerScanDiagnostics(env, message, throttleKey, ttlSeconds) {
  const ownerId = env.OWNER_TELEGRAM_ID || env.OWNER_ID;
  if (!ownerId) {
    console.error("SCAN_DIAGNOSTIC_OWNER_MISSING", JSON.stringify({ timestamp: new Date().toISOString() }));
    return false;
  }
  if (env.APP_KV && throttleKey) {
    try {
      if (await env.APP_KV.get(throttleKey)) return false;
      await env.APP_KV.put(throttleKey, new Date().toISOString(), { expirationTtl: ttlSeconds });
    } catch (error) {
      console.error("SCAN_DIAGNOSTIC_THROTTLE_FAILED", String(error?.message || error));
    }
  }
  try {
    await sendLongMessage(env, ownerId, message);
    return true;
  } catch (error) {
    console.error("SCAN_DIAGNOSTIC_TELEGRAM_FAILED", String(error?.stack || error?.message || error));
    return false;
  }
}

async function runAutomaticFuturesAlertScan(env) {
  try {
    return await runAutomaticFuturesAlertScanInternal(env);
  } catch (error) {
    const diagnostic = String(error?.stack || error?.message || error).slice(0, 1400);
    console.error("AUTOMATIC_FUTURES_SCAN_FATAL", JSON.stringify({
      timestamp: new Date().toISOString(), version: CONFIG.VERSION, error: diagnostic
    }));
    await notifyOwnerScanDiagnostics(env, "🚨 خطای اجرای اسکن زمان‌بندی‌شده فیوچرز\n\n" + diagnostic,
      "futures:scan-diagnostic:fatal", 15 * 60);
    return { scanned: false, error: diagnostic };
  }
}

async function runAutomaticFuturesAlertScanInternal(env) {
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
    let tracking = { checked: 0, closed: 0, errors: 0 };
    let trackingError = null;
    try {
      tracking = await monitorOpenFuturesTrades(env);
    } catch (error) {
      trackingError = String(error?.message || error).slice(0, 500);
      console.error("Open futures trade monitoring failed:", String(error?.stack || error?.message || error));
    }
    const result = await runFuturesSignalScan(env);
    if (result.diagnostics) result.diagnostics.trackingError = trackingError;
    const diagnostics = result.diagnostics || {};
    const noSignalMessage = [
      "🧪 گزارش تشخیصی اسکن خودکار فیوچرز",
      "━━━━━━━━━━━━━━━━━━",
      "نسخه: " + CONFIG.VERSION,
      "زمان: " + (diagnostics.finishedAt || new Date().toISOString()),
      "نمادهای واجد حجم: " + (diagnostics.universeCount ?? "—"),
      "نمادهای تحلیل‌شده: " + (diagnostics.analyzedCount ?? "—"),
      "نمادهای بررسی‌نشده به‌علت محدودیت زمان: " + (diagnostics.notAnalyzedCount ?? "—"),
      "خطاهای دریافت/تحلیل: " + (diagnostics.analysisErrorCount ?? "—"),
      "ردشده‌ها: " + (diagnostics.rejectedCount ?? "—"),
      "سیگنال واجد شرایط: " + (diagnostics.eligibleCount ?? "—"),
      "ثبت‌شده: " + (diagnostics.registeredCount ?? "—"),
      "ارسال موفق: " + (diagnostics.delivery?.delivered ?? "—"),
      "ارسال ناموفق: " + (diagnostics.delivery?.failed ?? "—"),
      "مدت اسکن: " + (diagnostics.durationMs != null ? Math.round(diagnostics.durationMs / 1000) + " ثانیه" : "—"),
      "",
      "آمار شروط TREND_SHORT (قبول/رد):",
      ...Object.entries(diagnostics.entryConditionSummary?.trendShort || {}).map(([name, counts]) => "• " + name + ": " + counts.passed + "/" + counts.failed),
      "آمار شروط RALLY_FADE (قبول/رد):",
      ...Object.entries(diagnostics.entryConditionSummary?.rallyFade || {}).map(([name, counts]) => "• " + name + ": " + counts.passed + "/" + counts.failed),
      "",
      "مهم‌ترین دلایل رد:",
      ...(diagnostics.topRejections || []).map(x => "• " + x.reason + ": " + x.count),
      diagnostics.deliveryError ? "\nخطای ارسال: " + diagnostics.deliveryError : "",
      diagnostics.trackingError ? "\nخطای پایش معاملات: " + diagnostics.trackingError : "",
      "━━━━━━━━━━━━━━━━━━",
      diagnostics.signalCount ? "سیگنال صادر شد؛ این پیام گزارش خطا/وضعیت نیست." :
        "در این نوبت سیگنالی واجد شرایط پیدا نشد."
    ].filter(Boolean).join("\n");
    if (diagnostics.analysisErrorCount > 0 || diagnostics.delivery?.failed > 0 || diagnostics.deliveryError || diagnostics.trackingError || diagnostics.universeError) {
      await notifyOwnerScanDiagnostics(env, noSignalMessage,
        "futures:scan-diagnostic:issue", 15 * 60);
    } else if ((diagnostics.signalCount || 0) === 0) {
      await notifyOwnerScanDiagnostics(env, noSignalMessage,
        "futures:scan-diagnostic:no-signal", 6 * 60 * 60);
    }
    return { scanned: true, signals: (result.signals || []).length, experimentalSignals: 0, tracking, diagnostics };
  } finally {
    const releaseResponse = await stub.fetch("https://signal-delivery.internal/scan-lock/release", { method: "POST", headers, body: "{}" });
    if (!releaseResponse.ok) console.error("Could not release automatic scan lock:", releaseResponse.status);
  }
}

async function runFuturesSignalScan(env, options = {}) {
  const started = Date.now();
  const universe = await getKrakenFuturesUniverse();
  if (!universe.length) {
    const finishedAt = new Date().toISOString();
    const diagnostics = {
      startedAt: new Date(started).toISOString(),
      finishedAt,
      durationMs: Date.now() - started,
      universeCount: 0,
      analyzedCount: 0,
      notAnalyzedCount: 0,
      analysisErrorCount: 0,
      rejectedCount: 0,
      eligibleCount: 0,
      signalCount: 0,
      registeredCount: 0,
      delivery: { newSignals: 0, recipients: 0, delivered: 0, failed: 0 },
      deliveryError: null,
      universeError: "Kraken returned no active PI/PF USD perpetuals above the configured 24h quote-volume threshold.",
      topRejections: [{ reason: "هیچ نماد واجد حداقل حجم ۲۴ساعته پیدا نشد.", count: 1 }]
    };
    console.error("AUTOMATIC_FUTURES_SCAN_DIAGNOSTICS", JSON.stringify(diagnostics));
    return { report: "⚠️ در Kraken قرارداد دائمی با حجم کافی پیدا نشد.", signals: [], diagnostics };
  }

  // Universe is already filtered to active PI/PF USD perpetuals with the minimum 24h quote volume and sorted by descending volume.
  // Scan the live exchange-wide liquid universe; no hard-coded symbol allowlist.
  const filteredUniverse = universe;

  const analysisDeadline = started + FUTURES_CONFIG.MAX_SCAN_DURATION_MS - FUTURES_CONFIG.SCAN_FINALIZATION_RESERVE_MS;
  let analysisErrorCount = 0;
  const analyzed = await mapLimit(filteredUniverse, FUTURES_CONFIG.CONCURRENCY, async ticker => {
    let oneHour = [];
    try {
      oneHour = await getKrakenFuturesCandles(ticker.symbol, "1h");
      const analysis = analyzeFuturesSymbol(ticker, oneHour, [], [], options);
      return { ...analysis, scanDiagnostics: { completeCandleCount: oneHour.length } };
    } catch (error) {
      analysisErrorCount++;
      return { symbol: ticker.symbol, rejected: error?.message || "خطای تحلیل", diagnosticStage: "DATA_OR_ANALYSIS_ERROR", diagnosticType: "data_or_analysis_error", scanDiagnostics: { completeCandleCount: oneHour.length, error: String(error?.message || error).slice(0, 240) } };
    }
  }, () => Date.now() < analysisDeadline);

  // Runtime-only diagnostics: console output only; deliberately no KV/DO writes or Telegram messages.
  const entryConditionBreakdown = analyzed
    .filter(item => item?.entryConditionDiagnostics)
    .map(item => ({ symbol: item.symbol, ...item.entryConditionDiagnostics }));
  const conditionTotals = { trendShort: {}, rallyFade: {} };
  for (const item of entryConditionBreakdown) {
    for (const [engine, conditions] of [["trendShort", item.trendShort], ["rallyFade", item.rallyFade]]) {
      for (const [condition, passed] of Object.entries(conditions || {})) {
        if (typeof passed !== "boolean") continue;
        const bucket = conditionTotals[engine][condition] || (conditionTotals[engine][condition] = { passed: 0, failed: 0 });
        bucket[passed ? "passed" : "failed"]++;
      }
    }
  }
  const entryConditionSummary = {
    symbolsWithConditionData: entryConditionBreakdown.length,
    trendShort: conditionTotals.trendShort,
    rallyFade: conditionTotals.rallyFade
  };
  if (entryConditionBreakdown.length) {
    console.log("AUTOMATIC_FUTURES_ENTRY_CONDITION_DIAGNOSTICS", JSON.stringify({
      timestamp: new Date().toISOString(),
      version: CONFIG.VERSION,
      rejectedAt: "TREND_SHORT_OR_RALLY_FADE_SETUP",
      summary: entryConditionSummary,
      symbols: entryConditionBreakdown
    }));
  }

  const stageCounts = new Map();
  const candleCountSamples = [];
  for (const item of analyzed) {
    const stage = item?.diagnosticStage || "UNKNOWN";
    stageCounts.set(stage, (stageCounts.get(stage) || 0) + 1);
    const count = Number(item?.scanDiagnostics?.completeCandleCount);
    if (Number.isFinite(count)) candleCountSamples.push({ symbol: item.symbol, completeCandles: count });
  }

  const createdAt = Date.now();
  const eligibleCandidates = analyzed
    .filter(x => x?.eligible === true && x.side === "SHORT")
    .sort((a,b) => b.score - a.score || a.symbol.localeCompare(b.symbol));

  const generatedSignals = eligibleCandidates
    .slice(0, FUTURES_CONFIG.MAX_SIGNALS_PER_SCAN)
    .map(x => {
      const { scanDiagnostics, diagnosticStage, diagnosticDetails, entryConditionDiagnostics, ...signal } = x;
      return {
      ...signal,
      id: crypto.randomUUID(),
      createdAt,
      expiresAt: createdAt + FUTURES_CONFIG.SIGNAL_TTL_MINUTES * 60000,
      status: "PENDING"
    };
    });

  const signals = await registerPendingFuturesSignals(env, generatedSignals);
  let delivery = { newSignals: signals.length, recipients: 0, delivered: 0, failed: 0 };
  let deliveryError = null;
  try {
    delivery = await deliverFuturesSignalAlerts(env, signals, options.excludeChatId ?? null);
  } catch (error) {
    deliveryError = String(error?.message || error).slice(0, 700);
    console.error("Immediate futures alert dispatch failed:", String(error?.stack || error?.message || error));
  }

  const analyzedCount = analyzed.filter(Boolean).length;
  const rejectionCounts = new Map();
  for (const item of analyzed) {
    if (!item || item.eligible === true) continue;
    const reason = String(item.rejected || "علت رد نامشخص").slice(0, 180);
    rejectionCounts.set(reason, (rejectionCounts.get(reason) || 0) + 1);
  }
  const finishedAt = new Date().toISOString();
  const diagnostics = {
    startedAt: new Date(started).toISOString(),
    finishedAt,
    durationMs: Date.now() - started,
    universeCount: filteredUniverse.length,
    analyzedCount,
    notAnalyzedCount: Math.max(0, filteredUniverse.length - analyzedCount),
    analysisErrorCount,
    rejectedCount: analyzed.filter(x => x && x.eligible !== true).length,
    eligibleCount: eligibleCandidates.length,
    signalCount: signals.length,
    registeredCount: signals.length,
    delivery,
    deliveryError,
    stageCounts: Object.fromEntries([...stageCounts.entries()].sort((a, b) => b[1] - a[1])),
    entryConditionSummary,
    candleCounts: { min: candleCountSamples.length ? Math.min(...candleCountSamples.map(x => x.completeCandles)) : null, max: candleCountSamples.length ? Math.max(...candleCountSamples.map(x => x.completeCandles)) : null, samples: candleCountSamples.slice(0, 12) },
    rejectionSamples: analyzed.filter(x => x && x.eligible !== true).slice(0, 20).map(x => ({ symbol: x.symbol, stage: x.diagnosticStage || "UNKNOWN", reason: x.rejected || null, details: x.diagnosticDetails || x.entryConditionDiagnostics || null, completeCandles: x.scanDiagnostics?.completeCandleCount ?? null })),
    topRejections: [...rejectionCounts.entries()].map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count).slice(0, 6)
  };
  console.log("AUTOMATIC_FUTURES_SCAN_DIAGNOSTICS", JSON.stringify(diagnostics));
  console.log("AUTOMATIC_FUTURES_STAGE_DIAGNOSTICS", JSON.stringify({ timestamp: finishedAt, version: CONFIG.VERSION, stageCounts: diagnostics.stageCounts, entryConditionSummary: diagnostics.entryConditionSummary, candleCounts: diagnostics.candleCounts, rejectionSamples: diagnostics.rejectionSamples }));
  const report =
    `📈 CRYPTO PUMP HUNTER V10.6 — STRICT SHORT HYBRID\n` +
    "━━━━━━━━━━━━━━━━━━\n" +
    "🏦 بازار: Kraken Derivatives Perpetual\n" +
    "⏱ تایم‌فریم: 1h\n" +
    `📥 نمادهای بررسی‌شده: ${analyzedCount} از ${filteredUniverse.length} نماد واجد حداقل حجم ۲۴ساعته\n` +
    `⭐ سیگنال‌های واجد شرایط: ${signals.length}\n` +
    `🧭 TREND_SHORT / RALLY_FADE\n\n` +
    (signals.length
      ? signals.map((item,i) => formatFuturesSignal(item,i+1)).join("\n━━━━━━━━━━━━━━━━━━\n\n")
      : "⚠️ در این بررسی سیگنال واجد شرایطی پیدا نشد.") +
    `\n\n🕒 زمان گزارش: ${new Date().toISOString()}\n` +
    `⏱ مدت بررسی: ${Math.round((Date.now()-started)/1000)} ثانیه\n` +
    "📡 منبع داده: Kraken Derivatives Futures\n" +
    "⚠️ سیگنال‌ها تحلیلی‌اند؛ سفارش واقعی ثبت نمی‌شود و سود تضمین نیست.";

  return { report, signals, experimentalSent: 0, analyzed, diagnostics };
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


async function deliverFuturesSignalAlerts(env, signals, excludeChatId = null) {
  if (!Array.isArray(signals) || !signals.length) return { newSignals: 0, recipients: 0, delivered: 0, failed: 0 };
  const recipients = new Set();
  const ownerId = env.OWNER_TELEGRAM_ID || env.OWNER_ID;
  if (ownerId) recipients.add(String(ownerId));
  // KV is used only to read the allow-list. Any read/quota outage must not
  // prevent delivery to the owner, and must never broaden access to users.
  if (env.APP_KV) {
    try {
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
      const legacyMembers = await env.APP_KV.get("v1:members", "json") || {};
      for (const [chatId, legacy] of Object.entries(legacyMembers)) {
        if (legacy?.status !== "active") continue;
        const modern = await env.APP_KV.get(memberKey(chatId), "json");
        if (!modern) recipients.add(String(chatId));
      }
    } catch (error) {
      console.error("Approved-member read failed; continuing with owner delivery only:", String(error?.message || error));
    }
  }
  const targets = [...recipients].filter(id => excludeChatId == null || String(id) !== String(excludeChatId));
  let delivered = 0, failed = 0;
  await mapLimit(targets, 4, async chatId => {
    for (let i = 0; i < signals.length; i++) {
      try {
        await sendAndArchiveFuturesSignal(env, chatId, signals[i], formatFuturesSignalAlert(signals[i], i + 1));
        delivered++;
      } catch (error) {
        failed++;
        console.error("Immediate futures alert delivery failed", chatId, signals[i].symbol, String(error?.message || error));
      }
    }
  });
  return { newSignals: signals.length, recipients: targets.length, delivered, failed };
}

// ---------------- CONCURRENCY ----------------

async function mapLimit(items, limit, callback, shouldContinue = () => true) {
  const results = new Array(items.length);
  let index = 0;

  async function worker() {
    while (true) {
      if (!shouldContinue()) return;
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
export { FUTURES_CONFIG, passesLongDistanceThreshold, findLatestConfirmed15mPivot, mapLimit, FUTURES_PROVIDER_ORDER, isKrakenPerpetualTicker, normalizeKrakenFuturesUnderlying, getKrakenFuturesUniverse, getKrakenFuturesCandles, calculateAtr, evaluateFuturesEntryFilters, analyzeFuturesSymbol, getFuturesUniverse, getFuturesCandles, tradeResultR, priceChangePercent, tradeOutcomePercent, targetReached, stopReached, getNewClosedFuturesCandles, ensureTradeTrackingCheckpoint, isValidFuturesSignalLevels };
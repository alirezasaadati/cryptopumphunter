import { futuresSignalFingerprint, selectUnnotifiedFuturesSignals, futuresAlertStorageKey, formatFuturesSignalAlert, displayEntryPrice, ALERT_TTL_SECONDS } from "./futures-alerts.js";
import { signalOutboxKey, signalOutboxAction } from "./signal-outbox.js";
import { createSerialExecutor } from "./serial-executor.js";
import { evaluateStagedTradeCandle } from "./futures-trade-lifecycle.js";

const CONFIG = {
  VERSION: "11.3.0",
  PENDING_TTL: 604800,
  TRADE_MONITOR_STUCK_AFTER_MS: 2 * 60 * 60 * 1000
};


const TELEGRAM_API = "https://api.telegram.org";

function getSignalDeliverySecret(env) {
  return env.SIGNAL_DELIVERY_AUTH_SECRET || "";
}

async function verifySignalDeliverySecret(provided, expected) {
  if (typeof provided !== "string" || !provided || typeof expected !== "string" || !expected) return false;
  const encoder = new TextEncoder();
  const [providedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(provided)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected))
  ]);
  if (typeof crypto.subtle.timingSafeEqual === "function") {
    return crypto.subtle.timingSafeEqual(providedHash, expectedHash);
  }
  const left = new Uint8Array(providedHash);
  const right = new Uint8Array(expectedHash);
  let difference = 0;
  for (let i = 0; i < left.length; i++) difference |= left[i] ^ right[i];
  return difference === 0;
}

const seenUpdates = new Set();
let telegramKvDedupeUnavailable = false;

export function quotaDayKey(now = Date.now()) { return new Date(now).toISOString().slice(0, 10); }
export function isKvDailyWriteQuotaError(error) {
  const message = String(error?.message || error || "").toLowerCase();
  return message.includes("limit exceeded for the day") || (message.includes("quota") && (message.includes("put") || message.includes("delete")));
}
const kvWriteGateCache = new Map();
let localKvWritePausedDay = null;
const KV_WRITE_GATE_CACHE_MS = 5 * 60 * 1000;
const KV_WRITE_GATE_FAILURE_CACHE_MS = 5 * 60 * 1000;

async function kvWriteGate(env, action, error = null) {
  const today = quotaDayKey();
  if (!env.SIGNAL_DELIVERY) return { allowed: true, gateUnavailable: true };

  if (action === "allow") {
    const cached = kvWriteGateCache.get(today);
    if (cached && cached.expiresAt > Date.now()) return cached.promise;
  }

  const request = (async () => {
    try {
      const stub = env.SIGNAL_DELIVERY.get(env.SIGNAL_DELIVERY.idFromName("global-kv-write-quota"));
      const response = await stub.fetch("https://signal-delivery.internal/kv-write/" + action, {
        method: "POST",
        headers: { "content-type": "application/json", "x-signal-delivery-secret": getSignalDeliverySecret(env) || "" },
        body: JSON.stringify({ day: today, message: error ? String(error?.message || error).slice(0, 300) : undefined })
      });
      if (!response.ok) throw new Error("KV quota gate returned HTTP " + response.status + ".");
      const result = await response.json();
      if (typeof result?.allowed !== "boolean") throw new Error("KV quota gate returned an invalid response.");
      if (action === "allow") {
        const nextUtcDay = Date.parse(today + "T00:00:00.000Z") + 24 * 60 * 60 * 1000;
        const ttl = result.allowed ? KV_WRITE_GATE_CACHE_MS : Math.max(1000, nextUtcDay - Date.now());
        kvWriteGateCache.set(today, { expiresAt: Date.now() + ttl, promise: Promise.resolve(result) });
      }
      return result;
    } catch (gateError) {
      console.warn("KV quota gate unavailable; relying on the KV namespace quota enforcement:", String(gateError?.message || gateError));
      if (action === "allow") {
        const fallback = { allowed: true, gateUnavailable: true };
        kvWriteGateCache.set(today, { expiresAt: Date.now() + KV_WRITE_GATE_FAILURE_CACHE_MS, promise: Promise.resolve(fallback) });
        return fallback;
      }
      return { allowed: false, gateUnavailable: true };
    }
  })();

  if (action === "allow") {
    kvWriteGateCache.set(today, { expiresAt: Date.now() + KV_WRITE_GATE_FAILURE_CACHE_MS, promise: request });
  }
  return request;
}

export function withQuotaAwareKV(env) {
  if (!env.APP_KV) return env;
  const raw = env.APP_KV;
  const guarded = new Proxy(raw, {
    get(target, property) {
      if (property === "put" || property === "delete") return async (...args) => {
        const today = quotaDayKey();
        if (localKvWritePausedDay === today) {
          throw new Error("KV daily write quota is paused until the next UTC day; this change was not saved.");
        }

        const gate = await kvWriteGate(env, "allow");
        if (gate?.allowed === false) {
          localKvWritePausedDay = today;
          console.warn("KV write suppressed by daily quota circuit breaker.");
          throw new Error("KV daily write quota is paused until the next UTC day; this change was not saved.");
        }

        try {
          return await target[property](...args);
        } catch (error) {
          if (isKvDailyWriteQuotaError(error)) {
            localKvWritePausedDay = today;
            await kvWriteGate(env, "pause", error);
            console.error("KV daily write quota reached; writes paused locally until the next UTC day.");
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
  "<b>🔵 درباره ربات</b>\n\n" +
  "🔸تریدیار | دستیار معاملات فیوچرز\n\n" +
  "🔸 طراحی و توسعه: ع.س\n\n" +
  "🔸 تمامی حقوق مربوط به ربات برای صاحب اثر محفوظ است.\n" +
  "🔸هرگونه کپی‌برداری، بازنشر یا استفاده ، بدون اجازه ممنوع است.";

const CAPITAL_MANAGEMENT_TEXT =
  "🚨 <b>راهنمای مدیریت ریسک</b> 🚨\n\n" +
  "لطفاً پیش از ورود به هر سیگنال، این دستورالعمل‌ها را با دقت مطالعه کنید.\n\n\n" +
  "<b>1️⃣ ریسک هر معامله</b>\n\n\n" +
  "🔹 در هر معامله، حداکثر <b>۱٪ از کل موجودی کیف پول</b> خود را در معرض ریسک قرار دهید.\n\n\n" +
  "🔹 حجم موقعیت معاملاتی را به‌گونه‌ای افزایش ندهید که از این سقف ریسک فراتر برود.\n\n\n" +
  "<b>2️⃣ مسئولیت معامله‌گری</b>\n\n\n" +
  "🔹 تصمیم‌گیری درباره معاملات و زمان ورود، بر عهده خود شماست.\n\n\n" +
  "🔹 هرگز با پولی که برای هزینه‌های ضروری زندگی نیاز دارید معامله نکنید.\n\n\n" +
  "🔹 تا زمانی که ریسک‌ها را درک نکرده‌اید و تجربه کافی ندارید، وارد معامله نشوید.\n\n\n" +
  "🔹 هیچ سیگنالی تضمین‌شده یا بدون ریسک نیست؛ احتمال زیان همیشه وجود دارد.\n\n\n" +
  "<b>3️⃣ ورود پله‌ای</b>\n\n\n" +
  "🔹 برای کاهش ریسک ورود در یک قیمت مشخص، می‌توانید سرمایه اختصاص‌یافته به معامله را میان دو سطح ورود تقسیم کنید.\n\n\n" +
  "🔹 برای مثال، اگر ۱۰ دلار با اهرم ۱۰ برابر به معامله اختصاص داده‌اید، می‌توانید ۵ دلار را در نقطه ورود اول و ۵ دلار دیگر را در نقطه ورود دوم وارد کنید. به این ترتیب، تمام مبلغ را در یک قیمت وارد نمی‌کنید و ممکن است میانگین قیمت ورود بهتری به دست آورید.\n\n\n" +
  "⚠️ ورود پله‌ای ریسک را از بین نمی‌برد. ورود دوم میزان درگیری سرمایه و ریسک کل را افزایش می‌دهد؛ بنابراین رعایت حد ضرر و مدیریت حجم معامله ضروری است.\n\n\n" +
  "<b>4️⃣ اهرم و اجرای معامله</b>\n\n\n" +
  "🔹 اهرم را متناسب با ریسک معامله و فاصله قیمت ورود تا حد ضرر انتخاب کنید.\n\n\n" +
  "🔹 استفاده از حالت <b>ایزوله (Isolated)</b> و اهرم پایین‌تر، معمولاً ریسک لیکویید شدن را کاهش می‌دهد.\n\n\n" +
  "🔹 اهرم ۱۰ برابر مانع لیکویید شدن نمی‌شود. همیشه حد ضرر درج‌شده در سیگنال را رعایت کنید.\n\n\n" +
  "<b>5️⃣ ورود دیرهنگام</b>\n\n\n" +
  "🔹 اگر قیمت به هدف اول رسیده است، دیگر به‌صورت دیرهنگام وارد آن سیگنال نشوید.\n\n\n" +
  "<b>6️⃣ مدیریت سود و حد ضرر</b>\n\n\n" +
  "🔹 در سطوح قیمتی اهداف، برداشت بخشی از سود را در نظر بگیرید.\n\n\n" +
  "🔹 می‌توانید بخش قابل‌توجهی از موقعیت را در هدف اول (TP1) ببندید و باقی‌مانده را برای اهداف بعدی باز نگه دارید.\n\n\n" +
  "🔹 پس از حرکت مطلوب قیمت، انتقال حد ضرر به نقطه ورود یا سطحی امن‌تر را بررسی کنید.\n\n\n" +
  "🔹 مجموع حجم بسته‌شده در تمام اهداف نباید از ۱۰۰٪ موقعیت اولیه بیشتر شود.\n\n" +
  "⚠️ <b>حفظ سرمایه بر کسب سود اولویت دارد.</b>\n" +
  "برای جبران ضرر، هرگز حجم معامله را افزایش ندهید.";

function mainMenuForChat(env, chatId) {
  const owner = isOwner(chatId, env);
  const keyboard = [
    [
      { text: "📈 سیگنال‌های فیوچرز", callback_data: "futures" }
    ],
    [{ text: "🛡️ راهنمای مدیریت ریسک", callback_data: "capital_guide" }],
    owner
      ? [
          { text: "📢 کانال سیگنال VIP", callback_data: "issued_signals" },
          { text: "📊 گزارش سیگنال‌های اخیر", callback_data: "admin:signals" }
        ]
      : [
          { text: "🎧 پشتیبانی", url: "https://t.me/alirza_saadati" },
          { text: "📊 رصد معاملات کاربران", callback_data: "invite" }
        ],
    ...(owner ? [[
      { text: "👥 مدیریت اعضا", callback_data: "members:0" },
      { text: "📊 رصد معاملات کاربران", callback_data: "invite" }
    ]] : []),
    [
      { text: "📡 وضعیت ربات", callback_data: "status" },
      { text: "🔌 تست اتصال", callback_data: "test" }
    ],
    ...(owner ? [[
      { text: "⚠️ ارسال‌های نامشخص", callback_data: "outbox:review" },
      { text: "ℹ️ درباره ربات", callback_data: "about" }
    ]] : [[
      { text: "ℹ️ درباره ربات", callback_data: "about" }
    ]]),
    ...(owner ? [[{ text: "🎧 پشتیبانی", url: "https://t.me/alirza_saadati" }]] : [])
  ];
  return { inline_keyboard: keyboard };
}

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
        mode: "Kraken Derivatives Futures signals",
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
    throw new Error(`${label}: Invalid JSON response; HTTP ${response.status}`);
  }

  if (!response.ok) {
    throw new Error(`${label}: HTTP ${response.status}`);
  }

  return data;
}

async function telegram(method, env, body) {
  if (!(env.TELEGRAM_BOT_TOKEN || env.BOT_TOKEN)) throw new Error("BOT_TOKEN is not configured.");

  // Explicitly disable Telegram content protection in private chats so users can
  // screenshot bot messages. Keep protection enabled for channel/group messages.
  const chatId = body?.chat_id == null ? "" : String(body.chat_id);
  const protectedBody = method === "sendMessage" && chatId
    ? { ...body, protect_content: chatId.startsWith("-") }
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
    const error = new Error(data.description || `Telegram HTTP ${response.status}`);
    error.telegramStatus = response.status;
    error.telegramRetryAfter = Number(data?.parameters?.retry_after) || 0;
    throw error;
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

async function sendSignalCardOrText(env, chatId, signal, messageText, replyMarkup, parseMode) {
  // Signal alerts are intentionally delivered as text for readability and easy copying.
  return sendMessage(env, chatId, messageText, replyMarkup, parseMode);
}

async function sendCapitalManagementGuide(env, chatId) {
  return sendMessage(env, chatId, CAPITAL_MANAGEMENT_TEXT, null, "HTML");
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
  if (!channelId) return sendMessage(env,userId,"⚠️ Archive access has not been fully configured yet.");
  if (!(await isApproved(userId,env))) return sendMessage(env,userId,"⛔ شما به آرشیو دسترسی ندارید.");
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
    await sendMessage(env,userId,"🎉 عضویت شما تایید شد.\n\n🔗 برای ورود به کانال VIP از لینک زیر استفاده کنید.\n\nلینک : "+link);
  } catch(error) {
    console.error("Archive invite link failed:",String(error?.message||error));
    await sendMessage(env,userId,"⚠️ Could not create an archive invite link right now.");
  }
}
async function handleArchiveJoinRequest(request,env) {
  const channelId=archiveChannelId(env);
  if(!channelId||String(request?.chat?.id)!==channelId)return false;
  const userId=request?.from?.id;if(!userId)return true;
  try {
    if(await isApproved(userId,env)){
      await telegram("approveChatJoinRequest",env,{chat_id:channelId,user_id:userId});
      await sendMessage(env,userId,"✅ Your request to join the archive channel has been approved.");
    } else {
      await telegram("declineChatJoinRequest",env,{chat_id:channelId,user_id:userId});
      await sendMessage(env,userId,"⛔ Only approved bot members can join the archive channel.");
    }
  } catch(error){console.error("Archive join request failed:",String(error?.message||error));}
  return true;
}
async function removeArchiveMember(env,userId) {
  const channelId=archiveChannelId(env);
  if(!channelId||!userId||isOwner(userId,env)) {
    return {ok:false,error:"The archive channel ID or member ID is invalid."};
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
    return {ok:false,error:"The archive channel ID or member ID is invalid."};
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

const LBANK_REFERRAL_URL = "https://www.lbk.pub/ref/67XF8";

async function requestMembership(env, chatId, message, submittedUid = "") {
  if (isOwner(chatId, env)) {
    await showMenu(env, chatId);
    return;
  }

  if (!(env.OWNER_TELEGRAM_ID || env.OWNER_ID) || !env.APP_KV) {
    await sendMessage(env, chatId, "⚠️ ثبت درخواست عضویت در حال حاضر امکان‌پذیر نیست. لطفاً بعداً تلاش کنید.");
    return;
  }

  if (await isApproved(chatId, env)) {
    await showMenu(env, chatId);
    return;
  }

  try {
    const existingMember = await env.APP_KV.get(memberKey(chatId), "json");
    if (existingMember?.revoked === true) {
      await sendMessage(env, chatId, "⛔ دسترسی شما قبلاً توسط مدیر لغو شده است. برای فعال‌سازی مجدد با مدیر تماس بگیرید.");
      return;
    }
  } catch {
    await sendMessage(env, chatId, "⚠️ بررسی وضعیت عضویت ممکن نشد. لطفاً دوباره تلاش کنید.");
    return;
  }

  try {
    const existing = await env.APP_KV.get(pendingKey(chatId), "json");

    if (!submittedUid) {
      if (existing?.uid) {
        await sendMessage(env, chatId, "⏳ UID شما قبلاً ثبت شده و درخواستتان در انتظار بررسی مدیر است. پس از تصمیم‌گیری به شما اطلاع می‌دهیم.");
        return;
      }
      await sendMessage(
        env,
        chatId,
        "👋 به تریدیار خوش آمدید\n\n" +
        "برای استفاده از سیگنال‌ها، ابتدا از طریق لینک زیر در صرافی LBank ثبت‌نام کنید. سپس UID حساب خود را در قالب یک پیام برای ربات ارسال کنید.\n\n" +
        "🔗 لینک ثبت‌نام: " + LBANK_REFERRAL_URL + "\n\n" +
        "پس از بررسی UID توسط مدیر، در صورت تأیید عضویت، لینک کانال VIP برای شما ارسال خواهد شد.\n\n" +
        "📩 لطفاً UID خود را در پیام بعدی ارسال کنید."
      );
      return;
    }

    const uid = String(submittedUid).trim();
    if (!/^[A-Za-z0-9_-]{3,64}$/.test(uid)) {
      await sendMessage(env, chatId, "⚠️ UID معتبر نیست. لطفاً فقط UID حساب LBank را بدون فاصله و توضیحات ارسال کنید.");
      return;
    }

    if (existing?.uid) {
      await sendMessage(env, chatId, "⏳ UID شما قبلاً ثبت شده و درخواستتان در انتظار بررسی مدیر است. پس از تصمیم‌گیری به شما اطلاع می‌دهیم.");
      return;
    }

    const user = message?.from || {};
    const applicant = {
      chatId: String(chatId),
      userId: String(user.id || chatId),
      username: user.username || "",
      firstName: user.first_name || "",
      lastName: user.last_name || "",
      uid,
      requestedAt: new Date().toISOString()
    };

    await env.APP_KV.put(
      pendingKey(chatId),
      JSON.stringify(applicant),
      { expirationTtl: CONFIG.PENDING_TTL }
    );

    const displayName = [applicant.firstName, applicant.lastName].filter(Boolean).join(" ") || "نام ثبت نشده";
    const username = applicant.username ? `@${applicant.username}` : "ندارد";
    const adminText =
      "🔔 درخواست عضویت جدید\n" +
      "━━━━━━━━━━━━━━━━━━\n\n" +
      `👤 نام: ${displayName}\n` +
      `🔗 نام کاربری: ${username}\n` +
      `🆔 شناسه تلگرام: ${applicant.userId}\n` +
      `🪪 UID صرافی LBank: ${applicant.uid}\n` +
      `🕒 زمان درخواست: ${applicant.requestedAt}\n\n` +
      "لطفاً UID را بررسی و درباره عضویت تصمیم‌گیری کنید.";

    const adminButtons = {
      inline_keyboard: [[
        { text: "✅ قبول عضویت", callback_data: `approve:${chatId}` },
        { text: "❌ رد درخواست", callback_data: `reject:${chatId}` }
      ]]
    };

    await sendMessage(env, (env.OWNER_TELEGRAM_ID || env.OWNER_ID), adminText, adminButtons);
    await sendMessage(env, chatId, "✅ UID شما با موفقیت ثبت شد.\n\n⏳ درخواست عضویت برای مدیر ارسال شد و پس از بررسی، نتیجه همین‌جا به شما اطلاع داده می‌شود.");
  } catch (error) {
    console.error("Membership UID submission failed:", String(error?.message || error));
    await sendMessage(env, chatId, "❌ ثبت UID انجام نشد. لطفاً کمی بعد دوباره تلاش کنید.");
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
    await answerCallback(env, query.id, "⛔ Unauthorized");
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
    await sendMessage(env, ownerId, "❌ KV storage is unavailable.");
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
        "⚠️ Request not found or expired."
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
        "🎉 عضویت شما در تریدیار تأیید شد.\n\n✅ دسترسی شما فعال است. لینک ورود به کانال VIP در پیام بعدی برایتان ارسال می‌شود."
      );
      await sendArchiveAccessLink(env, applicantId);
      await showMenu(env, applicantId);

      await sendMessage(
        env,
        ownerId,
        "✅ Member approved successfully."
      );
    } else {
      await env.APP_KV.delete(pendingKey(applicantId));

      await sendMessage(
        env,
        applicantId,
        "❌ ثبت‌نام شما ناموفق بوده است.\n\nلطفاً از طریق لینک زیر در صرافی LBank ثبت‌نام کنید و UID خود را برای بررسی مجدداً ارسال کنید.\n\n🔗 لینک ثبت‌نام: " + LBANK_REFERRAL_URL
      );

      await sendMessage(
        env,
        ownerId,
        "❌ Membership request rejected."
      );
    }
  } catch (error) {
    await sendMessage(
      env,
      ownerId,
      "❌ Error processing request:\n" +
      String(error.message || "Unknown error").slice(0, 500)
    );
  }

  return true;
}

async function handleOwnerAccessCommand(command, chatId, env, message) {
  if (!["/allow", "/revoke", "/members", "/member"].includes(command)) return false;
  if (!isOwner(chatId, env)) {
    await sendMessage(env, chatId, "⛔ This command is available to the bot administrator only.");
    return true;
  }
  if (!env.APP_KV) {
    await sendMessage(env, chatId, "❌ WATCHLIST_KV is not configured. Bind KV to the Worker first.");
    return true;
  }

  if (command === "/members") {
    await showMemberList(env, chatId, 0);
    return true;
  }

  if (command === "/member") {
    const targetId = (message?.text || "").trim().split(/\s+/)[1];
    if (!targetId || !/^-?\d+$/.test(targetId)) {
      await sendMessage(env, chatId, "Usage: /member 123456789");
    } else {
      await showMemberProfile(env, chatId, targetId);
    }
    return true;
  }

  const targetId = (message?.text || "").trim().split(/\s+/)[1];
  if (!targetId || !/^-?\d+$/.test(targetId)) {
    await sendMessage(env, chatId, `Usage: ${command} 123456789`);
    return true;
  }
  if (String(targetId) === String((env.OWNER_TELEGRAM_ID || env.OWNER_ID))) {
    await sendMessage(env, chatId, "⚠️ The primary administrator's access cannot be revoked.");
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
        "🎉 Your CRYPTO PUMP HUNTER access has been enabled by the administrator.\n\n" +
        "Welcome! You can now use the bot.");
      await showMenu(env, targetId);
      await sendMessage(env, chatId, `✅ User ${targetId} has been approved and access is active.`);
    } else {
      const member = { ...existing, chatId: String(targetId), approved: false, revoked: true,
        revokedAt: new Date().toISOString(), revokedBy: String(chatId) };
      await env.APP_KV.put(memberKey(targetId), JSON.stringify(member));
      await env.APP_KV.delete(pendingKey(targetId));
      await removeArchiveMember(env,targetId);
      await sendMessage(env, targetId, "⛔ دسترسی شما به ربات تریدیار توسط مدیر لغو شد.");
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
    await sendMessage(env, ownerId, "صفحه قبلی منقضی شده است. فهرست اعضا را دوباره باز کنید.");
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
    const name = [m.firstName, m.lastName].filter(Boolean).join(" ") || "No name";
    keyboard.push([{ text: `${blocked ? "🚫" : "✅"} ${name.slice(0,24)} | ${id}`, callback_data: `mprof:${id}` }]);
  }
  if (result.list_complete === false && result.cursor) {
    await env.APP_KV.put(`admin:members:cursor:${ownerId}:${page+1}`, result.cursor, { expirationTtl: 3600 });
    keyboard.push([{ text: "صفحه بعد ➡️", callback_data: `members:${page+1}` }]);
  }
  if (page > 0) keyboard.push([{ text: "⬅️ صفحه قبل", callback_data: `members:${page-1}` }]);
  keyboard.push([{ text: "🏠 منوی اصلی", callback_data: "menu" }]);
  const faDigits = value => String(value).replace(/\\d/g, digit => "۰۱۲۳۴۵۶۷۸۹"[Number(digit)]);
  await sendMessage(env, ownerId,
    `<b>مدیریت اعضا</b>\n\n- مدیریت اعضا | صفحه ${faDigits(page+1)}\n- اعضای فعال در این صفحه: ${faDigits(active)}\n- دسترسی لغوشده در این صفحه: ${faDigits(revoked)}`,
    { inline_keyboard: keyboard }, "HTML");
}
async function showMemberProfile(env, ownerId, id) {
  if (!isOwner(ownerId,env) || !env.APP_KV || !/^-?\d+$/.test(id)) return;
  const m=await env.APP_KV.get(memberKey(id),"json");
  if(!m){await sendMessage(env,ownerId,"عضو موردنظر پیدا نشد.");return;}
  const blocked=m.revoked===true||m.approved===false;
  const name=[m.firstName,m.lastName].filter(Boolean).join(" ")||"Not provided";
  const body=["👤 پروفایل عضو","━━━━━━━━━━━━━━━━━━",`نام: ${name}`,`نام کاربری: ${m.username?"@"+m.username:"ثبت نشده"}`,`شناسه تلگرام: ${m.userId||id}`,`شناسه گفتگو: ${m.chatId||id}`,`وضعیت: ${blocked?"🚫 لغوشده":"✅ فعال"}`,`زمان درخواست: ${m.requestedAt||"نامشخص"}`,`زمان تأیید: ${m.approvedAt||"ثبت نشده"}`,`آخرین فعال‌سازی: ${m.allowedAt||"ثبت نشده"}`,`زمان لغو دسترسی: ${m.revokedAt||"ثبت نشده"}`].join("\n");
  await sendMessage(env,ownerId,body,{inline_keyboard:[[blocked?{text:"✅ فعال‌سازی دسترسی",callback_data:`mall:${id}`}:{text:"🚫 لغو دسترسی",callback_data:`mrev:${id}`}],[{text:"⬅️ بازگشت",callback_data:"members:"}]]});
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
    await sendMessage(env,ownerId,"❌ Could not read member data from KV. No changes were made.\nReason: "+message.slice(0,500));
    return;
  }
  if(!m){await sendMessage(env,ownerId,"Member not found.");return;}
  const next=allow?{...m,approved:true,revoked:false,allowedAt:new Date().toISOString(),allowedBy:String(ownerId)}:{...m,approved:false,revoked:true,revokedAt:new Date().toISOString(),revokedBy:String(ownerId)};
  try {
    await env.APP_KV.put(memberKey(id),JSON.stringify(next));
  } catch(error) {
    const message=String(error?.message||error);
    console.error("Member access KV write failed:",message);
    await sendMessage(env,ownerId,"❌ Access change was not saved. The member's status remains unchanged.\nReason: "+message.slice(0,500));
    return;
  }
  const archiveResult=allow
    ? await restoreArchiveMemberEligibility(env,id)
    : await removeArchiveMember(env,id);
  try {
    await sendMessage(env,id,allow?"🎉 Your access has been restored.":"⛔ Your access has been revoked by the administrator.");
  } catch(error) {
    console.warn("Member access notification failed:",String(error?.message||error));
  }
  if(!archiveResult?.ok) {
    await sendMessage(env,ownerId,
      "⚠️ Bot access was saved, but the archive-channel permission change failed.\n"+
      "Reason: "+String(archiveResult?.error||"Unknown error").slice(0,500));
  } else {
    await sendMessage(env,ownerId,allow
      ?"✅ دسترسی عضو فعال شد و محدودیت عضویت در کانال آرشیو برداشته شد."
      :"✅ دسترسی عضو لغو شد و عضویت در کانال آرشیو مسدود شد.");
  }
  await showMemberProfile(env,ownerId,id);
}

// ---------------- MAIN MENU ----------------
function replyMenuForChat(env, chatId) {
  const owner = isOwner(chatId, env);
  const keyboard = [
    [
      { text: "📈 سیگنال‌های فیوچرز" }
    ],
    [
      { text: "🛡️ راهنمای مدیریت ریسک" }
    ],
    owner
      ? [
          { text: "📢 کانال سیگنال VIP" },
          { text: "📊 گزارش سیگنال‌های اخیر" }
        ]
      : [
          { text: "🎧 پشتیبانی" },
          { text: "📊 رصد معاملات کاربران" }
        ],
    ...(owner ? [[
      { text: "👥 مدیریت اعضا" },
      { text: "📊 رصد معاملات کاربران" }
    ]] : []),
    [
      { text: "📡 وضعیت ربات" },
      { text: "🔌 تست اتصال" }
    ],
    owner
      ? [
          { text: "⚠️ ارسال‌های نامشخص" },
          { text: "ℹ️ درباره ربات" }
        ]
      : [
          { text: "ℹ️ درباره ربات" }
        ]
  ];
  return {
    keyboard,
    resize_keyboard: true,
    one_time_keyboard: true,
    input_field_placeholder: "یک گزینه از تریدیار انتخاب کنید"
  };
}

// Ordinary responses must not reattach the keyboard. Telegram keeps the
// keyboard available in the chat; users can reopen it manually or with /menu.
function menuForChat(env, chatId) {
  return null;
}
async function configureTelegramMenu(env, chatId) {
  const commands = [
    { command: "start", description: "شروع ربات و معرفی" },
    { command: "menu", description: "باز کردن منوی اصلی" },
    { command: "futures", description: "دریافت سیگنال‌های فیوچرز" },
    { command: "status", description: "وضعیت سرویس" },
    { command: "help", description: "راهنمای دستورات" }
  ];

  // Telegram may prefer localized or chat-specific command lists over the
  // فهرست دستورات فارسی را برای زبان فارسی و محدوده‌های خصوصی ثبت می‌کنیم.
  // تا توضیحات قدیمی تلگرام جایگزین متن‌های جدید نشوند.
  const scopes = [
    { type: "default" },
    { type: "all_private_chats" },
    { type: "chat", chat_id: chatId }
  ];
  const tasks = [];
  for (const scope of scopes) {
    tasks.push(telegram("setMyCommands", env, { commands, scope }));
    tasks.push(telegram("setMyCommands", env, { commands, scope, language_code: "fa" }));
  }
  tasks.push(telegram("setChatMenuButton", env, {
    chat_id: chatId,
    menu_button: { type: "default" }
  }));

  // توضیحات پروفایل ربات برای زبان پیش‌فرض و فارسی ثبت می‌شود.
  
  const botDescription =
    "🤖 تریدیار | پایش هوشمند بازار\n\nشناسایی فرصت‌های \n\nمعاملاتی در دو جهت بازار:\n\n🟢 LONG | 🔴 SHORT\n\n🔎 شناسایی فرصت‌های معاملاتی با استفاده از \n\n\"موتور قدرتمند کراکن\"\n\n📍 ارائه نقاط ورود، حد ضرر و اهداف قیمتی\n\n📊 ارزیابی شرایط بازار پیش از صدور سیگنال\n\n🛡️ توجه به مدیریت ریسک در معاملات\n\n⚡ تحلیل بازار بر اساس استراتژی اختصاصی";
  const botShortDescription =
    "⚡🤖 شناسایی هوشمند معاملات بازار فیوچرز";

  for (const language_code of [undefined, "fa"]) {
    const locale = language_code ? { language_code } : {};
    tasks.push(telegram("setMyDescription", env, {
      description: botDescription,
      ...locale
    }));
    tasks.push(telegram("setMyShortDescription", env, {
      short_description: botShortDescription,
      ...locale
    }));
  }

  const results = await Promise.allSettled(tasks);
  const failed = results.filter(x => x.status === "rejected");
  if (failed.length) console.error("Telegram menu/profile setup warning:", failed.map(x => x.reason?.message || "Telegram API error"));
}

function welcomeSeenKey(chatId) {
  return `welcome-seen:${chatId}`;
}

async function showMenu(env, chatId) {
  await configureTelegramMenu(env, chatId);
  await sendMessage(
    env,
    chatId,
    "📋 منوی اصلی تریدیار",
    replyMenuForChat(env, chatId)
  );
}

async function showWelcome(env, chatId, welcome = true) {
  await configureTelegramMenu(env, chatId);
  await sendMessage(
    env,
    chatId,
    welcome
      ? "🤖 به تریدیار خوش آمدید!\nبرای باز کردن منوی اصلی، دکمه صفحه‌کلید کنار کادر پیام را لمس کنید."
      : "منوی اصلی تریدیار:",
    replyMenuForChat(env, chatId)
  );
}

async function handleReplyMenuAction(action, env, chatId, message) {
  if (action.startsWith("members:") || action.startsWith("admin:") || action.startsWith("outbox:")) {
    if (!isOwner(chatId, env)) {
      await sendMessage(env, chatId, "⛔ این گزینه فقط برای مالک ربات در دسترس است.", menuForChat(env, chatId));
      return;
    }
    if (action.startsWith("members:")) return showMemberList(env, chatId, Number(action.slice(8)) || 0);
    if (action === "admin:signals") return showRecentFuturesSignalReport(env, chatId);
    if (action === "outbox:review") return showUncertainSignalOutbox(env, chatId);
  }
  if (action === "support") {
    await sendMessage(env, chatId, "برای ارتباط مستقیم با پشتیبانی، دکمه زیر را انتخاب کنید:", {
      inline_keyboard: [[{ text: "🎧 ورود به چت خصوصی پشتیبانی", url: "https://t.me/alirza_saadati" }]]
    });
    return;
  }
  if (action === "invite") {
    await sendMessage(env, chatId,
      "📊 <b>رصد هوشمند معاملات کاربران</b>\n\n" +
      "با ثبت‌نام در صرافی LBank از طریق لینک اختصاصی زیر، می‌توانید برای بررسی دقیق دلایل سود و زیان معاملات خود، از طریق پشتیبانی گروه تریدیار اقدام کنید.\n\n" +
      "🔗 <b>لینک ثبت‌نام در LBank:</b>\n" +
      '<a href="https://www.lbk.pub/ref/67XF8">https://www.lbk.pub/ref/67XF8</a>\n\n' +
      "💠 تریدیار | پایش هوشمند بازار", menuForChat(env, chatId), "HTML");
    return;
  }
  if (action === "futures") return runFuturesSignalsForChat(env, chatId);
  if (action === "issued_signals") return sendArchiveAccessLink(env, chatId);
  if (action === "capital_guide") {
    await sendCapitalManagementGuide(env, chatId);
    return;
  }
  if (action === "status") return showStatus(env, chatId);
  if (action === "test") return showConnectionTest(env, chatId);
  if (action === "about") return sendMessage(env, chatId, ABOUT_TEXT, menuForChat(env, chatId), "HTML");
}

async function handleTelegramCommand(command, chatId, env, message) {
  try {
    if (await handleOwnerAccessCommand(command, chatId, env, message)) return;

    const selectedMenuText = String(message?.text || "").trim();
    const menuActions = new Map([
      ...mainMenuForChat(env, chatId).inline_keyboard.flat().map(button => [button.text, button.callback_data]),
      ["👥 Member Management", "members:0"],
      ["📊 Recent Signals Report", "admin:signals"],
      ["⚠️ Uncertain Deliveries", "outbox:review"],
      ["👥 مدیریت اعضا", "members:0"],
      ["📊 گزارش سیگنال‌های اخیر", "admin:signals"],
      ["⚠️ ارسال‌های نامشخص", "outbox:review"],
      ["🎧 پشتیبانی", "support"]
    ]);
    if (selectedMenuText === "📋 Main Menu" || selectedMenuText === "Main Menu" || selectedMenuText === "/menu") {
      if (await isApproved(chatId, env)) await showMenu(env, chatId);
      else await requestMembership(env, chatId, message);
      return;
    }
    if (menuActions.has(selectedMenuText)) {
      if (!(await isApproved(chatId, env))) {
        await requestMembership(env, chatId, message);
        return;
      }
      await handleReplyMenuAction(menuActions.get(selectedMenuText), env, chatId, message);
      return;
    }

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
        await showWelcome(env, chatId, !welcomeAlreadyShown);
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
      const submittedText = String(message?.text || "").trim();
      if (submittedText && !submittedText.startsWith("/")) {
        await requestMembership(env, chatId, message, submittedText);
      } else {
        await requestMembership(env, chatId, message);
      }
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
        "📘 راهنمای دستورات تریدیار\n\n" +
        "/start - شروع ربات\n" +
        "/menu - باز کردن منوی اصلی\n" +
        "/futures - دریافت سیگنال‌های فیوچرز\n" +
        "/diagfutures - گزارش عیب‌یابی فقط‌خواندنی (مالک)\n" +
        "/close_trade <ID> - بستن رکورد پیگیری داخلی (مالک؛ پوزیشن صرافی را نمی‌بندد)\n" +
        "/scan - اجرای اسکن دستی بازار اسپات\n" +
        "/status - بررسی وضعیت ربات\n" +
        "/help - نمایش این راهنما\n\n" +
        "اسکن‌ها فقط با درخواست دستی شما اجرا می‌شوند.",
        menuForChat(env, chatId)
      );
      return;
    }

    if (command === "/close_trade") {
      if (!isOwner(chatId, env)) {
        await sendMessage(env, chatId, "⛔ This command is available to the bot owner only.");
        return;
      }
      const tradeId = String(message?.text || "").trim().split(/\s+/)[1] || "";
      if (!tradeId) {
        await sendMessage(env, chatId, "Enter a trade ID: /close_trade <ID>");
        return;
      }
      const openTrades = await getOpenFuturesTrades(env);
      const trade = openTrades.find(item => String(item.id) === tradeId);
      if (!trade) {
        await sendMessage(env, chatId, "No OPEN trade was found with this ID. No changes were made.");
        return;
      }
      const exitPrice = Number(trade.lastPrice || trade.actualEntry || trade.plannedEntry);
      const change = priceChangePercent(trade.side, trade.actualEntry || trade.plannedEntry, exitPrice);
      const closedAt = new Date().toISOString();
      await persistFuturesTradeUpdates(env, [{
        id: trade.id, status: "CLOSED_MANUAL", closeReason: "OWNER_MANUAL_TRACKING_RESET",
        exitPrice, closePriceChangePercent: change, marginReturnPercent: change * FUTURES_DISPLAY_LEVERAGE,
        closedAt, lastPrice: exitPrice, lastCheckedAt: trade.lastCheckedAt,
        lastCheckedCandleTime: trade.lastCheckedCandleTime
      }]);
      await sendMessage(env, chatId,
        "✅ Tracking record closed successfully and the symbol/direction lock was released.\n" +
        "Reference price: " + formatSignalPrice(exitPrice) + "\n" +
        "⚠️ This command closes only the bot's internal tracking record; it does not close an actual exchange position. Check and close the exchange position separately.");
      return;
    }

    if (command === "/diagfutures") {
      if (!isOwner(chatId, env)) {
        await sendMessage(env, chatId, "⛔ This command is available to the bot owner only.");
        return;
      }
      await sendMessage(env, chatId, "🧪 Read-only diagnostics started. No signals will be saved or sent.");
      const diagnostic = await runFuturesEntryDiagnostics(env);
      await sendLongMessage(env, chatId, formatFuturesEntryDiagnostics(diagnostic));
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
      "Send /start to begin using the bot.",
      menuForChat(env, chatId)
    );
  } catch (error) {
    try {
      await sendMessage(
        env,
        chatId,
        "❌ Command execution failed:\n" +
        String(error.message || "Unknown error").slice(0, 1000),
        menuForChat(env, chatId)
      );
    } catch {
      // Ignore Telegram reporting errors.
    }
  }
}

async function clearInlineMenu(env, message) {
  if (!message?.chat?.id || !message?.message_id) return;
  try {
    await telegram("editMessageReplyMarkup", env, {
      chat_id: message.chat.id,
      message_id: message.message_id,
      reply_markup: { inline_keyboard: [] }
    });
  } catch (error) {
    console.error("Could not clear selected menu keyboard:", String(error?.message || error));
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
      await answerCallback(env,query.id,"⛔ Unauthorized"); return;
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
      else if(action.startsWith("outbox:archive:")) await reconcileSignalOutbox(env,chatId,action.slice(14),"retry_archive");
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
  if (action !== "menu") await clearInlineMenu(env, query.message);

  try {
    if (action === "menu") {
      await showMenu(env, chatId);
      return;
    }
    if (action === "invite") {
      await sendMessage(env, chatId,
        "📊 <b>رصد هوشمند معاملات کاربران</b>\n\n" +
        "با ثبت‌نام در صرافی LBank از طریق لینک اختصاصی زیر، می‌توانید برای بررسی دقیق دلایل سود و زیان معاملات خود، از طریق پشتیبانی گروه تریدیار اقدام کنید.\n\n" +
        "🔗 <b>لینک ثبت‌نام در LBank:</b>\n" +
        '<a href="https://www.lbk.pub/ref/67XF8">https://www.lbk.pub/ref/67XF8</a>\n\n' +
        "💠 تریدیار | پایش هوشمند بازار", null, "HTML");
      return;
    }
    if (action === "futures") {
      await runFuturesSignalsForChat(env, chatId);
      return;
    }
    if (action === "issued_signals" || action === "ledger:archive" || action === "ledger:history") return sendArchiveAccessLink(env,chatId);
    if (action === "capital_guide") {
      await sendCapitalManagementGuide(env, chatId);
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
      await sendMessage(env, chatId, ABOUT_TEXT, null, "HTML");
      return;
    }

    await showMenu(env, chatId);
  } catch (error) {
    await sendMessage(
      env,
      chatId,
      "❌ Error:\n" + String(error.message || "Unknown error").slice(0, 1000),
      menuForChat(env, chatId)
    );
  }
}

async function showStatus(env, chatId) {
  let lastScan = "هنوز گزارشی از اسکن فیوچرز ذخیره نشده است.";

  if (env.APP_KV) {
    try {
      const saved = await env.APP_KV.get("last_futures_scan", "json");
      if (saved?.timestamp) {
        lastScan = new Date(saved.timestamp).toLocaleString("en-GB", {
          timeZone: "UTC"
        }) + " UTC";
      }
    } catch {
      lastScan = "خواندن اطلاعات اسکن قبلی ممکن نشد.";
    }
  }

  await sendMessage(
    env,
    chatId,
    `🟢 وضعیت ربات\n\n` +
    `نسخه ربات:\n\u200FV${CONFIG.VERSION}\n` +
    "حالت فعالیت:\n" +
    "موتور سیگنال‌دهی فیوچرز کراکن\n" +
    "اتصال KV:\n" +
    `${env.APP_KV ? "متصل" : "قطع" }\n` +
    "آخرین اسکن فیوچرز:\n" +
    lastScan,
    menuForChat(env, chatId)
  );
}

async function showConnectionTest(env, chatId) {
  await sendMessage(env, chatId, "🔌 در حال بررسی اتصال به منابع داده...");
  const result=await testDataSources();
  const lines=[
    (result.krakenFutures?.ok?"✅":"❌")+" موتور کراکن: "+(result.krakenFutures?.ok?"متصل":"قطع"),
    result.krakenFutures?.error?"خطای فیوچرز: "+result.krakenFutures.error.slice(0,350):"",
    "نسخه: V"+CONFIG.VERSION
  ].filter(Boolean);
  await sendMessage(env,chatId,lines.join("\n"),menuForChat(env,chatId));
}
async function registerWebhook(request, env) {
  if (!(env.TELEGRAM_BOT_TOKEN || env.BOT_TOKEN)) {
    return json({ ok: false, error: "BOT_TOKEN is not configured." }, 400);
  }

  if (
    !(env.TELEGRAM_WEBHOOK_SECRET || env.WEBHOOK_SECRET) ||
    !/^[A-Za-z0-9_-]{1,256}$/.test((env.TELEGRAM_WEBHOOK_SECRET || env.WEBHOOK_SECRET))
  ) {
    return json({
      ok: false,
      error: "WEBHOOK_SECRET may contain only English letters, numbers, _ or -."
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
      error: candles.length ? undefined : "Kraken Futures returned no closed candles." };
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
  CONCURRENCY: 5, MAX_SCAN_DURATION_MS: 180000, SCAN_FINALIZATION_RESERVE_MS: 45000,
  REQUEST_TIMEOUT_MS: 12000, MAX_SIGNALS_PER_SCAN: 20,
  MIN_QUOTE_VOLUME: 5_000_000, HIGH_RISK_MIN_QUOTE_VOLUME: 5_000_000,
  KLINE_LIMIT: 120, MIN_CANDLES: 60, MIN_SCORE: 72,
  INTERVAL: "1h", CONFIRM_INTERVAL: "4h", ENTRY_CONFIRM_INTERVAL: "15m",
  SIGNAL_TTL_MINUTES: 60, MAX_ENTRY_DRIFT_PCT: 0.35, LONG_MAX_ENTRY_DRIFT_PCT: 0.70,
  MAX_ENTRY_EMA_DISTANCE_ATR: 3.0, MAX_PULLBACK_DISTANCE_ATR: 0.35, LONG_MAX_PULLBACK_DISTANCE_ATR: 0.60,
  MAX_RECLAIM_EXTENSION_ATR: 3.0, HIGH_RISK_MIN_SCORE: 55, LONG_MIN_SCORE: 67, HIGH_RISK_LONG_MIN_SCORE: 60,
  HIGH_RISK_MIN_VOLUME_RATIO: 0.5, HIGH_RISK_LONG_MIN_VOLUME_RATIO: 0.60, VOLUME_PRIORITY_TIER_1: 0.8,
  VOLUME_PRIORITY_TIER_2: 1.3, VOLUME_PRIORITY_BONUS_TIER_1: 5,
  VOLUME_PRIORITY_BONUS_TIER_2: 10, CONFIRMATION_PRIORITY_BONUS_ONE: 7,
  CONFIRMATION_PRIORITY_BONUS_BOTH: 15, HIGH_RISK_LONG_RSI_MIN: 35, HIGH_RISK_LONG_RSI_MAX: 78,
  HIGH_RISK_SHORT_RSI_MIN: 22, HIGH_RISK_SHORT_RSI_MAX: 65, HIGH_RISK_MAX_ENTRY_DRIFT_PCT: 0.75, HIGH_RISK_LONG_MAX_ENTRY_DRIFT_PCT: 0.90,
  HIGH_RISK_MAX_ENTRY_EMA_DISTANCE_ATR: 4.0, HIGH_RISK_MAX_RECLAIM_EXTENSION_ATR: 4.0
};
const FUTURES_PROVIDER_ORDER = ["Kraken"];

async function krakenFuturesJson(path, label, baseUrl = FUTURES_CONFIG.BASE_URL) {
  // Kraken can briefly return 5xx/429 during maintenance or load spikes.
  // Retry with exponential backoff; never substitute stale market data.
  const maxAttempts = 4;
  const retryableStatuses = new Set([408, 429, 500, 502, 503, 504, 520, 522, 524, 526]);
  const baseDelayMs = 1000;
  const maxDelayMs = 15000;
  let lastError = null;

  const retryDelay = (response, attempt) => {
    const retryAfter = response?.headers?.get("Retry-After");
    if (retryAfter) {
      const seconds = Number(retryAfter);
      const retryAt = Date.parse(retryAfter);
      const requestedMs = Number.isFinite(seconds)
        ? seconds * 1000
        : (Number.isFinite(retryAt) ? retryAt - Date.now() : NaN);
      if (Number.isFinite(requestedMs) && requestedMs > 0) {
        return Math.min(maxDelayMs, Math.max(baseDelayMs, requestedMs));
      }
    }
    return Math.min(maxDelayMs, baseDelayMs * (2 ** (attempt - 1)));
  };

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let response;
    try {
      response = await fetch(`${baseUrl}${path}`, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(FUTURES_CONFIG.REQUEST_TIMEOUT_MS)
      });
    } catch (error) {
      lastError = new Error(
        `${label}: Connection failed (attempt ${attempt}/${maxAttempts}): ${String(error?.message || error).slice(0, 180)}`
      );
      if (attempt === maxAttempts) throw lastError;
      const delayMs = retryDelay(null, attempt);
      console.warn("Kraken request temporarily unavailable; retrying:", JSON.stringify({
        label, attempt, maxAttempts, delayMs, error: String(error?.message || error).slice(0, 180)
      }));
      await new Promise(resolve => setTimeout(resolve, delayMs));
      continue;
    }

    const body = await response.text();
    if (!response.ok) {
      // Check status before JSON parsing: CDN/proxy failures often return HTML.
      const detail = body.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 180);
      lastError = new Error(`${label}: HTTP ${response.status}${detail ? ` — ${detail}` : ""}`);
      if (retryableStatuses.has(response.status) && attempt < maxAttempts) {
        const delayMs = retryDelay(response, attempt);
        console.warn("Kraken returned a retryable HTTP status; retrying:", JSON.stringify({
          label, status: response.status, attempt, maxAttempts, delayMs
        }));
        await new Promise(resolve => setTimeout(resolve, delayMs));
        continue;
      }
      throw lastError;
    }

    let data;
    try {
      data = JSON.parse(body);
    } catch {
      throw new Error(`${label}: HTTP ${response.status} succeeded, but the response was not valid JSON.`);
    }
    if (data?.result === "error" || (Array.isArray(data?.errors) && data.errors.length)) {
      throw new Error(`${label}: ${(data.errors || []).join(", ") || data.error || "Kraken error"}`);
    }
    return data;
  }

  throw lastError || new Error(`${label}: Request failed.`);
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
    throw new Error("Kraken Futures returned an invalid symbol list.");
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
    throw new Error(`Kraken returned an invalid candle structure for ${symbol}.`);
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
  // Exclude the currently forming candle, then enforce the configured local cap
  // even if the upstream API returns more candles than requested.
  return candles
    .filter(c => c.time + intervalMs <= now)
    .slice(-FUTURES_CONFIG.KLINE_LIMIT);
}

// Per-isolate cache avoids Cache API subrequests; entries expire at the next candle close.
const FUTURES_MARKET_DATA_MEMORY_CACHE = new Map();

async function getKrakenFuturesCandlesViaCoordinator(env, symbol, intervals) {
  // Stateless Worker performs all exchange I/O. The strategy receives the same
  // closed-candle arrays and response shape, without consuming Cache API quota.
  const normalizedSymbol = String(symbol || "").trim().toUpperCase();
  const requestedIntervals = [...new Set(Array.isArray(intervals) ? intervals : [])];
  const intervalMsMap = { "5m": 300000, "15m": 900000, "1h": 3600000, "4h": 14400000 };
  if (!/^(PI|PF)_[A-Z0-9]+USD$/.test(normalizedSymbol)) {
    throw new Error("Invalid Kraken perpetual symbol for market-data request.");
  }
  if (!requestedIntervals.length || requestedIntervals.length > 3 ||
      requestedIntervals.some(interval => !Object.hasOwn(intervalMsMap, interval))) {
    throw new Error("Invalid Kraken candle interval request.");
  }

  const now = Date.now();
  const results = await Promise.all(requestedIntervals.map(async interval => {
    const cacheKey = normalizedSymbol + "|" + interval;
    try {
      const cached = FUTURES_MARKET_DATA_MEMORY_CACHE.get(cacheKey);
      if (cached && cached.expiresAt > now) {
        return { interval, candles: cached.candles, cache: "HIT" };
      }
      if (cached) FUTURES_MARKET_DATA_MEMORY_CACHE.delete(cacheKey);

      const candles = await getKrakenFuturesCandles(normalizedSymbol, interval);
      const nextClose = (Math.floor(now / intervalMsMap[interval]) + 1) * intervalMsMap[interval];
      const expiresAt = nextClose + 1500;
      FUTURES_MARKET_DATA_MEMORY_CACHE.set(cacheKey, { candles, expiresAt });
      // Keep the opportunistic isolate cache bounded.
      if (FUTURES_MARKET_DATA_MEMORY_CACHE.size > 256) {
        for (const [key, value] of FUTURES_MARKET_DATA_MEMORY_CACHE) {
          if (value.expiresAt <= now || FUTURES_MARKET_DATA_MEMORY_CACHE.size > 192) {
            FUTURES_MARKET_DATA_MEMORY_CACHE.delete(key);
          }
          if (FUTURES_MARKET_DATA_MEMORY_CACHE.size <= 192) break;
        }
      }
      return { interval, candles, cache: "MISS" };
    } catch (error) {
      return { interval, error: String(error?.message || error).slice(0, 400), cache: "ERROR" };
    }
  }));

  const candles = {};
  const errors = {};
  const cacheStats = { hit: 0, miss: 0, error: 0 };
  for (const result of results) {
    if (result.error) errors[result.interval] = result.error;
    else candles[result.interval] = result.candles;
    cacheStats[result.cache.toLowerCase()]++;
  }
  console.log("FUTURES_MARKET_DATA_FETCH", JSON.stringify({
    symbol: normalizedSymbol, intervals: requestedIntervals, cache: cacheStats
  }));
  return { ok: true, symbol: normalizedSymbol, candles, errors, cacheStats };
}


function normalizeKrakenFuturesUnderlying(symbol) {
  const raw = String(symbol || "").toUpperCase().replace(/^(PI|PF)_/, "").replace(/USD$/, "");
  return raw === "XBT" ? "BTC" : raw;
}

async function getFuturesUniverse() {
  return { exchange: "Kraken", tickers: await getKrakenFuturesUniverse(), fallbackReason: null };
}

async function getFuturesCandles(exchange, symbol, interval) {
  if (exchange !== "Kraken") throw new Error(`Unknown data source: ${exchange}`);
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

function calculateEntryQualityScore({ side, rsi: rsiValue, rsiSlope, emaDistanceAtr, pullbackState, momentumState, fourHourTrend }) {
  let rawScore = 0;
  const details = { rsi: null, ema: null, pullback: null, momentum: null, trend4h: null };

  if (Number.isFinite(rsiValue) && Number.isFinite(rsiSlope)) {
    if (side === "LONG") {
      if (rsiValue >= 30 && rsiValue <= 45 && rsiSlope > 0) { rawScore += 20; details.rsi = 20; }
      else if (rsiValue > 45 && rsiValue <= 55 && rsiSlope > 0) { rawScore += 10; details.rsi = 10; }
      else if (rsiValue > 70) { rawScore -= 15; details.rsi = -15; }
      else if (rsiValue < 30 && rsiSlope <= 0) { rawScore -= 10; details.rsi = -10; }
      else details.rsi = 0;
    } else if (side === "SHORT") {
      if (rsiValue >= 55 && rsiValue <= 70 && rsiSlope < 0) { rawScore += 20; details.rsi = 20; }
      else if (rsiValue >= 45 && rsiValue < 55 && rsiSlope < 0) { rawScore += 10; details.rsi = 10; }
      else if (rsiValue < 30) { rawScore -= 15; details.rsi = -15; }
      else if (rsiValue > 70 && rsiSlope >= 0) { rawScore -= 10; details.rsi = -10; }
      else details.rsi = 0;
    }
  }

  if (Number.isFinite(emaDistanceAtr)) {
    if (emaDistanceAtr <= 1) { rawScore += 20; details.ema = 20; }
    else if (emaDistanceAtr <= 2) { rawScore += 10; details.ema = 10; }
    else if (emaDistanceAtr <= 3) details.ema = 0;
    else { rawScore -= 20; details.ema = -20; }
  }

  if (pullbackState === "RECLAIM_CONFIRMED") { rawScore += 25; details.pullback = 25; }
  else if (pullbackState === "TOUCHED_ZONE") { rawScore += 10; details.pullback = 10; }
  else if (pullbackState === "NONE") { rawScore -= 15; details.pullback = -15; }

  if (momentumState === "CONFIRMED") { rawScore += 10; details.momentum = 10; }
  else if (momentumState === "NOT_CONFIRMED") { rawScore -= 5; details.momentum = -5; }

  const expectedTrend = side === "LONG" ? "BULLISH" : "BEARISH";
  if (fourHourTrend === expectedTrend) { rawScore += 6; details.trend4h = 6; }
  else if (fourHourTrend === "NEUTRAL") details.trend4h = 0;
  else if (fourHourTrend === "BULLISH" || fourHourTrend === "BEARISH") {
    rawScore -= 6;
    details.trend4h = -6;
  }

  const normalized = Math.max(0, Math.min(100, Math.round(((rawScore + 70) / 155) * 100)));
  const availableFactorCount = Object.values(details).filter(value => value !== null).length;
  return { raw: rawScore, normalized, details, availableFactorCount };
}

function calculateEntryTimingScore({ side, rsi: rsiValue, rsiSlope, emaDistanceAtr, pullbackState, momentumState, reclaimExtensionAtr }) {
  let raw = 0;
  const details = { rsi: null, emaDistance: null, pullback: null, momentumTiming: null, ema9Extension: null };
  if (Number.isFinite(rsiValue) && Number.isFinite(rsiSlope)) {
    if (side === "LONG") {
      if (rsiValue >= 30 && rsiValue <= 45 && rsiSlope > 0) { raw += 20; details.rsi = 20; }
      else if (rsiValue > 45 && rsiValue <= 55 && rsiSlope > 0) { raw += 10; details.rsi = 10; }
      else if (rsiValue > 70) { raw -= 15; details.rsi = -15; }
      else if (rsiValue < 30 && rsiSlope <= 0) { raw -= 10; details.rsi = -10; }
      else details.rsi = 0;
    } else if (side === "SHORT") {
      if (rsiValue >= 55 && rsiValue <= 70 && rsiSlope < 0) { raw += 20; details.rsi = 20; }
      else if (rsiValue >= 45 && rsiValue < 55 && rsiSlope < 0) { raw += 10; details.rsi = 10; }
      else if (rsiValue < 30) { raw -= 15; details.rsi = -15; }
      else if (rsiValue > 70 && rsiSlope >= 0) { raw -= 10; details.rsi = -10; }
      else details.rsi = 0;
    }
  }
  if (Number.isFinite(emaDistanceAtr)) {
    if (emaDistanceAtr <= 1) { raw += 20; details.emaDistance = 20; }
    else if (emaDistanceAtr <= 2) { raw += 10; details.emaDistance = 10; }
    else if (emaDistanceAtr <= 3) details.emaDistance = 0;
    else { raw -= 20; details.emaDistance = -20; }
  }
  if (side === "LONG") {
    if (pullbackState === "RECLAIM_CONFIRMED") { raw += 10; details.pullback = 10; }
    else if (pullbackState === "TOUCHED_ZONE") { raw += 15; details.pullback = 15; }
    else if (pullbackState === "NONE") { raw -= 15; details.pullback = -15; }
  } else if (side === "SHORT") {
    if (pullbackState === "RECLAIM_CONFIRMED") { raw += 25; details.pullback = 25; }
    else if (pullbackState === "TOUCHED_ZONE") { raw += 10; details.pullback = 10; }
    else if (pullbackState === "NONE") { raw -= 15; details.pullback = -15; }
  }
  // Momentum confirmation is useful for direction, but can mean the entry is late.
  if (momentumState === "CONFIRMED") { raw -= 5; details.momentumTiming = -5; }
  else if (momentumState === "NOT_CONFIRMED") { raw += 5; details.momentumTiming = 5; }
  if (Number.isFinite(reclaimExtensionAtr)) {
    const extension = Math.max(0, reclaimExtensionAtr);
    if (extension <= 0.25) { raw += 20; details.ema9Extension = 20; }
    else if (extension <= 0.5) { raw += 15; details.ema9Extension = 15; }
    else if (extension <= 1) { raw += 5; details.ema9Extension = 5; }
    else if (extension <= 1.5) details.ema9Extension = 0;
    else if (extension <= 2) { raw -= 5; details.ema9Extension = -5; }
    else { raw -= 10; details.ema9Extension = -10; }
  }
  const normalized = Math.max(0, Math.min(100, Math.round(((raw + 65) / 155) * 100)));
  return { raw, normalized, details, availableFactorCount: Object.values(details).filter(v => v !== null).length };
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
function passesLongDistanceThreshold(side, candles1h, threshold = 0.005) {
  // Retained as a pure compatibility utility for historical tests only.
  // The restored Kraken Futures 3.8.2 analyzer does not call this LONG-only filter.
  if (side !== "LONG") return true;
  if (!Array.isArray(candles1h) || candles1h.length < 3) return false;
  const last3 = candles1h.slice(-3);
  const referencePrice = Number(last3[2]?.close);
  const maxHigh = Math.max(...last3.map(c => Number(c?.high)));
  if (!Number.isFinite(referencePrice) || !Number.isFinite(maxHigh) || maxHigh <= 0) return false;
  const distance = Math.abs(referencePrice - maxHigh) / maxHigh;
  return Number.isFinite(distance) && distance >= threshold;
}

function evaluateHighRiskFuturesEntryFilters({ ticker, candles1h, candles15m, side, referencePrice, ema20, atr, fourHourOpposes }) {
  const marketPrice = Number(ticker?.last);
  if (!Number.isFinite(marketPrice) || marketPrice <= 0) {
    return { ok: false, rejected: "قیمت لحظه‌ای بازار معتبر نیست" };
  }
  const driftPct = Math.abs(marketPrice - referencePrice) / referencePrice * 100;
  if (driftPct > FUTURES_CONFIG.HIGH_RISK_MAX_ENTRY_DRIFT_PCT) {
    return { ok: false, rejected: "فاصله قیمت لحظه‌ای برای مسیر پرریسک نیز بیش از حد مجاز است", driftPct };
  }

  const emaDistanceAtr = Math.abs(marketPrice - ema20) / atr;
  if (emaDistanceAtr > FUTURES_CONFIG.HIGH_RISK_MAX_ENTRY_EMA_DISTANCE_ATR) {
    return { ok: false, rejected: "قیمت برای ورود پرریسک نیز بیش از حد از EMA20 فاصله دارد", driftPct, emaDistanceAtr };
  }

  const has15mData = Array.isArray(candles15m) && candles15m.length >= 30;
  if (!has15mData) {
    if (fourHourOpposes) {
      return { ok: false, rejected: "روند ۴ساعته مخالف است و داده ۱۵دقیقه‌ای برای تأیید مسیر پرریسک موجود نیست", driftPct, emaDistanceAtr };
    }
    return { ok: true, driftPct, emaDistanceAtr, momentumConfirmed: false, pullbackConfirmed: false, confirmationUnavailable: true };
  }

  const closes15m = candles15m.map(c => c.close);
  const ema9_15m = ema(closes15m, 9);
  const ema21_15m = ema(closes15m, 21);
  const atr15m = calculateAtr(candles15m, 14);
  const last15m = candles15m[candles15m.length - 1];
  if (![ema9_15m, ema21_15m, atr15m].every(Number.isFinite) || atr15m <= 0) {
    if (fourHourOpposes) {
      return { ok: false, rejected: "روند ۴ساعته مخالف است و اندیکاتورهای ۱۵دقیقه‌ای معتبر نیستند", driftPct, emaDistanceAtr };
    }
    return { ok: true, driftPct, emaDistanceAtr, momentumConfirmed: false, pullbackConfirmed: false, confirmationUnavailable: true };
  }

  const momentumConfirmed = side === "LONG"
    ? ema9_15m > ema21_15m && last15m.close > ema9_15m && last15m.close > last15m.open
    : ema9_15m < ema21_15m && last15m.close < ema9_15m && last15m.close < last15m.open;
  const reclaimExtensionAtr = side === "LONG"
    ? (last15m.close - ema9_15m) / atr15m
    : (ema9_15m - last15m.close) / atr15m;
  if (reclaimExtensionAtr > FUTURES_CONFIG.HIGH_RISK_MAX_RECLAIM_EXTENSION_ATR) {
    return { ok: false, rejected: "قیمت پس از حرکت ۱۵دقیقه‌ای بیش از حد از محدوده ورود فاصله گرفته است", driftPct, emaDistanceAtr, reclaimExtensionAtr };
  }
  if (fourHourOpposes && !momentumConfirmed) {
    return { ok: false, rejected: "روند ۴ساعته مخالف است و مومنتوم ۱۵دقیقه‌ای هم‌جهت تأیید نشد", driftPct, emaDistanceAtr, reclaimExtensionAtr, momentumConfirmed };
  }

  return { ok: true, driftPct, emaDistanceAtr, reclaimExtensionAtr, ema9_15m, ema21_15m, atr15m,
    momentumConfirmed, pullbackConfirmed: false, fourHourOpposes };
}
function analyzeFuturesSymbol(ticker, candles1h, candles4h, candles15m, options = {}) {
  if (candles1h.length < FUTURES_CONFIG.MIN_CANDLES || candles4h.length < FUTURES_CONFIG.MIN_CANDLES) {
    throw new Error("تعداد کندل بسته‌شده برای تحلیل ۱ساعته/۴ساعته کافی نیست.");
  }
  const closes1h = candles1h.map(c => c.close);
  const closes4h = candles4h.map(c => c.close);
  const last = candles1h[candles1h.length - 1];
  const referencePrice = last.close;
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
  const up1h = e20 > e50 && referencePrice > e20;
  const down1h = e20 < e50 && referencePrice < e20;
  const up4h = e20_4h > e50_4h;
  const down4h = e20_4h < e50_4h;
  const fourHourTrend = up4h ? "BULLISH" : down4h ? "BEARISH" : "NEUTRAL";
  let side = null;
  let score = 0;
  const reasons = [];

  const strictLong = up1h && up4h && rsiValue >= 48 && rsiValue <= 69;
  const strictShort = down1h && down4h && rsiValue >= 31 && rsiValue <= 52;
  const relaxedLong = up1h && rsiValue >= FUTURES_CONFIG.HIGH_RISK_LONG_RSI_MIN && rsiValue <= FUTURES_CONFIG.HIGH_RISK_LONG_RSI_MAX;
  const relaxedShort = down1h && rsiValue >= FUTURES_CONFIG.HIGH_RISK_SHORT_RSI_MIN && rsiValue <= FUTURES_CONFIG.HIGH_RISK_SHORT_RSI_MAX;
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

  const fourHourOpposes = side === "LONG" ? down4h : up4h;
  const standardThresholdMet = strictSetup &&
    score >= FUTURES_CONFIG.MIN_SCORE &&
    volumeRatio >= 0.75;
  let standardEntryPassed = false;
  let entryFilters;

  if (options.skipEntryFilters) {
    entryFilters = { ok: true, skippedForBaseline: true };
    standardEntryPassed = standardThresholdMet;
  } else if (standardThresholdMet) {
    const strictEntryFilters = evaluateFuturesEntryFilters({
      ticker, candles1h, candles15m, side, referencePrice, ema20: e20, atr
    });
    if (strictEntryFilters.ok) {
      entryFilters = strictEntryFilters;
      standardEntryPassed = true;
    } else {
      // A strict candidate that misses the standard entry rules may still qualify
      // through the independent high-risk path, for both LONG and SHORT.
      const flexibleEntryFilters = evaluateHighRiskFuturesEntryFilters({
        ticker, candles1h, candles15m, side, referencePrice, ema20: e20, atr, fourHourOpposes
      });
      entryFilters = flexibleEntryFilters.ok
        ? { ...flexibleEntryFilters, strictEntryRejected: strictEntryFilters.rejected, highRiskFallback: true }
        : { ...flexibleEntryFilters, strictEntryRejected: strictEntryFilters.rejected };
    }
  } else {
    // Do not let strictSetup alone block a candidate from the relaxed path:
    // score/volume misses and strict-vs-flexible entry differences are fallback cases.
    entryFilters = evaluateHighRiskFuturesEntryFilters({
      ticker, candles1h, candles15m, side, referencePrice, ema20: e20, atr, fourHourOpposes
    });
  }

  if (!entryFilters.ok) {
    return {
      symbol: ticker.symbol,
      side,
      score: Math.max(0, Math.min(100, Math.round(score))),
      rejected: entryFilters.rejected,
      entryDiagnostics: entryFilters
    };
  }
  reasons.push("قیمت لحظه‌ای در محدوده مجاز قیمت تحلیلی است");
  reasons.push("فاصله قیمت از EMA20 برای ورود قابل‌قبول است");
  if (entryFilters.momentumConfirmed && entryFilters.pullbackConfirmed) {
    reasons.push("مومنتوم و پولبک ۱۵دقیقه‌ای تأیید شدند");
  } else if (!strictSetup && fourHourOpposes && entryFilters.momentumConfirmed) {
    reasons.push("با وجود مخالفت روند ۴ساعته، مومنتوم ۱۵دقیقه‌ای هم‌جهت تأیید شد");
  } else {
    reasons.push("تأیید ۱۵دقیقه‌ای کامل نبود؛ مسیر پرریسک با محدودیت‌های مستقل ارزیابی شد");
  }

  const entry = options.skipEntryFilters ? referencePrice : Number(ticker.last);
  const swing = candles1h.slice(-8, -1);
  const swingLow = Math.min(...swing.map(c => c.low));
  const swingHigh = Math.max(...swing.map(c => c.high));
  let stop = side === "LONG"
    ? Math.min(swingLow, entry - atr * 1.5)
    : Math.max(swingHigh, entry + atr * 1.5);
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
  const eligible = standardEntryPassed;
  const highRiskEligible = !standardEntryPassed &&
    score >= FUTURES_CONFIG.HIGH_RISK_MIN_SCORE &&
    volumeRatio >= FUTURES_CONFIG.HIGH_RISK_MIN_VOLUME_RATIO;
  if (highRiskEligible) reasons.push("این سیگنال فقط از مسیر مستقل منعطف عبور کرده و پرریسک طبقه‌بندی شده است");
  return {
    symbol: ticker.symbol,
    side,
    score,
    riskLevel: highRiskEligible ? "HIGH_RISK" : "STANDARD",
    price: entry,
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
    entryDiagnostics: entryFilters,
    eligible: eligible || highRiskEligible,
    highRiskEligible,
    fourHourTrend,
    momentumConfirmed: Boolean(entryFilters.momentumConfirmed),
    pullbackConfirmed: Boolean(entryFilters.pullbackConfirmed),
    baseScore: score,
    priorityScore: score,
    volumePriorityBonus: 0,
    fourHourScoreAdjustment: 0,
    confirmationPriorityBonus: 0,
    confirmationCount: Number(Boolean(entryFilters.momentumConfirmed)) + Number(Boolean(entryFilters.pullbackConfirmed))
  };
}
function formatPrice(value) {
  const price = Number(value);
  if (!Number.isFinite(price)) return "—";
  return price.toLocaleString("en-US", { maximumFractionDigits: 8 });
}

function formatFuturesSignal(item, index = 1) {
  const sideLabel = item.side === "LONG" ? "LONG 🟢" : "SHORT 🔴";
  const symbol = escapeTelegramHtml(formatFuturesSymbol(item.symbol) + "/USDT");
  const lines = [
    `<b>${symbol}</b>`,
    `<b>${sideLabel}</b>`,
    "",
    `Entry Zone 1 : ${formatSignalDisplayPrice(item.entry)}`,
    `Entry Zone 2 : ${formatSignalDisplayPrice(displayEntryPrice(item.entry, item.side))}`,
    "",
    `🎯 TP 1 : ${formatSignalDisplayPrice(item.target1)}`,
    `🎯 TP 2 : ${formatSignalDisplayPrice(item.target2)}`,
    `🎯 TP 3 : ${formatSignalDisplayPrice(item.target3)}`,
    "",
    `⛔ SL : ${formatSignalDisplayPrice(item.stop)}`
  ];
  return lines.map(line => `\u200E${line}`).join("\n");
}

function formatSignalDisplayPrice(value) {
  const price = Number(value);
  return Number.isFinite(price)
    ? price.toLocaleString("en-US", { useGrouping: false, maximumFractionDigits: 8 })
    : "—";
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

function formatPerpetualLabel(symbol) {
  const base = formatFuturesSymbol(symbol);
  const names = { BTC: "Bitcoin", ETH: "Ethereum", SOL: "Solana", XRP: "XRP" };
  return `${names[base] || base} Perpetual`;
}


async function getOpenFuturesTrades(env) {
  if (!env.SIGNAL_DELIVERY || !getSignalDeliverySecret(env)) throw new Error("Durable signal storage is required.");
  const stub = env.SIGNAL_DELIVERY.get(env.SIGNAL_DELIVERY.idFromName("global:active-futures-signals"));
  const response = await stub.fetch("https://signal-delivery.internal/trades/list", {
    method: "POST", headers: { "content-type": "application/json", "x-signal-delivery-secret": getSignalDeliverySecret(env) },
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
    method: "POST", headers: { "content-type": "application/json", "x-signal-delivery-secret": getSignalDeliverySecret(env) },
    body: JSON.stringify({ trades: updates })
  });
  const payload = await response.json();
  if (!response.ok || !payload?.ok) throw new Error(payload?.error || "Durable trade update failed.");
  return payload;
}

async function monitorOpenFuturesTrades(env, now = Date.now()) {
  const trades = await getOpenFuturesTrades(env);
  const openTrades = trades.filter(t => t?.status === "OPEN");
  if (!openTrades.length) return { checked: 0, closed: 0, errors: 0, errorDetails: [], stuckCount: 0, stuckTrades: [] };
  const symbols = [...new Set(openTrades.map(t => t.symbol).filter(Boolean))];
  const updates = [];
  const errorDetails = [];
  let checked = 0, closed = 0, errors = 0;
  const timestamp = new Date(now).toISOString();
  const recordError = (trade, stage, error) => {
    const detail = {
      tradeId: String(trade.id || ""),
      symbol: String(trade.symbol || ""),
      side: String(trade.side || ""),
      stage,
      message: String(error?.message || error).slice(0, 400),
      at: timestamp
    };
    errorDetails.push(detail);
    const history = [...(Array.isArray(trade.monitorErrorHistory) ? trade.monitorErrorHistory : []), detail].slice(-5);
    updates.push({ ...trade, lastMonitorAttemptAt: timestamp, lastMonitorError: detail, monitorErrorAt: timestamp, monitorErrorHistory: history });
    errors++;
    console.error("FUTURES_TRADE_MONITOR_ERROR", JSON.stringify(detail));
  };
  await mapLimit(symbols, 3, async symbol => {
    const symbolTrades = openTrades.filter(t => t.symbol === symbol);
    let candles;
    try {
      const marketData = await getKrakenFuturesCandlesViaCoordinator(env, symbol, ["5m"]);
      if (marketData.errors?.["5m"]) throw new Error(marketData.errors["5m"]);
      candles = marketData.candles["5m"];
    } catch (error) {
      for (const trade of symbolTrades) recordError(trade, "CANDLE_FETCH", error);
      return;
    }
    for (const original of symbolTrades) {
      let trade = { ...original, lastMonitorAttemptAt: timestamp };
      try {
        const freshCandles = getNewClosedFuturesCandles(candles, trade.lastCheckedCandleTime);
        if (!freshCandles.length) continue;
        for (const candle of freshCandles) {
          const result = evaluateStagedTradeCandle(trade, { ...candle, time: Number(candle.time) + 300000 });
          trade = {
            ...trade,
            lastPrice: candle.close,
            lastCheckedAt: timestamp,
            lastCheckedCandleTime: Number(candle.time),
            lastMonitorError: null
          };
          checked++;
          if (result.changed || result.closed) {
            trade = {
              ...result.trade, lastPrice: candle.close, lastCheckedAt: timestamp,
              lastCheckedCandleTime: Number(candle.time), lastMonitorAttemptAt: timestamp,
              lastMonitorError: null
            };
          }
          if (result.closed) {
            closed++;
            break;
          }
        }
        updates.push(trade);
      } catch (error) {
        recordError(original, "CANDLE_EVALUATION", error);
      }
    }
  });
  let persistenceError = null;
  if (updates.length) {
    try {
      await persistFuturesTradeUpdates(env, updates);
    } catch (error) {
      errors++;
      persistenceError = String(error?.message || error).slice(0, 400);
      errorDetails.push({ stage: "PERSISTENCE", message: persistenceError, at: timestamp });
      console.error("FUTURES_TRADE_MONITOR_PERSISTENCE_ERROR", persistenceError);
    }
  }
  const stuckTrades = openTrades.filter(trade => {
    const lastChecked = Date.parse(trade.lastCheckedAt || trade.createdAt || 0);
    return !Number.isFinite(lastChecked) || now - lastChecked >= CONFIG.TRADE_MONITOR_STUCK_AFTER_MS;
  }).map(trade => ({
    tradeId: String(trade.id || ""), symbol: String(trade.symbol || ""),
    side: String(trade.side || ""), lastCheckedAt: trade.lastCheckedAt || null,
    ageMs: Math.max(0, now - (Date.parse(trade.lastCheckedAt || trade.createdAt || 0) || 0))
  }));
  return { checked, closed, errors, errorDetails: errorDetails.slice(0, 12), stuckCount: stuckTrades.length, stuckTrades: stuckTrades.slice(0, 10), persistenceError };
}

async function registerPendingFuturesSignals(env, candidates) {
  if (!env.SIGNAL_DELIVERY || !getSignalDeliverySecret(env)) throw new Error("Durable signal storage is required.");
  const stub = env.SIGNAL_DELIVERY.get(env.SIGNAL_DELIVERY.idFromName("global:active-futures-signals"));
  const response = await stub.fetch("https://signal-delivery.internal/signals/register", {
    method: "POST", headers: { "content-type": "application/json", "x-signal-delivery-secret": getSignalDeliverySecret(env) },
    body: JSON.stringify({ signals: Array.isArray(candidates) ? candidates : [] })
  });
  const payload = await response.json();
  if (!response.ok || !payload?.ok || !Array.isArray(payload.signals)) throw new Error(payload?.error || "Durable pending-signal registration failed.");
  if (payload.registrationDiagnostics) {
    console.log("FUTURES_SIGNAL_REGISTRATION_DIAGNOSTICS", JSON.stringify({
      timestamp: new Date().toISOString(),
      received: Array.isArray(candidates) ? candidates.length : 0,
      registered: payload.signals.length,
      ...payload.registrationDiagnostics
    }));
  }
  return payload.signals;
}
const tradeDir=side=>side==="LONG"?1:-1;
const targetReached=(side,p,t)=>side==="LONG"?p>=t:p<=t;
const stopReached=(side,p,t)=>side==="LONG"?p<=t:p>=t;
const FUTURES_DISPLAY_LEVERAGE=10;
function priceChangePercent(side,entry,exit){const e=Number(entry),x=Number(exit);return Number.isFinite(e)&&e>0&&Number.isFinite(x)?tradeDir(side)*(x-e)/e*100:null}
function leveragedPriceChangePercent(side,entry,exit){const p=priceChangePercent(side,entry,exit);return p===null?null:p*FUTURES_DISPLAY_LEVERAGE}
function formatOutcomePercent(value){if(value===null||value===undefined||value==="")return "—";const n=Number(value);if(!Number.isFinite(n))return "—";const label=n>0?"PROFIT":n<0?"LOSS":"BREAKEVEN";return `${Math.abs(n).toFixed(2)}% ${label}`}
function tradeResultR(t,includeRemainder){const risk=Number(t.initialRisk),entry=Number(t.actualEntry),target=Number(t.target1);if(!Number.isFinite(risk)||risk<=0||!Number.isFinite(entry)||entry<=0)return null;if((t.tpHits||[]).includes("TP1")&&Number.isFinite(target))return tradeDir(t.side)*(target-entry)/risk;return includeRemainder?tradeDir(t.side)*(Number(t.currentStop)-entry)/risk:0}
function tradeOutcomePercent(t,exitPrice){const realized=Number(t?.marginReturnPercent??t?.realizedMarginReturnPct);if(Number.isFinite(realized))return realized;const e=Number(t.actualEntry??t.entry);if(!Number.isFinite(e)||e<=0)return null;const exit=(t.tpHits||[]).includes("TP1")?Number(t.target1):Number(exitPrice);const p=priceChangePercent(t.side,e,exit);return p===null?null:p*FUTURES_DISPLAY_LEVERAGE}
function getNewClosedFuturesCandles(candles,lastCheckedCandleTime=0){return(Array.isArray(candles)?candles:[]).filter(c=>Number(c.time)>Number(lastCheckedCandleTime||0)).sort((a,b)=>a.time-b.time)}
function ensureTradeTrackingCheckpoint(trade,now=Date.now()){if(!Number.isFinite(Number(trade?.lastCheckedCandleTime))||Number(trade.lastCheckedCandleTime)<=0){trade.lastCheckedCandleTime=Math.floor(now/60000)*60000;trade.trackingMode=trade.trackingMode||"LEGACY_CONTINUED";return true}return false}
function isValidFuturesSignalLevels(signal){const entry=Number(signal?.entry),stop=Number(signal?.stop),targets=[Number(signal?.target1),Number(signal?.target2),Number(signal?.target3)];if(!signal?.id||!signal?.symbol||!["LONG","SHORT"].includes(signal?.side)||![entry,stop,...targets].every(Number.isFinite)||![entry,stop,...targets].every(v=>v>0))return false;return signal.side==="LONG"?stop<entry&&entry<targets[0]&&targets[0]<targets[1]&&targets[1]<targets[2]:stop>entry&&entry>targets[0]&&targets[0]>targets[1]&&targets[1]>targets[2]}
function createTrackedFuturesTrade(signal,chatId){if(!isValidFuturesSignalLevels(signal))return null;const entry=Number(signal.entry),stop=Number(signal.stop),createdAt=Date.now();return{id:crypto.randomUUID(),signalId:signal.id,chatId:String(chatId),symbol:signal.symbol,exchange:signal.exchange||"Kraken",side:signal.side,tier:"STANDARD",strategyId:signal.strategyId||"kraken-futures-engine",strategyName:signal.strategyName||"Kraken Futures 3.8.2",reason:signal.reason||"",plannedEntry:entry,actualEntry:entry,initialStop:stop,currentStop:stop,target1:Number(signal.target1),target2:Number(signal.target2),target3:Number(signal.target3),initialRisk:tradeDir(signal.side)*(entry-stop),tpHits:[],status:"OPEN",trackingMode:"SIGNAL_EVALUATION",createdAt:new Date(createdAt).toISOString(),lastPrice:entry,lastCheckedAt:new Date(createdAt).toISOString(),lastCheckedCandleTime:Math.floor(createdAt/60000)*60000}}
async function persistSignalOutboxMirror(env,chatId,signalId,record,label){
  if(!env.APP_KV)return false;
  try{
    await env.APP_KV.put(signalOutboxKey(chatId,signalId),JSON.stringify(record));
    return true;
  }catch(error){
    console.error(label,String(error?.message||error));
    return false;
  }
}

async function signalDeliveryRequest(env, stub, path, body) {
  const response = await stub.fetch("https://signal-delivery.internal" + path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-signal-delivery-secret": getSignalDeliverySecret(env) },
    body: JSON.stringify(body)
  });
  let payload;
  try { payload = await response.json(); }
  catch { throw new Error("Signal delivery coordinator returned an unreadable response."); }
  if (!response.ok || !payload?.ok) throw new Error(payload?.error || "Signal delivery coordinator failed.");
  return payload.result;
}

async function publishSignalToArchive(env, signal, messageText, parseMode = "HTML", options = {}) {
  const channelId = archiveChannelId(env);
  if (!channelId) throw new Error("SIGNAL_ARCHIVE_CHANNEL_ID is missing or invalid; signal was not published.");
  if (!env.SIGNAL_DELIVERY || !getSignalDeliverySecret(env)) throw new Error("Archive publishing requires SIGNAL_DELIVERY coordination.");

  const stub = env.SIGNAL_DELIVERY.get(env.SIGNAL_DELIVERY.idFromName("global:signal-archive-publisher"));
  const reservation = await signalDeliveryRequest(env, stub, "/archive-publish/reserve", {
    channelId, signalId: String(signal.id), force: options.force === true
  });
  if (reservation?.duplicate) {
    if (reservation.pending) return { published: false, duplicate: true, pending: true, messageId: null };
    if (reservation.uncertain) throw new Error("Archive delivery is uncertain; inspect the archive before retrying.");
    return { published: reservation.published === true, duplicate: true, messageId: reservation.messageId ?? null };
  }

  let sent;
  try {
    sent = await sendSignalCardOrText(env, channelId, signal, messageText, null, parseMode || "HTML");
  } catch (error) {
    try {
      await signalDeliveryRequest(env, stub, "/archive-publish/complete", {
        signalId: String(signal.id),
        status: "UNCERTAIN",
        error: String(error?.message || error).slice(0, 500)
      });
    } catch (stateError) {
      console.error("ARCHIVE_UNCERTAIN_STATE_PERSIST_FAILED", String(stateError?.message || stateError));
    }
    throw error;
  }

  const messageId = sent?.result?.message_id ?? null;
  try {
    await signalDeliveryRequest(env, stub, "/archive-publish/complete", {
      signalId: String(signal.id), status: "PUBLISHED", messageId
    });
  } catch (stateError) {
    // The Telegram send succeeded. Leave the DO reservation in place so a
    // later attempt cannot blindly publish a duplicate archive message.
    console.error("ARCHIVE_PUBLISHED_STATE_CONFIRMATION_FAILED", String(stateError?.message || stateError));
  }
  return { published: true, messageId };
}

async function sendAndArchiveFuturesSignal(env, chatId, signal, messageText, replyMarkup = null, parseMode = "HTML", options = {}) {
  if (!signal?.id || !signal?.symbol || !["LONG", "SHORT"].includes(signal?.side)) {
    throw new Error("Signal is missing a valid id, symbol, or direction.");
  }
  if (!isValidFuturesSignalLevels(signal)) {
    throw new Error("Signal price levels are invalid or not correctly ordered; refusing to publish an untrackable signal.");
  }
  if (!env.SIGNAL_DELIVERY || !getSignalDeliverySecret(env)) {
    throw new Error("SIGNAL_DELIVERY Durable Object binding and authentication secret are required.");
  }

  const key = signalOutboxKey(chatId, signal.id);
  const stub = env.SIGNAL_DELIVERY.get(env.SIGNAL_DELIVERY.idFromName(key));
  const reservation = await signalDeliveryRequest(env, stub, "/deliver/reserve", {
    chatId: String(chatId), signal, messageText, replyMarkup, parseMode
  });
  if (reservation?.duplicate) {
    return { delivered: true, duplicate: true, archivePending: reservation.archivePending === true };
  }

  const record = reservation.record;
  let response;
  let deliveryError = null;
  let retryAttempts = 0;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      response = await sendSignalCardOrText(env, chatId, signal, messageText, replyMarkup, parseMode);
      deliveryError = null;
      break;
    } catch (error) {
      deliveryError = error;
      const status = Number(error?.telegramStatus);
      const retryAfter = Number(error?.telegramRetryAfter) || 0;
      // Telegram 429 is an explicit rejection. Network/5xx failures stay
      // UNCERTAIN because retrying them could create duplicate notifications.
      if (status !== 429 || attempt >= 3 || retryAfter > 5) break;
      retryAttempts++;
      await new Promise(resolve => setTimeout(resolve, Math.max(1000, retryAfter * 1000)));
    }
  }

  if (deliveryError) {
    const uncertain = {
      status: "UNCERTAIN", retryAttempts,
      error: String(deliveryError?.message || deliveryError).slice(0, 500)
    };
    try {
      await signalDeliveryRequest(env, stub, "/deliver/complete", {
        chatId: String(chatId), signalId: String(signal.id), ...uncertain
      });
    } catch (stateError) {
      console.error("UNCERTAIN_DELIVERY_STATE_PERSIST_FAILED", String(stateError?.message || stateError));
    }
    await persistSignalOutboxMirror(env, chatId, signal.id, {
      ...record, ...uncertain, updatedAt: new Date().toISOString()
    }, "UNCERTAIN_OUTBOX_KV_PERSIST_FAILED");
    throw deliveryError;
  }

  const sentRecord = {
    status: "SENT",
    telegramMessageId: response?.result?.message_id ?? null,
    sentAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  try {
    await signalDeliveryRequest(env, stub, "/deliver/complete", {
      chatId: String(chatId), signalId: String(signal.id), ...sentRecord
    });
  } catch (stateError) {
    const uncertain = {
      ...record, status: "UNCERTAIN",
      telegramMessageId: sentRecord.telegramMessageId,
      error: "Telegram accepted the message but durable delivery state confirmation failed.",
      updatedAt: new Date().toISOString()
    };
    await persistSignalOutboxMirror(env, chatId, signal.id, uncertain, "UNCERTAIN_OUTBOX_KV_PERSIST_FAILED");
    throw new Error(uncertain.error + " Manual reconciliation is required.");
  }
  let currentRecord = { ...record, ...sentRecord };
  await persistSignalOutboxMirror(env, chatId, signal.id, currentRecord, "SIGNAL_OUTBOX_SENT_MIRROR_FAILED");

  if (options.archive === false) {
    return { delivered: true, duplicate: false, archivePending: false, archiveDeferred: true };
  }

  try {
    const archiveResult = await publishSignalToArchive(env, signal, messageText, parseMode);
    const archiveComplete = archiveResult?.skipped === true || archiveResult?.published === true ||
      (archiveResult?.duplicate === true && archiveResult?.pending !== true);
    currentRecord = {
      ...currentRecord,
      status: archiveComplete ? "ARCHIVED" : "ARCHIVE_PENDING",
      archivePublished: archiveComplete,
      archiveMessageId: archiveResult?.messageId ?? null,
      ...(archiveComplete ? { archivedAt: new Date().toISOString() } : {
        archivePublishError: archiveResult?.pending ? "Archive publication is already in progress for this signal." : "Archive publication is pending."
      }),
      updatedAt: new Date().toISOString()
    };
  } catch (error) {
    currentRecord = {
      ...currentRecord,
      status: "ARCHIVE_PENDING",
      archivePublished: false,
      archivePublishError: String(error?.message || error).slice(0, 500),
      updatedAt: new Date().toISOString()
    };
    console.error("Archive failed; private signal delivery remains successful and archive retry is available:", signal.symbol, String(error?.message || error));
  }

  try {
    await signalDeliveryRequest(env, stub, "/deliver/complete", {
      chatId: String(chatId), signalId: String(signal.id),
      status: currentRecord.status,
      archivePublished: currentRecord.archivePublished,
      archiveMessageId: currentRecord.archiveMessageId,
      archivedAt: currentRecord.archivedAt,
      archivePublishError: currentRecord.archivePublishError,
      updatedAt: currentRecord.updatedAt
    });
  } catch (stateError) {
    console.error("SIGNAL_OUTBOX_FINAL_STATE_CONFIRMATION_FAILED", String(stateError?.message || stateError));
  }
  await persistSignalOutboxMirror(env, chatId, signal.id, currentRecord, "SIGNAL_OUTBOX_FINAL_MIRROR_FAILED");
  return { delivered: true, duplicate: false, archivePending: currentRecord.status === "ARCHIVE_PENDING" };
}

export class SignalDeliveryCoordinator {
  constructor(ctx,env){
    this.ctx=ctx;
    this.env=env;
    this.serial=createSerialExecutor();
  }
  async fetch(request){
    const url=new URL(request.url);
    if(request.method!=="POST"||!["/deliver/reserve","/deliver/complete","/archive-publish/reserve","/archive-publish/complete","/scan-lock/acquire","/scan-lock/release","/kv-write/allow","/kv-write/pause","/signals/register","/signals/list","/trades/list","/trades/update"].includes(url.pathname))return new Response("Not found",{status:404});
    const expectedSecret=getSignalDeliverySecret(this.env);
    const suppliedSecret=request.headers.get("x-signal-delivery-secret");
    if(!(await verifySignalDeliverySecret(suppliedSecret,expectedSecret)))return Response.json({ok:false,error:"Unauthorized."},{status:401});
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
              lastCheckedCandleTime:Math.max(Number(existing.lastCheckedCandleTime)||0,Number(candidate.lastCheckedCandleTime)||0),
              lastMonitorAttemptAt:candidate.lastMonitorAttemptAt||existing.lastMonitorAttemptAt,
              lastMonitorError:candidate.lastMonitorError===null?null:(candidate.lastMonitorError||existing.lastMonitorError),
              monitorErrorAt:candidate.monitorErrorAt||existing.monitorErrorAt,
              monitorErrorHistory:Array.isArray(candidate.monitorErrorHistory)
                ? candidate.monitorErrorHistory.slice(-5)
                : (existing.monitorErrorHistory||[]),
              tpHits:Array.isArray(candidate.tpHits)?candidate.tpHits:existing.tpHits,
              remainingFraction:Number.isFinite(Number(candidate.remainingFraction))?Number(candidate.remainingFraction):existing.remainingFraction,
              realizedMarginReturnPct:Number.isFinite(Number(candidate.realizedMarginReturnPct))?Number(candidate.realizedMarginReturnPct):existing.realizedMarginReturnPct,
              currentStop:Number.isFinite(Number(candidate.currentStop))?Number(candidate.currentStop):existing.currentStop,
              breakEvenActivated:candidate.breakEvenActivated===true||existing.breakEvenActivated===true
            };
            if(["CLOSED_PROFIT","CLOSED_STOP","CLOSED_MANUAL"].includes(candidate.status)){
              next.status=candidate.status;
              next.closeReason=candidate.closeReason||candidate.status;
              next.exitPrice=Number(candidate.exitPrice);
              next.closePriceChangePercent=Number(candidate.closePriceChangePercent);
              next.marginReturnPercent=Number(candidate.marginReturnPercent);
              next.realizedMarginReturnPct=Number(candidate.realizedMarginReturnPct??candidate.marginReturnPercent);
              next.remainingFraction=0;
              next.tpHits=Array.isArray(candidate.tpHits)?candidate.tpHits:next.tpHits;
              next.currentStop=Number(candidate.currentStop)||next.currentStop;
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
          await this.ctx.storage.transaction(async transaction => {
            await transaction.put("active-futures-trades",[...open,...history]);
            if(closed){
              const pending=await transaction.get("active-futures-pending")||[];
              await transaction.put("active-futures-pending",pending.filter(s=>!releasedSignalIds.has(String(s.id))));
            }
          });
          return Response.json({ok:true,updated,closed,open:open.length});
        }
        if(url.pathname==="/signals/register"){
          const now=Date.now();
          const current=await this.ctx.storage.get("active-futures-pending")||[];
          const trades=await this.ctx.storage.get("active-futures-trades")||[];
          const closedSignalIds=new Set(trades.filter(t=>["CLOSED_PROFIT","CLOSED_STOP","CLOSED_MANUAL"].includes(t?.status)).map(t=>String(t.signalId)));
          const active=current.filter(x=>Number(x?.expiresAt)>now&&x?.symbol&&["LONG","SHORT"].includes(x?.side)&&!closedSignalIds.has(String(x?.id)));
          const activeKeys=new Set(active.map(x=>String(x.symbol).trim().toUpperCase()+"|"+x.side));
          // An OPEN tracked trade owns its symbol-side until the lifecycle monitor
          // confirms either the stop or the 30% margin-profit close condition.
          // Pending-alert TTL expiry must not unlock a trade that is still OPEN.
          const openTradeKeys=new Set(trades
            .filter(t=>t?.status==="OPEN"&&t?.symbol&&["LONG","SHORT"].includes(t?.side))
            .map(t=>String(t.symbol).trim().toUpperCase()+"|"+t.side));
          const today=new Date(now).toISOString().slice(0,10);
          const storedDirectionLocks=await this.ctx.storage.get("daily-signal-direction-locks");
          const directionLocks=storedDirectionLocks?.day===today
            ? {...(storedDirectionLocks.symbols||{})}
            : {};
          const utcDayOf=value=>{
            const raw=String(value??"");
            const timestamp=typeof value==="number"||/^\d+$/.test(raw)?Number(value):Date.parse(raw);
            return Number.isFinite(timestamp)&&timestamp>0?new Date(timestamp).toISOString().slice(0,10):null;
          };
          // Rebuild today's lock from already-issued signals/trades as a migration-safe fallback.
          for(const item of active){
            if(utcDayOf(item.createdAt)===today&&item.symbol&&["LONG","SHORT"].includes(item.side)){
              directionLocks[String(item.symbol).trim().toUpperCase()] ||= item.side;
            }
          }
          for(const trade of trades){
            if(utcDayOf(trade.createdAt)===today&&trade.symbol&&["LONG","SHORT"].includes(trade.side)){
              directionLocks[String(trade.symbol).trim().toUpperCase()] ||= trade.side;
            }
          }
          const openDirectionBySymbol=new Map(trades
            .filter(t=>t?.status==="OPEN"&&t?.symbol&&["LONG","SHORT"].includes(t?.side))
            .map(t=>[String(t.symbol).trim().toUpperCase(),t.side]));
          const seen=new Set();
          const fresh=[];
          const newTrades=[];
          const registrationDiagnostics={invalid:0,blockedByOpenOpposite:0,blockedByDailyDirectionLock:0,blockedByActiveSameSide:0,blockedByOpenSameSide:0,duplicateInBatch:0,expired:0};
          for(const signal of Array.isArray(payload.signals)?payload.signals:[]){
            if(!signal?.id||!signal?.symbol||!["LONG","SHORT"].includes(signal?.side)||!isValidFuturesSignalLevels(signal)){registrationDiagnostics.invalid++;continue;}
            const symbol=String(signal.symbol).trim().toUpperCase();
            const key=symbol+"|"+signal.side;
            // Never allow an opposite signal while a trade is OPEN or after the symbol
            // has already emitted the other direction during this UTC day.
            if(openDirectionBySymbol.has(symbol)&&openDirectionBySymbol.get(symbol)!==signal.side){registrationDiagnostics.blockedByOpenOpposite++;continue;}
            if(directionLocks[symbol]&&directionLocks[symbol]!==signal.side){registrationDiagnostics.blockedByDailyDirectionLock++;continue;}
            if(activeKeys.has(key)){registrationDiagnostics.blockedByActiveSameSide++;continue;}
            if(openTradeKeys.has(key)){registrationDiagnostics.blockedByOpenSameSide++;continue;}
            if(seen.has(key)){registrationDiagnostics.duplicateInBatch++;continue;}
            const suppliedCreatedAt=Number(signal.createdAt);
            const createdAt=Number.isFinite(suppliedCreatedAt)&&suppliedCreatedAt>0?suppliedCreatedAt:now;
            const suppliedExpiry=Number(signal.expiresAt);
            // Preserve a valid explicit expiry, but never register an already-expired
            // candidate or create an OPEN tracking record for a signal that cannot be sent.
            const expiresAt=Number.isFinite(suppliedExpiry)&&signal.expiresAt!=null&&signal.expiresAt!==""
              ? suppliedExpiry
              : createdAt+FUTURES_CONFIG.SIGNAL_TTL_MINUTES*60000;
            if(!Number.isFinite(expiresAt)||expiresAt<=now){registrationDiagnostics.expired++;continue;}
            const normalizedSignal={...signal,createdAt,expiresAt};
            seen.add(key);fresh.push(normalizedSignal);
            directionLocks[symbol]=signal.side;
            const trade=createTrackedFuturesTrade(normalizedSignal,"signal-evaluation");
            if(trade)newTrades.push(trade);
          }
          const merged=[...active,...fresh].slice(-150);
          const open=trades.filter(t=>t?.status==="OPEN");
          const history=trades.filter(t=>t?.status!=="OPEN").slice(-500);
          // Keep the pending signal and its tracking record in one Durable Object
          // transaction so a failed second write cannot leave an orphaned OPEN trade.
          await this.ctx.storage.transaction(async transaction => {
            if(newTrades.length) {
              await transaction.put("active-futures-trades",[...open,...history,...newTrades]);
            }
            await transaction.put("active-futures-pending",merged);
            if(fresh.length||storedDirectionLocks?.day!==today){
              await transaction.put("daily-signal-direction-locks",{day:today,symbols:directionLocks});
            }
          });
          return Response.json({ok:true,signals:fresh,trackedTrades:newTrades.length,registrationDiagnostics});
        }
        if(url.pathname==="/scan-lock/acquire"){
          const current=await this.ctx.storage.get("automatic-futures-scan-lock");
          const now=Date.now();
          const token=String(payload.token||"");
          if(!token)throw new Error("Scan lock token is required.");
          if(current&&Number(current.expiresAt)>now)return Response.json({ok:true,acquired:false});
          await this.ctx.storage.put("automatic-futures-scan-lock",{token,acquiredAt:now,expiresAt:now+600000});
          return Response.json({ok:true,acquired:true,expiresAt:now+600000});
        }
        if(url.pathname==="/scan-lock/release"){
          const current=await this.ctx.storage.get("automatic-futures-scan-lock");
          if(!current)return Response.json({ok:true,released:false,reason:"lock not found"});
          if(!payload.token||payload.token!==current.token)return Response.json({ok:true,released:false,reason:"lock token mismatch"});
          await this.ctx.storage.delete("automatic-futures-scan-lock");
          return Response.json({ok:true,released:true});
        }
        if(url.pathname==="/deliver/reserve"){
          const chatId=String(payload.chatId||"");
          const signal=payload.signal;
          if(!chatId||!signal?.id||!signal?.symbol||!["LONG","SHORT"].includes(signal?.side))throw new Error("Signal delivery payload is invalid.");
          if(!isValidFuturesSignalLevels(signal))throw new Error("Signal price levels are invalid or not correctly ordered.");
          const key="signal-outbox:"+signalOutboxKey(chatId,signal.id);
          const old=await this.ctx.storage.get(key);
          if(old?.status==="SENT"||old?.status==="ARCHIVE_PENDING")return Response.json({ok:true,result:{duplicate:true,archivePending:true}});
          if(old?.status==="ARCHIVED")return Response.json({ok:true,result:{duplicate:true,archivePending:false}});
          if(old?.status==="SENDING"||old?.status==="UNCERTAIN")throw new Error("Signal delivery is uncertain and requires manual reconciliation; automatic resend is blocked.");
          const record={
            version:2,chatId,signalId:String(signal.id),symbol:signal.symbol,signal,
            messageText:String(payload.messageText||""),replyMarkup:payload.replyMarkup??null,
            parseMode:payload.parseMode??"HTML",status:"SENDING",
            createdAt:old?.createdAt||new Date().toISOString(),attemptedAt:new Date().toISOString()
          };
          await this.ctx.storage.put(key,record);
          return Response.json({ok:true,result:{reserved:true,record}});
        }
        if(url.pathname==="/deliver/complete"){
          const chatId=String(payload.chatId||""),signalId=String(payload.signalId||"");
          const key="signal-outbox:"+signalOutboxKey(chatId,signalId);
          const old=await this.ctx.storage.get(key);
          const seed=payload.seed&&typeof payload.seed==="object"?payload.seed:null;
          if(!old&&!seed)throw new Error("Signal delivery reservation was not found.");
          const allowedStatuses=["SENT","UNCERTAIN","ARCHIVED","ARCHIVE_PENDING","QUEUED"];
          if(!allowedStatuses.includes(payload.status))throw new Error("Signal delivery completion status is invalid.");
          const next={...(old||seed),status:payload.status,updatedAt:payload.updatedAt||new Date().toISOString()};
          for(const field of ["telegramMessageId","sentAt","retryAttempts","error","archivePublished","archiveMessageId","archivedAt","archivePublishError","retryAuthorizedAt","manualConfirmedAt","archiveRetryAt"]){
            if(Object.prototype.hasOwnProperty.call(payload,field))next[field]=payload[field];
          }
          await this.ctx.storage.put(key,next);
          return Response.json({ok:true,result:{record:next}});
        }
        if(url.pathname==="/archive-publish/reserve"){
          const signalId=String(payload.signalId||"");
          if(!signalId||!archiveChannelId(this.env)||String(payload.channelId)!==archiveChannelId(this.env))throw new Error("Archive channel or signal ID is invalid.");
          const key="published-signal:"+signalId;
          const old=await this.ctx.storage.get(key);
          if(old?.status==="PUBLISHED"||old?.publishedAt||old?.messageId){
            return Response.json({ok:true,result:{duplicate:true,published:true,messageId:old.messageId??null}});
          }
          if(old?.status==="PUBLISHING"&&!payload.force){
            return Response.json({ok:true,result:{duplicate:true,pending:true,messageId:null}});
          }
          if(old&&!payload.force){
            return Response.json({ok:true,result:{duplicate:true,uncertain:true,messageId:old.messageId??null}});
          }
          await this.ctx.storage.put(key,{status:"PUBLISHING",startedAt:new Date().toISOString()});
          return Response.json({ok:true,result:{reserved:true}});
        }
        if(url.pathname==="/archive-publish/complete"){
          const signalId=String(payload.signalId||"");
          const key="published-signal:"+signalId;
          const old=await this.ctx.storage.get(key);
          if(!old||old.status!=="PUBLISHING")throw new Error("Archive publishing reservation was not found.");
          if(payload.status==="PUBLISHED"){
            const record={status:"PUBLISHED",messageId:payload.messageId??null,publishedAt:new Date().toISOString()};
            await this.ctx.storage.put(key,record);
            return Response.json({ok:true,result:{published:true,messageId:record.messageId}});
          }
          if(payload.status==="UNCERTAIN"){
            const record={...old,status:"UNCERTAIN",error:String(payload.error||"Archive delivery outcome is uncertain").slice(0,500),updatedAt:new Date().toISOString()};
            await this.ctx.storage.put(key,record);
            return Response.json({ok:true,result:{published:false,uncertain:true}});
          }
          throw new Error("Archive publishing completion status is invalid.");
        }

      }catch(error){
        return Response.json({ok:false,error:String(error?.message||error).slice(0,500)},{status:409});
      }
    });
  }
}


async function showRecentFuturesSignalReport(env,ownerId){
  if(!isOwner(ownerId,env))return;
  if(!env.SIGNAL_DELIVERY||!getSignalDeliverySecret(env)){
    await sendMessage(env,ownerId,"❌ Secure signal-memory connection is unavailable.");
    return;
  }
  try{
    const stub=env.SIGNAL_DELIVERY.get(env.SIGNAL_DELIVERY.idFromName("global:active-futures-signals"));
    const response=await stub.fetch("https://signal-delivery.internal/signals/list",{
      method:"POST",
      headers:{"content-type":"application/json","x-signal-delivery-secret":getSignalDeliverySecret(env)},
      body:JSON.stringify({limit:15})
    });
    let payload={};
    try{payload=await response.json()}catch{}
    if(!response.ok||!payload?.ok)throw new Error(payload?.error||"Could not retrieve the signal list.");
    const signals=Array.isArray(payload.signals)?payload.signals:[];
    if(!signals.length){
      await sendMessage(env,ownerId,"📊 در حال حاضر هیچ سیگنال فعالی در حافظه موتور وجود ندارد.\nاین گزارش فقط سیگنال‌های معتبر و منقضی‌نشده را نمایش می‌دهد.");
      return;
    }
    const fmt=value=>{
      if(value===null||value===undefined||value==="")return "—";
      const n=Number(value);
      return Number.isFinite(n)?n.toLocaleString("en-US",{maximumFractionDigits:8}):"—";
    };
    const lines=[
      "📊 RECENT SIGNAL ADMIN REPORT",
      "━━━━━━━━━━━━━━━━━━",
      "Source: Futures engine Durable Object memory",
      "Displayed signals: "+signals.length,
      "This report is read-only. No data is written to KV.",
      ""
    ];
    for(let i=0;i<signals.length;i++){
      const s=signals[i];
      const side=s.side==="LONG"?"🟢 LONG":"🔴 SHORT";
      const created=Number(s.createdAt);
      const createdText=Number.isFinite(created)&&created>0?new Date(created).toISOString():"Unknown";
      lines.push(
        (i+1)+") "+formatFuturesSymbol(s.symbol)+" | "+side,
        "Score: "+fmt(s.score)+" / 100",
        "Entry: "+fmt(s.entry)+" | Stop Loss: "+fmt(s.stop),
        "TP1: "+fmt(s.target1)+" | TP2: "+fmt(s.target2)+" | TP3: "+fmt(s.target3),
        "RSI: "+fmt(s.rsi)+" | Volume ratio: "+fmt(s.volumeRatio)+" | 24H change: "+fmt(s.change24h)+"%",
        "Quote volume: "+fmt(s.quoteVolume)+" USD | Funding: "+fmt(s.funding),
        "Created: "+createdText
      );
      if(Array.isArray(s.reasons)&&s.reasons.length){
        lines.push("Scoring reasons:");
        for(const reason of s.reasons.slice(0,8))lines.push("• "+String(reason).slice(0,180));
      }
      const d=s.entryDiagnostics;
      if(d&&typeof d==="object"){
        const checks=[
          ["Live-to-reference price deviation",d.driftPct,"%"],
          ["Distance from EMA20 (ATR)",d.emaDistanceAtr," ATR"],
          ["15M momentum confirmation",d.momentumConfirmed===true?"Yes":d.momentumConfirmed===false?"No":"Unknown",""],
          ["15M pullback confirmation",d.pullbackConfirmed===true?"Yes":d.pullbackConfirmed===false?"No":"Unknown",""]
        ];
        lines.push("Entry checks:");
        for(const [label,value,suffix] of checks){
          if(value!==undefined)lines.push("• "+label+": "+(typeof value==="number"?fmt(value)+suffix:value));
        }
      }
      lines.push("━━━━━━━━━━━━━━━━━━","");
    }
    await sendLongMessage(env,ownerId,lines.join("\n"));
  }catch(error){
    console.error("Admin recent signal report failed:",String(error?.stack||error));
    await sendMessage(env,ownerId,"❌ Could not build the admin report:\n"+String(error?.message||error).slice(0,500));
  }
}


function outboxSelectionKey(ownerId,token){return "admin:outbox-selection:"+ownerId+":"+token;}

export function canManuallyConfirmOutboxDelivery(record){
  return Boolean(record?.signal) && ["SENDING","UNCERTAIN","SENT","ARCHIVE_PENDING"].includes(record.status);
}

async function showUncertainSignalOutbox(env,ownerId){
  if(!isOwner(ownerId,env)||!env.APP_KV)return;
  const page=await env.APP_KV.list({prefix:"futures:signal-outbox:v1:",limit:1000});
  const records=[];
  for(const item of page.keys||[]){const record=await env.APP_KV.get(item.name,"json");if(record&&["SENDING","UNCERTAIN","SENT","ARCHIVE_PENDING"].includes(record.status))records.push(record);}
  records.sort((a,b)=>String(b.updatedAt||b.createdAt||"").localeCompare(String(a.updatedAt||a.createdAt||"")));
  const keyboard=[];
  for(const record of records.slice(0,15)){
    const token=crypto.randomUUID().replace(/-/g,"").slice(0,12);
    await env.APP_KV.put(outboxSelectionKey(ownerId,token),JSON.stringify({chatId:record.chatId,signalId:record.signalId}),{expirationTtl:3600});
    keyboard.push([{text:"⚠️ "+(record.symbol||"Signal")+" · "+record.status,callback_data:"outbox:detail:"+token}]);
  }
  keyboard.push([{text:"🔄 تازه‌سازی",callback_data:"outbox:review"},{text:"🏠 منوی اصلی",callback_data:"menu"}]);
  const note=page.list_complete===false?"\nدر حال نمایش ۱۰۰۰ رکورد اول ذخیره‌شده.":"";
  await sendMessage(env,ownerId,"🛠 ارسال‌های نیازمند بررسی\n━━━━━━━━━━━━━━━━━━\nموارد نیازمند بررسی: "+records.length+note+"\n\nپیش از هر اقدامی، پیام تلگرام مربوط به هر مورد را بررسی کنید.",{inline_keyboard:keyboard});
}

async function showOutboxSignalDetail(env,ownerId,token){
  if(!isOwner(ownerId,env)||!env.APP_KV)return;
  const selection=await env.APP_KV.get(outboxSelectionKey(ownerId,token),"json");
  if(!selection){await sendMessage(env,ownerId,"این مورد منقضی شده است. فهرست را دوباره باز کنید.");return;}
  const record=await env.APP_KV.get(signalOutboxKey(selection.chatId,selection.signalId),"json");
  if(!record){await sendMessage(env,ownerId,"رکورد ارسال پیدا نشد.");return;}
  const hasPayload=Boolean(record.signal&&typeof record.messageText==="string");
  const keyboard=[];
  if(canManuallyConfirmOutboxDelivery(record))keyboard.push([{text:"✅ پیام تلگرام را بررسی کردم؛ ارسال‌شده ثبت شود",callback_data:"outbox:confirm:"+token}]);
  if(["SENDING","UNCERTAIN"].includes(record.status)&&hasPayload)keyboard.push([{text:"⚠️ پیام را ندیدم؛ تلاش مجدد (ممکن است تکراری شود)",callback_data:"outbox:retry:"+token}]);
  if(["SENT","ARCHIVE_PENDING"].includes(record.status)&&hasPayload)keyboard.push([{text:"📚 تلاش مجدد برای انتشار در آرشیو (پس از بررسی کانال)",callback_data:"outbox:archive:"+token}]);
  keyboard.push([{text:"⬅️ بازگشت",callback_data:"outbox:review"}]);
  const body=["🔍 جزئیات ارسال","━━━━━━━━━━━━━━━━━━","نماد: "+(record.symbol||"—"),"شناسه گفتگو: "+record.chatId,"شناسه سیگنال: "+record.signalId,"وضعیت: "+record.status,"آخرین به‌روزرسانی: "+(record.updatedAt||"—"),"","اگر پیام را در تلگرام مشاهده می‌کنید، گزینه تأیید ارسال را انتخاب کنید.","فقط پس از بررسی پیام، ارسال مجدد را انتخاب کنید. ممکن است پیامِ با وضعیت نامشخص قبلاً ارسال شده باشد."];
  if(!hasPayload)body.push("⚠️ این رکورد قدیمی است و اطلاعات کافی برای بازیابی خودکار ندارد.");
  await sendMessage(env,ownerId,body.join("\n"),{inline_keyboard:keyboard});
}

async function reconcileSignalOutbox(env, ownerId, token, action) {
  if (!isOwner(ownerId, env) || !env.APP_KV || !env.SIGNAL_DELIVERY) return;
  const selection = await env.APP_KV.get(outboxSelectionKey(ownerId, token), "json");
  if (!selection) {
    await sendMessage(env, ownerId, "This item has expired. Reopen the list.");
    return;
  }
  const key = signalOutboxKey(selection.chatId, selection.signalId);
  const stub = env.SIGNAL_DELIVERY.get(env.SIGNAL_DELIVERY.idFromName(key));
  if (!getSignalDeliverySecret(env)) {
    await sendMessage(env, ownerId, "❌ Internal communication security secret is not configured.");
    return;
  }

  let record;
  try { record = await env.APP_KV.get(key, "json"); }
  catch (error) {
    await sendMessage(env, ownerId, "❌ Could not read delivery status: " + String(error?.message || error));
    return;
  }
  if (!record) {
    await sendMessage(env, ownerId, "This record is no longer in the delivery archive.");
    return;
  }

  if (action === "confirm_delivered") {
    if (record.status === "ARCHIVED") {
      await sendMessage(env, ownerId, "This signal is already marked as delivered.");
      return;
    }
    if (!canManuallyConfirmOutboxDelivery(record)) {
      await sendMessage(env, ownerId, "❌ This record does not contain enough information for manual confirmation.");
      return;
    }
    const confirmedAt = new Date().toISOString();
    const confirmed = {
      ...record, status: "ARCHIVED", archivedAt: confirmedAt,
      updatedAt: confirmedAt, manualConfirmedAt: confirmedAt
    };
    try {
      await signalDeliveryRequest(env, stub, "/deliver/complete", {
        chatId: String(selection.chatId), signalId: String(selection.signalId),
        status: "ARCHIVED", seed: confirmed, archivedAt: confirmedAt,
        updatedAt: confirmedAt, manualConfirmedAt: confirmedAt
      });
      await env.APP_KV.put(key, JSON.stringify(confirmed));
      await sendMessage(env, ownerId, "✅ Signal marked as delivered.");
    } catch (error) {
      await sendMessage(env, ownerId, "❌ Manual confirmation failed: " + String(error?.message || error));
      return;
    }
  } else if (action === "retry_archive") {
    if (!["SENT", "ARCHIVE_PENDING"].includes(record.status) || !record.signal || typeof record.messageText !== "string") {
      await sendMessage(env, ownerId, "❌ This record is not eligible for an archive retry.");
      return;
    }
    try {
      const archiveResult = await publishSignalToArchive(
        env, record.signal, record.messageText, record.parseMode ?? "HTML", { force: true }
      );
      const archivedAt = new Date().toISOString();
      const archived = {
        ...record, status: "ARCHIVED",
        archivePublished: archiveResult?.published !== false || archiveResult?.duplicate === true,
        archiveMessageId: archiveResult?.messageId ?? null,
        archivedAt, updatedAt: archivedAt, archiveRetryAt: archivedAt
      };
      await signalDeliveryRequest(env, stub, "/deliver/complete", {
        chatId: String(selection.chatId), signalId: String(selection.signalId),
        status: "ARCHIVED", seed: archived,
        archivePublished: archived.archivePublished,
        archiveMessageId: archived.archiveMessageId,
        archivedAt, archiveRetryAt: archivedAt, updatedAt: archivedAt
      });
      await env.APP_KV.put(key, JSON.stringify(archived));
      await sendMessage(env, ownerId, "📚 Signal successfully republished to the archive.");
    } catch (error) {
      const failedAt = new Date().toISOString();
      const pending = {
        ...record, status: "ARCHIVE_PENDING",
        archivePublished: false,
        archivePublishError: String(error?.message || error).slice(0, 500),
        updatedAt: failedAt
      };
      try {
        await signalDeliveryRequest(env, stub, "/deliver/complete", {
          chatId: String(selection.chatId), signalId: String(selection.signalId),
          status: "ARCHIVE_PENDING", seed: pending, archivePublished: false,
          archivePublishError: pending.archivePublishError, updatedAt: failedAt
        });
        await env.APP_KV.put(key, JSON.stringify(pending));
      } catch (stateError) {
        console.error("ARCHIVE_RETRY_FAILURE_STATE_PERSIST_FAILED", String(stateError?.message || stateError));
      }
      await sendMessage(env, ownerId, "❌ Archive publication failed: " + String(error?.message || error));
    }
  } else if (action === "retry") {
    if (!["SENDING", "UNCERTAIN", "QUEUED"].includes(record.status) || !record.signal || typeof record.messageText !== "string") {
      await sendMessage(env, ownerId, "❌ This record is not eligible for an archive publication retry.");
      return;
    }
    try {
      const archiveResult = await publishSignalToArchive(
        env, record.signal, record.messageText, record.parseMode ?? "HTML"
      );
      const published = archiveResult?.published === true ||
        (archiveResult?.duplicate === true && archiveResult?.pending !== true);
      const updatedAt = new Date().toISOString();
      const archived = {
        ...record, status: published ? "ARCHIVED" : "ARCHIVE_PENDING",
        archivePublished: published,
        archiveMessageId: archiveResult?.messageId ?? null,
        ...(published ? { archivedAt: updatedAt } : {}),
        updatedAt
      };
      await signalDeliveryRequest(env, stub, "/deliver/complete", {
        chatId: String(selection.chatId), signalId: String(selection.signalId),
        status: archived.status, seed: archived,
        archivePublished: archived.archivePublished,
        archiveMessageId: archived.archiveMessageId,
        archivedAt: archived.archivedAt, updatedAt
      });
      await env.APP_KV.put(key, JSON.stringify(archived));
      await sendMessage(env, ownerId, "📚 Signal publication retry completed in the archive channel. No private signal message was sent.");
    } catch (error) {
      await sendMessage(env, ownerId, "❌ Archive publication retry failed: " + String(error?.message || error));
    }
  } else {
    await sendMessage(env, ownerId, "❌ This action is not available for the current status.");
  }

  await showUncertainSignalOutbox(env, ownerId);
}
async function handleFillCommand(env,chatId,message){return sendMessage(env,chatId,"ℹ️ Trade result logging and tracking are not available in this version.")}
async function countUncertainSignalOutbox(env) {
  if(!env.APP_KV)return null;
  try{
    let cursor, count=0;
    do{
      const page=await env.APP_KV.list({prefix:"futures:signal-outbox:v1:",limit:1000,...(cursor?{cursor}:{})});
      for(const item of page.keys||[]){
        const record=await env.APP_KV.get(item.name,"json");
        if(record?.status==="UNCERTAIN")count++;
      }
      cursor=page.list_complete===false?page.cursor:null;
    }while(cursor);
    return count;
  }catch(error){
    console.error("UNCERTAIN_OUTBOX_COUNT_FAILED",String(error?.message||error));
    return null;
  }
}

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
      console.error("SCAN_DIAGNOSTIC_THROTTLE_FAILED; sending without throttle", String(error?.message || error));
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
    await notifyOwnerScanDiagnostics(env, "🚨 SCHEDULED FUTURES SCAN ERROR\n\n" + diagnostic,
      "futures:scan-diagnostic:fatal", 15 * 60);
    return { scanned: false, error: diagnostic };
  }
}

async function runAutomaticFuturesAlertScanInternal(env) {
  if (!env.SIGNAL_DELIVERY || !getSignalDeliverySecret(env)) {
    const result=await runFuturesSignalScan(env,{analysisOnly:true});
    const d=result.diagnostics||{};
    const message=[
      "⚠️ Futures scan ran in analysis-only mode; no signals were registered",
      "Reason: Durable Object binding or secret is missing.",
      "Symbols analyzed: "+(d.analyzedCount??0),
      "Symbols not analyzed: "+(d.notAnalyzedCount??0),
      "Eligible but unregistered candidates: "+(d.unregisteredCandidateCount??0),
      "Rejected: "+(d.rejectedCount??0),
      "",
      ...(d.topRejections||[]).map(x=>"• "+x.reason+": "+x.count),
      "",
      "No signals were sent or marked as registered. Check the Durable Object binding."
    ].join("\n");
    await notifyOwnerScanDiagnostics(env,message,null,0);
    return {scanned:true,analysisOnly:true,signals:0,diagnostics:d};
  }
  const stub = env.SIGNAL_DELIVERY.get(env.SIGNAL_DELIVERY.idFromName("global:automatic-futures-scan-lock"));
  const headers = { "content-type": "application/json", "x-signal-delivery-secret": getSignalDeliverySecret(env) };
  const scanLockToken = crypto.randomUUID();
  const acquireResponse = await stub.fetch("https://signal-delivery.internal/scan-lock/acquire", {
    method: "POST", headers, body: JSON.stringify({ token: scanLockToken })
  });
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
    diagnostics.uncertainOutboxCount = await countUncertainSignalOutbox(env);
    const noSignalMessage = [
      "🧪 گزارش تشخیصی اسکن خودکار فیوچرز",
      "━━━━━━━━━━━━━━━━━━",
      "نسخه: " + CONFIG.VERSION,
      "زمان: " + (diagnostics.finishedAt || new Date().toISOString()),
      "نمادهای دارای شرایط لازم حجم معاملات: " + (diagnostics.universeCount ?? "—"),
      "نمادهای بررسی‌شده: " + (diagnostics.analyzedCount ?? "—"),
      "نمادهای بررسی‌نشده به دلیل محدودیت زمانی: " + (diagnostics.notAnalyzedCount ?? "—"),
      "خطاهای دریافت داده یا تحلیل: " + (diagnostics.analysisErrorCount ?? "—"),
      "خطاهای دریافت کندل ۱۵ دقیقه‌ای: " + (diagnostics.fifteenMinuteDataErrorCount ?? 0),
      "نمادهای ردشده: " + (diagnostics.rejectedCount ?? "—"),
      "سیگنال‌های واجد شرایط: " + (diagnostics.eligibleCount ?? "—"),
      "سیگنال‌های ثبت‌شده: " + (diagnostics.registeredCount ?? "—"),
      "فرصت‌های ثبت‌نشده: " + (diagnostics.unregisteredCandidateCount ?? 0),
      "سوابق ارسال نامشخص: " + (diagnostics.uncertainOutboxCount ?? "—"),
      "معاملات باز که طی ۲ ساعت گذشته کندل آن‌ها بررسی نشده: " + (tracking.stuckCount ?? "—"),
      "خطاهای داخلی سیستم پایش معاملات: " + (tracking.errors ?? 0),
      ...(tracking.errorDetails || []).map(x => "• Monitor " + (x.symbol || "") + " / " + (x.stage || "ERROR") + ": " + x.message),
      ...(tracking.stuckTrades || []).map(x => "⚠️ Stalled trade: " + x.symbol + " " + x.side + " | ID: " + x.tradeId + " | Last checked: " + (x.lastCheckedAt || "Unknown")),
      "ارسال‌های موفق: " + (diagnostics.delivery?.delivered ?? "—"),
      "ارسال‌های ناموفق: " + (diagnostics.delivery?.failed ?? "—"),
      "Scan duration: " + (diagnostics.durationMs != null ? Math.round(diagnostics.durationMs / 1000) + " ثانیه" : "—"),
      "",
      "مهم‌ترین دلایل رد شدن نمادها:",
      ...(diagnostics.topRejections || []).map(x => "• " + ({
        "The symbol's 4H trend is not aligned with the signal": "هم‌جهت نبودن روند ۴ ساعته نماد با جهت سیگنال",
        "The 1H trend and optimal RSI zone were not confirmed together": "تأیید نشدن هم‌زمان روند ۱ ساعته و محدوده بهینه RSI",
        "Bitcoin's 4H trend is not aligned with the signal": "هم‌جهت نبودن روند ۴ ساعته بیت‌کوین با جهت سیگنال",
        "No symbol met the minimum 24-hour volume requirement.": "هیچ نمادی حداقل حجم معاملات ۲۴ ساعته را نداشت.",
        "Kraken Futures market universe unavailable; scan safely skipped.": "فهرست بازار فیوچرز کراکن در دسترس نبود؛ اسکن برای حفظ ایمنی اجرا نشد."
      }[x.reason] || x.reason) + ": " + x.count),
      diagnostics.deliveryError ? "\nخطای ارسال: " + diagnostics.deliveryError : "",
      diagnostics.trackingError ? "\nخطای سیستم پایش معاملات: " + diagnostics.trackingError : "",
      "━━━━━━━━━━━━━━━━━━",
      diagnostics.signalCount ? "سیگنال تولید شده است؛ این گزارش خطا یا وضعیت نیست." :
        "در این مرحله هیچ فرصت معاملاتی واجد شرایطی شناسایی نشد."
    ].filter(Boolean).join("\n");
    if (diagnostics.analysisErrorCount > 0 || diagnostics.fifteenMinuteDataErrorCount > 0 || diagnostics.delivery?.failed > 0 || diagnostics.deliveryError || diagnostics.trackingError || diagnostics.universeError || tracking.errors > 0 || tracking.stuckCount > 0) {
      await notifyOwnerScanDiagnostics(env, noSignalMessage,
        "futures:scan-diagnostic:issue", 15 * 60);
    } else if ((diagnostics.signalCount || 0) === 0) {
      await notifyOwnerScanDiagnostics(env, noSignalMessage,
        "futures:scan-diagnostic:no-signal", 6 * 60 * 60);
    }
    return { scanned: true, signals: (result.signals || []).length, experimentalSignals: 0, tracking, diagnostics };
  } finally {
    const releaseResponse = await stub.fetch("https://signal-delivery.internal/scan-lock/release", {
      method: "POST", headers, body: JSON.stringify({ token: scanLockToken })
    });
    if (!releaseResponse.ok) console.error("Could not release automatic scan lock:", releaseResponse.status);
  }
}

// Owner-only, read-only diagnostics. This path reads public Kraken market data only;
// it never registers signals, writes KV/DO state, or delivers trading alerts.
async function runFuturesEntryDiagnostics(env) {
  const startedAt = new Date().toISOString();
  const universe = await getKrakenFuturesUniverse();
  const analyzed = await mapLimit(
    universe.slice(0, 30),
    FUTURES_CONFIG.CONCURRENCY,
    async ticker => {
      try {
        const marketData = await getKrakenFuturesCandlesViaCoordinator(env, ticker.symbol, [
          FUTURES_CONFIG.INTERVAL, FUTURES_CONFIG.CONFIRM_INTERVAL, FUTURES_CONFIG.ENTRY_CONFIRM_INTERVAL
        ]);
        const oneHour = marketData.candles[FUTURES_CONFIG.INTERVAL];
        const fourHour = marketData.candles[FUTURES_CONFIG.CONFIRM_INTERVAL];
        const fifteenMinute = marketData.candles[FUTURES_CONFIG.ENTRY_CONFIRM_INTERVAL] || [];
        if (marketData.errors?.[FUTURES_CONFIG.ENTRY_CONFIRM_INTERVAL]) {
          console.error("FUTURES_15M_CANDLE_FETCH_FAILED", ticker.symbol, marketData.errors[FUTURES_CONFIG.ENTRY_CONFIRM_INTERVAL]);
        }
        if (!Array.isArray(oneHour) || !Array.isArray(fourHour)) {
          throw new Error(marketData.errors?.[FUTURES_CONFIG.INTERVAL] ||
            marketData.errors?.[FUTURES_CONFIG.CONFIRM_INTERVAL] ||
            "Required Kraken candle data is missing.");
        }
        const result = analyzeFuturesSymbol(ticker, oneHour, fourHour, fifteenMinute);
        return {
          symbol: ticker.symbol,
          stage: result.eligible ? "ELIGIBLE" : result.rejected ? "REJECTED" : "UNKNOWN",
          reason: result.rejected || null,
          score: result.score ?? null,
          side: result.side ?? null,
          candleCounts: { "1h": oneHour.length, "4h": fourHour.length, "15m": fifteenMinute.length },
          entry: result.entry ?? null, stop: result.stop ?? null,
          targets: result.eligible ? [result.target1, result.target2, result.target3] : null,
          metrics: result.entryDiagnostics || null
        };
      } catch (error) {
        return { symbol: ticker.symbol, stage: "DATA_OR_ANALYSIS_ERROR",
          reason: String(error?.message || error).slice(0, 220), score: null, side: null,
          candleCounts: null, entry: null, stop: null, targets: null, metrics: null };
      }
    }
  );
  const stageCounts = {};
  for (const item of analyzed) stageCounts[item.stage] = (stageCounts[item.stage] || 0) + 1;
  return {
    startedAt, finishedAt: new Date().toISOString(), universeCount: universe.length,
    sampledCount: analyzed.length, stageCounts, samples: analyzed
  };
}

function formatFuturesEntryDiagnostics(d) {
  const lines = [
    "🧪 READ-ONLY FUTURES DIAGNOSTICS",
    "━━━━━━━━━━━━━━━━━━",
    "Symbols meeting market-volume requirements: " + d.universeCount,
    "Symbols sampled and analyzed: " + d.sampledCount,
    "",
    "Kraken Futures 3.8.2 engine analysis result:"
  ];
  for (const [stage, count] of Object.entries(d.stageCounts || {})) lines.push("• " + stage + ": " + count);
  lines.push("", "Symbol details:");
  for (const item of (d.samples || []).slice(0, 15)) {
    lines.push("• " + item.symbol + " | " + item.stage +
      " | Score: " + (item.score ?? "—") + " | Direction: " + (item.side || "—"));
    if (item.candleCounts) lines.push("  Candles: 1h=" + item.candleCounts["1h"] +
      "; 4h=" + item.candleCounts["4h"] + "; 15m=" + item.candleCounts["15m"]);
    if (item.entry != null) lines.push("  Entry: " + formatPrice(item.entry) +
      " | Stop: " + formatPrice(item.stop) +
      " | Targets: " + (item.targets || []).map(formatPrice).join(" / "));
    if (item.reason) lines.push("  Reason: " + item.reason);
  }
  lines.push("", "⛔ This report is read-only. No signal was registered or sent, and no trade was executed.");
  return lines.join("\n");
}

function classifyBitcoinFourHourCandle(candles, endIndex) {
  const sample = candles.slice(0, endIndex + 1);
  if (sample.length < FUTURES_CONFIG.MIN_CANDLES) return { direction: "NEUTRAL", reason: "insufficient_closed_candles" };
  const closes = sample.map(c => c.close);
  const close = closes[closes.length - 1];
  const previousEma20 = ema(closes.slice(0, -1), 20);
  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  if (![close, previousEma20, ema20, ema50].every(Number.isFinite) || close <= 0) {
    return { direction: "NEUTRAL", reason: "invalid_indicators" };
  }
  const slopePct = ((ema20 - previousEma20) / previousEma20) * 100;
  const spreadPct = ((ema20 - ema50) / close) * 100;
  const nearNeutral = Math.abs(spreadPct) <= 0.20;
  let direction = "NEUTRAL";
  let reason = "no_directional_confirmation";
  if (ema20 > ema50 && slopePct > 0 && close > ema20) {
    direction = "LONG";
    reason = "bullish_ema_alignment";
  } else if (ema20 < ema50 && slopePct < 0 && close < ema20) {
    direction = "SHORT";
    reason = "bearish_ema_alignment";
  } else if (nearNeutral && slopePct > 0 && close >= ema20) {
    direction = "LONG";
    reason = "neutral_leaning_bullish";
  } else if (nearNeutral && slopePct < 0 && close <= ema20) {
    direction = "SHORT";
    reason = "neutral_leaning_bearish";
  }
  return {
    direction, reason,
    close, ema20, ema50,
    emaSpreadPct: spreadPct,
    ema20SlopePct: slopePct,
    candleTime: sample[sample.length - 1].time
  };
}

function determineBitcoinFourHourRegime(candles) {
  if (!Array.isArray(candles) || candles.length < FUTURES_CONFIG.MIN_CANDLES + 1) {
    return { direction: "NEUTRAL", confirmed: false, reason: "insufficient_bitcoin_4h_candles" };
  }
  const latest = classifyBitcoinFourHourCandle(candles, candles.length - 1);
  const previous = classifyBitcoinFourHourCandle(candles, candles.length - 2);
  const confirmed = latest.direction !== "NEUTRAL" && latest.direction === previous.direction;
  return {
    direction: confirmed ? latest.direction : "NEUTRAL",
    confirmed,
    reason: confirmed ? latest.reason : "last_two_closed_4h_candles_not_aligned",
    confirmation: {
      previous: { direction: previous.direction, reason: previous.reason, candleTime: previous.candleTime },
      latest: { direction: latest.direction, reason: latest.reason, candleTime: latest.candleTime }
    },
    metrics: {
      close: latest.close,
      ema20: latest.ema20,
      ema50: latest.ema50,
      emaSpreadPct: latest.emaSpreadPct,
      ema20SlopePct: latest.ema20SlopePct
    }
  };
}

async function runFuturesSignalScan(env, options = {}) {
  const started = Date.now();
  let universe;
  try {
    universe = await getKrakenFuturesUniverse();
  } catch (error) {
    const finishedAt = new Date().toISOString();
    const universeError = String(error?.message || error).slice(0, 500);
    const diagnostics = {
      startedAt: new Date(started).toISOString(), finishedAt,
      durationMs: Date.now() - started,
      universeCount: 0, analyzedCount: 0, notAnalyzedCount: 0,
      analysisErrorCount: 0, fifteenMinuteDataErrorCount: 0,
      unregisteredCandidateCount: 0, uncertainOutboxCount: null,
      rejectedCount: 0, eligibleCount: 0, signalCount: 0, registeredCount: 0,
      delivery: { newSignals: 0, recipients: 0, delivered: 0, failed: 0 },
      deliveryError: null, universeError,
      topRejections: [{ reason: "Kraken Futures market universe unavailable; scan safely skipped.", count: 1 }]
    };
    console.error("AUTOMATIC_FUTURES_SCAN_DIAGNOSTICS", JSON.stringify(diagnostics));
    return {
      report: "⚠️ Kraken Futures market data is temporarily unavailable. No signals were generated.",
      signals: [], diagnostics
    };
  }
  if (!universe.length) {
    const finishedAt = new Date().toISOString();
    const diagnostics = {
      startedAt: new Date(started).toISOString(), finishedAt, durationMs: Date.now() - started,
      universeCount: 0, analyzedCount: 0, notAnalyzedCount: 0, analysisErrorCount: 0, unregisteredCandidateCount: 0, uncertainOutboxCount: null,
      rejectedCount: 0, eligibleCount: 0, signalCount: 0, registeredCount: 0,
      delivery: { newSignals: 0, recipients: 0, delivered: 0, failed: 0 },
      deliveryError: null,
      universeError: "Kraken returned no active PI/PF USD perpetuals above the configured 24h quote-volume threshold.",
      topRejections: [{ reason: "No symbol met the minimum 24-hour volume requirement.", count: 1 }]
    };
    console.error("AUTOMATIC_FUTURES_SCAN_DIAGNOSTICS", JSON.stringify(diagnostics));
    return { report: "⚠️ No Kraken perpetual contract met the required volume threshold.", signals: [], diagnostics };
  }

  const filteredUniverse = universe;
  const bitcoinTicker = filteredUniverse
    .filter(item => /^(?:PI|PF)_(?:XBT|BTC)USD$/.test(String(item.symbol || "").toUpperCase()))
    .sort((a, b) => Number(b.quoteVolume) - Number(a.quoteVolume))[0];
  if (!bitcoinTicker) {
    const diagnostics = {
      startedAt: new Date(started).toISOString(), finishedAt: new Date().toISOString(),
      durationMs: Date.now() - started, universeCount: filteredUniverse.length,
      analyzedCount: 0, analysisErrorCount: 0, eligibleCount: 0, signalCount: 0,
      registeredCount: 0, bitcoinMarketRegime: { direction: "UNAVAILABLE", reason: "bitcoin_perpetual_not_found" },
      delivery: { newSignals: 0, recipients: 0, delivered: 0, failed: 0 },
      topRejections: [{ reason: "Bitcoin perpetual market data was unavailable; scan safely skipped.", count: 1 }]
    };
    console.error("AUTOMATIC_FUTURES_SCAN_DIAGNOSTICS", JSON.stringify(diagnostics));
    return { report: "⚠️ داده قرارداد دائمی بیت‌کوین در دسترس نیست؛ برای جلوگیری از صدور سیگنال خلاف جهت بازار، این اسکن متوقف شد.", signals: [], diagnostics };
  }
  let bitcoinMarketRegime;
  try {
    const btcData = await getKrakenFuturesCandlesViaCoordinator(env, bitcoinTicker.symbol, [FUTURES_CONFIG.CONFIRM_INTERVAL]);
    const btcCandles = btcData.candles?.[FUTURES_CONFIG.CONFIRM_INTERVAL] || [];
    if (btcData.errors?.[FUTURES_CONFIG.CONFIRM_INTERVAL]) throw new Error(btcData.errors[FUTURES_CONFIG.CONFIRM_INTERVAL]);
    bitcoinMarketRegime = determineBitcoinFourHourRegime(btcCandles);
  } catch (error) {
    bitcoinMarketRegime = { direction: "UNAVAILABLE", confirmed: false, reason: String(error?.message || error).slice(0, 300) };
  }
  if (!["LONG", "SHORT"].includes(bitcoinMarketRegime.direction)) {
    const diagnostics = {
      startedAt: new Date(started).toISOString(), finishedAt: new Date().toISOString(),
      durationMs: Date.now() - started, universeCount: filteredUniverse.length,
      analyzedCount: 0, analysisErrorCount: 0, eligibleCount: 0, signalCount: 0,
      registeredCount: 0, bitcoinMarketRegime: { ...bitcoinMarketRegime, symbol: bitcoinTicker.symbol },
      delivery: { newSignals: 0, recipients: 0, delivered: 0, failed: 0 },
      topRejections: [{ reason: "Bitcoin 4h direction was neutral, unconfirmed, or unavailable; no signals were allowed.", count: 1 }]
    };
    console.log("AUTOMATIC_FUTURES_SCAN_DIAGNOSTICS", JSON.stringify(diagnostics));
    return { report: "⏸ روند ۴ ساعته بیت‌کوین خنثی یا تأییدنشده است؛ در این اسکن هیچ سیگنالی صادر نمی‌شود.", signals: [], diagnostics };
  }

  const analysisDeadline = started + FUTURES_CONFIG.MAX_SCAN_DURATION_MS - FUTURES_CONFIG.SCAN_FINALIZATION_RESERVE_MS;
  let analysisErrorCount = 0;
  let fifteenMinuteDataErrorCount = 0;
  const analyzed = await mapLimit(filteredUniverse, FUTURES_CONFIG.CONCURRENCY, async ticker => {
    try {
      // Stage 1: fetch only the 1h/4h inputs and run the unchanged engine with
      // entry filters skipped. This is a conservative preflight: any symbol
      // that can become eligible in the full analysis must pass this stage.
      const baseData = await getKrakenFuturesCandlesViaCoordinator(env, ticker.symbol, [
        FUTURES_CONFIG.INTERVAL, FUTURES_CONFIG.CONFIRM_INTERVAL
      ]);
      const oneHour = baseData.candles[FUTURES_CONFIG.INTERVAL];
      const fourHour = baseData.candles[FUTURES_CONFIG.CONFIRM_INTERVAL];
      if (!Array.isArray(oneHour) || !Array.isArray(fourHour)) {
        throw new Error(baseData.errors?.[FUTURES_CONFIG.INTERVAL] ||
          baseData.errors?.[FUTURES_CONFIG.CONFIRM_INTERVAL] ||
          "Required Kraken candle data is missing.");
      }

      const analysisOptions = { ...options };
      const preflight = analyzeFuturesSymbol(ticker, oneHour, fourHour, [], {
        ...analysisOptions, skipEntryFilters: true
      });
      if (preflight?.eligible !== true && preflight?.highRiskEligible !== true) {
        return preflight;
      }

      // Stage 2: only symbols surviving every 1h/4h/BTC/volume/score/risk
      // prerequisite request 15m candles. Final qualification still runs the
      // original, unchanged entry-filter implementation on the real 15m data.
      const entryData = await getKrakenFuturesCandlesViaCoordinator(
        env, ticker.symbol, [FUTURES_CONFIG.ENTRY_CONFIRM_INTERVAL]
      );
      const fifteenMinute = entryData.candles[FUTURES_CONFIG.ENTRY_CONFIRM_INTERVAL] || [];
      if (entryData.errors?.[FUTURES_CONFIG.ENTRY_CONFIRM_INTERVAL]) {
        fifteenMinuteDataErrorCount++;
        console.error("FUTURES_15M_CANDLE_FETCH_FAILED", ticker.symbol, entryData.errors[FUTURES_CONFIG.ENTRY_CONFIRM_INTERVAL]);
      }
      return analyzeFuturesSymbol(ticker, oneHour, fourHour, fifteenMinute, analysisOptions);
    } catch (error) {
      analysisErrorCount++;
      return { symbol: ticker.symbol, rejected: error?.message || "Analysis error", diagnosticType: "data_or_analysis_error" };
    }
  }, () => Date.now() < analysisDeadline);

  const entryDiagnostics = analyzed
    .filter(item => item?.entryDiagnostics)
    .map(item => ({ symbol: item.symbol, ...item.entryDiagnostics }));
  if (entryDiagnostics.length) {
    console.log("AUTOMATIC_FUTURES_ENTRY_DIAGNOSTICS", JSON.stringify({
      timestamp: new Date().toISOString(), version: CONFIG.VERSION, engine: "Kraken Futures 3.8.2",
      symbols: entryDiagnostics
    }));
  }

  const createdAt = Date.now();
  const eligibleCandidates = analyzed
    .filter(item => item?.eligible === true)
    // Preserve every standard candidate ahead of experimental high-risk candidates.
    .sort((a, b) =>
      Number(a.riskLevel === "HIGH_RISK") - Number(b.riskLevel === "HIGH_RISK") ||
      Number(b.score) - Number(a.score) ||
      a.symbol.localeCompare(b.symbol)
    );

  // Bitcoin's confirmed 4h regime is the sole market-direction gate.
  // The signal engine's scoring, setup, entry, stop and target calculations remain unchanged.
  const longEligibleCount = eligibleCandidates.filter(item => item.side === "LONG").length;
  const shortEligibleCount = eligibleCandidates.filter(item => item.side === "SHORT").length;
  const dominantDirection = bitcoinMarketRegime.direction;
  const directionFilteredCandidates = eligibleCandidates.filter(item => item.side === dominantDirection);
  const suppressedOppositeDirectionCount = eligibleCandidates.length - directionFilteredCandidates.length;

  const generatedSignals = directionFilteredCandidates
    .slice(0, FUTURES_CONFIG.MAX_SIGNALS_PER_SCAN)
    .map(item => ({
      ...item, id: crypto.randomUUID(), createdAt,
      expiresAt: createdAt + FUTURES_CONFIG.SIGNAL_TTL_MINUTES * 60000,
      status: "PENDING"
    }));

  let signals = [];
  let registrationError = null;
  if (!options.analysisOnly && generatedSignals.length) {
    try {
      signals = await registerPendingFuturesSignals(env, generatedSignals);
    } catch (error) {
      registrationError = String(error?.message || error).slice(0, 700);
      console.error("Pending futures signal registration failed:", String(error?.stack || error?.message || error));
    }
  }
  let delivery = { newSignals: signals.length, recipients: 0, delivered: 0, failed: 0 };
  let deliveryError = registrationError;
  if (signals.length) {
    try {
      delivery = await deliverFuturesSignalAlerts(env, signals, options.excludeChatId ?? null);
    } catch (error) {
      deliveryError = String(error?.message || error).slice(0, 700);
      console.error("Immediate futures alert dispatch failed:", String(error?.stack || error?.message || error));
    }
  }

  const analyzedCount = analyzed.filter(Boolean).length;
  const rejectionCounts = new Map();
  for (const item of analyzed) {
    if (!item || item.eligible === true) continue;
    const reason = String(item.rejected || "Rejection reason unavailable").slice(0, 180);
    rejectionCounts.set(reason, (rejectionCounts.get(reason) || 0) + 1);
  }
  const finishedAt = new Date().toISOString();
  const diagnostics = {
    startedAt: new Date(started).toISOString(), finishedAt, durationMs: Date.now() - started,
    universeCount: filteredUniverse.length, analyzedCount,
    notAnalyzedCount: Math.max(0, filteredUniverse.length - analyzedCount),
    analysisErrorCount, fifteenMinuteDataErrorCount,
    rejectedCount: analyzed.filter(item => item && item.eligible !== true).length,
    eligibleCount: eligibleCandidates.length,
    longEligibleCount,
    shortEligibleCount,
    dominantDirection,
    bitcoinMarketRegime: { ...bitcoinMarketRegime, symbol: bitcoinTicker.symbol },
    suppressedOppositeDirectionCount,
    selectedEligibleCount: directionFilteredCandidates.length,
    standardEligibleCount: eligibleCandidates.filter(item => item.riskLevel !== "HIGH_RISK").length,
    highRiskEligibleCount: eligibleCandidates.filter(item => item.riskLevel === "HIGH_RISK").length,
    signalCount: signals.length,
    unregisteredCandidateCount: options.analysisOnly || registrationError ? generatedSignals.length : 0,
    uncertainOutboxCount: null,
    standardSignalCount: signals.filter(item => item.riskLevel !== "HIGH_RISK").length,
    highRiskSignalCount: signals.filter(item => item.riskLevel === "HIGH_RISK").length,
    registeredCount: signals.length,
    delivery, deliveryError,
    topRejections: [...rejectionCounts.entries()].map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count).slice(0, 8)
  };
  console.log("AUTOMATIC_FUTURES_SCAN_DIAGNOSTICS", JSON.stringify(diagnostics));
  const report =
    "📈 CRYPTO PUMP HUNTER — KRAKEN FUTURES 3.8.2\n" +
    "━━━━━━━━━━━━━━━━━━\n" +
    "🏦 Market: Kraken Derivatives Perpetual\n" +
    "⏱ Timeframes: 1H with 4H trend confirmation and 15M entry filter\n" +
    `📥 Symbols checked: ${analyzedCount} of ${filteredUniverse.length} symbols meeting the 24H volume threshold
` +
    `🟢 Standard signals: ${signals.filter(item => item.riskLevel !== "HIGH_RISK").length}\n` +
    `⚠️ High-risk signals: ${signals.filter(item => item.riskLevel === "HIGH_RISK").length}\n\n` +
    (signals.length
      ? signals.map((item, index) => formatFuturesSignal(item, index + 1)).join("\n━━━━━━━━━━━━━━━━━━\n\n")
      : "⚠️ No signal met the minimum score and entry requirements in this scan.\n\n") +
    `🕒 Report time: ${new Date().toISOString()}\n` +
    `⏱ Scan duration: ${Math.round((Date.now() - started) / 1000)} seconds\n` +
    "📡 Data source: Kraken Derivatives Futures\n" +
    "⚠️ Signals are analytical only. No real orders are placed, and profit is not guaranteed.";
  return { report, signals, experimentalSent: 0, analyzed, diagnostics };
}

async function runFuturesSignalsForChat(env, chatId) {
  if (!(await isApproved(chatId, env))) {
    await sendMessage(env, chatId, "⛔ Your access is not active.");
    return;
  }

  let lockAcquired = false;
  let scanLockStub = null;
  let scanLockToken = null;
  const lockHeaders = {
    "content-type": "application/json",
    "x-signal-delivery-secret": getSignalDeliverySecret(env)
  };

  try {
    if (!env.SIGNAL_DELIVERY || !getSignalDeliverySecret(env)) {
      throw new Error("Durable signal storage is required for a globally coordinated manual scan.");
    }

    // Use the same Durable Object lease as scheduled scans. This serializes
    // manual and automatic scans across all Worker isolates and regions.
    scanLockStub = env.SIGNAL_DELIVERY.get(
      env.SIGNAL_DELIVERY.idFromName("global:automatic-futures-scan-lock")
    );
    scanLockToken = crypto.randomUUID();
    const acquireResponse = await scanLockStub.fetch("https://signal-delivery.internal/scan-lock/acquire", {
      method: "POST",
      headers: lockHeaders,
      body: JSON.stringify({ token: scanLockToken })
    });
    const acquire = await acquireResponse.json();
    if (!acquireResponse.ok || !acquire?.ok) {
      throw new Error(acquire?.error || "Could not acquire the global Futures scan lock.");
    }
    if (!acquire.acquired) {
      await sendMessage(env, chatId,
        "⏳ Another futures scan is currently running. Please try again after it finishes.",
        menuForChat(env, chatId));
      return;
    }
    lockAcquired = true;

    await sendMessage(env, chatId,
      "🔍 <b>درخواست اسکن دریافت شد</b>\n" +
      "━━━━━━━━━━━━━━━━━━\n\n" +
      "📊 موتور کراکن در حال بررسی بازار است.\n\n" +
      "در صورت شناسایی فرصت معتبر، سیگنال مستقیماً در کانال آرشیو منتشر می‌شود.\n\n" +
      "⚡ <b>تریدیار | پایش هوشمند بازار</b>",
      menuForChat(env, chatId),
      "HTML");

    const result = await runFuturesSignalScan(env);
    const signals = result.signals || [];
    if (!signals.length) {
      const d = result.diagnostics || {};
      await sendMessage(env, chatId,
        "📊 اسکن فیوچرز به پایان رسید؛ سیگنال معتبری پیدا نشد.\n\n" +
        "نمادهای بررسی‌شده: " + (d.analyzedCount ?? "—") + "\n" +
        "نمادهای دارای شرایط لازم حجم معاملات: " + (d.universeCount ?? "—") + "\n" +
        "نمادهای ردشده: " + (d.rejectedCount ?? "—") + "\n" +
        "مدت‌زمان اسکن: " + (d.durationMs != null ? Math.round(d.durationMs / 1000) + " ثانیه" : "—") +
        "\n\nبا تغییر شرایط بازار می‌توانید اسکن دیگری اجرا کنید.",
        menuForChat(env, chatId));
      return;
    }

    const delivery = result.diagnostics?.delivery || { delivered: 0, failed: signals.length };
    await sendMessage(env, chatId,
      "✅ اسکن به پایان رسید.\n" +
      "تعداد سیگنال‌های شناسایی‌شده: " + signals.length + "\n" +
      "منتشرشده در کانال آرشیو: " + delivery.delivered + "\n" +
      "ارسال‌های ناموفق: " + delivery.failed,
      menuForChat(env, chatId));
  } catch (error) {
    const diagnostic = String(error?.stack || error?.message || error).slice(0, 1800);
    console.error("Manual futures scan failed:", diagnostic);
    if (String(chatId) === String((env.OWNER_TELEGRAM_ID || env.OWNER_ID))) {
      try {
        await sendMessage(env, chatId, "🧪 Futures scan technical error (owner only):\n" + diagnostic);
      } catch (diagnosticError) {
        console.error("Could not deliver futures scan diagnostic:", String(diagnosticError?.message || diagnosticError));
      }
    }
    await sendMessage(env, chatId, "⚠️ The futures scan failed. Your request was received, but no result was generated. Please try again later.", menuForChat(env, chatId));
  } finally {
    if (lockAcquired && scanLockStub && scanLockToken) {
      try {
        const releaseResponse = await scanLockStub.fetch("https://signal-delivery.internal/scan-lock/release", {
          method: "POST",
          headers: lockHeaders,
          body: JSON.stringify({ token: scanLockToken })
        });
        if (!releaseResponse.ok) console.error("Could not release manual Futures scan lock:", releaseResponse.status);
      } catch (releaseError) {
        console.error("Could not release manual Futures scan lock:", String(releaseError?.message || releaseError));
      }
    }
  }
}

async function deliverFuturesSignalAlerts(env, signals, excludeChatId = null) {
  if (!Array.isArray(signals) || !signals.length) {
    return { newSignals: 0, recipients: 0, delivered: 0, failed: 0 };
  }

  // Publish each signal once, directly to the archive channel. Signal content
  // is never fanned out to private bot chats or copied from private messages.
  let delivered = 0;
  let failed = 0;
  for (let i = 0; i < signals.length; i++) {
    const signal = signals[i];
    try {
      const result = await publishSignalToArchive(
        env, signal, formatFuturesSignalAlert(signal, i + 1), "HTML"
      );
      if (result?.published === true || (result?.duplicate === true && result?.pending !== true)) {
        delivered++;
      } else {
        failed++;
      }
    } catch (error) {
      failed++;
      console.error("Direct archive signal publication failed:", signal.symbol, String(error?.message || error));
    }
  }
  return { newSignals: signals.length, recipients: 1, delivered, failed };
}

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
          rejected: error.message || "Processing error"
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
export { FUTURES_CONFIG, mapLimit, passesLongDistanceThreshold, FUTURES_PROVIDER_ORDER, isKrakenPerpetualTicker, normalizeKrakenFuturesUnderlying, getKrakenFuturesUniverse, getKrakenFuturesCandles, calculateAtr, evaluateFuturesEntryFilters, analyzeFuturesSymbol, getFuturesUniverse, getFuturesCandles, tradeResultR, priceChangePercent, tradeOutcomePercent, targetReached, stopReached, getNewClosedFuturesCandles, ensureTradeTrackingCheckpoint, isValidFuturesSignalLevels, sendAndArchiveFuturesSignal, publishSignalToArchive, deliverFuturesSignalAlerts };
// Experimental futures signal engine validation branch; Telegram and UI handlers remain from main.

// Re-run the pinned comparison harness after switching to the current TP lifecycle.

// Keep staged TP lifecycle regression coverage active in this experiment branch.

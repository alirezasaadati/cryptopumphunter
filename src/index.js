import { analyzePriceAction } from "./price-action-engine.js";
import { FUTURES_ECONOMICS, calculateTradeEconomics, qualifyTradeEconomics } from "./futures-economics.js";
import { futuresSignalFingerprint, selectUnnotifiedFuturesSignals, futuresAlertStorageKey, formatFuturesSignalAlert, ALERT_TTL_SECONDS } from "./futures-alerts.js";

const CONFIG = {
  VERSION: "4.6.0",
  MIN_MARKET_CAP: 1_000_000,
  MAX_MARKET_CAP: 500_000_000,
  MIN_DAILY_VOLUME: 250_000,
  MAX_CANDIDATES: 35,
  MAX_RESULTS: 5,
  WATCHLIST_SIZE: 5,
  CONCURRENCY: 2,
  MIN_SCORE: 65,
  CANDLE_INTERVAL: 60,
  MIN_CANDLES: 55,
  COINLORE_PAGES: [0, 100, 200, 300, 400, 500, 600, 700, 800, 900],
  PENDING_TTL: 604800
};


const TELEGRAM_API = "https://api.telegram.org";
const seenUpdates = new Set();

const ABOUT_TEXT =
  "🤖 تریدیار | دستیار معامله‌گر فیوچرز\n\n" +
  "طراحی و توسعه: علیرضا سعادتی\n\n" +
  "© تمامی حقوق مادی و معنوی این ربات محفوظ است.\n\n" +
  "هرگونه کپی‌برداری، بازنشر یا استفاده بدون کسب اجازه از صاحب اثر مجاز نیست.";

const MAIN_MENU = {
  inline_keyboard: [
    [
      { text: "🚀 اسکن بازار", callback_data: "scan" },
      { text: "📊 تحلیل بازار", callback_data: "analysis" }
    ],
    [
      { text: "📈 سیگنال فیوچرز", callback_data: "futures" }
    ],
    [
      { text: "📌 معاملات باز", callback_data: "open_trades" },
      { text: "📚 تاریخچه معاملات", callback_data: "trade_history" }
    ],
    [
      { text: "👀 واچ‌لیست", callback_data: "watchlist" },
      { text: "📡 وضعیت ربات", callback_data: "status" }
    ],
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
    ctx.waitUntil(runAutomaticFuturesAlertScan(env));
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return json({
        ok: true,
        service: "Crypto Pump Hunter",
        version: CONFIG.VERSION,
        mode: "Manual spot scan + Kraken Derivatives Futures signals",
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
        if (env.APP_KV) {
          if (await env.APP_KV.get(key)) return new Response("OK");
          await env.APP_KV.put(key, "1", { expirationTtl: 86400 });
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
  if (isOwner(chatId, env)) keyboard.splice(keyboard.length - 1, 0, [
    { text: "👥 مدیریت اعضا", callback_data: "members:0" }
  ]);
  return { inline_keyboard: keyboard };
}
async function configureTelegramMenu(env, chatId) {
  const commands = [
    { command: "start", description: "نمایش منوی اصلی" },
    { command: "menu", description: "نمایش منوی اصلی" },
    { command: "futures", description: "دریافت سیگنال‌های فیوچرز" },
    { command: "scan", description: "اسکن دستی بازار اسپات" },
    { command: "status", description: "وضعیت سرویس" },
    { command: "help", description: "راهنمای دستورات" }
  ];
  const tasks = [
    telegram("setMyCommands", env, { commands }),
    telegram("setChatMenuButton", env, { chat_id: chatId, menu_button: { type: "commands" } }),
    telegram("setMyDescription", env, { description: "🚀 تریدیار | دستیار هوشمند شکار فرصت‌های بازار ارزهای دیجیتال\n📊 اسکن و تحلیل ساختار قیمت در تایم‌فریم‌های 4H، 1H و 15M\n🎯 چهار استراتژی مستقل Price Action: ساختار بازار، واکنش به حمایت و مقاومت، شکست و پولبک، الگوهای کندلی\n📈 شناسایی موقعیت‌های LONG و SHORT در بازار فیوچرز\n🛡️ نقاط ورود، حد ضرر ساختاری و اهداف مرحله‌ای\n⚠️ سیگنال‌ها صرفاً تحلیلی هستند و ربات سفارش واقعی ثبت نمی‌کند. استفاده از امکانات نیازمند تأیید عضویت توسط مدیر است." }),
    telegram("setMyShortDescription", env, { short_description: "دستیار هوشمند تحلیل بازار و سیگنال‌های Price Action برای فیوچرز" })
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

    if (command === "/scan") {
      await runScanForChat(env, chatId);
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
      action.startsWith("mrev:") || action.startsWith("mall:")) {
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

    if (action === "scan") {
      await runScanForChat(env, chatId);
      return;
    }

    if (action === "futures") {
      await runFuturesSignalsForChat(env, chatId);
      return;
    }
    if (action === "open_trades") return showOpenFuturesTrades(env, chatId);
    if (action === "trade_history") return showFuturesTradeHistory(env, chatId);
    if (action.startsWith("trade:")) return handleTradeAction(action, chatId, env);

    if (action === "analysis") {
      await showLastAnalysis(env, chatId);
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

async function runScanForChat(env, chatId) {
  if (!(await isApproved(chatId, env))) {
    await sendMessage(env, chatId, "⛔ دسترسی شما فعال نیست.");
    return;
  }

  await sendMessage(
    env,
    chatId,
    `🔎 اسکن هوشمند V${CONFIG.VERSION} شروع شد...\n` +
    "در حال بررسی بازار، روند، حجم، RSI و سطوح قیمتی."
  );

  const result = await runScan(env);
  await sendLongMessage(env, chatId, result.report);

  await sendMessage(
    env,
    chatId,
    "عملیات اسکن به پایان رسید.",
    menuForChat(env, chatId)
  );
}

async function showStatus(env, chatId) {
  let lastScan = "هنوز اسکن ذخیره‌شده‌ای وجود ندارد.";

  if (env.APP_KV) {
    try {
      const saved = await env.APP_KV.get("last_scan", "json");
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
    "اسپات: CoinLore و Kraken | فیوچرز: Kraken Derivatives\n" +
    `اتصال KV: ${env.APP_KV ? "فعال" : "غیرفعال"}\n` +
    `آخرین اسکن ذخیره‌شده: ${lastScan}`,
    menuForChat(env, chatId)
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
  if (!env.APP_KV) {
    await sendMessage(
      env,
      chatId,
      "⚠️ اتصال KV فعال نیست. ابتدا Binding را بررسی کن.",
      menuForChat(env, chatId)
    );
    return;
  }

  const saved = await env.APP_KV.get("last_scan", "json");

  if (!saved?.report) {
    await sendMessage(
      env,
      chatId,
      "هنوز گزارشی ذخیره نشده است.\nابتدا یک‌بار اسکن بازار را اجرا کن.",
      menuForChat(env, chatId)
    );
    return;
  }

  await sendLongMessage(env, chatId, saved.report);
  await sendMessage(env, chatId, "پایان آخرین گزارش ذخیره‌شده.", menuForChat(env, chatId));
}

async function showWatchlist(env, chatId) {
  if (!env.APP_KV) {
    await sendMessage(
      env,
      chatId,
      "⚠️ اتصال KV فعال نیست. Binding را در تنظیمات Worker بررسی کن.",
      menuForChat(env, chatId)
    );
    return;
  }

  const saved = await env.APP_KV.get("last_scan", "json");

  if (!saved?.watchlist?.length) {
    await sendMessage(
      env,
      chatId,
      "👀 واچ‌لیست خالی است.\nپس از اجرای اسکن، ارزهای منتخب اینجا ذخیره می‌شوند.",
      menuForChat(env, chatId)
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
  await sendMessage(env, chatId, "پایان واچ‌لیست.", menuForChat(env, chatId));
}

async function showConnectionTest(env, chatId) {
  await sendMessage(env, chatId, "🔌 در حال بررسی اتصال منابع داده...");
  const result = await testDataSources();
  const coinLore = result.coinlore.ok ? `✅ CoinLore: متصل (${result.coinlore.assets} ارز نمونه)` : `❌ CoinLore: ${result.coinlore.error}`;
  const kraken = result.kraken.ok ? `✅ Kraken Spot: متصل (${result.kraken.pairs} جفت معاملاتی)` : `❌ Kraken Spot: ${result.kraken.error}`;
  const futures = result.krakenFutures?.ok
    ? `✅ Kraken Futures: متصل (${result.krakenFutures.symbols} قرارداد | نمونه ${result.krakenFutures.sample} | ${result.krakenFutures.candles} کندل 1H)`
    : `❌ Kraken Futures: ${result.krakenFutures?.error || "نامشخص"}`;
  await sendMessage(env, chatId, "🔌 نتیجه تست اتصال\n\n" + coinLore + "\n\n" + kraken + "\n\n" + futures + "\n\n" + `نسخه ربات: V${CONFIG.VERSION}`, menuForChat(env, chatId));
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
  const result = { version: CONFIG.VERSION, coinlore: { ok: false }, kraken: { ok: false }, krakenFutures: { ok: false } };
  try {
    const coins = await fetchCoinLore(0, 10);
    result.coinlore = { ok: true, assets: coins.assets.length };
  } catch (error) { result.coinlore = { ok: false, error: error.message }; }
  try {
    const pairs = await getKrakenPairs();
    result.kraken = { ok: true, pairs: Object.keys(pairs).length };
  } catch (error) { result.kraken = { ok: false, error: error.message }; }
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

  if (env.APP_KV) {
    try {
      await env.APP_KV.put(
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


// ---------------- MULTI-EXCHANGE USDT-M PERPETUAL FUTURES DATA ----------------
// Public market data only. No private credentials and no order endpoints are used.
const FUTURES_CONFIG = {
  MAX_SYMBOLS: 32, // Match the working first bot's Kraken Futures universe.
  CONCURRENCY: 2,
  MIN_QUOTE_VOLUME: 3_000_000,
  PREFERRED_MIN_QUOTE_VOLUME: 5_000_000,
  KLINE_LIMIT: 120,
  MIN_CANDLES: 60,
  MIN_SCORE: 70,
  MAX_ENTRY_DRIFT_PCT: 0.35,
  SIGNAL_TTL_MINUTES: 60,
  INTERVAL: "1h",
  CONFIRM_INTERVAL: "4h",
  ENTRY_INTERVAL: "15m",
  REFERENCE_MARGIN_USD: FUTURES_ECONOMICS.REFERENCE_MARGIN_USD,
  REFERENCE_LEVERAGE: FUTURES_ECONOMICS.LEVERAGE,
  MIN_PROJECTED_PROFIT_USD: FUTURES_ECONOMICS.MIN_PROJECTED_PROFIT_USD,
  MAX_STOP_LOSS_USD: FUTURES_ECONOMICS.MAX_STOP_LOSS_USD
};

const FUTURES_PROVIDER_ORDER = ["Kraken"];

// ---------------- KRAKEN DERIVATIVES FUTURES ----------------
const KRAKEN_FUTURES_CONFIG = {
  BASE_URL: "https://futures.kraken.com",
  MIN_QUOTE_VOLUME: FUTURES_CONFIG.MIN_QUOTE_VOLUME,
  MAX_SYMBOLS: FUTURES_CONFIG.MAX_SYMBOLS
};

async function krakenFuturesJson(url, label) {
  const response = await fetch(url, { headers: { Accept: "application/json", "User-Agent": `CryptoPumpHunter/${CONFIG.VERSION}` } });
  const body = await response.text();
  if (!response.ok) throw new Error(`${label}: HTTP ${response.status}${body ? " | " + body.slice(0, 180).replace(/\s+/g, " ") : ""}`);
  let data;
  try { data = JSON.parse(body); } catch { throw new Error(`${label}: پاسخ JSON معتبر نیست.`); }
  if (data?.result && data.result !== "success") throw new Error(`${label}: ${data?.error || data?.result}`);
  return data;
}

function normalizeKrakenFuturesUnderlying(symbol) {
  const raw = String(symbol || "").toUpperCase().replace(/^(PI|PF)_/, "").replace(/USD$/, "");
  return raw === "XBT" ? "BTC" : raw;
}

// Kraken's xStocks perpetuals are tokenized equities, not crypto assets.
const KRAKEN_TOKENIZED_EQUITY_UNDERLYINGS = new Set([
  "AAPLX", "AMZNX", "COINX", "CRCLX", "GLDX", "GOOGLX", "HOODX",
  "METAX", "MSTRX", "NVDAX", "QQQX", "SPCX", "SPYX", "TSLAX"
]);

function isKrakenFuturesPerpetual(ticker) {
  const symbol = String(ticker?.symbol || "").toUpperCase();
  const underlying = normalizeKrakenFuturesUnderlying(symbol);
  return Boolean(ticker && ticker.tag === "perpetual" &&
    /^(PI|PF)_[A-Z0-9]+USD$/.test(symbol) &&
    !KRAKEN_TOKENIZED_EQUITY_UNDERLYINGS.has(underlying) &&
    Number(ticker.volumeQuote) >= KRAKEN_FUTURES_CONFIG.MIN_QUOTE_VOLUME &&
    Number(ticker.last) > 0);
}

async function getKrakenFuturesUniverse() {
  const payload = await krakenFuturesJson(`${KRAKEN_FUTURES_CONFIG.BASE_URL}/derivatives/api/v3/tickers`, "Kraken Futures tickers");
  if (!Array.isArray(payload?.tickers) || !payload.tickers.length) throw new Error("Kraken Futures فهرست تیکرها را برنگرداند.");
  const tickers = payload.tickers.filter(isKrakenFuturesPerpetual)
    .sort((a, b) => Number(b.volumeQuote) - Number(a.volumeQuote))
    .slice(0, KRAKEN_FUTURES_CONFIG.MAX_SYMBOLS)
    .map(item => ({
      symbol: String(item.symbol), underlying: normalizeKrakenFuturesUnderlying(item.symbol),
      exchange: "Kraken", last: Number(item.last), quoteVolume: Number(item.volumeQuote) || 0,
      priceChangePercent: Number(item.change24h) * 100 || 0,
      premium: { lastFundingRate: Number(item.fundingRate) || null }
    }));
  if (!tickers.length) throw new Error("هیچ قرارداد Perpetual با حجم کافی در Kraken پیدا نشد.");
  return tickers;
}

async function getKrakenFuturesCandles(symbol, interval) {
  if (!["15m", "1h", "4h"].includes(interval)) throw new Error(`بازه زمانی Kraken Futures پشتیبانی نمی‌شود: ${interval}`);
  const url = `${KRAKEN_FUTURES_CONFIG.BASE_URL}/api/charts/v1/trade/${encodeURIComponent(symbol)}/${interval}?count=${FUTURES_CONFIG.KLINE_LIMIT}`;
  const payload = await krakenFuturesJson(url, `Kraken Futures ${symbol} ${interval}`);
  if (!Array.isArray(payload?.candles)) throw new Error(`ساختار کندل‌های Kraken Futures برای ${symbol} معتبر نیست.`);
  const intervalMs = interval === "4h" ? 14400000 : interval === "15m" ? 900000 : 3600000;
  return payload.candles.map(row => {
    let time = Number(row.time);
    if (time > 0 && time < 1e12) time *= 1000;
    return { time, open: Number(row.open), high: Number(row.high), low: Number(row.low), close: Number(row.close), volume: Number(row.volume) };
  }).filter(x => Number.isFinite(x.time) && Number.isFinite(x.open) && Number.isFinite(x.close) && x.close > 0 &&
    Number.isFinite(x.high) && Number.isFinite(x.low) && x.high >= x.low && x.low > 0 &&
    Number.isFinite(x.volume) && x.volume >= 0)
    .sort((a, b) => a.time - b.time).filter(x => x.time + intervalMs <= Date.now());
}

const FUTURES_PROVIDER_LOADERS = { Kraken: getKrakenFuturesUniverse };

async function getFuturesUniverse() {
  const tickers = await getKrakenFuturesUniverse();
  if (!Array.isArray(tickers) || !tickers.length) throw new Error("Kraken Futures قرارداد Perpetual با حجم کافی برنگرداند.");
  return { exchange: "Kraken", tickers, fallbackReason: null };
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

function analyzeFuturesSymbol(ticker, candles1h, candles4h, candles15m) {
  const result = analyzePriceAction({
    symbol: ticker.symbol,
    oneHour: candles1h,
    fourHour: candles4h,
    fifteenMin: candles15m,
    livePrice: Number(ticker.last)
  });
  if (!result.signals?.length) {
    return {
      symbol: ticker.symbol,
      exchange: ticker.exchange || "Kraken",
      analysisCompleted: true,
      rejected: result.rejected || "هیچ‌یک از چهار ستاپ مستقل Price Action تأیید نشد.",
      conflict: Boolean(result.conflict),
      diagnostics: result.diagnostics || []
    };
  }
  // Apply dollar-risk and staged-profit filters before a signal can be sent.
  const economicallyQualified = result.signals.map(signal => {
    const economics = calculateTradeEconomics(signal);
    const qualification = qualifyTradeEconomics(economics);
    return { ...signal, economics, economicsRejection: qualification.reason, eligible: qualification.eligible };
  }).filter(signal => signal.eligible);
  if (!economicallyQualified.length) {
    const rejected = result.signals.map(signal => qualifyTradeEconomics(calculateTradeEconomics(signal)).reason).filter(Boolean);
    const reason = rejected[0]||"بازده اقتصادی معامله با معیارهای مدیریت سرمایه سازگار نیست.";
    const diagnostics = (result.diagnostics||[]).map(d => d.status==="accepted" ? {...d,status:"economic_rejection",statusLabel:"رد به‌دلیل بازده/ریسک دلاری",reason} : d);
    return { symbol:ticker.symbol, exchange:ticker.exchange||"Kraken", analysisCompleted:true, eligible:false,
      economicsRejected:true, rejected:reason, diagnostics };
  }
  const best = economicallyQualified[0];
  return {
    ...best,
    exchange: ticker.exchange || "Kraken",
    analysisCompleted: true,
    score: best.score,
    price: candles1h.at(-1).close,
    entry: best.entry,
    candleTime: best.setupTime,
    reasons: [best.reason],
    quoteVolume: Number(ticker.quoteVolume) || 0,
    change24h: Number(ticker.priceChangePercent) || 0,
    eligible: true,
    conflict: false,
    diagnostics: result.diagnostics || []
  };
}

function formatFuturesSignal(item, index = 1) {
  const sideLabel = item.side === "LONG" ? "🟢 لانگ" : "🔴 شورت";
  return `🎯 سیگنال ${Number(index).toLocaleString("fa-IR")}\n` +
    "━━━━━━━━━━━━━━━━━━\n" +
    `🪙 نماد: ${formatFuturesSymbol(item.symbol)}\n` +
    `🧭 جهت معامله: ${sideLabel}\n` +
    `📍 ورود: ${formatPrice(item.entry)}\n` +
    `🛑 حد ضرر: ${formatPrice(item.stop)}\n` +
    `🎯 تارگت ۱: ${formatPrice(item.target1)}\n` +
    `🎯 تارگت ۲: ${formatPrice(item.target2)}\n` +
    `🎯 تارگت ۳: ${formatPrice(item.target3)}\n` +
    (item.economics ? `💵 سود تخمینی خروج ۲۰/۲۰/۶۰: ${item.economics.projectedProfitUsd.toFixed(2)} به‌ازای ${item.economics.referenceMarginUsd} مارجین با لوریج ${item.economics.leverage}x\n🛑 ضرر تخمینی تا استاپ: ${item.economics.maxLossUsd.toFixed(2)}\n` : "") +
    "\n⚠️ محاسبات ناخالص‌اند و کارمزد، فاندینگ و لغزش قیمت را شامل نمی‌شوند؛ سفارش واقعی ثبت نمی‌شود.";
}

function formatFuturesSymbol(symbol) {
  return String(symbol || "—").toUpperCase().replace(/\.P$/, "").replace(/[-_/]?USDT$/, "");
}


// V4 migration: legacy spot/futures features plus isolated, user-confirmed trade tracking.
// ---------------- INDEPENDENT FUTURES TRADE LIFECYCLE ----------------
const FUTURES_PENDING_KEY = "futures_pending_signals";
const FUTURES_OPEN_KEY = "futures_open_trades";
const FUTURES_CLOSED_KEY = "futures_closed_trades";
async function readTradeList(env,key) {
  if (!env.APP_KV) throw new Error("APP_KV binding is missing");
  const raw=await env.APP_KV.get(key); if(!raw)return [];
  try { const v=JSON.parse(raw); return Array.isArray(v)?v:[]; } catch { return []; }
}
async function writeTradeList(env,key,value) {
  if(!env.APP_KV)throw new Error("APP_KV binding is missing");
  await env.APP_KV.put(key,JSON.stringify(value));
}
async function savePendingFuturesSignals(env, fresh) {
  const now = Date.now();
  const old = await readTradeList(env, FUTURES_PENDING_KEY);
  const byFingerprint = new Map();
  for (const signal of old.filter(x => x.expiresAt > now)) {
    const fingerprint = futuresSignalFingerprint(signal);
    if (fingerprint && !byFingerprint.has(fingerprint)) byFingerprint.set(fingerprint, signal);
  }
  for (const signal of fresh) {
    const fingerprint = futuresSignalFingerprint(signal);
    if (fingerprint && !byFingerprint.has(fingerprint)) byFingerprint.set(fingerprint, signal);
  }
  const merged = [...byFingerprint.values()].slice(0, 150);
  await writeTradeList(env, FUTURES_PENDING_KEY, merged);
  return fresh.map(signal => byFingerprint.get(futuresSignalFingerprint(signal))).filter(Boolean);
}
const tradeDir=side=>side==="LONG"?1:-1;
const targetReached=(side,p,t)=>side==="LONG"?p>=t:p<=t;
const stopReached=(side,p,t)=>side==="LONG"?p<=t:p>=t;
function tradeResultR(t,includeRemainder) {
  const weights = Array.isArray(t.exitWeights) && t.exitWeights.length===3 ? t.exitWeights : [.40,.35,.25];
  const levels=[["TP1",weights[0],1.5],["TP2",weights[1],2.2],["TP3",weights[2],3.0]];
  let r=0,weight=0;
  for(const [k,w,m] of levels)if((t.tpHits||[]).includes(k)){r+=w*m;weight+=w;}
  if(includeRemainder)r+=(1-weight)*tradeDir(t.side)*(t.currentStop-t.actualEntry)/t.initialRisk;
  return r;
}
async function handleTradeAction(action,chatId,env) {
  const [,op,id]=action.split(":");
  if(!id)return;
  if(op==="be") {
    const open=await readTradeList(env,FUTURES_OPEN_KEY);
    const t=open.find(x=>x.id===id&&String(x.chatId)===String(chatId));
    if(!t)return sendMessage(env,chatId,"معامله باز پیدا نشد.");
    t.currentStop=t.actualEntry;t.breakEvenConfirmed=true;t.breakEvenAt=new Date().toISOString();
    await writeTradeList(env,FUTURES_OPEN_KEY,open);
    return sendMessage(env,chatId,"✅ حد ضرر در دفتر پیگیری به نقطه ورود منتقل شد. این تغییر را باید دستی در صرافی هم انجام داده باشی.");
  }
  const pending=await readTradeList(env,FUTURES_PENDING_KEY);
  const signal=pending.find(x=>x.id===id);
  if(!signal||signal.expiresAt<=Date.now())return sendMessage(env,chatId,"⏳ سیگنال پیدا نشد یا اعتبار ورود آن تمام شده است.");
  if(op==="skip")return sendMessage(env,chatId,"سیگنال برای این نوبت رد شد؛ معاملات باز قبلی تغییری نمی‌کنند.");
  if(op!=="enter")return;
  const open=await readTradeList(env,FUTURES_OPEN_KEY),closed=await readTradeList(env,FUTURES_CLOSED_KEY);
  if([...open,...closed].some(x=>x.signalId===id&&String(x.chatId)===String(chatId)))return sendMessage(env,chatId,"برای این سیگنال قبلاً معامله ثبت شده است.");
  return sendMessage(env,chatId,`برای ثبت معامله، قیمت واقعی ورود را بفرست:\n/fill ${id} قیمت_واقعی_ورود\n\nقیمت باید حداکثر ${FUTURES_CONFIG.MAX_ENTRY_DRIFT_PCT}٪ با Entry سیگنال اختلاف داشته باشد.`);
}
async function handleFillCommand(env,chatId,message) {
  const p=String(message?.text||"").trim().split(/\s+/),id=p[1],entry=Number(p[2]);
  if(!id||!Number.isFinite(entry)||entry<=0)return sendMessage(env,chatId,"فرمت صحیح: /fill شناسه_سیگنال قیمت_واقعی_ورود");
  const pending=await readTradeList(env,FUTURES_PENDING_KEY),signal=pending.find(x=>x.id===id);
  if(!signal||signal.expiresAt<=Date.now())return sendMessage(env,chatId,"سیگنال منقضی یا نامعتبر است؛ معامله ثبت نشد.");
  const drift=Math.abs(entry-signal.entry)/signal.entry*100;
  if(drift>FUTURES_CONFIG.MAX_ENTRY_DRIFT_PCT)return sendMessage(env,chatId,`⛔ ورود ثبت نشد؛ اختلاف قیمت ${drift.toFixed(3)}٪ و بیشتر از حد مجاز است. سیگنال را تعقیب نکن.`);
  const open=await readTradeList(env,FUTURES_OPEN_KEY),closed=await readTradeList(env,FUTURES_CLOSED_KEY);
  if([...open,...closed].some(x=>x.signalId===id&&String(x.chatId)===String(chatId)))return sendMessage(env,chatId,"این سیگنال قبلاً ثبت شده است.");
  const risk=tradeDir(signal.side)*(entry-signal.stop);
  if(!Number.isFinite(risk)||risk<=0)return sendMessage(env,chatId,"قیمت ورود با حد ضرر سازگار نیست؛ ثبت نشد.");
  open.unshift({id:crypto.randomUUID(),signalId:id,chatId:String(chatId),symbol:signal.symbol,exchange:signal.exchange||"Kraken",side:signal.side,
    strategyId:signal.strategyId||"legacy",strategyName:signal.strategyName||"نامشخص",reason:signal.reason||"",
    plannedEntry:signal.entry,actualEntry:entry,initialStop:signal.stop,currentStop:signal.stop,
    target1:signal.target1,target2:signal.target2,target3:signal.target3,initialRisk:risk,
    exitWeights:[.20,.20,.60],tpHits:[],breakEvenConfirmed:false,status:"OPEN",createdAt:new Date().toISOString(),lastPrice:entry});
  await writeTradeList(env,FUTURES_OPEN_KEY,open.slice(0,100));
  return sendMessage(env,chatId,`✅ معامله در دفتر پیگیری ثبت شد.\n${signal.symbol} | ${signal.side}\nورود واقعی: ${formatPrice(entry)}\nحد ضرر: ${formatPrice(signal.stop)}\nاهداف: ${formatPrice(signal.target1)} / ${formatPrice(signal.target2)} / ${formatPrice(signal.target3)}\n\n⚠️ فقط پایش تحلیلی است؛ سفارش واقعی ثبت نمی‌شود.`);
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
      t.status="CLOSED_STOP";t.closedAt=new Date().toISOString();t.exitPrice=price;t.outcomeR=tradeResultR(t,true);
      closed.unshift(t);
      await sendMessage(env,chatId,`🛑 ${t.symbol} به حد ضرر فعلی رسید. نتیجه نظری: ${t.outcomeR.toFixed(2)}R | اهداف لمس‌شده: ${t.tpHits.join(",")||"هیچ‌کدام"}`);
      continue;
    }
    const favorableR=tradeDir(t.side)*(price-t.actualEntry)/t.initialRisk;
    if(favorableR>=0.75&&!t.protectionAlerted&&!t.breakEvenConfirmed) {
      t.protectionAlerted=true;
      await sendMessage(env,chatId,`🛡️ قیمت ${t.symbol} به +0.75R رسیده؛ یعنی نصف مسیر هدف اول. برای جلوگیری از تبدیل سود شناور به زیان، انتقال حد ضرر باقی‌مانده به نقطه ورود را بررسی کن. اگر واقعاً در صرافی انجامش دادی، تأیید کن.`,
        {inline_keyboard:[[{text:"✅ حد ضرر را به ورود منتقل کردم",callback_data:`trade:be:${t.id}`}]]});
    }
    const levels=[["TP1",t.target1],["TP2",t.target2],["TP3",t.target3]],hits=[];
    for(const [key,target] of levels)if(!t.tpHits.includes(key)&&targetReached(t.side,price,target)){t.tpHits.push(key);hits.push(key);}
    for(const hit of hits) {
      if(hit==="TP1")await sendMessage(env,chatId,`🎯 هدف اول ${t.symbol} لمس شد. ۲۰٪ حجم در مدل ثبت شد. اگر واقعاً بخشی از معامله را بسته‌ای، حد ضرر باقی‌مانده را در صرافی به نقطه ورود منتقل کن و سپس تأیید کن.`,
        {inline_keyboard:[[{text:"✅ حد ضرر را به ورود منتقل کردم",callback_data:`trade:be:${t.id}`}]]});
      if(hit==="TP2")await sendMessage(env,chatId,`🥈 هدف دوم ${t.symbol} لمس شد؛ ۲۰٪ دیگر در مدل ثبت شد. ۶۰٪ باقی‌مانده برای هدف سوم است.`);
    }
    if(t.tpHits.includes("TP3")) {
      t.status="CLOSED_TARGETS";t.closedAt=new Date().toISOString();t.exitPrice=price;t.outcomeR=tradeResultR(t,false);
      closed.unshift(t);await sendMessage(env,chatId,`🏁 هر سه هدف ${t.symbol} لمس شد. نتیجه نظری پیش از کارمزد: +${t.outcomeR.toFixed(2)}R.`);continue;
    }
    remaining.push(t);
  }
  await writeTradeList(env,FUTURES_OPEN_KEY,remaining);
  await writeTradeList(env,FUTURES_CLOSED_KEY,closed.slice(0,300));
}
async function showOpenFuturesTrades(env,chatId) {
  try {
    const tickers=(await getFuturesUniverse()).tickers;
    await refreshOpenFuturesTrades(env,chatId,tickers);
  } catch (error) {
    console.error("Open trade refresh failed:",error);
  }
  const list=(await readTradeList(env,FUTURES_OPEN_KEY)).filter(t=>String(t.chatId)===String(chatId));
  if(!list.length)return sendMessage(env,chatId,"📭 معامله بازی در دفتر پیگیری ثبت نشده است.",BACK_MENU);
  const body=list.slice(0,15).map(t=>`${t.side} ${t.symbol} | ${t.exchange||"Kraken"} | ${t.strategyName||"استراتژی ثبت‌نشده"}\nورود واقعی: ${formatPrice(t.actualEntry)} | قیمت آخر: ${formatPrice(t.lastPrice)}\nحد ضرر: ${formatPrice(t.currentStop)}\nاهداف: ${formatPrice(t.target1)} / ${formatPrice(t.target2)} / ${formatPrice(t.target3)}\nاهداف لمس‌شده: ${t.tpHits.join(",")||"—"}`).join("\n\n");
  return sendLongMessage(env,chatId,"📌 معاملات باز\n━━━━━━━━━━━━━━━━━━\n"+body+"\n\n⚠️ فقط هنگام اسکن دستی به‌روزرسانی می‌شوند؛ سفارش واقعی ثبت نمی‌شود.");
}
async function showFuturesTradeHistory(env,chatId) {
  const list=(await readTradeList(env,FUTURES_CLOSED_KEY)).filter(t=>String(t.chatId)===String(chatId)).slice(0,15);
  if(!list.length)return sendMessage(env,chatId,"📚 هنوز معامله بسته‌شده‌ای ثبت نشده است.",BACK_MENU);
  const body=list.map(t=>`${t.symbol} | ${t.side} | ${t.strategyName||"استراتژی ثبت‌نشده"}\nورود: ${formatPrice(t.actualEntry)} | خروج: ${formatPrice(t.exitPrice)}\nدلیل ورود: ${t.reason||"—"}\nنتیجه نظری: ${Number(t.outcomeR).toFixed(2)}R | اهداف: ${t.tpHits.join(",")||"—"}`).join("\n\n");
  return sendLongMessage(env,chatId,"📚 تاریخچه معاملات\n━━━━━━━━━━━━━━━━━━\n"+body);
}

async function runAutomaticFuturesAlertScan(env) {
  if (!env.APP_KV) throw new Error("APP_KV binding is required for automatic alerts.");
  const lockKey = "futures:auto-alerts:scan-lock";
  const queueKey = "futures:auto-alerts:pending-broadcasts";
  if (await env.APP_KV.get(lockKey)) return { skipped: true, reason: "scan already running" };
  await env.APP_KV.put(lockKey, String(Date.now()), { expirationTtl: 240 });
  try {
    const result = await runFuturesSignalScan(env);
    let queue = await env.APP_KV.get(queueKey, "json") || [];
    if (!Array.isArray(queue)) queue = [];
    const queuedFingerprints = new Set(queue.map(item => item.fingerprint));
    const fresh = selectUnnotifiedFuturesSignals(result.signals || [], queuedFingerprints);
    queue = [...queue, ...fresh.map(item => ({ ...item, queuedAt: Date.now() }))].slice(-100);
    if (queue.length) await env.APP_KV.put(queueKey, JSON.stringify(queue), { expirationTtl: 86400 });
    if (!queue.length) return { scanned: true, newSignals: 0, recipients: 0 };

    await migrateLegacyMembership(env);
    const recipients = new Set();
    if ((env.OWNER_TELEGRAM_ID || env.OWNER_ID)) recipients.add(String((env.OWNER_TELEGRAM_ID || env.OWNER_ID)));
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
    await mapLimit([...recipients], 4, async chatId => {
      const pending = [];
      for (const item of queue) {
        const key = futuresAlertStorageKey(chatId, item.fingerprint);
        if (!(await env.APP_KV.get(key))) pending.push({ ...item, key });
      }
      if (!pending.length) return;
      try {
        for (let i = 0; i < pending.length; i++) {
          const item = pending[i];
          await sendMessage(env, chatId, formatFuturesSignalAlert(item.signal, i + 1, pending.length));
          await env.APP_KV.put(item.key, "sent", { expirationTtl: ALERT_TTL_SECONDS });
        }
        delivered++;
      } catch (error) {
        failed++;
        console.error("Automatic futures alert delivery failed", chatId, String(error?.message || error));
      }
    });
    if (failed === 0 && recipients.size > 0) await env.APP_KV.delete(queueKey);
    return { scanned: true, newSignals: fresh.length, queuedSignals: queue.length, recipients: recipients.size, delivered, failed };
  } finally {
    await env.APP_KV.delete(lockKey);
  }
}

async function runFuturesSignalScan(env) {
  const started = Date.now();
  const failoverReasons = [];
  let universeResult = null;
  let universe = [];
  let activeExchange = "";
  let universeMs = 0;
  let candleFetchMs = 0;
  let analysisMs = 0;
  let analyzed = [];
  let nextProviderIndex = 0;

  while (nextProviderIndex < FUTURES_PROVIDER_ORDER.length) {
    const universeStarted = Date.now();
    try {
      universeResult = await getFuturesUniverse(nextProviderIndex);
    } catch (error) {
      failoverReasons.push(String(error.message || error));
      break;
    }
    universeMs += Date.now() - universeStarted;
    universe = universeResult.tickers;
    activeExchange = universeResult.exchange;
    if (universeResult.fallbackReason) failoverReasons.push(universeResult.fallbackReason);
    const activeIndex = FUTURES_PROVIDER_ORDER.indexOf(activeExchange);
    nextProviderIndex = activeIndex + 1;

    let attemptCandleFetchMs = 0;
    let attemptAnalysisMs = 0;
    analyzed = await mapLimit(universe, FUTURES_CONFIG.CONCURRENCY, async ticker => {
      try {
        const fetchStarted = Date.now();
        const [oneHour, fourHour, fifteenMin] = await Promise.all([
          getFuturesCandles(activeExchange, ticker.symbol, FUTURES_CONFIG.INTERVAL),
          getFuturesCandles(activeExchange, ticker.symbol, FUTURES_CONFIG.CONFIRM_INTERVAL),
          getFuturesCandles(activeExchange, ticker.symbol, FUTURES_CONFIG.ENTRY_INTERVAL)
        ]);
        const dataFetchMs = Date.now() - fetchStarted;
        attemptCandleFetchMs += dataFetchMs;
        const analysisStarted = Date.now();
        const result = analyzeFuturesSymbol(ticker, oneHour, fourHour, fifteenMin);
        const symbolAnalysisMs = Date.now() - analysisStarted;
        attemptAnalysisMs += symbolAnalysisMs;
        return { ...result, timing: { dataFetchMs, analysisMs: symbolAnalysisMs } };
      } catch (error) {
        return {
          symbol: ticker.symbol, exchange: activeExchange,
          analysisCompleted: false, rejected: error.message || "خطای تحلیل"
        };
      }
    });
    candleFetchMs += attemptCandleFetchMs;
    analysisMs += attemptAnalysisMs;

    const failedSymbols = analyzed.filter(x => x?.analysisCompleted === false);
    if (!failedSymbols.length) break;

    failoverReasons.push(
      `${activeExchange}: دریافت کندل برای ${failedSymbols.length} نماد از ${universe.length} نماد ناموفق بود؛ ${nextProviderIndex < FUTURES_PROVIDER_ORDER.length ? "اسکن کامل بدون ترکیب داده به منبع بعدی منتقل می‌شود." : "منبع جایگزین دیگری باقی نمانده است."} نمونه: ${failedSymbols.slice(0, 3).map(x => x.symbol + " (" + x.rejected + ")").join("; ")}`
    );
    if (nextProviderIndex >= FUTURES_PROVIDER_ORDER.length) break;
    universeResult = null;
  }

  if (!universeResult || !universe.length) {
    throw new Error(`هیچ منبع Futures نتوانست داده معتبر فراهم کند. ${failoverReasons.join(" | ")}`);
  }
  universeResult.fallbackReason = failoverReasons.length ? failoverReasons.join(" | ") : null;
  if (!universe.length) {
    return { report: "⚠️ قرارداد دائمی USDT با حجم کافی پیدا نشد.", signals: [] };
  }
  const createdAt = Date.now();
  const generatedSignals = analyzed.filter(x => x?.eligible).sort((a, b) => b.score - a.score).slice(0, 10)
    .map(x => ({ ...x, id: crypto.randomUUID(), createdAt, expiresAt: createdAt + FUTURES_CONFIG.SIGNAL_TTL_MINUTES * 60000, status: "PENDING" }));
  const signals = await savePendingFuturesSignals(env, generatedSignals);
  const validData = analyzed.filter(x => x?.analysisCompleted === true).length;
  const dataErrors = analyzed.filter(x => x?.analysisCompleted === false).length;
  const setupRejected = analyzed.filter(x => x?.analysisCompleted === true && !x?.eligible).length;
  const highLiquidityCount = universe.filter(x => x.quoteVolume >= FUTURES_CONFIG.PREFERRED_MIN_QUOTE_VOLUME).length;
  const rejected = analyzed.filter(x => x?.rejected).slice(0, 8);
  let report = `📈 CRYPTO PUMP HUNTER V${CONFIG.VERSION} — KRAKEN FUTURES\n` +
    "━━━━━━━━━━━━━━━━━━\n" +
    `🏦 بازار: ${activeExchange} USDT Perpetual\n` +
    "⏱ تایم‌فریم: زمینه 4H | ساختار 1H | تأیید ورود 15M (Price Action)\n" +
    "💰 فیلتر اقتصادی: مارجین مرجع $10، لوریج 10x، سود ناخالص حداقل $2، ریسک استاپ حداکثر $2، خروج ۲۰/۲۰/۶۰\n" +
    `📥 نمادهای بررسی‌شده: ${universe.length} (سقف ${FUTURES_CONFIG.MAX_SYMBOLS})\n` +
    `💧 نمادهای با حجم روزانه بالای ۵ میلیون دلار: ${highLiquidityCount}\n` +
    `📊 تحلیل‌های موفق با داده کامل: ${validData}\n` +
    `⛔ رد به‌دلیل نبود ستاپ/تعارض: ${setupRejected}\n` +
    `⚠️ خطای دریافت داده: ${dataErrors}\n` +
    `⭐ سیگنال‌های واجد شرایط: ${signals.length}\n\n`;
  if (signals.length) {
    report += "🎯 سیگنال‌های فعلی\n━━━━━━━━━━━━━━━━━━\n\n";
    for (const item of signals) report += formatFuturesSignal(item) + "\n━━━━━━━━━━━━━━━━━━\n\n";
  } else {
    report += "⚠️ در این بررسی هیچ‌یک از چهار ستاپ Price Action به تأیید نهایی نرسید یا تعارض جهت وجود داشت.\n\n";
  }
  if (universeResult.fallbackReason) {
    report += `🔁 منبع اصلی/قبلی در دسترس نبود؛ اسکن کامل با ${activeExchange} انجام شد. علت: ${universeResult.fallbackReason}\n\n`;
  }
  if (rejected.length) {
    report += "🧪 نمونه دلایل رد نمادها\n";
    for (const item of rejected) report += `• ${item.symbol}: ${item.rejected}\n`;
  }
  const strategyDiagnostics = analyzed.flatMap(item =>
    (item.diagnostics || []).map(d => ({ symbol: item.symbol, ...d }))
  );
  const statusCounts = strategyDiagnostics.reduce((counts, d) => {
    counts[d.status] = (counts[d.status] || 0) + 1;
    return counts;
  }, {});
  const statusOrder = [
    ["accepted", "تأیید فنی"],
    ["economic_rejection", "رد بازده/ریسک دلاری"],
    ["late_entry", "فاصله زیاد قیمت از ورود"],
    ["conflict", "تعارض جهت"],
    ["below_score", "امتیاز ناکافی"],
    ["no_setup", "بدون ستاپ"],
    ["strategy_error", "خطای استراتژی"],
    ["invalid_data", "داده ناکافی"]
  ];
  report += "\n🔬 گزارش تشخیصی چهار استراتژی\n";
  report += statusOrder
    .filter(([key]) => statusCounts[key])
    .map(([key, label]) => `• ${label}: ${statusCounts[key]} مورد`)
    .join("\n") + "\n\n";
  for (const item of analyzed) {
    if (!item.diagnostics?.length) continue;
    report += `📍 ${item.symbol}\n`;
    for (const d of item.diagnostics) {
      report += `  • ${d.strategyName}: ${d.statusLabel}`;
      if (d.score !== null && d.score !== undefined) report += ` | امتیاز ${d.score}`;
      if (d.side) report += ` | ${d.side}`;
      if (d.reason) report += ` | ${d.reason}`;
      report += "\n";
    }
    if (item.timing) report += `  ⏱ دریافت داده: ${item.timing.dataFetchMs}ms | تحلیل: ${item.timing.analysisMs}ms\n`;
  }
  report += `\n🕒 زمان تهیه گزارش: ${new Date().toISOString()}\n` +
    `⏱ مدت کل بررسی: ${((Date.now() - started) / 1000).toFixed(2)} ثانیه\n` +
    `⏱ جزئیات زمان: فهرست نمادها ${universeMs}ms | مجموع دریافت کندل‌ها ${candleFetchMs}ms | مجموع تحلیل‌ها ${analysisMs}ms\n` +
    `📡 منبع داده: API عمومی Kraken Derivatives Futures\n` +
    "⚠️ سیگنال‌ها تحلیلی‌اند؛ سفارش واقعی ثبت نمی‌شود و سود تضمین نیست. قیمت ممکن است پس از بسته‌شدن کندل تغییر کند.";

  if (env.APP_KV) {
    try {
      await env.APP_KV.put("last_futures_scan", JSON.stringify({
        version: CONFIG.VERSION,
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
  return { report, signals, tickers: universe, exchange: activeExchange, fallbackReason: universeResult.fallbackReason };
}

async function runFuturesSignalsForChat(env, chatId) {
  if (!(await isApproved(chatId, env))) {
    await sendMessage(env, chatId, "⛔ دسترسی شما فعال نیست.");
    return;
  }
  try {
    const result = await runFuturesSignalScan(env);
    await refreshOpenFuturesTrades(env, chatId, result.tickers || []);
    const signals = result.signals || [];
    if (!signals.length) {
      await sendMessage(env, chatId, "📊 فعلاً سیگنال جدیدی وجود ندارد.\nبازار همچنان به‌صورت خودکار بررسی می‌شود.", menuForChat(env, chatId));
      return;
    }
    for (let i = 0; i < signals.length; i++) {
      const signal = signals[i];
      await sendMessage(env, chatId, formatFuturesSignal(signal, i + 1),
        { inline_keyboard: [[
          { text: "✅ ثبت ورود", callback_data: `trade:enter:${signal.id}` },
          { text: "⏭ رد سیگنال", callback_data: `trade:skip:${signal.id}` }
        ]] });
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
export { FUTURES_CONFIG, FUTURES_PROVIDER_ORDER, isKrakenFuturesPerpetual, normalizeKrakenFuturesUnderlying, getKrakenFuturesUniverse, getKrakenFuturesCandles, calculateAtr, analyzeFuturesSymbol, getFuturesUniverse, getFuturesCandles, tradeResultR, calculateTradeEconomics, qualifyTradeEconomics };
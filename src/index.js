import { runSpotScan } from "./spot-engine.js";
import { futuresSignalFingerprint, selectUnnotifiedFuturesSignals, futuresAlertStorageKey, formatFuturesSignalAlert, ALERT_TTL_SECONDS } from "./futures-alerts.js";

const CONFIG = {
  VERSION: "4.6.0",
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
      { text: "📈 سیگنال فیوچرز", callback_data: "futures" }
    ],
    [
      { text: "🔎 اسکن بازار", callback_data: "market_scan" },
      { text: "📊 تحلیل بازار", callback_data: "market_analysis" }
    ],
    [
      { text: "📌 معاملات باز", callback_data: "open_trades" },
      { text: "📚 تاریخچه معاملات", callback_data: "trade_history" }
    ],
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
    ctx.waitUntil(runAutomaticFuturesAlertScan(env));
  },

  async fetch(request, env, ctx) {
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
    { command: "status", description: "وضعیت سرویس" },
    { command: "help", description: "راهنمای دستورات" }
  ];
  const tasks = [
    telegram("setMyCommands", env, { commands }),
    telegram("setChatMenuButton", env, { chat_id: chatId, menu_button: { type: "commands" } }),
    telegram("setMyDescription", env, { description: "🤖 تریدیار | ربات تخصصی سیگنال‌دهی فیوچرز\n📊 شناسایی فرصت‌های LONG و SHORT در بازار Kraken Derivatives\n⏱ بررسی روند در تایم‌فریم‌های 1H و 4H\n🎯 ارائه نقاط ورود، حد ضرر و اهداف معاملاتی\n⚠️ سیگنال‌ها تحلیلی‌اند؛ ربات سفارش واقعی ثبت نمی‌کند." }),
    telegram("setMyShortDescription", env, { short_description: "ربات شناسایی سیگنال‌های LONG و SHORT فیوچرز" })
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
    if (action === "trade_history") return showFuturesTradeHistory(env, chatId);
    if (action.startsWith("trade:")) return handleTradeAction(action, chatId, env);
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
  const intervalMsMap={"1m":60000,"5m":300000,"15m":900000,"30m":1800000,"1h":3600000,"4h":14400000,"12h":43200000,"1d":86400000,"1w":604800000};\n  const intervalMs=intervalMsMap[interval]||3600000;
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

  if (up1h && up4h && rsiValue >= 48 && rsiValue <= 69) {
    side = "LONG";
    score = 45;
    reasons.push("روند ۱ساعته و ۴ساعته صعودی است", "قیمت بالای EMA20 قرار دارد");
    score += rsiValue >= 52 && rsiValue <= 65 ? 15 : 9;
  } else if (down1h && down4h && rsiValue >= 31 && rsiValue <= 52) {
    side = "SHORT";
    score = 45;
    reasons.push("روند ۱ساعته و ۴ساعته نزولی است", "قیمت زیر EMA20 قرار دارد");
    score += rsiValue >= 35 && rsiValue <= 48 ? 15 : 9;
  } else {
    return { symbol: ticker.symbol, rejected: "هم‌جهتی روند ۱ساعته و ۴ساعته یا محدوده RSI تأیید نشد" };
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
  const eligible = score >= FUTURES_CONFIG.MIN_SCORE && volumeRatio >= 0.75;
  return {
    symbol: ticker.symbol,
    side,
    score,
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
  const sideLabel = item.side === "LONG" ? "🟢 لانگ" : "🔴 شورت";
  return `🎯 سیگنال ${Number(index).toLocaleString("fa-IR")}\n` +
    "━━━━━━━━━━━━━━━━━━\n" +
    `🪙 نماد: ${formatFuturesSymbol(item.symbol)}\n` +
    `🧭 جهت معامله: ${sideLabel}\n` +
    `📍 ورود: ${formatPrice(item.entry)}\n` +
    `🛑 حد ضرر: ${formatPrice(item.stop)}\n` +
    `🎯 تارگت ۱: ${formatPrice(item.target1)}\n` +
    `🎯 تارگت ۲: ${formatPrice(item.target2)}\n` +
    `🎯 تارگت ۳: ${formatPrice(item.target3)}\n\n` +
    "⚠️ سیگنال تحلیلی است؛ سفارش واقعی ثبت نمی‌شود.";
}

function formatFuturesSymbol(symbol) {
  return String(symbol || "—").toUpperCase().replace(/\.P$/, "").replace(/[-_/]?USDT$/, "");
}


// V4.6: automatic signal-outcome tracking.
const FUTURES_PENDING_KEY="futures_pending_signals";
const FUTURES_OPEN_KEY="futures_open_trades";
const FUTURES_CLOSED_KEY="futures_closed_trades";
async function readTradeList(env,key){if(!env.APP_KV)throw new Error("APP_KV binding is missing");const raw=await env.APP_KV.get(key);if(!raw)return[];try{const v=JSON.parse(raw);return Array.isArray(v)?v:[]}catch{return[]}}
async function writeTradeList(env,key,value){if(!env.APP_KV)throw new Error("APP_KV binding is missing");await env.APP_KV.put(key,JSON.stringify(value))}
async function savePendingFuturesSignals(env,fresh){const now=Date.now(),old=await readTradeList(env,FUTURES_PENDING_KEY),m=new Map();for(const x of old.filter(v=>v.expiresAt>now)){const f=futuresSignalFingerprint(x);if(f&&!m.has(f))m.set(f,x)}for(const x of fresh){const f=futuresSignalFingerprint(x);if(f&&!m.has(f))m.set(f,x)}const merged=[...m.values()].slice(0,150);await writeTradeList(env,FUTURES_PENDING_KEY,merged);return fresh.map(x=>m.get(futuresSignalFingerprint(x))).filter(Boolean)}
const tradeDir=side=>side==="LONG"?1:-1;
const targetReached=(side,p,t)=>side==="LONG"?p>=t:p<=t;
const stopReached=(side,p,t)=>side==="LONG"?p<=t:p>=t;
function priceChangePercent(side,entry,exit){const e=Number(entry),x=Number(exit);return Number.isFinite(e)&&e>0&&Number.isFinite(x)?tradeDir(side)*(x-e)/e*100:null}
function tradeResultR(t,includeRemainder){const levels=[["TP1",.4,1.5],["TP2",.35,2.2],["TP3",.25,3]],r=[0,0];for(const[k,w,m]of levels)if((t.tpHits||[]).includes(k)){r[0]+=w*m;r[1]+=w}if(includeRemainder)r[0]+=(1-r[1])*tradeDir(t.side)*(t.currentStop-t.actualEntry)/t.initialRisk;return r[0]}
function tradeOutcomePercent(t,exitPrice){const e=Number(t.actualEntry);if(!Number.isFinite(e)||e<=0)return null;const levels=[["TP1",.4,t.target1],["TP2",.35,t.target2],["TP3",.25,t.target3]];let out=0,w=0;for(const[k,wt,target]of levels)if((t.tpHits||[]).includes(k)&&Number.isFinite(Number(target))){const p=priceChangePercent(t.side,e,target);if(p!==null){out+=wt*p;w+=wt}}if(w<1){const p=priceChangePercent(t.side,e,exitPrice);if(p!==null)out+=(1-w)*p}return out}
function createTrackedFuturesTrade(signal,chatId){const entry=Number(signal?.entry),stop=Number(signal?.stop);if(!signal?.id||!signal?.symbol||!["LONG","SHORT"].includes(signal?.side)||!Number.isFinite(entry)||entry<=0||!Number.isFinite(stop)||stop<=0)return null;return{id:crypto.randomUUID(),signalId:signal.id,chatId:String(chatId),symbol:signal.symbol,exchange:signal.exchange||"Kraken",side:signal.side,strategyId:signal.strategyId||"kraken-futures-engine",strategyName:signal.strategyName||"Kraken Futures 3.8.2",reason:signal.reason||"",plannedEntry:entry,actualEntry:entry,initialStop:stop,currentStop:stop,target1:Number(signal.target1),target2:Number(signal.target2),target3:Number(signal.target3),initialRisk:tradeDir(signal.side)*(entry-stop),tpHits:[],status:"OPEN",trackingMode:"SIGNAL_EVALUATION",createdAt:new Date().toISOString(),lastPrice:entry,lastCheckedAt:new Date().toISOString()}}
async function registerTrackedSignal(env,chatId,signal){if(!env.APP_KV||!signal?.id)return false;const open=await readTradeList(env,FUTURES_OPEN_KEY),closed=await readTradeList(env,FUTURES_CLOSED_KEY);if([...open,...closed].some(t=>String(t.signalId)===String(signal.id)&&String(t.chatId)===String(chatId)))return false;const trade=createTrackedFuturesTrade(signal,chatId);if(!trade)return false;open.unshift(trade);await writeTradeList(env,FUTURES_OPEN_KEY,open.slice(0,300));return true}
async function refreshTrackedFuturesTrades(env,chatId=null){const open=await readTradeList(env,FUTURES_OPEN_KEY);if(!open.length)return{checked:0,closed:0};const targets=open.filter(t=>chatId==null||String(t.chatId)===String(chatId));if(!targets.length)return{checked:0,closed:0};const closed=await readTradeList(env,FUTURES_CLOSED_KEY),remaining=open.slice();let checked=0,closedCount=0;const results=await mapLimit(targets,3,async trade=>{try{const candles=await getKrakenFuturesCandles(trade.symbol,"1m");const recent=(candles||[]).filter(c=>Number(c.time)>Math.max(Number(trade.lastCheckedCandleTime||0),Date.now()-10*60*1000));if(!recent.length&&candles?.length)recent.push(candles[candles.length-1]);let event=null,eventPrice=null,eventCandleTime=null;for(const candle of recent.sort((a,b)=>a.time-b.time)){const hi=Number(candle.high),lo=Number(candle.low);const stopHit=stopReached(trade.side,hi,trade.currentStop)||stopReached(trade.side,lo,trade.currentStop);const hits=[["TP1",Number(trade.target1)],["TP2",Number(trade.target2)],["TP3",Number(trade.target3)]].filter(([,target])=>Number.isFinite(target)&&(targetReached(trade.side,hi,target)||targetReached(trade.side,lo,target)));if(stopHit){event="STOP";eventPrice=trade.currentStop;eventCandleTime=candle.time;break}for(const[k,target]of hits)if(!trade.tpHits.includes(k)){trade.tpHits.push(k);await notifyTradeMilestone(env,trade,k,target)}if(trade.tpHits.includes("TP3")){event="TP3";eventPrice=trade.target3;eventCandleTime=candle.time;break}}const latest=recent[recent.length-1]||candles?.[candles.length-1];if(latest){trade.lastPrice=Number(latest.close);trade.lastCheckedAt=new Date().toISOString();trade.lastCheckedCandleTime=Number(latest.time)}checked++;if(event){trade.closedAt=new Date().toISOString();trade.exitPrice=Number(eventPrice);trade.outcomeR=tradeResultR(trade,event==="STOP");trade.outcomePercent=tradeOutcomePercent(trade,eventPrice);trade.closeReason=event==="STOP"?"STOP_LOSS":"TP3";trade.status=event==="STOP"?"CLOSED_STOP":"CLOSED_TARGETS";trade.resolutionCandleTime=eventCandleTime;return{trade,closed:true}}return{trade,closed:false}}catch(error){console.error("Tracked futures trade refresh failed:",trade.symbol,String(error?.message||error));return{trade,closed:false}}});const closedIds=new Set();for(const x of results){const i=remaining.findIndex(t=>t.id===x.trade.id);if(i>=0){remaining[i]=x.trade;if(x.closed){closedIds.add(x.trade.id);closed.unshift(x.trade);closedCount++}}}await writeTradeList(env,FUTURES_OPEN_KEY,remaining.filter(t=>!closedIds.has(t.id)).slice(0,300));await writeTradeList(env,FUTURES_CLOSED_KEY,closed.slice(0,500));for(const x of results.filter(v=>v.closed)){const t=x.trade,o=Number(t.outcomePercent),label=o>0?"سود":o<0?"ضرر":"سر‌به‌سر";await sendMessage(env,t.chatId,`📚 نتیجه سیگنال ${t.symbol}\n━━━━━━━━━━━━━━━━━━\nجهت: ${t.side==="LONG"?"LONG 🟢":"SHORT 🔴"}\nورود سیگنال: ${formatPrice(t.actualEntry)}\nخروج ثبت‌شده: ${formatPrice(t.exitPrice)}\nنتیجه: ${label} ${Number.isFinite(o)?(o>=0?"+":"")+o.toFixed(2)+"%":"—"}\nR: ${Number.isFinite(t.outcomeR)?(t.outcomeR>=0?"+":"")+t.outcomeR.toFixed(2):"—"}\nTPهای لمس‌شده: ${t.tpHits.join(", ")||"هیچ‌کدام"}\nدلیل بسته‌شدن: ${t.closeReason==="STOP_LOSS"?"حد ضرر":"TP3"}`)}return{checked,closed:closedCount}}
async function notifyTradeMilestone(env,trade,key,target){const p=priceChangePercent(trade.side,trade.actualEntry,target),labels={TP1:"🥇 هدف اول",TP2:"🥈 هدف دوم",TP3:"🥉 هدف سوم"},weight={TP1:"۴۰٪",TP2:"۳۵٪",TP3:"۲۵٪"};await sendMessage(env,trade.chatId,`${labels[key]||key} ${trade.symbol} لمس شد.\nقیمت هدف: ${formatPrice(target)}\nبازده قیمتی تا این هدف: ${p>=0?"+":""}${Number(p).toFixed(2)}%\nسهم مدل: ${weight[key]||"—"}\nمعامله هنوز باز است و حد ضرر اولیه دست‌نخورده باقی می‌ماند.`)}
async function handleTradeAction(action,chatId,env){const[,op]=action.split(":");if(op==="be")return sendMessage(env,chatId,"ℹ️ در نسخه جدید حد ضرر سیگنال خودکار جابه‌جا نمی‌شود؛ برای ارزیابی منصفانه حد ضرر اولیه ثابت می‌ماند.");if(op==="skip"||op==="enter")return sendMessage(env,chatId,"ℹ️ این نسخه هر سیگنال صادرشده را خودکار در دفتر ارزیابی ثبت می‌کند؛ ثبت دستی لازم نیست.")}
async function handleFillCommand(env,chatId,message){return sendMessage(env,chatId,"ℹ️ ثبت دستی معامله در نسخه جدید غیرفعال است؛ سیگنال‌های صادرشده خودکار در دفتر ارزیابی ثبت می‌شوند.")}
async function showOpenFuturesTrades(env,chatId){try{await refreshTrackedFuturesTrades(env,chatId)}catch(error){console.error("Open trade refresh failed:",String(error?.stack||error))}const list=(await readTradeList(env,FUTURES_OPEN_KEY)).filter(t=>String(t.chatId)===String(chatId));if(!list.length)return sendMessage(env,chatId,"📭 معامله بازی در دفتر پیگیری ثبت نشده است.",BACK_MENU);const body=list.slice(0,15).map(t=>{const p=priceChangePercent(t.side,t.actualEntry,t.lastPrice);return`${t.side==="LONG"?"🟢 LONG":"🔴 SHORT"} ${t.symbol} | ${t.exchange||"Kraken"}\nورود سیگنال: ${formatPrice(t.actualEntry)} | قیمت آخر: ${formatPrice(t.lastPrice)}\nبازده فعلی قیمتی: ${Number.isFinite(p)?(p>=0?"+":"")+p.toFixed(2)+"%":"—"}\nحد ضرر: ${formatPrice(t.currentStop)}\nاهداف: ${formatPrice(t.target1)} / ${formatPrice(t.target2)} / ${formatPrice(t.target3)}\nاهداف لمس‌شده: ${t.tpHits.join(", ")||"—"}`}).join("\n\n");return sendLongMessage(env,chatId,"📌 معاملات باز / سیگنال‌های در حال ارزیابی\n━━━━━━━━━━━━━━━━━━\n"+body+"\n\n⚠️ این دفتر ارزیابی است؛ سفارش واقعی ثبت نمی‌شود.")}
async function showFuturesTradeHistory(env,chatId){const list=(await readTradeList(env,FUTURES_CLOSED_KEY)).filter(t=>String(t.chatId)===String(chatId)).slice(0,50);if(!list.length)return sendMessage(env,chatId,"📚 هنوز معامله بسته‌شده‌ای ثبت نشده است.",BACK_MENU);const wins=list.filter(t=>Number(t.outcomePercent)>0).length,losses=list.filter(t=>Number(t.outcomePercent)<0).length,breakeven=list.length-wins-losses,winRate=list.length?wins/list.length*100:0,tp1=list.filter(t=>t.tpHits?.includes("TP1")).length,tp2=list.filter(t=>t.tpHits?.includes("TP2")).length,tp3=list.filter(t=>t.tpHits?.includes("TP3")).length,avg=list.reduce((s,t)=>s+Number(t.outcomePercent||0),0)/list.length,total=list.reduce((s,t)=>s+Number(t.outcomePercent||0),0);const summary=`📊 آمار عملکرد سیگنال‌ها\n━━━━━━━━━━━━━━━━━━\nکل سیگنال‌های بسته‌شده: ${list.length}\nبرد: ${wins} | باخت: ${losses} | سر‌به‌سر: ${breakeven}\n🏆 Win Rate: ${winRate.toFixed(1)}%\n📈 میانگین نتیجه هر سیگنال: ${avg>=0?"+":""}${avg.toFixed(2)}%\n💰 مجموع نتیجه قیمتی مدل: ${total>=0?"+":""}${total.toFixed(2)}%\n🎯 رسیدن به TP1: ${tp1} | TP2: ${tp2} | TP3: ${tp3}\n\n`;const body=list.slice(0,15).map(t=>`${t.symbol} | ${t.side}\nورود: ${formatPrice(t.actualEntry)} | خروج: ${formatPrice(t.exitPrice)}\nنتیجه: ${Number(t.outcomePercent)>=0?"+":""}${Number(t.outcomePercent).toFixed(2)}% | ${Number(t.outcomeR).toFixed(2)}R\nTPها: ${t.tpHits.join(", ")||"—"} | ${t.closeReason==="STOP_LOSS"?"استاپ":"TP3"}`).join("\n\n");return sendLongMessage(env,chatId,summary+"📚 تاریخچه معاملات\n━━━━━━━━━━━━━━━━━━\n"+body)}
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
export { FUTURES_CONFIG, FUTURES_PROVIDER_ORDER, isKrakenPerpetualTicker, normalizeKrakenFuturesUnderlying, getKrakenFuturesUniverse, getKrakenFuturesCandles, calculateAtr, analyzeFuturesSymbol, getFuturesUniverse, getFuturesCandles, tradeResultR, priceChangePercent, tradeOutcomePercent, targetReached, stopReached };
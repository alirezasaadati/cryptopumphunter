const CONFIG = {
  VERSION: "3.9.2",
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
  "🚀 CRYPTO PUMP HUNTER V3.9.2\n\n" +
  "طراحی و توسعه: علیرضا سعادتی\n\n" +
  "© تمامی حقوق مادی و معنوی این نرم‌افزار محفوظ است.\n\n" +
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
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runPaperTradingCycle(env));
  },
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return json({
        ok: true,
        service: "Crypto Pump Hunter",
        version: CONFIG.VERSION,
        mode: "Manual spot scan + Kraken Derivatives futures signals",
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
        !env.WEBHOOK_SECRET ||
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
    const member = await env.WATCHLIST_KV.get(memberKey(chatId), "json");
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
    const existingMember = await env.WATCHLIST_KV.get(memberKey(chatId), "json");
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
        "🎉 به خانواده CRYPTO PUMP HUNTER خوش آمدید!\n\n" +
        "✅ عضویت شما با موفقیت تأیید شد و دسترسی شما فعال است.\n\n" +
        "🚀 از این لحظه می‌توانید از اسکن بازار اسپات و سیگنال‌های تحلیلی فیوچرز Kraken استفاده کنید.\n\n" +
        "⚠️ سیگنال‌ها صرفاً تحلیلی هستند؛ قبل از هر معامله مدیریت ریسک را رعایت کنید."
      );
      await showMenu(env, applicantId);

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

async function handleOwnerAccessCommand(command, chatId, env, message) {
  if (!["/allow", "/revoke", "/members", "/member"].includes(command)) return false;
  if (!isOwner(chatId, env)) {
    await sendMessage(env, chatId, "⛔ این دستور فقط برای مدیر ربات فعال است.");
    return true;
  }
  if (!env.WATCHLIST_KV) {
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
  if (String(targetId) === String(env.OWNER_ID)) {
    await sendMessage(env, chatId, "⚠️ دسترسی مدیر اصلی قابل لغو نیست.");
    return true;
  }

  try {
    const existing = await env.WATCHLIST_KV.get(memberKey(targetId), "json") || {};
    if (command === "/allow") {
      const member = { ...existing, chatId: String(targetId), approved: true, revoked: false,
        allowedAt: new Date().toISOString(), allowedBy: String(chatId) };
      await env.WATCHLIST_KV.put(memberKey(targetId), JSON.stringify(member));
      await env.WATCHLIST_KV.delete(pendingKey(targetId));
      await sendMessage(env, targetId,
        "🎉 دسترسی شما به CRYPTO PUMP HUNTER توسط مدیر فعال شد.\n\n" +
        "خوش آمدید! اکنون می‌توانید از امکانات ربات استفاده کنید.");
      await showMenu(env, targetId);
      await sendMessage(env, chatId, `✅ کاربر ${targetId} مجاز شد و دسترسی او فعال است.`);
    } else {
      const member = { ...existing, chatId: String(targetId), approved: false, revoked: true,
        revokedAt: new Date().toISOString(), revokedBy: String(chatId) };
      await env.WATCHLIST_KV.put(memberKey(targetId), JSON.stringify(member));
      await env.WATCHLIST_KV.delete(pendingKey(targetId));
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
  if (!isOwner(ownerId, env) || !env.WATCHLIST_KV) return;
  const cursorKey = `admin:members:cursor:${ownerId}:${page}`;
  const cursor = page > 0 ? await env.WATCHLIST_KV.get(cursorKey) : null;
  if (page > 0 && !cursor) {
    await sendMessage(env, ownerId, "صفحه قبلی منقضی شده است؛ فهرست را دوباره باز کن.");
    return;
  }
  const result = await env.WATCHLIST_KV.list({ prefix: "member:", limit: 10, ...(cursor ? { cursor } : {}) });
  const keyboard = [];
  let active = 0, revoked = 0;
  for (const key of result.keys || []) {
    const id = key.name.slice(7);
    const m = await env.WATCHLIST_KV.get(key.name, "json") || {};
    const blocked = m.revoked === true || m.approved === false;
    if (blocked) revoked++; else active++;
    const name = [m.firstName, m.lastName].filter(Boolean).join(" ") || "بدون نام";
    keyboard.push([{ text: `${blocked ? "🚫" : "✅"} ${name.slice(0,24)} | ${id}`, callback_data: `mprof:${id}` }]);
  }
  if (result.list_complete === false && result.cursor) {
    await env.WATCHLIST_KV.put(`admin:members:cursor:${ownerId}:${page+1}`, result.cursor, { expirationTtl: 3600 });
    keyboard.push([{ text: "صفحه بعدی ➡️", callback_data: `members:${page+1}` }]);
  }
  if (page > 0) keyboard.push([{ text: "⬅️ صفحه قبل", callback_data: `members:${page-1}` }]);
  keyboard.push([{ text: "🏠 منوی اصلی", callback_data: "menu" }]);
  await sendMessage(env, ownerId,
    `👥 مدیریت اعضا | صفحه ${page+1}\n━━━━━━━━━━━━━━━━━━\nفعال در این صفحه: ${active}\nلغو دسترسی در این صفحه: ${revoked}\n\nبرای دیدن پروفایل و مدیریت دسترسی روی عضو بزن.`,
    { inline_keyboard: keyboard });
}
async function showMemberProfile(env, ownerId, id) {
  if (!isOwner(ownerId,env) || !env.WATCHLIST_KV || !/^-?\d+$/.test(id)) return;
  const m=await env.WATCHLIST_KV.get(memberKey(id),"json");
  if(!m){await sendMessage(env,ownerId,"عضو پیدا نشد.");return;}
  const blocked=m.revoked===true||m.approved===false;
  const name=[m.firstName,m.lastName].filter(Boolean).join(" ")||"ثبت نشده";
  const body=["👤 پروفایل عضو","━━━━━━━━━━━━━━━━━━",`نام: ${name}`,`نام کاربری: ${m.username?"@"+m.username:"ثبت نشده"}`,`شناسه تلگرام: ${m.userId||id}`,`شناسه گفتگو: ${m.chatId||id}`,`وضعیت: ${blocked?"🚫 لغو دسترسی":"✅ مجاز"}`,`درخواست: ${m.requestedAt||"نامشخص"}`,`تأیید: ${m.approvedAt||"ثبت نشده"}`,`آخرین فعال‌سازی: ${m.allowedAt||"ثبت نشده"}`,`لغو دسترسی: ${m.revokedAt||"ثبت نشده"}`].join("\n");
  await sendMessage(env,ownerId,body,{inline_keyboard:[[blocked?{text:"✅ اجازه دسترسی مجدد",callback_data:`mall:${id}`}:{text:"🚫 قطع دسترسی",callback_data:`mrev:${id}`}],[{text:"⬅️ بازگشت",callback_data:"members:"}]]});
}
async function changeMemberAccess(env,ownerId,id,allow) {
  if(!isOwner(ownerId,env)||!env.WATCHLIST_KV||!/^-?\d+$/.test(id))return;
  if(String(id)===String(env.OWNER_ID)){await sendMessage(env,ownerId,"دسترسی مدیر اصلی قابل تغییر نیست.");return;}
  const m=await env.WATCHLIST_KV.get(memberKey(id),"json");
  if(!m){await sendMessage(env,ownerId,"عضو پیدا نشد.");return;}
  const next=allow?{...m,approved:true,revoked:false,allowedAt:new Date().toISOString(),allowedBy:String(ownerId)}:{...m,approved:false,revoked:true,revokedAt:new Date().toISOString(),revokedBy:String(ownerId)};
  await env.WATCHLIST_KV.put(memberKey(id),JSON.stringify(next));
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
async function showMenu(env, chatId) {
  await sendMessage(env, chatId,
    `🚀 CRYPTO PUMP HUNTER V${CONFIG.VERSION}\n\nاز منوی زیر گزینه موردنظر را انتخاب کن:`,
    menuForChat(env, chatId));
}

async function handleTelegramCommand(command, chatId, env, message) {
  try {
    if (await handleOwnerAccessCommand(command, chatId, env, message)) return;

    if (command === "/start") {
      await sendMessage(
        env,
        chatId,
        "👋 سلام! به ربات CRYPTO PUMP HUNTER خوش آمدید.\n\n" +
        "🚀 این ربات برای بررسی فرصت‌های بازار رمزارز و ارائه سیگنال‌های تحلیلی اسپات و فیوچرز Kraken طراحی شده است.\n\n" +
        "🔐 برای استفاده از امکانات، ابتدا باید عضویت شما توسط مدیر تأیید شود."
      );
      await requestMembership(env, chatId, message);
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

    if (command === "/help") {
      await sendMessage(
        env,
        chatId,
        "📘 راهنمای ربات\n\n" +
        "/start - نمایش منوی اصلی\n" +
        "/scan - اسکن دستی بازار\n" +
        "/futures - دریافت سیگنال فیوچرز کراکن\n" +
        "/status - وضعیت ربات\n" +
        "/paperstatus - گزارش Paper Trading (فقط Owner)\n" +
        "/paperdetails - جزئیات معاملات باز Paper Trading (فقط Owner)\n" +
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

    if (command === "/paperstatus") {
      await showPaperStatus(env, chatId);
      return;
    }

    if (command === "/paperdetails") {
      await showPaperDetails(env, chatId);
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
    if (!isOwner(chatId,env) || String(query.from?.id)!==String(env.OWNER_ID)) {
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
    "اسپات: CoinLore و Kraken | فیوچرز: Kraken Derivatives\n" +
    `اتصال KV: ${env.WATCHLIST_KV ? "فعال" : "غیرفعال"}\n` +
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
  if (!env.WATCHLIST_KV) {
    await sendMessage(
      env,
      chatId,
      "⚠️ اتصال KV فعال نیست. ابتدا Binding را بررسی کن.",
      menuForChat(env, chatId)
    );
    return;
  }

  const saved = await env.WATCHLIST_KV.get("last_scan", "json");

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
  if (!env.WATCHLIST_KV) {
    await sendMessage(
      env,
      chatId,
      "⚠️ اتصال KV فعال نیست. Binding را در تنظیمات Worker بررسی کن.",
      menuForChat(env, chatId)
    );
    return;
  }

  const saved = await env.WATCHLIST_KV.get("last_scan", "json");

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
  const coinLore = result.coinlore.ok
    ? `✅ CoinLore: متصل (${result.coinlore.assets} ارز نمونه)`
    : `❌ CoinLore: ${result.coinlore.error}`;
  const kraken = result.kraken.ok
    ? `✅ Kraken: متصل (${result.kraken.pairs} جفت معاملاتی)`
    : `❌ Kraken: ${result.kraken.error}`;
  const krakenFutures = result.krakenFutures?.ok
    ? `✅ Kraken Futures: متصل (${result.krakenFutures.symbols} نماد)`
    : `❌ Kraken Futures: ${result.krakenFutures?.error || "نامشخص"}`;
  await sendMessage(env, chatId,
    "🔌 نتیجه تست اتصال\n\n" + coinLore + "\n\n" + kraken + "\n\n" +
    krakenFutures + "\n\n" +
    `نسخه ربات: V${CONFIG.VERSION}`, menuForChat(env, chatId));
}
async function registerWebhook(request, env) {
  if (!env.BOT_TOKEN) {
    return json({ ok: false, error: "BOT_TOKEN تنظیم نشده است." }, 400);
  }

  if (
    !env.WEBHOOK_SECRET ||
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

    body.secret_token = env.WEBHOOK_SECRET;

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
    kraken: { ok: false },
    krakenFutures: { ok: false },
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

  try {
    const tickers = await krakenFuturesJson("/tickers", "Kraken Futures tickers");
    const perpetuals = Array.isArray(tickers?.tickers)
      ? tickers.tickers.filter(isKrakenPerpetualTicker)
      : [];
    result.krakenFutures = {
      ok: Array.isArray(tickers?.tickers),
      symbols: perpetuals.length,
      sample: perpetuals.slice(0, 5).map(x => x.symbol)
    };
    if (!result.krakenFutures.ok) {
      result.krakenFutures.error = "ساختار پاسخ Kraken Futures معتبر نیست.";
    }
  } catch (error) {
    result.krakenFutures = { ok: false, error: error.message };
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


// ---------------- KRAKEN DERIVATIVES FUTURES SIGNAL ENGINE ----------------
// Public market data only. This module never places orders and never uses API keys.
const FUTURES_CONFIG = {
  BASE_URL: "https://futures.kraken.com/derivatives/api/v3",
  CHARTS_URL: "https://futures.kraken.com/api/charts/v1",
  MAX_SYMBOLS: 32,
  CONCURRENCY: 3,
  MIN_QUOTE_VOLUME: 3_000_000,
  KLINE_LIMIT: 120,
  MIN_CANDLES: 60,
  MIN_SCORE: 82,
  INTERVAL: "1h",
  CONFIRM_INTERVAL: "4h"
};

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
  // Keep tokenized equities out of the crypto-only futures scan.
  const underlying = symbol.replace(/^(PI|PF)_/, "").replace(/USD$/, "");
  const nonCryptoUnderlyings = new Set(["NVDAX", "TSLAX", "AAPLX", "AMZNX", "GOOGLX", "MSFTX", "METAX", "COINX"]);
  if (nonCryptoUnderlyings.has(underlying)) return false;
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
  const intervalMs = interval === "4h" ? 4 * 60 * 60 * 1000 : 60 * 60 * 1000;
  const now = Date.now();
  return candles.filter(c => c.time + intervalMs <= now);
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

function makeFuturesWatchItem(ticker, side, price, rsiValue, volumeRatio, reason, score = 0) {
  return {
    symbol: ticker.symbol, side, price, rsi: rsiValue, volumeRatio,
    score, watchlist: true, watchReason: reason
  };
}

function analyzeFuturesSymbol(ticker, candles1h, candles4h) {
  if (candles1h.length < FUTURES_CONFIG.MIN_CANDLES || candles4h.length < FUTURES_CONFIG.MIN_CANDLES) throw new Error("تعداد کندل بسته‌شده برای تحلیل ۱ساعته/۴ساعته کافی نیست.");
  const closes1h=candles1h.map(c=>c.close), closes4h=candles4h.map(c=>c.close);
  const last=candles1h[candles1h.length-1], candleClose=last.close, price=Number(ticker.last);
  if(!Number.isFinite(price)||price<=0) throw new Error("قیمت زنده قرارداد Kraken معتبر نیست.");
  const e20=ema(closes1h,20), e50=ema(closes1h,50), e20_4h=ema(closes4h,20), e50_4h=ema(closes4h,50);
  const rsiValue=rsi(closes1h,14), atr=calculateAtr(candles1h,14);
  if([e20,e50,e20_4h,e50_4h,rsiValue,atr].some(v=>!Number.isFinite(v))||atr<=0) throw new Error("محاسبه اندیکاتورها معتبر نیست.");
  const avgVol=average(candles1h.slice(-21,-1).map(c=>c.volume)), volumeRatio=avgVol>0?last.volume/avgVol:0;
  const up1h=e20>e50&&price>e20, down1h=e20<e50&&price<e20, up4h=e20_4h>e50_4h, down4h=e20_4h<e50_4h;
  let side=null,score=0; const reasons=[];
  if(up1h&&up4h&&rsiValue>=50&&rsiValue<=67){side="LONG";score=48;reasons.push("هم‌جهتی روند صعودی در تایم‌فریم‌های ۱ و ۴ ساعته");}
  else if(down1h&&down4h&&rsiValue>=33&&rsiValue<=50){side="SHORT";score=48;reasons.push("هم‌جهتی روند نزولی در تایم‌فریم‌های ۱ و ۴ ساعته");}
  else {
    if(up1h&&up4h&&rsiValue>=45&&rsiValue<=72) return makeFuturesWatchItem(ticker,"LONG",price,rsiValue,volumeRatio,"روند صعودی همسو است؛ RSI هنوز برای ورود تأیید نشده");
    if(down1h&&down4h&&rsiValue>=28&&rsiValue<=55) return makeFuturesWatchItem(ticker,"SHORT",price,rsiValue,volumeRatio,"روند نزولی همسو است؛ RSI هنوز برای ورود تأیید نشده");
    return {symbol:ticker.symbol,rejected:"هم‌جهتی روند یا محدوده RSI تأیید نشد"};
  }
  const direction=side==="LONG"?1:-1, candleRange=Math.max(last.high-last.low,Number.EPSILON), body=Math.abs(last.close-last.open);
  const closeStrength=side==="LONG"?(last.close-last.low)/candleRange:(last.high-last.close)/candleRange;
  const confirmed=side==="LONG"?last.close>last.open&&closeStrength>=0.65:last.close<last.open&&closeStrength>=0.65;
  if(!confirmed||body<atr*0.20) return makeFuturesWatchItem(ticker,side,price,rsiValue,volumeRatio,"جهت روند تأیید شده؛ قدرت کندل برای ورود کافی نیست",score);
  score+=12;reasons.push("کندل بسته‌شده در جهت معامله تأیید شده است");
  if(volumeRatio>=1.5){score+=16;reasons.push("حجم حداقل ۱.۵ برابر میانگین است");}
  else if(volumeRatio>=1.1){score+=11;reasons.push("حجم بالاتر از میانگین است");}
  else if(volumeRatio>=0.70) return makeFuturesWatchItem(ticker,side,price,rsiValue,volumeRatio,"حجم هنوز برای ورود کافی نیست",score);
  else return {symbol:ticker.symbol,rejected:"حجم کندل تأییدکننده پایین است"};
  const extension=Math.abs(price-e20)/atr;
  if(Math.abs(price-candleClose)/atr>0.45)return {symbol:ticker.symbol,rejected:"قیمت زنده بیش از حد از قیمت بسته‌شدن کندل تأیید فاصله گرفته است"};
  if(extension>1.35)return {symbol:ticker.symbol,rejected:"قیمت بیش از حد از EMA20 فاصله گرفته؛ ورود تعقیبی رد شد"};
  score+=extension<=0.65?8:4;
  const change=Number(ticker.priceChangePercent)||0;
  score+=((side==="LONG"&&change>0)||(side==="SHORT"&&change<0))?5:2;
  const funding=Number(ticker.premium?.lastFundingRate);
  if(Number.isFinite(funding)){
    if((side==="LONG"&&funding>0.001)||(side==="SHORT"&&funding< -0.001)){score-=6;reasons.push("فاندینگ نامتوازن و احتمال ازدحام سمت معامله");}
    else{score+=3;reasons.push("فاندینگ مانع جدی در جهت انتخابی نشان نمی‌دهد");}
  }else reasons.push("فاندینگ در دسترس نبود؛ امتیاز اضافه منظور نشد");
  const structure=candles1h.slice(-13,-1), swingLow=Math.min(...structure.map(c=>c.low)), swingHigh=Math.max(...structure.map(c=>c.high));
  const entry=price, structuralStop=side==="LONG"?swingLow-atr*0.20:swingHigh+atr*0.20, volatilityStop=side==="LONG"?entry-atr*1.35:entry+atr*1.35;
  const stop=side==="LONG"?Math.min(structuralStop,volatilityStop):Math.max(structuralStop,volatilityStop);
  const risk=side==="LONG"?entry-stop:stop-entry, riskPct=risk/entry;
  if(!Number.isFinite(risk)||risk<=0||riskPct<0.0015||riskPct>0.05)return {symbol:ticker.symbol,rejected:"فاصله حد ضرر خارج از محدوده منطقی است"};
  const target1=entry+direction*risk*1.5,target2=entry+direction*risk*2.2,target3=entry+direction*risk*3.0,rewardRisk=Math.abs(target2-entry)/risk;
  score=Math.max(0,Math.min(100,Math.round(score)));
  const eligible=score>=FUTURES_CONFIG.MIN_SCORE&&volumeRatio>=1.1&&rewardRisk>=2.0;
  if(!eligible)reasons.push("امتیاز یا نسبت سود به ریسک به حد نصاب نرسید");
  return {symbol:ticker.symbol,side,score,price,entry,stop,target1,target2,target3,rewardRisk,rsi:rsiValue,ema20:e20,ema50:e50,atr,volumeRatio,
    funding:Number.isFinite(funding)?funding:null,quoteVolume:Number(ticker.quoteVolume)||0,change24h:change,candleTime:last.time,reasons,eligible,
    entryZoneLow:entry-atr*0.15,entryZoneHigh:entry+atr*0.15,invalidation:side==="LONG"?"بسته‌شدن کندل ۱ساعته زیر حد ضرر":"بسته‌شدن کندل ۱ساعته بالای حد ضرر"};
}

function formatFuturesSignal(item) {
  const sideLabel = item.side === "LONG" ? "🟢 LONG" : "🔴 SHORT";
  const fundingText = item.funding === null ? "در دسترس نیست" : `${(item.funding * 100).toFixed(4)}%`;
  return `${sideLabel} | ${item.symbol}\n` +
    `⭐ امتیاز: ${item.score}/100\n` +
    `💵 ورود پس از تأیید کندل: ${formatPrice(item.entry)}\n` +
    `📍 محدوده ورود: ${formatPrice(item.entryZoneLow)} تا ${formatPrice(item.entryZoneHigh)}\n` +
    `🛑 حد ضرر ساختاری/ATR: ${formatPrice(item.stop)}\n` +
    `🥇 هدف ۱: ${formatPrice(item.target1)} (1.5R)\n` +
    `🥈 هدف ۲: ${formatPrice(item.target2)} (2.2R)\n` +
    `🥉 هدف ۳: ${formatPrice(item.target3)} (3R)\n` +
    `📊 RSI(1h): ${item.rsi.toFixed(1)} | نسبت حجم: ${item.volumeRatio.toFixed(2)}x | R:R تا هدف۲: ${item.rewardRisk.toFixed(2)}R\n` +
    `⚠️ ابطال سناریو: ${item.invalidation}\n` +
    `💸 Funding: ${fundingText} | تغییر ۲۴ساعته: ${item.change24h.toFixed(2)}%\n` +
    `📦 حجم ۲۴ساعته: $${Math.round(item.quoteVolume).toLocaleString("en-US")}\n` +
    `🕒 کندل مبنا: ${new Date(item.candleTime).toISOString()}\n` +
    `🔎 دلایل: ${item.reasons.join("؛ ")}\n`;
}

async function runFuturesSignalScan(env) {
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
  const signals = analyzed.filter(x => x?.eligible).sort((a, b) => b.score - a.score).slice(0, 8);
  const watchlist = analyzed.filter(x => x?.watchlist).sort((a, b) => b.score - a.score).slice(0, 5);
  const validData = analyzed.filter(x => x && x.score !== undefined).length;
  const allRejected = analyzed.filter(x => x?.rejected);
  const rejected = allRejected.slice(0, 8);
  const rejectionCounts = new Map();
  for (const item of allRejected) {
    const reason = item.rejected || "نامشخص";
    rejectionCounts.set(reason, (rejectionCounts.get(reason) || 0) + 1);
  }
  let report = `📈 CRYPTO PUMP HUNTER V${CONFIG.VERSION} — KRAKEN FUTURES\n` +
    "━━━━━━━━━━━━━━━━━━\n" +
    "🏦 بازار: Kraken Derivatives Perpetual\n" +
    "⏱ تایم‌فریم: 1h با تأیید روند 4h\n" +
    `📥 نمادهای پرحجم بررسی‌شده: ${universe.length}\n` +
    `📊 تحلیل‌های دارای امتیاز: ${validData}\n` +
    `⭐ سیگنال‌های واجد شرایط: ${signals.length}\n\n`;
  if (signals.length) {
    report += "🎯 سیگنال‌های تأییدشده\n━━━━━━━━━━━━━━━━━━\n\n";
    for (const item of signals) report += formatFuturesSignal(item) + "\n━━━━━━━━━━━━━━━━━━\n\n";
  } else {
    report += "⚠️ در این بررسی سیگنال تأییدشده‌ای صادر نشد.\n\n";
  }
  report += "👀 فرصت‌های در حال شکل‌گیری (فقط واچ‌لیست؛ بدون مجوز ورود)\n";
  if (watchlist.length) {
    for (const item of watchlist) {
      report += `• ${item.symbol} ${item.side} | قیمت: ${formatPrice(item.price)} | RSI: ${item.rsi.toFixed(1)} | حجم: ${item.volumeRatio.toFixed(2)}x | ${item.watchReason}\n`;
    }
  } else {
    report += "• موردی نزدیک به شرایط ورود پیدا نشد.\n";
  }
  report += "\n";
  if (rejected.length) {
    report += "🧪 نمونه دلایل رد نمادها\n";
    for (const item of rejected) report += `• ${item.symbol}: ${item.rejected}\n`;
  }
  if (rejectionCounts.size) {
    report += "\n📊 شمارش دلایل رد کل نمادها\n";
    for (const [reason, count] of [...rejectionCounts.entries()].sort((a, b) => b[1] - a[1])) {
      report += `• ${reason}: ${count}\n`;
    }
  }
  report += `\n🕒 زمان تهیه گزارش: ${new Date().toISOString()}\n` +
    `⏱ مدت بررسی: ${((Date.now() - started) / 1000).toFixed(2)} ثانیه\n` +
    "📡 منبع داده: API عمومی Kraken Derivatives Futures\n" +
    "⚠️ سیگنال‌ها تحلیلی‌اند؛ سفارش واقعی ثبت نمی‌شود و سود تضمین نیست. قیمت ممکن است پس از بسته‌شدن کندل تغییر کند.";

  if (env.WATCHLIST_KV) {
    try {
      await env.WATCHLIST_KV.put("last_futures_scan", JSON.stringify({
        version: CONFIG.VERSION,
        timestamp: Date.now(),
        report,
        signals: signals.map(x => ({
          symbol: x.symbol, side: x.side, score: x.score, entry: x.entry,
          stop: x.stop, target1: x.target1, target2: x.target2, target3: x.target3
        })),
        watchlist: watchlist.map(x => ({
          symbol: x.symbol, side: x.side, price: x.price, rsi: x.rsi,
          volumeRatio: x.volumeRatio, reason: x.watchReason
        }))
      }));
    } catch (error) {
      report += `\n⚠️ ذخیره گزارش فیوچرز ناموفق بود: ${String(error.message || "KV error")}`;
    }
  }
  return { report, signals, watchlist };
}

async function runFuturesSignalsForChat(env, chatId) {
  if (!(await isApproved(chatId, env))) {
    await sendMessage(env, chatId, "⛔ دسترسی شما فعال نیست.");
    return;
  }
  await sendMessage(env, chatId,
    "📈 اسکن فیوچرز Kraken شروع شد...\n" +
    "در حال بررسی قراردادهای دائمی دلاری Kraken با کندل‌های بسته‌شده ۱ساعته و تأیید ۴ساعته.\n" +
    "این بخش فقط سیگنال تحلیلی تولید می‌کند و سفارشی ثبت نمی‌کند."
  );
  try {
    const result = await runFuturesSignalScan(env);
    await sendLongMessage(env, chatId, result.report);
    await sendMessage(env, chatId, "پایان بررسی فیوچرز.", menuForChat(env, chatId));
  } catch (error) {
    await sendMessage(env, chatId,
      "❌ دریافت یا تحلیل داده Kraken Futures ناموفق بود.\n" +
      String(error.message || "خطای ناشناخته").slice(0, 900) +
      "\n\nدر این وضعیت هیچ سیگنالی ساخته نمی‌شود.", menuForChat(env, chatId)
    );
  }
}

// ---------------- PAPER TRADING (SIMULATED, NO ORDERS) ----------------
const PAPER_KEY = "paper:portfolio:v1";
const PAPER_CONFIG = { FEE: 0.0005, SLIPPAGE: 0.0003, TARGET_WEIGHTS: [0.40, 0.35, 0.25], MAX_HISTORY: 100 };

function createPaperPosition(signal, now = Date.now()) {
  const risk = Math.abs(signal.entry - signal.stop);
  if (!Number.isFinite(risk) || risk <= 0) return null;
  const direction = signal.side === "LONG" ? 1 : -1;
  const entryCostR = ((PAPER_CONFIG.FEE + PAPER_CONFIG.SLIPPAGE) * signal.entry) / risk;
  return {
    id: signal.symbol + ":" + signal.side + ":" + signal.candleTime,
    symbol: signal.symbol, side: signal.side, entry: signal.entry, stop: signal.stop,
    targets: [signal.target1, signal.target2, signal.target3],
    candleTime: signal.candleTime, openedAt: now, direction, risk,
    remaining: 1, targetHits: 0, realizedR: -entryCostR, status: "OPEN"
  };
}

function applyPaperPrice(position, price, now = Date.now()) {
  if (!position || position.status !== "OPEN" || !Number.isFinite(price) || price <= 0) return { position, events: [] };
  const events = [];
  const adverse = position.direction === 1 ? price <= position.stop : price >= position.stop;
  if (adverse) {
    const fraction = position.remaining;
    const grossR = fraction * position.direction * (price - position.entry) / position.risk;
    const costsR = fraction * (PAPER_CONFIG.FEE + PAPER_CONFIG.SLIPPAGE) * (position.entry + price) / position.risk;
    position.realizedR += grossR - costsR;
    position.remaining = 0; position.status = "CLOSED"; position.closedAt = now; position.exitReason = "STOP";
    events.push({ type: "STOP", symbol: position.symbol, side: position.side, price, netR: position.realizedR });
    return { position, events };
  }
  while (position.targetHits < 3 && position.remaining > 0) {
    const target = position.targets[position.targetHits];
    const reached = position.direction === 1 ? price >= target : price <= target;
    if (!reached) break;
    const fraction = Math.min(position.remaining, PAPER_CONFIG.TARGET_WEIGHTS[position.targetHits]);
    const grossR = fraction * position.direction * (target - position.entry) / position.risk;
    const costsR = fraction * (PAPER_CONFIG.FEE + PAPER_CONFIG.SLIPPAGE) * (position.entry + target) / position.risk;
    position.realizedR += grossR - costsR;
    position.remaining = Math.max(0, position.remaining - fraction);
    position.targetHits++;
    events.push({ type: "TARGET" + position.targetHits, symbol: position.symbol, side: position.side, price: target, netR: position.realizedR });
  }
  if (position.remaining < 1e-8) {
    position.remaining = 0; position.status = "CLOSED"; position.closedAt = now; position.exitReason = "TARGETS";
    events.push({ type: "CLOSED", symbol: position.symbol, side: position.side, price, netR: position.realizedR });
  }
  return { position, events };
}

async function runPaperTradingCycle(env) {
  if (!env.WATCHLIST_KV || !env.OWNER_ID) throw new Error("WATCHLIST_KV یا OWNER_ID تنظیم نیست.");
  const lockKey = "paper:cycle:lock";
  if (await env.WATCHLIST_KV.get(lockKey)) return { skipped: true, events: [] };
  await env.WATCHLIST_KV.put(lockKey, String(Date.now()), { expirationTtl: 240 });
  try {
    const state = await env.WATCHLIST_KV.get(PAPER_KEY, "json") || { version: 1, positions: [], history: [], cycles: 0 };
    const scan = await runFuturesSignalScan(env);
    const tickerData = await krakenFuturesJson("/tickers", "Kraken Futures paper prices");
    const prices = new Map((tickerData.tickers || []).map(t => [t.symbol, Number(t.last)]));
    const events = [];
    const stillOpen = [];
    for (const position of state.positions) {
      const price = prices.get(position.symbol);
      if (Number.isFinite(price) && price > 0) events.push(...applyPaperPrice(position, price).events);
      if (position.status === "OPEN") stillOpen.push(position);
      else state.history.push(position);
    }
    const openIds = new Set(stillOpen.map(p => p.id));
    for (const signal of scan.signals) {
      const position = createPaperPosition(signal);
      if (!position || openIds.has(position.id) || state.history.some(p => p.id === position.id)) continue;
      stillOpen.push(position); openIds.add(position.id);
      events.push({ type: "OPEN", symbol: position.symbol, side: position.side, price: position.entry, netR: position.realizedR });
    }
    state.positions = stillOpen;
    state.history = state.history.slice(-PAPER_CONFIG.MAX_HISTORY);
    state.cycles = (state.cycles || 0) + 1;
    state.lastCycleAt = Date.now();
    state.lastScanSignals = scan.signals.length;
    await env.WATCHLIST_KV.put(PAPER_KEY, JSON.stringify(state));
    if (events.length) {
      const summary = events.map(e => {
        const label = e.type === "OPEN" ? "ورود فرضی" : e.type.startsWith("TARGET") ? e.type : e.type === "STOP" ? "حد ضرر" : "بسته شد";
        return "• " + label + ": " + e.symbol + " " + e.side + " | قیمت " + formatPrice(e.price) + " | نتیجه تجمعی " + e.netR.toFixed(2) + "R";
      }).join("\n");
      await sendMessage(env, env.OWNER_ID, "🧪 گزارش Paper Trading\n━━━━━━━━━━━━━━━━━━\n" + summary);
    }
    return { skipped: false, events, open: state.positions.length, closed: state.history.length, cycles: state.cycles };
  } finally {
    await env.WATCHLIST_KV.delete(lockKey);
  }
}

async function showPaperStatus(env, chatId) {
  if (!isOwner(chatId, env)) { await sendMessage(env, chatId, "⛔ فقط Owner به گزارش Paper Trading دسترسی دارد."); return; }
  const state = await env.WATCHLIST_KV?.get(PAPER_KEY, "json");
  if (!state) { await sendMessage(env, chatId, "🧪 Paper Trading هنوز چرخه‌ای اجرا نکرده است."); return; }
  const closed = state.history || [];
  const wins = closed.filter(p => p.realizedR > 0).length;
  const totalR = closed.reduce((sum, p) => sum + p.realizedR, 0);
  await sendMessage(env, chatId,
    "🧪 وضعیت Paper Trading\n━━━━━━━━━━━━━━━━━━\n" +
    "چرخه‌ها: " + (state.cycles || 0) + "\nمعاملات باز: " + (state.positions || []).length +
    "\nمعاملات بسته: " + closed.length + "\nبرد معاملات بسته: " +
    (closed.length ? (wins / closed.length * 100).toFixed(1) : "—") + "%\nمجموع نتیجه بسته‌ها: " +
    totalR.toFixed(2) + "R\nآخرین اجرا: " + (state.lastCycleAt ? new Date(state.lastCycleAt).toISOString() : "—") +
    "\n\nکارمزد و لغزش فرضی هر سمت: 0.05% + 0.03%.",
    menuForChat(env, chatId));
}


async function showPaperDetails(env, chatId) {
  if (!isOwner(chatId, env)) {
    await sendMessage(env, chatId, "⛔ فقط Owner به جزئیات Paper Trading دسترسی دارد.");
    return;
  }
  const state = await env.WATCHLIST_KV?.get(PAPER_KEY, "json");
  const positions = state?.positions || [];
  if (!positions.length) {
    await sendMessage(env, chatId, "🧪 در حال حاضر معامله بازی در Paper Trading وجود ندارد.", menuForChat(env, chatId));
    return;
  }

  try {
    const tickerData = await krakenFuturesJson("/tickers", "Kraken Futures paper position details");
    const prices = new Map((tickerData.tickers || []).map(t => [t.symbol, Number(t.last)]));
    const lines = positions.map((p, index) => {
      const price = prices.get(p.symbol);
      const validPrice = Number.isFinite(price) && price > 0;
      const remaining = Math.max(0, Number(p.remaining) || 0);
      const unrealizedGrossR = validPrice ? remaining * p.direction * (price - p.entry) / p.risk : 0;
      const estimatedExitCostsR = validPrice ? remaining * (PAPER_CONFIG.FEE + PAPER_CONFIG.SLIPPAGE) * price / p.risk : 0;
      const totalR = validPrice ? p.realizedR + unrealizedGrossR - estimatedExitCostsR : null;
      const targets = (p.targets || []).map((v, i) => "هدف " + (i + 1) + ": " + formatPrice(v)).join(" | ");
      const result = totalR === null ? "قیمت فعلی در دسترس نیست" : (totalR >= 0 ? "+" : "") + totalR.toFixed(2) + "R";
      return (index + 1) + ") " + p.symbol + " " + p.side +
        "\nورود: " + formatPrice(p.entry) +
        "\nقیمت فعلی: " + (validPrice ? formatPrice(price) : "ناموجود") +
        "\nحد ضرر: " + formatPrice(p.stop) +
        "\n" + targets +
        "\nاهداف فعال‌شده: " + (p.targetHits || 0) + "/3 | حجم باقی‌مانده: " + (remaining * 100).toFixed(0) + "%" +
        "\nسود/ضرر شناور تخمینی: " + result;
    });
    await sendMessage(env, chatId,
      "🧪 جزئیات معاملات باز Paper Trading\n━━━━━━━━━━━━━━━━━━\n" +
      lines.join("\n\n━━━━━━━━━━━━━━━━━━\n\n") +
      "\n\nنتیجه شناور تخمینی است؛ معامله واقعی نیست و تا بسته‌شدن قطعی محسوب نمی‌شود.",
      menuForChat(env, chatId));
  } catch (error) {
    await sendMessage(env, chatId,
      "❌ دریافت قیمت فعلی ناموفق بود. اطلاعات معاملات ذخیره‌شده تغییری نکرده است.\n" +
      String(error.message || "خطای دریافت قیمت").slice(0, 500),
      menuForChat(env, chatId));
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
export { FUTURES_CONFIG, isKrakenPerpetualTicker, calculateAtr, analyzeFuturesSymbol, getKrakenFuturesCandles, createPaperPosition, applyPaperPrice };
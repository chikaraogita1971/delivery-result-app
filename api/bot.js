const { neon } = require("@neondatabase/serverless");

const sql = neon(process.env.DATABASE_URL);

const BOT_TOKEN = process.env.BOT_TOKEN;
const JST = "Asia/Tokyo";

const TELEGRAM_API =
  `https://api.telegram.org/bot${BOT_TOKEN}`;


// ============================================================
// Telegram API
// ============================================================

async function telegramApi(method, body = {}) {
  const response = await fetch(
    `${TELEGRAM_API}/${method}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }
  );

  const data = await response.json();

  if (!data.ok) {
    throw new Error(
      data.description ||
      `Telegram API error: ${method}`
    );
  }

  return data.result;
}


async function sendMessage(
  chatId,
  text,
  options = {}
) {
  return telegramApi(
    "sendMessage",
    {
      chat_id: chatId,
      text,

      parse_mode:
        options.parseMode || "HTML",

      disable_web_page_preview: true,

      ...(options.replyMarkup
        ? {
            reply_markup:
              options.replyMarkup,
          }
        : {}),
    }
  );
}


// ============================================================
// 共通
// ============================================================

function getTelegramUserId(message) {
  return String(
    message?.from?.id || ""
  );
}


function getChatId(message) {
  return String(
    message?.chat?.id || ""
  );
}


function isGroupChat(message) {
  const type =
    message?.chat?.type;

  return (
    type === "group" ||
    type === "supergroup"
  );
}


function getDisplayName(user) {
  if (!user) {
    return "ユーザー";
  }

  const fullName = [
    user.first_name,
    user.last_name,
  ]
    .filter(Boolean)
    .join(" ")
    .trim();

  if (fullName) {
    return fullName;
  }

  if (user.username) {
    return `@${user.username}`;
  }

  return `ユーザー${user.id}`;
}


function getCommandName(message) {
  const text =
    String(
      message?.text || ""
    ).trim();

  if (!text.startsWith("/")) {
    return "";
  }

  return text
    .split(/\s+/)[0]
    .split("@")[0]
    .toLowerCase();
}


function formatNumber(value) {
  return Number(
    value || 0
  ).toLocaleString("ja-JP");
}


function formatHours(value) {
  const hours =
    Number(value || 0);

  return hours
    .toFixed(2)
    .replace(/\.00$/, "")
    .replace(/(\.\d)0$/, "$1");
}


function formatDateJST(value) {
  if (!value) {
    return "-";
  }

  return new Intl.DateTimeFormat(
    "ja-JP",
    {
      timeZone: JST,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }
  ).format(new Date(value));
}


function parseWorkHours(value) {
  const hours = Number(value);

  if (
    !Number.isFinite(hours) ||
    hours <= 0 ||
    hours > 24
  ) {
    return null;
  }

  return Math.round(
    hours * 100
  ) / 100;
}


// ============================================================
// 管理者
// ============================================================

function getAdminIds() {
  return String(
    process.env.ADMIN_TELEGRAM_USER_IDS || ""
  )
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
}


function isAdmin(userId) {
  return getAdminIds().includes(
    String(userId)
  );
}


// ============================================================
// Audit Log
// ============================================================

async function writeAuditLog({
  telegramUserId,
  chatId = null,
  action,
  details = null,
}) {
  try {
    await sql`
      INSERT INTO audit_logs (
        telegram_user_id,
        chat_id,
        action,
        details
      )
      VALUES (
        ${String(telegramUserId)},
        ${chatId ? String(chatId) : null},
        ${action},
        ${
          details
            ? JSON.stringify(details)
            : null
        }
      )
    `;
  } catch (error) {
    console.error(
      "audit log error:",
      error
    );
  }
}


// ============================================================
// グループ
// ============================================================

async function ensureGroupRegistered(message) {
  if (!isGroupChat(message)) {
    return;
  }

  const chatId =
    getChatId(message);

  const title =
    message?.chat?.title || "";

  await sql`
    INSERT INTO telegram_groups (
      chat_id,
      title,
      updated_at
    )
    VALUES (
      ${chatId},
      ${title},
      NOW()
    )
    ON CONFLICT (chat_id)
    DO UPDATE SET
      title = EXCLUDED.title,
      updated_at = NOW()
  `;
}


async function ensureGroupMember(message) {
  if (!isGroupChat(message)) {
    return;
  }

  const user =
    message?.from;

  if (!user?.id) {
    return;
  }

  // Bot除外
  if (user.is_bot) {
    return;
  }

  // Telegram匿名管理者除外
  if (
    user.username ===
      "GroupAnonymousBot" ||
    String(user.id) ===
      "1087968824"
  ) {
    return;
  }

  const chatId =
    getChatId(message);

  await sql`
    INSERT INTO group_members (
      chat_id,
      telegram_user_id,
      username,
      first_name,
      updated_at
    )
    VALUES (
      ${chatId},
      ${String(user.id)},
      ${user.username || null},
      ${user.first_name || null},
      NOW()
    )
    ON CONFLICT (
      chat_id,
      telegram_user_id
    )
    DO UPDATE SET
      username =
        EXCLUDED.username,
      first_name =
        EXCLUDED.first_name,
      updated_at =
        NOW()
  `;
}


async function ensureGroupContext(message) {
  if (!isGroupChat(message)) {
    return;
  }

  await ensureGroupRegistered(
    message
  );

  await ensureGroupMember(
    message
  );
}


// ============================================================
// /add 引数
// ============================================================

function parseAddArguments(text) {
  const parts =
    String(text || "")
      .trim()
      .split(/\s+/);

  if (parts.length !== 4) {
    return {
      ok: false,
      error:
        `⚠️ 入力形式が正しくありません。\n\n` +
        `<code>/add 売上 配達件数 稼働時間</code>\n` +
        `例：<code>/add 20000 30 8</code>`,
    };
  }

  const saleAmount =
    Number(parts[1]);

  const deliveryCount =
    Number(parts[2]);

  const workHours =
    parseWorkHours(parts[3]);

  if (
    !Number.isFinite(saleAmount) ||
    saleAmount < 0 ||
    saleAmount > 100000000
  ) {
    return {
      ok: false,
      error:
        "⚠️ 売上金額が不正です。",
    };
  }

  if (
    !Number.isInteger(deliveryCount) ||
    deliveryCount <= 0 ||
    deliveryCount > 10000
  ) {
    return {
      ok: false,
      error:
        "⚠️ 配達件数が不正です。",
    };
  }

  if (workHours === null) {
    return {
      ok: false,
      error:
        "⚠️ 稼働時間は0より大きく24時間以下で指定してください。",
    };
  }

  return {
    ok: true,
    saleAmount:
      Math.floor(saleAmount),
    deliveryCount,
    workHours,
  };
}


// ============================================================
// 月間目標
// ============================================================

async function getMonthlyGoal(userId) {
  const rows = await sql`
    SELECT monthly_goal
    FROM delivery_goals
    WHERE telegram_user_id =
      ${userId}
    LIMIT 1
  `;

  return rows.length
    ? Number(rows[0].monthly_goal)
    : 500;
}


// ============================================================
// /start
// ============================================================

async function handleStart(message) {
  const userId =
    getTelegramUserId(message);

  const chatId =
    getChatId(message);

  if (!userId || !chatId) {
    return;
  }

  if (isGroupChat(message)) {
    await ensureGroupContext(
      message
    );
  }

  await writeAuditLog({
    telegramUserId: userId,
    chatId,
    action: "start",
    details: {
      chatType:
        message?.chat?.type || null,
    },
  });

  const displayName =
    getDisplayName(
      message?.from
    );

  const text =
    `🔥 <b>配達リザルトBotへようこそ！</b>\n\n` +
    `${displayName}さん、今日もお疲れさまです！\n\n` +

    `📦 <b>実績登録</b>\n` +
    `<code>/add 売上 配達件数 稼働時間</code>\n` +
    `例：<code>/add 20000 30 8</code>\n\n` +

    `↩️ <b>最新実績を削除</b>\n` +
    `<code>/cancel</code>\n\n` +

    `🗑 <b>自分の実績を全削除</b>\n` +
    `<code>/reset</code>\n\n` +

    `🎯 <b>月間目標</b>\n` +
    `<code>/goal 500</code>\n\n` +

    `👥 <b>グループ実績</b>\n` +
    `<code>/group</code>\n\n` +

    `🏆 <b>ランキング</b>\n` +
    `<code>/ranking</code>\n\n` +

    `📱 <b>Mini App</b>\n` +
    `ダッシュボードから詳細を確認できます。\n\n` +

    `💡 <code>/help</code> で全コマンドを確認できます。`;

  await sendMessage(
    chatId,
    text
  );
}


// ============================================================
// /help
// ============================================================

async function handleHelp(message) {
  const chatId =
    getChatId(message);

  if (!chatId) {
    return;
  }

  const text =
    `📖 <b>配達リザルトBot ヘルプ</b>\n` +
    `━━━━━━━━━━━━━━\n\n` +

    `📦 <b>実績登録</b>\n` +
    `<code>/add 20000 30 8</code>\n\n` +

    `↩️ <b>最新実績を削除</b>\n` +
    `<code>/cancel</code>\n\n` +

    `🗑 <b>自分の実績を全削除</b>\n` +
    `<code>/reset</code>\n\n` +

    `🎯 <b>月間目標</b>\n` +
    `<code>/goal 500</code>\n` +
    `引数なしで現在の目標確認\n\n` +

    `👥 <b>今月のグループ実績</b>\n` +
    `<code>/group</code>\n\n` +

    `📅 <b>先月のグループ実績</b>\n` +
    `<code>/lastmonth</code>\n\n` +

    `🗓 <b>指定月のグループ実績</b>\n` +
    `<code>/month 2026-09</code>\n\n` +

    `🏆 <b>ランキング</b>\n` +
    `<code>/ranking</code>\n\n` +

    `👑 <b>管理者統計</b>\n` +
    `<code>/admin</code>`;

  await sendMessage(
    chatId,
    text
  );
}


// ============================================================
// /add
// 個人チャット → 所属グループへ保存
// ============================================================

async function handleAdd(message) {
  const userId =
    getTelegramUserId(message);

  const messageChatId =
    getChatId(message);

  if (!userId || !messageChatId) {
    return;
  }

  const args =
    parseAddArguments(
      message?.text || ""
    );

  if (!args.ok) {
    await sendMessage(
      messageChatId,
      args.error
    );

    return;
  }

  const {
    saleAmount,
    deliveryCount,
    workHours,
  } = args;

  // ----------------------------------------------------------
  // 保存先chat_id
  // ----------------------------------------------------------

  let resultChatId =
    messageChatId;

  // 個人チャットから登録した場合
  if (!isGroupChat(message)) {
    const groups =
      await sql`
        SELECT
          tg.chat_id,
          tg.title
        FROM telegram_groups tg
        INNER JOIN group_members gm
          ON gm.chat_id =
            tg.chat_id
        WHERE gm.telegram_user_id =
          ${String(userId)}
        ORDER BY
          gm.updated_at DESC,
          tg.updated_at DESC
        LIMIT 1
      `;

    if (groups.length > 0) {
      resultChatId =
        String(groups[0].chat_id);
    }
  }

  // ----------------------------------------------------------
  // 所属グループなし
  // ----------------------------------------------------------

  if (
    !isGroupChat(message) &&
    resultChatId === messageChatId
  ) {
    await sendMessage(
      messageChatId,
      `⚠️ <b>所属グループが見つかりません。</b>\n\n` +
      `先にグループ内で <code>/start</code> を1回実行してください。`
    );

    return;
  }

  // ----------------------------------------------------------
  // グループから直接登録した場合
  // ----------------------------------------------------------

  if (isGroupChat(message)) {
    await ensureGroupContext(
      message
    );
  }

  // ----------------------------------------------------------
  // 実績保存
  // ----------------------------------------------------------

  const inserted =
    await sql`
      INSERT INTO delivery_results (
        telegram_user_id,
        sale_amount,
        delivery_count,
        work_hours,
        chat_id
      )
      VALUES (
        ${String(userId)},
        ${saleAmount},
        ${deliveryCount},
        ${workHours},
        ${String(resultChatId)}
      )
      RETURNING
        id,
        sale_amount,
        delivery_count,
        work_hours,
        created_at
    `;

  const result =
    inserted[0];

  // ----------------------------------------------------------
  // Audit Log
  // ----------------------------------------------------------

  await writeAuditLog({
    telegramUserId:
      userId,

    chatId:
      resultChatId,

    action:
      "add",

    details: {
      result_id:
        String(result.id),

      sale_amount:
        saleAmount,

      delivery_count:
        deliveryCount,

      work_hours:
        workHours,

      source_chat_id:
        String(messageChatId),

      saved_chat_id:
        String(resultChatId),
    },
  });

  // ----------------------------------------------------------
  // 計算
  // ----------------------------------------------------------

  const unitPrice =
    deliveryCount > 0
      ? Math.round(
          saleAmount /
          deliveryCount
        )
      : 0;

  const hourlySales =
    workHours > 0
      ? Math.round(
          saleAmount /
          workHours
        )
      : 0;

  // ----------------------------------------------------------
  // 完了メッセージ
  // ----------------------------------------------------------

  let text =
    `✅ <b>実績登録しました！</b>\n` +
    `━━━━━━━━━━━━━━\n` +
    `💰 売上：<b>${formatNumber(
      saleAmount
    )}円</b>\n` +
    `📦 配達：<b>${formatNumber(
      deliveryCount
    )}件</b>\n` +
    `⏱ 稼働：<b>${formatHours(
      workHours
    )}時間</b>\n` +
    `💴 件単価：約<b>${formatNumber(
      unitPrice
    )}円</b>\n` +
    `⚡ 時給換算：約<b>${formatNumber(
      hourlySales
    )}円</b>\n` +
    `━━━━━━━━━━━━━━\n` +
    `🎯 月間目標：${formatNumber(
      await getMonthlyGoal(userId)
    )}件`;

  if (!isGroupChat(message)) {
    text +=
      `\n\n👥 グループ実績にも反映しました。`;
  }

  await sendMessage(
    messageChatId,
    text
  );
}
// ============================================================
// /cancel
// ============================================================

async function handleCancel(message) {
  const userId = getTelegramUserId(message);
  const chatId = getChatId(message);

  if (!userId || !chatId) {
    return;
  }

  const rows = await sql`
    SELECT
      id,
      sale_amount,
      delivery_count,
      work_hours,
      created_at
    FROM delivery_results
    WHERE telegram_user_id = ${userId}
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `;

  if (rows.length === 0) {
    await sendMessage(
      chatId,
      `⚠️ <b>削除できる実績がありません。</b>`
    );

    return;
  }

  const latest = rows[0];

  await sql`
    DELETE FROM delivery_results
    WHERE id = ${latest.id}
      AND telegram_user_id = ${userId}
  `;

  await writeAuditLog({
    telegramUserId: userId,
    chatId,
    action: "cancel",
    details: {
      delivery_result_id: latest.id,
      sale_amount: latest.sale_amount,
      delivery_count: latest.delivery_count,
      work_hours: latest.work_hours,
    },
  });

  await sendMessage(
    chatId,
    `↩️ <b>最新の実績を削除しました。</b>\n\n` +
    `売上：<b>${formatNumber(
      latest.sale_amount
    )}円</b>\n` +
    `配達：<b>${formatNumber(
      latest.delivery_count
    )}件</b>\n` +
    `稼働：<b>${formatHours(
      latest.work_hours
    )}h</b>`
  );
}


// ============================================================
// /reset
// ============================================================

async function handleReset(message) {
  const userId = getTelegramUserId(message);
  const chatId = getChatId(message);

  if (!userId || !chatId) {
    return;
  }

  const countRows = await sql`
    SELECT COUNT(*)::int AS count
    FROM delivery_results
    WHERE telegram_user_id = ${userId}
  `;

  const count = Number(
    countRows[0]?.count || 0
  );

  if (count === 0) {
    const goal = await getMonthlyGoal(userId);

    await sendMessage(
      chatId,
      `⚠️ <b>削除する実績がありません。</b>\n\n` +
      `🎯 月間目標：${formatNumber(goal)}件\n\n` +
      `※月間目標はそのまま残っています。`
    );

    return;
  }

  await sql`
    DELETE FROM delivery_results
    WHERE telegram_user_id = ${userId}
  `;

  await writeAuditLog({
    telegramUserId: userId,
    chatId,
    action: "reset",
    details: {
      deleted_count: count,
    },
  });

  const gamification = await rebuildGamification(userId);

  await updateDailyStats(userId);
  await updateMonthlyStats(userId);

  const goal = await getMonthlyGoal(userId);

  await sendMessage(
    chatId,
    `🗑 <b>実績をすべて削除しました。</b>\n\n` +
    `削除件数：<b>${formatNumber(
      count
    )}件</b>\n\n` +
    `🏆 累計XP：<b>${formatNumber(
      gamification.xp
    )}</b>\n` +
    `🎚 レベル：<b>${gamification.level}</b>\n` +
    `🔥 連続稼働：<b>${gamification.streakDays}日</b>\n\n` +
    `🎯 月間目標：<b>${formatNumber(
      goal
    )}件</b>\n` +
    `※月間目標は残っています。`
  );
}


// ============================================================
// /goal
// ============================================================

async function handleGoal(message) {
  const userId = getTelegramUserId(message);
  const chatId = getChatId(message);

  if (!userId || !chatId) {
    return;
  }

  const parts = String(
    message?.text || ""
  )
    .trim()
    .split(/\s+/);

  if (parts.length < 2) {
    await sendMessage(
      chatId,
      `🎯 <b>現在の月間目標</b>\n\n` +
      `<b>${formatNumber(
        await getMonthlyGoal(userId)
      )}件</b>\n\n` +
      `変更：<code>/goal 500</code>`
    );

    return;
  }

  const rawGoal = String(
    parts[1]
  ).replace(/,/g, "");

  if (!/^\d+$/.test(rawGoal)) {
    await sendMessage(
      chatId,
      `⚠️ 目標件数は整数で指定してください。\n\n` +
      `例：<code>/goal 500</code>`
    );

    return;
  }

  const monthlyGoal = Number(rawGoal);

  if (
    monthlyGoal <= 0 ||
    monthlyGoal > 1000000
  ) {
    await sendMessage(
      chatId,
      `⚠️ 月間目標は1〜1,000,000件で指定してください。`
    );

    return;
  }

  await sql`
    INSERT INTO delivery_goals (
      telegram_user_id,
      monthly_goal,
      updated_at
    )
    VALUES (
      ${userId},
      ${monthlyGoal},
      NOW()
    )
    ON CONFLICT (
      telegram_user_id
    )
    DO UPDATE SET
      monthly_goal = EXCLUDED.monthly_goal,
      updated_at = NOW()
  `;

  await writeAuditLog({
    telegramUserId: userId,
    chatId,
    action: "goal_update",
    details: {
      monthlyGoal,
    },
  });

  await sendMessage(
    chatId,
    `🎯 <b>月間目標を更新しました！</b>\n\n` +
    `目標：<b>${formatNumber(
      monthlyGoal
    )}件</b>`
  );
}


// ============================================================
// グループ期間
// ============================================================

function getJSTMonthRange(offsetMonths = 0) {
  const now = new Date();

  const formatter = new Intl.DateTimeFormat(
    "en-CA",
    {
      timeZone: JST,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }
  );

  const parts = formatter.formatToParts(now);

  const year = Number(
    parts.find(
      (p) => p.type === "year"
    )?.value
  );

  const month = Number(
    parts.find(
      (p) => p.type === "month"
    )?.value
  );

  const base = new Date(
    Date.UTC(
      year,
      month - 1 + offsetMonths,
      1
    )
  );

  const targetYear = base.getUTCFullYear();
  const targetMonth = base.getUTCMonth() + 1;

  const start = `${targetYear}-${String(
    targetMonth
  ).padStart(2, "0")}-01`;

  const next = new Date(
    Date.UTC(
      targetYear,
      targetMonth,
      1
    )
  );

  const end = `${next.getUTCFullYear()}-${String(
    next.getUTCMonth() + 1
  ).padStart(2, "0")}-01`;

  return {
    start,
    end,
    year: targetYear,
    month: targetMonth,
  };
}


// ============================================================
// グループ取得
// ============================================================

async function getUserGroup(userId) {
  const rows = await sql`
    SELECT
      tg.chat_id,
      tg.title,
      tg.updated_at
    FROM telegram_groups tg
    INNER JOIN group_members gm
      ON gm.chat_id = tg.chat_id
    WHERE gm.telegram_user_id = ${String(userId)}
    ORDER BY
      gm.updated_at DESC,
      tg.updated_at DESC
    LIMIT 1
  `;

  return rows[0] || null;
}


// ============================================================
// /group
// ============================================================

async function handleGroup(message) {
  const userId = getTelegramUserId(message);
  const chatId = getChatId(message);

  if (!userId || !chatId) {
    return;
  }

  let groupChatId = null;

  if (isGroupChat(message)) {
    groupChatId = chatId;
  } else {
    const group = await getUserGroup(userId);

    if (group) {
      groupChatId = String(group.chat_id);
    }
  }

  if (!groupChatId) {
    await sendMessage(
      chatId,
      `⚠️ <b>所属グループが見つかりません。</b>\n\n` +
      `先にグループ内で <code>/start</code> を1回実行してください。`
    );

    return;
  }

  const {
    start,
    end,
    year,
    month,
  } = getJSTMonthRange(0);

  const rows = await sql`
    SELECT
      COALESCE(SUM(dr.sale_amount), 0)::bigint AS total_sales,
      COALESCE(SUM(dr.delivery_count), 0)::bigint AS total_deliveries,
      COALESCE(SUM(dr.work_hours), 0)::numeric AS total_hours
    FROM delivery_results dr
    INNER JOIN group_members gm
      ON gm.chat_id = dr.chat_id
     AND gm.telegram_user_id = dr.telegram_user_id
    WHERE dr.chat_id = ${groupChatId}
      AND dr.created_at >= ${start}::date AT TIME ZONE ${JST}
      AND dr.created_at < ${end}::date AT TIME ZONE ${JST}
      AND COALESCE(gm.username, '') <> 'delivery_result_bot'
      AND COALESCE(gm.username, '') <> 'GroupAnonymousBot'
      AND gm.telegram_user_id NOT IN (
        '8981642532',
        '1087968824'
      )
  `;

  const stats = rows[0] || {};

  const totalSales = Number(
    stats.total_sales || 0
  );

  const totalDeliveries = Number(
    stats.total_deliveries || 0
  );

  const totalHours = Number(
    stats.total_hours || 0
  );

  const memberRows = await sql`
    SELECT
      gm.telegram_user_id,
      COALESCE(gm.username, '') AS username,
      COALESCE(gm.first_name, '') AS first_name,
      COALESCE(SUM(dr.sale_amount), 0)::bigint AS sales,
      COALESCE(SUM(dr.delivery_count), 0)::bigint AS deliveries,
      COALESCE(SUM(dr.work_hours), 0)::numeric AS hours
    FROM group_members gm
    LEFT JOIN delivery_results dr
      ON dr.chat_id = gm.chat_id
     AND dr.telegram_user_id = gm.telegram_user_id
     AND dr.created_at >= ${start}::date AT TIME ZONE ${JST}
     AND dr.created_at < ${end}::date AT TIME ZONE ${JST}
    WHERE gm.chat_id = ${groupChatId}
      AND COALESCE(gm.username, '') <> 'delivery_result_bot'
      AND COALESCE(gm.username, '') <> 'GroupAnonymousBot'
      AND gm.telegram_user_id NOT IN (
        '8981642532',
        '1087968824'
      )
    GROUP BY
      gm.telegram_user_id,
      gm.username,
      gm.first_name
    ORDER BY
      sales DESC,
      deliveries DESC,
      hours DESC
  `;

  let text =
    `👥 <b>今月のグループ実績</b>\n` +
    `━━━━━━━━━━━━━━\n\n` +
    `📅 ${year}年${month}月\n\n` +
    `💰 売上：<b>${formatNumber(
      totalSales
    )}円</b>\n` +
    `📦 配達：<b>${formatNumber(
      totalDeliveries
    )}件</b>\n` +
    `⏱ 稼働：<b>${formatHours(
      totalHours
    )}h</b>\n\n`;

  for (const member of memberRows) {
    const name =
      member.first_name ||
      (member.username
        ? `@${member.username}`
        : "ユーザー");

    text +=
      `👤 ${name}\n` +
      `　${formatNumber(
        member.sales
      )}円 / ${formatNumber(
        member.deliveries
      )}件 / ${formatHours(
        member.hours
      )}h\n`;
  }

  await sendMessage(
    chatId,
    text
  );
}
// ============================================================
// /lastmonth
// ============================================================

async function handleLastMonth(message) {
  const userId = getTelegramUserId(message);
  const chatId = getChatId(message);

  if (!userId || !chatId) {
    return;
  }

  let groupChatId = null;

  if (isGroupChat(message)) {
    groupChatId = chatId;
  } else {
    const group = await getUserGroup(userId);

    if (group) {
      groupChatId = String(group.chat_id);
    }
  }

  if (!groupChatId) {
    await sendMessage(
      chatId,
      `⚠️ <b>所属グループが見つかりません。</b>\n\n` +
      `先にグループ内で <code>/start</code> を1回実行してください。`
    );

    return;
  }

  const {
    start,
    end,
    year,
    month,
  } = getJSTMonthRange(-1);

  const rows = await sql`
    SELECT
      COALESCE(SUM(dr.sale_amount), 0)::bigint AS total_sales,
      COALESCE(SUM(dr.delivery_count), 0)::bigint AS total_deliveries,
      COALESCE(SUM(dr.work_hours), 0)::numeric AS total_hours
    FROM delivery_results dr
    INNER JOIN group_members gm
      ON gm.chat_id = dr.chat_id
     AND gm.telegram_user_id = dr.telegram_user_id
    WHERE dr.chat_id = ${groupChatId}
      AND dr.created_at >= ${start}::date AT TIME ZONE ${JST}
      AND dr.created_at < ${end}::date AT TIME ZONE ${JST}
      AND COALESCE(gm.username, '') <> 'delivery_result_bot'
      AND COALESCE(gm.username, '') <> 'GroupAnonymousBot'
      AND gm.telegram_user_id NOT IN (
        '8981642532',
        '1087968824'
      )
  `;

  const stats = rows[0] || {};

  const totalSales = Number(
    stats.total_sales || 0
  );

  const totalDeliveries = Number(
    stats.total_deliveries || 0
  );

  const totalHours = Number(
    stats.total_hours || 0
  );

  await sendMessage(
    chatId,
    `📅 <b>先月のグループ実績</b>\n` +
    `━━━━━━━━━━━━━━\n\n` +
    `対象：<b>${year}年${month}月</b>\n\n` +
    `💰 売上：<b>${formatNumber(
      totalSales
    )}円</b>\n` +
    `📦 配達：<b>${formatNumber(
      totalDeliveries
    )}件</b>\n` +
    `⏱ 稼働：<b>${formatHours(
      totalHours
    )}h</b>`
  );
}


// ============================================================
// /month
// ============================================================

async function handleMonth(message) {
  const userId = getTelegramUserId(message);
  const chatId = getChatId(message);

  if (!userId || !chatId) {
    return;
  }

  const parts = String(
    message?.text || ""
  )
    .trim()
    .split(/\s+/);

  if (parts.length < 2) {
    await sendMessage(
      chatId,
      `📅 <b>指定月のグループ実績</b>\n\n` +
      `例：<code>/month 2026-09</code>`
    );

    return;
  }

  const monthText = String(
    parts[1]
  ).trim();

  if (!/^\d{4}-\d{2}$/.test(monthText)) {
    await sendMessage(
      chatId,
      `⚠️ 月は <code>YYYY-MM</code> 形式で指定してください。\n\n` +
      `例：<code>/month 2026-09</code>`
    );

    return;
  }

  const [yearText, monthTextOnly] =
    monthText.split("-");

  const year = Number(yearText);
  const month = Number(monthTextOnly);

  if (
    year < 2000 ||
    year > 2100 ||
    month < 1 ||
    month > 12
  ) {
    await sendMessage(
      chatId,
      `⚠️ 正しい年月を指定してください。`
    );

    return;
  }

  let groupChatId = null;

  if (isGroupChat(message)) {
    groupChatId = chatId;
  } else {
    const group = await getUserGroup(userId);

    if (group) {
      groupChatId = String(group.chat_id);
    }
  }

  if (!groupChatId) {
    await sendMessage(
      chatId,
      `⚠️ <b>所属グループが見つかりません。</b>\n\n` +
      `先にグループ内で <code>/start</code> を1回実行してください。`
    );

    return;
  }

  const start = `${yearText}-${monthTextOnly}-01`;

  const nextDate = new Date(
    Date.UTC(
      year,
      month,
      1
    )
  );

  const end =
    `${nextDate.getUTCFullYear()}-${String(
      nextDate.getUTCMonth() + 1
    ).padStart(2, "0")}-01`;

  const rows = await sql`
    SELECT
      COALESCE(SUM(dr.sale_amount), 0)::bigint AS total_sales,
      COALESCE(SUM(dr.delivery_count), 0)::bigint AS total_deliveries,
      COALESCE(SUM(dr.work_hours), 0)::numeric AS total_hours
    FROM delivery_results dr
    INNER JOIN group_members gm
      ON gm.chat_id = dr.chat_id
     AND gm.telegram_user_id = dr.telegram_user_id
    WHERE dr.chat_id = ${groupChatId}
      AND dr.created_at >= ${start}::date AT TIME ZONE ${JST}
      AND dr.created_at < ${end}::date AT TIME ZONE ${JST}
      AND COALESCE(gm.username, '') <> 'delivery_result_bot'
      AND COALESCE(gm.username, '') <> 'GroupAnonymousBot'
      AND gm.telegram_user_id NOT IN (
        '8981642532',
        '1087968824'
      )
  `;

  const stats = rows[0] || {};

  await sendMessage(
    chatId,
    `📅 <b>グループ実績</b>\n` +
    `━━━━━━━━━━━━━━\n\n` +
    `対象：<b>${year}年${month}月</b>\n\n` +
    `💰 売上：<b>${formatNumber(
      stats.total_sales || 0
    )}円</b>\n` +
    `📦 配達：<b>${formatNumber(
      stats.total_deliveries || 0
    )}件</b>\n` +
    `⏱ 稼働：<b>${formatHours(
      stats.total_hours || 0
    )}h</b>`
  );
}


// ============================================================
// /ranking
// ============================================================

async function handleRanking(message) {
  const userId = getTelegramUserId(message);
  const chatId = getChatId(message);

  if (!userId || !chatId) {
    return;
  }

  let groupChatId = null;

  if (isGroupChat(message)) {
    groupChatId = chatId;
  } else {
    const group = await getUserGroup(userId);

    if (group) {
      groupChatId = String(group.chat_id);
    }
  }

  if (!groupChatId) {
    await sendMessage(
      chatId,
      `⚠️ <b>所属グループが見つかりません。</b>\n\n` +
      `先にグループ内で <code>/start</code> を1回実行してください。`
    );

    return;
  }

  const {
    start,
    end,
  } = getJSTMonthRange(0);

  const rows = await sql`
    SELECT
      gm.telegram_user_id,
      COALESCE(gm.username, '') AS username,
      COALESCE(gm.first_name, '') AS first_name,
      COALESCE(SUM(dr.sale_amount), 0)::bigint AS sales,
      COALESCE(SUM(dr.delivery_count), 0)::bigint AS deliveries,
      COALESCE(SUM(dr.work_hours), 0)::numeric AS hours
    FROM group_members gm
    LEFT JOIN delivery_results dr
      ON dr.chat_id = gm.chat_id
     AND dr.telegram_user_id = gm.telegram_user_id
     AND dr.created_at >= ${start}::date AT TIME ZONE ${JST}
     AND dr.created_at < ${end}::date AT TIME ZONE ${JST}
    WHERE gm.chat_id = ${groupChatId}
      AND COALESCE(gm.username, '') <> 'delivery_result_bot'
      AND COALESCE(gm.username, '') <> 'GroupAnonymousBot'
      AND gm.telegram_user_id NOT IN (
        '8981642532',
        '1087968824'
      )
    GROUP BY
      gm.telegram_user_id,
      gm.username,
      gm.first_name
    ORDER BY
      sales DESC,
      deliveries DESC,
      hours DESC
  `;

  if (rows.length === 0) {
    await sendMessage(
      chatId,
      `🏆 <b>ランキング</b>\n\n` +
      `まだ実績がありません。`
    );

    return;
  }

  let text =
    `🏆 <b>今月のランキング</b>\n` +
    `━━━━━━━━━━━━━━\n\n`;

  rows.forEach((row, index) => {
    const rank = index + 1;

    const name =
      row.telegram_user_id === String(userId)
        ? "自分"
        : (
          row.first_name ||
          (
            row.username
              ? `@${row.username}`
              : "ユーザー"
          )
        );

    const sales = Number(
      row.sales || 0
    );

    const deliveries = Number(
      row.deliveries || 0
    );

    const hours = Number(
      row.hours || 0
    );

    const efficiency =
      hours > 0
        ? deliveries / hours
        : 0;

    const medal =
      rank === 1
        ? "🥇"
        : rank === 2
          ? "🥈"
          : rank === 3
            ? "🥉"
            : `${rank}位`;

    text +=
      `${medal} <b>${name}</b>\n` +
      `　${formatNumber(
        deliveries
      )}件 / ${formatHours(
        hours
      )}h\n` +
      `　${formatNumber(
        sales
      )}円 / ${efficiency.toFixed(
        1
      )}件/h\n\n`;
  });

  const myIndex = rows.findIndex(
    (row) =>
      String(row.telegram_user_id) ===
      String(userId)
  );

  if (myIndex >= 0) {
    const me = rows[myIndex];

    const mySales = Number(
      me.sales || 0
    );

    const myDeliveries = Number(
      me.deliveries || 0
    );

    const myHours = Number(
      me.hours || 0
    );

    const myEfficiency =
      myHours > 0
        ? myDeliveries / myHours
        : 0;

    text +=
      `━━━━━━━━━━━━━━\n` +
      `あなたの順位：<b>${myIndex + 1}位</b>\n` +
      `自分\n` +
      `${formatNumber(
        myDeliveries
      )}件 / ${formatHours(
        myHours
      )}h\n` +
      `${formatNumber(
        mySales
      )}円 / ${myEfficiency.toFixed(
        1
      )}件/h`;
  }

  await sendMessage(
    chatId,
    text
  );
}


// ============================================================
// /admin
// ============================================================

async function handleAdmin(message) {
  const userId = getTelegramUserId(message);
  const chatId = getChatId(message);

  if (!userId || !chatId) {
    return;
  }

  if (!isAdmin(userId)) {
    await sendMessage(
      chatId,
      `⛔ <b>管理者専用コマンドです。</b>`
    );

    await writeAuditLog({
      telegramUserId: userId,
      chatId,
      action: "admin_denied",
      details: {},
    });

    return;
  }

  const overallRows = await sql`
    SELECT
      COUNT(*)::int AS result_count,
      COUNT(DISTINCT telegram_user_id)::int AS user_count,
      COALESCE(SUM(sale_amount), 0)::bigint AS sales,
      COALESCE(SUM(delivery_count), 0)::bigint AS deliveries,
      COALESCE(SUM(work_hours), 0)::numeric AS hours
    FROM delivery_results
  `;

  const monthRows = await sql`
    SELECT
      COUNT(*)::int AS result_count,
      COUNT(DISTINCT telegram_user_id)::int AS user_count,
      COALESCE(SUM(sale_amount), 0)::bigint AS sales,
      COALESCE(SUM(delivery_count), 0)::bigint AS deliveries,
      COALESCE(SUM(work_hours), 0)::numeric AS hours
    FROM delivery_results
    WHERE (
      created_at AT TIME ZONE ${JST}
    ) >= date_trunc(
      'month',
      NOW() AT TIME ZONE ${JST}
    )
  `;

  const groupRows = await sql`
    SELECT COUNT(*)::int AS count
    FROM telegram_groups
  `;

  const logs = await sql`
    SELECT
      id,
      telegram_user_id,
      action,
      created_at
    FROM audit_logs
    ORDER BY created_at DESC
    LIMIT 10
  `;

  const overall = overallRows[0] || {};
  const month = monthRows[0] || {};

  let text =
    `🔐 <b>管理者統計</b>\n` +
    `━━━━━━━━━━━━━━\n\n` +

    `📊 <b>全体</b>\n` +
    `登録実績：<b>${formatNumber(
      overall.result_count || 0
    )}件</b>\n` +
    `ユーザー：<b>${formatNumber(
      overall.user_count || 0
    )}人</b>\n` +
    `売上：<b>${formatNumber(
      overall.sales || 0
    )}円</b>\n` +
    `配達：<b>${formatNumber(
      overall.deliveries || 0
    )}件</b>\n` +
    `稼働：<b>${formatHours(
      overall.hours || 0
    )}h</b>\n\n` +

    `📅 <b>今月</b>\n` +
    `実績登録：<b>${formatNumber(
      month.result_count || 0
    )}件</b>\n` +
    `アクティブ：<b>${formatNumber(
      month.user_count || 0
    )}人</b>\n` +
    `売上：<b>${formatNumber(
      month.sales || 0
    )}円</b>\n` +
    `配達：<b>${formatNumber(
      month.deliveries || 0
    )}件</b>\n` +
    `稼働：<b>${formatHours(
      month.hours || 0
    )}h</b>\n\n` +

    `👥 <b>グループ</b>\n` +
    `登録グループ：<b>${formatNumber(
      groupRows[0]?.count || 0
    )}</b>\n\n` +

    `📝 <b>最近の監査ログ</b>\n`;

  for (const log of logs) {
    text +=
      `${formatDateJST(
        log.created_at
      )} / ${log.action} / ${log.telegram_user_id}\n`;
  }

  if (logs.length === 0) {
    text += `なし\n`;
  }

  await sendMessage(
    chatId,
    text
  );

  await writeAuditLog({
    telegramUserId: userId,
    chatId,
    action: "admin",
    details: {},
  });
}


// ============================================================
// Mini App
// ============================================================

async function sendMiniAppButton(chatId) {
  const miniAppUrl =
    process.env.MINI_APP_URL ||
    process.env.WEB_APP_URL ||
    "";

  if (!miniAppUrl) {
    return false;
  }

  try {
    await telegramApi(
      "sendMessage",
      {
        chat_id: chatId,

        text:
          `📱 <b>Mini App</b>\n\n` +
          `実績・分析・ランキング・目標をまとめて確認できます。`,

        parse_mode: "HTML",

        reply_markup: {
          inline_keyboard: [
            [
              {
                text:
                  "📊 ダッシュボードを開く",

                web_app: {
                  url: miniAppUrl,
                },
              },
            ],
          ],
        },
      }
    );

    return true;
  } catch (error) {
    console.error(
      "Mini App button error:",
      error
    );

    return false;
  }
}


// ============================================================
// Command Router
// ============================================================

async function handleCommand(message) {
  const command =
    getCommandName(message);

  switch (command) {
    case "/start":
    case "start":
      await handleStart(message);
      return;

    case "/help":
    case "help":
      await handleHelp(message);
      return;

    case "/add":
    case "add":
      await handleAdd(message);
      return;

    case "/cancel":
    case "cancel":
      await handleCancel(message);
      return;

    case "/reset":
    case "reset":
      await handleReset(message);
      return;

    case "/goal":
    case "goal":
      await handleGoal(message);
      return;

    case "/group":
    case "group":
      await handleGroup(message);
      return;

    case "/lastmonth":
    case "lastmonth":
      await handleLastMonth(message);
      return;

    case "/month":
    case "month":
      await handleMonth(message);
      return;

    case "/ranking":
    case "ranking":
      await handleRanking(message);
      return;

    case "/admin":
    case "admin":
      await handleAdmin(message);
      return;

    default:
      return;
  }
}


// ============================================================
// Webhook Handler
// ============================================================

async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(200).json({
      ok: true,
      message:
        "Bot webhook is running.",
    });

    return;
  }

  try {
    if (!BOT_TOKEN) {
      console.error(
        "BOT_TOKEN is not configured."
      );

      res.status(500).json({
        ok: false,
        error:
          "BOT_TOKEN is not configured.",
      });

      return;
    }

    const update =
      typeof req.body === "string"
        ? JSON.parse(req.body)
        : req.body;

    if (
      !update ||
      typeof update !== "object"
    ) {
      res.status(200).json({
        ok: true,
      });

      return;
    }

    const message =
      update.message ||
      update.edited_message ||
      update.channel_post ||
      null;

    if (!message) {
      res.status(200).json({
        ok: true,
        ignored: true,
      });

      return;
    }

    // --------------------------------------------------------
    // グループの場合、Bot自身を除外しながら
    // グループ情報を同期
    // --------------------------------------------------------

    if (isGroupChat(message)) {
      try {
        await ensureGroupContext(
          message
        );
      } catch (error) {
        console.error(
          "group context error:",
          error
        );
      }
    }

    // --------------------------------------------------------
    // コマンド処理
    // --------------------------------------------------------

    if (
      typeof message.text === "string" &&
      message.text.trim().startsWith("/")
    ) {
      await handleCommand(message);
    }

    res.status(200).json({
      ok: true,
    });
  } catch (error) {
    console.error(
      "bot handler error:",
      error
    );

    // Telegramには200を返して
    // 不要なWebhook再送を避ける
    try {
      res.status(200).json({
        ok: false,
        error:
          "Internal bot error.",
      });
    } catch {
      // noop
    }
  }
}


// ============================================================
// Export
// ============================================================

module.exports = handler;

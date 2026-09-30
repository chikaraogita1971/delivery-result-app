import { neon } from "@neondatabase/serverless";

const sql = neon(process.env.DATABASE_URL);

const BOT_TOKEN = process.env.BOT_TOKEN;
const JST = "Asia/Tokyo";

if (!BOT_TOKEN) {
  throw new Error("BOT_TOKEN is not set");
}

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not set");
}

// ============================================================
// Telegram API
// ============================================================

async function telegramApi(method, body = {}) {
  const response = await fetch(
    `https://api.telegram.org/bot${BOT_TOKEN}/${method}`,
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
    console.error(`Telegram API error: ${method}`, data);

    throw new Error(
      data.description || `Telegram API error: ${method}`
    );
  }

  return data.result;
}

async function sendMessage(chatId, text, extra = {}) {
  if (!chatId) {
    return null;
  }

  return telegramApi("sendMessage", {
    chat_id: chatId,
    text,
    ...extra,
  });
}

async function answerCallbackQuery(callbackQueryId, text = "") {
  if (!callbackQueryId) {
    return null;
  }

  return telegramApi("answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    text,
  });
}

async function editMessageText(
  chatId,
  messageId,
  text,
  extra = {}
) {
  return telegramApi("editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text,
    ...extra,
  });
}

// ============================================================
// Helpers
// ============================================================

function getTelegramUserId(message) {
  return message?.from?.id
    ? String(message.from.id)
    : "";
}

function getChatId(message) {
  return message?.chat?.id
    ? String(message.chat.id)
    : "";
}

function isGroupChat(message) {
  const type = message?.chat?.type;

  return (
    type === "group" ||
    type === "supergroup"
  );
}

function getDisplayName(user) {
  if (!user) {
    return "ユーザー";
  }

  if (user.first_name && user.last_name) {
    return `${user.first_name} ${user.last_name}`;
  }

  if (user.first_name) {
    return user.first_name;
  }

  if (user.username) {
    return `@${user.username}`;
  }

  return String(user.id || "ユーザー");
}

function getCommandName(text) {
  if (!text) {
    return "";
  }

  const first = String(text)
    .trim()
    .split(/\s+/)[0];

  if (!first.startsWith("/")) {
    return "";
  }

  return first
    .slice(1)
    .split("@")[0]
    .toLowerCase();
}

function formatHours(value) {
  const hours = Number(value || 0);

  if (!Number.isFinite(hours)) {
    return "0";
  }

  return Number.isInteger(hours)
    ? String(hours)
    : hours
        .toFixed(2)
        .replace(/0+$/, "")
        .replace(/\.$/, "");
}

function formatNumber(value) {
  return Number(value || 0).toLocaleString("ja-JP");
}

function formatDateJST(value) {
  if (!value) {
    return "-";
  }

  return new Date(value).toLocaleString("ja-JP", {
    timeZone: JST,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function parseWorkHours(value) {
  if (value === undefined || value === null) {
    return null;
  }

  const text = String(value).trim();

  if (!text) {
    return null;
  }

  // 8:30
  const colonMatch = text.match(
    /^(\d+(?:\.\d+)?):(\d{1,2})$/
  );

  if (colonMatch) {
    const hours = Number(colonMatch[1]);
    const minutes = Number(colonMatch[2]);

    if (
      !Number.isFinite(hours) ||
      !Number.isFinite(minutes) ||
      minutes >= 60
    ) {
      return null;
    }

    return Math.round(
      (hours + minutes / 60) * 100
    ) / 100;
  }

  // 8時間30分
  const jpMatch = text.match(
    /^(?:(\d+(?:\.\d+)?)\s*時間)?\s*(?:(\d+)\s*分)?$/
  );

  if (jpMatch && (jpMatch[1] || jpMatch[2])) {
    const hours = Number(jpMatch[1] || 0);
    const minutes = Number(jpMatch[2] || 0);

    if (
      !Number.isFinite(hours) ||
      !Number.isFinite(minutes) ||
      minutes >= 60
    ) {
      return null;
    }

    return Math.round(
      (hours + minutes / 60) * 100
    ) / 100;
  }

  // 8時間
  const hoursOnly = text.match(
    /^(\d+(?:\.\d+)?)\s*時間$/
  );

  if (hoursOnly) {
    const hours = Number(hoursOnly[1]);

    return Number.isFinite(hours)
      ? Math.round(hours * 100) / 100
      : null;
  }

  // 30分
  const minutesOnly = text.match(
    /^(\d+)\s*分$/
  );

  if (minutesOnly) {
    const minutes = Number(minutesOnly[1]);

    if (
      !Number.isFinite(minutes) ||
      minutes >= 60
    ) {
      return null;
    }

    return Math.round(
      (minutes / 60) * 100
    ) / 100;
  }

  // 8 / 8.5
  const numberOnly = Number(text);

  if (
    Number.isFinite(numberOnly) &&
    numberOnly >= 0
  ) {
    return Math.round(numberOnly * 100) / 100;
  }

  return null;
}

// ============================================================
// Admin
// ============================================================

function getAdminIds() {
  const raw = String(
    process.env.ADMIN_TELEGRAM_USER_IDS || ""
  );

  return raw
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean)
    .map((id) => String(id));
}

function isAdmin(telegramUserId) {
  const userId = String(
    telegramUserId || ""
  );

  const adminIds = getAdminIds();

  console.log("ADMIN DEBUG:", {
    telegramUserId: userId,
    adminIds,
    hasAdminEnv: Boolean(
      process.env.ADMIN_TELEGRAM_USER_IDS
    ),
  });

  if (!userId) {
    return false;
  }

  return adminIds.includes(userId);
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
        ${String(telegramUserId || "")},
        ${chatId ? String(chatId) : null},
        ${action},
        ${
          details
            ? JSON.stringify(details)
            : null
        }::jsonb
      )
    `;
  } catch (error) {
    console.error(
      "AUDIT LOG ERROR:",
      error
    );
  }
}

// ============================================================
// Group Registration
// ============================================================

async function ensureGroupRegistered(message) {
  if (!isGroupChat(message)) {
    return;
  }

  const chatId = getChatId(message);

  if (!chatId) {
    return;
  }

  const title =
    message?.chat?.title || null;

  await sql`
    INSERT INTO telegram_groups (
      chat_id,
      title
    )
    VALUES (
      ${chatId},
      ${title}
    )
    ON CONFLICT (chat_id)
    DO UPDATE SET
      title = EXCLUDED.title,
      updated_at = NOW()
  `;
}

// ============================================================
// Group Member Registration
// ============================================================

async function ensureGroupMember(message) {
  if (!isGroupChat(message)) {
    return;
  }

  const chatId = getChatId(message);
  const userId = getTelegramUserId(message);

  if (!chatId || !userId) {
    return;
  }

  const user = message?.from || {};

  // Botユーザーは登録しない
  if (user.is_bot) {
    console.log(
      "GROUP MEMBER SKIP: bot user",
      {
        chatId,
        userId,
        username: user.username,
      }
    );

    return;
  }

  // Telegram匿名管理者
  if (
    user.username === "GroupAnonymousBot" ||
    userId === "1087968824"
  ) {
    console.log(
      "GROUP MEMBER SKIP: anonymous admin",
      {
        chatId,
        userId,
        username: user.username,
      }
    );

    return;
  }

  await sql`
    INSERT INTO group_members (
      chat_id,
      telegram_user_id,
      username,
      first_name
    )
    VALUES (
      ${chatId},
      ${userId},
      ${user.username || null},
      ${user.first_name || null}
    )
    ON CONFLICT (
      chat_id,
      telegram_user_id
    )
    DO UPDATE SET
      username = EXCLUDED.username,
      first_name = EXCLUDED.first_name,
      updated_at = NOW()
  `;

  console.log(
    "GROUP MEMBER REGISTERED:",
    {
      chatId,
      userId,
      username: user.username || null,
      firstName: user.first_name || null,
    }
  );
}

// ============================================================
// Group Context Registration
// ============================================================

async function ensureGroupContext(message) {
  if (!isGroupChat(message)) {
    return;
  }

  await ensureGroupRegistered(message);
  await ensureGroupMember(message);
}

// ============================================================
// /start
// ============================================================

async function handleStart(message) {
  const chatId = getChatId(message);
  const userId = getTelegramUserId(message);

  await ensureGroupContext(message);

  await sendMessage(
    chatId,
    [
      "🚚 配達リザルトへようこそ！",
      "",
      "配達実績を記録して、",
      "月間の売上・配達件数・稼働時間を確認できます。",
      "",
      "📌 主なコマンド",
      "",
      "/add",
      "配達実績を登録",
      "",
      "/cancel",
      "最新の実績を削除",
      "",
      "/reset",
      "自分の実績を全削除",
      "",
      "/goal",
      "月間目標を設定",
      "",
      "/group",
      "今月のグループ実績",
      "",
      "/lastmonth",
      "先月のグループ実績",
      "",
      "/month YYYY-MM",
      "指定月のグループ実績",
      "",
      "/help",
      "ヘルプを表示",
    ].join("\n")
  );

  await writeAuditLog({
    telegramUserId: userId,
    chatId,
    action: "start",
  });
}

// ============================================================
// /help
// ============================================================

async function handleHelp(message) {
  const chatId = getChatId(message);

  await ensureGroupContext(message);

  await sendMessage(
    chatId,
    [
      "📖 配達リザルト ヘルプ",
      "",
      "【個人】",
      "/add",
      "配達実績を登録します。",
      "",
      "/cancel",
      "自分の最新実績を削除します。",
      "",
      "/reset",
      "自分の実績をすべて削除します。",
      "",
      "/goal",
      "月間目標を設定します。",
      "",
      "【グループ】",
      "/group",
      "今月のグループ実績を表示します。",
      "",
      "/lastmonth",
      "先月のグループ実績を表示します。",
      "",
      "/month 2026-09",
      "指定した月のグループ実績を表示します。",
      "",
      "【管理者】",
      "/admin",
      "管理者用統計を表示します。",
      "",
      "稼働時間は以下の形式に対応しています。",
      "8",
      "8.5",
      "8:30",
      "8時間30分",
      "8時間",
      "30分",
    ].join("\n")
  );
}

// ============================================================
// /add
// ============================================================

async function handleAdd(message) {
  const chatId = getChatId(message);
  const userId = getTelegramUserId(message);

  // グループの場合、/addを使った時点でメンバー登録
  await ensureGroupContext(message);

  const args = String(message?.text || "")
    .trim()
    .split(/\s+/)
    .slice(1);

  if (args.length < 3) {
    await sendMessage(
      chatId,
      [
        "📝 実績を登録します。",
        "",
        "使い方：",
        "/add 売上 配達件数 稼働時間",
        "",
        "例：",
        "/add 20000 30 8",
        "/add 20000 30 8:30",
        "/add 20000 30 8時間30分",
      ].join("\n")
    );

    return;
  }

  const saleAmount = Number(args[0]);
  const deliveryCount = Number(args[1]);
  const workHours = parseWorkHours(
    args.slice(2).join(" ")
  );

  if (
    !Number.isFinite(saleAmount) ||
    !Number.isInteger(saleAmount) ||
    saleAmount < 0
  ) {
    await sendMessage(
      chatId,
      "❌ 売上金額が正しくありません。"
    );

    return;
  }

  if (
    !Number.isFinite(deliveryCount) ||
    !Number.isInteger(deliveryCount) ||
    deliveryCount < 0
  ) {
    await sendMessage(
      chatId,
      "❌ 配達件数が正しくありません。"
    );

    return;
  }

  if (
    workHours === null ||
    !Number.isFinite(workHours) ||
    workHours < 0
  ) {
    await sendMessage(
      chatId,
      [
        "❌ 稼働時間が正しくありません。",
        "",
        "例：8 / 8.5 / 8:30 / 8時間30分",
      ].join("\n")
    );

    return;
  }

  const [result] = await sql`
    INSERT INTO delivery_results (
      telegram_user_id,
      sale_amount,
      delivery_count,
      work_hours,
      chat_id
    )
    VALUES (
      ${userId},
      ${saleAmount},
      ${deliveryCount},
      ${workHours},
      ${
        isGroupChat(message)
          ? chatId
          : null
      }
    )
    RETURNING
      id,
      created_at
  `;

  await writeAuditLog({
    telegramUserId: userId,
    chatId,
    action: "add",
    details: {
      result_id: result.id,
      sale_amount: saleAmount,
      delivery_count: deliveryCount,
      work_hours: workHours,
    },
  });

  await sendMessage(
    chatId,
    [
      "✅ 配達実績を登録しました！",
      "",
      `💰 売上：${formatNumber(
        saleAmount
      )}円`,
      `📦 配達：${formatNumber(
        deliveryCount
      )}件`,
      `⏱ 稼働：${formatHours(
        workHours
      )}時間`,
      "",
      `🕐 ${formatDateJST(
        result.created_at
      )}`,
    ].join("\n")
  );
}

// ============================================================
// /cancel
// ============================================================

async function handleCancel(message) {
  const chatId = getChatId(message);
  const userId = getTelegramUserId(message);

  await ensureGroupContext(message);

  let result;

  if (isGroupChat(message)) {
    [result] = await sql`
      SELECT
        id,
        sale_amount,
        delivery_count,
        work_hours,
        created_at
      FROM delivery_results
      WHERE telegram_user_id = ${userId}
        AND chat_id = ${chatId}
      ORDER BY created_at DESC
      LIMIT 1
    `;
  } else {
    [result] = await sql`
      SELECT
        id,
        sale_amount,
        delivery_count,
        work_hours,
        created_at
      FROM delivery_results
      WHERE telegram_user_id = ${userId}
        AND (
          chat_id = ${chatId}
          OR chat_id IS NULL
        )
      ORDER BY created_at DESC
      LIMIT 1
    `;
  }

  if (!result) {
    await sendMessage(
      chatId,
      "📝 削除できる実績がありません。"
    );

    return;
  }

  await sql`
    DELETE FROM delivery_results
    WHERE id = ${result.id}
  `;

  await writeAuditLog({
    telegramUserId: userId,
    chatId,
    action: "cancel",
    details: {
      result_id: result.id,
      sale_amount: result.sale_amount,
      delivery_count: result.delivery_count,
      work_hours: result.work_hours,
    },
  });

  await sendMessage(
    chatId,
    [
      "🗑 最新の実績を削除しました。",
      "",
      `💰 ${formatNumber(
        result.sale_amount
      )}円`,
      `📦 ${formatNumber(
        result.delivery_count
      )}件`,
      `⏱ ${formatHours(
        result.work_hours
      )}時間`,
    ].join("\n")
  );
}

// ============================================================
// /reset
// ============================================================

async function handleReset(message) {
  const chatId = getChatId(message);
  const userId = getTelegramUserId(message);

  await ensureGroupContext(message);

  const [countResult] = await sql`
    SELECT COUNT(*)::int AS count
    FROM delivery_results
    WHERE telegram_user_id = ${userId}
  `;

  const count = Number(
    countResult?.count || 0
  );

  if (count === 0) {
    await sendMessage(
      chatId,
      "📝 削除する実績がありません。"
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

  await sendMessage(
    chatId,
    [
      "🗑 自分の実績をすべて削除しました。",
      "",
      `削除件数：${formatNumber(
        count
      )}件`,
    ].join("\n")
  );
}

// ============================================================
// /goal
// ============================================================

async function handleGoal(message) {
  const chatId = getChatId(message);
  const userId = getTelegramUserId(message);

  await ensureGroupContext(message);

  const args = String(message?.text || "")
    .trim()
    .split(/\s+/)
    .slice(1);

  if (args.length === 0) {
    const [goal] = await sql`
      SELECT monthly_goal
      FROM delivery_goals
      WHERE telegram_user_id = ${userId}
    `;

    if (!goal) {
      await sendMessage(
        chatId,
        [
          "🎯 月間目標はまだ設定されていません。",
          "",
          "設定：",
          "/goal 500000",
        ].join("\n")
      );

      return;
    }

    await sendMessage(
      chatId,
      [
        "🎯 現在の月間目標",
        "",
        `${formatNumber(
          goal.monthly_goal
        )}円`,
        "",
        "変更する場合：",
        "/goal 500000",
      ].join("\n")
    );

    return;
  }

  const monthlyGoal = Number(args[0]);

  if (
    !Number.isFinite(monthlyGoal) ||
    !Number.isInteger(monthlyGoal) ||
    monthlyGoal <= 0
  ) {
    await sendMessage(
      chatId,
      [
        "❌ 目標金額が正しくありません。",
        "",
        "例：",
        "/goal 500000",
      ].join("\n")
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
    ON CONFLICT (telegram_user_id)
    DO UPDATE SET
      monthly_goal = EXCLUDED.monthly_goal,
      updated_at = NOW()
  `;

  await writeAuditLog({
    telegramUserId: userId,
    chatId,
    action: "goal",
    details: {
      monthly_goal: monthlyGoal,
    },
  });

  await sendMessage(
    chatId,
    [
      "🎯 月間目標を設定しました！",
      "",
      `${formatNumber(
        monthlyGoal
      )}円`,
    ].join("\n")
  );
}

// ============================================================
// Group summary
// ============================================================

async function getGroupSummary(
  chatId,
  start,
  end
) {
  const [summary] = await sql`
    SELECT
      COUNT(*)::int AS result_count,
      COUNT(
        DISTINCT telegram_user_id
      )::int AS user_count,
      COALESCE(
        SUM(sale_amount),
        0
      )::bigint AS total_sales,
      COALESCE(
        SUM(delivery_count),
        0
      )::bigint AS total_deliveries,
      COALESCE(
        SUM(work_hours),
        0
      )::numeric AS total_hours
    FROM delivery_results
    WHERE chat_id = ${chatId}
      AND created_at >= ${start}
      AND created_at < ${end}
  `;

  const members = await sql`
    SELECT
      gm.telegram_user_id,
      gm.username,
      gm.first_name,
      COUNT(dr.id)::int AS result_count,
      COALESCE(
        SUM(dr.sale_amount),
        0
      )::bigint AS total_sales,
      COALESCE(
        SUM(dr.delivery_count),
        0
      )::bigint AS total_deliveries,
      COALESCE(
        SUM(dr.work_hours),
        0
      )::numeric AS total_hours
    FROM group_members gm
    LEFT JOIN delivery_results dr
      ON dr.chat_id = gm.chat_id
      AND dr.telegram_user_id =
        gm.telegram_user_id
      AND dr.created_at >= ${start}
      AND dr.created_at < ${end}
    WHERE gm.chat_id = ${chatId}
      AND COALESCE(gm.username, '') <>
        'delivery_result_bot'
      AND COALESCE(gm.username, '') <>
        'GroupAnonymousBot'
      AND gm.telegram_user_id NOT IN (
        '8981642532',
        '1087968824'
      )
    GROUP BY
      gm.telegram_user_id,
      gm.username,
      gm.first_name
    ORDER BY
      total_sales DESC,
      gm.telegram_user_id
  `;

  return {
    summary,
    members,
  };
}

// ============================================================
// Group result message
// ============================================================

function buildGroupResultMessage({
  year,
  month,
  summary,
  members,
  emptyMessage,
}) {
  const lines = [
    "👥 グループ配達リザルト",
    "",
    `📅 ${year}年${month}月`,
    "",
    `💰 売上：${formatNumber(
      summary.total_sales
    )}円`,
    `📦 配達：${formatNumber(
      summary.total_deliveries
    )}件`,
    `⏱ 稼働：${formatHours(
      summary.total_hours
    )}時間`,
    `👤 登録ユーザー：${formatNumber(
      summary.user_count
    )}人`,
    "",
  ];

  if (members.length > 0) {
    lines.push(
      "━━━━━━━━━━━━━━"
    );
    lines.push("👤 メンバー別");
    lines.push(
      "━━━━━━━━━━━━━━"
    );

    for (const member of members) {
      const name =
        member.first_name ||
        (
          member.username
            ? `@${member.username}`
            : member.telegram_user_id
        );

      lines.push("");
      lines.push(`👤 ${name}`);
      lines.push(
        `💰 ${formatNumber(
          member.total_sales
        )}円`
      );
      lines.push(
        `📦 ${formatNumber(
          member.total_deliveries
        )}件`
      );
      lines.push(
        `⏱ ${formatHours(
          member.total_hours
        )}時間`
      );
    }
  } else {
    lines.push(
      emptyMessage ||
        "まだ実績はありません。"
    );
  }

  return lines.join("\n");
}

// ============================================================
// /group
// ============================================================

async function handleGroup(message) {
  const chatId = getChatId(message);
  const userId = getTelegramUserId(message);

  if (!isGroupChat(message)) {
    await sendMessage(
      chatId,
      "👥 /group はグループ内で使用してください。"
    );

    return;
  }

  await ensureGroupContext(message);

  const [period] = await sql`
    SELECT
      date_trunc(
        'month',
        CURRENT_TIMESTAMP AT TIME ZONE ${JST}
      ) AT TIME ZONE ${JST}
        AS start_at,
      (
        (
          date_trunc(
            'month',
            CURRENT_TIMESTAMP AT TIME ZONE ${JST}
          ) + INTERVAL '1 month'
        ) AT TIME ZONE ${JST}
      ) AS end_at
  `;

  const {
    summary,
    members,
  } = await getGroupSummary(
    chatId,
    period.start_at,
    period.end_at
  );

  const nowJST = new Date(
    new Date().toLocaleString(
      "en-US",
      {
        timeZone: JST,
      }
    )
  );

  const year =
    nowJST.getFullYear();

  const month =
    nowJST.getMonth() + 1;

  const text =
    buildGroupResultMessage({
      year,
      month,
      summary,
      members,
      emptyMessage:
        "まだ実績はありません。",
    });

  await sendMessage(
    chatId,
    text
  );

  await writeAuditLog({
    telegramUserId: userId,
    chatId,
    action: "group",
  });
}

// ============================================================
// Month boundaries
// ============================================================

function getMonthRange(year, month) {
  const start = new Date(
    `${year}-${String(month).padStart(
      2,
      "0"
    )}-01T00:00:00+09:00`
  );

  const nextYear =
    month === 12
      ? year + 1
      : year;

  const nextMonth =
    month === 12
      ? 1
      : month + 1;

  const end = new Date(
    `${nextYear}-${String(nextMonth).padStart(
      2,
      "0"
    )}-01T00:00:00+09:00`
  );

  return {
    start,
    end,
  };
}

// ============================================================
// /lastmonth
// ============================================================

async function handleLastMonth(message) {
  const chatId = getChatId(message);
  const userId = getTelegramUserId(message);

  if (!isGroupChat(message)) {
    await sendMessage(
      chatId,
      "👥 /lastmonth はグループ内で使用してください。"
    );

    return;
  }

  await ensureGroupContext(message);

  const now = new Date(
    new Date().toLocaleString(
      "en-US",
      {
        timeZone: JST,
      }
    )
  );

  let year =
    now.getFullYear();

  let month =
    now.getMonth() + 1;

  month -= 1;

  if (month === 0) {
    month = 12;
    year -= 1;
  }

  const {
    start,
    end,
  } = getMonthRange(
    year,
    month
  );

  const {
    summary,
    members,
  } = await getGroupSummary(
    chatId,
    start,
    end
  );

  const text =
    buildGroupResultMessage({
      year,
      month,
      summary,
      members,
      emptyMessage:
        "この月の実績はありません。",
    });

  await sendMessage(
    chatId,
    text
  );

  await writeAuditLog({
    telegramUserId: userId,
    chatId,
    action: "lastmonth",
    details: {
      year,
      month,
    },
  });
}

// ============================================================
// /month YYYY-MM
// ============================================================

async function handleMonth(message) {
  const chatId = getChatId(message);
  const userId = getTelegramUserId(message);

  if (!isGroupChat(message)) {
    await sendMessage(
      chatId,
      "👥 /month はグループ内で使用してください。"
    );

    return;
  }

  const args = String(message?.text || "")
    .trim()
    .split(/\s+/)
    .slice(1);

  if (args.length === 0) {
    await sendMessage(
      chatId,
      [
        "📅 指定月の実績を表示します。",
        "",
        "使い方：",
        "/month YYYY-MM",
        "",
        "例：",
        "/month 2026-09",
      ].join("\n")
    );

    return;
  }

  const match = args[0].match(
    /^(\d{4})-(\d{1,2})$/
  );

  if (!match) {
    await sendMessage(
      chatId,
      [
        "❌ 月の指定が正しくありません。",
        "",
        "例：",
        "/month 2026-09",
      ].join("\n")
    );

    return;
  }

  const year =
    Number(match[1]);

  const month =
    Number(match[2]);

  if (
    month < 1 ||
    month > 12 ||
    year < 2000 ||
    year > 2100
  ) {
    await sendMessage(
      chatId,
      "❌ 年月が正しくありません。"
    );

    return;
  }

  await ensureGroupContext(message);

  const {
    start,
    end,
  } = getMonthRange(
    year,
    month
  );

  const {
    summary,
    members,
  } = await getGroupSummary(
    chatId,
    start,
    end
  );

  const text =
    buildGroupResultMessage({
      year,
      month,
      summary,
      members,
      emptyMessage:
        "この月の実績はありません。",
    });

  await sendMessage(
    chatId,
    text
  );

  await writeAuditLog({
    telegramUserId: userId,
    chatId,
    action: "month",
    details: {
      year,
      month,
    },
  });
}

// ============================================================
// /admin
// ============================================================

async function handleAdmin(message) {
  const chatId = getChatId(message);
  const userId = getTelegramUserId(message);

  const adminIds = getAdminIds();
  const admin = isAdmin(userId);

  console.log("ADMIN COMMAND:", {
    userId,
    chatId,
    adminIds,
    admin,
    envExists: Boolean(
      process.env.ADMIN_TELEGRAM_USER_IDS
    ),
  });

  if (!admin) {
    await sendMessage(
      chatId,
      [
        "⛔ このコマンドは管理者のみ利用できます。",
        "",
        `あなたのTelegram ID：${
          userId || "取得できません"
        }`,
        "",
        "管理者IDが正しく設定されているか確認してください。",
      ].join("\n")
    );

    await writeAuditLog({
      telegramUserId: userId,
      chatId,
      action: "admin_denied",
      details: {
        admin_ids: adminIds,
      },
    });

    return;
  }

  try {
    // --------------------------------
    // 全体統計
    // --------------------------------

    const [totalStats] = await sql`
      SELECT
        COUNT(*)::int AS result_count,
        COUNT(
          DISTINCT telegram_user_id
        )::int AS user_count,
        COALESCE(
          SUM(sale_amount),
          0
        )::bigint AS total_sales,
        COALESCE(
          SUM(delivery_count),
          0
        )::bigint AS total_deliveries,
        COALESCE(
          SUM(work_hours),
          0
        )::numeric AS total_hours
      FROM delivery_results
    `;

    // --------------------------------
    // 今月統計 JST
    // --------------------------------

    const [monthlyStats] = await sql`
      SELECT
        COUNT(*)::int AS result_count,
        COUNT(
          DISTINCT telegram_user_id
        )::int AS user_count,
        COALESCE(
          SUM(sale_amount),
          0
        )::bigint AS total_sales,
        COALESCE(
          SUM(delivery_count),
          0
        )::bigint AS total_deliveries,
        COALESCE(
          SUM(work_hours),
          0
        )::numeric AS total_hours
      FROM delivery_results
      WHERE created_at >= (
        date_trunc(
          'month',
          CURRENT_TIMESTAMP AT TIME ZONE ${JST}
        ) AT TIME ZONE ${JST}
      )
      AND created_at < (
        (
          date_trunc(
            'month',
            CURRENT_TIMESTAMP AT TIME ZONE ${JST}
          ) + INTERVAL '1 month'
        ) AT TIME ZONE ${JST}
      )
    `;

    // --------------------------------
    // グループ数
    // --------------------------------

    const [groupStats] = await sql`
      SELECT
        COUNT(*)::int AS group_count
      FROM telegram_groups
    `;

    // --------------------------------
    // 今月アクティブユーザー
    // --------------------------------

    const [activeUserStats] = await sql`
      SELECT
        COUNT(
          DISTINCT telegram_user_id
        )::int AS active_user_count
      FROM delivery_results
      WHERE created_at >= (
        date_trunc(
          'month',
          CURRENT_TIMESTAMP AT TIME ZONE ${JST}
        ) AT TIME ZONE ${JST}
      )
      AND created_at < (
        (
          date_trunc(
            'month',
            CURRENT_TIMESTAMP AT TIME ZONE ${JST}
          ) + INTERVAL '1 month'
        ) AT TIME ZONE ${JST}
      )
    `;

    // --------------------------------
    // 最新登録
    // --------------------------------

    const [latestResult] = await sql`
      SELECT
        MAX(created_at)
          AS latest_created_at
      FROM delivery_results
    `;

    // --------------------------------
    // 最新監査ログ
    // --------------------------------

    const recentLogs = await sql`
      SELECT
        telegram_user_id,
        chat_id,
        action,
        created_at
      FROM audit_logs
      ORDER BY created_at DESC
      LIMIT 5
    `;

    const totalSales =
      Number(
        totalStats?.total_sales || 0
      );

    const totalDeliveries =
      Number(
        totalStats?.total_deliveries || 0
      );

    const totalHours =
      Number(
        totalStats?.total_hours || 0
      );

    const monthlySales =
      Number(
        monthlyStats?.total_sales || 0
      );

    const monthlyDeliveries =
      Number(
        monthlyStats?.total_deliveries || 0
      );

    const monthlyHours =
      Number(
        monthlyStats?.total_hours || 0
      );

    const resultCount =
      Number(
        totalStats?.result_count || 0
      );

    const userCount =
      Number(
        totalStats?.user_count || 0
      );

    const groupCount =
      Number(
        groupStats?.group_count || 0
      );

    const activeUserCount =
      Number(
        activeUserStats
          ?.active_user_count || 0
      );

    const monthlyAverageSales =
      monthlyDeliveries > 0
        ? Math.round(
            monthlySales /
              monthlyDeliveries
          )
        : 0;

    const monthlyAverageHoursPerUser =
      activeUserCount > 0
        ? Math.round(
            (monthlyHours /
              activeUserCount) *
              100
          ) / 100
        : 0;

    const lines = [
      "🔐 管理者統計",
      "",
      "━━━━━━━━━━━━━━",
      "📊 全体",
      "━━━━━━━━━━━━━━",
      `登録実績：${formatNumber(
        resultCount
      )}件`,
      `ユーザー：${formatNumber(
        userCount
      )}人`,
      `売上：${formatNumber(
        totalSales
      )}円`,
      `配達：${formatNumber(
        totalDeliveries
      )}件`,
      `稼働：${formatHours(
        totalHours
      )}時間`,
      "",
      "━━━━━━━━━━━━━━",
      "📅 今月（JST）",
      "━━━━━━━━━━━━━━",
      `実績登録：${formatNumber(
        monthlyStats?.result_count || 0
      )}件`,
      `アクティブ：${formatNumber(
        activeUserCount
      )}人`,
      `売上：${formatNumber(
        monthlySales
      )}円`,
      `配達：${formatNumber(
        monthlyDeliveries
      )}件`,
      `稼働：${formatHours(
        monthlyHours
      )}時間`,
      `平均単価：${formatNumber(
        monthlyAverageSales
      )}円/件`,
      `平均稼働：${formatHours(
        monthlyAverageHoursPerUser
      )}時間/人`,
      "",
      "━━━━━━━━━━━━━━",
      "👥 グループ",
      "━━━━━━━━━━━━━━",
      `登録グループ：${formatNumber(
        groupCount
      )}`,
      "",
    ];

    if (recentLogs.length > 0) {
      lines.push(
        "━━━━━━━━━━━━━━"
      );
      lines.push("📝 最新ログ");
      lines.push(
        "━━━━━━━━━━━━━━"
      );

      for (const log of recentLogs) {
        const date = log.created_at
          ? new Date(
              log.created_at
            ).toLocaleString(
              "ja-JP",
              {
                timeZone: JST,
                month: "2-digit",
                day: "2-digit",
                hour: "2-digit",
                minute: "2-digit",
              }
            )
          : "-";

        lines.push(
          `${date} / ${log.action} / ${log.telegram_user_id}`
        );
      }

      lines.push("");
    }

    if (
      latestResult?.latest_created_at
    ) {
      lines.push(
        `🕐 最終登録：${formatDateJST(
          latestResult.latest_created_at
        )}`
      );
    } else {
      lines.push(
        "🕐 最終登録：まだありません"
      );
    }

    await sendMessage(
      chatId,
      lines.join("\n")
    );

    await writeAuditLog({
      telegramUserId: userId,
      chatId,
      action: "admin_view",
      details: {
        total_result_count:
          resultCount,
        total_user_count:
          userCount,
        total_sales:
          totalSales,
        total_deliveries:
          totalDeliveries,
        total_hours:
          totalHours,
        monthly_sales:
          monthlySales,
        monthly_deliveries:
          monthlyDeliveries,
        monthly_hours:
          monthlyHours,
      },
    });
  } catch (error) {
    console.error(
      "ADMIN ERROR:",
      error
    );

    await sendMessage(
      chatId,
      [
        "⚠️ 管理者統計の取得中にエラーが発生しました。",
        "",
        "Vercelのログを確認してください。",
      ].join("\n")
    );

    await writeAuditLog({
      telegramUserId: userId,
      chatId,
      action: "admin_error",
      details: {
        error: String(
          error?.message || error
        ),
      },
    });
  }
}

// ============================================================
// Main webhook
// ============================================================

export default async function handler(
  req,
  res
) {
  if (req.method !== "POST") {
    return res.status(200).json({
      ok: true,
      service:
        "delivery-result-bot",
    });
  }

  try {
    const update =
      typeof req.body === "string"
        ? JSON.parse(req.body)
        : req.body;

    console.log(
      "WEBHOOK UPDATE:",
      {
        hasMessage:
          Boolean(update?.message),
        hasCallbackQuery:
          Boolean(
            update?.callback_query
          ),
      }
    );

    // --------------------------------------------------------
    // Callback Query
    // --------------------------------------------------------

    if (update?.callback_query) {
      const callbackQuery =
        update.callback_query;

      const callbackUserId =
        callbackQuery?.from?.id
          ? String(
              callbackQuery.from.id
            )
          : "";

      const callbackChatId =
        callbackQuery?.message?.chat?.id
          ? String(
              callbackQuery.message
                .chat.id
            )
          : "";

      const data =
        callbackQuery?.data || "";

      await answerCallbackQuery(
        callbackQuery.id
      );

      console.log(
        "CALLBACK DEBUG:",
        {
          data,
          userId:
            callbackUserId,
          chatId:
            callbackChatId,
        }
      );

      return res.status(200).json({
        ok: true,
      });
    }

    // --------------------------------------------------------
    // Message
    // --------------------------------------------------------

    const message =
      update?.message;

    if (!message) {
      return res.status(200).json({
        ok: true,
      });
    }

    const text =
      message?.text || "";

    const userId =
      getTelegramUserId(message);

    const chatId =
      getChatId(message);

    console.log(
      "MESSAGE DEBUG:",
      {
        text,
        userId,
        chatId,
        chatType:
          message?.chat?.type || "",
        username:
          message?.from?.username || "",
        firstName:
          message?.from?.first_name || "",
        isBot:
          Boolean(message?.from?.is_bot),
      }
    );

    // グループなら自動登録
    await ensureGroupContext(message);

    const command =
      getCommandName(text);

    console.log(
      "COMMAND DEBUG:",
      {
        text,
        command,
        userId,
        chatId,
        chatType:
          message?.chat?.type,
      }
    );

    if (!command) {
      return res.status(200).json({
        ok: true,
      });
    }

    switch (command) {
      case "start":
        await handleStart(
          message
        );
        break;

      case "add":
        await handleAdd(
          message
        );
        break;

      case "cancel":
        await handleCancel(
          message
        );
        break;

      case "reset":
        await handleReset(
          message
        );
        break;

      case "goal":
        await handleGoal(
          message
        );
        break;

      case "help":
        await handleHelp(
          message
        );
        break;

      case "group":
        await handleGroup(
          message
        );
        break;

      case "lastmonth":
        await handleLastMonth(
          message
        );
        break;

      case "month":
        await handleMonth(
          message
        );
        break;

      case "admin":
        await handleAdmin(
          message
        );
        break;

      default:
        break;
    }

    return res.status(200).json({
      ok: true,
    });
  } catch (error) {
    console.error(
      "Webhook error:",
      error
    );

    return res.status(200).json({
      ok: false,
      error: String(
        error?.message || error
      ),
    });
  }
}

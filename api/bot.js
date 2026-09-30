import { neon } from "@neondatabase/serverless";

const sql = neon(process.env.DATABASE_URL);

const BOT_TOKEN = process.env.BOT_TOKEN;
const JST = "Asia/Tokyo";

if (!BOT_TOKEN) {
  throw new Error("BOT_TOKEN is not configured.");
}

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not configured.");
}

/* =========================================================
   Telegram API
========================================================= */

async function telegram(method, body = {}) {
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
    throw new Error(data.description || `Telegram API error: ${method}`);
  }

  return data.result;
}

async function sendMessage(chatId, text, options = {}) {
  return telegram("sendMessage", {
    chat_id: chatId,
    text,
    ...options,
  });
}

async function answerCallbackQuery(callbackQueryId, text = "") {
  return telegram("answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    text,
  });
}

/* =========================================================
   Basic helpers
========================================================= */

function getTelegramUserId(message) {
  return String(message?.from?.id || "");
}

function getChatId(message) {
  return String(message?.chat?.id || "");
}

function isGroupChat(message) {
  const type = message?.chat?.type;

  return type === "group" || type === "supergroup";
}

function getDisplayName(user) {
  if (!user) return "不明";

  if (user.username) {
    return `@${user.username}`;
  }

  const name = [user.first_name, user.last_name]
    .filter(Boolean)
    .join(" ");

  return name || String(user.id);
}

function formatYen(value) {
  return `${Number(value || 0).toLocaleString("ja-JP")}円`;
}

function formatHours(value) {
  const hours = Number(value || 0);

  return `${hours.toLocaleString("ja-JP", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  })}時間`;
}

function formatNumber(value) {
  return Number(value || 0).toLocaleString("ja-JP");
}

function formatMonthDay(dateValue) {
  const date = new Date(dateValue);

  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: JST,
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

/* =========================================================
   Input parsing
========================================================= */

function parseWorkHours(input) {
  if (!input) {
    return null;
  }

  const value = String(input).trim();

  const colonMatch = value.match(/^(\d+(?:\.\d+)?)\s*:\s*(\d{1,2})$/);

  if (colonMatch) {
    const hours = Number(colonMatch[1]);
    const minutes = Number(colonMatch[2]);

    if (!Number.isFinite(hours) || !Number.isFinite(minutes)) {
      return null;
    }

    if (minutes >= 60) {
      return null;
    }

    const total = hours + minutes / 60;

    if (total <= 0 || total > 24) {
      return null;
    }

    return Number(total.toFixed(2));
  }

  const japaneseMatch = value.match(
    /^(?:(\d+(?:\.\d+)?)\s*時間)?\s*(?:(\d+(?:\.\d+)?)\s*分)?$/
  );

  if (japaneseMatch && (japaneseMatch[1] || japaneseMatch[2])) {
    const hours = Number(japaneseMatch[1] || 0);
    const minutes = Number(japaneseMatch[2] || 0);

    if (!Number.isFinite(hours) || !Number.isFinite(minutes)) {
      return null;
    }

    if (minutes >= 60) {
      return null;
    }

    const total = hours + minutes / 60;

    if (total <= 0 || total > 24) {
      return null;
    }

    return Number(total.toFixed(2));
  }

  const numeric = Number(value);

  if (!Number.isFinite(numeric)) {
    return null;
  }

  if (numeric <= 0 || numeric > 24) {
    return null;
  }

  return Number(numeric.toFixed(2));
}

/* =========================================================
   Admin
========================================================= */

function getAdminIds() {
  const raw = String(process.env.ADMIN_TELEGRAM_USER_IDS || "");

  return raw
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean)
    .map((id) => String(id));
}

function isAdmin(telegramUserId) {
  const userId = String(telegramUserId || "");
  const adminIds = getAdminIds();

  console.log("ADMIN DEBUG:", {
    telegramUserId: userId,
    adminIds,
    hasAdminEnv: Boolean(process.env.ADMIN_TELEGRAM_USER_IDS),
  });

  if (!userId) {
    return false;
  }

  return adminIds.includes(userId);
}

/* =========================================================
   Audit log
========================================================= */

async function writeAuditLog({
  telegramUserId,
  chatId = null,
  action,
  details = {},
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
        ${JSON.stringify(details)}::jsonb
      )
    `;
  } catch (error) {
    console.error("Audit log error:", error);
  }
}

/* =========================================================
   Group / Member registration
========================================================= */

async function registerGroupAndMember(message) {
  if (!message?.chat || !isGroupChat(message)) {
    return;
  }

  const chatId = getChatId(message);
  const userId = getTelegramUserId(message);

  if (!chatId || !userId) {
    return;
  }

  const title = message.chat.title || null;

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
      ${message.from?.username || null},
      ${message.from?.first_name || null}
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
}

async function registerNewMembers(message) {
  if (!message?.new_chat_members?.length) {
    return;
  }

  if (!isGroupChat(message)) {
    return;
  }

  const chatId = getChatId(message);
  const title = message.chat.title || null;

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

  for (const member of message.new_chat_members) {
    const userId = String(member.id);

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
        ${member.username || null},
        ${member.first_name || null}
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
  }
}

/* =========================================================
   Command parsing
========================================================= */

function getCommandText(text = "") {
  return String(text).trim();
}

function getCommandName(text = "") {
  const match = String(text)
    .trim()
    .match(/^\/([a-zA-Z0-9_]+)/);

  return match ? match[1].toLowerCase() : "";
}

/* =========================================================
   /start
========================================================= */

async function handleStart(message) {
  const chatId = getChatId(message);
  const userId = getTelegramUserId(message);

  await sendMessage(
    chatId,
    [
      "🛵 配達リザルトBotへようこそ！",
      "",
      "配達実績を記録して、月間・グループ実績を確認できます。",
      "",
      "【基本操作】",
      "/add 20000 30 8",
      "→ 売上・件数・稼働時間を登録",
      "",
      "時間は以下にも対応しています。",
      "8",
      "8.5",
      "8:30",
      "8時間30分",
      "",
      "【その他】",
      "/cancel → 最新の実績を削除",
      "/reset → 自分の実績を全削除",
      "/goal → 月間目標を設定",
      "/group → 今月のグループ実績",
      "/lastmonth → 先月のグループ実績",
      "/month YYYY-MM → 指定月の実績",
      "/help → ヘルプ",
      "",
      "管理者は /admin も利用できます。",
    ].join("\n")
  );

  await writeAuditLog({
    telegramUserId: userId,
    chatId,
    action: "start",
  });
}

/* =========================================================
   /help
========================================================= */

async function handleHelp(message) {
  const chatId = getChatId(message);

  await sendMessage(
    chatId,
    [
      "📖 配達リザルトBot ヘルプ",
      "",
      "【実績登録】",
      "/add 売上 件数 時間",
      "",
      "例:",
      "/add 20000 30 8",
      "/add 20000 30 8.5",
      "/add 20000 30 8:30",
      "/add 20000 30 8時間30分",
      "",
      "【実績削除】",
      "/cancel",
      "→ 最新の実績を1件削除",
      "",
      "/reset",
      "→ 自分の実績をすべて削除",
      "",
      "【目標】",
      "/goal",
      "→ 月間売上目標を設定",
      "",
      "【集計】",
      "/group",
      "→ 今月のグループ実績",
      "",
      "/lastmonth",
      "→ 先月のグループ実績",
      "",
      "/month 2026-09",
      "→ 指定月のグループ実績",
      "",
      "【管理者】",
      "/admin",
      "→ 管理者用統計",
    ].join("\n")
  );
}

/* =========================================================
   /add
========================================================= */

async function handleAdd(message) {
  const chatId = getChatId(message);
  const userId = getTelegramUserId(message);

  const text = getCommandText(message.text);
  const args = text.split(/\s+/).slice(1);

  if (args.length < 3) {
    await sendMessage(
      chatId,
      [
        "❌ 入力形式が違います。",
        "",
        "例:",
        "/add 20000 30 8",
        "/add 20000 30 8.5",
        "/add 20000 30 8:30",
        "/add 20000 30 8時間30分",
      ].join("\n")
    );

    return;
  }

  const saleAmount = Number(args[0]);
  const deliveryCount = Number(args[1]);
  const workHoursInput = args.slice(2).join("");
  const workHours = parseWorkHours(workHoursInput);

  if (
    !Number.isInteger(saleAmount) ||
    saleAmount < 0 ||
    saleAmount > 1000000
  ) {
    await sendMessage(
      chatId,
      "❌ 売上金額が正しくありません。\n0〜1,000,000円の範囲で入力してください。"
    );

    return;
  }

  if (
    !Number.isInteger(deliveryCount) ||
    deliveryCount < 0 ||
    deliveryCount > 1000
  ) {
    await sendMessage(
      chatId,
      "❌ 配達件数が正しくありません。\n0〜1,000件の範囲で入力してください。"
    );

    return;
  }

  if (workHours === null) {
    await sendMessage(
      chatId,
      [
        "❌ 稼働時間が正しくありません。",
        "",
        "例:",
        "8",
        "8.5",
        "8:30",
        "8時間30分",
        "",
        "0時間より大きく24時間以内で入力してください。",
      ].join("\n")
    );

    return;
  }

  if (isGroupChat(message)) {
    await registerGroupAndMember(message);
  }

  await sql`
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
      ${chatId}
    )
  `;

  await writeAuditLog({
    telegramUserId: userId,
    chatId,
    action: "add",
    details: {
      sale_amount: saleAmount,
      delivery_count: deliveryCount,
      work_hours: workHours,
    },
  });

  await sendMessage(
    chatId,
    [
      "✅ 実績を登録しました！",
      "",
      `💰 売上：${formatYen(saleAmount)}`,
      `📦 件数：${formatNumber(deliveryCount)}件`,
      `⏱ 稼働：${formatHours(workHours)}`,
      "",
      `📅 ${formatMonthDay(new Date())}`,
    ].join("\n")
  );
}

/* =========================================================
   /cancel
========================================================= */

async function handleCancel(message) {
  const chatId = getChatId(message);
  const userId = getTelegramUserId(message);

  let rows;

  if (isGroupChat(message)) {
    rows = await sql`
      SELECT
        id,
        sale_amount,
        delivery_count,
        work_hours,
        created_at
      FROM delivery_results
      WHERE telegram_user_id = ${userId}
        AND chat_id = ${chatId}
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `;
  } else {
    rows = await sql`
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
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `;
  }

  if (!rows.length) {
    await sendMessage(
      chatId,
      "ℹ️ 削除できる実績がありません。"
    );

    return;
  }

  const row = rows[0];

  await sql`
    DELETE FROM delivery_results
    WHERE id = ${row.id}
  `;

  await writeAuditLog({
    telegramUserId: userId,
    chatId,
    action: "cancel",
    details: {
      deleted_result_id: row.id,
      sale_amount: row.sale_amount,
      delivery_count: row.delivery_count,
      work_hours: row.work_hours,
    },
  });

  await sendMessage(
    chatId,
    [
      "🗑 最新の実績を削除しました。",
      "",
      `💰 ${formatYen(row.sale_amount)}`,
      `📦 ${formatNumber(row.delivery_count)}件`,
      `⏱ ${formatHours(row.work_hours)}`,
      `📅 ${formatMonthDay(row.created_at)}`,
    ].join("\n")
  );
}

/* =========================================================
   /reset
========================================================= */

async function handleReset(message) {
  const chatId = getChatId(message);
  const userId = getTelegramUserId(message);

  const rows = await sql`
    SELECT COUNT(*)::int AS count
    FROM delivery_results
    WHERE telegram_user_id = ${userId}
  `;

  const count = Number(rows[0]?.count || 0);

  if (count === 0) {
    await sendMessage(
      chatId,
      "ℹ️ 削除できる実績がありません。"
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
      `削除件数：${formatNumber(count)}件`,
    ].join("\n")
  );
}

/* =========================================================
   /goal
========================================================= */

async function handleGoal(message) {
  const chatId = getChatId(message);
  const userId = getTelegramUserId(message);

  const text = getCommandText(message.text);
  const args = text.split(/\s+/).slice(1);

  if (!args.length) {
    const current = await sql`
      SELECT monthly_goal
      FROM delivery_goals
      WHERE telegram_user_id = ${userId}
    `;

    if (!current.length) {
      await sendMessage(
        chatId,
        [
          "🎯 月間目標はまだ設定されていません。",
          "",
          "設定例:",
          "/goal 500000",
        ].join("\n")
      );

      return;
    }

    await sendMessage(
      chatId,
      `🎯 現在の月間目標：${formatYen(current[0].monthly_goal)}`
    );

    return;
  }

  const goal = Number(args[0]);

  if (
    !Number.isInteger(goal) ||
    goal <= 0 ||
    goal > 100000000
  ) {
    await sendMessage(
      chatId,
      "❌ 目標金額が正しくありません。\n1円〜100,000,000円で入力してください。"
    );

    return;
  }

  await sql`
    INSERT INTO delivery_goals (
      telegram_user_id,
      monthly_goal
    )
    VALUES (
      ${userId},
      ${goal}
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
      monthly_goal: goal,
    },
  });

  await sendMessage(
    chatId,
    `🎯 月間目標を ${formatYen(goal)} に設定しました！`
  );
}

/* =========================================================
   Month helpers
========================================================= */

function parseYearMonth(value) {
  const match = String(value || "").match(/^(\d{4})-(\d{1,2})$/);

  if (!match) {
    return null;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);

  if (year < 2020 || year > 2100) {
    return null;
  }

  if (month < 1 || month > 12) {
    return null;
  }

  return {
    year,
    month,
    monthStart: `${year}-${String(month).padStart(2, "0")}-01`,
  };
}

async function getMonthSummary(monthStart, chatId = null) {
  if (chatId) {
    const rows = await sql`
      SELECT
        COALESCE(SUM(sale_amount), 0)::bigint AS total_sales,
        COALESCE(SUM(delivery_count), 0)::bigint AS total_deliveries,
        COALESCE(SUM(work_hours), 0)::numeric AS total_hours,
        COUNT(DISTINCT telegram_user_id)::int AS user_count
      FROM delivery_results
      WHERE chat_id = ${chatId}
        AND created_at >= (
          ${monthStart}::date AT TIME ZONE ${JST}
        )
        AND created_at < (
          (
            ${monthStart}::date + INTERVAL '1 month'
          ) AT TIME ZONE ${JST}
        )
    `;

    return rows[0];
  }

  return {
    total_sales: 0,
    total_deliveries: 0,
    total_hours: 0,
    user_count: 0,
  };
}

/* =========================================================
   /group
========================================================= */

async function handleGroup(message) {
  const chatId = getChatId(message);
  const userId = getTelegramUserId(message);

  if (!isGroupChat(message)) {
    await sendMessage(
      chatId,
      "ℹ️ /group はグループ内で使用してください。"
    );

    return;
  }

  await registerGroupAndMember(message);

  const rows = await sql`
    SELECT
      COALESCE(SUM(sale_amount), 0)::bigint AS total_sales,
      COALESCE(SUM(delivery_count), 0)::bigint AS total_deliveries,
      COALESCE(SUM(work_hours), 0)::numeric AS total_hours,
      COUNT(DISTINCT telegram_user_id)::int AS user_count
    FROM delivery_results
    WHERE chat_id = ${chatId}
      AND created_at >= (
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

  const summary = rows[0];

  const members = await sql`
    SELECT
      gm.telegram_user_id,
      gm.username,
      gm.first_name,
      COALESCE(SUM(dr.sale_amount), 0)::bigint AS sales,
      COALESCE(SUM(dr.delivery_count), 0)::bigint AS deliveries,
      COALESCE(SUM(dr.work_hours), 0)::numeric AS hours
    FROM group_members gm
    LEFT JOIN delivery_results dr
      ON dr.telegram_user_id = gm.telegram_user_id
      AND dr.chat_id = gm.chat_id
      AND dr.created_at >= (
        date_trunc(
          'month',
          CURRENT_TIMESTAMP AT TIME ZONE ${JST}
        ) AT TIME ZONE ${JST}
      )
      AND dr.created_at < (
        (
          date_trunc(
            'month',
            CURRENT_TIMESTAMP AT TIME ZONE ${JST}
          ) + INTERVAL '1 month'
        ) AT TIME ZONE ${JST}
      )
    WHERE gm.chat_id = ${chatId}
    GROUP BY
      gm.telegram_user_id,
      gm.username,
      gm.first_name
    ORDER BY sales DESC, deliveries DESC
  `;

  const monthLabel = new Intl.DateTimeFormat("ja-JP", {
    timeZone: JST,
    year: "numeric",
    month: "long",
  }).format(new Date());

  const lines = [
    `📊 ${monthLabel} グループ実績`,
    "",
    `💰 売上：${formatYen(summary.total_sales)}`,
    `📦 配達：${formatNumber(summary.total_deliveries)}件`,
    `⏱ 稼働：${formatHours(summary.total_hours)}`,
    `👥 登録者：${formatNumber(summary.user_count)}人`,
    "",
    "【メンバー別】",
  ];

  if (!members.length) {
    lines.push("まだメンバーが登録されていません。");
  } else {
    members.forEach((member, index) => {
      const name = member.username
        ? `@${member.username}`
        : member.first_name || member.telegram_user_id;

      lines.push(
        `${index + 1}. ${name}`,
        `   💰 ${formatYen(member.sales)} / 📦 ${formatNumber(
          member.deliveries
        )}件 / ⏱ ${formatHours(member.hours)}`
      );
    });
  }

  await sendMessage(chatId, lines.join("\n"));

  await writeAuditLog({
    telegramUserId: userId,
    chatId,
    action: "group",
  });
}

/* =========================================================
   /lastmonth
========================================================= */

async function handleLastMonth(message) {
  const chatId = getChatId(message);
  const userId = getTelegramUserId(message);

  if (!isGroupChat(message)) {
    await sendMessage(
      chatId,
      "ℹ️ /lastmonth はグループ内で使用してください。"
    );

    return;
  }

  await registerGroupAndMember(message);

  const rows = await sql`
    SELECT
      COALESCE(SUM(sale_amount), 0)::bigint AS total_sales,
      COALESCE(SUM(delivery_count), 0)::bigint AS total_deliveries,
      COALESCE(SUM(work_hours), 0)::numeric AS total_hours,
      COUNT(DISTINCT telegram_user_id)::int AS user_count
    FROM delivery_results
    WHERE chat_id = ${chatId}
      AND created_at >= (
        (
          date_trunc(
            'month',
            CURRENT_TIMESTAMP AT TIME ZONE ${JST}
          ) - INTERVAL '1 month'
        ) AT TIME ZONE ${JST}
      )
      AND created_at < (
        date_trunc(
          'month',
          CURRENT_TIMESTAMP AT TIME ZONE ${JST}
        ) AT TIME ZONE ${JST}
      )
  `;

  const summary = rows[0];

  const members = await sql`
    SELECT
      gm.telegram_user_id,
      gm.username,
      gm.first_name,
      COALESCE(SUM(dr.sale_amount), 0)::bigint AS sales,
      COALESCE(SUM(dr.delivery_count), 0)::bigint AS deliveries,
      COALESCE(SUM(dr.work_hours), 0)::numeric AS hours
    FROM group_members gm
    LEFT JOIN delivery_results dr
      ON dr.telegram_user_id = gm.telegram_user_id
      AND dr.chat_id = gm.chat_id
      AND dr.created_at >= (
        (
          date_trunc(
            'month',
            CURRENT_TIMESTAMP AT TIME ZONE ${JST}
          ) - INTERVAL '1 month'
        ) AT TIME ZONE ${JST}
      )
      AND dr.created_at < (
        date_trunc(
          'month',
          CURRENT_TIMESTAMP AT TIME ZONE ${JST}
        ) AT TIME ZONE ${JST}
      )
    WHERE gm.chat_id = ${chatId}
    GROUP BY
      gm.telegram_user_id,
      gm.username,
      gm.first_name
    ORDER BY sales DESC, deliveries DESC
  `;

  const now = new Date();

  const lastMonthDate = new Date(
    now.toLocaleString("en-US", {
      timeZone: JST,
    })
  );

  lastMonthDate.setMonth(lastMonthDate.getMonth() - 1);

  const monthLabel = new Intl.DateTimeFormat("ja-JP", {
    timeZone: JST,
    year: "numeric",
    month: "long",
  }).format(lastMonthDate);

  const lines = [
    `📊 ${monthLabel} グループ実績`,
    "",
    `💰 売上：${formatYen(summary.total_sales)}`,
    `📦 配達：${formatNumber(summary.total_deliveries)}件`,
    `⏱ 稼働：${formatHours(summary.total_hours)}`,
    `👥 登録者：${formatNumber(summary.user_count)}人`,
    "",
    "【メンバー別】",
  ];

  if (!members.length) {
    lines.push("メンバー情報がありません。");
  } else {
    members.forEach((member, index) => {
      const name = member.username
        ? `@${member.username}`
        : member.first_name || member.telegram_user_id;

      lines.push(
        `${index + 1}. ${name}`,
        `   💰 ${formatYen(member.sales)} / 📦 ${formatNumber(
          member.deliveries
        )}件 / ⏱ ${formatHours(member.hours)}`
      );
    });
  }

  await sendMessage(chatId, lines.join("\n"));

  await writeAuditLog({
    telegramUserId: userId,
    chatId,
    action: "lastmonth",
  });
}

/* =========================================================
   /month
========================================================= */

async function handleMonth(message) {
  const chatId = getChatId(message);
  const userId = getTelegramUserId(message);

  if (!isGroupChat(message)) {
    await sendMessage(
      chatId,
      "ℹ️ /month はグループ内で使用してください。"
    );

    return;
  }

  const text = getCommandText(message.text);

  const match = text.match(
    /^\/month(?:@\w+)?\s+(\d{4}-\d{1,2})$/i
  );

  if (!match) {
    await sendMessage(
      chatId,
      [
        "❌ 月の指定が正しくありません。",
        "",
        "例:",
        "/month 2026-09",
        "/month 2026-10",
      ].join("\n")
    );

    return;
  }

  const parsed = parseYearMonth(match[1]);

  if (!parsed) {
    await sendMessage(
      chatId,
      "❌ 年月が正しくありません。例：/month 2026-09"
    );

    return;
  }

  await registerGroupAndMember(message);

  const summary = await getMonthSummary(
    parsed.monthStart,
    chatId
  );

  const members = await sql`
    SELECT
      gm.telegram_user_id,
      gm.username,
      gm.first_name,
      COALESCE(SUM(dr.sale_amount), 0)::bigint AS sales,
      COALESCE(SUM(dr.delivery_count), 0)::bigint AS deliveries,
      COALESCE(SUM(dr.work_hours), 0)::numeric AS hours
    FROM group_members gm
    LEFT JOIN delivery_results dr
      ON dr.telegram_user_id = gm.telegram_user_id
      AND dr.chat_id = gm.chat_id
      AND dr.created_at >= (
        ${parsed.monthStart}::date AT TIME ZONE ${JST}
      )
      AND dr.created_at < (
        (
          ${parsed.monthStart}::date + INTERVAL '1 month'
        ) AT TIME ZONE ${JST}
      )
    WHERE gm.chat_id = ${chatId}
    GROUP BY
      gm.telegram_user_id,
      gm.username,
      gm.first_name
    ORDER BY sales DESC, deliveries DESC
  `;

  const monthLabel = `${parsed.year}年${parsed.month}月`;

  const lines = [
    `📊 ${monthLabel} グループ実績`,
    "",
    `💰 売上：${formatYen(summary.total_sales)}`,
    `📦 配達：${formatNumber(summary.total_deliveries)}件`,
    `⏱ 稼働：${formatHours(summary.total_hours)}`,
    `👥 登録者：${formatNumber(summary.user_count)}人`,
    "",
    "【メンバー別】",
  ];

  if (!members.length) {
    lines.push("メンバー情報がありません。");
  } else {
    members.forEach((member, index) => {
      const name = member.username
        ? `@${member.username}`
        : member.first_name || member.telegram_user_id;

      lines.push(
        `${index + 1}. ${name}`,
        `   💰 ${formatYen(member.sales)} / 📦 ${formatNumber(
          member.deliveries
        )}件 / ⏱ ${formatHours(member.hours)}`
      );
    });
  }

  await sendMessage(chatId, lines.join("\n"));

  await writeAuditLog({
    telegramUserId: userId,
    chatId,
    action: "month",
    details: {
      year: parsed.year,
      month: parsed.month,
    },
  });
}

/* =========================================================
   /admin
========================================================= */

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
  });

  if (!admin) {
    await sendMessage(
      chatId,
      [
        "⛔ このコマンドは管理者のみ利用できます。",
        "",
        `あなたのTelegram ID：${userId || "取得できません"}`,
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

  const totals = await sql`
    SELECT
      COUNT(*)::bigint AS result_count,
      COALESCE(SUM(sale_amount), 0)::bigint AS total_sales,
      COALESCE(SUM(delivery_count), 0)::bigint AS total_deliveries,
      COALESCE(SUM(work_hours), 0)::numeric AS total_hours,
      COUNT(DISTINCT telegram_user_id)::int AS user_count,
      COUNT(DISTINCT chat_id)::int AS chat_count
    FROM delivery_results
  `;

  const currentMonth = await sql`
    SELECT
      COUNT(*)::bigint AS result_count,
      COALESCE(SUM(sale_amount), 0)::bigint AS total_sales,
      COALESCE(SUM(delivery_count), 0)::bigint AS total_deliveries,
      COALESCE(SUM(work_hours), 0)::numeric AS total_hours,
      COUNT(DISTINCT telegram_user_id)::int AS user_count,
      COUNT(DISTINCT chat_id)::int AS chat_count
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

  const recentMonths = await sql`
    SELECT
      TO_CHAR(
        created_at AT TIME ZONE ${JST},
        'YYYY-MM'
      ) AS month,
      COALESCE(SUM(sale_amount), 0)::bigint AS sales,
      COALESCE(SUM(delivery_count), 0)::bigint AS deliveries,
      COALESCE(SUM(work_hours), 0)::numeric AS hours,
      COUNT(DISTINCT telegram_user_id)::int AS users
    FROM delivery_results
    GROUP BY
      TO_CHAR(
        created_at AT TIME ZONE ${JST},
        'YYYY-MM'
      )
    ORDER BY month DESC
    LIMIT 6
  `;

  const total = totals[0];
  const current = currentMonth[0];

  const lines = [
    "🔐 管理者統計",
    "",
    "【全期間】",
    `📝 登録件数：${formatNumber(total.result_count)}件`,
    `💰 売上：${formatYen(total.total_sales)}`,
    `📦 配達：${formatNumber(total.total_deliveries)}件`,
    `⏱ 稼働：${formatHours(total.total_hours)}`,
    `👤 ユーザー：${formatNumber(total.user_count)}人`,
    `💬 チャット：${formatNumber(total.chat_count)}`,
    "",
    "【今月】",
    `📝 登録件数：${formatNumber(current.result_count)}件`,
    `💰 売上：${formatYen(current.total_sales)}`,
    `📦 配達：${formatNumber(current.total_deliveries)}件`,
    `⏱ 稼働：${formatHours(current.total_hours)}`,
    `👤 ユーザー：${formatNumber(current.user_count)}人`,
    "",
    "【月別】",
  ];

  if (!recentMonths.length) {
    lines.push("データなし");
  } else {
    for (const month of recentMonths) {
      lines.push(
        `${month.month}：${formatYen(month.sales)} / ${formatNumber(
          month.deliveries
        )}件 / ${formatHours(month.hours)} / ${formatNumber(
          month.users
        )}人`
      );
    }
  }

  await sendMessage(chatId, lines.join("\n"));

  await writeAuditLog({
    telegramUserId: userId,
    chatId,
    action: "admin",
  });
}

/* =========================================================
   Callback Query
========================================================= */

async function handleCallbackQuery(callbackQuery) {
  const callbackId = callbackQuery.id;
  const fromUserId = String(callbackQuery.from?.id || "");
  const data = String(callbackQuery.data || "");
  const message = callbackQuery.message;
  const chatId = String(message?.chat?.id || "");

  try {
    if (data === "cancel") {
      const rows = await sql`
        SELECT
          id,
          sale_amount,
          delivery_count,
          work_hours,
          created_at
        FROM delivery_results
        WHERE telegram_user_id = ${fromUserId}
          AND (
            chat_id = ${chatId}
            OR chat_id IS NULL
          )
        ORDER BY created_at DESC, id DESC
        LIMIT 1
      `;

      if (!rows.length) {
        await answerCallbackQuery(
          callbackId,
          "削除できる実績がありません。"
        );

        return;
      }

      const row = rows[0];

      await sql`
        DELETE FROM delivery_results
        WHERE id = ${row.id}
      `;

      await writeAuditLog({
        telegramUserId: fromUserId,
        chatId,
        action: "cancel_callback",
        details: {
          deleted_result_id: row.id,
          sale_amount: row.sale_amount,
          delivery_count: row.delivery_count,
          work_hours: row.work_hours,
        },
      });

      await answerCallbackQuery(
        callbackId,
        "最新の実績を削除しました。"
      );

      await sendMessage(
        chatId,
        [
          "🗑 最新の実績を削除しました。",
          "",
          `💰 ${formatYen(row.sale_amount)}`,
          `📦 ${formatNumber(row.delivery_count)}件`,
          `⏱ ${formatHours(row.work_hours)}`,
        ].join("\n")
      );

      return;
    }

    if (data === "reset") {
      const rows = await sql`
        SELECT COUNT(*)::int AS count
        FROM delivery_results
        WHERE telegram_user_id = ${fromUserId}
      `;

      const count = Number(rows[0]?.count || 0);

      if (count === 0) {
        await answerCallbackQuery(
          callbackId,
          "削除できる実績がありません。"
        );

        return;
      }

      await sql`
        DELETE FROM delivery_results
        WHERE telegram_user_id = ${fromUserId}
      `;

      await writeAuditLog({
        telegramUserId: fromUserId,
        chatId,
        action: "reset_callback",
        details: {
          deleted_count: count,
        },
      });

      await answerCallbackQuery(
        callbackId,
        "実績をすべて削除しました。"
      );

      await sendMessage(
        chatId,
        `🗑 自分の実績をすべて削除しました。\n削除件数：${formatNumber(
          count
        )}件`
      );

      return;
    }

    await answerCallbackQuery(callbackId);
  } catch (error) {
    console.error("Callback error:", error);

    await answerCallbackQuery(
      callbackId,
      "処理中にエラーが発生しました。"
    );
  }
}

/* =========================================================
   Main webhook
========================================================= */

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(200).json({
      ok: true,
      message: "Delivery Result Bot is running.",
    });
  }

  try {
    const update = req.body;

    if (update?.callback_query) {
      await handleCallbackQuery(update.callback_query);

      return res.status(200).json({
        ok: true,
      });
    }

    const message = update?.message;

    if (!message) {
      return res.status(200).json({
        ok: true,
      });
    }

    if (message.new_chat_members?.length) {
      await registerNewMembers(message);
    }

    if (isGroupChat(message)) {
      await registerGroupAndMember(message);
    }

    if (!message.text || !message.text.startsWith("/")) {
      return res.status(200).json({
        ok: true,
      });
    }

    const command = getCommandName(message.text);

    switch (command) {
      case "start":
        await handleStart(message);
        break;

      case "help":
        await handleHelp(message);
        break;

      case "add":
        await handleAdd(message);
        break;

      case "cancel":
        await handleCancel(message);
        break;

      case "reset":
        await handleReset(message);
        break;

      case "goal":
        await handleGoal(message);
        break;

      case "group":
        await handleGroup(message);
        break;

      case "lastmonth":
        await handleLastMonth(message);
        break;

      case "month":
        await handleMonth(message);
        break;

      case "admin":
        await handleAdmin(message);
        break;

      default:
        await sendMessage(
          getChatId(message),
          [
            "❓ コマンドが分かりません。",
            "",
            "/help で使えるコマンドを確認できます。",
          ].join("\n")
        );
        break;
    }

    return res.status(200).json({
      ok: true,
    });
  } catch (error) {
    console.error("Webhook error:", error);

    return res.status(200).json({
      ok: false,
      error: "Internal error",
    });
  }
}

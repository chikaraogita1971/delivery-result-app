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
// ============================================================

async function handleAdd(message) {
  const userId =
    getTelegramUserId(message);

  const chatId =
    getChatId(message);

  if (!userId || !chatId) {
    return;
  }

  const args =
    parseAddArguments(
      message?.text || ""
    );

  if (!args.ok) {
    await sendMessage(
      chatId,
      args.error
    );
    return;
  }

  if (isGroupChat(message)) {
    await ensureGroupContext(
      message
    );
  }

  const {
    saleAmount,
    deliveryCount,
    workHours,
  } = args;

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
        ${userId},
        ${saleAmount},
        ${deliveryCount},
        ${workHours},
        ${chatId}
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

  await writeAuditLog({
    telegramUserId: userId,
    chatId,
    action: "add",
    details: {
      result_id:
        String(result.id),
      sale_amount:
        saleAmount,
      delivery_count:
        deliveryCount,
      work_hours:
        workHours,
    },
  });

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

  const text =
    `✅ <b>実績登録しました！</b>\n` +
    `━━━━━━━━━━━━━━\n` +
    `💰 売上：<b>${formatNumber(saleAmount)}円</b>\n` +
    `📦 配達：<b>${formatNumber(deliveryCount)}件</b>\n` +
    `⏱ 稼働：<b>${formatHours(workHours)}時間</b>\n` +
    `💴 件単価：約<b>${formatNumber(unitPrice)}円</b>\n` +
    `⚡ 時給換算：約<b>${formatNumber(hourlySales)}円</b>\n` +
    `━━━━━━━━━━━━━━\n` +
    `🎯 月間目標：${formatNumber(
      await getMonthlyGoal(userId)
    )}件`;

  await sendMessage(
    chatId,
    text
  );
}


// ============================================================
// /cancel
// ============================================================

async function handleCancel(message) {
  const userId =
    getTelegramUserId(message);

  const chatId =
    getChatId(message);

  if (!userId || !chatId) {
    return;
  }

  const rows =
    await sql`
      SELECT
        id,
        sale_amount,
        delivery_count,
        work_hours
      FROM delivery_results
      WHERE telegram_user_id =
        ${userId}
      ORDER BY
        created_at DESC,
        id DESC
      LIMIT 1
    `;

  if (!rows.length) {
    await sendMessage(
      chatId,
      `⚠️ <b>削除する実績がありません。</b>\n\n` +
      `🎯 月間目標：${formatNumber(
        await getMonthlyGoal(userId)
      )}件`
    );

    return;
  }

  const result =
    rows[0];

  await sql`
    DELETE FROM delivery_results
    WHERE id = ${result.id}
      AND telegram_user_id =
        ${userId}
  `;

  await writeAuditLog({
    telegramUserId: userId,
    chatId,
    action: "cancel",
    details: {
      result_id:
        String(result.id),
      sale_amount:
        Number(result.sale_amount),
      delivery_count:
        Number(result.delivery_count),
      work_hours:
        Number(result.work_hours),
    },
  });

  await sendMessage(
    chatId,
    `↩️ <b>最新の実績を削除しました。</b>\n\n` +
    `💰 売上：${formatNumber(
      result.sale_amount
    )}円\n` +
    `📦 配達：${formatNumber(
      result.delivery_count
    )}件\n` +
    `⏱ 稼働：${formatHours(
      result.work_hours
    )}時間`
  );
}


// ============================================================
// /reset
// ============================================================

async function handleReset(message) {
  const userId =
    getTelegramUserId(message);

  const chatId =
    getChatId(message);

  if (!userId || !chatId) {
    return;
  }

  const countRows =
    await sql`
      SELECT COUNT(*)::int AS count
      FROM delivery_results
      WHERE telegram_user_id =
        ${userId}
    `;

  const count =
    Number(
      countRows[0]?.count || 0
    );

  if (count === 0) {
    await sendMessage(
      chatId,
      `⚠️ <b>削除する実績がありません。</b>\n\n` +
      `🎯 月間目標：${formatNumber(
        await getMonthlyGoal(userId)
      )}件は残っています。`
    );

    return;
  }

  await sql`
    DELETE FROM delivery_results
    WHERE telegram_user_id =
      ${userId}
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
    `🗑 <b>実績をすべて削除しました。</b>\n\n` +
    `削除件数：<b>${formatNumber(
      count
    )}件</b>\n\n` +
    `🎯 月間目標：<b>${formatNumber(
      await getMonthlyGoal(userId)
    )}件</b>\n` +
    `※月間目標は残っています。`
  );
}


// ============================================================
// /goal
// ============================================================

async function handleGoal(message) {
  const userId =
    getTelegramUserId(message);

  const chatId =
    getChatId(message);

  if (!userId || !chatId) {
    return;
  }

  const parts =
    String(
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

  const rawGoal =
    String(parts[1])
      .replace(/,/g, "");

  if (!/^\d+$/.test(rawGoal)) {
    await sendMessage(
      chatId,
      `⚠️ 目標件数は整数で指定してください。\n\n` +
      `例：<code>/goal 500</code>`
    );

    return;
  }

  const monthlyGoal =
    Number(rawGoal);

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
      monthly_goal =
        EXCLUDED.monthly_goal,
      updated_at =
        NOW()
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

function getJSTMonthRange(
  offsetMonths = 0
) {
  const now =
    new Date();

  const formatter =
    new Intl.DateTimeFormat(
      "en-CA",
      {
        timeZone: JST,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }
    );

  const parts =
    formatter.formatToParts(now);

  const year =
    Number(
      parts.find(
        (p) =>
          p.type === "year"
      )?.value
    );

  const month =
    Number(
      parts.find(
        (p) =>
          p.type === "month"
      )?.value
    );

  const base =
    new Date(
      Date.UTC(
        year,
        month - 1 + offsetMonths,
        1
      )
    );

  const targetYear =
    base.getUTCFullYear();

  const targetMonth =
    base.getUTCMonth() + 1;

  const start =
    `${targetYear}-${String(
      targetMonth
    ).padStart(2, "0")}-01`;

  const next =
    new Date(
      Date.UTC(
        targetYear,
        targetMonth,
        1
      )
    );

  const end =
    `${next.getUTCFullYear()}-${String(
      next.getUTCMonth() + 1
    ).padStart(2, "0")}-01`;

  return {
    start,
    end,
    year: targetYear,
    month: targetMonth,
  };
}


function parseMonthArgument(text) {
  const parts =
    String(text || "")
      .trim()
      .split(/\s+/);

  if (parts.length < 2) {
    return null;
  }

  const value =
    parts[1];

  if (!/^\d{4}-\d{2}$/.test(value)) {
    return null;
  }

  const [
    year,
    month,
  ] =
    value
      .split("-")
      .map(Number);

  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    month < 1 ||
    month > 12
  ) {
    return null;
  }

  const next =
    new Date(
      Date.UTC(
        year,
        month,
        1
      )
    );

  return {
    year,
    month,

    start:
      `${year}-${String(
        month
      ).padStart(2, "0")}-01`,

    end:
      `${next.getUTCFullYear()}-${String(
        next.getUTCMonth() + 1
      ).padStart(2, "0")}-01`,
  };
}


// ============================================================
// グループ統計
// ============================================================

async function getGroupStats(
  start,
  end,
  chatId
) {
  const rows =
    await sql`
      SELECT
        COUNT(*)::int AS result_count,
        COUNT(
          DISTINCT telegram_user_id
        )::int AS user_count,

        COALESCE(
          SUM(sale_amount),
          0
        )::bigint AS sales,

        COALESCE(
          SUM(delivery_count),
          0
        )::int AS delivery_count,

        COALESCE(
          SUM(work_hours),
          0
        )::numeric AS work_hours

      FROM delivery_results

      WHERE chat_id =
        ${chatId}

      AND created_at >=
        ${start}::date
        AT TIME ZONE ${JST}

      AND created_at <
        ${end}::date
        AT TIME ZONE ${JST}
    `;

  const row =
    rows[0] || {};

  return {
    resultCount:
      Number(row.result_count || 0),

    userCount:
      Number(row.user_count || 0),

    sales:
      Number(row.sales || 0),

    deliveryCount:
      Number(
        row.delivery_count || 0
      ),

    workHours:
      Number(
        row.work_hours || 0
      ),
  };
}


async function getGroupUserRanking(
  start,
  end,
  chatId
) {
  const rows =
    await sql`
      SELECT
        r.telegram_user_id,

        COALESCE(
          NULLIF(
            MAX(gm.first_name),
            ''
          ),
          NULLIF(
            MAX(gm.username),
            ''
          ),
          r.telegram_user_id
        ) AS display_name,

        MAX(gm.username)
          AS username,

        COALESCE(
          SUM(r.delivery_count),
          0
        )::int AS delivery_count,

        COALESCE(
          SUM(r.sale_amount),
          0
        )::bigint AS sales,

        COALESCE(
          SUM(r.work_hours),
          0
        )::numeric AS work_hours

      FROM delivery_results r

      LEFT JOIN group_members gm
        ON gm.telegram_user_id =
          r.telegram_user_id
       AND gm.chat_id =
          ${chatId}

      WHERE r.chat_id =
        ${chatId}

      AND r.created_at >=
        ${start}::date
        AT TIME ZONE ${JST}

      AND r.created_at <
        ${end}::date
        AT TIME ZONE ${JST}

      GROUP BY
        r.telegram_user_id

      ORDER BY
        delivery_count DESC,
        sales DESC,
        telegram_user_id ASC

      LIMIT 100
    `;

  return rows.map(
    (row, index) => {
      const count =
        Number(
          row.delivery_count || 0
        );

      const sales =
        Number(
          row.sales || 0
        );

      const hours =
        Number(
          row.work_hours || 0
        );

      return {
        rank: index + 1,

        telegramUserId:
          String(
            row.telegram_user_id
          ),

        name:
          row.display_name ||
          String(
            row.telegram_user_id
          ),

        username:
          row.username || null,

        deliveryCount: count,
        sales,
        workHours: hours,

        efficiency:
          hours > 0
            ? Math.round(
                (count / hours) * 100
              ) / 100
            : 0,
      };
    }
  );
}


function buildGroupText({
  title,
  year,
  month,
  stats,
  rankings,
}) {
  const monthLabel =
    `${year}/${String(
      month
    ).padStart(2, "0")}`;

  let text =
    `👥 <b>${title}</b>\n` +
    `━━━━━━━━━━━━━━\n` +
    `📅 ${monthLabel}\n\n` +

    `📊 <b>全体</b>\n` +
    `登録実績：${formatNumber(
      stats.resultCount
    )}件\n` +
    `参加人数：${formatNumber(
      stats.userCount
    )}人\n` +
    `💰 売上：<b>${formatNumber(
      stats.sales
    )}円</b>\n` +
    `📦 配達：<b>${formatNumber(
      stats.deliveryCount
    )}件</b>\n` +
    `⏱ 稼働：<b>${formatHours(
      stats.workHours
    )}時間</b>\n`;

  if (stats.deliveryCount > 0) {
    text +=
      `💴 件単価：約${formatNumber(
        Math.round(
          stats.sales /
          stats.deliveryCount
        )
      )}円\n`;
  }

  if (stats.workHours > 0) {
    text +=
      `⚡ 1時間あたり：約${formatNumber(
        Math.round(
          stats.deliveryCount /
          stats.workHours
        )
      )}件\n`;
  }

  text +=
    `\n━━━━━━━━━━━━━━\n` +
    `🏆 <b>配達件数ランキング</b>\n`;

  if (!rankings.length) {
    return (
      text +
      `\nまだ実績がありません。`
    );
  }

  for (
    const row of rankings.slice(0, 10)
  ) {
    const medal =
      row.rank === 1
        ? "🥇"
        : row.rank === 2
          ? "🥈"
          : row.rank === 3
            ? "🥉"
            : `${row.rank}.`;

    text +=
      `${medal} <b>${row.name}</b>\n` +
      `　📦 ${formatNumber(
        row.deliveryCount
      )}件` +
      ` / 💰 ${formatNumber(
        row.sales
      )}円` +
      ` / ⏱ ${formatHours(
        row.workHours
      )}時間\n`;
  }

  return text;
}


// ============================================================
// /group
// ============================================================

async function handleGroup(message) {
  const userId =
    getTelegramUserId(message);

  const chatId =
    getChatId(message);

  if (!userId || !chatId) {
    return;
  }

  if (!isGroupChat(message)) {
    await sendMessage(
      chatId,
      `👥 <b>/group</b> はグループチャットで使用してください。`
    );
    return;
  }

  await ensureGroupContext(
    message
  );

  const range =
    getJSTMonthRange(0);

  const stats =
    await getGroupStats(
      range.start,
      range.end,
      chatId
    );

  const rankings =
    await getGroupUserRanking(
      range.start,
      range.end,
      chatId
    );

  await sendMessage(
    chatId,
    buildGroupText({
      title:
        "グループ月間実績",
      year:
        range.year,
      month:
        range.month,
      stats,
      rankings,
    })
  );

  await writeAuditLog({
    telegramUserId: userId,
    chatId,
    action: "group",
    details: {
      year: range.year,
      month: range.month,
    },
  });
}


// ============================================================
// /lastmonth
// ============================================================

async function handleLastMonth(message) {
  const userId =
    getTelegramUserId(message);

  const chatId =
    getChatId(message);

  if (!userId || !chatId) {
    return;
  }

  if (!isGroupChat(message)) {
    await sendMessage(
      chatId,
      `👥 <b>/lastmonth</b> はグループチャットで使用してください。`
    );
    return;
  }

  await ensureGroupContext(
    message
  );

  const range =
    getJSTMonthRange(-1);

  const stats =
    await getGroupStats(
      range.start,
      range.end,
      chatId
    );

  const rankings =
    await getGroupUserRanking(
      range.start,
      range.end,
      chatId
    );

  await sendMessage(
    chatId,
    buildGroupText({
      title:
        "先月のグループ実績",
      year:
        range.year,
      month:
        range.month,
      stats,
      rankings,
    })
  );

  await writeAuditLog({
    telegramUserId: userId,
    chatId,
    action: "lastmonth",
    details: {
      year: range.year,
      month: range.month,
    },
  });
}


// ============================================================
// /month
// ============================================================

async function handleMonth(message) {
  const userId =
    getTelegramUserId(message);

  const chatId =
    getChatId(message);

  if (!userId || !chatId) {
    return;
  }

  if (!isGroupChat(message)) {
    await sendMessage(
      chatId,
      `👥 <b>/month</b> はグループチャットで使用してください。`
    );
    return;
  }

  const range =
    parseMonthArgument(
      message?.text || ""
    );

  if (!range) {
    await sendMessage(
      chatId,
      `⚠️ 月を正しく指定してください。\n\n` +
      `例：<code>/month 2026-09</code>`
    );
    return;
  }

  await ensureGroupContext(
    message
  );

  const stats =
    await getGroupStats(
      range.start,
      range.end,
      chatId
    );

  const rankings =
    await getGroupUserRanking(
      range.start,
      range.end,
      chatId
    );

  await sendMessage(
    chatId,
    buildGroupText({
      title:
        "指定月のグループ実績",
      year:
        range.year,
      month:
        range.month,
      stats,
      rankings,
    })
  );

  await writeAuditLog({
    telegramUserId: userId,
    chatId,
    action: "month",
    details: {
      year: range.year,
      month: range.month,
    },
  });
}


// ============================================================
// /ranking
// ============================================================

async function handleRanking(message) {
  const userId =
    getTelegramUserId(message);

  const chatId =
    getChatId(message);

  if (!userId || !chatId) {
    return;
  }

  const range =
    getJSTMonthRange(0);

  const rankings =
    await getGroupUserRanking(
      range.start,
      range.end,
      chatId
    );

  let text =
    `🏆 <b>今月ランキング</b>\n` +
    `━━━━━━━━━━━━━━\n`;

  if (!rankings.length) {
    await sendMessage(
      chatId,
      text +
      `\nまだランキングデータがありません。`
    );
    return;
  }

  const myIndex =
    rankings.findIndex(
      (row) =>
        row.telegramUserId ===
        String(userId)
    );

  for (
    const row of rankings.slice(0, 10)
  ) {
    const medal =
      row.rank === 1
        ? "🥇"
        : row.rank === 2
          ? "🥈"
          : row.rank === 3
            ? "🥉"
            : `${row.rank}.`;

    const me =
      row.telegramUserId ===
      String(userId)
        ? " 👈"
        : "";

    text +=
      `${medal} <b>${row.name}</b>${me}\n` +
      `　📦 ${formatNumber(
        row.deliveryCount
      )}件` +
      ` / 💰 ${formatNumber(
        row.sales
      )}円` +
      ` / ⚡ ${row.efficiency}件/h\n`;
  }

  if (myIndex >= 10) {
    const me =
      rankings[myIndex];

    text +=
      `\n━━━━━━━━━━━━━━\n` +
      `👤 <b>あなた</b>\n` +
      `順位：${myIndex + 1}位\n` +
      `📦 ${formatNumber(
        me.deliveryCount
      )}件\n` +
      `💰 ${formatNumber(
        me.sales
      )}円\n` +
      `⚡ ${me.efficiency}件/h`;
  }

  await sendMessage(
    chatId,
    text
  );

  await writeAuditLog({
    telegramUserId: userId,
    chatId,
    action: "ranking",
    details: {
      year: range.year,
      month: range.month,
    },
  });
}


// ============================================================
// Admin
// ============================================================

async function getAdminStatistics() {
  const overallRows =
    await sql`
      SELECT
        COUNT(*)::int AS result_count,
        COUNT(
          DISTINCT telegram_user_id
        )::int AS user_count,

        COALESCE(
          SUM(sale_amount),
          0
        )::bigint AS sales,

        COALESCE(
          SUM(delivery_count),
          0
        )::int AS delivery_count,

        COALESCE(
          SUM(work_hours),
          0
        )::numeric AS work_hours

      FROM delivery_results
    `;

  const monthRows =
    await sql`
      SELECT
        COUNT(*)::int AS result_count,
        COUNT(
          DISTINCT telegram_user_id
        )::int AS user_count,

        COALESCE(
          SUM(sale_amount),
          0
        )::bigint AS sales,

        COALESCE(
          SUM(delivery_count),
          0
        )::int AS delivery_count,

        COALESCE(
          SUM(work_hours),
          0
        )::numeric AS work_hours

      FROM delivery_results

      WHERE created_at >=
        date_trunc(
          'month',
          NOW() AT TIME ZONE ${JST}
        ) AT TIME ZONE ${JST}

      AND created_at <
        (
          date_trunc(
            'month',
            NOW() AT TIME ZONE ${JST}
          )
          + INTERVAL '1 month'
        ) AT TIME ZONE ${JST}
    `;

  const groupsRows =
    await sql`
      SELECT COUNT(*)::int AS count
      FROM telegram_groups
    `;

  const logs =
    await sql`
      SELECT
        telegram_user_id,
        chat_id,
        action,
        details,
        created_at
      FROM audit_logs
      ORDER BY created_at DESC
      LIMIT 10
    `;

  const lastRows =
    await sql`
      SELECT created_at
      FROM delivery_results
      ORDER BY created_at DESC
      LIMIT 1
    `;

  const overall =
    overallRows[0] || {};

  const month =
    monthRows[0] || {};

  return {
    overall: {
      resultCount:
        Number(
          overall.result_count || 0
        ),
      userCount:
        Number(
          overall.user_count || 0
        ),
      sales:
        Number(
          overall.sales || 0
        ),
      deliveryCount:
        Number(
          overall.delivery_count || 0
        ),
      workHours:
        Number(
          overall.work_hours || 0
        ),
    },

    month: {
      resultCount:
        Number(
          month.result_count || 0
        ),
      userCount:
        Number(
          month.user_count || 0
        ),
      sales:
        Number(
          month.sales || 0
        ),
      deliveryCount:
        Number(
          month.delivery_count || 0
        ),
      workHours:
        Number(
          month.work_hours || 0
        ),
    },

    groupCount:
      Number(
        groupsRows[0]?.count || 0
      ),

    logs,

    lastCreatedAt:
      lastRows.length
        ? lastRows[0].created_at
        : null,
  };
}


async function handleAdmin(message) {
  const userId =
    getTelegramUserId(message);

  const chatId =
    getChatId(message);

  if (!userId || !chatId) {
    return;
  }

  if (!isAdmin(userId)) {
    await writeAuditLog({
      telegramUserId: userId,
      chatId,
      action:
        "admin_denied",
      details: {
        reason:
          "not_admin",
      },
    });

    await sendMessage(
      chatId,
      `⛔ <b>管理者権限がありません。</b>`
    );

    return;
  }

  const stats =
    await getAdminStatistics();

  const avgPrice =
    stats.month.deliveryCount > 0
      ? Math.round(
          stats.month.sales /
          stats.month.deliveryCount
        )
      : 0;

  const avgHours =
    stats.month.userCount > 0
      ? Math.round(
          (
            stats.month.workHours /
            stats.month.userCount
          ) * 100
        ) / 100
      : 0;

  let text =
    `🔐 <b>管理者統計</b>\n` +
    `━━━━━━━━━━━━━━\n` +

    `📊 <b>全体</b>\n` +
    `登録実績：${formatNumber(
      stats.overall.resultCount
    )}件\n` +
    `ユーザー：${formatNumber(
      stats.overall.userCount
    )}人\n` +
    `売上：${formatNumber(
      stats.overall.sales
    )}円\n` +
    `配達：${formatNumber(
      stats.overall.deliveryCount
    )}件\n` +
    `稼働：${formatHours(
      stats.overall.workHours
    )}時間\n\n` +

    `📅 <b>今月（JST）</b>\n` +
    `実績登録：${formatNumber(
      stats.month.resultCount
    )}件\n` +
    `アクティブ：${formatNumber(
      stats.month.userCount
    )}人\n` +
    `売上：${formatNumber(
      stats.month.sales
    )}円\n` +
    `配達：${formatNumber(
      stats.month.deliveryCount
    )}件\n` +
    `稼働：${formatHours(
      stats.month.workHours
    )}時間\n` +
    `平均単価：${formatNumber(
      avgPrice
    )}円/件\n` +
    `平均稼働：${formatHours(
      avgHours
    )}時間/人\n\n` +

    `👥 <b>グループ</b>\n` +
    `登録グループ：${formatNumber(
      stats.groupCount
    )}\n\n` +

    `📝 <b>最新ログ</b>\n`;

  for (
    const log of stats.logs
  ) {
    text +=
      `${formatDateJST(
        log.created_at
      )} / ${log.action} / ${log.telegram_user_id}\n`;
  }

  if (stats.lastCreatedAt) {
    text +=
      `\n🕐 最終登録：${formatDateJST(
        stats.lastCreatedAt
      )}`;
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
                  url:
                    miniAppUrl,
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
// Webhook
// ============================================================

async function handler(req, res) {
  // GET確認
  if (req.method !== "POST") {
    return res.status(200).json({
      ok: true,
      message:
        "Bot webhook is running.",
    });
  }

  try {
    if (!BOT_TOKEN) {
      console.error(
        "BOT_TOKEN is not configured."
      );

      return res.status(500).json({
        ok: false,
        error:
          "BOT_TOKEN is not configured.",
      });
    }

    const update =
      typeof req.body === "string"
        ? JSON.parse(req.body)
        : req.body;

    if (
      !update ||
      typeof update !== "object"
    ) {
      return res.status(200).json({
        ok: true,
      });
    }

    const message =
      update.message ||
      update.edited_message ||
      update.channel_post ||
      null;

    if (!message) {
      return res.status(200).json({
        ok: true,
        ignored: true,
      });
    }

    // グループ情報は同期するが、
    // 失敗してもBot本体を止めない
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

    if (
      typeof message.text ===
        "string" &&
      message.text
        .trim()
        .startsWith("/")
    ) {
      await handleCommand(
        message
      );
    }

    return res.status(200).json({
      ok: true,
    });

  } catch (error) {
    console.error(
      "bot handler error:",
      error
    );

    // Telegramへの再送ループを防ぐ
    return res.status(200).json({
      ok: false,
      error:
        "Internal bot error.",
    });
  }
}


module.exports = handler;

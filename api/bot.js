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

    `📱 <b>個人ダッシュボード</b>\n` +
    `今日・今週・今月・年間の実績、` +
    `分析、目標進捗を確認できます。\n\n` +

    `💡 <code>/help</code> でコマンドを確認できます。`;

  await sendMessage(
    chatId,
    text
  );

  await sendMiniAppButton(
    chatId
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
    `<code>/add 20000 30 8</code>\n` +
    `売上・配達件数・稼働時間を登録\n\n` +

    `↩️ <b>最新実績を削除</b>\n` +
    `<code>/cancel</code>\n\n` +

    `🗑 <b>自分の実績を全削除</b>\n` +
    `<code>/reset</code>\n\n` +

    `🎯 <b>月間目標</b>\n` +
    `<code>/goal 500</code>\n` +
    `引数なしで現在の目標を確認\n\n` +

    `📱 <b>個人ダッシュボード</b>\n` +
    `今日・今週・今月・年間の実績、` +
    `分析・目標進捗・実績履歴を確認できます。`;

  await sendMessage(
    chatId,
    text
  );

  await sendMiniAppButton(
    chatId
  );
}
// ============================================================
// /add
// 個人実績登録
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
        ${String(userId)},
        ${saleAmount},
        ${deliveryCount},
        ${workHours},
        ${String(chatId)}
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

  const monthlyGoal =
    await getMonthlyGoal(
      userId
    );

  const text =
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
      monthlyGoal
    )}件`;

  await sendMessage(
    chatId,
    text
  );
}


// ============================================================
// /cancel
// 最新の自分の実績を削除
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
// 自分の実績をすべて削除
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
// 月間目標
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

  // 引数なし → 現在の目標を表示
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
// 管理者用：個人実績の全体統計
// ※ グループ・ランキングは完全に廃止
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
        )::bigint AS delivery_count,
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
        )::bigint AS delivery_count,
        COALESCE(
          SUM(work_hours),
          0
        )::numeric AS work_hours
      FROM delivery_results
      WHERE (
        created_at AT TIME ZONE ${JST}
      ) >= (
        date_trunc(
          'month',
          NOW() AT TIME ZONE ${JST}
        )
      )
      AND (
        created_at AT TIME ZONE ${JST}
      ) < (
        date_trunc(
          'month',
          NOW() AT TIME ZONE ${JST}
        ) +
        INTERVAL '1 month'
      )
    `;

  const logRows =
    await sql`
      SELECT
        id,
        telegram_user_id,
        chat_id,
        action,
        details,
        created_at
      FROM audit_logs
      ORDER BY
        created_at DESC
      LIMIT 20
    `;

  const lastRows =
    await sql`
      SELECT
        created_at
      FROM delivery_results
      ORDER BY
        created_at DESC
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

    logs:
      logRows.map((row) => ({
        id:
          String(row.id),

        telegramUserId:
          String(row.telegram_user_id),

        chatId:
          row.chat_id
            ? String(row.chat_id)
            : null,

        action:
          row.action,

        details:
          row.details,

        createdAt:
          row.created_at,
      })),

    lastCreatedAt:
      lastRows[0]?.created_at || null,
  };
}


// ============================================================
// /admin
// 管理者専用
// ============================================================

async function handleAdmin(message) {
  const userId =
    getTelegramUserId(message);

  const chatId =
    getChatId(message);

  if (!userId || !chatId) {
    return;
  }

  if (!isAdmin(userId)) {
    await sendMessage(
      chatId,
      `⛔ このコマンドは管理者専用です。`
    );

    return;
  }

  const stats =
    await getAdminStatistics();

  const overall =
    stats.overall;

  const month =
    stats.month;

  const overallHourly =
    overall.workHours > 0
      ? Math.round(
          overall.sales /
          overall.workHours
        )
      : 0;

  const monthHourly =
    month.workHours > 0
      ? Math.round(
          month.sales /
          month.workHours
        )
      : 0;

  const text =
    `🔐 <b>管理者ダッシュボード</b>\n` +
    `━━━━━━━━━━━━━━\n` +
    `📊 <b>全体</b>\n` +
    `登録実績：${formatNumber(
      overall.resultCount
    )}件\n` +
    `ユーザー：${formatNumber(
      overall.userCount
    )}人\n` +
    `売上：${formatNumber(
      overall.sales
    )}円\n` +
    `配達：${formatNumber(
      overall.deliveryCount
    )}件\n` +
    `稼働：${formatHours(
      overall.workHours
    )}時間\n` +
    `時給換算：約${formatNumber(
      overallHourly
    )}円\n\n` +
    `📅 <b>今月</b>\n` +
    `実績登録：${formatNumber(
      month.resultCount
    )}件\n` +
    `アクティブ：${formatNumber(
      month.userCount
    )}人\n` +
    `売上：${formatNumber(
      month.sales
    )}円\n` +
    `配達：${formatNumber(
      month.deliveryCount
    )}件\n` +
    `稼働：${formatHours(
      month.workHours
    )}時間\n` +
    `時給換算：約${formatNumber(
      monthHourly
    )}円`;

  await writeAuditLog({
    telegramUserId: userId,
    chatId,
    action: "admin_view",
    details: {
      overall,
      month,
    },
  });

  await sendMessage(
    chatId,
    text
  );
}


// ============================================================
// Mini App ボタン
// ============================================================

async function sendMiniAppButton(chatId) {
  const webAppUrl =
    process.env.MINI_APP_URL ||
    process.env.WEB_APP_URL;

  if (!webAppUrl) {
    await sendMessage(
      chatId,
      `⚠️ Mini AppのURLが設定されていません。`
    );

    return;
  }

  await telegramApi(
    "sendMessage",
    {
      chat_id:
        chatId,

      text:
        `📱 <b>個人ダッシュボード</b>\n\n` +
        `今日・今週・今月・年間の実績、\n` +
        `目標進捗、分析、実績履歴を確認できます。`,

      parse_mode:
        "HTML",

      reply_markup: {
        inline_keyboard: [
          [
            {
              text:
                "📊 個人ダッシュボードを開く",

              web_app: {
                url:
                  webAppUrl,
              },
            },
          ],
        ],
      },
    }
  );
}
/// ============================================================
// コマンドルーター
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
  if (req.method !== "POST") {
    res.status(200).json({
      ok: true,
    });

    return;
  }

  try {
    const update =
      req.body || {};

    const message =
      update.message ||
      update.edited_message;

    if (!message) {
      res.status(200).json({
        ok: true,
      });

      return;
    }

    // コマンド以外は無視
    const text =
      String(
        message.text || ""
      ).trim();

    if (!text.startsWith("/")) {
      res.status(200).json({
        ok: true,
      });

      return;
    }

    await handleCommand(
      message
    );

    res.status(200).json({
      ok: true,
    });
  } catch (error) {
    console.error(
      "Webhook error:",
      error
    );

    res.status(200).json({
      ok: true,
    });
  }
}


// ============================================================
// export
// ============================================================

module.exports = handler;

const { neon } = require("@neondatabase/serverless");

const sql = neon(process.env.DATABASE_URL);

const BOT_TOKEN = process.env.BOT_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

async function telegramApi(method, payload = {}) {
  const response = await fetch(
    `${TELEGRAM_API}/${method}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    }
  );

  const data = await response.json();

  if (!data.ok) {
    throw new Error(
      data.description || "Telegram API error"
    );
  }

  return data.result;
}

async function sendMessage(
  chatId,
  text,
  extra = {}
) {
  return telegramApi("sendMessage", {
    chat_id: chatId,
    text,
    ...extra,
  });
}

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

function getDisplayName(message) {
  const firstName =
    message?.from?.first_name || "";

  const lastName =
    message?.from?.last_name || "";

  const username =
    message?.from?.username || "";

  const name =
    `${firstName} ${lastName}`.trim();

  if (name) {
    return username
      ? `${name} (@${username})`
      : name;
  }

  if (username) {
    return `@${username}`;
  }

  return "配達員";
}

function getCommandName(text) {
  if (!text) {
    return "";
  }

  return (
    text
      .trim()
      .split(/\s+/)[0]
      .split("@")[0]
      .toLowerCase()
  );
}

function formatNumber(value) {
  return Number(value || 0).toLocaleString(
    "ja-JP"
  );
}

function formatHours(value) {
  return Number(value || 0).toFixed(1);
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

  return hours;
}

// =========================================================
// 管理者
// =========================================================

function getAdminIds() {
  return String(
    process.env.ADMIN_TELEGRAM_USER_IDS || ""
  )
    .split(",")
    .map(id => id.trim())
    .filter(Boolean);
}

function isAdmin(userId) {
  return getAdminIds().includes(
    String(userId)
  );
}

// =========================================================
// 監査ログ
// =========================================================

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
        ${String(telegramUserId)},
        ${chatId ? String(chatId) : null},
        ${action},
        ${JSON.stringify(details)}
      )
    `;
  } catch (error) {
    console.error(
      "audit log error:",
      error
    );
  }
}

// =========================================================
// /add
// =========================================================

function parseAddArguments(text) {
  const parts =
    String(text || "")
      .trim()
      .split(/\s+/);

  if (parts.length !== 4) {
    return null;
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
    return null;
  }

  if (
    !Number.isInteger(deliveryCount) ||
    deliveryCount <= 0 ||
    deliveryCount > 10000
  ) {
    return null;
  }

  if (workHours === null) {
    return null;
  }

  return {
    saleAmount: Math.round(
      saleAmount
    ),
    deliveryCount,
    workHours,
  };
}

// =========================================================
// /start
// =========================================================

async function handleStart(
  message
) {
  const userId =
    getTelegramUserId(message);

  const chatId =
    getChatId(message);

  await writeAuditLog({
    telegramUserId: userId,
    chatId,
    action: "start",
  });

  const text = [
    `こんにちは、${getDisplayName(message)}さん！`,
    "",
    "配達実績を記録できます。",
    "",
    "【記録】",
    "/add 売上 配達件数 稼働時間",
    "",
    "例：",
    "/add 5000 5 2",
    "",
    "【その他】",
    "/cancel 直前の実績を削除",
    "/reset 自分の実績を全削除",
    "/help ヘルプ",
    "",
    "下のボタンから個人ダッシュボードを開けます。",
  ].join("\n");

  return sendMessage(
    chatId,
    text,
    {
      reply_markup: {
        inline_keyboard: [
          [
            {
              text:
                "📊 個人ダッシュボードを開く",
              web_app: {
                url:
                  process.env.MINI_APP_URL ||
                  process.env.WEB_APP_URL,
              },
            },
          ],
        ],
      },
    }
  );
}

// =========================================================
// /help
// =========================================================

async function handleHelp(
  message
) {
  const chatId =
    getChatId(message);

  const text = [
    "📖 使い方",
    "",
    "実績を登録：",
    "/add 5000 5 2",
    "",
    "意味：",
    "5000円の売上・5件配達・2時間稼働",
    "",
    "直前の実績を削除：",
    "/cancel",
    "",
    "自分の実績を全削除：",
    "/reset",
    "",
    "個人ダッシュボード：",
    "📊 ボタンから開いてください。",
  ].join("\n");

  return sendMessage(
    chatId,
    text
  );
}

// =========================================================
// /add
// =========================================================

async function handleAdd(
  message
) {
  const userId =
    getTelegramUserId(message);

  const chatId =
    getChatId(message);

  const parsed =
    parseAddArguments(
      message.text
    );

  if (!parsed) {
    return sendMessage(
      chatId,
      [
        "❌ 入力形式が正しくありません。",
        "",
        "正しい形式：",
        "/add 売上 配達件数 稼働時間",
        "",
        "例：",
        "/add 5000 5 2",
      ].join("\n")
    );
  }

  const {
    saleAmount,
    deliveryCount,
    workHours,
  } = parsed;

  const rows = await sql`
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

  const row = rows[0];

  await writeAuditLog({
    telegramUserId: userId,
    chatId,
    action: "add",
    details: {
      resultId: Number(row.id),
      saleAmount,
      deliveryCount,
      workHours,
    },
  });

  const unitPrice =
    deliveryCount > 0
      ? saleAmount / deliveryCount
      : 0;

  const hourlySales =
    workHours > 0
      ? saleAmount / workHours
      : 0;

  const text = [
    "✅ 実績を登録しました！",
    "",
    `売上：¥${formatNumber(saleAmount)}`,
    `配達：${formatNumber(deliveryCount)}件`,
    `稼働：${formatHours(workHours)}時間`,
    "",
    `平均単価：¥${formatNumber(
      Math.round(unitPrice)
    )}`,
    `時給換算：¥${formatNumber(
      Math.round(hourlySales)
    )}/h`,
  ].join("\n");

  return sendMessage(
    chatId,
    text
  );
}

// =========================================================
// /cancel
// =========================================================

async function handleCancel(
  message
) {
  const userId =
    getTelegramUserId(message);

  const chatId =
    getChatId(message);

  const rows = await sql`
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

  if (rows.length === 0) {
    return sendMessage(
      chatId,
      "削除できる実績がありません。"
    );
  }

  const row = rows[0];

  await sql`
    DELETE FROM delivery_results
    WHERE id = ${row.id}
      AND telegram_user_id = ${userId}
  `;

  await writeAuditLog({
    telegramUserId: userId,
    chatId,
    action: "cancel",
    details: {
      resultId: Number(row.id),
      saleAmount: Number(
        row.sale_amount
      ),
      deliveryCount: Number(
        row.delivery_count
      ),
      workHours: Number(
        row.work_hours
      ),
    },
  });

  return sendMessage(
    chatId,
    [
      "↩️ 直前の実績を削除しました。",
      "",
      `売上：¥${formatNumber(
        row.sale_amount
      )}`,
      `配達：${formatNumber(
        row.delivery_count
      )}件`,
      `稼働：${formatHours(
        row.work_hours
      )}時間`,
    ].join("\n")
  );
}

// =========================================================
// /reset
// =========================================================

async function handleReset(
  message
) {
  const userId =
    getTelegramUserId(message);

  const chatId =
    getChatId(message);

  const rows = await sql`
    DELETE FROM delivery_results
    WHERE telegram_user_id =
      ${userId}
    RETURNING id
  `;

  const deletedCount =
    rows.length;

  await writeAuditLog({
    telegramUserId: userId,
    chatId,
    action: "reset",
    details: {
      deletedCount,
    },
  });

  return sendMessage(
    chatId,
    deletedCount > 0
      ? `🗑 ${deletedCount}件の実績を削除しました。`
      : "削除する実績はありませんでした。"
  );
}

// =========================================================
// /admin
// =========================================================

async function getAdminStatistics() {
  const overallRows = await sql`
    SELECT
      COUNT(*) AS records,
      COUNT(
        DISTINCT telegram_user_id
      ) AS users,
      COALESCE(
        SUM(sale_amount),
        0
      ) AS sales,
      COALESCE(
        SUM(delivery_count),
        0
      ) AS delivery_count,
      COALESCE(
        SUM(work_hours),
        0
      ) AS work_hours
    FROM delivery_results
  `;

  const monthRows = await sql`
    SELECT
      COUNT(*) AS records,
      COUNT(
        DISTINCT telegram_user_id
      ) AS users,
      COALESCE(
        SUM(sale_amount),
        0
      ) AS sales,
      COALESCE(
        SUM(delivery_count),
        0
      ) AS delivery_count,
      COALESCE(
        SUM(work_hours),
        0
      ) AS work_hours
    FROM delivery_results
    WHERE created_at >= (
      date_trunc(
        'month',
        CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Tokyo'
      ) AT TIME ZONE 'Asia/Tokyo'
    )
  `;

  const latestRows = await sql`
    SELECT
      action,
      telegram_user_id,
      chat_id,
      created_at
    FROM audit_logs
    ORDER BY created_at DESC
    LIMIT 20
  `;

  return {
    overall: overallRows[0],
    month: monthRows[0],
    latestLogs: latestRows,
  };
}

async function handleAdmin(
  message
) {
  const userId =
    getTelegramUserId(message);

  const chatId =
    getChatId(message);

  if (!isAdmin(userId)) {
    await writeAuditLog({
      telegramUserId: userId,
      chatId,
      action: "admin_denied",
    });

    return sendMessage(
      chatId,
      "⛔ 管理者権限がありません。"
    );
  }

  const stats =
    await getAdminStatistics();

  await writeAuditLog({
    telegramUserId: userId,
    chatId,
    action: "admin_view",
  });

  const overall =
    stats.overall || {};

  const month =
    stats.month || {};

  const text = [
    "🛠 管理者ダッシュボード",
    "",
    "【全期間】",
    `記録：${formatNumber(
      overall.records
    )}件`,
    `ユーザー：${formatNumber(
      overall.users
    )}人`,
    `売上：¥${formatNumber(
      overall.sales
    )}`,
    `配達：${formatNumber(
      overall.delivery_count
    )}件`,
    `稼働：${formatHours(
      overall.work_hours
    )}時間`,
    "",
    "【今月】",
    `記録：${formatNumber(
      month.records
    )}件`,
    `ユーザー：${formatNumber(
      month.users
    )}人`,
    `売上：¥${formatNumber(
      month.sales
    )}`,
    `配達：${formatNumber(
      month.delivery_count
    )}件`,
    `稼働：${formatHours(
      month.work_hours
    )}時間`,
  ].join("\n");

  return sendMessage(
    chatId,
    text
  );
}

// =========================================================
// コマンド処理
// =========================================================

async function handleCommand(
  message
) {
  const command =
    getCommandName(
      message.text
    );

  switch (command) {
    case "/start":
      return handleStart(message);

    case "/help":
      return handleHelp(message);

    case "/add":
      return handleAdd(message);

    case "/cancel":
      return handleCancel(message);

    case "/reset":
      return handleReset(message);

    case "/admin":
      return handleAdmin(message);

    default:
      return null;
  }
}

// =========================================================
// Webhook
// =========================================================

module.exports = async function handler(
  req,
  res
) {
  if (req.method !== "POST") {
    return res.status(405).json({
      ok: false,
      error: "Method Not Allowed",
    });
  }

  try {
    const update =
      req.body || {};

    const message =
      update.message;

    if (!message) {
      return res.status(200).json({
        ok: true,
        ignored: true,
      });
    }

    if (
      typeof message.text !== "string"
    ) {
      return res.status(200).json({
        ok: true,
        ignored: true,
      });
    }

    if (
      !message.text.trim().startsWith("/")
    ) {
      return res.status(200).json({
        ok: true,
        ignored: true,
      });
    }

    await handleCommand(
      message
    );

    return res.status(200).json({
      ok: true,
    });
  } catch (error) {
    console.error(
      "bot webhook error:",
      error
    );

    return res.status(200).json({
      ok: false,
      error:
        error?.message ||
        "Bot処理に失敗しました。",
    });
  }
};

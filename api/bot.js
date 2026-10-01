const { neon } = require("@neondatabase/serverless");
const crypto = require("crypto");

const sql = neon(process.env.DATABASE_URL);

const BOT_TOKEN = process.env.BOT_TOKEN;
const JST = "Asia/Tokyo";


// =========================================================
// Telegram API
// =========================================================

const TELEGRAM_API =
  `https://api.telegram.org/bot${BOT_TOKEN}`;


async function telegramApi(
  method,
  body = {}
) {
  const response =
    await fetch(
      `${TELEGRAM_API}/${method}`,
      {
        method: "POST",

        headers: {
          "Content-Type":
            "application/json"
        },

        body:
          JSON.stringify(body)
      }
    );

  const data =
    await response.json();

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
        options.parseMode ||
        "HTML",

      disable_web_page_preview:
        true,

      ...(options.replyMarkup
        ? {
            reply_markup:
              options.replyMarkup
          }
        : {})
    }
  );
}


// =========================================================
// 共通ヘルパー
// =========================================================

function getTelegramUserId(
  message
) {
  return String(
    message?.from?.id || ""
  );
}


function getChatId(
  message
) {
  return String(
    message?.chat?.id || ""
  );
}


function isGroupChat(
  message
) {
  const type =
    message?.chat?.type;

  return (
    type === "group" ||
    type === "supergroup"
  );
}


function getDisplayName(
  user
) {
  if (!user) {
    return "ユーザー";
  }

  const fullName =
    [
      user.first_name,
      user.last_name
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


function getCommandName(
  message
) {
  const text =
    String(
      message?.text || ""
    ).trim();

  if (!text.startsWith("/")) {
    return "";
  }

  const first =
    text.split(/\s+/)[0];

  return first
    .split("@")[0]
    .toLowerCase();
}


function formatNumber(
  value
) {
  return Number(
    value || 0
  ).toLocaleString("ja-JP");
}


function formatHours(
  value
) {
  const hours =
    Number(value || 0);

  return hours
    .toFixed(2)
    .replace(/\.00$/, "")
    .replace(
      /(\.\d)0$/,
      "$1"
    );
}


function formatDateJST(
  value
) {
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
      minute: "2-digit"
    }
  ).format(
    new Date(value)
  );
}


function formatDateOnlyJST(
  value
) {
  if (!value) {
    return "-";
  }

  return new Intl.DateTimeFormat(
    "ja-JP",
    {
      timeZone: JST,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }
  ).format(
    new Date(value)
  );
}


function parseWorkHours(
  value
) {
  const hours =
    Number(value);

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


// =========================================================
// 管理者
// =========================================================

function getAdminIds() {
  return String(
    process.env
      .ADMIN_TELEGRAM_USER_IDS ||
      ""
  )
    .split(",")
    .map(
      id => id.trim()
    )
    .filter(Boolean);
}


function isAdmin(
  userId
) {
  return getAdminIds()
    .includes(
      String(userId)
    );
}


// =========================================================
// Audit Log
// =========================================================

async function writeAuditLog({
  telegramUserId,
  chatId = null,
  action,
  details = null
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
        ${String(
          telegramUserId
        )},

        ${chatId
          ? String(chatId)
          : null},

        ${action},

        ${
          details
            ? JSON.stringify(
                details
              )
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


// =========================================================
// グループ登録
// =========================================================

async function ensureGroupRegistered(
  message
) {
  if (!isGroupChat(message)) {
    return;
  }

  const chatId =
    getChatId(message);

  const title =
    message?.chat?.title ||
    "";

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

    ON CONFLICT (
      chat_id
    )

    DO UPDATE SET
      title =
        EXCLUDED.title,

      updated_at =
        NOW()
  `;
}


// =========================================================
// グループメンバー登録
// =========================================================

async function ensureGroupMember(
  message
) {
  if (!isGroupChat(message)) {
    return;
  }

  const user =
    message?.from;

  if (!user?.id) {
    return;
  }

  // Botは登録しない
  if (user.is_bot) {
    return;
  }

  // Telegram匿名管理者
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

      ${
        user.username ||
        null
      },

      ${
        user.first_name ||
        null
      },

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


// =========================================================
// グループコンテキスト
// =========================================================

async function ensureGroupContext(
  message
) {
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


// =========================================================
// 数値引数
// =========================================================

function parseAddArguments(
  message
) {
  const text =
    String(
      message?.text || ""
    ).trim();

  const parts =
    text.split(/\s+/);

  // /add 売上 件数 稼働時間
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
    !Number.isFinite(
      saleAmount
    ) ||
    saleAmount < 0 ||
    saleAmount > 100000000
  ) {
    return null;
  }

  if (
    !Number.isInteger(
      deliveryCount
    ) ||
    deliveryCount <= 0 ||
    deliveryCount > 10000
  ) {
    return null;
  }

  if (workHours === null) {
    return null;
  }

  return {
    saleAmount:
      Math.floor(
        saleAmount
      ),

    deliveryCount,

    workHours
  };
}


// =========================================================
// XP / LEVEL
// =========================================================

function calculateLevel(
  xp
) {
  let level = 1;

  let required = 100;

  let totalRequired = 0;

  while (
    xp >=
    totalRequired +
      required
  ) {
    totalRequired +=
      required;

    level += 1;

    required =
      100 +
      (level - 2) * 50;

    if (level >= 1000) {
      break;
    }
  }

  const currentLevelXP =
    totalRequired;

  const nextLevelXP =
    totalRequired +
    required;

  const requiredXP =
    Math.max(
      1,
      nextLevelXP -
        currentLevelXP
    );

  const progressXP =
    Math.max(
      0,
      xp -
        currentLevelXP
    );

  const progressRate =
    Math.min(
      100,
      (
        progressXP /
        requiredXP
      ) * 100
    );

  return {
    level,

    currentLevelXP,

    nextLevelXP,

    progressXP,

    requiredXP,

    progressRate
  };
}


// =========================================================
// ユーザープロフィール
// =========================================================

async function ensureProfile(
  user
) {
  const userId =
    String(user.id);

  const displayName =
    getDisplayName(user);

  const rows =
    await sql`
      INSERT INTO user_profiles (
        telegram_user_id,
        display_name,
        updated_at
      )

      VALUES (
        ${userId},
        ${displayName},
        NOW()
      )

      ON CONFLICT (
        telegram_user_id
      )

      DO UPDATE SET
        display_name =
          EXCLUDED.display_name,

        updated_at =
          NOW()

      RETURNING *
    `;

  return rows[0];
}


// =========================================================
// XP追加
// =========================================================

async function addXP({
  userId,
  xp,
  reason,
  referenceId = null
}) {
  if (
    !xp ||
    xp <= 0
  ) {
    return {
      added: 0,
      duplicate: false
    };
  }

  // 同じイベントへの二重付与防止
  if (referenceId) {
    const existing =
      await sql`
        SELECT id

        FROM xp_logs

        WHERE
          telegram_user_id =
            ${userId}

        AND reference_id =
            ${String(
              referenceId
            )}

        LIMIT 1
      `;

    if (existing.length) {
      return {
        added: 0,
        duplicate: true
      };
    }
  }

  await sql`
    INSERT INTO xp_logs (
      telegram_user_id,
      xp,
      reason,
      reference_id
    )

    VALUES (
      ${userId},
      ${xp},
      ${reason},
      ${
        referenceId
          ? String(
              referenceId
            )
          : null
      }
    )
  `;

  await sql`
    UPDATE user_profiles

    SET
      xp =
        xp + ${xp},

      updated_at =
        NOW()

    WHERE
      telegram_user_id =
        ${userId}
  `;

  return {
    added: xp,
    duplicate: false
  };
}


// =========================================================
// 累計実績
// =========================================================

async function getLifetimeStats(
  userId
) {
  const rows =
    await sql`
      SELECT
        COALESCE(
          SUM(sale_amount),
          0
        ) AS sales,

        COALESCE(
          SUM(delivery_count),
          0
        ) AS count,

        COALESCE(
          SUM(work_hours),
          0
        ) AS hours,

        COUNT(*) AS records

      FROM delivery_results

      WHERE
        telegram_user_id =
          ${userId}
    `;

  const row =
    rows[0] || {};

  return {
    sales:
      Number(
        row.sales || 0
      ),

    count:
      Number(
        row.count || 0
      ),

    hours:
      Number(
        row.hours || 0
      ),

    records:
      Number(
        row.records || 0
      )
  };
}


// =========================================================
// 活動日取得
// =========================================================

async function getActivityDates(
  userId
) {
  const rows =
    await sql`
      SELECT DISTINCT
        (
          created_at
          AT TIME ZONE ${JST}
        )::date AS activity_date

      FROM delivery_results

      WHERE
        telegram_user_id =
          ${userId}

      ORDER BY
        activity_date DESC
    `;

  return rows.map(
    row =>
      String(
        row.activity_date
      )
  );
}


// =========================================================
// 日付をJST基準の数値へ
// =========================================================

function dateToNumber(
  dateString
) {
  const date =
    new Date(
      `${dateString}T00:00:00+09:00`
    );

  return Math.floor(
    date.getTime() /
    86400000
  );
}


// =========================================================
// JST今日
// =========================================================

function getTodayJST() {
  return new Intl.DateTimeFormat(
    "en-CA",
    {
      timeZone: JST,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }
  ).format(
    new Date()
  );
}


// =========================================================
// 連続日数
// =========================================================

function calculateStreak(
  dates
) {
  if (!dates.length) {
    return {
      current: 0,
      best: 0
    };
  }

  const unique =
    [
      ...new Set(
        dates.map(
          dateToNumber
        )
      )
    ].sort(
      (a, b) => b - a
    );

  let best = 1;
  let run = 1;

  for (
    let i = 1;
    i < unique.length;
    i++
  ) {
    if (
      unique[i - 1] -
        unique[i] ===
      1
    ) {
      run += 1;

      best =
        Math.max(
          best,
          run
        );
    } else {
      run = 1;
    }
  }

  const today =
    dateToNumber(
      getTodayJST()
    );

  let current = 0;

  if (
    unique[0] === today ||
    unique[0] === today - 1
  ) {
    current = 1;

    for (
      let i = 1;
      i < unique.length;
      i++
    ) {
      if (
        unique[i - 1] -
          unique[i] ===
        1
      ) {
        current += 1;
      } else {
        break;
      }
    }
  }

  return {
    current,
    best
  };
}


// =========================================================
// バッジ付与
// =========================================================

async function awardBadge(
  userId,
  badgeCode
) {
  const badges =
    await sql`
      SELECT
        id,
        code,
        name,
        description,
        icon,
        xp_reward

      FROM badges

      WHERE code =
        ${badgeCode}

      LIMIT 1
    `;

  if (!badges.length) {
    return null;
  }

  const badge =
    badges[0];

  const existing =
    await sql`
      SELECT
        badge_id

      FROM user_badges

      WHERE
        telegram_user_id =
          ${userId}

      AND badge_id =
          ${badge.id}

      LIMIT 1
    `;

  if (existing.length) {
    return null;
  }

  await sql`
    INSERT INTO user_badges (
      telegram_user_id,
      badge_id
    )

    VALUES (
      ${userId},
      ${badge.id}
    )
  `;

  const reward =
    Number(
      badge.xp_reward || 0
    );

  if (reward > 0) {
    await addXP({
      userId,

      xp: reward,

      reason:
        `badge:${badge.code}`,

      referenceId:
        `badge:${badge.code}`
    });
  }

  return badge;
}


// =========================================================
// バッジ判定
// =========================================================

async function checkBadges({
  userId,
  stats,
  streak
}) {
  const earned = [];

  const checks = [];

  if (
    stats.records >= 1
  ) {
    checks.push(
      "FIRST_RESULT"
    );
  }

  if (
    stats.count >= 10
  ) {
    checks.push(
      "TEN_DELIVERIES"
    );
  }

  if (
    stats.count >= 50
  ) {
    checks.push(
      "FIFTY_DELIVERIES"
    );
  }

  if (
    stats.count >= 100
  ) {
    checks.push(
      "HUNDRED_DELIVERIES"
    );
  }

  if (
    stats.count >= 500
  ) {
    checks.push(
      "FIVE_HUNDRED_DELIVERIES"
    );
  }

  if (
    streak.current >= 3
  ) {
    checks.push(
      "STREAK_3"
    );
  }

  if (
    streak.current >= 7
  ) {
    checks.push(
      "STREAK_7"
    );
  }

  if (
    streak.current >= 30
  ) {
    checks.push(
      "STREAK_30"
    );
  }

  for (
    const code of checks
  ) {
    const badge =
      await awardBadge(
        userId,
        code
      );

    if (badge) {
      earned.push(
        badge
      );
    }
  }

  return earned;
}
// ============================================================
// Command Handlers
// ============================================================

async function getMonthlyGoal(userId) {
  const rows = await sql`
    SELECT monthly_goal
    FROM delivery_goals
    WHERE telegram_user_id = ${userId}
    LIMIT 1
  `;

  return rows.length ? Number(rows[0].monthly_goal) : 500;
}

async function getUserResults(userId) {
  return sql`
    SELECT
      id,
      telegram_user_id,
      sale_amount,
      delivery_count,
      work_hours,
      created_at,
      chat_id
    FROM delivery_results
    WHERE telegram_user_id = ${userId}
    ORDER BY created_at ASC, id ASC
  `;
}

async function rebuildGamification(userId) {
  const results = await getUserResults(userId);

  await ensureProfile(userId);

  // ----------------------------------------------------------
  // 既存のXP・バッジを一旦再構築
  // /cancel や /reset で整合性を保つため
  // ----------------------------------------------------------

  await sql`
    DELETE FROM xp_logs
    WHERE telegram_user_id = ${userId}
  `;

  await sql`
    DELETE FROM user_badges
    WHERE telegram_user_id = ${userId}
  `;

  let totalXP = 0;

  // ----------------------------------------------------------
  // 実績ごとの基本XP
  // ----------------------------------------------------------

  for (const result of results) {
    const count = Number(result.delivery_count || 0);

    const xp = Math.max(10, count * 10);

    await sql`
      INSERT INTO xp_logs (
        telegram_user_id,
        xp,
        reason,
        reference_id,
        created_at
      )
      VALUES (
        ${userId},
        ${xp},
        'delivery_result',
        ${`result:${result.id}`},
        ${result.created_at}
      )
    `;

    totalXP += xp;
  }

  // ----------------------------------------------------------
  // ストリーク計算
  // ----------------------------------------------------------

  const activityDates = await getActivityDates(userId);

  const streak = calculateStreak(activityDates);

  // ----------------------------------------------------------
  // プロフィール統計
  // ----------------------------------------------------------

  const lifetime = await getLifetimeStats(userId);

  const today = getTodayJST();

  const lastActivityDate =
    activityDates.length > 0
      ? activityDates[activityDates.length - 1]
      : null;

  // ----------------------------------------------------------
  // レベル計算
  // ----------------------------------------------------------

  let level = calculateLevel(totalXP);

  // ----------------------------------------------------------
  // 一旦プロフィール更新
  // ----------------------------------------------------------

  await sql`
    UPDATE user_profiles
    SET
      xp = ${totalXP},
      level = ${level},
      streak_days = ${streak.current},
      best_streak_days = ${streak.best},
      last_activity_date = ${lastActivityDate},
      updated_at = NOW()
    WHERE telegram_user_id = ${userId}
  `;

  // ----------------------------------------------------------
  // バッジ再判定
  // ----------------------------------------------------------

  const badgeResult = await checkBadges(userId);

  // checkBadges() 内でバッジXPが追加されるため、
  // 最終XPを再取得
  const profileRows = await sql`
    SELECT
      xp,
      level,
      streak_days,
      best_streak_days,
      last_activity_date
    FROM user_profiles
    WHERE telegram_user_id = ${userId}
    LIMIT 1
  `;

  if (profileRows.length) {
    totalXP = Number(profileRows[0].xp || 0);
    level = Number(profileRows[0].level || calculateLevel(totalXP));
  }

  return {
    xp: totalXP,
    level,
    streakDays: streak.current,
    bestStreakDays: streak.best,
    lifetime,
    lastActivityDate,
    today,
    newBadges: badgeResult?.newBadges || [],
  };
}

async function processGamificationAfterAdd(userId, resultId) {
  await ensureProfile(userId);

  const rows = await sql`
    SELECT
      id,
      sale_amount,
      delivery_count,
      work_hours,
      created_at
    FROM delivery_results
    WHERE id = ${resultId}
      AND telegram_user_id = ${userId}
    LIMIT 1
  `;

  if (!rows.length) {
    return null;
  }

  const result = rows[0];

  const referenceId = `result:${result.id}`;

  // ----------------------------------------------------------
  // 同じ実績にXPを二重付与しない
  // ----------------------------------------------------------

  const existingXP = await sql`
    SELECT id
    FROM xp_logs
    WHERE telegram_user_id = ${userId}
      AND reference_id = ${referenceId}
    LIMIT 1
  `;

  let earnedXP = 0;

  if (!existingXP.length) {
    earnedXP = Math.max(
      10,
      Number(result.delivery_count || 0) * 10
    );

    await sql`
      INSERT INTO xp_logs (
        telegram_user_id,
        xp,
        reason,
        reference_id,
        created_at
      )
      VALUES (
        ${userId},
        ${earnedXP},
        'delivery_result',
        ${referenceId},
        ${result.created_at}
      )
    `;
  }

  // ----------------------------------------------------------
  // 全XPを再集計
  // ----------------------------------------------------------

  const xpRows = await sql`
    SELECT COALESCE(SUM(xp), 0) AS total_xp
    FROM xp_logs
    WHERE telegram_user_id = ${userId}
  `;

  const totalXP = Number(xpRows[0]?.total_xp || 0);

  const level = calculateLevel(totalXP);

  // ----------------------------------------------------------
  // ストリーク
  // ----------------------------------------------------------

  const activityDates = await getActivityDates(userId);
  const streak = calculateStreak(activityDates);

  const lastActivityDate =
    activityDates.length > 0
      ? activityDates[activityDates.length - 1]
      : null;

  // ----------------------------------------------------------
  // プロフィール更新
  // ----------------------------------------------------------

  await sql`
    UPDATE user_profiles
    SET
      xp = ${totalXP},
      level = ${level},
      streak_days = ${streak.current},
      best_streak_days = ${streak.best},
      last_activity_date = ${lastActivityDate},
      updated_at = NOW()
    WHERE telegram_user_id = ${userId}
  `;

  // ----------------------------------------------------------
  // バッジ
  // ----------------------------------------------------------

  const badgeResult = await checkBadges(userId);

  // バッジXPが入った場合の最終XP
  const finalXPRows = await sql`
    SELECT
      xp,
      level,
      streak_days,
      best_streak_days
    FROM user_profiles
    WHERE telegram_user_id = ${userId}
    LIMIT 1
  `;

  const profile = finalXPRows[0] || {};

  return {
    earnedXP,
    xp: Number(profile.xp || totalXP),
    level: Number(profile.level || calculateLevel(totalXP)),
    streakDays: Number(profile.streak_days || streak.current),
    bestStreakDays: Number(
      profile.best_streak_days || streak.best
    ),
    newBadges: badgeResult?.newBadges || [],
  };
}


// ============================================================
// /start
// ============================================================

async function handleStart(message) {
  const userId = getTelegramUserId(message);
  const chatId = getChatId(message);

  if (!userId || !chatId) return;

  await ensureProfile(userId);

  if (isGroupChat(message)) {
    await ensureGroupContext(message);
  }

  await writeAuditLog({
    userId,
    chatId,
    action: "start",
    details: {
      chatType: message?.chat?.type || null,
    },
  });

  const displayName = getDisplayName(message);

  const text =
    `🔥 <b>配達リザルトBotへようこそ！</b>\n\n` +
    `${displayName}さん、今日もお疲れさまです！\n\n` +
    `📦 実績登録\n` +
    `<code>/add 売上 配達件数 稼働時間</code>\n` +
    `例：<code>/add 20000 30 8</code>\n\n` +
    `🎯 月間目標\n` +
    `<code>/goal 500</code>\n\n` +
    `📊 グループ実績\n` +
    `<code>/group</code>\n\n` +
    `🏆 ランキング\n` +
    `<code>/ranking</code>\n\n` +
    `📈 Mini App\n` +
    `下のメニューからダッシュボードを開けます。\n\n` +
    `💡 <code>/help</code> で全コマンドを確認できます。`;

  await sendMessage(chatId, text);
}


// ============================================================
// /help
// ============================================================

async function handleHelp(message) {
  const chatId = getChatId(message);

  if (!chatId) return;

  const text =
    `📖 <b>配達リザルトBot ヘルプ</b>\n` +
    `━━━━━━━━━━━━━━\n\n` +

    `📦 <b>実績登録</b>\n` +
    `<code>/add 20000 30 8</code>\n` +
    `売上2万円・30件・8時間\n\n` +

    `↩️ <b>最新実績を削除</b>\n` +
    `<code>/cancel</code>\n\n` +

    `🗑 <b>自分の実績を全削除</b>\n` +
    `<code>/reset</code>\n` +
    `※月間目標は残ります\n\n` +

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
    `<code>/admin</code>\n\n` +

    `━━━━━━━━━━━━━━\n` +
    `🔥 実績を積むほどXP・レベル・バッジが成長します。`;

  await sendMessage(chatId, text);
}


// ============================================================
// /add
// ============================================================

async function handleAdd(message) {
  const userId = getTelegramUserId(message);
  const chatId = getChatId(message);

  if (!userId || !chatId) return;

  const args = parseAddArguments(message?.text || "");

  if (!args.ok) {
    await sendMessage(chatId, args.error);
    return;
  }

  await ensureProfile(userId);

  if (isGroupChat(message)) {
    await ensureGroupContext(message);
  }

  const {
    saleAmount,
    deliveryCount,
    workHours,
  } = args;

  // ----------------------------------------------------------
  // 実績登録
  // ----------------------------------------------------------

  const inserted = await sql`
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
      telegram_user_id,
      sale_amount,
      delivery_count,
      work_hours,
      created_at,
      chat_id
  `;

  const result = inserted[0];

  // ----------------------------------------------------------
  // 監査ログ
  // ----------------------------------------------------------

  await writeAuditLog({
    userId,
    chatId,
    action: "add",
    details: {
      result_id: String(result.id),
      sale_amount: saleAmount,
      delivery_count: deliveryCount,
      work_hours: workHours,
    },
  });

  // ----------------------------------------------------------
  // 日次・月次集計
  // ----------------------------------------------------------

  await updateDailyStats(userId);
  await updateMonthlyStats(userId);

  // ----------------------------------------------------------
  // XP / レベル / バッジ
  // ----------------------------------------------------------

  const gamification = await processGamificationAfterAdd(
    userId,
    result.id
  );

  const unitPrice =
    deliveryCount > 0
      ? Math.round(saleAmount / deliveryCount)
      : 0;

  const hourlySales =
    workHours > 0
      ? Math.round(saleAmount / workHours)
      : 0;

  let text =
    `✅ <b>実績登録しました！</b>\n` +
    `━━━━━━━━━━━━━━\n` +
    `💰 売上：<b>${formatNumber(saleAmount)}円</b>\n` +
    `📦 配達：<b>${formatNumber(deliveryCount)}件</b>\n` +
    `⏱ 稼働：<b>${formatHours(workHours)}</b>\n` +
    `💴 件単価：約<b>${formatNumber(unitPrice)}円</b>\n` +
    `⚡ 時給換算：約<b>${formatNumber(hourlySales)}円</b>\n` +
    `━━━━━━━━━━━━━━\n`;

  if (gamification) {
    text +=
      `✨ XP：<b>+${formatNumber(gamification.earnedXP)}</b>\n` +
      `🏆 累計XP：<b>${formatNumber(gamification.xp)}</b>\n` +
      `🎚 レベル：<b>${gamification.level}</b>\n` +
      `🔥 連続稼働：<b>${gamification.streakDays}日</b>\n`;

    if (
      gamification.newBadges &&
      gamification.newBadges.length > 0
    ) {
      text += `\n🎉 <b>新バッジ獲得！</b>\n`;

      for (const badge of gamification.newBadges) {
        const icon = badge.icon || "🏅";
        const name = badge.name || badge.code || "新バッジ";

        text +=
          `${icon} ${name}` +
          (badge.xpReward
            ? `（+${formatNumber(badge.xpReward)}XP）`
            : "") +
          `\n`;
      }
    }
  }

  text +=
    `\n📊 Mini Appで詳細を見ると\n` +
    `ランキング・分析・目標進捗も確認できます。`;

  await sendMessage(chatId, text);
}


// ============================================================
// /cancel
// ============================================================

async function handleCancel(message) {
  const userId = getTelegramUserId(message);
  const chatId = getChatId(message);

  if (!userId || !chatId) return;

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

  if (!rows.length) {
    const goal = await getMonthlyGoal(userId);

    await sendMessage(
      chatId,
      `⚠️ <b>削除する実績がありません。</b>\n\n` +
      `🎯 月間目標：${formatNumber(goal)}件`
    );

    return;
  }

  const result = rows[0];

  await sql`
    DELETE FROM delivery_results
    WHERE id = ${result.id}
      AND telegram_user_id = ${userId}
  `;

  await writeAuditLog({
    userId,
    chatId,
    action: "cancel",
    details: {
      result_id: String(result.id),
      sale_amount: Number(result.sale_amount),
      delivery_count: Number(result.delivery_count),
      work_hours: Number(result.work_hours),
    },
  });

  // ----------------------------------------------------------
  // XP / バッジ / ストリークを実績ベースで再構築
  // ----------------------------------------------------------

  const gamification = await rebuildGamification(userId);

  await updateDailyStats(userId);
  await updateMonthlyStats(userId);

  await sendMessage(
    chatId,
    `↩️ <b>最新の実績を削除しました。</b>\n\n` +
    `💰 売上：${formatNumber(Number(result.sale_amount))}円\n` +
    `📦 配達：${formatNumber(Number(result.delivery_count))}件\n` +
    `⏱ 稼働：${formatHours(Number(result.work_hours))}\n\n` +
    `🏆 累計XP：${formatNumber(gamification.xp)}\n` +
    `🎚 レベル：${gamification.level}\n` +
    `🔥 連続稼働：${gamification.streakDays}日`
  );
}


// ============================================================
// /reset
// ============================================================

async function handleReset(message) {
  const userId = getTelegramUserId(message);
  const chatId = getChatId(message);

  if (!userId || !chatId) return;

  const countRows = await sql`
    SELECT COUNT(*)::int AS count
    FROM delivery_results
    WHERE telegram_user_id = ${userId}
  `;

  const count = Number(countRows[0]?.count || 0);

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
    userId,
    chatId,
    action: "reset",
    details: {
      deleted_count: count,
    },
  });

  // ----------------------------------------------------------
  // 実績を全削除したので
  // XP / バッジ / ストリークも再構築
  // ----------------------------------------------------------

  const gamification = await rebuildGamification(userId);

  await updateDailyStats(userId);
  await updateMonthlyStats(userId);

  const goal = await getMonthlyGoal(userId);

  await sendMessage(
    chatId,
    `🗑 <b>実績をすべて削除しました。</b>\n\n` +
    `削除件数：<b>${formatNumber(count)}件</b>\n\n` +
    `🏆 累計XP：<b>${formatNumber(gamification.xp)}</b>\n` +
    `🎚 レベル：<b>${gamification.level}</b>\n` +
    `🔥 連続稼働：<b>${gamification.streakDays}日</b>\n\n` +
    `🎯 月間目標：<b>${formatNumber(goal)}件</b>\n` +
    `※月間目標は残っています。`
  );
}


// ============================================================
// /goal
// ============================================================

async function handleGoal(message) {
  const userId = getTelegramUserId(message);
  const chatId = getChatId(message);

  if (!userId || !chatId) return;

  const text = String(message?.text || "").trim();

  const parts = text.split(/\s+/);

  // ----------------------------------------------------------
  // 引数なし → 現在の目標表示
  // ----------------------------------------------------------

  if (parts.length < 2) {
    const goal = await getMonthlyGoal(userId);

    await sendMessage(
      chatId,
      `🎯 <b>現在の月間目標</b>\n\n` +
      `<b>${formatNumber(goal)}件</b>\n\n` +
      `変更する場合：\n` +
      `<code>/goal 500</code>`
    );

    return;
  }

  const rawGoal = String(parts[1]).replace(/,/g, "");

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
    !Number.isInteger(monthlyGoal) ||
    monthlyGoal <= 0 ||
    monthlyGoal > 1000000
  ) {
    await sendMessage(
      chatId,
      `⚠️ 月間目標は <b>1〜1,000,000件</b> の範囲で指定してください。`
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
    userId,
    chatId,
    action: "goal_update",
    details: {
      monthlyGoal,
    },
  });

  await sendMessage(
    chatId,
    `🎯 <b>月間目標を更新しました！</b>\n\n` +
    `目標：<b>${formatNumber(monthlyGoal)}件</b>\n\n` +
    `🔥 この目標に向かって積み上げていきましょう！`
  );
}


// ============================================================
// Daily / Monthly Stats
// ============================================================

async function updateDailyStats(userId) {
  const rows = await sql`
    SELECT
      (created_at AT TIME ZONE ${JST})::date AS stat_date,
      COUNT(*)::int AS result_count,
      COALESCE(SUM(sale_amount), 0)::bigint AS sales,
      COALESCE(SUM(delivery_count), 0)::int AS delivery_count,
      COALESCE(SUM(work_hours), 0)::numeric AS work_hours
    FROM delivery_results
    WHERE telegram_user_id = ${userId}
    GROUP BY 1
    ORDER BY 1
  `;

  for (const row of rows) {
    await sql`
      INSERT INTO daily_stats (
        telegram_user_id,
        stat_date,
        sales,
        delivery_count,
        work_hours,
        created_at,
        updated_at
      )
      VALUES (
        ${userId},
        ${row.stat_date},
        ${Number(row.sales || 0)},
        ${Number(row.delivery_count || 0)},
        ${Number(row.work_hours || 0)},
        NOW(),
        NOW()
      )
      ON CONFLICT (telegram_user_id, stat_date)
      DO UPDATE SET
        sales = EXCLUDED.sales,
        delivery_count = EXCLUDED.delivery_count,
        work_hours = EXCLUDED.work_hours,
        updated_at = NOW()
    `;
  }

  // 実績がなくなった日の集計を削除
  await sql`
    DELETE FROM daily_stats d
    WHERE d.telegram_user_id = ${userId}
      AND NOT EXISTS (
        SELECT 1
        FROM delivery_results r
        WHERE r.telegram_user_id = d.telegram_user_id
          AND (r.created_at AT TIME ZONE ${JST})::date = d.stat_date
      )
  `;
}


async function updateMonthlyStats(userId) {
  const rows = await sql`
    SELECT
      EXTRACT(
        YEAR FROM (created_at AT TIME ZONE ${JST})
      )::int AS year,

      EXTRACT(
        MONTH FROM (created_at AT TIME ZONE ${JST})
      )::int AS month,

      COUNT(*)::int AS result_count,

      COALESCE(SUM(sale_amount), 0)::bigint AS sales,

      COALESCE(SUM(delivery_count), 0)::int AS delivery_count,

      COALESCE(SUM(work_hours), 0)::numeric AS work_hours,

      COUNT(
        DISTINCT (created_at AT TIME ZONE ${JST})::date
      )::int AS work_days

    FROM delivery_results

    WHERE telegram_user_id = ${userId}

    GROUP BY 1, 2

    ORDER BY 1, 2
  `;

  for (const row of rows) {
    await sql`
      INSERT INTO monthly_stats (
        telegram_user_id,
        year,
        month,
        sales,
        delivery_count,
        work_hours,
        work_days,
        created_at,
        updated_at
      )
      VALUES (
        ${userId},
        ${Number(row.year)},
        ${Number(row.month)},
        ${Number(row.sales || 0)},
        ${Number(row.delivery_count || 0)},
        ${Number(row.work_hours || 0)},
        ${Number(row.work_days || 0)},
        NOW(),
        NOW()
      )
      ON CONFLICT (telegram_user_id, year, month)
      DO UPDATE SET
        sales = EXCLUDED.sales,
        delivery_count = EXCLUDED.delivery_count,
        work_hours = EXCLUDED.work_hours,
        work_days = EXCLUDED.work_days,
        updated_at = NOW()
    `;
  }

  await sql`
    DELETE FROM monthly_stats m
    WHERE m.telegram_user_id = ${userId}
      AND NOT EXISTS (
        SELECT 1
        FROM delivery_results r
        WHERE r.telegram_user_id = m.telegram_user_id
          AND EXTRACT(
            YEAR FROM (r.created_at AT TIME ZONE ${JST})
          )::int = m.year
          AND EXTRACT(
            MONTH FROM (r.created_at AT TIME ZONE ${JST})
          )::int = m.month
      )
  `;
}
// ============================================================
// Group Statistics
// ============================================================

function getJSTMonthRange(offsetMonths = 0) {
  const now = new Date();

  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: JST,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });

  const parts = formatter.formatToParts(now);

  const year = Number(
    parts.find((p) => p.type === "year")?.value
  );

  const month = Number(
    parts.find((p) => p.type === "month")?.value
  );

  const base = new Date(
    Date.UTC(year, month - 1 + offsetMonths, 1)
  );

  const targetYear = base.getUTCFullYear();
  const targetMonth = base.getUTCMonth() + 1;

  const start = `${targetYear}-${String(targetMonth).padStart(2, "0")}-01`;

  const next = new Date(
    Date.UTC(targetYear, targetMonth, 1)
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


function parseMonthArgument(text) {
  const parts = String(text || "")
    .trim()
    .split(/\s+/);

  if (parts.length < 2) {
    return null;
  }

  const value = parts[1];

  if (!/^\d{4}-\d{2}$/.test(value)) {
    return null;
  }

  const [year, month] = value.split("-").map(Number);

  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    month < 1 ||
    month > 12
  ) {
    return null;
  }

  return {
    year,
    month,
    start: `${year}-${String(month).padStart(2, "0")}-01`,
    end: (() => {
      const next = new Date(Date.UTC(year, month, 1));

      return `${next.getUTCFullYear()}-${String(
        next.getUTCMonth() + 1
      ).padStart(2, "0")}-01`;
    })(),
  };
}


async function getGroupStats(start, end) {
  const rows = await sql`
    SELECT
      COUNT(*)::int AS result_count,
      COUNT(DISTINCT telegram_user_id)::int AS user_count,
      COALESCE(SUM(sale_amount), 0)::bigint AS sales,
      COALESCE(SUM(delivery_count), 0)::int AS delivery_count,
      COALESCE(SUM(work_hours), 0)::numeric AS work_hours
    FROM delivery_results
    WHERE created_at >= ${start}::date AT TIME ZONE ${JST}
      AND created_at < ${end}::date AT TIME ZONE ${JST}
  `;

  const row = rows[0] || {};

  return {
    resultCount: Number(row.result_count || 0),
    userCount: Number(row.user_count || 0),
    sales: Number(row.sales || 0),
    deliveryCount: Number(row.delivery_count || 0),
    workHours: Number(row.work_hours || 0),
  };
}


async function getGroupUserRanking(start, end) {
  const rows = await sql`
    SELECT
      r.telegram_user_id,

      COALESCE(
        NULLIF(MAX(gm.first_name), ''),
        NULLIF(MAX(gm.username), ''),
        r.telegram_user_id
      ) AS display_name,

      MAX(gm.username) AS username,

      COUNT(*)::int AS result_count,

      COALESCE(SUM(r.sale_amount), 0)::bigint AS sales,

      COALESCE(SUM(r.delivery_count), 0)::int AS delivery_count,

      COALESCE(SUM(r.work_hours), 0)::numeric AS work_hours

    FROM delivery_results r

    LEFT JOIN group_members gm
      ON gm.telegram_user_id = r.telegram_user_id

    WHERE r.created_at >= ${start}::date AT TIME ZONE ${JST}
      AND r.created_at < ${end}::date AT TIME ZONE ${JST}

    GROUP BY r.telegram_user_id

    ORDER BY
      delivery_count DESC,
      sales DESC,
      telegram_user_id ASC

    LIMIT 100
  `;

  return rows.map((row, index) => {
    const deliveryCount = Number(row.delivery_count || 0);
    const sales = Number(row.sales || 0);
    const hours = Number(row.work_hours || 0);

    return {
      rank: index + 1,
      telegramUserId: String(row.telegram_user_id),
      name: row.display_name || String(row.telegram_user_id),
      username: row.username || null,
      resultCount: Number(row.result_count || 0),
      deliveryCount,
      sales,
      workHours: hours,
      efficiency:
        hours > 0
          ? Math.round(deliveryCount / hours * 100) / 100
          : 0,
      salesPerHour:
        hours > 0
          ? Math.round(sales / hours)
          : 0,
    };
  });
}


function buildGroupText({
  title,
  year,
  month,
  stats,
  rankings,
}) {
  const monthLabel =
    `${year}/${String(month).padStart(2, "0")}`;

  let text =
    `👥 <b>${title}</b>\n` +
    `━━━━━━━━━━━━━━\n` +
    `📅 ${monthLabel}\n\n` +

    `📊 <b>全体</b>\n` +
    `登録実績：${formatNumber(stats.resultCount)}件\n` +
    `参加人数：${formatNumber(stats.userCount)}人\n` +
    `💰 売上：<b>${formatNumber(stats.sales)}円</b>\n` +
    `📦 配達：<b>${formatNumber(stats.deliveryCount)}件</b>\n` +
    `⏱ 稼働：<b>${formatHours(stats.workHours)}</b>\n`;

  if (stats.deliveryCount > 0) {
    text +=
      `💴 件単価：約${formatNumber(
        Math.round(stats.sales / stats.deliveryCount)
      )}円\n`;
  }

  if (stats.workHours > 0) {
    text +=
      `⚡ 1時間あたり：約${formatNumber(
        Math.round(stats.deliveryCount / stats.workHours)
      )}件\n`;
  }

  text +=
    `\n━━━━━━━━━━━━━━\n` +
    `🏆 <b>配達件数ランキング</b>\n`;

  if (!rankings.length) {
    text += `\nまだ実績がありません。`;
    return text;
  }

  for (const row of rankings.slice(0, 10)) {
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
      `　📦 ${formatNumber(row.deliveryCount)}件` +
      ` / 💰 ${formatNumber(row.sales)}円` +
      ` / ⏱ ${formatHours(row.workHours)}\n`;
  }

  return text;
}


// ============================================================
// /group
// ============================================================

async function handleGroup(message) {
  const userId = getTelegramUserId(message);
  const chatId = getChatId(message);

  if (!userId || !chatId) return;

  if (!isGroupChat(message)) {
    await sendMessage(
      chatId,
      `👥 <b>/group</b> はグループチャットで使用してください。`
    );
    return;
  }

  await ensureGroupContext(message);

  const range = getJSTMonthRange(0);

  const stats = await getGroupStats(
    range.start,
    range.end
  );

  const rankings = await getGroupUserRanking(
    range.start,
    range.end
  );

  await sendMessage(
    chatId,
    buildGroupText({
      title: "グループ月間実績",
      year: range.year,
      month: range.month,
      stats,
      rankings,
    })
  );

  await writeAuditLog({
    userId,
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
  const userId = getTelegramUserId(message);
  const chatId = getChatId(message);

  if (!userId || !chatId) return;

  if (!isGroupChat(message)) {
    await sendMessage(
      chatId,
      `👥 <b>/lastmonth</b> はグループチャットで使用してください。`
    );
    return;
  }

  await ensureGroupContext(message);

  const range = getJSTMonthRange(-1);

  const stats = await getGroupStats(
    range.start,
    range.end
  );

  const rankings = await getGroupUserRanking(
    range.start,
    range.end
  );

  await sendMessage(
    chatId,
    buildGroupText({
      title: "先月のグループ実績",
      year: range.year,
      month: range.month,
      stats,
      rankings,
    })
  );

  await writeAuditLog({
    userId,
    chatId,
    action: "lastmonth",
    details: {
      year: range.year,
      month: range.month,
    },
  });
}


// ============================================================
// /month YYYY-MM
// ============================================================

async function handleMonth(message) {
  const userId = getTelegramUserId(message);
  const chatId = getChatId(message);

  if (!userId || !chatId) return;

  if (!isGroupChat(message)) {
    await sendMessage(
      chatId,
      `👥 <b>/month</b> はグループチャットで使用してください。`
    );
    return;
  }

  const range = parseMonthArgument(message?.text || "");

  if (!range) {
    await sendMessage(
      chatId,
      `⚠️ 月を正しく指定してください。\n\n` +
      `例：<code>/month 2026-09</code>`
    );
    return;
  }

  await ensureGroupContext(message);

  const stats = await getGroupStats(
    range.start,
    range.end
  );

  const rankings = await getGroupUserRanking(
    range.start,
    range.end
  );

  await sendMessage(
    chatId,
    buildGroupText({
      title: "指定月のグループ実績",
      year: range.year,
      month: range.month,
      stats,
      rankings,
    })
  );

  await writeAuditLog({
    userId,
    chatId,
    action: "month",
    details: {
      year: range.year,
      month: range.month,
    },
  });
}


// ============================================================
// Ranking Command
// ============================================================

async function getRankingData({
  start,
  end,
  type = "count",
}) {
  const rows = await sql`
    SELECT
      r.telegram_user_id,

      COALESCE(
        NULLIF(MAX(gm.first_name), ''),
        NULLIF(MAX(gm.username), ''),
        r.telegram_user_id
      ) AS display_name,

      MAX(gm.username) AS username,

      COALESCE(SUM(r.delivery_count), 0)::int AS delivery_count,

      COALESCE(SUM(r.sale_amount), 0)::bigint AS sales,

      COALESCE(SUM(r.work_hours), 0)::numeric AS work_hours

    FROM delivery_results r

    LEFT JOIN group_members gm
      ON gm.telegram_user_id = r.telegram_user_id

    WHERE r.created_at >= ${start}::date AT TIME ZONE ${JST}
      AND r.created_at < ${end}::date AT TIME ZONE ${JST}

    GROUP BY r.telegram_user_id
  `;

  const mapped = rows.map((row) => {
    const count = Number(row.delivery_count || 0);
    const sales = Number(row.sales || 0);
    const hours = Number(row.work_hours || 0);

    return {
      telegramUserId: String(row.telegram_user_id),
      name:
        row.display_name ||
        String(row.telegram_user_id),
      username: row.username || null,
      count,
      sales,
      hours,
      efficiency:
        hours > 0
          ? Math.round((count / hours) * 100) / 100
          : 0,
    };
  });

  mapped.sort((a, b) => {
    if (type === "sales") {
      return (
        b.sales - a.sales ||
        b.count - a.count
      );
    }

    if (type === "efficiency") {
      return (
        b.efficiency - a.efficiency ||
        b.count - a.count
      );
    }

    return (
      b.count - a.count ||
      b.sales - a.sales
    );
  });

  return mapped;
}


async function handleRanking(message) {
  const userId = getTelegramUserId(message);
  const chatId = getChatId(message);

  if (!userId || !chatId) return;

  const range = getJSTMonthRange(0);

  const rankings = await getRankingData({
    start: range.start,
    end: range.end,
    type: "count",
  });

  const myIndex = rankings.findIndex(
    (row) => row.telegramUserId === String(userId)
  );

  let text =
    `🏆 <b>今月ランキング</b>\n` +
    `━━━━━━━━━━━━━━\n`;

  if (!rankings.length) {
    text += `\nまだランキングデータがありません。`;

    await sendMessage(chatId, text);
    return;
  }

  for (const [index, row] of rankings
    .slice(0, 10)
    .entries()) {

    const rank = index + 1;

    const medal =
      rank === 1
        ? "🥇"
        : rank === 2
          ? "🥈"
          : rank === 3
            ? "🥉"
            : `${rank}.`;

    const me =
      row.telegramUserId === String(userId)
        ? " 👈"
        : "";

    text +=
      `${medal} <b>${row.name}</b>${me}\n` +
      `　📦 ${formatNumber(row.count)}件` +
      ` / 💰 ${formatNumber(row.sales)}円` +
      ` / ⚡ ${row.efficiency}件/h\n`;
  }

  if (myIndex >= 10) {
    const me = rankings[myIndex];

    text +=
      `\n━━━━━━━━━━━━━━\n` +
      `👤 <b>あなた</b>\n` +
      `順位：${myIndex + 1}位\n` +
      `📦 ${formatNumber(me.count)}件\n` +
      `💰 ${formatNumber(me.sales)}円\n` +
      `⚡ ${me.efficiency}件/h`;
  }

  await sendMessage(chatId, text);

  await writeAuditLog({
    userId,
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
  const overallRows = await sql`
    SELECT
      COUNT(*)::int AS result_count,
      COUNT(DISTINCT telegram_user_id)::int AS user_count,
      COALESCE(SUM(sale_amount), 0)::bigint AS sales,
      COALESCE(SUM(delivery_count), 0)::int AS delivery_count,
      COALESCE(SUM(work_hours), 0)::numeric AS work_hours
    FROM delivery_results
  `;

  const monthRows = await sql`
    SELECT
      COUNT(*)::int AS result_count,
      COUNT(DISTINCT telegram_user_id)::int AS user_count,
      COALESCE(SUM(sale_amount), 0)::bigint AS sales,
      COALESCE(SUM(delivery_count), 0)::int AS delivery_count,
      COALESCE(SUM(work_hours), 0)::numeric AS work_hours
    FROM delivery_results
    WHERE created_at >= date_trunc(
      'month',
      NOW() AT TIME ZONE ${JST}
    ) AT TIME ZONE ${JST}
    AND created_at < (
      date_trunc(
        'month',
        NOW() AT TIME ZONE ${JST}
      ) + INTERVAL '1 month'
    ) AT TIME ZONE ${JST}
  `;

  const groupsRows = await sql`
    SELECT COUNT(*)::int AS count
    FROM telegram_groups
  `;

  const logs = await sql`
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

  const lastRows = await sql`
    SELECT created_at
    FROM delivery_results
    ORDER BY created_at DESC
    LIMIT 1
  `;

  const overall = overallRows[0] || {};
  const month = monthRows[0] || {};

  return {
    overall: {
      resultCount: Number(overall.result_count || 0),
      userCount: Number(overall.user_count || 0),
      sales: Number(overall.sales || 0),
      deliveryCount: Number(overall.delivery_count || 0),
      workHours: Number(overall.work_hours || 0),
    },

    month: {
      resultCount: Number(month.result_count || 0),
      userCount: Number(month.user_count || 0),
      sales: Number(month.sales || 0),
      deliveryCount: Number(month.delivery_count || 0),
      workHours: Number(month.work_hours || 0),
    },

    groupCount: Number(groupsRows[0]?.count || 0),

    logs,

    lastCreatedAt:
      lastRows.length
        ? lastRows[0].created_at
        : null,
  };
}


async function handleAdmin(message) {
  const userId = getTelegramUserId(message);
  const chatId = getChatId(message);

  if (!userId || !chatId) return;

  if (!isAdmin(userId)) {
    await writeAuditLog({
      userId,
      chatId,
      action: "admin_denied",
      details: {
        reason: "not_admin",
      },
    });

    await sendMessage(
      chatId,
      `⛔ <b>管理者権限がありません。</b>`
    );

    return;
  }

  const stats = await getAdminStatistics();

  const monthAvgPrice =
    stats.month.deliveryCount > 0
      ? Math.round(
          stats.month.sales /
          stats.month.deliveryCount
        )
      : 0;

  const monthAvgHours =
    stats.month.userCount > 0
      ? Math.round(
          stats.month.workHours /
          stats.month.userCount *
          100
        ) / 100
      : 0;

  let text =
    `🔐 <b>管理者統計</b>\n` +
    `━━━━━━━━━━━━━━\n` +

    `📊 <b>全体</b>\n` +
    `━━━━━━━━━━━━━━\n` +
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
    )}\n\n` +

    `📅 <b>今月（JST）</b>\n` +
    `━━━━━━━━━━━━━━\n` +
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
    )}\n` +
    `平均単価：${formatNumber(
      monthAvgPrice
    )}円/件\n` +
    `平均稼働：${formatHours(
      monthAvgHours
    )}/人\n\n` +

    `👥 <b>グループ</b>\n` +
    `━━━━━━━━━━━━━━\n` +
    `登録グループ：${formatNumber(
      stats.groupCount
    )}\n\n` +

    `📝 <b>最新ログ</b>\n` +
    `━━━━━━━━━━━━━━\n`;

  if (!stats.logs.length) {
    text += `ログなし\n`;
  } else {
    for (const log of stats.logs) {
      text +=
        `${formatDateJST(log.created_at)} ` +
        `/ ${log.action} / ` +
        `${log.telegram_user_id}\n`;
    }
  }

  text += `\n`;

  if (stats.lastCreatedAt) {
    text +=
      `🕐 最終登録：` +
      `${formatDateJST(stats.lastCreatedAt)}`;
  } else {
    text += `🕐 最終登録：なし`;
  }

  await sendMessage(chatId, text);

  await writeAuditLog({
    userId,
    chatId,
    action: "admin",
    details: {},
  });
}


// ============================================================
// Telegram Mini App
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
    await telegramApi("sendMessage", {
      chat_id: chatId,
      text:
        `📱 <b>Mini App</b>\n\n` +
        `実績・分析・ランキング・目標をまとめて確認できます。`,
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "📊 ダッシュボードを開く",
              web_app: {
                url: miniAppUrl,
              },
            },
          ],
        ],
      },
    });

    return true;
  } catch (error) {
    console.error(
      "sendMiniAppButton error:",
      error
    );

    return false;
  }
}


// ============================================================
// Command Router
// ============================================================

async function handleCommand(message) {
  const command = getCommandName(
    message?.text || ""
  );

  if (!command) return;

  switch (command) {
    case "start":
      await handleStart(message);
      return;

    case "help":
      await handleHelp(message);
      return;

    case "add":
      await handleAdd(message);
      return;

    case "cancel":
      await handleCancel(message);
      return;

    case "reset":
      await handleReset(message);
      return;

    case "goal":
      await handleGoal(message);
      return;

    case "group":
      await handleGroup(message);
      return;

    case "lastmonth":
      await handleLastMonth(message);
      return;

    case "month":
      await handleMonth(message);
      return;

    case "ranking":
      await handleRanking(message);
      return;

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
      message: "Bot webhook is running.",
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
        error: "BOT_TOKEN is not configured.",
      });

      return;
    }

    const update =
      typeof req.body === "string"
        ? JSON.parse(req.body)
        : req.body;

    if (!update || typeof update !== "object") {
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
        await ensureGroupContext(message);
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
        error: "Internal bot error.",
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

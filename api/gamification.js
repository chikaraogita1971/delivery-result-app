const { neon } = require("@neondatabase/serverless");
const crypto = require("crypto");

const sql = neon(process.env.DATABASE_URL);

const BOT_TOKEN = process.env.BOT_TOKEN;
const JST = "Asia/Tokyo";

const MAX_AUTH_AGE_SECONDS = 60 * 60;


// =========================================================
// Telegram initData 検証
// =========================================================

function verifyTelegramInitData(initData) {
  if (!initData) {
    throw new Error(
      "Telegram initData がありません"
    );
  }

  if (!BOT_TOKEN) {
    throw new Error(
      "BOT_TOKEN が設定されていません"
    );
  }

  const params =
    new URLSearchParams(initData);

  const receivedHash =
    params.get("hash");

  if (!receivedHash) {
    throw new Error(
      "Telegram hash がありません"
    );
  }

  const authDate =
    Number(
      params.get("auth_date")
    );

  if (
    !Number.isInteger(authDate) ||
    authDate <= 0
  ) {
    throw new Error(
      "auth_date が不正です"
    );
  }

  const now =
    Math.floor(
      Date.now() / 1000
    );

  if (
    Math.abs(
      now - authDate
    ) >
    MAX_AUTH_AGE_SECONDS
  ) {
    throw new Error(
      "Telegram initData の有効期限が切れています"
    );
  }

  params.delete("hash");

  const dataCheckString =
    [...params.entries()]
      .sort(([a], [b]) =>
        a.localeCompare(b)
      )
      .map(
        ([key, value]) =>
          `${key}=${value}`
      )
      .join("\n");

  const secretKey =
    crypto
      .createHmac(
        "sha256",
        "WebAppData"
      )
      .update(BOT_TOKEN)
      .digest();

  const calculatedHash =
    crypto
      .createHmac(
        "sha256",
        secretKey
      )
      .update(dataCheckString)
      .digest("hex");

  const receivedBuffer =
    Buffer.from(
      receivedHash,
      "hex"
    );

  const calculatedBuffer =
    Buffer.from(
      calculatedHash,
      "hex"
    );

  if (
    receivedBuffer.length !==
      calculatedBuffer.length ||
    !crypto.timingSafeEqual(
      receivedBuffer,
      calculatedBuffer
    )
  ) {
    throw new Error(
      "Telegram initData の検証に失敗しました"
    );
  }

  const userRaw =
    params.get("user");

  if (!userRaw) {
    throw new Error(
      "Telegramユーザー情報がありません"
    );
  }

  let user;

  try {
    user =
      JSON.parse(userRaw);
  } catch {
    throw new Error(
      "Telegramユーザー情報が不正です"
    );
  }

  if (!user?.id) {
    throw new Error(
      "TelegramユーザーIDが取得できません"
    );
  }

  return {
    id: String(user.id),

    username:
      user.username || "",

    firstName:
      user.first_name || "",

    lastName:
      user.last_name || "",
  };
}


// =========================================================
// レベル計算
// =========================================================

function calculateLevel(xp) {
  let level = 1;
  let required = 100;
  let totalRequired = 0;

  while (
    xp >=
    totalRequired + required
  ) {
    totalRequired += required;
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
    totalRequired + required;

  const requiredXP =
    Math.max(
      1,
      nextLevelXP -
        currentLevelXP
    );

  const progressXP =
    Math.max(
      0,
      xp - currentLevelXP
    );

  const progressRate =
    Math.min(
      100,
      Math.max(
        0,
        (
          progressXP /
          requiredXP
        ) *
          100
      )
    );

  return {
    level,

    currentLevelXP,

    nextLevelXP,

    progressXP,

    requiredXP,

    progressRate,
  };
}


// =========================================================
// プロフィール作成・更新
// =========================================================

async function ensureProfile(user) {
  const displayName =
    user.firstName ||
    user.username ||
    `ユーザー${user.id}`;

  const rows =
    await sql`
      INSERT INTO user_profiles (
        telegram_user_id,
        display_name,
        updated_at
      )
      VALUES (
        ${user.id},
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
// 累計実績
// =========================================================

async function getLifetimeStats(userId) {
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

      WHERE telegram_user_id =
        ${userId}
    `;

  const row =
    rows[0] || {};

  return {
    sales:
      Number(row.sales || 0),

    count:
      Number(row.count || 0),

    hours:
      Number(row.hours || 0),

    records:
      Number(row.records || 0),
  };
}


// =========================================================
// 活動日取得
// =========================================================

async function getActivityDates(userId) {
  const rows =
    await sql`
      SELECT DISTINCT
        (
          created_at
          AT TIME ZONE ${JST}
        )::date AS activity_date

      FROM delivery_results

      WHERE telegram_user_id =
        ${userId}

      ORDER BY activity_date DESC
    `;

  return rows.map(
    (row) =>
      String(
        row.activity_date
      )
  );
}


// =========================================================
// JST日付を連番化
// =========================================================

function dateToNumber(date) {
  const value =
    String(date);

  const d =
    new Date(
      `${value}T00:00:00+09:00`
    );

  return Math.floor(
    d.getTime() /
      86400000
  );
}


// =========================================================
// 今日のJST日付
// =========================================================

function getTodayJST() {
  return new Date()
    .toLocaleDateString(
      "en-CA",
      {
        timeZone: JST,
      }
    );
}


// =========================================================
// 連続日数
// =========================================================

function calculateStreak(dates) {
  if (!dates.length) {
    return {
      current: 0,
      best: 0,
    };
  }

  const numbers =
    dates
      .map(dateToNumber)
      .sort(
        (a, b) => b - a
      );

  const unique =
    [...new Set(numbers)];

  let best = 1;
  let currentSequence = 1;

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
      currentSequence += 1;

      best =
        Math.max(
          best,
          currentSequence
        );
    } else {
      currentSequence = 1;
    }
  }

  const today =
    dateToNumber(
      getTodayJST()
    );

  const yesterday =
    today - 1;

  let current = 0;

  if (
    unique[0] === today ||
    unique[0] === yesterday
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

    best:
      Math.max(
        best,
        current
      ),
  };
}


// =========================================================
// XP付与
// =========================================================

async function addXP({
  userId,
  xp,
  reason,
  referenceId,
}) {
  if (
    !Number.isFinite(xp) ||
    xp <= 0
  ) {
    return {
      added: 0,
      duplicate: false,
    };
  }

  if (referenceId) {
    const existing =
      await sql`
        SELECT id
        FROM xp_logs

        WHERE telegram_user_id =
          ${userId}

        AND reference_id =
          ${String(referenceId)}

        LIMIT 1
      `;

    if (existing.length) {
      return {
        added: 0,
        duplicate: true,
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
      ${referenceId || null}
    )
  `;

  await sql`
    UPDATE user_profiles

    SET
      xp =
        COALESCE(xp, 0) +
        ${xp},

      updated_at =
        NOW()

    WHERE telegram_user_id =
      ${userId}
  `;

  return {
    added: xp,
    duplicate: false,
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
    return {
      awarded: false,
    };
  }

  const badge =
    badges[0];

  const existing =
    await sql`
      SELECT badge_id

      FROM user_badges

      WHERE telegram_user_id =
        ${userId}

      AND badge_id =
        ${badge.id}

      LIMIT 1
    `;

  if (existing.length) {
    return {
      awarded: false,

      alreadyOwned: true,

      badge,
    };
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

  const badgeXP =
    Number(
      badge.xp_reward || 0
    );

  if (badgeXP > 0) {
    await addXP({
      userId,

      xp: badgeXP,

      reason:
        `badge:${badge.code}`,

      referenceId:
        `badge:${badge.code}`,
    });
  }

  return {
    awarded: true,
    badge,
  };
}


// =========================================================
// バッジ判定
// =========================================================

async function checkBadges(
  userId,
  stats,
  streak
) {
  const earned = [];

  const rules = [
    [
      stats.records >= 1,
      "FIRST_RESULT",
    ],

    [
      stats.count >= 10,
      "TEN_DELIVERIES",
    ],

    [
      stats.count >= 50,
      "FIFTY_DELIVERIES",
    ],

    [
      stats.count >= 100,
      "HUNDRED_DELIVERIES",
    ],

    [
      stats.count >= 500,
      "FIVE_HUNDRED_DELIVERIES",
    ],

    [
      streak.current >= 3,
      "STREAK_3",
    ],

    [
      streak.current >= 7,
      "STREAK_7",
    ],

    [
      streak.current >= 30,
      "STREAK_30",
    ],
  ];

  for (const [
    condition,
    badgeCode,
  ] of rules) {
    if (!condition) {
      continue;
    }

    const result =
      await awardBadge(
        userId,
        badgeCode
      );

    if (result.awarded) {
      earned.push(
        result.badge
      );
    }
  }

  return earned;
}


// =========================================================
// 獲得済みバッジ
// =========================================================

async function getUserBadges(userId) {
  const rows =
    await sql`
      SELECT
        b.code,
        b.name,
        b.description,
        b.icon,
        b.xp_reward,
        ub.earned_at

      FROM user_badges ub

      INNER JOIN badges b
        ON b.id =
           ub.badge_id

      WHERE ub.telegram_user_id =
        ${userId}

      ORDER BY
        ub.earned_at DESC
    `;

  return rows;
}


// =========================================================
// 個人ゲーミフィケーション情報
// =========================================================

async function getGamificationData(user) {
  const profile =
    await ensureProfile(
      user
    );

  const stats =
    await getLifetimeStats(
      user.id
    );

  const dates =
    await getActivityDates(
      user.id
    );

  const streak =
    calculateStreak(
      dates
    );

  const level =
    calculateLevel(
      Number(
        profile.xp || 0
      )
    );

  const badges =
    await getUserBadges(
      user.id
    );

  return {
    profile: {
      telegramUserId:
        user.id,

      displayName:
        profile.display_name,

      xp:
        Number(
          profile.xp || 0
        ),

      level:
        level.level,

      currentLevelXP:
        level.currentLevelXP,

      nextLevelXP:
        level.nextLevelXP,

      progressXP:
        level.progressXP,

      requiredXP:
        level.requiredXP,

      progressRate:
        Number(
          level.progressRate.toFixed(
            1
          )
        ),

      streakDays:
        streak.current,

      bestStreakDays:
        streak.best,

      lifetimeCount:
        stats.count,

      lifetimeSales:
        stats.sales,

      lifetimeHours:
        stats.hours,

      lifetimeRecords:
        stats.records,
    },

    badges,
  };
}


// =========================================================
// 実績をゲーミフィケーションへ反映
// =========================================================

async function processResult(
  userId,
  resultId
) {
  const rows =
    await sql`
      SELECT
        id,
        delivery_count,
        created_at

      FROM delivery_results

      WHERE id =
        ${resultId}

      AND telegram_user_id =
        ${userId}

      LIMIT 1
    `;

  if (!rows.length) {
    throw new Error(
      "対象の実績が見つかりません"
    );
  }

  const result =
    rows[0];

  // -----------------------------------------
  // XP
  // -----------------------------------------

  const deliveryCount =
    Number(
      result.delivery_count || 0
    );

  const baseXP =
    Math.max(
      10,
      deliveryCount * 10
    );

  const xpResult =
    await addXP({
      userId,

      xp: baseXP,

      reason:
        "delivery_result",

      referenceId:
        `result:${result.id}`,
    });

  // -----------------------------------------
  // プロフィール取得
  // -----------------------------------------

  const profileRows =
    await sql`
      SELECT
        xp,
        best_streak_days

      FROM user_profiles

      WHERE telegram_user_id =
        ${userId}

      LIMIT 1
    `;

  const profile =
    profileRows[0] || {};

  const previousBest =
    Number(
      profile.best_streak_days || 0
    );

  // -----------------------------------------
  // 継続日数
  // -----------------------------------------

  const dates =
    await getActivityDates(
      userId
    );

  const streak =
    calculateStreak(
      dates
    );

  const bestStreak =
    Math.max(
      previousBest,
      streak.best
    );

  await sql`
    UPDATE user_profiles

    SET
      streak_days =
        ${streak.current},

      best_streak_days =
        ${bestStreak},

      last_activity_date =
        (
          ${result.created_at}
          AT TIME ZONE ${JST}
        )::date,

      updated_at =
        NOW()

    WHERE telegram_user_id =
      ${userId}
  `;

  // -----------------------------------------
  // バッジ
  // -----------------------------------------

  const stats =
    await getLifetimeStats(
      userId
    );

  const earnedBadges =
    await checkBadges(
      userId,
      stats,
      streak
    );

  // -----------------------------------------
  // レベル
  // -----------------------------------------

  const updatedProfileRows =
    await sql`
      SELECT xp

      FROM user_profiles

      WHERE telegram_user_id =
        ${userId}

      LIMIT 1
    `;

  const updatedXP =
    Number(
      updatedProfileRows[0]?.xp ||
      0
    );

  const level =
    calculateLevel(
      updatedXP
    );

  await sql`
    UPDATE user_profiles

    SET
      level =
        ${level.level},

      updated_at =
        NOW()

    WHERE telegram_user_id =
      ${userId}
  `;

  return {
    resultId:
      Number(result.id),

    xpAdded:
      xpResult.added,

    duplicateXP:
      xpResult.duplicate,

    totalXP:
      updatedXP,

    level:
      level.level,

    levelProgress:
      Number(
        level.progressRate.toFixed(
          1
        )
      ),

    streakDays:
      streak.current,

    bestStreakDays:
      bestStreak,

    badges:
      earnedBadges,
  };
}


// =========================================================
// API
// =========================================================

module.exports =
  async function handler(
    req,
    res
  ) {
    res.setHeader(
      "Cache-Control",
      "no-store"
    );

    try {
      // ===============================================
      // GET
      // ===============================================

      if (
        req.method ===
        "GET"
      ) {
        const initData =
          req.headers[
            "x-telegram-init-data"
          ];

        const user =
          verifyTelegramInitData(
            initData
          );

        const data =
          await getGamificationData(
            user
          );

        return res.status(200).json({
          ok: true,
          ...data,
        });
      }

      // ===============================================
      // POST
      // ===============================================

      if (
        req.method ===
        "POST"
      ) {
        const initData =
          req.headers[
            "x-telegram-init-data"
          ];

        const user =
          verifyTelegramInitData(
            initData
          );

        const body =
          typeof req.body ===
          "string"
            ? JSON.parse(
                req.body
              )
            : (
                req.body || {}
              );

        const action =
          body.action ||
          "process";

        // =============================================
        // 実績処理
        // =============================================

        if (
          action ===
          "process"
        ) {
          const resultId =
            Number(
              body.resultId
            );

          if (
            !Number.isInteger(
              resultId
            ) ||
            resultId <= 0
          ) {
            return res.status(400).json({
              ok: false,
              error:
                "resultId が不正です",
            });
          }

          const result =
            await processResult(
              user.id,
              resultId
            );

          return res.status(200).json({
            ok: true,
            ...result,
          });
        }

        // =============================================
        // 再同期
        // =============================================

        if (
          action ===
          "sync"
        ) {
          const data =
            await getGamificationData(
              user
            );

          return res.status(200).json({
            ok: true,
            ...data,
          });
        }

        return res.status(400).json({
          ok: false,
          error:
            "action が不正です",
        });
      }

      return res.status(405).json({
        ok: false,
        error:
          "Method Not Allowed",
      });
    } catch (error) {
      console.error(
        "gamification API error:",
        error
      );

      return res.status(500).json({
        ok: false,
        error:
          error?.message ||
          "ゲーミフィケーション処理に失敗しました",
      });
    }
  };

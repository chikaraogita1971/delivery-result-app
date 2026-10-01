const { neon } = require("@neondatabase/serverless");
const crypto = require("crypto");

const sql = neon(process.env.DATABASE_URL);

const BOT_TOKEN = process.env.BOT_TOKEN;
const JST = "Asia/Tokyo";


// =========================================================
// Telegram initData 検証
// =========================================================

function verifyTelegramInitData(initData) {
  if (!initData) {
    throw new Error("Telegram initData がありません");
  }

  const params = new URLSearchParams(initData);
  const hash = params.get("hash");

  if (!hash) {
    throw new Error("Telegram hash がありません");
  }

  const dataCheckString = [...params.entries()]
    .filter(([key]) => key !== "hash")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

  const secretKey = crypto
    .createHmac("sha256", "WebAppData")
    .update(BOT_TOKEN)
    .digest();

  const calculatedHash = crypto
    .createHmac("sha256", secretKey)
    .update(dataCheckString)
    .digest("hex");

  if (
    hash.length !== calculatedHash.length ||
    !crypto.timingSafeEqual(
      Buffer.from(hash, "hex"),
      Buffer.from(calculatedHash, "hex")
    )
  ) {
    throw new Error(
      "Telegram initData の検証に失敗しました"
    );
  }

  const authDate =
    Number(params.get("auth_date"));

  if (!authDate) {
    throw new Error(
      "auth_date がありません"
    );
  }

  const age =
    Math.floor(Date.now() / 1000) -
    authDate;

  if (age > 60 * 60) {
    throw new Error(
      "Telegram initData の有効期限が切れています"
    );
  }

  const userRaw =
    params.get("user");

  if (!userRaw) {
    throw new Error(
      "Telegramユーザー情報がありません"
    );
  }

  const user =
    JSON.parse(userRaw);

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
      user.last_name || ""
  };
}


// =========================================================
// レベル計算
// =========================================================
//
// Lv1 = 0XP
// Lv2 = 100XP
// Lv3 = 300XP
// Lv4 = 600XP
// Lv5 = 1000XP
// 以降は徐々に必要XP増加
//

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

    // 無限ループ防止
    if (level >= 1000) {
      break;
    }
  }

  const currentLevelXP =
    totalRequired;

  const nextLevelXP =
    totalRequired + required;

  return {
    level,
    currentLevelXP,
    nextLevelXP,
    progressXP:
      Math.max(
        0,
        xp - currentLevelXP
      ),
    requiredXP:
      Math.max(
        1,
        nextLevelXP -
          currentLevelXP
      ),
    progressRate:
      Math.min(
        100,
        Math.max(
          0,
          (
            (xp - currentLevelXP) /
            Math.max(
              1,
              nextLevelXP -
                currentLevelXP
            )
          ) * 100
        )
      )
  };
}


// =========================================================
// プロフィール作成 / 更新
// =========================================================

async function ensureProfile(
  user
) {
  const rows = await sql`
    INSERT INTO user_profiles (
      telegram_user_id,
      display_name,
      updated_at
    )
    VALUES (
      ${user.id},
      ${user.firstName || user.username || `ユーザー${user.id}`},
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

async function getLifetimeStats(
  userId
) {
  const rows = await sql`
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

  const row = rows[0];

  return {
    sales:
      Number(row?.sales || 0),

    count:
      Number(row?.count || 0),

    hours:
      Number(row?.hours || 0),

    records:
      Number(row?.records || 0)
  };
}


// =========================================================
// 直近の活動日
// =========================================================

async function getActivityDates(
  userId
) {
  const rows = await sql`
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
    row =>
      row.activity_date
  );
}


// =========================================================
// 日付差
// =========================================================

function dateToNumber(
  date
) {
  const d =
    new Date(
      `${date}T00:00:00+09:00`
    );

  return Math.floor(
    d.getTime() /
    86400000
  );
}


// =========================================================
// 連続日数計算
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

  const numbers =
    dates
      .map(dateToNumber)
      .sort(
        (a, b) => b - a
      );

  const unique =
    [...new Set(numbers)];

  let best = 1;
  let current = 1;

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
      best =
        Math.max(
          best,
          current
        );
    } else {
      current = 1;
    }
  }

  const today =
    dateToNumber(
      new Date()
        .toLocaleDateString(
          "en-CA",
          {
            timeZone: JST
          }
        )
    );

  const yesterday =
    today - 1;

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
  } else {
    current = 0;
  }

  return {
    current,
    best:
      Math.max(
        best,
        current
      )
  };
}


// =========================================================
// XP付与
// =========================================================

async function addXP({
  userId,
  xp,
  reason,
  referenceId
}) {
  if (!xp || xp <= 0) {
    return {
      added: 0,
      duplicate: false
    };
  }

  // referenceIdがある場合、
  // 同じイベントへのXP二重付与を防止
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
      ${referenceId || null}
    )
  `;

  await sql`
    UPDATE user_profiles

    SET
      xp = xp + ${xp},
      updated_at = NOW()

    WHERE telegram_user_id =
      ${userId}
  `;

  return {
    added: xp,
    duplicate: false
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
      awarded: false
    };
  }

  const badge =
    badges[0];

  const existing =
    await sql`
      SELECT
        badge_id

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
      badge
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

  if (
    Number(
      badge.xp_reward
    ) > 0
  ) {
    await addXP({
      userId,
      xp:
        Number(
          badge.xp_reward
        ),
      reason:
        `badge:${badge.code}`,
      referenceId:
        `badge:${badge.code}`
    });
  }

  return {
    awarded: true,
    badge
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

  // 初回
  if (stats.records >= 1) {
    const result =
      await awardBadge(
        userId,
        "FIRST_RESULT"
      );

    if (result.awarded) {
      earned.push(
        result.badge
      );
    }
  }

  // 累計10件
  if (stats.count >= 10) {
    const result =
      await awardBadge(
        userId,
        "TEN_DELIVERIES"
      );

    if (result.awarded) {
      earned.push(
        result.badge
      );
    }
  }

  // 累計50件
  if (stats.count >= 50) {
    const result =
      await awardBadge(
        userId,
        "FIFTY_DELIVERIES"
      );

    if (result.awarded) {
      earned.push(
        result.badge
      );
    }
  }

  // 累計100件
  if (stats.count >= 100) {
    const result =
      await awardBadge(
        userId,
        "HUNDRED_DELIVERIES"
      );

    if (result.awarded) {
      earned.push(
        result.badge
      );
    }
  }

  // 累計500件
  if (stats.count >= 500) {
    const result =
      await awardBadge(
        userId,
        "FIVE_HUNDRED_DELIVERIES"
      );

    if (result.awarded) {
      earned.push(
        result.badge
      );
    }
  }

  // 3日連続
  if (streak.current >= 3) {
    const result =
      await awardBadge(
        userId,
        "STREAK_3"
      );

    if (result.awarded) {
      earned.push(
        result.badge
      );
    }
  }

  // 7日連続
  if (streak.current >= 7) {
    const result =
      await awardBadge(
        userId,
        "STREAK_7"
      );

    if (result.awarded) {
      earned.push(
        result.badge
      );
    }
  }

  // 30日連続
  if (streak.current >= 30) {
    const result =
      await awardBadge(
        userId,
        "STREAK_30"
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
// ユーザー情報取得
// =========================================================

async function getUserBadges(
  userId
) {
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
// GET用データ
// =========================================================

async function getGamificationData(
  user
) {
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
        stats.records
    },

    badges
  };
}


// =========================================================
// POST処理
// =========================================================

async function processResult(
  userId,
  resultId
) {
  const rows =
    await sql`
      SELECT
        id,
        sale_amount,
        delivery_count,
        work_hours,
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
  // 基本XP
  // -----------------------------------------

  const baseXP =
    Math.max(
      10,
      Number(
        result.delivery_count
      ) * 10
    );

  const xpResult =
    await addXP({
      userId,
      xp: baseXP,
      reason:
        "delivery_result",
      referenceId:
        `result:${result.id}`
    });

  // -----------------------------------------
  // プロフィール再取得
  // -----------------------------------------

  const profileRows =
    await sql`
      SELECT *
      FROM user_profiles

      WHERE telegram_user_id =
        ${userId}

      LIMIT 1
    `;

  const profile =
    profileRows[0];

  // -----------------------------------------
  // 連続記録
  // -----------------------------------------

  const dates =
    await getActivityDates(
      userId
    );

  const streak =
    calculateStreak(
      dates
    );

  const previousBest =
    Number(
      profile.best_streak_days || 0
    );

  await sql`
    UPDATE user_profiles

    SET
      streak_days =
        ${streak.current},

      best_streak_days =
        ${Math.max(
          previousBest,
          streak.best
        )},

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
  // レベル更新
  // -----------------------------------------

  const updatedProfileRows =
    await sql`
      SELECT xp
      FROM user_profiles

      WHERE telegram_user_id =
        ${userId}
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
      Math.max(
        previousBest,
        streak.best
      ),

    badges:
      earnedBadges
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

    try {

      // ---------------------------------------
      // GET
      // ---------------------------------------

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
          ...data
        });
      }


      // ---------------------------------------
      // POST
      // ---------------------------------------

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
            ? JSON.parse(req.body)
            : (
                req.body || {}
              );

        const action =
          body.action ||
          "process";

        // -------------------------------------
        // 実績処理
        // -------------------------------------

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
                "resultId が不正です"
            });
          }

          const result =
            await processResult(
              user.id,
              resultId
            );

          return res.status(200).json({
            ok: true,
            ...result
          });
        }


        // -------------------------------------
        // プロフィール再計算
        // -------------------------------------

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
            ...data
          });
        }


        return res.status(400).json({
          ok: false,
          error:
            "action が不正です"
        });
      }


      return res.status(405).json({
        ok: false,
        error:
          "Method Not Allowed"
      });

    } catch (error) {

      console.error(
        "gamification API error:",
        error
      );

      return res.status(500).json({
        ok: false,
        error:
          error.message ||
          "ゲーミフィケーション処理に失敗しました"
      });
    }
  };

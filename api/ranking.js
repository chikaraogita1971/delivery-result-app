const crypto = require("crypto");
const { neon } = require("@neondatabase/serverless");

const sql = neon(process.env.DATABASE_URL);

const BOT_TOKEN = process.env.BOT_TOKEN;
const JST = "Asia/Tokyo";

// =========================================================
// JSON
// =========================================================

function json(res, status, data) {
  return res.status(status).json(data);
}

// =========================================================
// Telegram WebApp 認証
// =========================================================

function verifyTelegramInitData(initData) {
  if (!BOT_TOKEN || !initData) {
    return null;
  }

  try {
    const params = new URLSearchParams(initData);

    const hash = params.get("hash");

    if (!hash) {
      return null;
    }

    params.delete("hash");

    const dataCheckString = [...params.entries()]
      .sort(([a], [b]) =>
        a.localeCompare(b)
      )
      .map(
        ([key, value]) =>
          `${key}=${value}`
      )
      .join("\n");

    const secretKey = crypto
      .createHmac(
        "sha256",
        "WebAppData"
      )
      .update(BOT_TOKEN)
      .digest();

    const calculatedHash = crypto
      .createHmac(
        "sha256",
        secretKey
      )
      .update(dataCheckString)
      .digest("hex");

    if (calculatedHash !== hash) {
      return null;
    }

    const authDate = Number(
      params.get("auth_date")
    );

    if (!authDate) {
      return null;
    }

    const now =
      Math.floor(
        Date.now() / 1000
      );

    if (
      now - authDate >
      3600
    ) {
      return null;
    }

    const user = JSON.parse(
      params.get("user") || "{}"
    );

    if (!user.id) {
      return null;
    }

    return {
      id: String(user.id),
      username:
        user.username || null,
      firstName:
        user.first_name || "",
      lastName:
        user.last_name || ""
    };

  } catch (error) {
    console.error(
      "Telegram auth error:",
      error
    );

    return null;
  }
}

// =========================================================
// 表示名
// =========================================================

function getDisplayName(user) {
  if (!user) {
    return "ユーザー";
  }

  const fullName = [
    user.firstName,
    user.lastName
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

  return `ID:${user.id}`;
}

// =========================================================
// 期間条件
// =========================================================

function getPeriodCondition(period) {
  switch (period) {

    case "today":
      return sql`
        (
          created_at
          AT TIME ZONE ${JST}
        )::date =
        (
          NOW()
          AT TIME ZONE ${JST}
        )::date
      `;

    case "week":
      return sql`
        (
          created_at
          AT TIME ZONE ${JST}
        )::date >=
        date_trunc(
          'week',
          (
            NOW()
            AT TIME ZONE ${JST}
          )::date
        )::date

        AND

        (
          created_at
          AT TIME ZONE ${JST}
        )::date <=
        (
          NOW()
          AT TIME ZONE ${JST}
        )::date
      `;

    case "month":
      return sql`
        (
          created_at
          AT TIME ZONE ${JST}
        )::date >=
        date_trunc(
          'month',
          (
            NOW()
            AT TIME ZONE ${JST}
          )::date
        )::date

        AND

        (
          created_at
          AT TIME ZONE ${JST}
        )::date <=
        (
          NOW()
          AT TIME ZONE ${JST}
        )::date
      `;

    default:
      return null;
  }
}

// =========================================================
// ランキング取得
// =========================================================

module.exports = async function handler(
  req,
  res
) {
  // -------------------------------------------------------
  // GETのみ
  // -------------------------------------------------------

  if (req.method !== "GET") {
    return json(
      res,
      405,
      {
        ok: false,
        error: "Method Not Allowed"
      }
    );
  }

  // -------------------------------------------------------
  // Telegram認証
  // -------------------------------------------------------

  const user =
    verifyTelegramInitData(
      req.headers[
        "x-telegram-init-data"
      ]
    );

  if (!user) {
    return json(
      res,
      401,
      {
        ok: false,
        error: "Unauthorized"
      }
    );
  }

  // -------------------------------------------------------
  // 期間
  // -------------------------------------------------------

  const period =
    String(
      req.query?.period ||
      "month"
    ).toLowerCase();

  if (
    ![
      "today",
      "week",
      "month"
    ].includes(period)
  ) {
    return json(
      res,
      400,
      {
        ok: false,
        error:
          "periodはtoday / week / monthのいずれかです。"
      }
    );
  }

  try {
    const condition =
      getPeriodCondition(
        period
      );

    // -----------------------------------------------------
    // ランキング
    //
    // ユーザー単位で集計
    // -----------------------------------------------------

    const rankingResult =
      await sql`
        SELECT
          telegram_user_id,

          COALESCE(
            SUM(delivery_count),
            0
          ) AS count,

          COALESCE(
            SUM(sale_amount),
            0
          ) AS sales,

          COALESCE(
            SUM(work_hours),
            0
          ) AS hours,

          COUNT(
            DISTINCT (
              created_at
              AT TIME ZONE ${JST}
            )::date
          ) AS work_days

        FROM delivery_results

        WHERE
          ${condition}

        GROUP BY
          telegram_user_id

        ORDER BY
          count DESC,
          sales DESC,
          hours ASC
      `;

    // -----------------------------------------------------
    // Telegram IDから表示名を取得
    //
    // delivery_resultsだけではユーザー名を保存して
    // いないため、group_membersを利用できる場合は
    // そこから取得する。
    // -----------------------------------------------------

    const memberResult =
      await sql`
        SELECT
          telegram_user_id,
          username,
          first_name

        FROM group_members

        WHERE telegram_user_id IN (
          SELECT DISTINCT
            telegram_user_id

          FROM delivery_results

          WHERE
            ${condition}
        )
      `;

    const memberMap =
      new Map();

    for (
      const member
      of memberResult
    ) {
      memberMap.set(
        String(
          member.telegram_user_id
        ),
        member
      );
    }

    // -----------------------------------------------------
    // ランキング整形
    // -----------------------------------------------------

    const ranking =
      rankingResult.map(
        (row, index) => {

          const telegramUserId =
            String(
              row.telegram_user_id
            );

          const member =
            memberMap.get(
              telegramUserId
            );

          const displayName =
            member
              ? (
                  member.first_name ||
                  (
                    member.username
                      ? `@${member.username}`
                      : null
                  )
                )
              : (
                  telegramUserId ===
                  user.id
                    ? getDisplayName(
                        user
                      )
                    : `ユーザー ${telegramUserId.slice(-4)}`
                );

          const count =
            Number(
              row.count || 0
            );

          const sales =
            Number(
              row.sales || 0
            );

          const hours =
            Number(
              row.hours || 0
            );

          const workDays =
            Number(
              row.work_days || 0
            );

          const countPerHour =
            hours > 0
              ? count / hours
              : 0;

          const salesPerHour =
            hours > 0
              ? sales / hours
              : 0;

          return {
            rank:
              index + 1,

            telegramUserId,

            name:
              displayName,

            count,

            sales,

            hours,

            workDays,

            countPerHour,

            salesPerHour,

            isMe:
              telegramUserId ===
              user.id
          };
        }
      );

    // -----------------------------------------------------
    // 自分の順位
    // -----------------------------------------------------

    const myRankIndex =
      ranking.findIndex(
        (item) =>
          item.telegramUserId ===
          user.id
      );

    const myRank =
      myRankIndex >= 0
        ? myRankIndex + 1
        : null;

    const myData =
      myRankIndex >= 0
        ? ranking[myRankIndex]
        : {
            rank: null,
            telegramUserId:
              user.id,
            name:
              getDisplayName(
                user
              ),
            count: 0,
            sales: 0,
            hours: 0,
            workDays: 0,
            countPerHour: 0,
            salesPerHour: 0,
            isMe: true
          };

    // -----------------------------------------------------
    // 配達数ランキング
    // -----------------------------------------------------

    const countRanking =
      [...ranking]
        .sort(
          (a, b) => {

            if (
              b.count !==
              a.count
            ) {
              return (
                b.count -
                a.count
              );
            }

            return (
              b.sales -
              a.sales
            );
          }
        )
        .map(
          (item, index) => ({
            ...item,
            rank:
              index + 1
          })
        );

    // -----------------------------------------------------
    // 売上ランキング
    // -----------------------------------------------------

    const salesRanking =
      [...ranking]
        .sort(
          (a, b) => {

            if (
              b.sales !==
              a.sales
            ) {
              return (
                b.sales -
                a.sales
              );
            }

            return (
              b.count -
              a.count
            );
          }
        )
        .map(
          (item, index) => ({
            ...item,
            rank:
              index + 1
          })
        );

    // -----------------------------------------------------
    // 効率ランキング
    // -----------------------------------------------------

    const efficiencyRanking =
      [...ranking]
        .filter(
          (item) =>
            item.hours > 0
        )
        .sort(
          (a, b) =>
            b.countPerHour -
            a.countPerHour
        )
        .map(
          (item, index) => ({
            ...item,
            rank:
              index + 1
          })
        );

    // -----------------------------------------------------
    // TOP 20
    // -----------------------------------------------------

    return json(
      res,
      200,
      {
        ok: true,

        period,

        totalUsers:
          ranking.length,

        myRank,

        myData,

        ranking:
          ranking.slice(
            0,
            20
          ),

        countRanking:
          countRanking.slice(
            0,
            20
          ),

        salesRanking:
          salesRanking.slice(
            0,
            20
          ),

        efficiencyRanking:
          efficiencyRanking.slice(
            0,
            20
          )
      }
    );

  } catch (error) {

    console.error(
      "ranking error:",
      error
    );

    return json(
      res,
      500,
      {
        ok: false,
        error:
          "ランキングの取得に失敗しました。"
      }
    );
  }
};

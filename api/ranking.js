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
    !crypto.timingSafeEqual(
      Buffer.from(hash, "hex"),
      Buffer.from(calculatedHash, "hex")
    )
  ) {
    throw new Error("Telegram initData の検証に失敗しました");
  }

  const authDate = Number(params.get("auth_date"));

  if (!authDate) {
    throw new Error("auth_date がありません");
  }

  const age = Math.floor(Date.now() / 1000) - authDate;

  // 1時間以上古いinitDataは拒否
  if (age > 60 * 60) {
    throw new Error("Telegram initData の有効期限が切れています");
  }

  const userRaw = params.get("user");

  if (!userRaw) {
    throw new Error("Telegramユーザー情報がありません");
  }

  const user = JSON.parse(userRaw);

  if (!user?.id) {
    throw new Error("TelegramユーザーIDが取得できません");
  }

  return {
    id: String(user.id),
    username: user.username || "",
    firstName: user.first_name || "",
    lastName: user.last_name || ""
  };
}


// =========================================================
// 期間条件
// =========================================================

function getPeriodCondition(period) {
  switch (period) {

    case "today":
      return `
        created_at >=
        date_trunc('day', NOW() AT TIME ZONE '${JST}')
        AT TIME ZONE '${JST}'
      `;

    case "week":
      return `
        created_at >=
        date_trunc(
          'week',
          NOW() AT TIME ZONE '${JST}'
        ) AT TIME ZONE '${JST}'
      `;

    case "month":
      return `
        created_at >=
        date_trunc(
          'month',
          NOW() AT TIME ZONE '${JST}'
        ) AT TIME ZONE '${JST}'
      `;

    default:
      throw new Error(
        "period は today / week / month のいずれかです"
      );
  }
}


// =========================================================
// 表示名
// =========================================================

function getDisplayName(row) {
  if (row.first_name) {
    return row.first_name;
  }

  if (row.username) {
    return `@${row.username}`;
  }

  return `ユーザー${row.telegram_user_id}`;
}


// =========================================================
// ランキング取得
// =========================================================

async function getRanking(period, type) {

  const condition =
    getPeriodCondition(period);

  let orderBy;

  switch (type) {

    case "sales":
      orderBy = `
        total_sales DESC,
        total_count DESC,
        total_hours ASC
      `;
      break;

    case "efficiency":
      orderBy = `
        efficiency DESC,
        total_count DESC,
        total_sales DESC
      `;
      break;

    case "count":
    default:
      orderBy = `
        total_count DESC,
        total_sales DESC,
        total_hours ASC
      `;
      break;
  }

  const rows = await sql`
    WITH stats AS (
      SELECT
        telegram_user_id,

        COALESCE(
          SUM(sale_amount),
          0
        ) AS total_sales,

        COALESCE(
          SUM(delivery_count),
          0
        ) AS total_count,

        COALESCE(
          SUM(work_hours),
          0
        ) AS total_hours

      FROM delivery_results

      WHERE ${sql.unsafe(condition)}

      GROUP BY telegram_user_id
    ),

    members AS (
      SELECT DISTINCT ON (telegram_user_id)
        telegram_user_id,
        username,
        first_name

      FROM group_members

      ORDER BY
        telegram_user_id,
        updated_at DESC
    )

    SELECT
      stats.telegram_user_id,
      stats.total_sales,
      stats.total_count,
      stats.total_hours,

      CASE
        WHEN stats.total_hours > 0
        THEN
          stats.total_count / stats.total_hours
        ELSE 0
      END AS efficiency,

      members.username,
      members.first_name

    FROM stats

    LEFT JOIN members
      ON members.telegram_user_id =
         stats.telegram_user_id

    ORDER BY ${sql.unsafe(orderBy)}

    LIMIT 100
  `;

  return rows.map(
    (row, index) => ({
      rank: index + 1,

      telegramUserId:
        String(row.telegram_user_id),

      name:
        getDisplayName(row),

      username:
        row.username || "",

      count:
        Number(row.total_count || 0),

      sales:
        Number(row.total_sales || 0),

      hours:
        Number(row.total_hours || 0),

      efficiency:
        Number(
          row.efficiency || 0
        )
    })
  );
}


// =========================================================
// 自分の順位
// =========================================================

async function getMyRank(
  rankings,
  userId
) {

  const index =
    rankings.findIndex(
      item =>
        String(
          item.telegramUserId
        ) === String(userId)
    );

  if (index === -1) {
    return null;
  }

  return rankings[index];
}


// =========================================================
// GET
// =========================================================

module.exports = async function handler(
  req,
  res
) {

  if (req.method !== "GET") {
    return res.status(405).json({
      ok: false,
      error:
        "Method Not Allowed"
    });
  }

  try {

    // -----------------------------------------
    // Telegram認証
    // -----------------------------------------

    const initData =
      req.headers[
        "x-telegram-init-data"
      ];

    const user =
      verifyTelegramInitData(
        initData
      );

    // -----------------------------------------
    // パラメータ
    // -----------------------------------------

    const period =
      String(
        req.query?.period ||
        "month"
      );

    const type =
      String(
        req.query?.type ||
        "count"
      );

    if (
      ![
        "today",
        "week",
        "month"
      ].includes(period)
    ) {
      return res.status(400).json({
        ok: false,
        error:
          "period が不正です"
      });
    }

    if (
      ![
        "count",
        "sales",
        "efficiency"
      ].includes(type)
    ) {
      return res.status(400).json({
        ok: false,
        error:
          "type が不正です"
      });
    }

    // -----------------------------------------
    // ランキング
    // -----------------------------------------

    const rankings =
      await getRanking(
        period,
        type
      );

    const me =
      await getMyRank(
        rankings,
        user.id
      );

    // -----------------------------------------
    // 自分の順位が100位外の場合
    // -----------------------------------------

    let myRank = me;

    if (!myRank) {

      const condition =
        getPeriodCondition(
          period
        );

      const ownRows = await sql`
        SELECT
          COALESCE(
            SUM(sale_amount),
            0
          ) AS total_sales,

          COALESCE(
            SUM(delivery_count),
            0
          ) AS total_count,

          COALESCE(
            SUM(work_hours),
            0
          ) AS total_hours

        FROM delivery_results

        WHERE telegram_user_id =
          ${user.id}

        AND ${sql.unsafe(condition)}
      `;

      const own =
        ownRows[0];

      const ownSales =
        Number(
          own?.total_sales || 0
        );

      const ownCount =
        Number(
          own?.total_count || 0
        );

      const ownHours =
        Number(
          own?.total_hours || 0
        );

      const ownEfficiency =
        ownHours > 0
          ? ownCount / ownHours
          : 0;

      // 自分より上の人数を数える
      let higherCondition;

      switch (type) {

        case "sales":
          higherCondition = sql`
            SUM(sale_amount) >
            ${ownSales}
            OR (
              SUM(sale_amount) =
              ${ownSales}
              AND
              SUM(delivery_count) >
              ${ownCount}
            )
          `;
          break;

        case "efficiency":
          higherCondition = sql`
            CASE
              WHEN SUM(work_hours) > 0
              THEN
                SUM(delivery_count) /
                SUM(work_hours)
              ELSE 0
            END >
            ${ownEfficiency}
          `;
          break;

        case "count":
        default:
          higherCondition = sql`
            SUM(delivery_count) >
            ${ownCount}
            OR (
              SUM(delivery_count) =
              ${ownCount}
              AND
              SUM(sale_amount) >
              ${ownSales}
            )
          `;
          break;
      }

      const rankRows =
        await sql`
          SELECT COUNT(*) AS higher_users

          FROM (
            SELECT
              telegram_user_id

            FROM delivery_results

            WHERE ${sql.unsafe(condition)}

            GROUP BY telegram_user_id

            HAVING ${higherCondition}
          ) x
        `;

      const higherUsers =
        Number(
          rankRows[0]?.higher_users ||
          0
        );

      myRank = {
        rank:
          higherUsers + 1,

        telegramUserId:
          user.id,

        name:
          user.firstName ||
          (
            user.username
              ? `@${user.username}`
              : `ユーザー${user.id}`
          ),

        username:
          user.username || "",

        count:
          ownCount,

        sales:
          ownSales,

        hours:
          ownHours,

        efficiency:
          ownEfficiency
      };
    }

    // -----------------------------------------
    // レスポンス
    // -----------------------------------------

    return res.status(200).json({
      ok: true,

      period,

      type,

      me: myRank,

      myRank,

      rankings,

      // フロント側の互換用
      ranking: rankings,

      users: rankings
    });

  } catch (error) {

    console.error(
      "ranking API error:",
      error
    );

    return res.status(500).json({
      ok: false,

      error:
        error.message ||
        "ランキング取得に失敗しました"
    });
  }
};

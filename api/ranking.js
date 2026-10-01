const crypto = require("crypto");
const { neon } = require("@neondatabase/serverless");

const sql = neon(process.env.DATABASE_URL);

const BOT_TOKEN = process.env.BOT_TOKEN;
const JST = "Asia/Tokyo";

// =========================================================
// Telegram initData 検証
// =========================================================

function validateTelegramInitData(initData) {
  if (!initData || !BOT_TOKEN) {
    throw new Error("Telegram認証情報がありません");
  }

  const params = new URLSearchParams(initData);
  const hash = params.get("hash");

  if (!hash) {
    throw new Error("Telegram hash がありません");
  }

  const authDate = Number(params.get("auth_date"));

  if (!authDate) {
    throw new Error("Telegram auth_date がありません");
  }

  const now = Math.floor(Date.now() / 1000);

  // 1時間以上古いinitDataは拒否
  if (now - authDate > 60 * 60) {
    throw new Error(
      "Telegram認証の有効期限が切れています"
    );
  }

  params.delete("hash");

  const dataCheckString = [...params.entries()]
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

  if (calculatedHash.length !== hash.length) {
    throw new Error("Telegram認証に失敗しました");
  }

  if (
    !crypto.timingSafeEqual(
      Buffer.from(calculatedHash, "utf8"),
      Buffer.from(hash, "utf8")
    )
  ) {
    throw new Error("Telegram認証に失敗しました");
  }

  const userRaw = params.get("user");

  if (!userRaw) {
    throw new Error(
      "Telegramユーザー情報がありません"
    );
  }

  let user;

  try {
    user = JSON.parse(userRaw);
  } catch {
    throw new Error(
      "Telegramユーザー情報が不正です"
    );
  }

  if (!user?.id) {
    throw new Error(
      "TelegramユーザーIDがありません"
    );
  }

  return String(user.id);
}

// =========================================================
// 期間条件
// =========================================================

function getPeriodCondition(period) {
  switch (period) {
    case "today":
      return `
        DATE(
          created_at AT TIME ZONE '${JST}'
        ) =
        DATE(
          NOW() AT TIME ZONE '${JST}'
        )
      `;

    case "week":
      return `
        (
          created_at AT TIME ZONE '${JST}'
        )::date >=
        (
          DATE(
            NOW() AT TIME ZONE '${JST}'
          )
          -
          (
            EXTRACT(
              DOW FROM
              NOW() AT TIME ZONE '${JST}'
            )::integer
          )
        )
      `;

    case "month":
      return `
        DATE_TRUNC(
          'month',
          created_at AT TIME ZONE '${JST}'
        )
        =
        DATE_TRUNC(
          'month',
          NOW() AT TIME ZONE '${JST}'
        )
      `;

    default:
      throw new Error(
        "期間指定が不正です"
      );
  }
}

// =========================================================
// 名前
// =========================================================

function getDisplayName(row) {
  if (row.first_name) {
    if (row.username) {
      return `${row.first_name} (@${row.username})`;
    }

    return row.first_name;
  }

  if (row.username) {
    return `@${row.username}`;
  }

  return `ユーザー ${row.telegram_user_id}`;
}

// =========================================================
// 効率計算
// =========================================================

function calculateEfficiency(count, hours) {
  const c = Number(count || 0);
  const h = Number(hours || 0);

  if (h <= 0) {
    return 0;
  }

  return c / h;
}

// =========================================================
// ランキング生成
// =========================================================

async function buildRanking(period, chatId) {
  const condition = getPeriodCondition(period);

  /*
   * chatId がある場合
   *
   * → そのグループの実績だけを対象
   *
   * chatId がない場合
   *
   * → ユーザー本人の実績だけを返す
   *
   * Mini Appの通常ランキングでは
   * グループIDを取得できる場合に
   * グループランキングとして利用する。
   */

  let rows;

  if (chatId) {
    rows = await sql`
      SELECT
        gm.telegram_user_id,
        gm.username,
        gm.first_name,

        COALESCE(
          SUM(dr.delivery_count),
          0
        ) AS delivery_count,

        COALESCE(
          SUM(dr.sale_amount),
          0
        ) AS sale_amount,

        COALESCE(
          SUM(dr.work_hours),
          0
        ) AS work_hours

      FROM group_members gm

      LEFT JOIN delivery_results dr
        ON dr.telegram_user_id =
          gm.telegram_user_id
       AND dr.chat_id =
          ${chatId}
       AND ${sql.unsafe(condition)}

      WHERE gm.chat_id =
        ${chatId}

        -- Botアカウントをランキングから除外
        AND COALESCE(gm.username, '') <> 'delivery_result_bot'
        AND COALESCE(gm.username, '') <> 'GroupAnonymousBot'

        -- Bot IDでも確実に除外
        AND gm.telegram_user_id NOT IN (
          '8981642532',
          '1087968824'
        )

      GROUP BY
        gm.telegram_user_id,
        gm.username,
        gm.first_name

      ORDER BY
        delivery_count DESC,
        sale_amount DESC,
        work_hours ASC
    `;
  } else {
    rows = await sql`
      SELECT
        telegram_user_id,

        NULL::text AS username,
        NULL::text AS first_name,

        COALESCE(
          SUM(delivery_count),
          0
        ) AS delivery_count,

        COALESCE(
          SUM(sale_amount),
          0
        ) AS sale_amount,

        COALESCE(
          SUM(work_hours),
          0
        ) AS work_hours

      FROM delivery_results

      WHERE ${sql.unsafe(condition)}

      GROUP BY
        telegram_user_id

      ORDER BY
        delivery_count DESC,
        sale_amount DESC,
        work_hours ASC
    `;
  }

  return rows.map((row, index) => {
    const count =
      Number(
        row.delivery_count || 0
      );

    const sales =
      Number(
        row.sale_amount || 0
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
        getDisplayName(row),

      count,

      sales,

      hours,

      efficiency:
        Number(
          calculateEfficiency(
            count,
            hours
          ).toFixed(2)
        )
    };
  });
}

// =========================================================
// API
// =========================================================

module.exports = async function handler(req, res) {
  try {
    // -----------------------------------------------------
    // CORS
    // -----------------------------------------------------

    res.setHeader(
      "Access-Control-Allow-Origin",
      "*"
    );

    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, X-Telegram-Init-Data"
    );

    res.setHeader(
      "Access-Control-Allow-Methods",
      "GET, OPTIONS"
    );

    if (req.method === "OPTIONS") {
      return res
        .status(200)
        .json({
          ok: true
        });
    }

    if (req.method !== "GET") {
      return res
        .status(405)
        .json({
          ok: false,
          error: "Method Not Allowed"
        });
    }

    // -----------------------------------------------------
    // Telegram認証
    // -----------------------------------------------------

    const initData =
      req.headers[
        "x-telegram-init-data"
      ];

    const userId =
      validateTelegramInitData(
        initData
      );

    // -----------------------------------------------------
    // パラメータ
    // -----------------------------------------------------

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
      return res
        .status(400)
        .json({
          ok: false,
          error:
            "period は today / week / month のいずれかです"
        });
    }

    // -----------------------------------------------------
    // グループ取得
    // -----------------------------------------------------

    /*
     * 現在ユーザーが所属している
     * グループを取得。
     *
     * 複数グループ対応もできるよう
     * 最初の1グループを利用。
     */

    const memberRows =
      await sql`
        SELECT
          chat_id,
          username,
          first_name
        FROM group_members
        WHERE telegram_user_id =
          ${userId}
        ORDER BY
          joined_at ASC
        LIMIT 1
      `;

    const chatId =
      memberRows.length > 0
        ? memberRows[0].chat_id
        : null;

    // -----------------------------------------------------
    // ランキング
    // -----------------------------------------------------

    const rankings =
      await buildRanking(
        period,
        chatId
      );

    // -----------------------------------------------------
    // 自分の順位
    // -----------------------------------------------------

    const myRank =
      rankings.find(
        item =>
          String(
            item.telegramUserId
          ) ===
          String(userId)
      ) || null;

    // -----------------------------------------------------
    // タイプ別ランキング
    // -----------------------------------------------------

    const countRanking =
      [...rankings]
        .sort(
          (a, b) =>
            b.count - a.count ||
            b.sales - a.sales
        )
        .map(
          (item, index) => ({
            ...item,
            rank: index + 1
          })
        );

    const salesRanking =
      [...rankings]
        .sort(
          (a, b) =>
            b.sales - a.sales ||
            b.count - a.count
        )
        .map(
          (item, index) => ({
            ...item,
            rank: index + 1
          })
        );

    const efficiencyRanking =
      [...rankings]
        .sort(
          (a, b) =>
            b.efficiency -
              a.efficiency ||
            b.count -
              a.count
        )
        .map(
          (item, index) => ({
            ...item,
            rank: index + 1
          })
        );

    // -----------------------------------------------------
    // 自分の各順位
    // -----------------------------------------------------

    const myCountRank =
      countRanking.find(
        item =>
          item.telegramUserId ===
          userId
      ) || null;

    const mySalesRank =
      salesRanking.find(
        item =>
          item.telegramUserId ===
          userId
      ) || null;

    const myEfficiencyRank =
      efficiencyRanking.find(
        item =>
          item.telegramUserId ===
          userId
      ) || null;

    // -----------------------------------------------------
    // レスポンス
    // -----------------------------------------------------

    return res
      .status(200)
      .json({
        ok: true,

        period,

        chatId,

        totalUsers:
          rankings.length,

        // 基本ランキング
        rankings,

        // 種類別
        countRanking,
        salesRanking,
        efficiencyRanking,

        // 自分
        me: myRank,

        myRank: myRank,

        myRanks: {
          count:
            myCountRank
              ? myCountRank.rank
              : null,

          sales:
            mySalesRank
              ? mySalesRank.rank
              : null,

          efficiency:
            myEfficiencyRank
              ? myEfficiencyRank.rank
              : null
        }
      });

  } catch (error) {
    console.error(
      "ranking API error:",
      error
    );

    return res
      .status(500)
      .json({
        ok: false,
        error:
          error.message ||
          "ランキング取得に失敗しました"
      });
  }
};

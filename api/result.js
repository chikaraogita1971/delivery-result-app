import { neon } from "@neondatabase/serverless";
import crypto from "crypto";

const sql = neon(process.env.POSTGRES_URL);

const TIME_ZONE = "Asia/Tokyo";
const MAX_AUTH_AGE_SECONDS = 60 * 60;

/*
============================================================
Telegram Mini App initData 検証
============================================================
*/

function validateTelegramInitData(initData) {
  if (!initData || typeof initData !== "string") {
    throw new Error(
      "Telegram initData がありません。"
    );
  }

  const params = new URLSearchParams(initData);

  const receivedHash = params.get("hash");

  if (!receivedHash) {
    throw new Error(
      "Telegram hash がありません。"
    );
  }

  params.delete("hash");

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

  /*
  ============================================================
  Telegram Mini App 公式署名方式
  ============================================================
  */

  const secretKey = crypto
    .createHmac("sha256", "WebAppData")
    .update(process.env.BOT_TOKEN)
    .digest();

  const calculatedHash = crypto
    .createHmac("sha256", secretKey)
    .update(dataCheckString)
    .digest("hex");

  const receivedBuffer = Buffer.from(
    receivedHash,
    "hex"
  );

  const calculatedBuffer = Buffer.from(
    calculatedHash,
    "hex"
  );

  if (
    receivedBuffer.length !== calculatedBuffer.length ||
    !crypto.timingSafeEqual(
      receivedBuffer,
      calculatedBuffer
    )
  ) {
    throw new Error(
      "Telegram initData の署名が不正です。"
    );
  }

  /*
  ============================================================
  auth_date 有効期限
  ============================================================
  */

  const authDate = Number(
    params.get("auth_date")
  );

  if (
    !Number.isInteger(authDate) ||
    authDate <= 0
  ) {
    throw new Error(
      "Telegram auth_date が不正です。"
    );
  }

  const now = Math.floor(
    Date.now() / 1000
  );

  if (
    now - authDate > MAX_AUTH_AGE_SECONDS
  ) {
    throw new Error(
      "Telegram initData の有効期限が切れています。"
    );
  }

  /*
  ============================================================
  Telegramユーザー情報
  ============================================================
  */

  const userJson = params.get("user");

  if (!userJson) {
    throw new Error(
      "Telegramユーザー情報がありません。"
    );
  }

  let user;

  try {
    user = JSON.parse(userJson);
  } catch {
    throw new Error(
      "Telegramユーザー情報を解析できません。"
    );
  }

  if (!user?.id) {
    throw new Error(
      "TelegramユーザーIDがありません。"
    );
  }

  return String(user.id);
}

/*
============================================================
期間の開始・終了日時を取得
============================================================

day   : 今日
week  : 今週（月曜開始）
month : 今月
year  : 今年

すべて Asia/Tokyo 基準。
============================================================
*/

function getPeriodCondition(period) {
  switch (period) {
    /*
    ==========================================================
    日
    ==========================================================
    */

    case "day":
      return {
        start: sql`
          date_trunc(
            'day',
            CURRENT_TIMESTAMP AT TIME ZONE ${TIME_ZONE}
          ) AT TIME ZONE ${TIME_ZONE}
        `,
        end: sql`
          (
            date_trunc(
              'day',
              CURRENT_TIMESTAMP AT TIME ZONE ${TIME_ZONE}
            ) + INTERVAL '1 day'
          ) AT TIME ZONE ${TIME_ZONE}
        `
      };

    /*
    ==========================================================
    週
    ==========================================================
    */

    case "week":
      return {
        start: sql`
          (
            date_trunc(
              'week',
              CURRENT_TIMESTAMP AT TIME ZONE ${TIME_ZONE}
            )
          ) AT TIME ZONE ${TIME_ZONE}
        `,
        end: sql`
          (
            date_trunc(
              'week',
              CURRENT_TIMESTAMP AT TIME ZONE ${TIME_ZONE}
            ) + INTERVAL '1 week'
          ) AT TIME ZONE ${TIME_ZONE}
        `
      };

    /*
    ==========================================================
    月
    ==========================================================
    */

    case "month":
      return {
        start: sql`
          (
            date_trunc(
              'month',
              CURRENT_TIMESTAMP AT TIME ZONE ${TIME_ZONE}
            )
          ) AT TIME ZONE ${TIME_ZONE}
        `,
        end: sql`
          (
            date_trunc(
              'month',
              CURRENT_TIMESTAMP AT TIME ZONE ${TIME_ZONE}
            ) + INTERVAL '1 month'
          ) AT TIME ZONE ${TIME_ZONE}
        `
      };

    /*
    ==========================================================
    年
    ==========================================================
    */

    case "year":
      return {
        start: sql`
          (
            date_trunc(
              'year',
              CURRENT_TIMESTAMP AT TIME ZONE ${TIME_ZONE}
            )
          ) AT TIME ZONE ${TIME_ZONE}
        `,
        end: sql`
          (
            date_trunc(
              'year',
              CURRENT_TIMESTAMP AT TIME ZONE ${TIME_ZONE}
            ) + INTERVAL '1 year'
          ) AT TIME ZONE ${TIME_ZONE}
        `
      };

    default:
      throw new Error(
        "period は day / week / month / year のいずれかです。"
      );
  }
}

/*
============================================================
API
============================================================
*/

export default async function handler(req, res) {

  /*
  ============================================================
  GETのみ許可
  ============================================================
  */

  if (req.method !== "GET") {
    return res.status(405).json({
      ok: false,
      error: "Method Not Allowed"
    });
  }

  try {

    /*
    ============================================================
    Telegram initData
    ============================================================
    */

    const initData =
      req.headers["x-telegram-init-data"];

    if (!initData) {
      return res.status(401).json({
        ok: false,
        error:
          "Telegram認証情報がありません。"
      });
    }

    /*
    ============================================================
    Telegram本人確認
    ============================================================
    */

    const telegramUserId =
      validateTelegramInitData(initData);

    /*
    ============================================================
    period
    ============================================================
    */

    const requestedPeriod =
      Array.isArray(req.query?.period)
        ? req.query.period[0]
        : req.query?.period;

    const period =
      requestedPeriod || "day";

    if (
      ![
        "day",
        "week",
        "month",
        "year"
      ].includes(period)
    ) {
      return res.status(400).json({
        ok: false,
        error:
          "period は day / week / month / year のいずれかです。"
      });
    }

    /*
    ============================================================
    期間
    ============================================================
    */

    const {
      start,
      end
    } = getPeriodCondition(period);

    /*
    ============================================================
    期間集計
    ============================================================
    */

    const aggregateRows = await sql`
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

        COUNT(
          DISTINCT (
            created_at AT TIME ZONE ${TIME_ZONE}
          )::date
        ) AS work_days,

        COALESCE(
          MAX(sale_amount),
          0
        ) AS max_sales,

        COALESCE(
          MAX(delivery_count),
          0
        ) AS max_count

      FROM delivery_results

      WHERE telegram_user_id =
        ${telegramUserId}

        AND created_at >= ${start}

        AND created_at < ${end}
    `;

    const aggregate =
      aggregateRows[0] || {};

    const sales =
      Number(aggregate.sales || 0);

    const count =
      Number(aggregate.count || 0);

    const hours =
      Number(aggregate.hours || 0);

    const workDays =
      Number(aggregate.work_days || 0);

    const maxSales =
      Number(aggregate.max_sales || 0);

    const maxCount =
      Number(aggregate.max_count || 0);

    /*
    ============================================================
    平均単価
    ============================================================
    */

    const average =
      count > 0
        ? sales / count
        : 0;

    /*
    ============================================================
    月間目標
    ============================================================

    現在設定されている月間目標を取得。
    リセットでは削除されません。
    ============================================================
    */

    const goalRows = await sql`
      SELECT monthly_goal

      FROM delivery_goals

      WHERE telegram_user_id =
        ${telegramUserId}

      LIMIT 1
    `;

    const goal =
      Number(
        goalRows[0]?.monthly_goal || 0
      );

    /*
    ============================================================
    目標達成率
    ============================================================
    */

    const rate =
      goal > 0
        ? (sales / goal) * 100
        : 0;

    /*
    ============================================================
    累計件数
    ============================================================
    */

    const totalRows = await sql`
      SELECT
        COALESCE(
          SUM(delivery_count),
          0
        ) AS total_count

      FROM delivery_results

      WHERE telegram_user_id =
        ${telegramUserId}
    `;

    const totalCount =
      Number(
        totalRows[0]?.total_count || 0
      );

    /*
    ============================================================
    最新20件
    ============================================================
    */

    const recordRows = await sql`
      SELECT
        id,
        sale_amount,
        delivery_count,
        work_hours,
        created_at

      FROM delivery_results

      WHERE telegram_user_id =
        ${telegramUserId}

        AND created_at >= ${start}

        AND created_at < ${end}

      ORDER BY
        created_at DESC,
        id DESC

      LIMIT 20
    `;

    const records =
      recordRows.map(row => ({
        id: Number(row.id),

        sale: Number(
          row.sale_amount
        ),

        count: Number(
          row.delivery_count
        ),

        hours: Number(
          row.work_hours
        ),

        createdAt:
          row.created_at
      }));

    /*
    ============================================================
    JSONレスポンス
    ============================================================
    */

    return res.status(200).json({
      ok: true,

      period,

      sales,

      count,

      hours,

      workDays,

      maxSales,

      maxCount,

      average,

      goal,

      rate,

      totalCount,

      records
    });

  } catch (error) {

    console.error(
      "Result API error:",
      error
    );

    return res.status(500).json({
      ok: false,
      error:
        error?.message ||
        "データ取得中にサーバーエラーが発生しました。"
    });
  }
}

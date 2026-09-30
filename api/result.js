import { neon } from "@neondatabase/serverless";
import crypto from "crypto";

const sql = neon(process.env.POSTGRES_URL);

const TIME_ZONE = "Asia/Tokyo";

/**
 * Telegram Mini App initData を検証する
 */
function validateTelegramInitData(initData) {
  if (!initData) {
    throw new Error("Missing Telegram initData");
  }

  const params = new URLSearchParams(initData);
  const receivedHash = params.get("hash");

  if (!receivedHash) {
    throw new Error("Missing hash");
  }

  params.delete("hash");

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

  const botToken = process.env.BOT_TOKEN;

  if (!botToken) {
    throw new Error("BOT_TOKEN is not configured");
  }

  // Telegram Mini Apps の公式仕様に従った secret key
  const secretKey = crypto
    .createHmac("sha256", "WebAppData")
    .update(botToken)
    .digest();

  const calculatedHash = crypto
    .createHmac("sha256", secretKey)
    .update(dataCheckString)
    .digest("hex");

  if (
    receivedHash.length !== calculatedHash.length ||
    !crypto.timingSafeEqual(
      Buffer.from(receivedHash),
      Buffer.from(calculatedHash)
    )
  ) {
    throw new Error("Invalid Telegram initData");
  }

  // auth_date の有効期限チェック
  const authDate = Number(params.get("auth_date"));

  if (!Number.isFinite(authDate)) {
    throw new Error("Invalid auth_date");
  }

  const now = Math.floor(Date.now() / 1000);

  // 1時間以上古い initData は拒否
  if (now - authDate > 60 * 60) {
    throw new Error("Expired Telegram initData");
  }

  const userJson = params.get("user");

  if (!userJson) {
    throw new Error("Missing Telegram user");
  }

  const user = JSON.parse(userJson);

  if (!user?.id) {
    throw new Error("Missing Telegram user id");
  }

  return String(user.id);
}

/**
 * 期間条件を JST 基準で作る
 *
 * PostgreSQL の TIMESTAMPTZ に対して、
 * Asia/Tokyo の日付境界を UTC の絶対時刻へ変換して比較する。
 */
function getPeriodCondition(period) {
  switch (period) {
    case "day":
      return {
        start: sql`
          (
            (CURRENT_TIMESTAMP AT TIME ZONE ${TIME_ZONE})::date
            AT TIME ZONE ${TIME_ZONE}
          )
        `,
        end: sql`
          (
            (
              (CURRENT_TIMESTAMP AT TIME ZONE ${TIME_ZONE})::date
              + INTERVAL '1 day'
            )
            AT TIME ZONE ${TIME_ZONE}
          )
        `,
      };

    case "week":
      return {
        start: sql`
          (
            date_trunc(
              'week',
              CURRENT_TIMESTAMP AT TIME ZONE ${TIME_ZONE}
            )
            AT TIME ZONE ${TIME_ZONE}
          )
        `,
        end: sql`
          (
            (
              date_trunc(
                'week',
                CURRENT_TIMESTAMP AT TIME ZONE ${TIME_ZONE}
              )
              + INTERVAL '1 week'
            )
            AT TIME ZONE ${TIME_ZONE}
          )
        `,
      };

    case "month":
      return {
        start: sql`
          (
            date_trunc(
              'month',
              CURRENT_TIMESTAMP AT TIME ZONE ${TIME_ZONE}
            )
            AT TIME ZONE ${TIME_ZONE}
          )
        `,
        end: sql`
          (
            (
              date_trunc(
                'month',
                CURRENT_TIMESTAMP AT TIME ZONE ${TIME_ZONE}
              )
              + INTERVAL '1 month'
            )
            AT TIME ZONE ${TIME_ZONE}
          )
        `,
      };

    case "year":
      return {
        start: sql`
          (
            date_trunc(
              'year',
              CURRENT_TIMESTAMP AT TIME ZONE ${TIME_ZONE}
            )
            AT TIME ZONE ${TIME_ZONE}
          )
        `,
        end: sql`
          (
            (
              date_trunc(
                'year',
                CURRENT_TIMESTAMP AT TIME ZONE ${TIME_ZONE}
              )
              + INTERVAL '1 year'
            )
            AT TIME ZONE ${TIME_ZONE}
          )
        `,
      };

    default:
      throw new Error("Invalid period");
  }
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({
      error: "Method Not Allowed",
    });
  }

  try {
    // Telegram が署名した initData からユーザーIDを取得
    // クライアントから user_id は受け取らない
    const initData = req.headers["x-telegram-init-data"];

    const userId = validateTelegramInitData(initData);

    const period = req.query?.period || "month";

    if (!["day", "week", "month", "year"].includes(period)) {
      return res.status(400).json({
        error: "Invalid period",
      });
    }

    const { start, end } = getPeriodCondition(period);

    /**
     * 指定期間の集計
     */
    const summaryRows = await sql`
      SELECT
        COALESCE(SUM(sale_amount), 0) AS sales,
        COALESCE(SUM(delivery_count), 0) AS delivery_count,
        COALESCE(SUM(work_hours), 0) AS work_hours,
        COUNT(DISTINCT (created_at AT TIME ZONE ${TIME_ZONE})::date) AS work_days
      FROM delivery_results
      WHERE telegram_user_id = ${userId}
        AND created_at >= ${start}
        AND created_at < ${end}
    `;

    const summary = summaryRows[0] || {};

    /**
     * 期間内の日別集計
     *
     * 日付は JST 基準で作る。
     */
    const dailyRows = await sql`
      SELECT
        (created_at AT TIME ZONE ${TIME_ZONE})::date AS work_date,
        COALESCE(SUM(sale_amount), 0) AS sales,
        COALESCE(SUM(delivery_count), 0) AS delivery_count
      FROM delivery_results
      WHERE telegram_user_id = ${userId}
        AND created_at >= ${start}
        AND created_at < ${end}
      GROUP BY (created_at AT TIME ZONE ${TIME_ZONE})::date
      ORDER BY work_date ASC
    `;

    /**
     * 期間内の最大売上・最大配達件数
     */
    let maxSales = 0;
    let maxCount = 0;

    for (const row of dailyRows) {
      const sales = Number(row.sales) || 0;
      const count = Number(row.delivery_count) || 0;

      if (sales > maxSales) {
        maxSales = sales;
      }

      if (count > maxCount) {
        maxCount = count;
      }
    }

    /**
     * 今月の目標
     *
     * 目標自体はユーザー単位なので、
     * JSTの月次集計と組み合わせて使用する。
     */
    const goalRows = await sql`
      SELECT monthly_goal
      FROM delivery_goals
      WHERE telegram_user_id = ${userId}
      LIMIT 1
    `;

    const monthlyGoal = Number(goalRows[0]?.monthly_goal) || 0;

    /**
     * 累計配達件数
     */
    const totalRows = await sql`
      SELECT
        COALESCE(SUM(delivery_count), 0) AS total_count
      FROM delivery_results
      WHERE telegram_user_id = ${userId}
    `;

    const totalCount = Number(totalRows[0]?.total_count) || 0;

    /**
     * 最新20件
     *
     * created_at 自体は TIMESTAMPTZ のまま返す。
     * フロント側で表示時に日本時間へ変換できる。
     */
    const recordRows = await sql`
      SELECT
        id,
        sale_amount,
        delivery_count,
        work_hours,
        created_at
      FROM delivery_results
      WHERE telegram_user_id = ${userId}
      ORDER BY created_at DESC
      LIMIT 20
    `;

    const sales = Number(summary.sales) || 0;
    const deliveryCount = Number(summary.delivery_count) || 0;
    const workHours = Number(summary.work_hours) || 0;
    const workDays = Number(summary.work_days) || 0;

    const average =
      deliveryCount > 0
        ? Math.round(sales / deliveryCount)
        : 0;

    /**
     * 達成率は今月の目標に対して計算
     */
    const rate =
      monthlyGoal > 0
        ? Math.round((sales / monthlyGoal) * 100)
        : 0;

    return res.status(200).json({
      period,

      sales,
      count: deliveryCount,
      hours: workHours,
      workDays,

      maxSales,
      maxCount,

      average,

      goal: monthlyGoal,
      rate,

      totalCount,

      records: recordRows.map((row) => ({
        id: Number(row.id),
        sale: Number(row.sale_amount),
        count: Number(row.delivery_count),
        hours: Number(row.work_hours),
        createdAt: row.created_at,
      })),
    });
  } catch (error) {
    console.error("result API error:", error);

    return res.status(500).json({
      error: "Internal Server Error",
    });
  }
}

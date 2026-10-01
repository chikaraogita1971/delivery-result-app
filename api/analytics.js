const crypto = require("crypto");
const { neon } = require("@neondatabase/serverless");

const sql = neon(process.env.DATABASE_URL);

const BOT_TOKEN = process.env.BOT_TOKEN;
const JST = "Asia/Tokyo";
const MAX_AUTH_AGE = 60 * 60;

function validateTelegramInitData(initData) {
  if (!initData) {
    throw new Error("Telegram initData がありません");
  }

  if (!BOT_TOKEN) {
    throw new Error("BOT_TOKEN が設定されていません");
  }

  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  const authDate = Number(params.get("auth_date"));

  if (!hash || !authDate) {
    throw new Error("Telegram initData が不正です");
  }

  const now = Math.floor(Date.now() / 1000);

  if (Math.abs(now - authDate) > MAX_AUTH_AGE) {
    throw new Error("Telegram initData の有効期限が切れています");
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

  const receivedBuffer = Buffer.from(hash, "hex");
  const calculatedBuffer = Buffer.from(calculatedHash, "hex");

  if (
    receivedBuffer.length !== calculatedBuffer.length ||
    !crypto.timingSafeEqual(receivedBuffer, calculatedBuffer)
  ) {
    throw new Error("Telegram initData の署名が不正です");
  }

  const userRaw = params.get("user");

  if (!userRaw) {
    throw new Error("Telegramユーザー情報がありません");
  }

  const user = JSON.parse(userRaw);

  if (!user.id) {
    throw new Error("TelegramユーザーIDが取得できません");
  }

  return String(user.id);
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "GET") {
    return res.status(405).json({
      ok: false,
      error: "Method Not Allowed",
    });
  }

  try {
    const initData =
      req.headers["x-telegram-init-data"] ||
      req.headers["X-Telegram-Init-Data"];

    const telegramUserId = validateTelegramInitData(initData);

    const rows = await sql`
      WITH base AS (
        SELECT
          sale_amount,
          delivery_count,
          work_hours,
          (created_at AT TIME ZONE ${JST})::date AS local_date
        FROM delivery_results
        WHERE telegram_user_id = ${telegramUserId}
      ),

      dates AS (
        SELECT
          (NOW() AT TIME ZONE ${JST})::date AS today,
          date_trunc(
            'week',
            (NOW() AT TIME ZONE ${JST})::timestamp
          )::date AS week_start,
          date_trunc(
            'month',
            (NOW() AT TIME ZONE ${JST})::timestamp
          )::date AS month_start
      ),

      summary AS (
        SELECT
          COALESCE(SUM(sale_amount) FILTER (
            WHERE local_date = today
          ), 0) AS today_sales,

          COALESCE(SUM(delivery_count) FILTER (
            WHERE local_date = today
          ), 0) AS today_count,

          COALESCE(SUM(work_hours) FILTER (
            WHERE local_date = today
          ), 0) AS today_hours,

          COALESCE(SUM(sale_amount) FILTER (
            WHERE local_date = today - INTERVAL '1 day'
          ), 0) AS yesterday_sales,

          COALESCE(SUM(delivery_count) FILTER (
            WHERE local_date = today - INTERVAL '1 day'
          ), 0) AS yesterday_count,

          COALESCE(SUM(delivery_count) FILTER (
            WHERE local_date >= week_start
          ), 0) AS week_count,

          COALESCE(SUM(sale_amount) FILTER (
            WHERE local_date >= week_start
          ), 0) AS week_sales,

          COALESCE(SUM(delivery_count) FILTER (
            WHERE local_date >= month_start
          ), 0) AS month_count,

          COALESCE(SUM(sale_amount) FILTER (
            WHERE local_date >= month_start
          ), 0) AS month_sales,

          COALESCE(SUM(work_hours) FILTER (
            WHERE local_date >= month_start
          ), 0) AS month_hours,

          COUNT(DISTINCT local_date) FILTER (
            WHERE local_date >= month_start
          ) AS month_work_days,

          COALESCE(SUM(delivery_count) FILTER (
            WHERE local_date >= month_start
              AND local_date < week_start
          ), 0) AS before_current_week_count

        FROM base
        CROSS JOIN dates
      )

      SELECT *
      FROM summary
    `;

    const goalRows = await sql`
      SELECT monthly_goal
      FROM delivery_goals
      WHERE telegram_user_id = ${telegramUserId}
      LIMIT 1
    `;

    const row = rows[0] || {};

    const goal = Number(
      goalRows[0]?.monthly_goal || 0
    );

    const todaySales = Number(row.today_sales || 0);
    const todayCount = Number(row.today_count || 0);
    const todayHours = Number(row.today_hours || 0);

    const yesterdaySales = Number(
      row.yesterday_sales || 0
    );

    const yesterdayCount = Number(
      row.yesterday_count || 0
    );

    const weekSales = Number(
      row.week_sales || 0
    );

    const weekCount = Number(
      row.week_count || 0
    );

    const monthSales = Number(
      row.month_sales || 0
    );

    const monthCount = Number(
      row.month_count || 0
    );

    const monthHours = Number(
      row.month_hours || 0
    );

    const monthWorkDays = Number(
      row.month_work_days || 0
    );

    // 平均単価
    const averageUnitPrice =
      monthCount > 0
        ? Math.round(monthSales / monthCount)
        : 0;

    // 1日平均
    const averageDailyCount =
      monthWorkDays > 0
        ? Math.round(monthCount / monthWorkDays)
        : 0;

    const averageDailySales =
      monthWorkDays > 0
        ? Math.round(monthSales / monthWorkDays)
        : 0;

    // JST現在日
    const nowJst = new Date(
      new Date().toLocaleString("en-US", {
        timeZone: JST,
      })
    );

    const currentDay = nowJst.getDate();

    const year = nowJst.getFullYear();
    const month = nowJst.getMonth();

    // 今月の日数
    const daysInMonth = new Date(
      year,
      month + 1,
      0
    ).getDate();

    const remainingDays =
      Math.max(daysInMonth - currentDay, 0);

    // 現在ペース
    const currentDailyPace =
      currentDay > 0
        ? monthCount / currentDay
        : 0;

    // 月末予測
    const projectedMonthCount = Math.round(
      currentDailyPace * daysInMonth
    );

    const projectedMonthSales = Math.round(
      monthSales / Math.max(currentDay, 1) *
      daysInMonth
    );

    // 目標達成率
    const goalRate =
      goal > 0
        ? Math.min(
            100,
            Math.round(
              (monthCount / goal) * 100
            )
          )
        : 0;

    // 残り必要件数
    const remainingGoalCount =
      Math.max(goal - monthCount, 0);

    // 目標達成に必要な1日平均
    const requiredDailyCount =
      remainingDays > 0
        ? Math.ceil(
            remainingGoalCount /
            remainingDays
          )
        : remainingGoalCount;

    // 前日比
    const salesChangeFromYesterday =
      yesterdaySales > 0
        ? Math.round(
            ((todaySales - yesterdaySales) /
              yesterdaySales) *
              100
          )
        : null;

    const countChangeFromYesterday =
      yesterdayCount > 0
        ? Math.round(
            ((todayCount - yesterdayCount) /
              yesterdayCount) *
              100
          )
        : null;

    return res.status(200).json({
      ok: true,

      today: {
        sales: todaySales,
        count: todayCount,
        hours: todayHours,
      },

      yesterday: {
        sales: yesterdaySales,
        count: yesterdayCount,
      },

      week: {
        sales: weekSales,
        count: weekCount,
      },

      month: {
        sales: monthSales,
        count: monthCount,
        hours: monthHours,
        workDays: monthWorkDays,
      },

      analysis: {
        averageUnitPrice,
        averageDailyCount,
        averageDailySales,
        currentDailyPace,
        projectedMonthCount,
        projectedMonthSales,
        remainingDays,
        remainingGoalCount,
        requiredDailyCount,
        goal,
        goalRate,
        salesChangeFromYesterday,
        countChangeFromYesterday,
      },
    });
  } catch (error) {
    console.error("analytics API error:", error);

    return res.status(401).json({
      ok: false,
      error:
        error.message ||
        "分析データの取得に失敗しました",
    });
  }
};

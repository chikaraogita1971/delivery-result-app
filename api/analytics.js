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

    const now = Math.floor(
      Date.now() / 1000
    );

    // 1時間以上古いinitDataは拒否
    if (now - authDate > 3600) {
      return null;
    }

    const user = JSON.parse(
      params.get("user") || "{}"
    );

    if (!user.id) {
      return null;
    }

    return String(user.id);

  } catch (error) {
    console.error(
      "Telegram auth error:",
      error
    );

    return null;
  }
}

// =========================================================
// メイン
// =========================================================

module.exports = async function handler(
  req,
  res
) {
  // GETのみ
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

  // Telegram認証
  const userId =
    verifyTelegramInitData(
      req.headers[
        "x-telegram-init-data"
      ]
    );

  if (!userId) {
    return json(
      res,
      401,
      {
        ok: false,
        error: "Unauthorized"
      }
    );
  }

  try {
    // =====================================================
    // 現在のJST情報
    // =====================================================

    const dateInfoResult =
      await sql`
        SELECT
          (
            NOW()
            AT TIME ZONE ${JST}
          )::date AS today,

          EXTRACT(
            DAY FROM
            (
              NOW()
              AT TIME ZONE ${JST}
            )::date
          )::int AS day_of_month,

          EXTRACT(
            DAY FROM
            (
              date_trunc(
                'month',
                NOW()
                AT TIME ZONE ${JST}
              )
              + INTERVAL '1 month - 1 day'
            )
          )::int AS days_in_month
      `;

    const dateInfo =
      dateInfoResult[0] || {};

    const today =
      dateInfo.today;

    const dayOfMonth =
      Number(
        dateInfo.day_of_month || 1
      );

    const daysInMonth =
      Number(
        dateInfo.days_in_month || 1
      );

    // =====================================================
    // 今日
    // =====================================================

    const todayResult =
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
          ) AS hours

        FROM delivery_results

        WHERE telegram_user_id =
          ${userId}

          AND (
            created_at
            AT TIME ZONE ${JST}
          )::date =
          ${today}::date
      `;

    // =====================================================
    // 昨日
    // =====================================================

    const yesterdayResult =
      await sql`
        SELECT
          COALESCE(
            SUM(sale_amount),
            0
          ) AS sales,

          COALESCE(
            SUM(delivery_count),
            0
          ) AS count

        FROM delivery_results

        WHERE telegram_user_id =
          ${userId}

          AND (
            created_at
            AT TIME ZONE ${JST}
          )::date =
          (
            ${today}::date
            - INTERVAL '1 day'
          )::date
      `;

    // =====================================================
    // 今週
    // PostgreSQLのweek = 月曜開始
    // =====================================================

    const weekResult =
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
          ) AS hours

        FROM delivery_results

        WHERE telegram_user_id =
          ${userId}

          AND (
            created_at
            AT TIME ZONE ${JST}
          )::date >=
          date_trunc(
            'week',
            ${today}::date
          )::date

          AND (
            created_at
            AT TIME ZONE ${JST}
          )::date <=
          ${today}::date
      `;

    // =====================================================
    // 今月
    // =====================================================

    const monthResult =
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

          COUNT(
            DISTINCT (
              created_at
              AT TIME ZONE ${JST}
            )::date
          ) AS work_days

        FROM delivery_results

        WHERE telegram_user_id =
          ${userId}

          AND (
            created_at
            AT TIME ZONE ${JST}
          )::date >=
          date_trunc(
            'month',
            ${today}::date
          )::date

          AND (
            created_at
            AT TIME ZONE ${JST}
          )::date <=
          ${today}::date
      `;

    // =====================================================
    // 月間目標
    // =====================================================

    const goalResult =
      await sql`
        SELECT
          monthly_goal

        FROM delivery_goals

        WHERE telegram_user_id =
          ${userId}

        LIMIT 1
      `;

    // =====================================================
    // 今月の日別データ
    // =====================================================

    const dailyResult =
      await sql`
        SELECT
          (
            created_at
            AT TIME ZONE ${JST}
          )::date AS date,

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
          ) AS hours

        FROM delivery_results

        WHERE telegram_user_id =
          ${userId}

          AND (
            created_at
            AT TIME ZONE ${JST}
          )::date >=
          date_trunc(
            'month',
            ${today}::date
          )::date

          AND (
            created_at
            AT TIME ZONE ${JST}
          )::date <=
          ${today}::date

        GROUP BY
          (
            created_at
            AT TIME ZONE ${JST}
          )::date

        ORDER BY
          date ASC
      `;

    // =====================================================
    // 数値化
    // =====================================================

    const todayData =
      todayResult[0] || {};

    const yesterdayData =
      yesterdayResult[0] || {};

    const weekData =
      weekResult[0] || {};

    const monthData =
      monthResult[0] || {};

    const goal =
      Number(
        goalResult[0]?.monthly_goal || 0
      );

    const todaySales =
      Number(
        todayData.sales || 0
      );

    const todayCount =
      Number(
        todayData.count || 0
      );

    const todayHours =
      Number(
        todayData.hours || 0
      );

    const yesterdaySales =
      Number(
        yesterdayData.sales || 0
      );

    const yesterdayCount =
      Number(
        yesterdayData.count || 0
      );

    const weekSales =
      Number(
        weekData.sales || 0
      );

    const weekCount =
      Number(
        weekData.count || 0
      );

    const weekHours =
      Number(
        weekData.hours || 0
      );

    const monthSales =
      Number(
        monthData.sales || 0
      );

    const monthCount =
      Number(
        monthData.count || 0
      );

    const monthHours =
      Number(
        monthData.hours || 0
      );

    const workDays =
      Number(
        monthData.work_days || 0
      );

    // =====================================================
    // 日別データ整形
    // =====================================================

    const daily =
      dailyResult.map(
        (row) => {
          const sales =
            Number(
              row.sales || 0
            );

          const count =
            Number(
              row.count || 0
            );

          const hours =
            Number(
              row.hours || 0
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
            date: row.date,

            sales,

            count,

            hours,

            countPerHour,

            salesPerHour
          };
        }
      );

    // =====================================================
    // 自己ベスト
    //
    // 今月の日別実績を基準にする
    // =====================================================

    let bestCount = 0;
    let bestCountDate = null;

    let bestSales = 0;
    let bestSalesDate = null;

    let bestCountPerHour = 0;
    let bestCountPerHourDate = null;

    let bestSalesPerHour = 0;
    let bestSalesPerHourDate = null;

    for (const day of daily) {

      // 配達数ベスト
      if (
        day.count >
        bestCount
      ) {
        bestCount =
          day.count;

        bestCountDate =
          day.date;
      }

      // 売上ベスト
      if (
        day.sales >
        bestSales
      ) {
        bestSales =
          day.sales;

        bestSalesDate =
          day.date;
      }

      // 配達効率ベスト
      if (
        day.countPerHour >
        bestCountPerHour
      ) {
        bestCountPerHour =
          day.countPerHour;

        bestCountPerHourDate =
          day.date;
      }

      // 売上効率ベスト
      if (
        day.salesPerHour >
        bestSalesPerHour
      ) {
        bestSalesPerHour =
          day.salesPerHour;

        bestSalesPerHourDate =
          day.date;
      }
    }

    // =====================================================
    // 今日の効率
    // =====================================================

    const todayCountPerHour =
      todayHours > 0
        ? todayCount /
          todayHours
        : 0;

    const todaySalesPerHour =
      todayHours > 0
        ? todaySales /
          todayHours
        : 0;

    // =====================================================
    // 月間平均
    // =====================================================

    const averageDailyCount =
      monthCount /
      Math.max(
        1,
        dayOfMonth
      );

    const averageDailySales =
      monthSales /
      Math.max(
        1,
        dayOfMonth
      );

    // =====================================================
    // 現在ペース
    // =====================================================

    const currentDailyPace =
      averageDailyCount;

    // =====================================================
    // 月末予測
    // =====================================================

    const projectedMonthCount =
      currentDailyPace *
      daysInMonth;

    const projectedMonthSales =
      averageDailySales *
      daysInMonth;

    // =====================================================
    // 残り日数
    // =====================================================

    const remainingDays =
      Math.max(
        0,
        daysInMonth -
          dayOfMonth
      );

    // =====================================================
    // 目標関連
    // =====================================================

    const remainingGoalCount =
      Math.max(
        0,
        goal -
          monthCount
      );

    const requiredDailyCount =
      remainingDays > 0
        ? remainingGoalCount /
          remainingDays
        : remainingGoalCount;

    const goalRate =
      goal > 0
        ? (
            monthCount /
            goal
          ) *
          100
        : 0;

    // =====================================================
    // 単価
    // =====================================================

    const averageUnitPrice =
      monthCount > 0
        ? monthSales /
          monthCount
        : 0;

    // =====================================================
    // 前日比較
    // =====================================================

    const salesChangeFromYesterday =
      todaySales -
      yesterdaySales;

    const countChangeFromYesterday =
      todayCount -
      yesterdayCount;

    // =====================================================
    // 月間効率
    // =====================================================

    const countPerHour =
      monthHours > 0
        ? monthCount /
          monthHours
        : 0;

    const salesPerHour =
      monthHours > 0
        ? monthSales /
          monthHours
        : 0;

    // =====================================================
    // レスポンス
    // =====================================================

    return json(
      res,
      200,
      {
        ok: true,

        today: {
          sales:
            todaySales,

          count:
            todayCount,

          hours:
            todayHours
        },

        yesterday: {
          sales:
            yesterdaySales,

          count:
            yesterdayCount
        },

        week: {
          sales:
            weekSales,

          count:
            weekCount,

          hours:
            weekHours
        },

        month: {
          sales:
            monthSales,

          count:
            monthCount,

          hours:
            monthHours,

          workDays
        },

        goal,

        analysis: {
          // -----------------------------
          // 平均
          // -----------------------------

          averageDailyCount,

          averageDailySales,

          averageUnitPrice,

          // -----------------------------
          // ペース
          // -----------------------------

          currentDailyPace,

          projectedMonthCount,

          projectedMonthSales,

          // -----------------------------
          // 目標
          // -----------------------------

          remainingDays,

          remainingGoalCount,

          requiredDailyCount,

          goalRate,

          // -----------------------------
          // 前日比較
          // -----------------------------

          salesChangeFromYesterday,

          countChangeFromYesterday,

          // -----------------------------
          // 効率
          // -----------------------------

          countPerHour,

          salesPerHour,

          todayCountPerHour,

          todaySalesPerHour,

          // -----------------------------
          // 自己ベスト
          // -----------------------------

          bestCount,

          bestSales,

          bestCountPerHour,

          bestSalesPerHour,

          // -----------------------------
          // 自己ベスト日
          // -----------------------------

          bestDayCount:
            bestCount,

          bestDayCountDate:
            bestCountDate,

          bestDaySales:
            bestSales,

          bestDaySalesDate:
            bestSalesDate,

          // -----------------------------
          // ベスト効率の日
          // -----------------------------

          bestCountPerHourDate,

          bestSalesPerHourDate,

          // -----------------------------
          // 月情報
          // -----------------------------

          elapsedDays:
            dayOfMonth,

          daysInMonth
        },

        // -----------------------------
        // 今月の日別データ
        // -----------------------------

        daily
      }
    );

  } catch (error) {
    console.error(
      "analytics error:",
      error
    );

    return json(
      res,
      500,
      {
        ok: false,
        error:
          "分析データの取得に失敗しました。"
      }
    );
  }
};

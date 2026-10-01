const { neon } = require("@neondatabase/serverless");
const crypto = require("crypto");

const sql = neon(process.env.DATABASE_URL);

const BOT_TOKEN = process.env.BOT_TOKEN;
const JST = "Asia/Tokyo";


// =========================================================
// Telegram initData 認証
// =========================================================

function validateTelegramInitData(initData) {
  if (!initData || !BOT_TOKEN) {
    return null;
  }

  const params = new URLSearchParams(initData);
  const hash = params.get("hash");

  if (!hash) {
    return null;
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

  if (
    !crypto.timingSafeEqual(
      Buffer.from(calculatedHash, "hex"),
      Buffer.from(hash, "hex")
    )
  ) {
    return null;
  }

  const authDate = Number(
    params.get("auth_date")
  );

  if (
    !Number.isFinite(authDate) ||
    Math.floor(Date.now() / 1000) - authDate > 3600
  ) {
    return null;
  }

  const userRaw = params.get("user");

  if (!userRaw) {
    return null;
  }

  try {
    return JSON.parse(userRaw);
  } catch {
    return null;
  }
}


// =========================================================
// JST日付
// =========================================================

function getJSTDateString(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: JST,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
}


function formatJSTDate(date) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: JST,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
}


function getJSTPreviousDate(dateString) {
  const date = new Date(
    `${dateString}T00:00:00+09:00`
  );

  date.setDate(
    date.getDate() - 1
  );

  return formatJSTDate(date);
}


function getJSTMonthStart(dateString) {
  return `${dateString.slice(0, 7)}-01`;
}


function getJSTMonthEnd(dateString) {
  const year =
    Number(dateString.slice(0, 4));

  const month =
    Number(dateString.slice(5, 7));

  const date = new Date(
    `${year}-${String(
      month + 1
    ).padStart(2, "0")}-01T00:00:00+09:00`
  );

  date.setDate(0);

  return formatJSTDate(date);
}


function getJSTWeekStart(dateString) {
  const date = new Date(
    `${dateString}T00:00:00+09:00`
  );

  const day =
    date.getDay();

  const diff =
    day === 0
      ? 6
      : day - 1;

  date.setDate(
    date.getDate() - diff
  );

  return formatJSTDate(date);
}


// =========================================================
// 前月
// =========================================================

function getPreviousMonthRange(dateString) {
  const year =
    Number(dateString.slice(0, 4));

  const month =
    Number(dateString.slice(5, 7));

  const previousMonth =
    new Date(
      Date.UTC(
        year,
        month - 2,
        1
      )
    );

  const previousYear =
    previousMonth.getUTCFullYear();

  const previousMonthNumber =
    previousMonth.getUTCMonth() + 1;

  const lastDay =
    new Date(
      Date.UTC(
        previousYear,
        previousMonthNumber,
        0
      )
    ).getUTCDate();

  const monthText =
    String(
      previousMonthNumber
    ).padStart(2, "0");

  return {
    start:
      `${previousYear}-${monthText}-01`,

    end:
      `${previousYear}-${monthText}-${String(
        lastDay
      ).padStart(2, "0")}`
  };
}


// =========================================================
// 集計
// =========================================================

async function getStats(
  userId,
  startDate,
  endDate
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
      ${String(userId)}

      AND (
        created_at AT TIME ZONE ${JST}
      )::date >= ${startDate}::date

      AND (
        created_at AT TIME ZONE ${JST}
      )::date <= ${endDate}::date
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
      Number(row.records || 0)
  };
}


// =========================================================
// 日別データ
// =========================================================

async function getDailyStats(
  userId,
  startDate,
  endDate
) {
  const rows = await sql`
    SELECT
      (
        created_at AT TIME ZONE ${JST}
      )::date AS activity_date,

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
      ${String(userId)}

      AND (
        created_at AT TIME ZONE ${JST}
      )::date >= ${startDate}::date

      AND (
        created_at AT TIME ZONE ${JST}
      )::date <= ${endDate}::date

    GROUP BY activity_date

    ORDER BY activity_date ASC
  `;

  return rows.map(
    (row) => ({
      date:
        String(row.activity_date),

      sales:
        Number(row.sales || 0),

      count:
        Number(row.count || 0),

      hours:
        Number(row.hours || 0)
    })
  );
}


// =========================================================
// 自己ベスト用全期間データ
// =========================================================

async function getAllTimeDailyStats(
  userId,
  today
) {
  const rows = await sql`
    SELECT
      (
        created_at AT TIME ZONE ${JST}
      )::date AS activity_date,

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
      ${String(userId)}

      AND (
        created_at AT TIME ZONE ${JST}
      )::date <= ${today}::date

    GROUP BY activity_date

    ORDER BY activity_date ASC
  `;

  return rows.map(
    (row) => ({
      date:
        String(row.activity_date),

      sales:
        Number(row.sales || 0),

      count:
        Number(row.count || 0),

      hours:
        Number(row.hours || 0)
    })
  );
}


// =========================================================
// 目標
// =========================================================

async function getGoal(userId) {
  const rows = await sql`
    SELECT monthly_goal
    FROM delivery_goals
    WHERE telegram_user_id =
      ${String(userId)}
    LIMIT 1
  `;

  return Number(
    rows[0]?.monthly_goal || 0
  );
}


// =========================================================
// 連続稼働日
// =========================================================

function calculateStreak(
  daily,
  today
) {
  const activeDates =
    new Set(
      daily
        .filter(
          (row) =>
            row.count > 0 ||
            row.sales > 0
        )
        .map(
          (row) => row.date
        )
    );

  let cursor =
    today;

  let streak = 0;

  while (
    activeDates.has(cursor)
  ) {
    streak += 1;

    cursor =
      getJSTPreviousDate(
        cursor
      );
  }

  return streak;
}


// =========================================================
// 自己ベスト
// =========================================================

function calculateBest(
  daily
) {
  let bestCount = 0;
  let bestSales = 0;
  let bestCountPerHour = 0;
  let bestSalesPerHour = 0;

  let bestCountDate = null;
  let bestSalesDate = null;

  for (const row of daily) {
    const count =
      Number(row.count || 0);

    const sales =
      Number(row.sales || 0);

    const hours =
      Number(row.hours || 0);

    const countPerHour =
      hours > 0
        ? count / hours
        : 0;

    const salesPerHour =
      hours > 0
        ? sales / hours
        : 0;

    if (count > bestCount) {
      bestCount = count;
      bestCountDate = row.date;
    }

    if (sales > bestSales) {
      bestSales = sales;
      bestSalesDate = row.date;
    }

    if (
      countPerHour >
      bestCountPerHour
    ) {
      bestCountPerHour =
        countPerHour;
    }

    if (
      salesPerHour >
      bestSalesPerHour
    ) {
      bestSalesPerHour =
        salesPerHour;
    }
  }

  return {
    count: bestCount,
    sales: bestSales,
    countPerHour: bestCountPerHour,
    salesPerHour: bestSalesPerHour,
    countDate: bestCountDate,
    salesDate: bestSalesDate
  };
}


// =========================================================
// Handler
// =========================================================

module.exports = async function handler(
  req,
  res
) {
  try {
    if (req.method !== "GET") {
      return res.status(405).json({
        ok: false,
        error: "Method Not Allowed"
      });
    }

    // =====================================================
    // Telegram認証
    // =====================================================

    const initData =
      req.headers[
        "x-telegram-init-data"
      ];

    const user =
      validateTelegramInitData(
        initData
      );

    if (!user?.id) {
      return res.status(401).json({
        ok: false,
        error: "Unauthorized"
      });
    }

    const userId =
      String(user.id);


    // =====================================================
    // 日付
    // =====================================================

    const today =
      getJSTDateString();

    const yesterday =
      getJSTPreviousDate(
        today
      );

    const weekStart =
      getJSTWeekStart(
        today
      );

    const monthStart =
      getJSTMonthStart(
        today
      );

    const monthEnd =
      getJSTMonthEnd(
        today
      );

    const previousMonth =
      getPreviousMonthRange(
        today
      );


    // =====================================================
    // 月情報
    // =====================================================

    const year =
      Number(
        today.slice(0, 4)
      );

    const month =
      Number(
        today.slice(5, 7)
      );

    const daysInMonth =
      new Date(
        year,
        month,
        0
      ).getDate();

    const elapsedDays =
      Number(
        today.slice(8, 10)
      );

    const remainingDays =
      Math.max(
        0,
        daysInMonth -
          elapsedDays
      );


    // =====================================================
    // データ取得
    // =====================================================

    const [
      todayStats,
      yesterdayStats,
      weekStats,
      monthStats,
      previousMonthStats,
      goal,
      monthlyDaily,
      allTimeDaily
    ] = await Promise.all([
      getStats(
        userId,
        today,
        today
      ),

      getStats(
        userId,
        yesterday,
        yesterday
      ),

      getStats(
        userId,
        weekStart,
        today
      ),

      getStats(
        userId,
        monthStart,
        today
      ),

      getStats(
        userId,
        previousMonth.start,
        previousMonth.end
      ),

      getGoal(
        userId
      ),

      getDailyStats(
        userId,
        monthStart,
        monthEnd
      ),

      getAllTimeDailyStats(
        userId,
        today
      )
    ]);


    // =====================================================
    // 稼働日数
    // =====================================================

    const activeDays =
      monthlyDaily.filter(
        (row) =>
          row.count > 0 ||
          row.sales > 0
      ).length;


    // =====================================================
    // 1日平均
    // =====================================================

    const averageDailyCount =
      activeDays > 0
        ? monthStats.count /
          activeDays
        : 0;

    const averageDailySales =
      activeDays > 0
        ? monthStats.sales /
          activeDays
        : 0;


    // =====================================================
    // 今日のパフォーマンス
    // =====================================================

    const todayHourlySales =
      todayStats.hours > 0
        ? todayStats.sales /
          todayStats.hours
        : 0;

    const todayCountPerHour =
      todayStats.hours > 0
        ? todayStats.count /
          todayStats.hours
        : 0;

    const todayAverageUnitPrice =
      todayStats.count > 0
        ? todayStats.sales /
          todayStats.count
        : 0;


    // =====================================================
    // 今日のペース
    // =====================================================

    const currentDailyPace =
      todayStats.count;


    // =====================================================
    // 月間予測
    // =====================================================

    const projectedMonthCount =
      elapsedDays > 0
        ? (
            monthStats.count /
            elapsedDays
          ) *
          daysInMonth
        : 0;

    const projectedMonthSales =
      elapsedDays > 0
        ? (
            monthStats.sales /
            elapsedDays
          ) *
          daysInMonth
        : 0;


    // =====================================================
    // 目標
    // =====================================================

    const remainingGoalCount =
      Math.max(
        0,
        goal -
          monthStats.count
      );

    const requiredDailyCount =
      remainingDays > 0
        ? remainingGoalCount /
          remainingDays
        : remainingGoalCount;

    const goalRate =
      goal > 0
        ? (
            monthStats.count /
            goal
          ) *
          100
        : 0;


    // =====================================================
    // 月間パフォーマンス
    // =====================================================

    const averageUnitPrice =
      monthStats.count > 0
        ? monthStats.sales /
          monthStats.count
        : 0;

    const countPerHour =
      monthStats.hours > 0
        ? monthStats.count /
          monthStats.hours
        : 0;

    const salesPerHour =
      monthStats.hours > 0
        ? monthStats.sales /
          monthStats.hours
        : 0;


    // =====================================================
    // 前日比較
    // =====================================================

    const salesChangeFromYesterday =
      todayStats.sales -
      yesterdayStats.sales;

    const countChangeFromYesterday =
      todayStats.count -
      yesterdayStats.count;


    // =====================================================
    // 前月比較
    // =====================================================

    const salesChangeFromPreviousMonth =
      monthStats.sales -
      previousMonthStats.sales;

    const countChangeFromPreviousMonth =
      monthStats.count -
      previousMonthStats.count;

    const salesChangeFromPreviousMonthRate =
      previousMonthStats.sales > 0
        ? (
            salesChangeFromPreviousMonth /
            previousMonthStats.sales
          ) *
          100
        : monthStats.sales > 0
          ? 100
          : 0;

    const countChangeFromPreviousMonthRate =
      previousMonthStats.count > 0
        ? (
            countChangeFromPreviousMonth /
            previousMonthStats.count
          ) *
          100
        : monthStats.count > 0
          ? 100
          : 0;


    // =====================================================
    // 今月最高
    // =====================================================

    const monthlyBest =
      calculateBest(
        monthlyDaily
      );


    // =====================================================
    // 全期間自己ベスト
    // =====================================================

    const allTimeBest =
      calculateBest(
        allTimeDaily
      );


    // =====================================================
    // 今日の自己ベスト更新
    // =====================================================

    const isBestCount =
      todayStats.count > 0 &&
      todayStats.count >=
        allTimeBest.count &&
      todayStats.count ===
        Math.max(
          ...allTimeDaily
            .filter(
              (row) =>
                row.date !== today
            )
            .map(
              (row) =>
                Number(
                  row.count || 0
                )
            ),
          0
        );

    const isBestSales =
      todayStats.sales > 0 &&
      todayStats.sales >=
        allTimeBest.sales &&
      todayStats.sales ===
        Math.max(
          ...allTimeDaily
            .filter(
              (row) =>
                row.date !== today
            )
            .map(
              (row) =>
                Number(
                  row.sales || 0
                )
            ),
          0
        );


    // =====================================================
    // 連続稼働日
    // =====================================================

    const streak =
      calculateStreak(
        allTimeDaily,
        today
      );


    // =====================================================
    // 今月進捗ペース
    // =====================================================

    const monthProgressRate =
      daysInMonth > 0
        ? (
            elapsedDays /
            daysInMonth
          ) *
          100
        : 0;

    const goalProgressRate =
      goal > 0
        ? (
            monthStats.count /
            goal
          ) *
          100
        : 0;

    const paceDifference =
      goalProgressRate -
      monthProgressRate;


    // =====================================================
    // Response
    // =====================================================

    return res.status(200).json({
      ok: true,

      today:
        todayStats,

      yesterday:
        yesterdayStats,

      week:
        weekStats,

      month:
        monthStats,

      previousMonth:
        previousMonthStats,

      goal,

      best: {
        count:
          allTimeBest.count,

        sales:
          allTimeBest.sales,

        countPerHour:
          allTimeBest.countPerHour,

        salesPerHour:
          allTimeBest.salesPerHour,

        countDate:
          allTimeBest.countDate,

        salesDate:
          allTimeBest.salesDate
      },

      analysis: {
        // -----------------------------
        // 基本
        // -----------------------------

        averageDailyCount,
        averageDailySales,

        currentDailyPace,

        projectedMonthCount,
        projectedMonthSales,

        remainingDays,

        remainingGoalCount,
        requiredDailyCount,

        goalRate,

        averageUnitPrice,

        countPerHour,
        salesPerHour,

        // -----------------------------
        // 今日
        // -----------------------------

        todayHourlySales,
        todayCountPerHour,
        todayAverageUnitPrice,

        // -----------------------------
        // 前日比較
        // -----------------------------

        salesChangeFromYesterday,
        countChangeFromYesterday,

        // -----------------------------
        // 前月比較
        // -----------------------------

        previousMonthSales:
          previousMonthStats.sales,

        previousMonthCount:
          previousMonthStats.count,

        previousMonthHours:
          previousMonthStats.hours,

        salesChangeFromPreviousMonth,

        countChangeFromPreviousMonth,

        salesChangeFromPreviousMonthRate,

        countChangeFromPreviousMonthRate,

        // -----------------------------
        // 今月最高
        // -----------------------------

        monthlyBestCount:
          monthlyBest.count,

        monthlyBestSales:
          monthlyBest.sales,

        monthlyBestCountDate:
          monthlyBest.countDate,

        monthlyBestSalesDate:
          monthlyBest.salesDate,

        // -----------------------------
        // 自己ベスト
        // -----------------------------

        allTimeBestCount:
          allTimeBest.count,

        allTimeBestSales:
          allTimeBest.sales,

        allTimeBestCountPerHour:
          allTimeBest.countPerHour,

        allTimeBestSalesPerHour:
          allTimeBest.salesPerHour,

        isBestCount,
        isBestSales,

        // -----------------------------
        // 連続稼働
        // -----------------------------

        streak,

        // -----------------------------
        // 今月ペース
        // -----------------------------

        monthProgressRate,

        goalProgressRate,

        paceDifference,

        // -----------------------------
        // 日付情報
        // -----------------------------

        elapsedDays,

        daysInMonth,

        today,

        yesterday,

        monthStart,

        monthEnd,

        previousMonthStart:
          previousMonth.start,

        previousMonthEnd:
          previousMonth.end
      },

      daily:
        monthlyDaily
    });

  } catch (error) {
    console.error(
      "analytics API error:",
      error
    );

    return res.status(500).json({
      ok: false,
      error:
        "Analytics failed",

      message:
        process.env.NODE_ENV ===
        "development"
          ? error.message
          : undefined
    });
  }
};

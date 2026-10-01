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

  const authDate = Number(params.get("auth_date"));

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


function getJSTMonthStart() {
  const today = getJSTDateString();

  return `${today.slice(0, 7)}-01`;
}


function getJSTPreviousDate(dateString) {
  const date = new Date(`${dateString}T00:00:00+09:00`);
  date.setDate(date.getDate() - 1);

  return new Intl.DateTimeFormat("en-CA", {
    timeZone: JST,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
}


function getJSTWeekStart() {
  const today = getJSTDateString();

  const date = new Date(`${today}T00:00:00+09:00`);
  const day = date.getDay();

  const diff = day === 0 ? 6 : day - 1;

  date.setDate(date.getDate() - diff);

  return new Intl.DateTimeFormat("en-CA", {
    timeZone: JST,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
}


function getJSTMonthEnd() {
  const today = getJSTDateString();

  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));

  const date = new Date(
    `${year}-${String(month + 1).padStart(2, "0")}-01T00:00:00+09:00`
  );

  date.setDate(0);

  return new Intl.DateTimeFormat("en-CA", {
    timeZone: JST,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
}


// =========================================================
// 集計
// =========================================================

async function getStats(userId, startDate, endDate) {
  const rows = await sql`
    SELECT
      COALESCE(SUM(sale_amount), 0) AS sales,
      COALESCE(SUM(delivery_count), 0) AS count,
      COALESCE(SUM(work_hours), 0) AS hours,
      COUNT(*) AS records
    FROM delivery_results
    WHERE telegram_user_id = ${String(userId)}
      AND (
        created_at AT TIME ZONE ${JST}
      )::date >= ${startDate}::date
      AND (
        created_at AT TIME ZONE ${JST}
      )::date <= ${endDate}::date
  `;

  const row = rows[0] || {};

  return {
    sales: Number(row.sales || 0),
    count: Number(row.count || 0),
    hours: Number(row.hours || 0),
    records: Number(row.records || 0)
  };
}


// =========================================================
// 月間日別データ
// =========================================================

async function getDailyStats(userId, monthStart, monthEnd) {
  const rows = await sql`
    SELECT
      (
        created_at AT TIME ZONE ${JST}
      )::date AS activity_date,

      COALESCE(SUM(sale_amount), 0) AS sales,

      COALESCE(
        SUM(delivery_count),
        0
      ) AS count,

      COALESCE(
        SUM(work_hours),
        0
      ) AS hours

    FROM delivery_results

    WHERE telegram_user_id = ${String(userId)}

      AND (
        created_at AT TIME ZONE ${JST}
      )::date >= ${monthStart}::date

      AND (
        created_at AT TIME ZONE ${JST}
      )::date <= ${monthEnd}::date

    GROUP BY activity_date

    ORDER BY activity_date ASC
  `;

  return rows.map(row => ({
    date: String(row.activity_date),
    sales: Number(row.sales || 0),
    count: Number(row.count || 0),
    hours: Number(row.hours || 0)
  }));
}


// =========================================================
// 目標
// =========================================================

async function getGoal(userId) {
  const rows = await sql`
    SELECT monthly_goal
    FROM delivery_goals
    WHERE telegram_user_id = ${String(userId)}
    LIMIT 1
  `;

  return Number(
    rows[0]?.monthly_goal || 0
  );
}


// =========================================================
// Handler
// =========================================================

module.exports = async function handler(req, res) {
  try {
    if (req.method !== "GET") {
      return res.status(405).json({
        ok: false,
        error: "Method Not Allowed"
      });
    }

    const initData =
      req.headers["x-telegram-init-data"];

    const user =
      validateTelegramInitData(initData);

    if (!user?.id) {
      return res.status(401).json({
        ok: false,
        error: "Unauthorized"
      });
    }

    const userId = String(user.id);

    const today = getJSTDateString();

    const yesterday =
      getJSTPreviousDate(today);

    const weekStart =
      getJSTWeekStart();

    const monthStart =
      getJSTMonthStart();

    const monthEnd =
      getJSTMonthEnd();

    // 今月の日数
    const now = new Date(
      `${today}T00:00:00+09:00`
    );

    const year =
      now.getFullYear();

    const month =
      now.getMonth();

    const daysInMonth =
      new Date(
        year,
        month + 1,
        0
      ).getDate();

    const elapsedDays =
      Number(today.slice(8, 10));

    const remainingDays =
      Math.max(
        0,
        daysInMonth - elapsedDays
      );

    // 各期間
    const [
      todayStats,
      yesterdayStats,
      weekStats,
      monthStats,
      goal,
      daily
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

      getGoal(userId),

      getDailyStats(
        userId,
        monthStart,
        monthEnd
      )
    ]);


    // =====================================================
    // 日平均
    // =====================================================

    const activeDays =
      daily.filter(
        row =>
          row.count > 0 ||
          row.sales > 0
      ).length;

    const averageDailyCount =
      activeDays > 0
        ? monthStats.count / activeDays
        : 0;

    const averageDailySales =
      activeDays > 0
        ? monthStats.sales / activeDays
        : 0;


    // =====================================================
    // 現在ペース
    // =====================================================

    const currentDailyPace =
      elapsedDays > 0
        ? monthStats.sales / elapsedDays
        : 0;


    // =====================================================
    // 月末予測
    // =====================================================

    const projectedMonthCount =
      elapsedDays > 0
        ? (
            monthStats.count /
            elapsedDays
          ) * daysInMonth
        : 0;

    const projectedMonthSales =
      elapsedDays > 0
        ? (
            monthStats.sales /
            elapsedDays
          ) * daysInMonth
        : 0;


    // =====================================================
    // 目標
    // =====================================================

    const remainingGoalCount =
      Math.max(
        0,
        goal - monthStats.sales
      );

    const requiredDailyCount =
      remainingDays > 0
        ? remainingGoalCount /
          remainingDays
        : remainingGoalCount;

    const goalRate =
      goal > 0
        ? (
            monthStats.sales /
            goal
          ) * 100
        : 0;


    // =====================================================
    // 単価・時給
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

    const todayCountPerHour =
      todayStats.hours > 0
        ? todayStats.count /
          todayStats.hours
        : 0;

    const todaySalesPerHour =
      todayStats.hours > 0
        ? todayStats.sales /
          todayStats.hours
        : 0;


    // =====================================================
    // 前日比較
    // =====================================================

    const salesChangeFromYesterday =
      yesterdayStats.sales > 0
        ? (
            (
              todayStats.sales -
              yesterdayStats.sales
            ) /
            yesterdayStats.sales
          ) * 100
        : todayStats.sales > 0
          ? 100
          : 0;

    const countChangeFromYesterday =
      yesterdayStats.count > 0
        ? (
            (
              todayStats.count -
              yesterdayStats.count
            ) /
            yesterdayStats.count
          ) * 100
        : todayStats.count > 0
          ? 100
          : 0;


    // =====================================================
    // ベスト記録
    // =====================================================

    let bestCount = 0;
    let bestSales = 0;
    let bestCountPerHour = 0;
    let bestSalesPerHour = 0;

    let bestDayCount = 0;
    let bestDayCountDate = null;

    let bestDaySales = 0;
    let bestDaySalesDate = null;

    for (const row of daily) {
      const rowCount =
        Number(row.count || 0);

      const rowSales =
        Number(row.sales || 0);

      const rowHours =
        Number(row.hours || 0);

      const rowCountPerHour =
        rowHours > 0
          ? rowCount / rowHours
          : 0;

      const rowSalesPerHour =
        rowHours > 0
          ? rowSales / rowHours
          : 0;

      if (rowCount > bestCount) {
        bestCount = rowCount;
      }

      if (rowSales > bestSales) {
        bestSales = rowSales;
      }

      if (
        rowCountPerHour >
        bestCountPerHour
      ) {
        bestCountPerHour =
          rowCountPerHour;
      }

      if (
        rowSalesPerHour >
        bestSalesPerHour
      ) {
        bestSalesPerHour =
          rowSalesPerHour;
      }

      if (rowCount > bestDayCount) {
        bestDayCount = rowCount;
        bestDayCountDate =
          row.date;
      }

      if (rowSales > bestDaySales) {
        bestDaySales = rowSales;
        bestDaySalesDate =
          row.date;
      }
    }


    // =====================================================
    // Response
    // =====================================================

    return res.status(200).json({
      ok: true,

      today: todayStats,

      yesterday: yesterdayStats,

      week: weekStats,

      month: monthStats,

      goal,

      best: {
        count: bestCount,
        sales: bestSales,
        countPerHour:
          bestCountPerHour,
        salesPerHour:
          bestSalesPerHour,
        dayCount:
          bestDayCount,
        dayCountDate:
          bestDayCountDate,
        daySales:
          bestDaySales,
        daySalesDate:
          bestDaySalesDate
      },

      analysis: {
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
        salesChangeFromYesterday,
        countChangeFromYesterday,
        countPerHour,
        salesPerHour,
        todayCountPerHour,
        todaySalesPerHour,
        bestCount,
        bestSales,
        bestCountPerHour,
        bestSalesPerHour,
        bestDayCount,
        bestDayCountDate,
        bestDaySales,
        bestDaySalesDate,
        elapsedDays,
        daysInMonth
      },

      daily
    });

  } catch (error) {
    console.error(
      "analytics API error:",
      error
    );

    return res.status(500).json({
      ok: false,
      error: "Analytics failed",
      message:
        process.env.NODE_ENV === "development"
          ? error.message
          : undefined
    });
  }
};

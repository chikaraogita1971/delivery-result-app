const { neon } = require("@neondatabase/serverless");
const crypto = require("crypto");

const sql = neon(process.env.DATABASE_URL);

const TIME_ZONE = "Asia/Tokyo";
const MAX_AUTH_AGE_SECONDS = 60 * 60;

// =========================================================
// Telegram Mini App initData 検証
// =========================================================

function validateTelegramInitData(initData) {
  if (!initData || typeof initData !== "string") {
    throw new Error("Telegram initData がありません");
  }

  const botToken = process.env.BOT_TOKEN;

  if (!botToken) {
    throw new Error("BOT_TOKEN が設定されていません");
  }

  const params = new URLSearchParams(initData);

  const receivedHash = params.get("hash");
  const authDate = Number(params.get("auth_date"));

  if (!receivedHash) {
    throw new Error("Telegram hash がありません");
  }

  if (!Number.isInteger(authDate) || authDate <= 0) {
    throw new Error("Telegram auth_date が不正です");
  }

  const now = Math.floor(Date.now() / 1000);

  if (
    Math.abs(now - authDate) >
    MAX_AUTH_AGE_SECONDS
  ) {
    throw new Error(
      "Telegram initData の有効期限が切れています"
    );
  }

  params.delete("hash");

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

  const secretKey = crypto
    .createHmac("sha256", "WebAppData")
    .update(botToken)
    .digest();

  const calculatedHash = crypto
    .createHmac("sha256", secretKey)
    .update(dataCheckString)
    .digest("hex");

  const receivedBuffer =
    Buffer.from(receivedHash, "hex");

  const calculatedBuffer =
    Buffer.from(calculatedHash, "hex");

  if (
    receivedBuffer.length !==
      calculatedBuffer.length ||
    !crypto.timingSafeEqual(
      receivedBuffer,
      calculatedBuffer
    )
  ) {
    throw new Error(
      "Telegram initData の署名が不正です"
    );
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
// JST 日付
// =========================================================

function getJSTDateString(date = new Date()) {
  return new Intl.DateTimeFormat(
    "en-CA",
    {
      timeZone: TIME_ZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }
  ).format(date);
}

function getJSTPreviousDate(dateString) {
  const date = new Date(
    `${dateString}T00:00:00+09:00`
  );

  date.setDate(date.getDate() - 1);

  return getJSTDateString(date);
}

function getJSTMonthStart(dateString) {
  return `${dateString.slice(0, 7)}-01`;
}

function getJSTMonthEnd(dateString) {
  const date = new Date(
    `${dateString.slice(0, 7)}-01T00:00:00+09:00`
  );

  date.setMonth(date.getMonth() + 1);
  date.setDate(date.getDate() - 1);

  return getJSTDateString(date);
}

function getJSTWeekStart(dateString) {
  const date = new Date(
    `${dateString}T00:00:00+09:00`
  );

  const day = date.getDay();

  date.setDate(
    date.getDate() - day
  );

  return getJSTDateString(date);
}

function formatJSTDate(dateString) {
  if (!dateString) {
    return null;
  }

  return dateString;
}

// =========================================================
// 期間
// =========================================================

function getPreviousMonthRange(today) {
  const date = new Date(
    `${today}T00:00:00+09:00`
  );

  date.setDate(1);
  date.setMonth(date.getMonth() - 1);

  const start =
    getJSTDateString(date);

  date.setMonth(date.getMonth() + 1);
  date.setDate(0);

  const end =
    getJSTDateString(date);

  return {
    start,
    end,
  };
}

// =========================================================
// 個人統計
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

      COUNT(
        DISTINCT (
          created_at AT TIME ZONE ${TIME_ZONE}
        )::date
      ) AS work_days

    FROM delivery_results

    WHERE telegram_user_id =
      ${userId}

      AND (
        created_at AT TIME ZONE ${TIME_ZONE}
      )::date >= ${startDate}::date

      AND (
        created_at AT TIME ZONE ${TIME_ZONE}
      )::date <= ${endDate}::date
  `;

  const row = rows[0] || {};

  return {
    sales: Number(row.sales || 0),
    count: Number(row.count || 0),
    hours: Number(row.hours || 0),
    workDays: Number(row.work_days || 0),
  };
}

// =========================================================
// 日別統計
// =========================================================

async function getDailyStats(
  userId,
  startDate,
  endDate
) {
  const rows = await sql`
    SELECT
      (
        created_at AT TIME ZONE ${TIME_ZONE}
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
        created_at AT TIME ZONE ${TIME_ZONE}
      )::date >= ${startDate}::date

      AND (
        created_at AT TIME ZONE ${TIME_ZONE}
      )::date <= ${endDate}::date

    GROUP BY
      (
        created_at AT TIME ZONE ${TIME_ZONE}
      )::date

    ORDER BY
      date ASC
  `;

  return rows.map(row => ({
    date: String(row.date),
    sales: Number(row.sales || 0),
    count: Number(row.count || 0),
    hours: Number(row.hours || 0),
  }));
}

// =========================================================
// 全期間の日別統計
// =========================================================

async function getAllTimeDailyStats(
  userId,
  today
) {
  const rows = await sql`
    SELECT
      (
        created_at AT TIME ZONE ${TIME_ZONE}
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
        created_at AT TIME ZONE ${TIME_ZONE}
      )::date <= ${today}::date

    GROUP BY
      (
        created_at AT TIME ZONE ${TIME_ZONE}
      )::date

    ORDER BY
      date ASC
  `;

  return rows.map(row => ({
    date: String(row.date),
    sales: Number(row.sales || 0),
    count: Number(row.count || 0),
    hours: Number(row.hours || 0),
  }));
}

// =========================================================
// 連続稼働日数
// =========================================================

function calculateStreak(
  dailyStats,
  today
) {
  const activeDates =
    new Set(
      dailyStats
        .filter(
          row =>
            Number(row.count || 0) > 0 ||
            Number(row.sales || 0) > 0
        )
        .map(row => row.date)
    );

  let streak = 0;
  let currentDate = today;

  while (
    activeDates.has(currentDate)
  ) {
    streak += 1;

    currentDate =
      getJSTPreviousDate(
        currentDate
      );
  }

  return streak;
}

// =========================================================
// ベスト記録
// =========================================================

function calculateBest(
  dailyStats
) {
  if (!dailyStats.length) {
    return {
      count: 0,
      sales: 0,
      countPerHour: 0,
      salesPerHour: 0,
      countDate: null,
      salesDate: null,
    };
  }

  let bestCount = dailyStats[0];
  let bestSales = dailyStats[0];
  let bestCountPerHour = dailyStats[0];
  let bestSalesPerHour = dailyStats[0];

  for (const row of dailyStats) {
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

    if (
      count >
      Number(bestCount.count || 0)
    ) {
      bestCount = row;
    }

    if (
      sales >
      Number(bestSales.sales || 0)
    ) {
      bestSales = row;
    }

    const bestCountHours =
      Number(bestCountPerHour.hours || 0);

    const bestCountRate =
      bestCountHours > 0
        ? Number(
            bestCountPerHour.count || 0
          ) / bestCountHours
        : 0;

    if (
      countPerHour >
      bestCountRate
    ) {
      bestCountPerHour = row;
    }

    const bestSalesHours =
      Number(bestSalesPerHour.hours || 0);

    const bestSalesRate =
      bestSalesHours > 0
        ? Number(
            bestSalesPerHour.sales || 0
          ) / bestSalesHours
        : 0;

    if (
      salesPerHour >
      bestSalesRate
    ) {
      bestSalesPerHour = row;
    }
  }

  const bestCountHours =
    Number(bestCountPerHour.hours || 0);

  const bestSalesHours =
    Number(bestSalesPerHour.hours || 0);

  return {
    count: Number(bestCount.count || 0),
    sales: Number(bestSales.sales || 0),

    countPerHour:
      bestCountHours > 0
        ? Number(
            bestCountPerHour.count || 0
          ) /
          bestCountHours
        : 0,

    salesPerHour:
      bestSalesHours > 0
        ? Number(
            bestSalesPerHour.sales || 0
          ) /
          bestSalesHours
        : 0,

    countDate:
      bestCount.date || null,

    salesDate:
      bestSales.date || null,
  };
}

// =========================================================
// API
// =========================================================

module.exports = async function handler(
  req,
  res
) {
  res.setHeader(
    "Cache-Control",
    "no-store"
  );

  if (req.method !== "GET") {
    return res.status(405).json({
      ok: false,
      error: "Method Not Allowed",
    });
  }

  try {
    const initData =
      req.headers[
        "x-telegram-init-data"
      ];

    const userId =
      validateTelegramInitData(
        initData
      );

    const today =
      getJSTDateString();

    const yesterday =
      getJSTPreviousDate(today);

    const weekStart =
      getJSTWeekStart(today);

    const monthStart =
      getJSTMonthStart(today);

    const monthEnd =
      getJSTMonthEnd(today);

    const previousMonth =
      getPreviousMonthRange(today);

    const [
      todayStats,
      yesterdayStats,
      weekStats,
      monthStats,
      previousMonthStats,
      monthlyDaily,
      allTimeDaily,
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
        monthEnd
      ),

      getStats(
        userId,
        previousMonth.start,
        previousMonth.end
      ),

      getDailyStats(
        userId,
        monthStart,
        today
      ),

      getAllTimeDailyStats(
        userId,
        today
      ),
    ]);

    // =======================================================
    // 月の日数
    // =======================================================

    const monthDate =
      new Date(
        `${monthStart}T00:00:00+09:00`
      );

    const nextMonthDate =
      new Date(monthDate);

    nextMonthDate.setMonth(
      nextMonthDate.getMonth() + 1
    );

    const daysInMonth =
      Math.round(
        (
          nextMonthDate -
          monthDate
        ) /
          86400000
      );

    const todayDate =
      new Date(
        `${today}T00:00:00+09:00`
      );

    const monthStartDate =
      new Date(
        `${monthStart}T00:00:00+09:00`
      );

    const elapsedDays =
      Math.floor(
        (
          todayDate -
          monthStartDate
        ) /
          86400000
      ) + 1;

    // =======================================================
    // 月平均
    // =======================================================

    const averageDailyCount =
      elapsedDays > 0
        ? monthStats.count /
          elapsedDays
        : 0;

    const averageDailySales =
      elapsedDays > 0
        ? monthStats.sales /
          elapsedDays
        : 0;

    const currentDailyPace =
      averageDailyCount;

    const projectedMonthCount =
      currentDailyPace *
      daysInMonth;

    const projectedMonthSales =
      averageDailySales *
      daysInMonth;

    // =======================================================
    // 効率
    // =======================================================

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

    // =======================================================
    // 前日比較
    // =======================================================

    const salesChangeFromYesterday =
      todayStats.sales -
      yesterdayStats.sales;

    const countChangeFromYesterday =
      todayStats.count -
      yesterdayStats.count;

    // =======================================================
    // 前月比較
    // =======================================================

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
        : 0;

    const countChangeFromPreviousMonthRate =
      previousMonthStats.count > 0
        ? (
            countChangeFromPreviousMonth /
            previousMonthStats.count
          ) *
          100
        : 0;

    // =======================================================
    // 月間ベスト
    // =======================================================

    const monthlyBestCount =
      Math.max(
        ...monthlyDaily.map(
          row =>
            Number(row.count || 0)
        ),
        0
      );

    const monthlyBestSales =
      Math.max(
        ...monthlyDaily.map(
          row =>
            Number(row.sales || 0)
        ),
        0
      );

    const monthlyBestCountRow =
      monthlyDaily.find(
        row =>
          Number(row.count || 0) ===
          monthlyBestCount
      );

    const monthlyBestSalesRow =
      monthlyDaily.find(
        row =>
          Number(row.sales || 0) ===
          monthlyBestSales
      );

    // =======================================================
    // 全期間ベスト
    // =======================================================

    const allTimeBestCount =
      Math.max(
        ...allTimeDaily.map(
          row =>
            Number(row.count || 0)
        ),
        0
      );

    const allTimeBestSales =
      Math.max(
        ...allTimeDaily.map(
          row =>
            Number(row.sales || 0)
        ),
        0
      );

    const allTimeBestCountPerHour =
      Math.max(
        ...allTimeDaily.map(row => {
          const hours =
            Number(row.hours || 0);

          return hours > 0
            ? Number(row.count || 0) /
                hours
            : 0;
        }),
        0
      );

    const allTimeBestSalesPerHour =
      Math.max(
        ...allTimeDaily.map(row => {
          const hours =
            Number(row.hours || 0);

          return hours > 0
            ? Number(row.sales || 0) /
                hours
            : 0;
        }),
        0
      );

    // =======================================================
    // 今日が自己ベスト更新か
    // =======================================================

    const previousBestCount =
      Math.max(
        ...allTimeDaily
          .filter(
            row =>
              row.date !== today
          )
          .map(
            row =>
              Number(
                row.count || 0
              )
          ),
        0
      );

    const previousBestSales =
      Math.max(
        ...allTimeDaily
          .filter(
            row =>
              row.date !== today
          )
          .map(
            row =>
              Number(
                row.sales || 0
              )
          ),
        0
      );

    const isBestCount =
      todayStats.count > 0 &&
      todayStats.count >
        previousBestCount;

    const isBestSales =
      todayStats.sales > 0 &&
      todayStats.sales >
        previousBestSales;

    // =======================================================
    // ストリーク
    // =======================================================

    const streak =
      calculateStreak(
        allTimeDaily,
        today
      );

    // =======================================================
    // 月進捗
    // =======================================================

    const monthProgressRate =
      daysInMonth > 0
        ? (
            elapsedDays /
            daysInMonth
          ) *
          100
        : 0;

    return res.status(200).json({
      ok: true,

      today: todayStats,

      yesterday: yesterdayStats,

      week: weekStats,

      month: monthStats,

      previousMonth:
        previousMonthStats,

      best:
        calculateBest(
          allTimeDaily
        ),

      analysis: {
        averageDailyCount,

        averageDailySales,

        currentDailyPace,

        projectedMonthCount,

        projectedMonthSales,

        averageUnitPrice,

        countPerHour,

        salesPerHour,

        todayHourlySales,

        todayCountPerHour,

        todayAverageUnitPrice,

        salesChangeFromYesterday,

        countChangeFromYesterday,

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

        monthlyBestCount,

        monthlyBestSales,

        monthlyBestCountDate:
          monthlyBestCountRow?.date ||
          null,

        monthlyBestSalesDate:
          monthlyBestSalesRow?.date ||
          null,

        allTimeBestCount,

        allTimeBestSales,

        allTimeBestCountPerHour,

        allTimeBestSalesPerHour,

        isBestCount,

        isBestSales,

        streak,

        monthProgressRate,

        elapsedDays,

        daysInMonth,

        today,

        yesterday,

        monthStart,

        monthEnd,

        previousMonthStart:
          previousMonth.start,

        previousMonthEnd:
          previousMonth.end,
      },

      daily: monthlyDaily,
    });
  } catch (error) {
    console.error(
      "Analytics API error:",
      error
    );

    return res.status(500).json({
      ok: false,
      error:
        error?.message ||
        "分析データ取得中にエラーが発生しました",
    });
  }
};

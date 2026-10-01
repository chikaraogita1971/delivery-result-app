const { neon } = require("@neondatabase/serverless");
const crypto = require("crypto");

const sql = neon(process.env.DATABASE_URL);

const BOT_TOKEN = process.env.BOT_TOKEN;
const JST = "Asia/Tokyo";


// ==============================
// Telegram initData
// ==============================

function verifyTelegramInitData(initData) {
  if (!initData || !BOT_TOKEN) {
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

    const userRaw = params.get("user");

    if (!userRaw) {
      return null;
    }

    return JSON.parse(userRaw);
  } catch (error) {
    console.error("verifyTelegramInitData error:", error);
    return null;
  }
}


// ==============================
// 日付
// ==============================

function getJSTDateString(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: JST,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}


function addDays(dateString, amount) {
  const [year, month, day] = String(dateString)
    .split("-")
    .map(Number);

  const date = new Date(
    Date.UTC(
      year,
      month - 1,
      day
    )
  );

  date.setUTCDate(
    date.getUTCDate() + amount
  );

  return date.toISOString().slice(0, 10);
}


function getMonthStart(dateString) {
  return `${dateString.slice(0, 7)}-01`;
}


function getNextMonthStart(dateString) {
  const [year, month] = dateString
    .slice(0, 7)
    .split("-")
    .map(Number);

  const date = new Date(
    Date.UTC(
      year,
      month,
      1
    )
  );

  return date.toISOString().slice(0, 10);
}


function getPreviousMonthStart(dateString) {
  const [year, month] = dateString
    .slice(0, 7)
    .split("-")
    .map(Number);

  const date = new Date(
    Date.UTC(
      year,
      month - 2,
      1
    )
  );

  return date.toISOString().slice(0, 10);
}


// ==============================
// 集計
// ==============================

async function getAggregate(
  userId,
  startDate,
  endDate
) {
  const rows = await sql`
    SELECT
      COALESCE(SUM(sale_amount), 0) AS sales,
      COALESCE(SUM(delivery_count), 0) AS count,
      COALESCE(SUM(work_hours), 0) AS hours,
      COUNT(*) AS records,
      COUNT(
        DISTINCT (
          (
            created_at AT TIME ZONE ${JST}
          )::date
        )
      ) AS work_days
    FROM delivery_results
    WHERE telegram_user_id = ${userId}
      AND (
        (
          created_at AT TIME ZONE ${JST}
        )::date >= ${startDate}::date
      )
      AND (
        (
          created_at AT TIME ZONE ${JST}
        )::date < ${endDate}::date
      )
  `;

  const row = rows[0] || {};

  return {
    sales: Number(row.sales || 0),
    count: Number(row.count || 0),
    hours: Number(row.hours || 0),
    records: Number(row.records || 0),
    workDays: Number(row.work_days || 0),
  };
}


// ==============================
// 日別集計
// ==============================

async function getDailyStats(
  userId,
  startDate,
  endDate
) {
  const rows = await sql`
    SELECT
      daily_source.day,
      COALESCE(
        SUM(daily_source.sale_amount),
        0
      ) AS sales,
      COALESCE(
        SUM(daily_source.delivery_count),
        0
      ) AS count,
      COALESCE(
        SUM(daily_source.work_hours),
        0
      ) AS hours
    FROM (
      SELECT
        (
          (
            created_at AT TIME ZONE ${JST}
          )::date
        ) AS day,
        sale_amount,
        delivery_count,
        work_hours
      FROM delivery_results
      WHERE telegram_user_id = ${userId}
        AND (
          (
            created_at AT TIME ZONE ${JST}
          )::date >= ${startDate}::date
        )
        AND (
          (
            created_at AT TIME ZONE ${JST}
          )::date < ${endDate}::date
        )
    ) AS daily_source
    GROUP BY daily_source.day
    ORDER BY daily_source.day ASC
  `;

  return rows.map((row) => ({
    day: String(row.day),
    sales: Number(row.sales || 0),
    count: Number(row.count || 0),
    hours: Number(row.hours || 0),
  }));
}


// ==============================
// 最近の実績
// ==============================

async function getRecentRecords(
  userId,
  limit = 30
) {
  const rows = await sql`
    SELECT
      id,
      sale_amount,
      delivery_count,
      work_hours,
      created_at
    FROM delivery_results
    WHERE telegram_user_id = ${userId}
    ORDER BY created_at DESC
    LIMIT ${limit}
  `;

  return rows.map((row) => ({
    id: Number(row.id),
    sale: Number(row.sale_amount || 0),
    count: Number(row.delivery_count || 0),
    hours: Number(row.work_hours || 0),
    createdAt: row.created_at,
  }));
}


// ==============================
// 自己ベスト
// ==============================

async function getBestRecords(userId) {
  const rows = await sql`
    SELECT
      id,
      sale_amount,
      delivery_count,
      work_hours,
      created_at
    FROM delivery_results
    WHERE telegram_user_id = ${userId}
    ORDER BY created_at ASC
  `;

  if (!rows.length) {
    return {
      count: 0,
      sales: 0,
      countPerHour: 0,
      salesPerHour: 0,
      countRecord: null,
      salesRecord: null,
      countPerHourRecord: null,
      salesPerHourRecord: null,
    };
  }

  let countBest = null;
  let salesBest = null;
  let countPerHourBest = null;
  let salesPerHourBest = null;

  for (const row of rows) {
    const count =
      Number(row.delivery_count || 0);

    const sales =
      Number(row.sale_amount || 0);

    const hours =
      Number(row.work_hours || 0);

    const countPerHour =
      hours > 0
        ? count / hours
        : 0;

    const salesPerHour =
      hours > 0
        ? sales / hours
        : 0;

    if (
      !countBest ||
      count > Number(countBest.delivery_count || 0)
    ) {
      countBest = row;
    }

    if (
      !salesBest ||
      sales > Number(salesBest.sale_amount || 0)
    ) {
      salesBest = row;
    }

    if (
      hours > 0 &&
      (
        !countPerHourBest ||
        countPerHour >
          Number(countPerHourBest.delivery_count || 0) /
            Number(countPerHourBest.work_hours || 1)
      )
    ) {
      countPerHourBest = row;
    }

    if (
      hours > 0 &&
      (
        !salesPerHourBest ||
        salesPerHour >
          Number(salesPerHourBest.sale_amount || 0) /
            Number(salesPerHourBest.work_hours || 1)
      )
    ) {
      salesPerHourBest = row;
    }
  }

  const makeRecord = (row) => {
    if (!row) {
      return null;
    }

    const count =
      Number(row.delivery_count || 0);

    const sales =
      Number(row.sale_amount || 0);

    const hours =
      Number(row.work_hours || 0);

    return {
      id: Number(row.id),
      count,
      sales,
      hours,
      countPerHour:
        hours > 0
          ? count / hours
          : 0,
      salesPerHour:
        hours > 0
          ? sales / hours
          : 0,
      createdAt: row.created_at,
    };
  };

  return {
    count: Number(
      countBest?.delivery_count || 0
    ),

    sales: Number(
      salesBest?.sale_amount || 0
    ),

    countPerHour:
      countPerHourBest &&
      Number(countPerHourBest.work_hours || 0) > 0
        ? Number(
            countPerHourBest.delivery_count || 0
          ) /
          Number(
            countPerHourBest.work_hours
          )
        : 0,

    salesPerHour:
      salesPerHourBest &&
      Number(salesPerHourBest.work_hours || 0) > 0
        ? Number(
            salesPerHourBest.sale_amount || 0
          ) /
          Number(
            salesPerHourBest.work_hours
          )
        : 0,

    countRecord: makeRecord(
      countBest
    ),

    salesRecord: makeRecord(
      salesBest
    ),

    countPerHourRecord:
      makeRecord(
        countPerHourBest
      ),

    salesPerHourRecord:
      makeRecord(
        salesPerHourBest
      ),
  };
}


// ==============================
// 連続稼働
// ==============================

async function getStreak(userId) {
  const rows = await sql`
    SELECT DISTINCT
      TO_CHAR(
        (
          created_at AT TIME ZONE ${JST}
        )::date,
        'YYYY-MM-DD'
      ) AS day
    FROM delivery_results
    WHERE telegram_user_id = ${userId}
    ORDER BY day DESC
  `;

  const dates = rows
    .map((row) => String(row.day))
    .filter((day) =>
      /^\d{4}-\d{2}-\d{2}$/.test(day)
    );

  if (!dates.length) {
    return {
      current: 0,
      best: 0,
      activeDays: [],
    };
  }

  const today =
    getJSTDateString();

  const yesterday =
    addDays(
      today,
      -1
    );

  const dateSet =
    new Set(dates);

  /*
   * 今日または昨日に稼働していなければ
   * 現在の連続稼働は0日
   */
  if (
    !dateSet.has(today) &&
    !dateSet.has(yesterday)
  ) {
    return {
      current: 0,
      best: calculateBestStreak(
        dates
      ),
      activeDays: dates,
    };
  }

  /*
   * 今日稼働していれば今日から。
   * 今日が未稼働なら昨日から。
   */
  let cursor =
    dateSet.has(today)
      ? today
      : yesterday;

  let current = 0;

  while (
    dateSet.has(cursor)
  ) {
    current += 1;

    cursor =
      addDays(
        cursor,
        -1
      );
  }

  const best =
    calculateBestStreak(
      dates
    );

  return {
    current,
    best,
    activeDays: dates,
  };
}


function calculateBestStreak(
  dates
) {
  if (
    !Array.isArray(dates) ||
    !dates.length
  ) {
    return 0;
  }

  const uniqueDates = [
    ...new Set(dates),
  ]
    .filter((day) =>
      /^\d{4}-\d{2}-\d{2}$/.test(day)
    )
    .sort();

  if (!uniqueDates.length) {
    return 0;
  }

  const dateSet =
    new Set(uniqueDates);

  let best = 0;

  for (
    const date of uniqueDates
  ) {
    const previous =
      addDays(
        date,
        -1
      );

    /*
     * 前日が存在するなら、
     * そこから始まる連続期間で
     * すでに計算されるためスキップ。
     */
    if (
      dateSet.has(previous)
    ) {
      continue;
    }

    let streak = 1;

    let cursor =
      date;

    while (
      dateSet.has(
        addDays(
          cursor,
          1
        )
      )
    ) {
      cursor =
        addDays(
          cursor,
          1
        );

      streak += 1;
    }

    best =
      Math.max(
        best,
        streak
      );
  }

  return best;
}


// ==============================
// 比率
// ==============================

function safeRate(
  current,
  previous
) {
  if (
    Number(previous) === 0
  ) {
    return 0;
  }

  return (
    (
      (Number(current) -
        Number(previous)) /
      Number(previous)
    ) *
    100
  );
}


// ==============================
// メイン
// ==============================

module.exports = async function handler(
  req,
  res
) {
  try {
    if (req.method !== "GET") {
      return res
        .status(405)
        .json({
          ok: false,
          error: "Method Not Allowed",
        });
    }

    const initData =
      req.headers[
        "x-telegram-init-data"
      ];

    const user =
      verifyTelegramInitData(
        initData
      );

    if (!user?.id) {
      return res
        .status(401)
        .json({
          ok: false,
          error: "Unauthorized",
        });
    }

    const userId =
      String(user.id);

    const today =
      getJSTDateString();

    const tomorrow =
      addDays(
        today,
        1
      );

    const monthStart =
      getMonthStart(
        today
      );

    const monthEnd =
      getNextMonthStart(
        today
      );

    const previousMonthStart =
      getPreviousMonthStart(
        today
      );

    const yearStart =
      `${today.slice(0, 4)}-01-01`;

    const yearEnd =
      `${Number(today.slice(0, 4)) + 1}-01-01`;

    const weekDay =
      new Date(
        `${today}T00:00:00Z`
      ).getUTCDay();

    const mondayOffset =
      weekDay === 0
        ? -6
        : 1 - weekDay;

    const weekStart =
      addDays(
        today,
        mondayOffset
      );

    const weekEnd =
      addDays(
        weekStart,
        7
      );

    const previousMonthEnd =
      monthStart;

    const yesterday =
      addDays(
        today,
        -1
      );

    const yesterdayStart =
      yesterday;

    const yesterdayEnd =
      today;


    // ==========================
    // 並列取得
    // ==========================

    const [
      todayStats,
      yesterdayStats,
      weekStats,
      monthStats,
      previousMonthStats,
      yearStats,
      dailyStats,
      best,
      streak,
      recentRecords,
    ] = await Promise.all([
      getAggregate(
        userId,
        today,
        tomorrow
      ),

      getAggregate(
        userId,
        yesterdayStart,
        yesterdayEnd
      ),

      getAggregate(
        userId,
        weekStart,
        weekEnd
      ),

      getAggregate(
        userId,
        monthStart,
        monthEnd
      ),

      getAggregate(
        userId,
        previousMonthStart,
        previousMonthEnd
      ),

      getAggregate(
        userId,
        yearStart,
        yearEnd
      ),

      getDailyStats(
        userId,
        monthStart,
        monthEnd
      ),

      getBestRecords(
        userId
      ),

      getStreak(
        userId
      ),

      getRecentRecords(
        userId,
        30
      ),
    ]);


    // ==========================
    // 基本分析
    // ==========================

    const averageDailyCount =
      monthStats.workDays > 0
        ? monthStats.count /
          monthStats.workDays
        : 0;

    const averageDailySales =
      monthStats.workDays > 0
        ? monthStats.sales /
          monthStats.workDays
        : 0;

    const currentDailyPace =
      monthStats.workDays > 0
        ? monthStats.count /
          monthStats.workDays
        : 0;

    const elapsedDays =
      Math.max(
        1,
        Number(today.slice(8, 10))
      );

    const daysInMonth =
      Math.round(
        (
          new Date(
            `${monthEnd}T00:00:00Z`
          ) -
          new Date(
            `${monthStart}T00:00:00Z`
          )
        ) /
        86400000
      );

    const remainingDays =
      Math.max(
        0,
        daysInMonth -
          elapsedDays
      );

    const projectedMonthCount =
      currentDailyPace *
      daysInMonth;

    const projectedMonthSales =
      monthStats.workDays > 0
        ? (
            monthStats.sales /
            monthStats.workDays
          ) *
          daysInMonth
        : 0;

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


    // ==========================
    // 前日比較
    // ==========================

    const salesChangeFromYesterday =
      todayStats.sales -
      yesterdayStats.sales;

    const countChangeFromYesterday =
      todayStats.count -
      yesterdayStats.count;


    // ==========================
    // 前月比較
    // ==========================

    const salesChangeFromPreviousMonth =
      monthStats.sales -
      previousMonthStats.sales;

    const countChangeFromPreviousMonth =
      monthStats.count -
      previousMonthStats.count;

    const salesChangeFromPreviousMonthRate =
      safeRate(
        monthStats.sales,
        previousMonthStats.sales
      );

    const countChangeFromPreviousMonthRate =
      safeRate(
        monthStats.count,
        previousMonthStats.count
      );


    // ==========================
    // 月間ベスト
    // ==========================

    let monthlyBestCount = 0;
    let monthlyBestSales = 0;

    let monthlyBestCountDate =
      null;

    let monthlyBestSalesDate =
      null;

    for (
      const day of dailyStats
    ) {
      if (
        day.count >
        monthlyBestCount
      ) {
        monthlyBestCount =
          day.count;

        monthlyBestCountDate =
          day.day;
      }

      if (
        day.sales >
        monthlyBestSales
      ) {
        monthlyBestSales =
          day.sales;

        monthlyBestSalesDate =
          day.day;
      }
    }


    // ==========================
    // 自己ベスト判定
    // ==========================

    const isBestCount =
      todayStats.count > 0 &&
      todayStats.count >=
        best.count;

    const isBestSales =
      todayStats.sales > 0 &&
      todayStats.sales >=
        best.sales;


    // ==========================
    // レスポンス
    // ==========================

    return res
      .status(200)
      .json({
        ok: true,

        today: todayStats,

        yesterday:
          yesterdayStats,

        week: weekStats,

        month: monthStats,

        previousMonth:
          previousMonthStats,

        year: yearStats,

        best,

        records:
          recentRecords,

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

          monthlyBestCountDate,
          monthlyBestSalesDate,

          allTimeBestCount:
            best.count,

          allTimeBestSales:
            best.sales,

          allTimeBestCountPerHour:
            best.countPerHour,

          allTimeBestSalesPerHour:
            best.salesPerHour,

          isBestCount,
          isBestSales,

          // 連続稼働
          streak,

          bestStreak:
            streak.best,

          monthProgressRate:
            daysInMonth > 0
              ? (
                  elapsedDays /
                  daysInMonth
                ) *
                100
              : 0,

          elapsedDays,
          daysInMonth,
          remainingDays,

          today,
          yesterday,

          monthStart,
          monthEnd,

          previousMonthStart,
          previousMonthEnd,
        },

        daily:
          dailyStats,
      });

  } catch (error) {
    console.error(
      "/api/analytics error:",
      error
    );

    return res
      .status(500)
      .json({
        ok: false,
        error: "Internal Server Error",
      });
  }
};

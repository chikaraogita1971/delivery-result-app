const { neon } = require("@neondatabase/serverless");
const crypto = require("crypto");

const sql = neon(process.env.DATABASE_URL);
const BOT_TOKEN = process.env.BOT_TOKEN;

const JST = "Asia/Tokyo";

/* =========================================================
   Telegram initData verification
========================================================= */

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
    hash.length !== calculatedHash.length ||
    !crypto.timingSafeEqual(
      Buffer.from(hash, "hex"),
      Buffer.from(calculatedHash, "hex")
    )
  ) {
    throw new Error(
      "Telegram initData の検証に失敗しました"
    );
  }

  const authDate = Number(params.get("auth_date"));

  if (!authDate) {
    throw new Error("auth_date がありません");
  }

  const age =
    Math.floor(Date.now() / 1000) -
    authDate;

  if (age > 60 * 60 || age < -60) {
    throw new Error(
      "Telegram initData の有効期限が切れています"
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
      "Telegramユーザー情報を解析できません"
    );
  }

  if (!user?.id) {
    throw new Error(
      "TelegramユーザーIDが取得できません"
    );
  }

  return {
    id: String(user.id),
    username: user.username || "",
    firstName: user.first_name || ""
  };
}

/* =========================================================
   JST helpers
========================================================= */

function getJSTParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat(
    "en-CA",
    {
      timeZone: JST,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }
  ).formatToParts(date);

  const result = {};

  for (const part of parts) {
    if (part.type !== "literal") {
      result[part.type] = part.value;
    }
  }

  return {
    year: Number(result.year),
    month: Number(result.month),
    day: Number(result.day)
  };
}

function getJSTDateString(date = new Date()) {
  const p = getJSTParts(date);

  return [
    p.year,
    String(p.month).padStart(2, "0"),
    String(p.day).padStart(2, "0")
  ].join("-");
}

function addDays(dateString, days) {
  const date = new Date(
    `${dateString}T00:00:00Z`
  );

  date.setUTCDate(
    date.getUTCDate() + days
  );

  return date
    .toISOString()
    .slice(0, 10);
}

function getMonthStart(date = new Date()) {
  const p = getJSTParts(date);

  return `${p.year}-${String(
    p.month
  ).padStart(2, "0")}-01`;
}

function getMonthEnd(date = new Date()) {
  const p = getJSTParts(date);

  if (p.month === 12) {
    return `${p.year + 1}-01-01`;
  }

  return `${p.year}-${String(
    p.month + 1
  ).padStart(2, "0")}-01`;
}

function getPreviousMonthStart(date = new Date()) {
  const p = getJSTParts(date);

  if (p.month === 1) {
    return `${p.year - 1}-12-01`;
  }

  return `${p.year}-${String(
    p.month - 1
  ).padStart(2, "0")}-01`;
}

function getWeekStart(date = new Date()) {
  const p = getJSTParts(date);

  const utcDate = new Date(
    Date.UTC(
      p.year,
      p.month - 1,
      p.day
    )
  );

  const day =
    utcDate.getUTCDay();

  utcDate.setUTCDate(
    utcDate.getUTCDate() - day
  );

  return utcDate
    .toISOString()
    .slice(0, 10);
}

/* =========================================================
   Aggregate
========================================================= */

async function getAggregate(
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

      COUNT(*) AS records,

      COUNT(
        DISTINCT (
          created_at AT TIME ZONE ${JST}
        )::date
      ) AS work_days

    FROM delivery_results

    WHERE telegram_user_id = ${userId}

      AND (
        created_at AT TIME ZONE ${JST}
      )::date >= ${startDate}::date

      AND (
        created_at AT TIME ZONE ${JST}
      )::date < ${endDate}::date
  `;

  const row =
    rows[0] || {};

  const sales =
    Number(row.sales || 0);

  const count =
    Number(row.count || 0);

  const hours =
    Number(row.hours || 0);

  return {
    sales,
    count,
    hours,

    records:
      Number(row.records || 0),

    workDays:
      Number(row.work_days || 0),

    average:
      count > 0
        ? sales / count
        : 0
  };
}

/* =========================================================
   Daily statistics
   ※ created_at GROUP BY エラー対策済み
========================================================= */

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
          created_at AT TIME ZONE ${JST}
        )::date AS day,

        sale_amount,
        delivery_count,
        work_hours

      FROM delivery_results

      WHERE telegram_user_id = ${userId}

        AND (
          created_at AT TIME ZONE ${JST}
        )::date >= ${startDate}::date

        AND (
          created_at AT TIME ZONE ${JST}
        )::date < ${endDate}::date
    ) AS daily_source

    GROUP BY
      daily_source.day

    ORDER BY
      daily_source.day ASC
  `;

  return rows.map(row => ({
    date: row.day,

    sales:
      Number(row.sales || 0),

    count:
      Number(row.count || 0),

    hours:
      Number(row.hours || 0)
  }));
}

/* =========================================================
   All-time best
========================================================= */

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

    ORDER BY
      created_at ASC
  `;

  if (!rows.length) {
    return {
      count: 0,
      sales: 0,
      countPerHour: 0,
      salesPerHour: 0,
      countDate: null,
      salesDate: null,
      countPerHourDate: null,
      salesPerHourDate: null
    };
  }

  let bestCount = null;
  let bestSales = null;
  let bestCountPerHour = null;
  let bestSalesPerHour = null;

  for (const row of rows) {
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

    const countPerHour =
      hours > 0
        ? count / hours
        : 0;

    const salesPerHour =
      hours > 0
        ? sales / hours
        : 0;

    if (
      !bestCount ||
      count > bestCount.value
    ) {
      bestCount = {
        value: count,
        date: row.created_at
      };
    }

    if (
      !bestSales ||
      sales > bestSales.value
    ) {
      bestSales = {
        value: sales,
        date: row.created_at
      };
    }

    if (
      hours > 0 &&
      (
        !bestCountPerHour ||
        countPerHour >
          bestCountPerHour.value
      )
    ) {
      bestCountPerHour = {
        value: countPerHour,
        date: row.created_at
      };
    }

    if (
      hours > 0 &&
      (
        !bestSalesPerHour ||
        salesPerHour >
          bestSalesPerHour.value
      )
    ) {
      bestSalesPerHour = {
        value: salesPerHour,
        date: row.created_at
      };
    }
  }

  return {
    count:
      bestCount?.value || 0,

    sales:
      bestSales?.value || 0,

    countPerHour:
      bestCountPerHour?.value || 0,

    salesPerHour:
      bestSalesPerHour?.value || 0,

    countDate:
      bestCount?.date || null,

    salesDate:
      bestSales?.date || null,

    countPerHourDate:
      bestCountPerHour?.date || null,

    salesPerHourDate:
      bestSalesPerHour?.date || null
  };
}

/* =========================================================
   Streak
   ※ 今日の実績があれば必ず1日
========================================================= */

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

  if (!rows.length) {
    return {
      current: 0,
      best: 0
    };
  }

  const dates =
    rows.map(row =>
      String(row.day)
    );

  const today =
    getJSTDateString();

  const yesterday =
    addDays(today, -1);

  let current = 0;

  /*
   * 今日または昨日に実績があれば
   * 現在の連続稼働を計算する
   */
  if (
    dates[0] === today ||
    dates[0] === yesterday
  ) {
    let expected =
      dates[0];

    for (const date of dates) {
      if (date !== expected) {
        break;
      }

      current++;

      expected =
        addDays(
          expected,
          -1
        );
    }
  }

  /*
   * 過去最高連続稼働
   */
  let best = 0;
  let streak = 0;
  let previous = null;

  const sortedDates =
    [...dates].sort();

  for (const date of sortedDates) {
    if (!previous) {
      streak = 1;
    } else {
      const next =
        addDays(
          previous,
          1
        );

      if (date === next) {
        streak++;
      } else {
        streak = 1;
      }
    }

    if (streak > best) {
      best = streak;
    }

    previous = date;
  }

  return {
    current,
    best
  };
}

/* =========================================================
   Recent records
========================================================= */

async function getRecentRecords(
  userId,
  startDate,
  endDate
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

      AND (
        created_at AT TIME ZONE ${JST}
      )::date >= ${startDate}::date

      AND (
        created_at AT TIME ZONE ${JST}
      )::date < ${endDate}::date

    ORDER BY
      created_at DESC

    LIMIT 20
  `;

  return rows.map(row => ({
    id:
      Number(row.id),

    sale_amount:
      Number(
        row.sale_amount || 0
      ),

    delivery_count:
      Number(
        row.delivery_count || 0
      ),

    work_hours:
      Number(
        row.work_hours || 0
      ),

    created_at:
      row.created_at
  }));
}

/* =========================================================
   Main handler
========================================================= */

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

    const initData =
      req.headers[
        "x-telegram-init-data"
      ];

    const user =
      verifyTelegramInitData(
        initData
      );

    const now =
      new Date();

    const today =
      getJSTDateString(now);

    const yesterday =
      addDays(today, -1);

    const tomorrow =
      addDays(today, 1);

    const weekStart =
      getWeekStart(now);

    const monthStart =
      getMonthStart(now);

    const monthEnd =
      getMonthEnd(now);

    const previousMonthStart =
      getPreviousMonthStart(now);

    const previousMonthEnd =
      monthStart;

    const currentYear =
      getJSTParts(now).year;

    const yearStart =
      `${currentYear}-01-01`;

    const yearEnd =
      `${currentYear + 1}-01-01`;

    /* =====================================================
       Period data
    ===================================================== */

    const [
      todayData,
      yesterdayData,
      weekData,
      monthData,
      previousMonthData,
      yearData
    ] = await Promise.all([
      getAggregate(
        user.id,
        today,
        tomorrow
      ),

      getAggregate(
        user.id,
        yesterday,
        today
      ),

      getAggregate(
        user.id,
        weekStart,
        tomorrow
      ),

      getAggregate(
        user.id,
        monthStart,
        tomorrow
      ),

      getAggregate(
        user.id,
        previousMonthStart,
        previousMonthEnd
      ),

      getAggregate(
        user.id,
        yearStart,
        yearEnd
      )
    ]);

    /* =====================================================
       Daily
    ===================================================== */

    const monthlyDaily =
      await getDailyStats(
        user.id,
        monthStart,
        tomorrow
      );

    /* =====================================================
       Best
    ===================================================== */

    const best =
      await getBestRecords(
        user.id
      );

    /* =====================================================
       Streak
    ===================================================== */

    const streak =
      await getStreak(
        user.id
      );

    /* =====================================================
       Today's records
    ===================================================== */

    const records =
      await getRecentRecords(
        user.id,
        today,
        tomorrow
      );

    /* =====================================================
       Analysis
    ===================================================== */

    const dateParts =
      getJSTParts(now);

    const daysInMonth =
      new Date(
        Date.UTC(
          dateParts.year,
          dateParts.month,
          0
        )
      ).getUTCDate();

    const elapsedDays =
      Math.min(
        dateParts.day,
        daysInMonth
      );

    const averageDailyCount =
      monthData.workDays > 0
        ? monthData.count /
          monthData.workDays
        : 0;

    const averageDailySales =
      monthData.workDays > 0
        ? monthData.sales /
          monthData.workDays
        : 0;

    const currentDailyPace =
      elapsedDays > 0
        ? monthData.count /
          elapsedDays
        : 0;

    const currentDailySalesPace =
      elapsedDays > 0
        ? monthData.sales /
          elapsedDays
        : 0;

    const projectedMonthCount =
      currentDailyPace *
      daysInMonth;

    const projectedMonthSales =
      currentDailySalesPace *
      daysInMonth;

    const averageUnitPrice =
      monthData.count > 0
        ? monthData.sales /
          monthData.count
        : 0;

    const countPerHour =
      monthData.hours > 0
        ? monthData.count /
          monthData.hours
        : 0;

    const salesPerHour =
      monthData.hours > 0
        ? monthData.sales /
          monthData.hours
        : 0;

    const todayHourlySales =
      todayData.hours > 0
        ? todayData.sales /
          todayData.hours
        : 0;

    const todayCountPerHour =
      todayData.hours > 0
        ? todayData.count /
          todayData.hours
        : 0;

    const todayAverageUnitPrice =
      todayData.count > 0
        ? todayData.sales /
          todayData.count
        : 0;

    const salesChangeFromYesterday =
      todayData.sales -
      yesterdayData.sales;

    const countChangeFromYesterday =
      todayData.count -
      yesterdayData.count;

    const salesChangeFromPreviousMonth =
      monthData.sales -
      previousMonthData.sales;

    const countChangeFromPreviousMonth =
      monthData.count -
      previousMonthData.count;

    const salesChangeFromPreviousMonthRate =
      previousMonthData.sales > 0
        ? (
            salesChangeFromPreviousMonth /
            previousMonthData.sales
          ) * 100
        : 0;

    const countChangeFromPreviousMonthRate =
      previousMonthData.count > 0
        ? (
            countChangeFromPreviousMonth /
            previousMonthData.count
          ) * 100
        : 0;

    const monthlyBestCount =
      monthlyDaily.length > 0
        ? Math.max(
            ...monthlyDaily.map(
              row => row.count
            )
          )
        : 0;

    const monthlyBestSales =
      monthlyDaily.length > 0
        ? Math.max(
            ...monthlyDaily.map(
              row => row.sales
            )
          )
        : 0;

    const monthlyBestCountRow =
      monthlyDaily.find(
        row =>
          row.count ===
          monthlyBestCount
      );

    const monthlyBestSalesRow =
      monthlyDaily.find(
        row =>
          row.sales ===
          monthlyBestSales
      );

    const isBestCount =
      todayData.count > 0 &&
      todayData.count >=
        best.count;

    const isBestSales =
      todayData.sales > 0 &&
      todayData.sales >=
        best.sales;

    const monthProgressRate =
      daysInMonth > 0
        ? (
            elapsedDays /
            daysInMonth
          ) * 100
        : 0;

    /* =====================================================
       Response
    ===================================================== */

    return res.status(200).json({
      ok: true,

      today:
        todayData,

      yesterday:
        yesterdayData,

      week:
        weekData,

      month:
        monthData,

      previousMonth:
        previousMonthData,

      year:
        yearData,

      best,

      records,

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
          previousMonthData.sales,

        previousMonthCount:
          previousMonthData.count,

        previousMonthHours:
          previousMonthData.hours,

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

        streak:
          streak.current,

        bestStreak:
          streak.best,

        monthProgressRate,

        elapsedDays,

        daysInMonth,

        remainingDays:
          Math.max(
            0,
            daysInMonth -
              elapsedDays
          ),

        today,

        yesterday,

        monthStart,

        monthEnd,

        previousMonthStart,

        previousMonthEnd
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
        error.message ||
        "分析データの取得に失敗しました"
    });
  }
};
};

const { neon } = require("@neondatabase/serverless");

const sql = neon(process.env.DATABASE_URL);

const BOT_TOKEN = process.env.BOT_TOKEN;
const JST = "Asia/Tokyo";

function json(res, status, data) {
  res.status(status).json(data);
}

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
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}=${value}`)
      .join("\n");

    const crypto = require("crypto");

    const secretKey = crypto
      .createHmac("sha256", "WebAppData")
      .update(BOT_TOKEN)
      .digest();

    const calculatedHash = crypto
      .createHmac("sha256", secretKey)
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

function getJstDate() {
  return new Intl.DateTimeFormat(
    "en-CA",
    {
      timeZone: JST,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }
  ).format(new Date());
}

function getJstDateOffset(days) {
  const now = new Date();

  const jstString =
    new Intl.DateTimeFormat(
      "en-US",
      {
        timeZone: JST,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false
      }
    ).format(now);

  const base = new Date(jstString);

  base.setDate(
    base.getDate() + days
  );

  const year =
    base.getFullYear();

  const month =
    String(
      base.getMonth() + 1
    ).padStart(2, "0");

  const day =
    String(
      base.getDate()
    ).padStart(2, "0");

  return `${year}-${month}-${day}`;
}

module.exports = async function handler(
  req,
  res
) {
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
    const today =
      getJstDate();

    const yesterday =
      getJstDateOffset(-1);

    const [
      todayResult,
      yesterdayResult,
      weekResult,
      monthResult,
      goalResult,
      bestResult
    ] = await Promise.all([
      sql`
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
      `,

      sql`
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
          ${yesterday}::date
      `,

      sql`
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

          AND date_trunc(
            'week',
            created_at
            AT TIME ZONE ${JST}
          )
          =
          date_trunc(
            'week',
            ${today}::date
          )
      `,

      sql`
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

          AND date_trunc(
            'month',
            created_at
            AT TIME ZONE ${JST}
          )
          =
          date_trunc(
            'month',
            ${today}::date
          )
      `,

      sql`
        SELECT monthly_goal

        FROM delivery_goals

        WHERE telegram_user_id =
          ${userId}

        LIMIT 1
      `,

      sql`
        SELECT
          COALESCE(
            MAX(delivery_count),
            0
          ) AS best_count,

          COALESCE(
            MAX(sale_amount),
            0
          ) AS best_sales,

          COALESCE(
            MAX(
              CASE
                WHEN work_hours > 0
                THEN
                  delivery_count /
                  work_hours
                ELSE 0
              END
            ),
            0
          ) AS best_count_per_hour,

          COALESCE(
            MAX(
              CASE
                WHEN work_hours > 0
                THEN
                  sale_amount /
                  work_hours
                ELSE 0
              END
            ),
            0
          ) AS best_sales_per_hour

        FROM delivery_results

        WHERE telegram_user_id =
          ${userId}
      `
    ]);
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

    const bestData =
      bestResult[0] || {};

    const todaySales =
      Number(todayData.sales || 0);

    const todayCount =
      Number(todayData.count || 0);

    const todayHours =
      Number(todayData.hours || 0);

    const yesterdaySales =
      Number(
        yesterdayData.sales || 0
      );

    const yesterdayCount =
      Number(
        yesterdayData.count || 0
      );

    const monthSales =
      Number(monthData.sales || 0);

    const monthCount =
      Number(monthData.count || 0);

    const monthHours =
      Number(monthData.hours || 0);

    const workDays =
      Number(
        monthData.work_days || 0
      );

    const now = new Date();

    const jstNow =
      new Date(
        now.toLocaleString(
          "en-US",
          {
            timeZone: JST
          }
        )
      );

    const year =
      jstNow.getFullYear();

    const month =
      jstNow.getMonth();

    const daysInMonth =
      new Date(
        year,
        month + 1,
        0
      ).getDate();

    const elapsedDays =
      Math.max(
        1,
        jstNow.getDate()
      );

    const remainingDays =
      Math.max(
        0,
        daysInMonth -
          elapsedDays
      );

    const averageDailyCount =
      monthCount /
      elapsedDays;

    const averageDailySales =
      monthSales /
      elapsedDays;

    const currentDailyPace =
      averageDailyCount;

    const projectedMonthCount =
      currentDailyPace *
      daysInMonth;

    const projectedMonthSales =
      averageDailySales *
      daysInMonth;

    const remainingGoalCount =
      Math.max(
        0,
        goal - monthCount
      );

    const requiredDailyCount =
      remainingDays > 0
        ? remainingGoalCount /
          remainingDays
        : remainingGoalCount;

    const goalRate =
      goal > 0
        ? (monthCount / goal) * 100
        : 0;

    const averageUnitPrice =
      monthCount > 0
        ? monthSales / monthCount
        : 0;

    const salesChangeFromYesterday =
      todaySales -
      yesterdaySales;

    const countChangeFromYesterday =
      todayCount -
      yesterdayCount;

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

    const bestCount =
      Number(
        bestData.best_count || 0
      );

    const bestSales =
      Number(
        bestData.best_sales || 0
      );

    const bestCountPerHour =
      Number(
        bestData.best_count_per_hour ||
          0
      );

    const bestSalesPerHour =
      Number(
        bestData.best_sales_per_hour ||
          0
      );

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

          AND date_trunc(
            'month',
            created_at
            AT TIME ZONE ${JST}
          )
          =
          date_trunc(
            'month',
            ${today}::date
          )

        GROUP BY
          (
            created_at
            AT TIME ZONE ${JST}
          )::date

        ORDER BY date ASC
      `;

    const daily =
      dailyResult.map(row => ({
        date: row.date,

        sales:
          Number(
            row.sales || 0
          ),

        count:
          Number(
            row.count || 0
          ),

        hours:
          Number(
            row.hours || 0
          ),

        countPerHour:
          Number(row.hours || 0) > 0
            ? Number(row.count || 0) /
              Number(row.hours)
            : 0,

        salesPerHour:
          Number(row.hours || 0) > 0
            ? Number(row.sales || 0) /
              Number(row.hours)
            : 0
      }));

    let bestDayCount = 0;
    let bestDayCountDate = null;

    let bestDaySales = 0;
    let bestDaySalesDate = null;

    for (const day of daily) {
      if (day.count > bestDayCount) {
        bestDayCount =
          day.count;

        bestDayCountDate =
          day.date;
      }

      if (day.sales > bestDaySales) {
        bestDaySales =
          day.sales;

        bestDaySalesDate =
          day.date;
      }
    }
        return json(res, 200, {
      ok: true,

      today: {
        sales: todaySales,
        count: todayCount,
        hours: todayHours
      },

      yesterday: {
        sales: yesterdaySales,
        count: yesterdayCount
      },

      week: {
        sales:
          Number(
            weekData.sales || 0
          ),

        count:
          Number(
            weekData.count || 0
          ),

        hours:
          Number(
            weekData.hours || 0
          )
      },

      month: {
        sales: monthSales,
        count: monthCount,
        hours: monthHours,
        workDays
      },

      goal,

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

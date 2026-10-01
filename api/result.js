const { neon } = require("@neondatabase/serverless");
const crypto = require("crypto");

const sql = neon(process.env.DATABASE_URL);
const BOT_TOKEN = process.env.BOT_TOKEN;

// =========================================================
// Telegram認証
// =========================================================

function parseInitData(initData) {
  const raw = String(initData || "");

  if (!raw) return null;

  const params = new URLSearchParams(raw);
  const hash = params.get("hash");

  if (!hash) return null;

  const dataCheckString = [...params.entries()]
    .filter(([key]) => key !== "hash")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

  if (!BOT_TOKEN) {
    console.error("[RESULT] BOT_TOKEN is not configured");
    return null;
  }

  try {
    const secretKey = crypto
      .createHmac("sha256", "WebAppData")
      .update(BOT_TOKEN)
      .digest();

    const calculatedHash = crypto
      .createHmac("sha256", secretKey)
      .update(dataCheckString)
      .digest("hex");

    const hashBuffer = Buffer.from(hash, "hex");
    const calculatedBuffer = Buffer.from(
      calculatedHash,
      "hex"
    );

    if (
      hashBuffer.length !==
      calculatedBuffer.length
    ) {
      return null;
    }

    if (
      !crypto.timingSafeEqual(
        hashBuffer,
        calculatedBuffer
      )
    ) {
      return null;
    }

    const authDate = Number(
      params.get("auth_date") || 0
    );

    if (!authDate) return null;

    const now = Math.floor(
      Date.now() / 1000
    );

    if (
      now - authDate > 86400 ||
      authDate - now > 60
    ) {
      return null;
    }

    const userRaw = params.get("user");

    if (!userRaw) return null;

    const user = JSON.parse(userRaw);

    if (!user?.id) return null;

    return user;
  } catch (error) {
    console.error(
      "[RESULT] Telegram auth error:",
      error?.message
    );

    return null;
  }
}

function getTelegramUserId(req) {
  const initData =
    req.headers["x-telegram-init-data"] || "";

  const user =
    parseInitData(initData);

  if (!user?.id) {
    return null;
  }

  return String(user.id);
}

// =========================================================
// 数値・入力チェック
// =========================================================

function parseInteger(value) {
  const number = Number(value);

  if (!Number.isInteger(number)) {
    return null;
  }

  return number;
}

function parseWorkHours(value) {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    return null;
  }

  return Math.round(
    number * 100
  ) / 100;
}

function validateResultInput(body) {
  const saleAmount =
    parseInteger(body?.saleAmount);

  const deliveryCount =
    parseInteger(body?.deliveryCount);

  const workHours =
    parseWorkHours(body?.workHours);

  if (
    saleAmount === null ||
    deliveryCount === null ||
    workHours === null
  ) {
    return {
      error:
        "売上・配達数・稼働時間を正しく入力してください。",
    };
  }

  if (saleAmount < 0) {
    return {
      error:
        "売上は0円以上で入力してください。",
    };
  }

  if (deliveryCount < 0) {
    return {
      error:
        "配達数は0件以上で入力してください。",
    };
  }

  if (workHours <= 0) {
    return {
      error:
        "稼働時間は0より大きい値を入力してください。",
    };
  }

  if (workHours > 999.99) {
    return {
      error:
        "稼働時間が大きすぎます。",
    };
  }

  return {
    saleAmount,
    deliveryCount,
    workHours,
  };
}

// =========================================================
// JST日付
// =========================================================

function getJstTodayParts() {
  const now = new Date();

  const parts =
    new Intl.DateTimeFormat(
      "en-CA",
      {
        timeZone: "Asia/Tokyo",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }
    ).formatToParts(now);

  return {
    year: Number(
      parts.find(
        item => item.type === "year"
      )?.value
    ),

    month: Number(
      parts.find(
        item => item.type === "month"
      )?.value
    ),

    day: Number(
      parts.find(
        item => item.type === "day"
      )?.value
    ),
  };
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function toJstDateString(
  year,
  month,
  day
) {
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

function jstDateToUtc(
  year,
  month,
  day
) {
  return new Date(
    `${toJstDateString(
      year,
      month,
      day
    )}T00:00:00+09:00`
  );
}

/*
 * PostgreSQLのDATEが環境によって
 * Dateオブジェクトになる場合にも
 * YYYY-MM-DDで返す。
 */
function normalizeDateValue(value) {
  if (!value) return "";

  if (
    typeof value === "string"
  ) {
    const match =
      /^(\d{4})-(\d{2})-(\d{2})/.exec(
        value
      );

    if (match) {
      return `${match[1]}-${match[2]}-${match[3]}`;
    }

    return value;
  }

  if (
    value instanceof Date &&
    !Number.isNaN(value.getTime())
  ) {
    return [
      value.getUTCFullYear(),
      pad2(value.getUTCMonth() + 1),
      pad2(value.getUTCDate()),
    ].join("-");
  }

  return String(value);
}

// =========================================================
// 期間計算
// =========================================================

function getPeriodRange(
  period,
  requestedMonth,
  requestedYear
) {
  const today =
    getJstTodayParts();

  let year = today.year;
  let month = today.month;

  // 指定月
  if (
    period === "month" &&
    requestedMonth
  ) {
    const match =
      /^(\d{4})-(\d{1,2})$/.exec(
        String(requestedMonth)
      );

    if (!match) {
      return {
        error:
          "月の指定はYYYY-MM形式で指定してください。",
      };
    }

    year = Number(match[1]);
    month = Number(match[2]);

    if (
      month < 1 ||
      month > 12
    ) {
      return {
        error:
          "月の指定が正しくありません。",
      };
    }
  }

  // 指定年
  if (
    period === "year" &&
    requestedYear
  ) {
    const match =
      /^(\d{4})$/.exec(
        String(requestedYear)
      );

    if (!match) {
      return {
        error:
          "年の指定はYYYY形式で指定してください。",
      };
    }

    year = Number(match[1]);

    if (
      year < 2000 ||
      year > 2100
    ) {
      return {
        error:
          "年の指定が正しくありません。",
      };
    }
  }

  // 今日
  if (period === "today") {
    const start =
      jstDateToUtc(
        today.year,
        today.month,
        today.day
      );

    const end =
      new Date(start);

    end.setUTCDate(
      end.getUTCDate() + 1
    );

    return {
      start: start.toISOString(),
      end: end.toISOString(),
      label: toJstDateString(
        today.year,
        today.month,
        today.day
      ),
    };
  }

  // 今週
  if (period === "week") {
    const current =
      jstDateToUtc(
        today.year,
        today.month,
        today.day
      );

    const weekday =
      current.getUTCDay();

    const mondayOffset =
      weekday === 0
        ? -6
        : 1 - weekday;

    const start =
      new Date(current);

    start.setUTCDate(
      start.getUTCDate() +
        mondayOffset
    );

    const end =
      new Date(start);

    end.setUTCDate(
      end.getUTCDate() + 7
    );

    return {
      start: start.toISOString(),
      end: end.toISOString(),
      label: "今週",
    };
  }

  // 月
  if (period === "month") {
    const start =
      jstDateToUtc(
        year,
        month,
        1
      );

    const end =
      month === 12
        ? jstDateToUtc(
            year + 1,
            1,
            1
          )
        : jstDateToUtc(
            year,
            month + 1,
            1
          );

    return {
      start: start.toISOString(),
      end: end.toISOString(),
      label:
        `${year}-${pad2(month)}`,
    };
  }

  // 年
  if (period === "year") {
    const start =
      jstDateToUtc(
        year,
        1,
        1
      );

    const end =
      jstDateToUtc(
        year + 1,
        1,
        1
      );

    return {
      start: start.toISOString(),
      end: end.toISOString(),
      label: `${year}年`,
    };
  }

  return null;
}

// =========================================================
// 集計
// =========================================================

async function getStats(
  userId,
  start,
  end
) {
  const rows = await sql`
    SELECT
      COUNT(*) AS records,

      COALESCE(
        SUM(sale_amount),
        0
      ) AS sales,

      COALESCE(
        SUM(delivery_count),
        0
      ) AS delivery_count,

      COALESCE(
        SUM(work_hours),
        0
      ) AS work_hours

    FROM delivery_results

    WHERE telegram_user_id =
      ${userId}

      AND created_at >=
        ${start}

      AND created_at <
        ${end}
  `;

  const row =
    rows[0] || {};

  const records =
    Number(row.records || 0);

  const sales =
    Number(row.sales || 0);

  const deliveryCount =
    Number(
      row.delivery_count || 0
    );

  const workHours =
    Number(
      row.work_hours || 0
    );

  return {
    records,
    sales,
    deliveryCount,
    workHours,

    unitPrice:
      deliveryCount > 0
        ? sales / deliveryCount
        : 0,

    hourlySales:
      workHours > 0
        ? sales / workHours
        : 0,
  };
}

// =========================================================
// 実績履歴
// =========================================================

async function getRecentResults(
  userId,
  start,
  end
) {
  const rows = await sql`
    SELECT
      id,
      sale_amount,
      delivery_count,
      work_hours,
      created_at

    FROM delivery_results

    WHERE telegram_user_id =
      ${userId}

      AND created_at >=
        ${start}

      AND created_at <
        ${end}

    ORDER BY
      created_at DESC,
      id DESC

    LIMIT 50
  `;

  return rows.map(row => {
    const sales =
      Number(
        row.sale_amount || 0
      );

    const deliveryCount =
      Number(
        row.delivery_count || 0
      );

    const workHours =
      Number(
        row.work_hours || 0
      );

    return {
      id: Number(row.id),

      saleAmount: sales,

      deliveryCount,

      workHours,

      unitPrice:
        deliveryCount > 0
          ? sales / deliveryCount
          : 0,

      hourlySales:
        workHours > 0
          ? sales / workHours
          : 0,

      createdAt:
        row.created_at,
    };
  });
}

// =========================================================
// 日別集計
// =========================================================

async function getDailyResults(
  userId,
  start,
  end
) {
  const rows = await sql`
    SELECT
      (
        created_at AT TIME ZONE
        'Asia/Tokyo'
      )::date AS result_date,

      COALESCE(
        SUM(sale_amount),
        0
      ) AS sales,

      COALESCE(
        SUM(delivery_count),
        0
      ) AS delivery_count,

      COALESCE(
        SUM(work_hours),
        0
      ) AS work_hours,

      COUNT(*) AS records

    FROM delivery_results

    WHERE telegram_user_id =
      ${userId}

      AND created_at >=
        ${start}

      AND created_at <
        ${end}

    GROUP BY
      result_date

    ORDER BY
      result_date ASC
  `;

  return rows.map(row => {
    const sales =
      Number(
        row.sales || 0
      );

    const deliveryCount =
      Number(
        row.delivery_count || 0
      );

    const workHours =
      Number(
        row.work_hours || 0
      );

    return {
      date:
        normalizeDateValue(
          row.result_date
        ),

      sales,

      deliveryCount,

      workHours,

      records:
        Number(
          row.records || 0
        ),

      unitPrice:
        deliveryCount > 0
          ? sales / deliveryCount
          : 0,

      hourlySales:
        workHours > 0
          ? sales / workHours
          : 0,
    };
  });
}

// =========================================================
// 月次レポート
// =========================================================

function buildMonthlyReport(
  stats,
  daily
) {
  const workingDays =
    daily.filter(
      day =>
        Number(day.records || 0) > 0
    ).length;

  let bestSalesDay = null;
  let bestDeliveryDay = null;
  let bestHourlyDay = null;

  for (const day of daily) {

    if (
      !bestSalesDay ||
      Number(day.sales || 0) >
        Number(
          bestSalesDay.sales || 0
        )
    ) {
      bestSalesDay = day;
    }

    if (
      !bestDeliveryDay ||
      Number(
        day.deliveryCount || 0
      ) >
        Number(
          bestDeliveryDay.deliveryCount || 0
        )
    ) {
      bestDeliveryDay = day;
    }

    if (
      !bestHourlyDay ||
      Number(
        day.hourlySales || 0
      ) >
        Number(
          bestHourlyDay.hourlySales || 0
        )
    ) {
      bestHourlyDay = day;
    }
  }

  return {
    sales:
      Number(stats.sales || 0),

    deliveryCount:
      Number(
        stats.deliveryCount || 0
      ),

    workHours:
      Number(
        stats.workHours || 0
      ),

    records:
      Number(stats.records || 0),

    workingDays,

    averageDailySales:
      workingDays > 0
        ? Number(stats.sales || 0) /
          workingDays
        : 0,

    averageDailyDeliveryCount:
      workingDays > 0
        ? Number(
            stats.deliveryCount || 0
          ) /
          workingDays
        : 0,

    averageDailyWorkHours:
      workingDays > 0
        ? Number(
            stats.workHours || 0
          ) /
          workingDays
        : 0,

    unitPrice:
      Number(stats.unitPrice || 0),

    hourlySales:
      Number(stats.hourlySales || 0),

    bestSalesDay,

    bestDeliveryDay,

    bestHourlyDay,
  };
}

// =========================================================
// 月次レポート用の期間
// 「今日・今週」でも現在月のレポートを返す
// 指定月の場合はその月のレポートを返す
// =========================================================

function getReportRange(
  period,
  requestedMonth
) {
  if (
    period === "month"
  ) {
    return getPeriodRange(
      "month",
      requestedMonth,
      null
    );
  }

  const today =
    getJstTodayParts();

  return getPeriodRange(
    "month",
    `${today.year}-${pad2(today.month)}`,
    null
  );
}
async function updateResult(
  userId,
  resultId,
  saleAmount,
  deliveryCount,
  workHours
) {
  const rows = await sql`
    UPDATE delivery_results
    SET
      sale_amount = ${saleAmount},
      delivery_count = ${deliveryCount},
      work_hours = ${workHours}
    WHERE
      id = ${resultId}
      AND telegram_user_id = ${userId}
    RETURNING
      id,
      sale_amount,
      delivery_count,
      work_hours,
      created_at
  `;

  if (!rows.length) {
    const error = new Error(
      "指定された実績が見つからないか、編集権限がありません。"
    );
    error.statusCode = 404;
    throw error;
  }

  return rows[0];
}

async function deleteResult(userId, resultId) {
  const rows = await sql`
    DELETE FROM delivery_results
    WHERE
      id = ${resultId}
      AND telegram_user_id = ${userId}
    RETURNING
      id,
      sale_amount,
      delivery_count,
      work_hours,
      created_at
  `;

  if (!rows.length) {
    const error = new Error(
      "指定された実績が見つからないか、削除権限がありません。"
    );
    error.statusCode = 404;
    throw error;
  }

  return rows[0];
}

async function handleGet(req, res, userId) {
  const period = String(
    req.query.period || "today"
  ).toLowerCase();

  const requestedMonth =
    req.query.month
      ? String(req.query.month)
      : null;

  const requestedYear =
    req.query.year
      ? String(req.query.year)
      : null;

  const allowedPeriods = [
    "today",
    "week",
    "month",
    "year"
  ];

  if (!allowedPeriods.includes(period)) {
    return res.status(400).json({
      ok: false,
      error: "period が不正です。"
    });
  }

  const range = getPeriodRange(
    period,
    requestedMonth,
    requestedYear
  );

  const [
    stats,
    recentResults,
    daily
  ] = await Promise.all([
    getStats(
      userId,
      range.start,
      range.end
    ),
    getRecentResults(
      userId,
      range.start,
      range.end
    ),
    getDailyResults(
      userId,
      range.start,
      range.end
    )
  ]);

  const reportRange =
    getReportRange(
      period,
      requestedMonth
    );

  let reportStats;
  let reportDaily;

  if (
    reportRange.start === range.start &&
    reportRange.end === range.end
  ) {
    reportStats = stats;
    reportDaily = daily;
  } else {
    [
      reportStats,
      reportDaily
    ] = await Promise.all([
      getStats(
        userId,
        reportRange.start,
        reportRange.end
      ),
      getDailyResults(
        userId,
        reportRange.start,
        reportRange.end
      )
    ]);
  }

  const monthlyReport =
    buildMonthlyReport(
      reportStats,
      reportDaily
    );

  return res.status(200).json({
    ok: true,

    period,

    requestedMonth:
      requestedMonth || null,

    requestedYear:
      requestedYear || null,

    label:
      range.label,

    range: {
      start: range.start,
      end: range.end
    },

    stats,

    monthlyReport,

    monthlyReportRange: {
      start: reportRange.start,
      end: reportRange.end
    },

    recentResults,

    daily
  });
}

async function handlePut(req, res, userId) {
  const resultId =
    parseInteger(
      req.body?.id,
      "id"
    );

  const saleAmount =
    parseInteger(
      req.body?.saleAmount,
      "saleAmount"
    );

  const deliveryCount =
    parseInteger(
      req.body?.deliveryCount,
      "deliveryCount"
    );

  const workHours =
    parseWorkHours(
      req.body?.workHours
    );

  validateResultInput(
    saleAmount,
    deliveryCount,
    workHours
  );

  const updated =
    await updateResult(
      userId,
      resultId,
      saleAmount,
      deliveryCount,
      workHours
    );

  await writeAuditLog(
    userId,
    null,
    "update_result",
    {
      resultId,
      saleAmount,
      deliveryCount,
      workHours
    }
  );

  return res.status(200).json({
    ok: true,
    result: {
      id: Number(updated.id),
      saleAmount: Number(
        updated.sale_amount
      ),
      deliveryCount: Number(
        updated.delivery_count
      ),
      workHours: Number(
        updated.work_hours
      ),
      createdAt:
        normalizeDateValue(
          updated.created_at
        )
    }
  });
}

async function handleDelete(req, res, userId) {
  const resultId =
    parseInteger(
      req.body?.id ??
        req.query?.id,
      "id"
    );

  const deleted =
    await deleteResult(
      userId,
      resultId
    );

  await writeAuditLog(
    userId,
    null,
    "delete_result",
    {
      resultId
    }
  );

  return res.status(200).json({
    ok: true,
    result: {
      id: Number(deleted.id)
    }
  });
}

module.exports = async function handler(
  req,
  res
) {
  try {
    if (
      !process.env.DATABASE_URL
    ) {
      return res.status(500).json({
        ok: false,
        error:
          "DATABASE_URL が設定されていません。"
      });
    }

    const userId =
      getTelegramUserId(req);

    if (!userId) {
      return res.status(401).json({
        ok: false,
        error:
          "Telegram認証に失敗しました。Telegramのミニアプリから開いてください。"
      });
    }

    if (req.method === "GET") {
      return await handleGet(
        req,
        res,
        userId
      );
    }

    if (
      req.method === "PUT" ||
      req.method === "PATCH"
    ) {
      return await handlePut(
        req,
        res,
        userId
      );
    }

    if (req.method === "DELETE") {
      return await handleDelete(
        req,
        res,
        userId
      );
    }

    res.setHeader(
      "Allow",
      "GET, PUT, PATCH, DELETE"
    );

    return res.status(405).json({
      ok: false,
      error:
        "Method Not Allowed"
    });
  } catch (error) {
    console.error(
      "[RESULT API] error:",
      error
    );

    const statusCode =
      Number(error?.statusCode) || 500;

    return res.status(statusCode).json({
      ok: false,
      error:
        statusCode === 500
          ? "サーバーエラーが発生しました。"
          : error.message
    });
  }
};

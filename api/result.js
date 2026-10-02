const { neon } = require("@neondatabase/serverless");
const crypto = require("crypto");

const sql = neon(process.env.DATABASE_URL);
const BOT_TOKEN = process.env.BOT_TOKEN;

// =========================================================
// Telegram認証
// =========================================================

function parseInitData(initData) {
  const raw = String(initData || "");

  if (!raw) {
    return null;
  }

  const params = new URLSearchParams(raw);
  const hash = params.get("hash");

  if (!hash || !BOT_TOKEN) {
    return null;
  }

  const dataCheckString = [...params.entries()]
    .filter(([key]) => key !== "hash")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

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

    if (!authDate) {
      return null;
    }

    const now = Math.floor(
      Date.now() / 1000
    );

    // 24時間以上古い認証情報は拒否
    if (
      now - authDate > 86400 ||
      authDate - now > 60
    ) {
      return null;
    }

    const userRaw = params.get("user");

    if (!userRaw) {
      return null;
    }

    const user = JSON.parse(userRaw);

    if (!user?.id) {
      return null;
    }

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

  const user = parseInitData(initData);

  if (!user?.id) {
    return null;
  }

  return String(user.id);
}

// =========================================================
// 入力チェック
// =========================================================

function parseInteger(value) {
  const number = Number(value);

  if (!Number.isInteger(number)) {
    return null;
  }

  return number;
}

function parseOptionalInteger(value) {
  if (
    value === undefined ||
    value === null ||
    value === ""
  ) {
    return null;
  }

  return parseInteger(value);
}

function parseWorkHours(value) {
  if (
    value === undefined ||
    value === null ||
    value === ""
  ) {
    return null;
  }

  const number = Number(value);

  if (!Number.isFinite(number)) {
    return null;
  }

  return Math.round(number * 100) / 100;
}

function parseOptionalDecimal(value) {
  if (
    value === undefined ||
    value === null ||
    value === ""
  ) {
    return null;
  }

  const number = Number(value);

  if (!Number.isFinite(number)) {
    return null;
  }

  return Math.round(number * 100) / 100;
}

function parseStartedAt(value) {
  if (
    value === undefined ||
    value === null ||
    value === ""
  ) {
    return null;
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date.toISOString();
}

function validateResultInput(body) {
  const saleAmount =
    parseInteger(body?.saleAmount);

  const deliveryCount =
    parseInteger(body?.deliveryCount);

  const workHours =
    parseWorkHours(body?.workHours);

  const distanceKm =
    parseOptionalDecimal(
      body?.distanceKm
    );

  const workStartedAt =
    parseStartedAt(
      body?.workStartedAt
    );

  if (
    saleAmount === null ||
    deliveryCount === null
  ) {
    return {
      error:
        "売上・配達数を正しく入力してください。",
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

  if (
    body?.workHours !== undefined &&
    body?.workHours !== null &&
    body?.workHours !== ""
  ) {
    if (workHours === null) {
      return {
        error:
          "稼働時間を正しく入力してください。",
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
  }

  if (
    body?.distanceKm !== undefined &&
    body?.distanceKm !== null &&
    body?.distanceKm !== ""
  ) {
    if (distanceKm === null) {
      return {
        error:
          "距離を正しく入力してください。",
      };
    }

    if (distanceKm < 0) {
      return {
        error:
          "距離は0km以上で入力してください。",
      };
    }

    if (distanceKm > 999999.99) {
      return {
        error:
          "距離が大きすぎます。",
      };
    }
  }

  if (
    body?.workStartedAt !== undefined &&
    body?.workStartedAt !== null &&
    body?.workStartedAt !== ""
  ) {
    if (!workStartedAt) {
      return {
        error:
          "開始時間を正しく入力してください。",
      };
    }
  }

  return {
    saleAmount,
    deliveryCount,
    workHours,
    workStartedAt,
    distanceKm,
  };
}

function validateExpense(body) {
  const raw =
    body?.expenseAmount;

  if (
    raw === undefined ||
    raw === null ||
    raw === ""
  ) {
    return {
      amount: 0,
    };
  }

  const amount =
    parseInteger(raw);

  if (
    amount === null ||
    amount < 0
  ) {
    return {
      error:
        "経費は0円以上の整数で入力してください。",
    };
  }

  return {
    amount,
  };
}

// =========================================================
// JST
// =========================================================

function getJstTodayParts() {
  const now = new Date();

  const parts = new Intl.DateTimeFormat(
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
  return (
    `${year}-${pad2(month)}-${pad2(day)}`
  );
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

function normalizeDateValue(value) {
  if (!value) {
    return null;
  }

  if (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(value)
  ) {
    return value;
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return String(value);
  }

  const parts = new Intl.DateTimeFormat(
    "en-CA",
    {
      timeZone: "Asia/Tokyo",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }
  ).formatToParts(date);

  const year = parts.find(
    item => item.type === "year"
  )?.value;

  const month = parts.find(
    item => item.type === "month"
  )?.value;

  const day = parts.find(
    item => item.type === "day"
  )?.value;

  if (!year || !month || !day) {
    return String(value);
  }

  return `${year}-${month}-${day}`;
}

// =========================================================
// 期間
// =========================================================

function getPeriodRange(
  period,
  requestedMonth,
  requestedYear
) {
  const today = getJstTodayParts();

  let year = today.year;
  let month = today.month;

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

    if (month < 1 || month > 12) {
      return {
        error:
          "月の指定が正しくありません。",
      };
    }
  }

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

    if (year < 2000 || year > 2100) {
      return {
        error:
          "年の指定が正しくありません。",
      };
    }
  }

  if (period === "today") {
    const start = jstDateToUtc(
      today.year,
      today.month,
      today.day
    );

    const end = new Date(start);

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

  if (period === "week") {
    const current = jstDateToUtc(
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

    const start = new Date(current);

    start.setUTCDate(
      start.getUTCDate() +
        mondayOffset
    );

    const end = new Date(start);

    end.setUTCDate(
      end.getUTCDate() + 7
    );

    return {
      start: start.toISOString(),
      end: end.toISOString(),
      label: "今週",
    };
  }

  if (period === "month") {
    const start = jstDateToUtc(
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

  if (period === "year") {
    const start = jstDateToUtc(
      year,
      1,
      1
    );

    const end = jstDateToUtc(
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
// 月次レポート
// =========================================================

function getMonthlyReportRange(
  period,
  requestedMonth
) {
  if (period === "month") {
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

// =========================================================
// 基本集計
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

  const row = rows[0] || {};

  const records =
    Number(row.records || 0);

  const sales =
    Number(row.sales || 0);

  const deliveryCount =
    Number(
      row.delivery_count || 0
    );

  const workHours =
    Number(row.work_hours || 0);

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

    deliveriesPerHour:
      workHours > 0
        ? deliveryCount / workHours
        : 0,
  };
}

// =========================================================
// 経費合計
// =========================================================

async function getExpenseTotal(
  userId,
  start,
  end
) {
  const rows = await sql`
    SELECT
      COALESCE(
        SUM(de.amount),
        0
      ) AS expense

    FROM delivery_expenses de

    INNER JOIN delivery_results dr
      ON dr.id =
        de.delivery_result_id

    WHERE de.telegram_user_id =
      ${userId}

      AND dr.telegram_user_id =
        ${userId}

      AND dr.created_at >=
        ${start}

      AND dr.created_at <
        ${end}
  `;

  return Number(
    rows[0]?.expense || 0
  );
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
      dr.id,
      dr.sale_amount,
      dr.delivery_count,
      dr.work_hours,
      dr.work_started_at,
      dr.distance_km,
      dr.created_at,

      COALESCE(
        (
          SELECT SUM(de.amount)
          FROM delivery_expenses de
          WHERE de.delivery_result_id =
            dr.id
            AND de.telegram_user_id =
              ${userId}
        ),
        0
      ) AS expense

    FROM delivery_results dr

    WHERE dr.telegram_user_id =
      ${userId}

      AND dr.created_at >=
        ${start}

      AND dr.created_at <
        ${end}

    ORDER BY
      dr.created_at DESC,
      dr.id DESC

    LIMIT 50
  `;

  return rows.map(row => {
    const sales =
      Number(row.sale_amount || 0);

    const deliveryCount =
      Number(
        row.delivery_count || 0
      );

    const workHours =
      Number(row.work_hours || 0);

    const expense =
      Number(row.expense || 0);

    const distanceKm =
      row.distance_km === null
        ? null
        : Number(row.distance_km);

    return {
      id: Number(row.id),

      saleAmount: sales,

      deliveryCount,

      workHours:
        row.work_hours === null
          ? null
          : workHours,

      workStartedAt:
        row.work_started_at,

      distanceKm,

      expense,

      profit:
        sales - expense,

      unitPrice:
        deliveryCount > 0
          ? sales / deliveryCount
          : 0,

      hourlySales:
        workHours > 0
          ? sales / workHours
          : 0,

      deliveriesPerHour:
        workHours > 0
          ? deliveryCount / workHours
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
        dr.created_at AT TIME ZONE
        'Asia/Tokyo'
      )::date AS result_date,

      COALESCE(
        SUM(dr.sale_amount),
        0
      ) AS sales,

      COALESCE(
        SUM(dr.delivery_count),
        0
      ) AS delivery_count,

      COALESCE(
        SUM(dr.work_hours),
        0
      ) AS work_hours,

      COALESCE(
        SUM(
          COALESCE(exp.expense, 0)
        ),
        0
      ) AS expense,

      COUNT(*) AS records

    FROM delivery_results dr

    LEFT JOIN (
      SELECT
        delivery_result_id,
        SUM(amount) AS expense

      FROM delivery_expenses

      WHERE telegram_user_id =
        ${userId}

      GROUP BY
        delivery_result_id
    ) exp
      ON exp.delivery_result_id =
        dr.id

    WHERE dr.telegram_user_id =
      ${userId}

      AND dr.created_at >=
        ${start}

      AND dr.created_at <
        ${end}

    GROUP BY result_date

    ORDER BY result_date ASC
  `;

  return rows.map(row => {
    const sales =
      Number(row.sales || 0);

    const deliveryCount =
      Number(
        row.delivery_count || 0
      );

    const workHours =
      Number(row.work_hours || 0);

    const expense =
      Number(row.expense || 0);

    return {
      date:
        normalizeDateValue(
          row.result_date
        ),

      sales,

      deliveryCount,

      workHours,

      expense,

      profit:
        sales - expense,

      records:
        Number(row.records || 0),

      unitPrice:
        deliveryCount > 0
          ? sales / deliveryCount
          : 0,

      hourlySales:
        workHours > 0
          ? sales / workHours
          : 0,

      deliveriesPerHour:
        workHours > 0
          ? deliveryCount / workHours
          : 0,
    };
  });
}

// =========================================================
// 月次・期間レポート
// =========================================================

function buildMonthlyReport(
  stats,
  daily
) {
  const workingDays =
    daily.filter(
      day =>
        Number(day.records) > 0
    ).length;

  let bestSalesDay = null;
  let bestDeliveryDay = null;
  let bestHourlyDay = null;

  for (const day of daily) {
    if (
      !bestSalesDay ||
      Number(day.sales) >
        Number(bestSalesDay.sales)
    ) {
      bestSalesDay = day;
    }

    if (
      !bestDeliveryDay ||
      Number(day.deliveryCount) >
        Number(
          bestDeliveryDay.deliveryCount
        )
    ) {
      bestDeliveryDay = day;
    }

    if (
      !bestHourlyDay ||
      Number(day.hourlySales) >
        Number(
          bestHourlyDay.hourlySales
        )
    ) {
      bestHourlyDay = day;
    }
  }

  return {
    sales: stats.sales,

    deliveryCount:
      stats.deliveryCount,

    workHours:
      stats.workHours,

    records:
      stats.records,

    workingDays,

    averageDailySales:
      workingDays > 0
        ? stats.sales / workingDays
        : 0,

    averageDailyDeliveryCount:
      workingDays > 0
        ? stats.deliveryCount /
          workingDays
        : 0,

    averageDailyWorkHours:
      workingDays > 0
        ? stats.workHours /
          workingDays
        : 0,

    unitPrice:
      stats.unitPrice,

    hourlySales:
      stats.hourlySales,

    deliveriesPerHour:
      stats.deliveriesPerHour,

    bestSalesDay,

    bestDeliveryDay,

    bestHourlyDay,
  };
}

// =========================================================
// 実績登録 POST
// =========================================================

async function createResult(
  userId,
  body
) {
  const validation =
    validateResultInput(body);

  if (validation.error) {
    return {
      ok: false,
      status: 400,
      error: validation.error,
    };
  }

  const expenseValidation =
    validateExpense(body);

  if (expenseValidation.error) {
    return {
      ok: false,
      status: 400,
      error:
        expenseValidation.error,
    };
  }

  const {
    saleAmount,
    deliveryCount,
    workHours,
    workStartedAt,
    distanceKm,
  } = validation;

  const expenseAmount =
    expenseValidation.amount;

  const rows = await sql`
    INSERT INTO delivery_results (
      telegram_user_id,
      sale_amount,
      delivery_count,
      work_hours,
      work_started_at,
      distance_km
    )
    VALUES (
      ${userId},
      ${saleAmount},
      ${deliveryCount},
      ${workHours},
      ${workStartedAt},
      ${distanceKm}
    )
    RETURNING
      id,
      sale_amount,
      delivery_count,
      work_hours,
      work_started_at,
      distance_km,
      created_at
  `;

  const row = rows[0];

  if (!row) {
    return {
      ok: false,
      status: 500,
      error:
        "実績の登録に失敗しました。",
    };
  }

  const resultId =
    Number(row.id);

  // 経費が入力された場合のみ登録
  if (expenseAmount > 0) {
    await sql`
      INSERT INTO delivery_expenses (
        telegram_user_id,
        delivery_result_id,
        expense_type,
        amount
      )
      VALUES (
        ${userId},
        ${resultId},
        ${"経費"},
        ${expenseAmount}
      )
    `;
  }

  try {
    await sql`
      INSERT INTO audit_logs (
        telegram_user_id,
        action,
        details
      )
      VALUES (
        ${userId},
        ${"result_create"},
        ${JSON.stringify({
          resultId,
          saleAmount,
          deliveryCount,
          workHours,
          workStartedAt,
          distanceKm,
          expenseAmount,
        })}
      )
    `;
  } catch (error) {
    console.error(
      "[RESULT] audit log error:",
      error?.message
    );
  }

  return {
    ok: true,
    status: 201,

    result: {
      id: resultId,

      saleAmount,

      deliveryCount,

      workHours,

      workStartedAt,

      distanceKm,

      expense: expenseAmount,

      profit:
        saleAmount -
        expenseAmount,

      createdAt:
        row.created_at,
    },
  };
}

// =========================================================
// 実績編集
// =========================================================

async function updateResult(
  userId,
  resultId,
  body
) {
  const id =
    parseInteger(resultId);

  if (
    id === null ||
    id <= 0
  ) {
    return {
      ok: false,
      status: 400,
      error:
        "実績IDが正しくありません。",
    };
  }

  const validation =
    validateResultInput(body);

  if (validation.error) {
    return {
      ok: false,
      status: 400,
      error: validation.error,
    };
  }

  const expenseValidation =
    validateExpense(body);

  if (expenseValidation.error) {
    return {
      ok: false,
      status: 400,
      error:
        expenseValidation.error,
    };
  }

  const {
    saleAmount,
    deliveryCount,
    workHours,
    workStartedAt,
    distanceKm,
  } = validation;

  const expenseAmount =
    expenseValidation.amount;

  const rows = await sql`
    UPDATE delivery_results

    SET
      sale_amount =
        ${saleAmount},

      delivery_count =
        ${deliveryCount},

      work_hours =
        ${workHours},

      work_started_at =
        ${workStartedAt},

      distance_km =
        ${distanceKm}

    WHERE id =
      ${id}

      AND telegram_user_id =
        ${userId}

    RETURNING
      id,
      sale_amount,
      delivery_count,
      work_hours,
      work_started_at,
      distance_km,
      created_at
  `;

  if (rows.length === 0) {
    return {
      ok: false,
      status: 404,
      error:
        "実績が見つかりません。",
    };
  }

  // この実績に紐づく既存経費を更新
  await sql`
    DELETE FROM delivery_expenses

    WHERE delivery_result_id =
      ${id}

      AND telegram_user_id =
        ${userId}
  `;

  if (expenseAmount > 0) {
    await sql`
      INSERT INTO delivery_expenses (
        telegram_user_id,
        delivery_result_id,
        expense_type,
        amount
      )
      VALUES (
        ${userId},
        ${id},
        ${"経費"},
        ${expenseAmount}
      )
    `;
  }

  const row = rows[0];

  try {
    await sql`
      INSERT INTO audit_logs (
        telegram_user_id,
        action,
        details
      )
      VALUES (
        ${userId},
        ${"result_update"},
        ${JSON.stringify({
          resultId: id,
          saleAmount,
          deliveryCount,
          workHours,
          workStartedAt,
          distanceKm,
          expenseAmount,
        })}
      )
    `;
  } catch (error) {
    console.error(
      "[RESULT] audit log error:",
      error?.message
    );
  }

  return {
    ok: true,
    status: 200,

    result: {
      id: Number(row.id),

      saleAmount:
        Number(row.sale_amount),

      deliveryCount:
        Number(
          row.delivery_count
        ),

      workHours:
        row.work_hours === null
          ? null
          : Number(row.work_hours),

      workStartedAt:
        row.work_started_at,

      distanceKm:
        row.distance_km === null
          ? null
          : Number(row.distance_km),

      expense:
        expenseAmount,

      profit:
        Number(row.sale_amount) -
        expenseAmount,

      createdAt:
        row.created_at,
    },
  };
}

// =========================================================
// 実績削除
// =========================================================

async function deleteResult(
  userId,
  resultId
) {
  const id =
    parseInteger(resultId);

  if (
    id === null ||
    id <= 0
  ) {
    return {
      ok: false,
      status: 400,
      error:
        "実績IDが正しくありません。",
    };
  }

  const rows = await sql`
    DELETE FROM delivery_results

    WHERE id =
      ${id}

      AND telegram_user_id =
        ${userId}

    RETURNING
      id,
      sale_amount,
      delivery_count,
      work_hours,
      work_started_at,
      distance_km,
      created_at
  `;

  if (rows.length === 0) {
    return {
      ok: false,
      status: 404,
      error:
        "実績が見つかりません。",
    };
  }

  const row = rows[0];

  try {
    await sql`
      INSERT INTO audit_logs (
        telegram_user_id,
        action,
        details
      )
      VALUES (
        ${userId},
        ${"result_delete"},
        ${JSON.stringify({
          resultId: id,
          saleAmount:
            Number(
              row.sale_amount
            ),
          deliveryCount:
            Number(
              row.delivery_count
            ),
          workHours:
            row.work_hours === null
              ? null
              : Number(
                  row.work_hours
                ),
          workStartedAt:
            row.work_started_at,
          distanceKm:
            row.distance_km === null
              ? null
              : Number(
                  row.distance_km
                ),
          createdAt:
            row.created_at,
        })}
      )
    `;
  } catch (error) {
    console.error(
      "[RESULT] audit log error:",
      error?.message
    );
  }

  return {
    ok: true,
    status: 200,

    deleted: {
      id: Number(row.id),

      saleAmount:
        Number(row.sale_amount),

      deliveryCount:
        Number(
          row.delivery_count
        ),

      workHours:
        row.work_hours === null
          ? null
          : Number(row.work_hours),

      workStartedAt:
        row.work_started_at,

      distanceKm:
        row.distance_km === null
          ? null
          : Number(row.distance_km),

      createdAt:
        row.created_at,
    },
  };
}

// =========================================================
// GET
// =========================================================

async function handleGet(
  req,
  userId
) {
  const query =
    req.query || {};

  const period = String(
    query.period || "today"
  ).toLowerCase();

  if (
    ![
      "today",
      "week",
      "month",
      "year",
    ].includes(period)
  ) {
    return {
      status: 400,

      body: {
        ok: false,
        error:
          "periodが正しくありません。",
      },
    };
  }

  const requestedMonth =
    query.month
      ? String(query.month)
      : null;

  const requestedYear =
    query.year
      ? String(query.year)
      : null;

  const range =
    getPeriodRange(
      period,
      requestedMonth,
      requestedYear
    );

  if (range?.error) {
    return {
      status: 400,

      body: {
        ok: false,
        error: range.error,
      },
    };
  }

  if (!range) {
    return {
      status: 400,

      body: {
        ok: false,
        error:
          "期間指定が正しくありません。",
      },
    };
  }

  const [
    stats,
    recentResults,
    daily,
    expense,
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
    ),

    getExpenseTotal(
      userId,
      range.start,
      range.end
    ),
  ]);

  const reportRange =
    getMonthlyReportRange(
      period,
      requestedMonth
    );

  let reportStats;
  let reportDaily;

  if (
    reportRange.start ===
      range.start &&
    reportRange.end ===
      range.end
  ) {
    reportStats = stats;
    reportDaily = daily;
  } else {
    [
      reportStats,
      reportDaily,
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
      ),
    ]);
  }

  const monthlyReport =
    buildMonthlyReport(
      reportStats,
      reportDaily
    );

  return {
    status: 200,

    body: {
      ok: true,

      period,

      requestedMonth,

      requestedYear,

      label:
        range.label,

      range: {
        start:
          range.start,

        end:
          range.end,
      },

      stats: {
        ...stats,

        expense,

        profit:
          stats.sales -
          expense,
      },

      monthlyReport,

      recentResults,

      daily,
    },
  };
}

// =========================================================
// PUT / PATCH
// =========================================================

async function handlePut(
  req,
  userId
) {
  const body =
    req.body || {};

  const resultId =
    body.id ??
    req.query?.id;

  return await updateResult(
    userId,
    resultId,
    body
  );
}

// =========================================================
// DELETE
// =========================================================

async function handleDelete(
  req,
  userId
) {
  const resultId =
    req.query?.id ??
    req.body?.id;

  return await deleteResult(
    userId,
    resultId
  );
}

// =========================================================
// Vercel API
// =========================================================

module.exports =
  async function handler(
    req,
    res
  ) {
    try {
      console.log(
        "[RESULT] request:",
        {
          method: req.method,
          url: req.url,
        }
      );

      const userId =
        getTelegramUserId(req);

      if (!userId) {
        return res
          .status(401)
          .json({
            ok: false,
            error:
              "Telegram認証が確認できません。",
          });
      }

      // POST
      if (
        req.method === "POST"
      ) {
        const result =
          await createResult(
            userId,
            req.body || {}
          );

        return res
          .status(result.status)
          .json(result);
      }

      // GET
      if (
        req.method === "GET"
      ) {
        const result =
          await handleGet(
            req,
            userId
          );

        return res
          .status(result.status)
          .json(result.body);
      }

      // PUT
      if (
        req.method === "PUT"
      ) {
        const result =
          await handlePut(
            req,
            userId
          );

        return res
          .status(result.status)
          .json(result);
      }

      // PATCH
      if (
        req.method === "PATCH"
      ) {
        const result =
          await handlePut(
            req,
            userId
          );

        return res
          .status(result.status)
          .json(result);
      }

      // DELETE
      if (
        req.method === "DELETE"
      ) {
        const result =
          await handleDelete(
            req,
            userId
          );

        return res
          .status(result.status)
          .json(result);
      }

      return res
        .status(405)
        .json({
          ok: false,
          error:
            "Method Not Allowed",
        });

    } catch (error) {
      console.error(
        "[RESULT] API error:",
        error
      );

      return res
        .status(500)
        .json({
          ok: false,
          error:
            "サーバーエラーが発生しました。",
        });
    }
  };

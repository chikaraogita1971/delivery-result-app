import crypto from "crypto";
import { neon } from "@neondatabase/serverless";

const sql = neon(process.env.DATABASE_URL);

const TELEGRAM_BOT_TOKEN = process.env.BOT_TOKEN;

function json(res, status, data) {
  res.status(status).json(data);
}

function getTelegramUserFromInitData(initData) {
  if (!initData || !TELEGRAM_BOT_TOKEN) {
    return null;
  }

  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  const authDate = params.get("auth_date");

  if (!hash || !authDate) {
    return null;
  }

  const authTimestamp = Number(authDate);

  if (!Number.isFinite(authTimestamp)) {
    return null;
  }

  const now = Math.floor(Date.now() / 1000);

  // 24時間以上古い認証情報は拒否
  if (now - authTimestamp > 60 * 60 * 24) {
    return null;
  }

  // 未来時刻の不正な認証情報も拒否
  if (authTimestamp > now + 60) {
    return null;
  }

  const dataCheckString = [...params.entries()]
    .filter(([key]) => key !== "hash")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

  const secretKey = crypto
    .createHmac("sha256", "WebAppData")
    .update(TELEGRAM_BOT_TOKEN)
    .digest();

  const calculatedHash = crypto
    .createHmac("sha256", secretKey)
    .update(dataCheckString)
    .digest("hex");

  if (
    !crypto.timingSafeEqual(
      Buffer.from(calculatedHash),
      Buffer.from(hash)
    )
  ) {
    return null;
  }

  const userRaw = params.get("user");

  if (!userRaw) {
    return null;
  }

  try {
    const user = JSON.parse(userRaw);

    if (!user?.id) {
      return null;
    }

    return user;
  } catch {
    return null;
  }
}

function parseInteger(value, fieldName) {
  if (
    value === undefined ||
    value === null ||
    value === "" ||
    !Number.isInteger(Number(value))
  ) {
    throw new Error(`${fieldName}は整数で入力してください`);
  }

  return Number(value);
}

function parseWorkHours(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  const number = Number(value);

  if (!Number.isFinite(number)) {
    throw new Error("稼働時間が不正です");
  }

  if (number < 0 || number > 999.99) {
    throw new Error("稼働時間は0〜999.99時間で入力してください");
  }

  return Math.round(number * 100) / 100;
}

function parseOptionalDecimal(value, fieldName, max) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  const number = Number(value);

  if (!Number.isFinite(number)) {
    throw new Error(`${fieldName}が不正です`);
  }

  if (number < 0 || number > max) {
    throw new Error(`${fieldName}の値が範囲外です`);
  }

  return Math.round(number * 100) / 100;
}

function getJstTodayParts() {
  const now = new Date();

  const formatter = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });

  const parts = formatter.formatToParts(now);

  const year = parts.find((p) => p.type === "year")?.value;
  const month = parts.find((p) => p.type === "month")?.value;
  const day = parts.find((p) => p.type === "day")?.value;

  return {
    year,
    month,
    day,
  };
}

function parseStartedAt(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  const stringValue = String(value).trim();

  // Mini Appの <input type="time"> などから
  // "16:30" のような時刻だけが送られた場合
  if (/^\d{1,2}:\d{2}$/.test(stringValue)) {
    const [hour, minute] = stringValue.split(":").map(Number);

    if (
      !Number.isInteger(hour) ||
      !Number.isInteger(minute) ||
      hour < 0 ||
      hour > 23 ||
      minute < 0 ||
      minute > 59
    ) {
      throw new Error("開始時間が不正です");
    }

    const { year, month, day } = getJstTodayParts();

    const jstDateTime =
      `${year}-${month}-${day}T` +
      `${String(hour).padStart(2, "0")}:` +
      `${String(minute).padStart(2, "0")}:00+09:00`;

    const date = new Date(jstDateTime);

    if (Number.isNaN(date.getTime())) {
      throw new Error("開始時間が不正です");
    }

    return date.toISOString();
  }

  // ISO日時など、完全な日時が送られた場合
  const date = new Date(stringValue);

  if (Number.isNaN(date.getTime())) {
    throw new Error("開始時間が不正です");
  }

  return date.toISOString();
}

function validateResultInput(body) {
  const saleAmount = parseInteger(body.saleAmount, "売上");
  const deliveryCount = parseInteger(body.deliveryCount, "配達数");

  if (saleAmount < 0 || saleAmount > 100000000) {
    throw new Error("売上は0〜100,000,000円で入力してください");
  }

  if (deliveryCount <= 0 || deliveryCount > 100000) {
    throw new Error("配達数は1〜100,000件で入力してください");
  }

  const workHours = parseWorkHours(body.workHours);

  const distanceKm = parseOptionalDecimal(
    body.distanceKm,
    "距離",
    999999.99
  );

  const workStartedAt = parseStartedAt(body.workStartedAt);

  return {
    saleAmount,
    deliveryCount,
    workHours,
    distanceKm,
    workStartedAt,
  };
}

function getJstDate(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function getPeriodRange(period) {
  const now = new Date();

  if (period === "today") {
    const date = getJstDate(now);

    return {
      start: `${date}T00:00:00+09:00`,
      end: `${date}T23:59:59.999+09:00`,
    };
  }

  if (period === "week") {
    const jstDate = new Date(
      new Intl.DateTimeFormat("en-US", {
        timeZone: "Asia/Tokyo",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(now)
    );

    const weekday = jstDate.getDay();

    const start = new Date(jstDate);
    start.setDate(start.getDate() - weekday);

    const end = new Date(start);
    end.setDate(end.getDate() + 7);

    return {
      start: `${getJstDate(start)}T00:00:00+09:00`,
      end: `${getJstDate(end)}T00:00:00+09:00`,
    };
  }

  if (period === "month") {
    const parts = getJstTodayParts();

    const start = `${parts.year}-${parts.month}-01T00:00:00+09:00`;

    const year = Number(parts.year);
    const month = Number(parts.month);

    const nextMonth =
      month === 12
        ? `${year + 1}-01`
        : `${year}-${String(month + 1).padStart(2, "0")}`;

    return {
      start,
      end: `${nextMonth}-01T00:00:00+09:00`,
    };
  }

  if (period === "year") {
    const parts = getJstTodayParts();

    return {
      start: `${parts.year}-01-01T00:00:00+09:00`,
      end: `${Number(parts.year) + 1}-01-01T00:00:00+09:00`,
    };
  }

  throw new Error("periodが不正です");
}

async function getStats(userId, start, end) {
  const rows = await sql`
    SELECT
      COALESCE(SUM(sale_amount), 0)::int AS sale_amount,
      COALESCE(SUM(delivery_count), 0)::int AS delivery_count,
      COALESCE(SUM(work_hours), 0)::numeric AS work_hours,
      COUNT(*)::int AS result_count
    FROM delivery_results
    WHERE telegram_user_id = ${userId}
      AND created_at >= ${start}
      AND created_at < ${end}
  `;

  const row = rows[0];

  const saleAmount = Number(row.sale_amount || 0);
  const deliveryCount = Number(row.delivery_count || 0);
  const workHours = Number(row.work_hours || 0);

  return {
    saleAmount,
    deliveryCount,
    workHours,
    resultCount: Number(row.result_count || 0),
    averageUnitPrice:
      deliveryCount > 0
        ? Math.round(saleAmount / deliveryCount)
        : 0,
    hourlyRate:
      workHours > 0
        ? Math.round(saleAmount / workHours)
        : null,
  };
}

async function getExpenseTotal(userId, start, end) {
  const rows = await sql`
    SELECT COALESCE(SUM(e.amount), 0)::int AS total
    FROM delivery_expenses e
    INNER JOIN delivery_results r
      ON r.id = e.delivery_result_id
    WHERE e.telegram_user_id = ${userId}
      AND r.created_at >= ${start}
      AND r.created_at < ${end}
  `;

  return Number(rows[0]?.total || 0);
}

async function getRecentResults(userId, limit = 30) {
  const rows = await sql`
    SELECT
      r.id,
      r.sale_amount,
      r.delivery_count,
      r.work_hours,
      r.work_started_at,
      r.distance_km,
      r.created_at,
      COALESCE(
        (
          SELECT SUM(e.amount)
          FROM delivery_expenses e
          WHERE e.delivery_result_id = r.id
            AND e.telegram_user_id = ${userId}
        ),
        0
      )::int AS expense
    FROM delivery_results r
    WHERE r.telegram_user_id = ${userId}
    ORDER BY r.created_at DESC
    LIMIT ${limit}
  `;

  return rows.map((row) => ({
    id: Number(row.id),
    saleAmount: Number(row.sale_amount),
    deliveryCount: Number(row.delivery_count),
    workHours:
      row.work_hours === null
        ? null
        : Number(row.work_hours),
    workStartedAt: row.work_started_at,
    distanceKm:
      row.distance_km === null
        ? null
        : Number(row.distance_km),
    expense: Number(row.expense || 0),
    createdAt: row.created_at,
  }));
}

async function getDailyResults(userId, start, end) {
  const rows = await sql`
    SELECT
      TO_CHAR(
        created_at AT TIME ZONE 'Asia/Tokyo',
        'YYYY-MM-DD'
      ) AS date,
      COALESCE(SUM(sale_amount), 0)::int AS sale_amount,
      COALESCE(SUM(delivery_count), 0)::int AS delivery_count,
      COALESCE(SUM(work_hours), 0)::numeric AS work_hours
    FROM delivery_results
    WHERE telegram_user_id = ${userId}
      AND created_at >= ${start}
      AND created_at < ${end}
    GROUP BY 1
    ORDER BY 1
  `;

  return rows.map((row) => ({
    date: row.date,
    saleAmount: Number(row.sale_amount || 0),
    deliveryCount: Number(row.delivery_count || 0),
    workHours: Number(row.work_hours || 0),
  }));
}

async function getMonthlyReport(userId) {
  const { start, end } = getPeriodRange("month");

  const rows = await sql`
    SELECT
      TO_CHAR(
        created_at AT TIME ZONE 'Asia/Tokyo',
        'YYYY-MM-DD'
      ) AS date,
      COALESCE(SUM(sale_amount), 0)::int AS sale_amount,
      COALESCE(SUM(delivery_count), 0)::int AS delivery_count,
      COALESCE(SUM(work_hours), 0)::numeric AS work_hours
    FROM delivery_results
    WHERE telegram_user_id = ${userId}
      AND created_at >= ${start}
      AND created_at < ${end}
    GROUP BY 1
    ORDER BY 1
  `;

  return rows.map((row) => ({
    date: row.date,
    saleAmount: Number(row.sale_amount || 0),
    deliveryCount: Number(row.delivery_count || 0),
    workHours: Number(row.work_hours || 0),
  }));
}

async function createResult(userId, body) {
  const {
    saleAmount,
    deliveryCount,
    workHours,
    distanceKm,
    workStartedAt,
  } = validateResultInput(body);

  const expenseValue = body.expense;

  let expense = null;

  if (
    expenseValue !== undefined &&
    expenseValue !== null &&
    expenseValue !== ""
  ) {
    expense = parseInteger(expenseValue, "経費");

    if (expense < 0 || expense > 100000000) {
      throw new Error("経費は0〜100,000,000円で入力してください");
    }
  }

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

  const result = rows[0];

  if (expense !== null && expense > 0) {
    await sql`
      INSERT INTO delivery_expenses (
        telegram_user_id,
        delivery_result_id,
        expense_type,
        amount
      )
      VALUES (
        ${userId},
        ${result.id},
        '経費',
        ${expense}
      )
    `;
  }

  return {
    id: Number(result.id),
    saleAmount: Number(result.sale_amount),
    deliveryCount: Number(result.delivery_count),
    workHours:
      result.work_hours === null
        ? null
        : Number(result.work_hours),
    workStartedAt: result.work_started_at,
    distanceKm:
      result.distance_km === null
        ? null
        : Number(result.distance_km),
    expense: expense || 0,
    createdAt: result.created_at,
  };
}

async function updateResult(userId, id, body) {
  const resultId = parseInteger(id, "ID");

  const {
    saleAmount,
    deliveryCount,
    workHours,
    distanceKm,
    workStartedAt,
  } = validateResultInput(body);

  let expense = null;

  if (
    body.expense !== undefined &&
    body.expense !== null &&
    body.expense !== ""
  ) {
    expense = parseInteger(body.expense, "経費");

    if (expense < 0 || expense > 100000000) {
      throw new Error("経費は0〜100,000,000円で入力してください");
    }
  }

  const rows = await sql`
    UPDATE delivery_results
    SET
      sale_amount = ${saleAmount},
      delivery_count = ${deliveryCount},
      work_hours = ${workHours},
      work_started_at = ${workStartedAt},
      distance_km = ${distanceKm}
    WHERE id = ${resultId}
      AND telegram_user_id = ${userId}
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
    return null;
  }

  await sql`
    DELETE FROM delivery_expenses
    WHERE delivery_result_id = ${resultId}
      AND telegram_user_id = ${userId}
  `;

  if (expense !== null && expense > 0) {
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
        '経費',
        ${expense}
      )
    `;
  }

  const result = rows[0];

  return {
    id: Number(result.id),
    saleAmount: Number(result.sale_amount),
    deliveryCount: Number(result.delivery_count),
    workHours:
      result.work_hours === null
        ? null
        : Number(result.work_hours),
    workStartedAt: result.work_started_at,
    distanceKm:
      result.distance_km === null
        ? null
        : Number(result.distance_km),
    expense: expense || 0,
    createdAt: result.created_at,
  };
}

async function deleteResult(userId, id) {
  const resultId = parseInteger(id, "ID");

  const rows = await sql`
    DELETE FROM delivery_results
    WHERE id = ${resultId}
      AND telegram_user_id = ${userId}
    RETURNING id
  `;

  return rows.length > 0;
}

export default async function handler(req, res) {
  try {
    const initData =
      req.headers["x-telegram-init-data"] ||
      req.headers["x-telegram-web-app-data"] ||
      req.body?.initData;

    const telegramUser = getTelegramUserFromInitData(initData);

    if (!telegramUser) {
      return json(res, 401, {
        ok: false,
        error: "Telegram認証に失敗しました",
      });
    }

    const userId = String(telegramUser.id);

    if (req.method === "GET") {
      const period = req.query?.period || "today";

      const { start, end } = getPeriodRange(period);

      const [stats, expense, recentResults, dailyResults, monthlyReport] =
        await Promise.all([
          getStats(userId, start, end),
          getExpenseTotal(userId, start, end),
          getRecentResults(userId),
          getDailyResults(userId, start, end),
          getMonthlyReport(userId),
        ]);

      return json(res, 200, {
        ok: true,
        user: {
          id: userId,
          firstName: telegramUser.first_name || "",
          lastName: telegramUser.last_name || "",
          username: telegramUser.username || "",
        },
        period,
        stats: {
          ...stats,
          expense,
          profit: stats.saleAmount - expense,
        },
        recentResults,
        dailyResults,
        monthlyReport,
      });
    }

    if (req.method === "POST") {
      const result = await createResult(
        userId,
        req.body || {}
      );

      return json(res, 201, {
        ok: true,
        result,
      });
    }

    if (req.method === "PUT" || req.method === "PATCH") {
      const id =
        req.query?.id ??
        req.body?.id;

      if (!id) {
        return json(res, 400, {
          ok: false,
          error: "IDが必要です",
        });
      }

      const result = await updateResult(
        userId,
        id,
        req.body || {}
      );

      if (!result) {
        return json(res, 404, {
          ok: false,
          error: "実績が見つかりません",
        });
      }

      return json(res, 200, {
        ok: true,
        result,
      });
    }

    if (req.method === "DELETE") {
      const id = req.query?.id;

      if (!id) {
        return json(res, 400, {
          ok: false,
          error: "IDが必要です",
        });
      }

      const deleted = await deleteResult(userId, id);

      if (!deleted) {
        return json(res, 404, {
          ok: false,
          error: "実績が見つかりません",
        });
      }

      return json(res, 200, {
        ok: true,
      });
    }

    res.setHeader("Allow", "GET, POST, PUT, PATCH, DELETE");

    return json(res, 405, {
      ok: false,
      error: "Method Not Allowed",
    });
  } catch (error) {
    console.error("result API error:", error);

    return json(res, 500, {
      ok: false,
      error:
        error?.message ||
        "サーバーエラーが発生しました",
    });
  }
}

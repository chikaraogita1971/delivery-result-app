import { neon } from "@neondatabase/serverless";
import crypto from "crypto";

const sql = neon(process.env.POSTGRES_URL);

/**
 * Telegram Mini App の initData を検証して、
 * Telegramが保証したユーザーIDを取得する
 */
function validateTelegramInitData(initData) {
  if (!initData) {
    throw new Error("Missing Telegram initData");
  }

  const params = new URLSearchParams(initData);
  const receivedHash = params.get("hash");

  if (!receivedHash) {
    throw new Error("Missing Telegram hash");
  }

  params.delete("hash");

  // Telegram指定の data-check-string を作成
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

  // bot.jsで使っているBot Tokenの環境変数名に合わせる
  const botToken = process.env.BOT_TOKEN;

  if (!botToken) {
    throw new Error("BOT_TOKEN is not configured");
  }

  // Telegram公式の検証方式
  const secretKey = crypto
    .createHmac("sha256", "WebAppData")
    .update(botToken)
    .digest();

  const calculatedHash = crypto
    .createHmac("sha256", secretKey)
    .update(dataCheckString)
    .digest("hex");

  const receivedBuffer = Buffer.from(receivedHash, "hex");
  const calculatedBuffer = Buffer.from(calculatedHash, "hex");

  if (
    receivedBuffer.length !== calculatedBuffer.length ||
    !crypto.timingSafeEqual(receivedBuffer, calculatedBuffer)
  ) {
    throw new Error("Invalid Telegram initData");
  }

  // 古いinitDataを拒否
  const authDate = Number(params.get("auth_date"));

  if (!authDate || !Number.isFinite(authDate)) {
    throw new Error("Invalid auth_date");
  }

  const maxAge = 60 * 60; // 1時間

  if (Math.floor(Date.now() / 1000) - authDate > maxAge) {
    throw new Error("Expired Telegram initData");
  }

  // Telegramが署名したuser情報を取得
  const userJson = params.get("user");

  if (!userJson) {
    throw new Error("Missing Telegram user");
  }

  let user;

  try {
    user = JSON.parse(userJson);
  } catch {
    throw new Error("Invalid Telegram user data");
  }

  if (!user?.id) {
    throw new Error("Missing Telegram user id");
  }

  return String(user.id);
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({
      error: "Method Not Allowed"
    });
  }

  try {
    /*
     * ここが今回の重要ポイント。
     *
     * user_id はURLから受け取らない。
     *
     * Telegramの署名付きinitDataを検証して、
     * サーバー側で本当のTelegramユーザーIDを取得する。
     */
    const initData = req.headers["x-telegram-init-data"];

    let userId;

    try {
      userId = validateTelegramInitData(initData);
    } catch (authError) {
      console.error("Telegram authentication error:", authError.message);

      return res.status(401).json({
        error: "Unauthorized"
      });
    }

    const period = req.query.period || "month";

    const allowedPeriods = [
      "day",
      "week",
      "month",
      "year"
    ];

    if (!allowedPeriods.includes(period)) {
      return res.status(400).json({
        error: "invalid period"
      });
    }

    let condition;

    if (period === "day") {
      condition = sql`
        created_at >= CURRENT_DATE
        AND created_at < CURRENT_DATE + INTERVAL '1 day'
      `;
    } else if (period === "week") {
      condition = sql`
        created_at >= date_trunc('week', CURRENT_DATE)
        AND created_at < date_trunc('week', CURRENT_DATE) + INTERVAL '1 week'
      `;
    } else if (period === "year") {
      condition = sql`
        created_at >= date_trunc('year', CURRENT_DATE)
        AND created_at < date_trunc('year', CURRENT_DATE) + INTERVAL '1 year'
      `;
    } else {
      condition = sql`
        created_at >= date_trunc('month', CURRENT_DATE)
        AND created_at < date_trunc('month', CURRENT_DATE) + INTERVAL '1 month'
      `;
    }

    const rows = await sql`
      SELECT
        COALESCE(SUM(sale_amount), 0) AS sales,
        COALESCE(SUM(delivery_count), 0) AS count,
        COALESCE(SUM(work_hours), 0) AS hours,
        COUNT(DISTINCT DATE(created_at)) AS work_days
      FROM delivery_results
      WHERE telegram_user_id = ${userId}
        AND ${condition}
    `;

    const dailyRows = await sql`
      SELECT
        DATE(created_at) AS work_date,
        SUM(sale_amount) AS daily_sales,
        SUM(delivery_count) AS daily_count
      FROM delivery_results
      WHERE telegram_user_id = ${userId}
        AND ${condition}
      GROUP BY DATE(created_at)
      ORDER BY DATE(created_at)
    `;

    const goalRows = await sql`
      SELECT monthly_goal
      FROM delivery_goals
      WHERE telegram_user_id = ${userId}
    `;

    const totalRows = await sql`
      SELECT
        COALESCE(SUM(delivery_count), 0) AS total_count
      FROM delivery_results
      WHERE telegram_user_id = ${userId}
    `;

    const recordRows = await sql`
      SELECT
        id,
        sale_amount,
        delivery_count,
        work_hours,
        created_at
      FROM delivery_results
      WHERE telegram_user_id = ${userId}
      ORDER BY created_at DESC, id DESC
      LIMIT 20
    `;

    const sales = Number(rows[0]?.sales ?? 0);
    const count = Number(rows[0]?.count ?? 0);
    const hours = Number(rows[0]?.hours ?? 0);
    const workDays = Number(rows[0]?.work_days ?? 0);

    const goal = Number(
      goalRows[0]?.monthly_goal ?? 0
    );

    const totalCount = Number(
      totalRows[0]?.total_count ?? 0
    );

    const maxSales = dailyRows.length
      ? Math.max(
          ...dailyRows.map(
            row => Number(row.daily_sales || 0)
          )
        )
      : 0;

    const maxCount = dailyRows.length
      ? Math.max(
          ...dailyRows.map(
            row => Number(row.daily_count || 0)
          )
        )
      : 0;

    const average = count > 0
      ? Math.round(sales / count)
      : 0;

    const rate = goal > 0
      ? Math.round((sales / goal) * 100)
      : 0;

    const records = recordRows.map(row => ({
      id: Number(row.id),
      sale: Number(row.sale_amount),
      count: Number(row.delivery_count),
      hours: Number(row.work_hours),
      createdAt: row.created_at
    }));

    return res.status(200).json({
      period,
      sales,
      count,
      hours,
      workDays,
      maxSales,
      maxCount,
      average,
      goal,
      rate,
      totalCount,
      records
    });

  } catch (error) {
    console.error("Result API error:", error);

    return res.status(500).json({
      error: "Internal Server Error"
    });
  }
}

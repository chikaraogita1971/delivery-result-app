const crypto = require("crypto");
const { neon } = require("@neondatabase/serverless");

const sql = neon(process.env.DATABASE_URL);

const BOT_TOKEN = process.env.BOT_TOKEN;
const MAX_AUTH_AGE = 60 * 60; // 1時間

function validateTelegramInitData(initData) {
  if (!initData) {
    throw new Error("Telegram initData がありません");
  }

  if (!BOT_TOKEN) {
    throw new Error("BOT_TOKEN が設定されていません");
  }

  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  const authDate = Number(params.get("auth_date"));

  if (!hash || !authDate) {
    throw new Error("Telegram initData が不正です");
  }

  // auth_date の有効期限チェック
  const now = Math.floor(Date.now() / 1000);

  if (Math.abs(now - authDate) > MAX_AUTH_AGE) {
    throw new Error("Telegram initData の有効期限が切れています");
  }

  // data-check-string 作成
  const dataCheckString = [...params.entries()]
    .filter(([key]) => key !== "hash")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

  // Telegram WebApp の署名キー
  const secretKey = crypto
    .createHmac("sha256", "WebAppData")
    .update(BOT_TOKEN)
    .digest();

  // ハッシュ計算
  const calculatedHash = crypto
    .createHmac("sha256", secretKey)
    .update(dataCheckString)
    .digest("hex");

  const receivedBuffer = Buffer.from(hash, "hex");
  const calculatedBuffer = Buffer.from(calculatedHash, "hex");

  if (
    receivedBuffer.length !== calculatedBuffer.length ||
    !crypto.timingSafeEqual(receivedBuffer, calculatedBuffer)
  ) {
    throw new Error("Telegram initData の署名が不正です");
  }

  // Telegramユーザー情報
  const userRaw = params.get("user");

  if (!userRaw) {
    throw new Error("Telegramユーザー情報がありません");
  }

  const user = JSON.parse(userRaw);

  if (!user.id) {
    throw new Error("TelegramユーザーIDが取得できません");
  }

  return String(user.id);
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  // GET / POST のみ
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({
      ok: false,
      error: "Method Not Allowed",
    });
  }

  try {
    // Telegram initData
    const initData =
      req.headers["x-telegram-init-data"] ||
      req.headers["X-Telegram-Init-Data"];

    const telegramUserId = validateTelegramInitData(initData);

    // =========================
    // GET：現在の目標を取得
    // =========================
    if (req.method === "GET") {
      const rows = await sql`
        SELECT
          telegram_user_id,
          monthly_goal,
          updated_at
        FROM delivery_goals
        WHERE telegram_user_id = ${telegramUserId}
        LIMIT 1
      `;

      if (rows.length === 0) {
        return res.status(200).json({
          ok: true,
          monthlyGoal: 0,
          updatedAt: null,
        });
      }

      return res.status(200).json({
        ok: true,
        monthlyGoal: Number(rows[0].monthly_goal),
        updatedAt: rows[0].updated_at,
      });
    }

    // =========================
    // POST：月間目標を保存
    // =========================
    let body = req.body;

    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        return res.status(400).json({
          ok: false,
          error: "JSONが不正です",
        });
      }
    }

    body = body || {};

    const monthlyGoal = Number(body.monthlyGoal);

    // 入力チェック
    if (
      !Number.isInteger(monthlyGoal) ||
      monthlyGoal <= 0 ||
      monthlyGoal > 1000000
    ) {
      return res.status(400).json({
        ok: false,
        error: "月間目標は1〜1,000,000件の整数で入力してください",
      });
    }

    // DBへ保存
    const rows = await sql`
      INSERT INTO delivery_goals (
        telegram_user_id,
        monthly_goal,
        updated_at
      )
      VALUES (
        ${telegramUserId},
        ${monthlyGoal},
        NOW()
      )
      ON CONFLICT (telegram_user_id)
      DO UPDATE SET
        monthly_goal = EXCLUDED.monthly_goal,
        updated_at = NOW()
      RETURNING
        telegram_user_id,
        monthly_goal,
        updated_at
    `;

    // 監査ログ
    await sql`
      INSERT INTO audit_logs (
        telegram_user_id,
        chat_id,
        action,
        details
      )
      VALUES (
        ${telegramUserId},
        NULL,
        'goal_update',
        ${JSON.stringify({
          monthlyGoal,
        })}
      )
    `;

    return res.status(200).json({
      ok: true,
      monthlyGoal: Number(rows[0].monthly_goal),
      updatedAt: rows[0].updated_at,
    });
  } catch (error) {
    console.error("goal API error:", error);

    return res.status(401).json({
      ok: false,
      error: error.message || "目標の保存に失敗しました",
    });
  }
};

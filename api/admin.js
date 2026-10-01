import { neon } from "@neondatabase/serverless";
import crypto from "crypto";

const sql = neon(process.env.DATABASE_URL);

const MAX_AUTH_AGE_SECONDS = 60 * 60;

// =========================================================
// Telegram initData 検証
// =========================================================

function validateTelegramInitData(initData) {
  if (!initData) {
    throw new Error("Telegram initData がありません。");
  }

  const botToken = process.env.BOT_TOKEN;

  if (!botToken) {
    throw new Error("BOT_TOKEN が設定されていません。");
  }

  const params = new URLSearchParams(initData);
  const receivedHash = params.get("hash");

  if (!receivedHash) {
    throw new Error("Telegram hash がありません。");
  }

  const authDate = Number(params.get("auth_date"));

  if (!Number.isInteger(authDate) || authDate <= 0) {
    throw new Error("Telegram auth_date が不正です。");
  }

  const now = Math.floor(Date.now() / 1000);

  if (
    Math.abs(now - authDate) >
    MAX_AUTH_AGE_SECONDS
  ) {
    throw new Error(
      "Telegram initData の有効期限が切れています。"
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

  const receivedBuffer = Buffer.from(
    receivedHash,
    "hex"
  );

  const calculatedBuffer = Buffer.from(
    calculatedHash,
    "hex"
  );

  if (
    receivedBuffer.length !== calculatedBuffer.length ||
    !crypto.timingSafeEqual(
      receivedBuffer,
      calculatedBuffer
    )
  ) {
    throw new Error(
      "Telegram initData の署名が不正です。"
    );
  }

  const userRaw = params.get("user");

  if (!userRaw) {
    throw new Error(
      "Telegramユーザー情報がありません。"
    );
  }

  let user;

  try {
    user = JSON.parse(userRaw);
  } catch {
    throw new Error(
      "Telegramユーザー情報が不正です。"
    );
  }

  if (!user?.id) {
    throw new Error(
      "TelegramユーザーIDがありません。"
    );
  }

  return String(user.id);
}

// =========================================================
// 管理者ID
// =========================================================

function getAdminIds() {
  return String(
    process.env.ADMIN_TELEGRAM_IDS || ""
  )
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
}

function isAdmin(userId) {
  return getAdminIds().includes(
    String(userId)
  );
}

// =========================================================
// API
// =========================================================

export default async function handler(req, res) {
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
    // =====================================================
    // Telegram認証
    // =====================================================

    const initData =
      req.headers[
        "x-telegram-init-data"
      ];

    if (!initData) {
      return res.status(401).json({
        ok: false,
        error:
          "Telegram認証情報がありません。",
      });
    }

    const telegramUserId =
      validateTelegramInitData(
        initData
      );

    // =====================================================
    // 管理者チェック
    // =====================================================

    if (!isAdmin(telegramUserId)) {
      return res.status(403).json({
        ok: false,
        error:
          "管理者権限がありません。",
      });
    }

    // =====================================================
    // 全体集計
    // 個人データのみ
    // =====================================================

    const [
      totalResult,
      todayResult,
      monthResult,
      userResult,
      latestResult,
    ] = await Promise.all([
      sql`
        SELECT
          COUNT(*)::int AS record_count,
          COALESCE(
            SUM(sale_amount),
            0
          )::bigint AS total_sales,
          COALESCE(
            SUM(delivery_count),
            0
          )::bigint AS total_deliveries,
          COALESCE(
            SUM(work_hours),
            0
          )::numeric AS total_hours
        FROM delivery_results
      `,

      sql`
        SELECT
          COUNT(*)::int AS record_count,
          COUNT(
            DISTINCT telegram_user_id
          )::int AS active_users,
          COALESCE(
            SUM(sale_amount),
            0
          )::bigint AS total_sales,
          COALESCE(
            SUM(delivery_count),
            0
          )::bigint AS total_deliveries,
          COALESCE(
            SUM(work_hours),
            0
          )::numeric AS total_hours
        FROM delivery_results
        WHERE (
          created_at AT TIME ZONE
          'Asia/Tokyo'
        )::date =
        (
          NOW() AT TIME ZONE
          'Asia/Tokyo'
        )::date
      `,

      sql`
        SELECT
          COUNT(*)::int AS record_count,
          COUNT(
            DISTINCT telegram_user_id
          )::int AS active_users,
          COALESCE(
            SUM(sale_amount),
            0
          )::bigint AS total_sales,
          COALESCE(
            SUM(delivery_count),
            0
          )::bigint AS total_deliveries,
          COALESCE(
            SUM(work_hours),
            0
          )::numeric AS total_hours
        FROM delivery_results
        WHERE (
          created_at AT TIME ZONE
          'Asia/Tokyo'
        ) >= date_trunc(
          'month',
          NOW() AT TIME ZONE
          'Asia/Tokyo'
        )
      `,

      sql`
        SELECT
          COUNT(
            DISTINCT telegram_user_id
          )::int AS user_count
        FROM delivery_results
      `,

      sql`
        SELECT
          id,
          telegram_user_id,
          sale_amount,
          delivery_count,
          work_hours,
          created_at
        FROM delivery_results
        ORDER BY created_at DESC
        LIMIT 20
      `,
    ]);

    const total = totalResult[0] || {};
    const today = todayResult[0] || {};
    const month = monthResult[0] || {};
    const users = userResult[0] || {};

    // =====================================================
    // 最新データ
    // =====================================================

    const latest = latestResult.map((row) => ({
      id: Number(row.id),
      telegramUserId:
        String(row.telegram_user_id),
      sale: Number(row.sale_amount),
      count: Number(row.delivery_count),
      hours: Number(row.work_hours),
      createdAt: row.created_at,
    }));

    // =====================================================
    // レスポンス
    // =====================================================

    return res.status(200).json({
      ok: true,

      total: {
        recordCount:
          Number(total.record_count || 0),

        sales:
          Number(total.total_sales || 0),

        deliveries:
          Number(total.total_deliveries || 0),

        hours:
          Number(total.total_hours || 0),
      },

      today: {
        recordCount:
          Number(today.record_count || 0),

        activeUsers:
          Number(today.active_users || 0),

        sales:
          Number(today.total_sales || 0),

        deliveries:
          Number(today.total_deliveries || 0),

        hours:
          Number(today.total_hours || 0),
      },

      month: {
        recordCount:
          Number(month.record_count || 0),

        activeUsers:
          Number(month.active_users || 0),

        sales:
          Number(month.total_sales || 0),

        deliveries:
          Number(month.total_deliveries || 0),

        hours:
          Number(month.total_hours || 0),
      },

      users: {
        count:
          Number(users.user_count || 0),
      },

      latest,
    });
  } catch (error) {
    console.error(
      "Admin API error:",
      error
    );

    return res.status(500).json({
      ok: false,
      error:
        error?.message ||
        "管理者データの取得に失敗しました。",
    });
  }
}

import { neon } from "@neondatabase/serverless";
import crypto from "crypto";

const sql = neon(process.env.DATABASE_URL);

const MAX_AUTH_AGE_SECONDS = 60 * 60;

// =========================================================
// Telegram Mini App initData 検証
// =========================================================

function validateTelegramInitData(initData) {
  if (!initData || typeof initData !== "string") {
    throw new Error(
      "Telegram initData がありません。"
    );
  }

  const botToken = process.env.BOT_TOKEN;

  if (!botToken) {
    throw new Error(
      "BOT_TOKEN が設定されていません。"
    );
  }

  const params =
    new URLSearchParams(initData);

  const receivedHash =
    params.get("hash");

  if (!receivedHash) {
    throw new Error(
      "Telegram hash がありません。"
    );
  }

  const authDate =
    Number(
      params.get("auth_date")
    );

  if (
    !Number.isInteger(authDate) ||
    authDate <= 0
  ) {
    throw new Error(
      "Telegram auth_date が不正です。"
    );
  }

  const now =
    Math.floor(
      Date.now() / 1000
    );

  if (
    Math.abs(
      now - authDate
    ) >
    MAX_AUTH_AGE_SECONDS
  ) {
    throw new Error(
      "Telegram initData の有効期限が切れています。"
    );
  }

  params.delete("hash");

  const dataCheckString =
    [...params.entries()]
      .sort(([a], [b]) =>
        a.localeCompare(b)
      )
      .map(
        ([key, value]) =>
          `${key}=${value}`
      )
      .join("\n");

  const secretKey =
    crypto
      .createHmac(
        "sha256",
        "WebAppData"
      )
      .update(botToken)
      .digest();

  const calculatedHash =
    crypto
      .createHmac(
        "sha256",
        secretKey
      )
      .update(dataCheckString)
      .digest("hex");

  const receivedBuffer =
    Buffer.from(
      receivedHash,
      "hex"
    );

  const calculatedBuffer =
    Buffer.from(
      calculatedHash,
      "hex"
    );

  if (
    receivedBuffer.length !==
      calculatedBuffer.length ||
    !crypto.timingSafeEqual(
      receivedBuffer,
      calculatedBuffer
    )
  ) {
    throw new Error(
      "Telegram initData の署名が不正です。"
    );
  }

  const userRaw =
    params.get("user");

  if (!userRaw) {
    throw new Error(
      "Telegramユーザー情報がありません。"
    );
  }

  let user;

  try {
    user =
      JSON.parse(userRaw);
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
// API
// =========================================================

export default async function handler(
  req,
  res
) {
  res.setHeader(
    "Cache-Control",
    "no-store"
  );

  // =======================================================
  // POSTのみ
  // =======================================================

  if (req.method !== "POST") {
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
    // 自分の実績だけ削除
    // =====================================================

    const deletedRows =
      await sql`
        DELETE FROM delivery_results
        WHERE telegram_user_id =
          ${telegramUserId}
        RETURNING id
      `;

    const deletedCount =
      deletedRows.length;

    // =====================================================
    // 監査ログ
    // =====================================================

    try {
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
          'reset',
          ${JSON.stringify({
            deletedCount,
          })}
        )
      `;
    } catch (auditError) {
      console.error(
        "Reset audit log error:",
        auditError
      );
    }

    // =====================================================
    // 完了
    // =====================================================

    return res.status(200).json({
      ok: true,

      deletedCount,

      message:
        deletedCount > 0
          ? `${deletedCount}件の実績を削除しました。`
          : "削除する実績はありませんでした。",
    });
  } catch (error) {
    console.error(
      "Reset API error:",
      error
    );

    return res.status(500).json({
      ok: false,
      error:
        error?.message ||
        "リセット処理に失敗しました。",
    });
  }
}

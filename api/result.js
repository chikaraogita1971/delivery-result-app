import { neon } from "@neondatabase/serverless";
import crypto from "crypto";

const sql = neon(process.env.POSTGRES_URL);

const MAX_AUTH_AGE_SECONDS = 60 * 60;

/*
============================================================
Telegram Mini App initData 検証
============================================================
*/
function validateTelegramInitData(initData) {
  if (!initData || typeof initData !== "string") {
    throw new Error("Telegram initData がありません。");
  }

  const params = new URLSearchParams(initData);

  const receivedHash = params.get("hash");

  if (!receivedHash) {
    throw new Error("Telegram hash がありません。");
  }

  params.delete("hash");

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

  /*
  Telegram Mini App公式の署名方式

  secret_key = HMAC-SHA256(
    key = "WebAppData",
    message = BOT_TOKEN
  )
  */
  const secretKey = crypto
    .createHmac("sha256", "WebAppData")
    .update(process.env.BOT_TOKEN)
    .digest();

  const calculatedHash = crypto
    .createHmac("sha256", secretKey)
    .update(dataCheckString)
    .digest("hex");

  const receivedBuffer = Buffer.from(receivedHash, "hex");
  const calculatedBuffer = Buffer.from(calculatedHash, "hex");

  if (
    receivedBuffer.length !== calculatedBuffer.length ||
    !crypto.timingSafeEqual(
      receivedBuffer,
      calculatedBuffer
    )
  ) {
    throw new Error("Telegram initData の署名が不正です。");
  }

  /*
  ============================================================
  auth_date の有効期限チェック
  ============================================================
  */

  const authDate = Number(params.get("auth_date"));

  if (
    !Number.isInteger(authDate) ||
    authDate <= 0
  ) {
    throw new Error("Telegram auth_date が不正です。");
  }

  const now = Math.floor(Date.now() / 1000);

  if (now - authDate > MAX_AUTH_AGE_SECONDS) {
    throw new Error("Telegram initData の有効期限が切れています。");
  }

  /*
  ============================================================
  Telegramユーザー情報
  ============================================================
  */

  const userJson = params.get("user");

  if (!userJson) {
    throw new Error("Telegramユーザー情報がありません。");
  }

  let user;

  try {
    user = JSON.parse(userJson);
  } catch {
    throw new Error("Telegramユーザー情報を解析できません。");
  }

  if (!user?.id) {
    throw new Error("TelegramユーザーIDがありません。");
  }

  return String(user.id);
}

/*
============================================================
API
============================================================
*/

export default async function handler(req, res) {
  /*
  ============================================================
  POSTのみ許可
  ============================================================
  */

  if (req.method !== "POST") {
    return res.status(405).json({
      ok: false,
      error: "Method Not Allowed"
    });
  }

  try {
    /*
    ============================================================
    Telegram initData取得
    ============================================================
    */

    const initData =
      req.headers["x-telegram-init-data"];

    if (!initData) {
      return res.status(401).json({
        ok: false,
        error: "Telegram認証情報がありません。"
      });
    }

    /*
    ============================================================
    Telegram本人確認
    ============================================================
    */

    const telegramUserId =
      validateTelegramInitData(initData);

    /*
    ============================================================
    実績削除
    ============================================================

    telegram_user_id が一致するものだけ削除。

    他ユーザーのデータは削除できません。
    */

    const deletedRows = await sql`
      DELETE FROM delivery_results
      WHERE telegram_user_id = ${telegramUserId}
      RETURNING id
    `;

    const deletedCount = deletedRows.length;

    /*
    ============================================================
    完了
    ============================================================
    */

    return res.status(200).json({
      ok: true,
      deletedCount,
      message:
        deletedCount > 0
          ? `${deletedCount}件の実績を削除しました。`
          : "削除する実績はありませんでした。"
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
        "リセット処理に失敗しました。"
    });
  }
}

    return res.status(500).json({
      error: "Internal Server Error",
    });
  }
}

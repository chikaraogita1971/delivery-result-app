import { neon } from "@neondatabase/serverless";
import crypto from "crypto";

const sql = neon(process.env.POSTGRES_URL);

const MAX_AUTH_AGE_SECONDS = 60 * 60;

/*
==========================================================
Telegram Mini App 認証
==========================================================
*/

function validateTelegramInitData(initData) {

  if (
    !initData ||
    typeof initData !== "string"
  ) {
    throw new Error(
      "Telegram initData がありません。"
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

  params.delete("hash");

  const dataCheckString =
    [...params.entries()]
      .sort(
        ([a], [b]) =>
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
      .update(
        process.env.BOT_TOKEN
      )
      .digest();

  const calculatedHash =
    crypto
      .createHmac(
        "sha256",
        secretKey
      )
      .update(
        dataCheckString
      )
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
    now - authDate >
    MAX_AUTH_AGE_SECONDS
  ) {
    throw new Error(
      "Telegram initData の有効期限が切れています。"
    );
  }

  const userJson =
    params.get("user");

  if (!userJson) {
    throw new Error(
      "Telegramユーザー情報がありません。"
    );
  }

  let user;

  try {

    user =
      JSON.parse(userJson);

  } catch {

    throw new Error(
      "Telegramユーザー情報を解析できません。"
    );
  }

  if (!user?.id) {
    throw new Error(
      "TelegramユーザーIDがありません。"
    );
  }

  return String(user.id);
}

/*
==========================================================
管理者判定
==========================================================
*/

function getAdminIds() {

  return String(
    process.env.ADMIN_TELEGRAM_USER_IDS ||
    ""
  )
    .split(",")
    .map(
      id => id.trim()
    )
    .filter(Boolean);
}

function isAdmin(userId) {

  return getAdminIds()
    .includes(
      String(userId)
    );
}

/*
==========================================================
監査ログ
==========================================================
*/

async function writeAuditLog({
  telegramUserId,
  chatId = null,
  action,
  details = null
}) {

  await sql`
    INSERT INTO audit_logs (
      telegram_user_id,
      chat_id,
      action,
      details
    )
    VALUES (
      ${String(telegramUserId)},
      ${chatId ? String(chatId) : null},
      ${action},
      ${details ? JSON.stringify(details) : null}
    )
  `;
}

/*
==========================================================
POST
==========================================================
*/

export default async function handler(
  req,
  res
) {

  if (req.method !== "POST") {

    return res.status(405).json({
      ok: false,
      error: "Method Not Allowed"
    });
  }

  try {

    /*
    ==========================
    Telegram認証
    ==========================
    */

    const initData =
      req.headers[
        "x-telegram-init-data"
      ];

    if (!initData) {

      return res.status(401).json({
        ok: false,
        error:
          "Telegram認証情報がありません。"
      });
    }

    const telegramUserId =
      validateTelegramInitData(
        initData
      );

    /*
    ==========================
    管理者確認
    ==========================
    */

    if (
      !isAdmin(
        telegramUserId
      )
    ) {

      await writeAuditLog({
        telegramUserId,
        action:
          "admin_reset_denied",
        details: {
          reason:
            "not_admin"
        }
      });

      return res.status(403).json({
        ok: false,
        error:
          "管理者権限がありません。"
      });
    }

    /*
    ==========================
    Body
    ==========================
    */

    const body =
      typeof req.body === "object"
        ? req.body
        : {};

    const action =
      body.action;

    /*
    ========================================================
    全体初期化
    ========================================================
    */

    if (action === "all") {

      /*
      実績件数を先に取得
      */

      const resultCountRows =
        await sql`
          SELECT COUNT(*) AS count
          FROM delivery_results
        `;

      const goalCountRows =
        await sql`
          SELECT COUNT(*) AS count
          FROM delivery_goals
        `;

      const resultCount =
        Number(
          resultCountRows[0]?.count ||
          0
        );

      const goalCount =
        Number(
          goalCountRows[0]?.count ||
          0
        );

      /*
      全実績削除
      */

      await sql`
        DELETE FROM delivery_results
      `;

      /*
      全月間目標削除
      */

      await sql`
        DELETE FROM delivery_goals
      `;

      /*
      監査ログ
      */

      await writeAuditLog({
        telegramUserId,
        action:
          "admin_reset_all",
        details: {
          deletedResults:
            resultCount,
          deletedGoals:
            goalCount
        }
      });

      return res.status(200).json({
        ok: true,
        action: "all",
        deleted: {
          results:
            resultCount,
          goals:
            goalCount
        }
      });
    }

    /*
    ========================================================
    グループ初期化
    ========================================================
    */

    if (action === "group") {

      const chatId =
        body.chatId
          ? String(body.chatId)
          : "";

      if (!chatId) {

        return res.status(400).json({
          ok: false,
          error:
            "chatId がありません。"
        });
      }

      /*
      登録グループ確認
      */

      const groupRows =
        await sql`
          SELECT
            chat_id,
            title
          FROM telegram_groups
          WHERE chat_id = ${chatId}
          LIMIT 1
        `;

      if (!groupRows.length) {

        return res.status(404).json({
          ok: false,
          error:
            "指定されたグループが登録されていません。"
        });
      }

      const group =
        groupRows[0];

      /*
      削除件数
      */

      const countRows =
        await sql`
          SELECT COUNT(*) AS count
          FROM delivery_results
          WHERE chat_id = ${chatId}
        `;

      const deletedCount =
        Number(
          countRows[0]?.count ||
          0
        );

      /*
      グループ実績だけ削除
      */

      await sql`
        DELETE FROM delivery_results
        WHERE chat_id = ${chatId}
      `;

      /*
      監査ログ
      */

      await writeAuditLog({
        telegramUserId,
        chatId,
        action:
          "admin_reset_group",
        details: {
          title:
            group.title ||
            "グループ",
          deletedResults:
            deletedCount
        }
      });

      return res.status(200).json({
        ok: true,
        action: "group",
        chatId,
        group: {
          title:
            group.title ||
            "グループ"
        },
        deleted: {
          results:
            deletedCount
        }
      });
    }

    /*
    ==========================
    不正なaction
    ==========================
    */

    return res.status(400).json({
      ok: false,
      error:
        "action は all または group を指定してください。"
    });

  } catch (error) {

    console.error(
      "Admin reset API error:",
      error
    );

    return res.status(500).json({
      ok: false,
      error:
        error?.message ||
        "初期化処理中にエラーが発生しました。"
    });
  }
}

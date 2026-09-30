import { neon } from "@neondatabase/serverless";
import crypto from "crypto";

const sql = neon(process.env.POSTGRES_URL);

const MAX_AUTH_AGE_SECONDS = 60 * 60;

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

  const authDate = Number(
    params.get("auth_date")
  );

  if (
    !Number.isInteger(authDate) ||
    authDate <= 0
  ) {
    throw new Error("Telegram auth_date が不正です。");
  }

  const now =
    Math.floor(Date.now() / 1000);

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
    user = JSON.parse(userJson);
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

function getAdminIds() {
  return String(
    process.env.ADMIN_TELEGRAM_USER_IDS || ""
  )
    .split(",")
    .map(id => id.trim())
    .filter(Boolean);
}

function isAdmin(userId) {
  return getAdminIds().includes(
    String(userId)
  );
}

async function writeAuditLog(
  telegramUserId,
  chatId,
  action,
  details = {}
) {
  try {
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
        ${JSON.stringify(details)}
      )
    `;
  } catch (error) {
    console.error(
      "Audit log error:",
      error
    );
  }
}

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

    if (!isAdmin(telegramUserId)) {
      await writeAuditLog(
        telegramUserId,
        null,
        "admin_reset_denied",
        {}
      );

      return res.status(403).json({
        ok: false,
        error:
          "管理者権限がありません。"
      });
    }

    let body = req.body;

    if (
      typeof body === "string"
    ) {
      try {
        body = JSON.parse(body);
      } catch {
        body = {};
      }
    }

    body = body || {};

    const action =
      body.action || "all";

    /*
    ==========================================================
    全体初期化
    ==========================================================
    */

    if (action === "all") {
      const result =
        await sql`
          DELETE FROM delivery_results
        `;

      await sql`
        DELETE FROM delivery_goals
      `;

      await writeAuditLog(
        telegramUserId,
        null,
        "admin_reset_all",
        {
          deletedResults:
            Number(
              result?.count || 0
            ),
          deletedGoals: true
        }
      );

      return res.status(200).json({
        ok: true,
        action: "all",
        message:
          "管理データを初期化しました。"
      });
    }

    /*
    ==========================================================
    グループ初期化
    ==========================================================
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
            "chatId が指定されていません。"
        });
      }

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

      const result =
        await sql`
          DELETE FROM delivery_results
          WHERE chat_id = ${chatId}
        `;

      await writeAuditLog(
        telegramUserId,
        chatId,
        "admin_reset_group",
        {
          title:
            groupRows[0].title ||
            "グループ",
          deletedResults:
            Number(
              result?.count || 0
            )
        }
      );

      return res.status(200).json({
        ok: true,
        action: "group",
        chatId,
        message:
          "グループ実績を初期化しました。"
      });
    }

    return res.status(400).json({
      ok: false,
      error:
        "初期化対象が不正です。"
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

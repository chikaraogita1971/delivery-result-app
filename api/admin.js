import { neon } from "@neondatabase/serverless";
import crypto from "crypto";

const sql = neon(process.env.POSTGRES_URL);

const TIME_ZONE = "Asia/Tokyo";
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

  const secretKey = crypto
    .createHmac("sha256", "WebAppData")
    .update(process.env.BOT_TOKEN)
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

  const authDate = Number(
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

  const now = Math.floor(
    Date.now() / 1000
  );

  if (
    now - authDate > MAX_AUTH_AGE_SECONDS
  ) {
    throw new Error(
      "Telegram initData の有効期限が切れています。"
    );
  }

  const userJson = params.get("user");

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

/*
============================================================
管理者ID
============================================================
*/

function getAdminIds() {
  return String(
    process.env.ADMIN_TELEGRAM_USER_IDS || ""
  )
    .split(",")
    .map(id => id.trim())
    .filter(Boolean);
}

/*
============================================================
管理者確認
============================================================
*/

function isAdmin(userId) {
  return getAdminIds().includes(
    String(userId)
  );
}

/*
============================================================
API
============================================================
*/

export default async function handler(req, res) {

  if (req.method !== "GET") {
    return res.status(405).json({
      ok: false,
      error: "Method Not Allowed"
    });
  }

  try {

    /*
    ==========================================================
    Telegram認証
    ==========================================================
    */

    const initData =
      req.headers["x-telegram-init-data"];

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
    ==========================================================
    管理者確認
    ==========================================================
    */

    if (!isAdmin(telegramUserId)) {
      return res.status(403).json({
        ok: false,
        error:
          "管理者権限がありません。"
      });
    }

    /*
    ==========================================================
    今月の期間
    ==========================================================
    */

    const monthStart = sql`
      (
        date_trunc(
          'month',
          CURRENT_TIMESTAMP AT TIME ZONE ${TIME_ZONE}
        )
      ) AT TIME ZONE ${TIME_ZONE}
    `;

    const monthEnd = sql`
      (
        (
          date_trunc(
            'month',
            CURRENT_TIMESTAMP AT TIME ZONE ${TIME_ZONE}
          ) + INTERVAL '1 month'
        )
      ) AT TIME ZONE ${TIME_ZONE}
    `;

    /*
    ==========================================================
    全体統計
    ==========================================================
    */

    const overallRows = await sql`
      SELECT
        COUNT(*) AS records,

        COUNT(
          DISTINCT telegram_user_id
        ) AS users,

        COALESCE(
          SUM(sale_amount),
          0
        ) AS sales,

        COALESCE(
          SUM(delivery_count),
          0
        ) AS count,

        COALESCE(
          SUM(work_hours),
          0
        ) AS hours

      FROM delivery_results
    `;

    const overall =
      overallRows[0] || {};

    /*
    ==========================================================
    今月統計
    ==========================================================
    */

    const monthlyRows = await sql`
      SELECT
        COUNT(*) AS records,

        COUNT(
          DISTINCT telegram_user_id
        ) AS active_users,

        COALESCE(
          SUM(sale_amount),
          0
        ) AS sales,

        COALESCE(
          SUM(delivery_count),
          0
        ) AS count,

        COALESCE(
          SUM(work_hours),
          0
        ) AS hours

      FROM delivery_results

      WHERE created_at >= ${monthStart}

        AND created_at < ${monthEnd}
    `;

    const monthly =
      monthlyRows[0] || {};

    const monthlySales =
      Number(
        monthly.sales || 0
      );

    const monthlyCount =
      Number(
        monthly.count || 0
      );

    const monthlyHours =
      Number(
        monthly.hours || 0
      );

    const average =
      monthlyCount > 0
        ? monthlySales /
          monthlyCount
        : 0;

    const averageHours =
      Number(
        monthly.active_users || 0
      ) > 0
        ? monthlyHours /
          Number(
            monthly.active_users
          )
        : 0;

    /*
    ==========================================================
    グループ
    ==========================================================
    */

    const groupRows = await sql`
      SELECT
        tg.chat_id,
        tg.title,

        COUNT(
          DISTINCT dr.telegram_user_id
        ) AS active_users,

        COALESCE(
          SUM(dr.sale_amount),
          0
        ) AS sales,

        COALESCE(
          SUM(dr.delivery_count),
          0
        ) AS count,

        COALESCE(
          SUM(dr.work_hours),
          0
        ) AS hours

      FROM telegram_groups tg

      LEFT JOIN delivery_results dr
        ON dr.chat_id =
          tg.chat_id

        AND dr.created_at >= ${monthStart}

        AND dr.created_at < ${monthEnd}

      GROUP BY
        tg.chat_id,
        tg.title

      ORDER BY
        sales DESC,
        tg.chat_id ASC
    `;

    const groups =
      groupRows.map(
        row => {

          const sales =
            Number(
              row.sales || 0
            );

          const count =
            Number(
              row.count || 0
            );

          const hours =
            Number(
              row.hours || 0
            );

          return {
            chatId:
              String(
                row.chat_id
              ),

            title:
              row.title ||
              "グループ",

            sales,

            count,

            hours,

            activeUsers:
              Number(
                row.active_users || 0
              ),

            average:
              count > 0
                ? sales / count
                : 0
          };
        }
      );

    /*
    ==========================================================
    最新監査ログ
    ==========================================================
    */

    const logRows = await sql`
      SELECT
        id,
        telegram_user_id,
        chat_id,
        action,
        details,
        created_at

      FROM audit_logs

      ORDER BY
        created_at DESC

      LIMIT 20
    `;

    const logs =
      logRows.map(
        row => ({
          id:
            Number(
              row.id
            ),

          telegramUserId:
            String(
              row.telegram_user_id
            ),

          chatId:
            row.chat_id
              ? String(
                  row.chat_id
                )
              : null,

          action:
            row.action,

          details:
            row.details || null,

          createdAt:
            row.created_at
        })
      );

    /*
    ==========================================================
    レスポンス
    ==========================================================
    */

    return res.status(200).json({
      ok: true,

      user: {
        telegramUserId
      },

      overall: {
        records:
          Number(
            overall.records || 0
          ),

        users:
          Number(
            overall.users || 0
          ),

        sales:
          Number(
            overall.sales || 0
          ),

        count:
          Number(
            overall.count || 0
          ),

        hours:
          Number(
            overall.hours || 0
          )
      },

      month: {
        records:
          Number(
            monthly.records || 0
          ),

        activeUsers:
          Number(
            monthly.active_users || 0
          ),

        sales:
          monthlySales,

        count:
          monthlyCount,

        hours:
          monthlyHours,

        average,

        averageHours
      },

      groups,

      logs
    });

  } catch (error) {

    console.error(
      "Admin Mini App API error:",
      error
    );

    return res.status(500).json({
      ok: false,
      error:
        error?.message ||
        "管理者データ取得中にエラーが発生しました。"
    });
  }
}

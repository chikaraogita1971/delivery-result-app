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

  /*
  ============================================================
  Telegram Mini App 公式署名方式
  ============================================================
  */

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

  /*
  ============================================================
  auth_date 有効期限
  ============================================================
  */

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

  /*
  ============================================================
  Telegramユーザー情報
  ============================================================
  */

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
月の開始・終了日時
============================================================

month:
  YYYY-MM

指定なし:
  現在のJST月
============================================================
*/

function getMonthCondition(month) {
  if (
    month !== undefined &&
    !/^\d{4}-\d{2}$/.test(month)
  ) {
    throw new Error(
      "month は YYYY-MM 形式で指定してください。"
    );
  }

  if (month) {
    const [year, monthNumber] =
      month.split("-").map(Number);

    if (
      monthNumber < 1 ||
      monthNumber > 12
    ) {
      throw new Error(
        "month が不正です。"
      );
    }

    return {
      start: sql`
        (
          make_date(
            ${year},
            ${monthNumber},
            1
          )::timestamp
          AT TIME ZONE ${TIME_ZONE}
        )
      `,
      end: sql`
        (
          (
            make_date(
              ${year},
              ${monthNumber},
              1
            ) + INTERVAL '1 month'
          )::timestamp
          AT TIME ZONE ${TIME_ZONE}
        )
      `,
      label: `${year}年${monthNumber}月`
    };
  }

  return {
    start: sql`
      (
        date_trunc(
          'month',
          CURRENT_TIMESTAMP AT TIME ZONE ${TIME_ZONE}
        )
      ) AT TIME ZONE ${TIME_ZONE}
    `,
    end: sql`
      (
        (
          date_trunc(
            'month',
            CURRENT_TIMESTAMP AT TIME ZONE ${TIME_ZONE}
          ) + INTERVAL '1 month'
        )
      ) AT TIME ZONE ${TIME_ZONE}
    `,
    label: sql`
      to_char(
        CURRENT_TIMESTAMP AT TIME ZONE ${TIME_ZONE},
        'YYYY年MM月'
      )
    `
  };
}

/*
============================================================
API
============================================================
*/

export default async function handler(req, res) {

  /*
  ============================================================
  GETのみ
  ============================================================
  */

  if (req.method !== "GET") {
    return res.status(405).json({
      ok: false,
      error: "Method Not Allowed"
    });
  }

  try {

    /*
    ============================================================
    Telegram initData
    ============================================================
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

    /*
    ============================================================
    Telegram本人確認
    ============================================================
    */

    const telegramUserId =
      validateTelegramInitData(initData);

    /*
    ============================================================
    chatId
    ============================================================
    */

    const requestedChatId =
      Array.isArray(req.query?.chatId)
        ? req.query.chatId[0]
        : req.query?.chatId;

    /*
    ============================================================
    自分が所属しているグループ一覧
    ============================================================
    */

    const groupRows = await sql`
      SELECT
        tg.chat_id,
        tg.title,
        tg.created_at,
        tg.updated_at

      FROM telegram_groups tg

      INNER JOIN group_members gm
        ON gm.chat_id = tg.chat_id

      WHERE gm.telegram_user_id =
        ${telegramUserId}

      ORDER BY
        tg.updated_at DESC,
        tg.chat_id DESC
    `;

    const groups =
      groupRows.map(row => ({
        chatId: String(row.chat_id),

        title:
          row.title ||
          "グループ",

        createdAt:
          row.created_at,

        updatedAt:
          row.updated_at
      }));

    /*
    ============================================================
    グループ未所属
    ============================================================
    */

    if (groups.length === 0) {
      return res.status(200).json({
        ok: true,

        groups: [],

        selectedChatId: null,

        summary: null,

        members: []
      });
    }

    /*
    ============================================================
    対象グループ決定
    ============================================================
    */

    let chatId =
      requestedChatId
        ? String(requestedChatId)
        : String(groups[0].chatId);

    /*
    ============================================================
    自分が対象グループのメンバーか確認
    ============================================================
    */

    const accessRows = await sql`
      SELECT 1

      FROM group_members

      WHERE chat_id =
        ${chatId}

        AND telegram_user_id =
        ${telegramUserId}

      LIMIT 1
    `;

    if (accessRows.length === 0) {
      return res.status(403).json({
        ok: false,
        error:
          "このグループの実績を見る権限がありません。"
      });
    }

    /*
    ============================================================
    対象グループ情報
    ============================================================
    */

    const selectedGroup =
      groups.find(
        group =>
          String(group.chatId) ===
          String(chatId)
      );

    /*
    ============================================================
    month
    ============================================================
    */

    const requestedMonth =
      Array.isArray(req.query?.month)
        ? req.query.month[0]
        : req.query?.month;

    const {
      start,
      end
    } = getMonthCondition(
      requestedMonth
    );

    /*
    ============================================================
    グループ全体集計
    ============================================================
    */

    const aggregateRows = await sql`
      SELECT
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
        ) AS hours,

        COUNT(
          DISTINCT telegram_user_id
        ) AS active_users

      FROM delivery_results

      WHERE chat_id =
        ${chatId}

        AND created_at >= ${start}

        AND created_at < ${end}
    `;

    const aggregate =
      aggregateRows[0] || {};

    const sales =
      Number(
        aggregate.sales || 0
      );

    const count =
      Number(
        aggregate.count || 0
      );

    const hours =
      Number(
        aggregate.hours || 0
      );

    const activeUsers =
      Number(
        aggregate.active_users || 0
      );

    const average =
      count > 0
        ? sales / count
        : 0;

    /*
    ============================================================
    メンバー別集計
    ============================================================

    Bot / GroupAnonymousBot は除外。

    group_members に登録されている人を基準にするため、
    実績ゼロのメンバーも表示。
    ============================================================
    */

    const memberRows = await sql`
      SELECT
        gm.telegram_user_id,
        gm.username,
        gm.first_name,

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
        ) AS hours,

        COUNT(dr.id) AS result_count,

        MAX(dr.created_at) AS latest_at

      FROM group_members gm

      LEFT JOIN delivery_results dr
        ON dr.chat_id =
          gm.chat_id

        AND dr.telegram_user_id =
          gm.telegram_user_id

        AND dr.created_at >= ${start}

        AND dr.created_at < ${end}

      WHERE gm.chat_id =
        ${chatId}

        AND COALESCE(
          gm.username,
          ''
        ) <> 'delivery_result_bot'

        AND COALESCE(
          gm.username,
          ''
        ) <> 'GroupAnonymousBot'

        AND gm.telegram_user_id NOT IN (
          '8981642532',
          '1087968824'
        )

      GROUP BY
        gm.telegram_user_id,
        gm.username,
        gm.first_name

      ORDER BY
        COALESCE(
          SUM(dr.sale_amount),
          0
        ) DESC,

        COALESCE(
          SUM(dr.delivery_count),
          0
        ) DESC,

        COALESCE(
          SUM(dr.work_hours),
          0
        ) DESC,

        gm.telegram_user_id ASC
    `;

    /*
    ============================================================
    メンバー整形
    ============================================================
    */

    const members =
      memberRows.map(
        (row, index) => {

          const memberSales =
            Number(
              row.sales || 0
            );

          const memberCount =
            Number(
              row.count || 0
            );

          const memberHours =
            Number(
              row.hours || 0
            );

          const memberAverage =
            memberCount > 0
              ? memberSales /
                memberCount
              : 0;

          let displayName =
            row.first_name ||
            row.username ||
            `ユーザー${row.telegram_user_id}`;

          if (
            row.username &&
            row.first_name
          ) {
            displayName =
              `${row.first_name} (@${row.username})`;
          } else if (
            row.username
          ) {
            displayName =
              `@${row.username}`;
          }

          return {
            rank:
              index + 1,

            telegramUserId:
              String(
                row.telegram_user_id
              ),

            username:
              row.username || null,

            firstName:
              row.first_name || null,

            displayName,

            sales:
              memberSales,

            count:
              memberCount,

            hours:
              memberHours,

            average:
              memberAverage,

            resultCount:
              Number(
                row.result_count || 0
              ),

            latestAt:
              row.latest_at || null
          };
        }
      );

    /*
    ============================================================
    レスポンス
    ============================================================
    */

    return res.status(200).json({

      ok: true,

      month:
        requestedMonth ||
        null,

      chatId:
        String(chatId),

      group: {
        chatId:
          String(
            selectedGroup?.chatId ||
            chatId
          ),

        title:
          selectedGroup?.title ||
          "グループ"
      },

      groups,

      summary: {
        sales,
        count,
        hours,
        activeUsers,
        average
      },

      members

    });

  } catch (error) {

    console.error(
      "Group API error:",
      error
    );

    return res.status(500).json({
      ok: false,
      error:
        error?.message ||
        "グループ実績取得中にサーバーエラーが発生しました。"
    });
  }
}

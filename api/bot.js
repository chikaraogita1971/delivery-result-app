const { neon } = require("@neondatabase/serverless");

const sql = neon(process.env.DATABASE_URL);

const BOT_TOKEN = process.env.BOT_TOKEN;
const JST = "Asia/Tokyo";

// ==============================
// Telegram API
// ==============================
async function telegram(method, body) {
  const response = await fetch(
    `https://api.telegram.org/bot${BOT_TOKEN}/${method}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    }
  );

  return response.json();
}

// ==============================
// Telegram User ID
// ==============================
function getTelegramUserId(message) {
  return String(
    message?.from?.id ||
    ""
  );
}

// ==============================
// Chat ID
// ==============================
function getChatId(message) {
  return String(
    message?.chat?.id ||
    ""
  );
}

// ==============================
// Group判定
// ==============================
function isGroupChat(chat) {
  return (
    chat &&
    (
      chat.type === "group" ||
      chat.type === "supergroup"
    )
  );
}

// ==============================
// Group / Member 登録
// ==============================
async function registerGroupAndMember(message) {
  if (!message?.chat || !isGroupChat(message.chat)) {
    return;
  }

  const chatId = String(message.chat.id);
  const title = message.chat.title || null;

  const userId = message?.from?.id
    ? String(message.from.id)
    : null;

  const username = message?.from?.username || null;
  const firstName = message?.from?.first_name || null;

  // グループ登録
  await sql`
    INSERT INTO telegram_groups
      (
        chat_id,
        title,
        created_at,
        updated_at
      )
    VALUES
      (
        ${chatId},
        ${title},
        NOW(),
        NOW()
      )
    ON CONFLICT (chat_id)
    DO UPDATE SET
      title = EXCLUDED.title,
      updated_at = NOW()
  `;

  // メンバー登録
  if (userId) {
    await sql`
      INSERT INTO group_members
        (
          chat_id,
          telegram_user_id,
          username,
          first_name,
          joined_at,
          updated_at
        )
      VALUES
        (
          ${chatId},
          ${userId},
          ${username},
          ${firstName},
          NOW(),
          NOW()
        )
      ON CONFLICT (
        chat_id,
        telegram_user_id
      )
      DO UPDATE SET
        username = EXCLUDED.username,
        first_name = EXCLUDED.first_name,
        updated_at = NOW()
    `;
  }
}

// ==============================
// 金額フォーマット
// ==============================
function formatYen(value) {
  return Number(value || 0).toLocaleString("ja-JP") + "円";
}

// ==============================
// 時間フォーマット
// ==============================
function formatHours(value) {
  const num = Number(value || 0);

  if (Number.isInteger(num)) {
    return String(num);
  }

  return num.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

// ==============================
// 日付フォーマット
// ==============================
function formatMonthDay(value) {
  const date = new Date(value);

  const month = date.getUTCMonth() + 1;
  const day = date.getUTCDate();

  return `${month}/${day}`;
}

// ==============================
// Webhook
// ==============================
module.exports = async (req, res) => {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({
        ok: false,
        error: "Method Not Allowed"
      });
    }

    const update = req.body || {};

    // ==============================
    // 通常メッセージ
    // ==============================
    const message = update.message;

    // ==============================
    // Callback Query
    // ==============================
    const callbackQuery = update.callback_query;

    // ==============================
    // Callback処理
    // ==============================
    if (callbackQuery) {
      const callbackMessage = callbackQuery.message;

      const telegramUserId = String(
        callbackQuery.from?.id || ""
      );

      const chatId = String(
        callbackMessage?.chat?.id || ""
      );

      const data = callbackQuery.data || "";

      await registerGroupAndMember({
        chat: callbackMessage?.chat,
        from: callbackQuery.from
      });

      // ------------------------------
      // キャンセル
      // ------------------------------
      if (data === "cancel") {
        await sql`
          DELETE FROM delivery_results
          WHERE telegram_user_id = ${telegramUserId}
        `;

        await telegram("answerCallbackQuery", {
          callback_query_id: callbackQuery.id,
          text: "実績を削除しました"
        });

        await telegram("sendMessage", {
          chat_id: chatId,
          text: "🗑 最新の実績を削除しました。"
        });

        return res.status(200).json({
          ok: true
        });
      }

      // ------------------------------
      // リセット
      // ------------------------------
      if (data === "reset") {
        await sql`
          DELETE FROM delivery_results
          WHERE telegram_user_id = ${telegramUserId}
        `;

        await telegram("answerCallbackQuery", {
          callback_query_id: callbackQuery.id,
          text: "実績をリセットしました"
        });

        await telegram("sendMessage", {
          chat_id: chatId,
          text: "♻️ 実績をリセットしました。"
        });

        return res.status(200).json({
          ok: true
        });
      }

      return res.status(200).json({
        ok: true
      });
    }

    // ==============================
    // message がない場合
    // ==============================
    if (!message) {
      return res.status(200).json({
        ok: true
      });
    }

    const telegramUserId = getTelegramUserId(message);
    const chatId = getChatId(message);
    const text = String(message.text || "").trim();

    // ==============================
    // Group / Member 自動登録
    // ==============================
    await registerGroupAndMember(message);

    // ==============================
    // 新規参加メンバー
    // ==============================
    if (
      Array.isArray(message.new_chat_members) &&
      message.new_chat_members.length > 0 &&
      isGroupChat(message.chat)
    ) {
      for (const member of message.new_chat_members) {
        const memberId = String(member.id);
        const username = member.username || null;
        const firstName = member.first_name || null;

        await sql`
          INSERT INTO group_members
            (
              chat_id,
              telegram_user_id,
              username,
              first_name,
              joined_at,
              updated_at
            )
          VALUES
            (
              ${chatId},
              ${memberId},
              ${username},
              ${firstName},
              NOW(),
              NOW()
            )
          ON CONFLICT (
            chat_id,
            telegram_user_id
          )
          DO UPDATE SET
            username = EXCLUDED.username,
            first_name = EXCLUDED.first_name,
            updated_at = NOW()
        `;
      }
    }

    // ==============================
    // /start
    // ==============================
    if (text === "/start") {
      await telegram("sendMessage", {
        chat_id: chatId,
        text:
          "🚚 配達リザルトBotです！\n\n" +
          "実績登録：/add 売上 件数 時間\n" +
          "例：/add 15000 25 8\n\n" +
          "最新実績削除：/cancel\n" +
          "全実績リセット：/reset\n" +
          "月間目標：/goal 金額\n" +
          "グループ集計：/group\n" +
          "先月集計：/lastmonth\n" +
          "ヘルプ：/help"
      });

      return res.status(200).json({
        ok: true
      });
    }

    // ==============================
    // /help
    // ==============================
    if (text === "/help") {
      await telegram("sendMessage", {
        chat_id: chatId,
        text:
          "📖 配達リザルトBot\n\n" +
          "/add 売上 件数 時間\n" +
          "例：/add 15000 25 8\n\n" +
          "/cancel\n" +
          "最新の実績を削除\n\n" +
          "/reset\n" +
          "自分の実績を全削除\n\n" +
          "/goal 金額\n" +
          "月間目標を設定\n\n" +
          "/group\n" +
          "今月のグループ実績\n\n" +
          "/lastmonth\n" +
          "先月のグループ実績"
      });

      return res.status(200).json({
        ok: true
      });
    }

    // ==============================
    // /group
    // ==============================
    if (text === "/group") {
      if (!isGroupChat(message.chat)) {
        await telegram("sendMessage", {
          chat_id: chatId,
          text: "このコマンドはグループ内で使用してください。"
        });

        return res.status(200).json({
          ok: true
        });
      }

      const groupTitle =
        message.chat.title || "グループ";

      // ------------------------------
      // 今月のグループ集計
      // ------------------------------
      const summaryRows = await sql`
        SELECT
          COALESCE(SUM(sale_amount), 0) AS total_sales,
          COALESCE(SUM(delivery_count), 0) AS total_count,
          COALESCE(SUM(work_hours), 0) AS total_hours,
          COUNT(DISTINCT telegram_user_id) AS member_count
        FROM delivery_results
        WHERE chat_id = ${chatId}
          AND created_at >= (
            date_trunc(
              'month',
              CURRENT_TIMESTAMP AT TIME ZONE ${JST}
            ) AT TIME ZONE ${JST}
          )
          AND created_at < (
            (
              date_trunc(
                'month',
                CURRENT_TIMESTAMP AT TIME ZONE ${JST}
              ) + INTERVAL '1 month'
            ) AT TIME ZONE ${JST}
          )
      `;

      const summary = summaryRows[0];

      // ------------------------------
      // メンバー別
      // ------------------------------
      const memberRows = await sql`
        SELECT
          dr.telegram_user_id,
          COALESCE(
            NULLIF(gm.username, ''),
            NULLIF(gm.first_name, ''),
            '不明'
          ) AS member_name,
          COALESCE(SUM(dr.sale_amount), 0) AS total_sales,
          COALESCE(SUM(dr.delivery_count), 0) AS total_count,
          COALESCE(SUM(dr.work_hours), 0) AS total_hours
        FROM delivery_results dr
        LEFT JOIN group_members gm
          ON gm.chat_id = dr.chat_id
          AND gm.telegram_user_id = dr.telegram_user_id
        WHERE dr.chat_id = ${chatId}
          AND dr.created_at >= (
            date_trunc(
              'month',
              CURRENT_TIMESTAMP AT TIME ZONE ${JST}
            ) AT TIME ZONE ${JST}
          )
          AND dr.created_at < (
            (
              date_trunc(
                'month',
                CURRENT_TIMESTAMP AT TIME ZONE ${JST}
              ) + INTERVAL '1 month'
            ) AT TIME ZONE ${JST}
          )
        GROUP BY
          dr.telegram_user_id,
          gm.username,
          gm.first_name
        ORDER BY total_sales DESC
      `;

      // ------------------------------
      // 日別
      // ------------------------------
      const dailyRows = await sql`
        SELECT
          (created_at AT TIME ZONE ${JST})::date AS work_date,
          COALESCE(SUM(sale_amount), 0) AS total_sales,
          COALESCE(SUM(delivery_count), 0) AS total_count,
          COALESCE(SUM(work_hours), 0) AS total_hours
        FROM delivery_results
        WHERE chat_id = ${chatId}
          AND created_at >= (
            date_trunc(
              'month',
              CURRENT_TIMESTAMP AT TIME ZONE ${JST}
            ) AT TIME ZONE ${JST}
          )
          AND created_at < (
            (
              date_trunc(
                'month',
                CURRENT_TIMESTAMP AT TIME ZONE ${JST}
              ) + INTERVAL '1 month'
            ) AT TIME ZONE ${JST}
          )
        GROUP BY work_date
        ORDER BY work_date DESC
      `;

      const totalSales =
        Number(summary.total_sales || 0);

      const totalCount =
        Number(summary.total_count || 0);

      const totalHours =
        Number(summary.total_hours || 0);

      const memberCount =
        Number(summary.member_count || 0);

      let resultText =
        `📊 ${groupTitle}\n\n` +
        `今月のグループ実績\n\n` +
        `💰 売上：${formatYen(totalSales)}\n` +
        `📦 件数：${totalCount}件\n` +
        `⏱ 稼働時間：${formatHours(totalHours)}時間\n` +
        `👥 実績登録者：${memberCount}人\n\n`;

      // ------------------------------
      // メンバー別
      // ------------------------------
      resultText += `👤 メンバー別実績\n\n`;

      if (memberRows.length === 0) {
        resultText += `まだ実績登録がありません\n`;
      } else {
        for (const member of memberRows) {
          const name =
            member.member_name ||
            `ユーザー ${member.telegram_user_id}`;

          resultText +=
            `${name}\n` +
            `💰 ${formatYen(Number(member.total_sales || 0))} / ` +
            `📦 ${Number(member.total_count || 0)}件 / ` +
            `⏱ ${formatHours(Number(member.total_hours || 0))}時間\n\n`;
        }
      }

      // ------------------------------
      // 日別
      // ------------------------------
      resultText += `📅 日別実績\n\n`;

      if (dailyRows.length === 0) {
        resultText += `まだ実績登録がありません`;
      } else {
        for (const day of dailyRows) {
          resultText +=
            `${formatMonthDay(day.work_date)}\n` +
            `💰 ${formatYen(Number(day.total_sales || 0))} / ` +
            `📦 ${Number(day.total_count || 0)}件 / ` +
            `⏱ ${formatHours(Number(day.total_hours || 0))}時間\n\n`;
        }

        resultText = resultText.trimEnd();
      }

      await telegram("sendMessage", {
        chat_id: chatId,
        text: resultText
      });

      return res.status(200).json({
        ok: true
      });
    }

    // ==============================
    // /lastmonth
    // ==============================
    if (text === "/lastmonth") {
      if (!isGroupChat(message.chat)) {
        await telegram("sendMessage", {
          chat_id: chatId,
          text: "このコマンドはグループ内で使用してください。"
        });

        return res.status(200).json({
          ok: true
        });
      }

      const groupTitle =
        message.chat.title || "グループ";

      // ------------------------------
      // 先月のグループ集計
      // ------------------------------
      const summaryRows = await sql`
        SELECT
          COALESCE(SUM(sale_amount), 0) AS total_sales,
          COALESCE(SUM(delivery_count), 0) AS total_count,
          COALESCE(SUM(work_hours), 0) AS total_hours,
          COUNT(DISTINCT telegram_user_id) AS member_count
        FROM delivery_results
        WHERE chat_id = ${chatId}
          AND created_at >= (
            (
              date_trunc(
                'month',
                CURRENT_TIMESTAMP AT TIME ZONE ${JST}
              ) - INTERVAL '1 month'
            ) AT TIME ZONE ${JST}
          )
          AND created_at < (
            date_trunc(
              'month',
              CURRENT_TIMESTAMP AT TIME ZONE ${JST}
            ) AT TIME ZONE ${JST}
          )
      `;

      const summary = summaryRows[0];

      // ------------------------------
      // 先月メンバー別
      // ------------------------------
      const memberRows = await sql`
        SELECT
          dr.telegram_user_id,
          COALESCE(
            NULLIF(gm.username, ''),
            NULLIF(gm.first_name, ''),
            '不明'
          ) AS member_name,
          COALESCE(SUM(dr.sale_amount), 0) AS total_sales,
          COALESCE(SUM(dr.delivery_count), 0) AS total_count,
          COALESCE(SUM(dr.work_hours), 0) AS total_hours
        FROM delivery_results dr
        LEFT JOIN group_members gm
          ON gm.chat_id = dr.chat_id
          AND gm.telegram_user_id = dr.telegram_user_id
        WHERE dr.chat_id = ${chatId}
          AND dr.created_at >= (
            (
              date_trunc(
                'month',
                CURRENT_TIMESTAMP AT TIME ZONE ${JST}
              ) - INTERVAL '1 month'
            ) AT TIME ZONE ${JST}
          )
          AND dr.created_at < (
            date_trunc(
              'month',
              CURRENT_TIMESTAMP AT TIME ZONE ${JST}
            ) AT TIME ZONE ${JST}
          )
        GROUP BY
          dr.telegram_user_id,
          gm.username,
          gm.first_name
        ORDER BY total_sales DESC
      `;

      // ------------------------------
      // 先月日別
      // ------------------------------
      const dailyRows = await sql`
        SELECT
          (created_at AT TIME ZONE ${JST})::date AS work_date,
          COALESCE(SUM(sale_amount), 0) AS total_sales,
          COALESCE(SUM(delivery_count), 0) AS total_count,
          COALESCE(SUM(work_hours), 0) AS total_hours
        FROM delivery_results
        WHERE chat_id = ${chatId}
          AND created_at >= (
            (
              date_trunc(
                'month',
                CURRENT_TIMESTAMP AT TIME ZONE ${JST}
              ) - INTERVAL '1 month'
            ) AT TIME ZONE ${JST}
          )
          AND created_at < (
            date_trunc(
              'month',
              CURRENT_TIMESTAMP AT TIME ZONE ${JST}
            ) AT TIME ZONE ${JST}
          )
        GROUP BY work_date
        ORDER BY work_date DESC
      `;

      const totalSales =
        Number(summary.total_sales || 0);

      const totalCount =
        Number(summary.total_count || 0);

      const totalHours =
        Number(summary.total_hours || 0);

      const memberCount =
        Number(summary.member_count || 0);

      let resultText =
        `📊 ${groupTitle}\n\n` +
        `先月のグループ実績\n\n` +
        `💰 売上：${formatYen(totalSales)}\n` +
        `📦 件数：${totalCount}件\n` +
        `⏱ 稼働時間：${formatHours(totalHours)}時間\n` +
        `👥 実績登録者：${memberCount}人\n\n`;

      // ------------------------------
      // メンバー別
      // ------------------------------
      resultText += `👤 メンバー別実績\n\n`;

      if (memberRows.length === 0) {
        resultText += `先月の実績登録がありません\n`;
      } else {
        for (const member of memberRows) {
          const name =
            member.member_name ||
            `ユーザー ${member.telegram_user_id}`;

          resultText +=
            `${name}\n` +
            `💰 ${formatYen(Number(member.total_sales || 0))} / ` +
            `📦 ${Number(member.total_count || 0)}件 / ` +
            `⏱ ${formatHours(Number(member.total_hours || 0))}時間\n\n`;
        }
      }

      // ------------------------------
      // 日別
      // ------------------------------
      resultText += `📅 日別実績\n\n`;

      if (dailyRows.length === 0) {
        resultText += `先月の実績登録がありません`;
      } else {
        for (const day of dailyRows) {
          resultText +=
            `${formatMonthDay(day.work_date)}\n` +
            `💰 ${formatYen(Number(day.total_sales || 0))} / ` +
            `📦 ${Number(day.total_count || 0)}件 / ` +
            `⏱ ${formatHours(Number(day.total_hours || 0))}時間\n\n`;
        }

        resultText = resultText.trimEnd();
      }

      await telegram("sendMessage", {
        chat_id: chatId,
        text: resultText
      });

      return res.status(200).json({
        ok: true
      });
    }

    // ==============================
    // /reset
    // ==============================
    if (text === "/reset") {
      await sql`
        DELETE FROM delivery_results
        WHERE telegram_user_id = ${telegramUserId}
      `;

      await telegram("sendMessage", {
        chat_id: chatId,
        text: "♻️ あなたの実績をすべてリセットしました。"
      });

      return res.status(200).json({
        ok: true
      });
    }

    // ==============================
    // /cancel
    // ==============================
    if (text === "/cancel") {
      const rows = await sql`
        SELECT id
        FROM delivery_results
        WHERE telegram_user_id = ${telegramUserId}
        ORDER BY created_at DESC
        LIMIT 1
      `;

      if (rows.length === 0) {
        await telegram("sendMessage", {
          chat_id: chatId,
          text: "削除できる実績がありません。"
        });

        return res.status(200).json({
          ok: true
        });
      }

      await sql`
        DELETE FROM delivery_results
        WHERE id = ${rows[0].id}
      `;

      await telegram("sendMessage", {
        chat_id: chatId,
        text: "🗑 最新の実績を削除しました。"
      });

      return res.status(200).json({
        ok: true
      });
    }

    // ==============================
    // /goal
    // ==============================
    if (text.startsWith("/goal")) {
      const parts = text.split(/\s+/);

      if (parts.length < 2) {
        await telegram("sendMessage", {
          chat_id: chatId,
          text:
            "使い方：\n" +
            "/goal 300000\n\n" +
            "例：\n" +
            "/goal 300000"
        });

        return res.status(200).json({
          ok: true
        });
      }

      const goal = Number(
        String(parts[1]).replace(/,/g, "")
      );

      if (!Number.isFinite(goal) || goal <= 0) {
        await telegram("sendMessage", {
          chat_id: chatId,
          text: "目標金額を正しく入力してください。"
        });

        return res.status(200).json({
          ok: true
        });
      }

      await sql`
        INSERT INTO delivery_goals
          (
            telegram_user_id,
            monthly_goal,
            updated_at
          )
        VALUES
          (
            ${telegramUserId},
            ${Math.floor(goal)},
            NOW()
          )
        ON CONFLICT (telegram_user_id)
        DO UPDATE SET
          monthly_goal = EXCLUDED.monthly_goal,
          updated_at = NOW()
      `;

      await telegram("sendMessage", {
        chat_id: chatId,
        text:
          `🎯 月間目標を ${formatYen(goal)} に設定しました。`
      });

      return res.status(200).json({
        ok: true
      });
    }

    // ==============================
    // /add
    // ==============================
    if (text.startsWith("/add")) {
      const parts = text.split(/\s+/);

      if (parts.length < 4) {
        await telegram("sendMessage", {
          chat_id: chatId,
          text:
            "使い方：\n" +
            "/add 売上 件数 時間\n\n" +
            "例：\n" +
            "/add 15000 25 8"
        });

        return res.status(200).json({
          ok: true
        });
      }

      const sale = Number(
        String(parts[1]).replace(/,/g, "")
      );

      const count = Number(parts[2]);

      const hours = Number(parts[3]);

      if (
        !Number.isFinite(sale) ||
        sale < 0 ||
        !Number.isFinite(count) ||
        count < 0 ||
        !Number.isFinite(hours) ||
        hours < 0
      ) {
        await telegram("sendMessage", {
          chat_id: chatId,
          text:
            "入力値が正しくありません。\n\n" +
            "例：/add 15000 25 8"
        });

        return res.status(200).json({
          ok: true
        });
      }

      await sql`
        INSERT INTO delivery_results
          (
            telegram_user_id,
            sale_amount,
            delivery_count,
            work_hours,
            chat_id
          )
        VALUES
          (
            ${telegramUserId},
            ${Math.floor(sale)},
            ${Math.floor(count)},
            ${hours},
            ${chatId}
          )
      `;

      await telegram("sendMessage", {
        chat_id: chatId,
        text:
          "✅ 実績を登録しました！\n\n" +
          `💰 売上：${formatYen(sale)}\n` +
          `📦 件数：${Math.floor(count)}件\n` +
          `⏱ 稼働時間：${formatHours(hours)}時間`
      });

      return res.status(200).json({
        ok: true
      });
    }

    // ==============================
    // 未知のコマンド
    // ==============================
    if (text.startsWith("/")) {
      await telegram("sendMessage", {
        chat_id: chatId,
        text:
          "❓ 不明なコマンドです。\n\n" +
          "/help で使い方を確認できます。"
      });

      return res.status(200).json({
        ok: true
      });
    }

    return res.status(200).json({
      ok: true
    });

  } catch (error) {
    console.error("BOT ERROR:", error);

    return res.status(500).json({
      ok: false,
      error: "Internal Server Error"
    });
  }
};

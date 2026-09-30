const { neon } = require("@neondatabase/serverless");

const sql = neon(process.env.DATABASE_URL);

const BOT_TOKEN = process.env.BOT_TOKEN;

const JST = "Asia/Tokyo";

// ==============================
// Telegram API
// ==============================
async function telegram(method, body = {}) {
  const response = await fetch(
    `https://api.telegram.org/bot${BOT_TOKEN}/${method}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }
  );

  return response.json();
}

// ==============================
// Telegram User ID
// ==============================
function getTelegramUserId(update) {
  return String(
    update?.message?.from?.id ??
      update?.callback_query?.from?.id ??
      ""
  );
}

// ==============================
// Chat ID
// ==============================
function getChatId(update) {
  return String(
    update?.message?.chat?.id ??
      update?.callback_query?.message?.chat?.id ??
      ""
  );
}

// ==============================
// Group判定
// ==============================
function isGroupChat(chatType) {
  return chatType === "group" || chatType === "supergroup";
}

// ==============================
// グループ＋メンバー登録
// ==============================
async function registerGroupAndMember(message) {
  if (!message?.chat) return;

  const chatType = message.chat.type;

  if (!isGroupChat(chatType)) return;

  const chatId = String(message.chat.id);
  const title = message.chat.title || "";

  const userId = String(message.from?.id || "");
  const username = message.from?.username || null;
  const firstName = message.from?.first_name || null;

  // グループ登録
  await sql`
    INSERT INTO telegram_groups (
      chat_id,
      title,
      created_at,
      updated_at
    )
    VALUES (
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
      INSERT INTO group_members (
        chat_id,
        telegram_user_id,
        username,
        first_name,
        joined_at,
        updated_at
      )
      VALUES (
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
// 表示名
// ==============================
function getDisplayName(member) {
  if (member.first_name) {
    return member.first_name;
  }

  if (member.username) {
    return `@${member.username}`;
  }

  return `ユーザー${member.telegram_user_id}`;
}

// ==============================
// 円・時間の表示
// ==============================
function formatYen(value) {
  return `${Number(value || 0).toLocaleString("ja-JP")}円`;
}

function formatHours(value) {
  return `${Number(value || 0).toLocaleString("ja-JP", {
    maximumFractionDigits: 2,
  })}時間`;
}

// ==============================
// Webhook
// ==============================
module.exports = async (req, res) => {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({
        ok: false,
        error: "Method Not Allowed",
      });
    }

    const update = req.body || {};

    const message = update.message;
    const callbackQuery = update.callback_query;

    // ==============================
    // Chat / User
    // ==============================
    const telegramUserId = getTelegramUserId(update);
    const chatId = getChatId(update);

    const chatType =
      message?.chat?.type ??
      callbackQuery?.message?.chat?.type ??
      "";

    // ==============================
    // グループなら登録
    // ==============================
    if (message) {
      await registerGroupAndMember(message);
    }

    // ==============================
    // New Chat Members
    // ==============================
    if (message?.new_chat_members) {
      for (const member of message.new_chat_members) {
        if (!message.chat) continue;

        if (!isGroupChat(message.chat.type)) continue;

        const groupChatId = String(message.chat.id);

        await sql`
          INSERT INTO telegram_groups (
            chat_id,
            title,
            created_at,
            updated_at
          )
          VALUES (
            ${groupChatId},
            ${message.chat.title || ""},
            NOW(),
            NOW()
          )
          ON CONFLICT (chat_id)
          DO UPDATE SET
            title = EXCLUDED.title,
            updated_at = NOW()
        `;

        await sql`
          INSERT INTO group_members (
            chat_id,
            telegram_user_id,
            username,
            first_name,
            joined_at,
            updated_at
          )
          VALUES (
            ${groupChatId},
            ${String(member.id)},
            ${member.username || null},
            ${member.first_name || null},
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
    // Callback Query
    // ==============================
    if (callbackQuery) {
      const callbackData = callbackQuery.data || "";

      await telegram("answerCallbackQuery", {
        callback_query_id: callbackQuery.id,
      });

      // ------------------------------
      // CANCEL
      // ------------------------------
      if (callbackData === "cancel") {
        await sql`
          DELETE FROM delivery_results
          WHERE telegram_user_id = ${telegramUserId}
        `;

        await telegram("sendMessage", {
          chat_id: chatId,
          text: "❌ 登録データを削除しました。",
        });

        return res.status(200).json({
          ok: true,
        });
      }

      // ------------------------------
      // RESET
      // ------------------------------
      if (callbackData === "reset") {
        await sql`
          DELETE FROM delivery_results
          WHERE telegram_user_id = ${telegramUserId}
        `;

        await telegram("sendMessage", {
          chat_id: chatId,
          text: "♻️ 実績をリセットしました。",
        });

        return res.status(200).json({
          ok: true,
        });
      }

      return res.status(200).json({
        ok: true,
      });
    }

    // ==============================
    // Messageがない場合
    // ==============================
    if (!message) {
      return res.status(200).json({
        ok: true,
      });
    }

    const text = (message.text || "").trim();

    // ==============================
    // /start
    // ==============================
    if (text === "/start") {
      await telegram("sendMessage", {
        chat_id: chatId,
        text:
          "🚚 配達リザルトBot\n\n" +
          "配達実績を登録・確認できます。\n\n" +
          "📝 実績登録：/add\n" +
          "❌ キャンセル：/cancel\n" +
          "♻️ リセット：/reset\n" +
          "🎯 月間目標：/goal\n" +
          "📊 グループ集計：/group\n" +
          "❓ ヘルプ：/help",
      });

      return res.status(200).json({
        ok: true,
      });
    }

    // ==============================
    // /help
    // ==============================
    if (text === "/help") {
      await telegram("sendMessage", {
        chat_id: chatId,
        text:
          "❓ 使い方\n\n" +
          "/add\n" +
          "配達実績を登録します。\n\n" +
          "/cancel\n" +
          "直前の登録をキャンセルします。\n\n" +
          "/reset\n" +
          "自分の実績をリセットします。\n\n" +
          "/goal\n" +
          "月間売上目標を設定します。\n\n" +
          "/group\n" +
          "グループ全体とメンバー別の今月実績を表示します。",
      });

      return res.status(200).json({
        ok: true,
      });
    }

    // ==============================
    // /group
    // ==============================
    if (text === "/group") {
      // グループ以外では使用不可
      if (!isGroupChat(chatType)) {
        await telegram("sendMessage", {
          chat_id: chatId,
          text:
            "⚠️ /group はグループ内で使用してください。",
        });

        return res.status(200).json({
          ok: true,
        });
      }

      // ============================
      // グループ全体集計
      // ============================
      const groupSummary = await sql`
        SELECT
          COALESCE(SUM(sale_amount), 0) AS total_sales,
          COALESCE(SUM(delivery_count), 0) AS total_deliveries,
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

      // ============================
      // メンバー別集計
      // ============================
      const memberResults = await sql`
        SELECT
          dr.telegram_user_id,
          COALESCE(
            gm.first_name,
            gm.username,
            'ユーザー'
          ) AS display_name,
          gm.username,
          COALESCE(SUM(dr.sale_amount), 0) AS total_sales,
          COALESCE(SUM(dr.delivery_count), 0) AS total_deliveries,
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
          gm.first_name,
          gm.username
        ORDER BY
          total_sales DESC
      `;

      const summary = groupSummary[0];

      let responseText =
        `📊 ${message.chat.title || "グループ"}\n\n` +
        `今月のグループ実績\n\n` +
        `💰 売上：${formatYen(summary.total_sales)}\n` +
        `📦 件数：${Number(summary.total_deliveries).toLocaleString("ja-JP")}件\n` +
        `⏱ 稼働時間：${formatHours(summary.total_hours)}\n` +
        `👥 実績登録者：${Number(summary.member_count)}人`;

      // ============================
      // メンバー別
      // ============================
      if (memberResults.length > 0) {
        responseText += "\n\n👤 メンバー別実績\n";

        for (const member of memberResults) {
          let name = member.display_name || "ユーザー";

          if (
            name === "ユーザー" &&
            member.username
          ) {
            name = `@${member.username}`;
          }

          responseText +=
            `\n${name}\n` +
            `💰 ${formatYen(member.total_sales)} / ` +
            `📦 ${Number(member.total_deliveries).toLocaleString("ja-JP")}件 / ` +
            `⏱ ${formatHours(member.total_hours)}\n`;
        }
      } else {
        responseText +=
          "\n\n👤 メンバー別実績\n\n" +
          "まだ実績登録がありません。";
      }

      await telegram("sendMessage", {
        chat_id: chatId,
        text: responseText,
      });

      return res.status(200).json({
        ok: true,
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
        text: "♻️ あなたの実績をリセットしました。",
      });

      return res.status(200).json({
        ok: true,
      });
    }

    // ==============================
    // /cancel
    // ==============================
    if (text === "/cancel") {
      const deleted = await sql`
        DELETE FROM delivery_results
        WHERE id = (
          SELECT id
          FROM delivery_results
          WHERE telegram_user_id = ${telegramUserId}
          ORDER BY created_at DESC
          LIMIT 1
        )
        RETURNING id
      `;

      if (deleted.length === 0) {
        await telegram("sendMessage", {
          chat_id: chatId,
          text: "❌ キャンセルできる実績がありません。",
        });
      } else {
        await telegram("sendMessage", {
          chat_id: chatId,
          text: "❌ 直前の実績をキャンセルしました。",
        });
      }

      return res.status(200).json({
        ok: true,
      });
    }

    // ==============================
    // /goal
    // ==============================
    if (text.startsWith("/goal")) {
      const parts = text.split(/\s+/);

      if (parts.length === 1) {
        const rows = await sql`
          SELECT monthly_goal
          FROM delivery_goals
          WHERE telegram_user_id = ${telegramUserId}
        `;

        if (rows.length === 0) {
          await telegram("sendMessage", {
            chat_id: chatId,
            text:
              "🎯 月間目標はまだ設定されていません。\n\n" +
              "/goal 300000\n\n" +
              "のように入力してください。",
          });
        } else {
          await telegram("sendMessage", {
            chat_id: chatId,
            text:
              `🎯 月間売上目標：${formatYen(
                rows[0].monthly_goal
              )}`,
          });
        }

        return res.status(200).json({
          ok: true,
        });
      }

      const goal = Number(parts[1]);

      if (!Number.isInteger(goal) || goal <= 0) {
        await telegram("sendMessage", {
          chat_id: chatId,
          text:
            "⚠️ 正しい金額を入力してください。\n\n" +
            "例：/goal 300000",
        });

        return res.status(200).json({
          ok: true,
        });
      }

      await sql`
        INSERT INTO delivery_goals (
          telegram_user_id,
          monthly_goal,
          updated_at
        )
        VALUES (
          ${telegramUserId},
          ${goal},
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
          `🎯 月間売上目標を ${formatYen(goal)} に設定しました。`,
      });

      return res.status(200).json({
        ok: true,
      });
    }

    // ==============================
    // /add
    // ==============================
    if (text.startsWith("/add")) {
      const parts = text.split(/\s+/);

      if (parts.length !== 4) {
        await telegram("sendMessage", {
          chat_id: chatId,
          text:
            "📝 実績登録\n\n" +
            "/add 売上 件数 時間\n\n" +
            "例：\n" +
            "/add 20000 30 10",
        });

        return res.status(200).json({
          ok: true,
        });
      }

      const sale = Number(parts[1]);
      const count = Number(parts[2]);
      const hours = Number(parts[3]);

      if (
        !Number.isInteger(sale) ||
        sale < 0 ||
        !Number.isInteger(count) ||
        count < 0 ||
        !Number.isFinite(hours) ||
        hours < 0
      ) {
        await telegram("sendMessage", {
          chat_id: chatId,
          text:
            "⚠️ 入力値を確認してください。\n\n" +
            "例：/add 20000 30 10",
        });

        return res.status(200).json({
          ok: true,
        });
      }

      await sql`
        INSERT INTO delivery_results (
          telegram_user_id,
          sale_amount,
          delivery_count,
          work_hours,
          chat_id
        )
        VALUES (
          ${telegramUserId},
          ${sale},
          ${count},
          ${hours},
          ${chatId}
        )
      `;

      await telegram("sendMessage", {
        chat_id: chatId,
        text:
          "✅ 実績を登録しました。\n\n" +
          `💰 売上：${formatYen(sale)}\n` +
          `📦 件数：${count}件\n` +
          `⏱ 稼働時間：${hours}時間`,
      });

      return res.status(200).json({
        ok: true,
      });
    }

    // ==============================
    // 未知のコマンド
    // ==============================
    if (text.startsWith("/")) {
      await telegram("sendMessage", {
        chat_id: chatId,
        text:
          "❓ コマンドが分かりません。\n\n" +
          "/help で使い方を確認できます。",
      });

      return res.status(200).json({
        ok: true,
      });
    }

    return res.status(200).json({
      ok: true,
    });
  } catch (error) {
    console.error("bot error:", error);

    return res.status(500).json({
      ok: false,
      error: "Internal Server Error",
    });
  }
};

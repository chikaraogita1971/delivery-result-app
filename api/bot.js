import { neon } from "@neondatabase/serverless";

const sql = neon(process.env.POSTGRES_URL);

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(200).send("Telegram Bot is running");
  }

  try {
    const update = req.body;

    const message = update?.message;
    const callbackQuery = update?.callback_query;

    // ============================================================
    // Telegramユーザー本人のID
    // ============================================================

    const telegramUserId = String(
      message?.from?.id ??
      callbackQuery?.from?.id ??
      ""
    );

    // ============================================================
    // 返信先チャットID
    // ============================================================

    const chatId = String(
      message?.chat?.id ??
      callbackQuery?.message?.chat?.id ??
      ""
    );

    // ユーザーIDまたはチャットIDが取得できない更新は無視
    if (!telegramUserId || !chatId) {
      return res.status(200).send("OK");
    }

    const telegramApiBase =
      `https://api.telegram.org/bot${process.env.BOT_TOKEN}`;

    // ============================================================
    // Telegram API 共通処理
    // ============================================================

    async function telegramRequest(method, body) {
      const response = await fetch(
        `${telegramApiBase}/${method}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify(body)
        }
      );

      const data = await response.json();

      if (!data.ok) {
        console.error(
          `Telegram API error: ${method}`,
          data
        );
      }

      return data;
    }

    // ============================================================
    // メッセージ送信
    // ============================================================

    async function reply(text, extra = {}) {
      return telegramRequest("sendMessage", {
        chat_id: chatId,
        text,
        ...extra
      });
    }

    // ============================================================
    // Callback Queryに回答
    // ============================================================

    async function answerCallbackQuery(
      callbackQueryId,
      text = ""
    ) {
      return telegramRequest("answerCallbackQuery", {
        callback_query_id: callbackQueryId,
        text
      });
    }

    // ============================================================
    // メッセージ本文を編集
    // ============================================================

    async function editMessageText(
      callbackMessage,
      text,
      extra = {}
    ) {
      return telegramRequest("editMessageText", {
        chat_id: callbackMessage.chat.id,
        message_id: callbackMessage.message_id,
        text,
        ...extra
      });
    }

    // ============================================================
    // グループ判定
    // ============================================================

    const messageChatType =
      message?.chat?.type ??
      callbackQuery?.message?.chat?.type ??
      "";

    const isGroup =
      messageChatType === "group" ||
      messageChatType === "supergroup";

    // ============================================================
    // グループ情報・メンバー情報をDBへ登録
    // ============================================================

    async function registerGroupAndMember() {
      if (!isGroup) {
        return;
      }

      const groupChatId = chatId;

      const groupTitle =
        message?.chat?.title ??
        callbackQuery?.message?.chat?.title ??
        "";

      const username =
        message?.from?.username ??
        callbackQuery?.from?.username ??
        null;

      const firstName =
        message?.from?.first_name ??
        callbackQuery?.from?.first_name ??
        "";

      // ----------------------------------------------------------
      // グループ登録
      // ----------------------------------------------------------

      await sql`
        INSERT INTO telegram_groups
          (
            chat_id,
            title
          )
        VALUES
          (
            ${groupChatId},
            ${groupTitle}
          )
        ON CONFLICT (chat_id)
        DO UPDATE SET
          title = EXCLUDED.title,
          updated_at = NOW()
      `;

      // ----------------------------------------------------------
      // メンバー登録
      // ----------------------------------------------------------

      await sql`
        INSERT INTO group_members
          (
            chat_id,
            telegram_user_id,
            username,
            first_name
          )
        VALUES
          (
            ${groupChatId},
            ${telegramUserId},
            ${username},
            ${firstName}
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

    // ============================================================
    // グループ情報を登録
    // ============================================================

    await registerGroupAndMember();

    // ============================================================
    // 新しくグループへ追加されたメンバーを登録
    // ============================================================

    if (
      isGroup &&
      Array.isArray(message?.new_chat_members)
    ) {
      for (
        const newMember
        of message.new_chat_members
      ) {
        if (!newMember?.id) {
          continue;
        }

        await sql`
          INSERT INTO group_members
            (
              chat_id,
              telegram_user_id,
              username,
              first_name
            )
          VALUES
            (
              ${chatId},
              ${String(newMember.id)},
              ${newMember.username ?? null},
              ${newMember.first_name ?? ""}
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

    // ============================================================
    // Telegram コマンドメニュー
    // ============================================================

    async function setCommands() {
      return telegramRequest("setMyCommands", {
        commands: [
          {
            command: "start",
            description: "スタート画面"
          },
          {
            command: "add",
            description: "配達実績を追加"
          },
          {
            command: "cancel",
            description: "最後の入力を取り消し"
          },
          {
            command: "reset",
            description: "実績をすべてリセット"
          },
          {
            command: "goal",
            description: "月間目標を設定"
          },
          {
            command: "help",
            description: "コマンド一覧"
          }
        ]
      });
    }

    /*
    ============================================================
    Callback Query処理
    ============================================================
    */

    if (callbackQuery) {
      const callbackData =
        callbackQuery.data || "";

      /*
      ------------------------------------------------------------
      /cancel
      「取り消さない」
      ------------------------------------------------------------
      */

      if (
        callbackData.startsWith(
          "cancel_abort:"
        )
      ) {
        const ownerId =
          callbackData.split(":")[1];

        // ボタンを押した本人だけ操作可能
        if (
          String(callbackQuery.from?.id) !==
          String(ownerId)
        ) {
          await answerCallbackQuery(
            callbackQuery.id,
            "この操作は本人のみ実行できます。"
          );

          return res.status(200).send("OK");
        }

        await answerCallbackQuery(
          callbackQuery.id,
          "取り消しませんでした。"
        );

        await editMessageText(
          callbackQuery.message,
          "↩️ 取り消しませんでした。"
        );

        return res.status(200).send("OK");
      }

      /*
      ------------------------------------------------------------
      /cancel
      「取り消す」
      ------------------------------------------------------------
      */

      if (
        callbackData.startsWith(
          "cancel_confirm:"
        )
      ) {
        const parts =
          callbackData.split(":");

        const recordId =
          Number(parts[1]);

        const ownerId =
          parts[2];

        // ボタンを押した本人だけ操作可能
        if (
          String(callbackQuery.from?.id) !==
          String(ownerId)
        ) {
          await answerCallbackQuery(
            callbackQuery.id,
            "この操作は本人のみ実行できます。"
          );

          return res.status(200).send("OK");
        }

        // IDが不正なら処理しない
        if (
          !Number.isInteger(recordId) ||
          recordId <= 0
        ) {
          await answerCallbackQuery(
            callbackQuery.id,
            "無効な記録です。"
          );

          return res.status(200).send("OK");
        }

        /*
        ----------------------------------------------------------
        重要：
        IDだけでは削除しない。
        必ず telegram_user_id も一致させる。
        ----------------------------------------------------------
        */

        const deletedRows = await sql`
          DELETE FROM delivery_results
          WHERE id = ${recordId}
            AND telegram_user_id = ${telegramUserId}
          RETURNING
            sale_amount,
            delivery_count,
            work_hours
        `;

        /*
        ----------------------------------------------------------
        すでに削除済み / 他ユーザーの記録だった場合
        ----------------------------------------------------------
        */

        if (deletedRows.length === 0) {
          await answerCallbackQuery(
            callbackQuery.id,
            "この記録は取り消せません。"
          );

          await editMessageText(
            callbackQuery.message,
            "⚠️ この記録はすでに削除されているか、\n" +
            "取り消せない状態です。"
          );

          return res.status(200).send("OK");
        }

        const deleted =
          deletedRows[0];

        await answerCallbackQuery(
          callbackQuery.id,
          "取り消しました。"
        );

        await editMessageText(
          callbackQuery.message,
          `↩️ 記録を取り消しました。\n\n` +
          `売上：${Number(
            deleted.sale_amount
          ).toLocaleString()}円\n` +
          `件数：${deleted.delivery_count}件\n` +
          `時間：${deleted.work_hours}時間`
        );

        return res.status(200).send("OK");
      }

      /*
      ------------------------------------------------------------
      /reset
      「リセットしない」
      ------------------------------------------------------------
      */

      if (
        callbackData.startsWith(
          "reset_abort:"
        )
      ) {
        const ownerId =
          callbackData.split(":")[1];

        // ボタンを押した本人だけ操作可能
        if (
          String(callbackQuery.from?.id) !==
          String(ownerId)
        ) {
          await answerCallbackQuery(
            callbackQuery.id,
            "この操作は本人のみ実行できます。"
          );

          return res.status(200).send("OK");
        }

        await answerCallbackQuery(
          callbackQuery.id,
          "リセットしませんでした。"
        );

        await editMessageText(
          callbackQuery.message,
          "↩️ リセットをキャンセルしました。"
        );

        return res.status(200).send("OK");
      }

      /*
      ------------------------------------------------------------
      /reset
      「すべての実績を削除」
      ------------------------------------------------------------
      */

      if (
        callbackData.startsWith(
          "reset_confirm:"
        )
      ) {
        const ownerId =
          callbackData.split(":")[1];

        // ボタンを押した本人だけ操作可能
        if (
          String(callbackQuery.from?.id) !==
          String(ownerId)
        ) {
          await answerCallbackQuery(
            callbackQuery.id,
            "この操作は本人のみ実行できます。"
          );

          return res.status(200).send("OK");
        }

        /*
        ----------------------------------------------------------
        重要：
        必ずボタンを押した本人の
        telegram_user_id のみ削除する。
        ----------------------------------------------------------
        */

        const deletedRows = await sql`
          DELETE FROM delivery_results
          WHERE telegram_user_id = ${telegramUserId}
          RETURNING id
        `;

        const deletedCount =
          deletedRows.length;

        await answerCallbackQuery(
          callbackQuery.id,
          "実績をリセットしました。"
        );

        if (deletedCount === 0) {
          await editMessageText(
            callbackQuery.message,
            "📭 リセットする実績はありませんでした。"
          );
        } else {
          await editMessageText(
            callbackQuery.message,
            `🗑️ 実績をリセットしました。\n\n` +
            `${deletedCount}件の実績を削除しました。\n\n` +
            `※ 月間目標はそのまま残っています。`
          );
        }

        return res.status(200).send("OK");
      }

      /*
      ------------------------------------------------------------
      未知のCallback Query
      ------------------------------------------------------------
      */

      await answerCallbackQuery(
        callbackQuery.id,
        "この操作は無効です。"
      );

      return res.status(200).send("OK");
    }

    /*
    ============================================================
    通常のメッセージ処理
    ============================================================
    */

    if (!message?.text) {
      return res.status(200).send("OK");
    }

    const text =
      message.text.trim();

    /*
    ============================================================
    /start
    ============================================================
    */

    if (text === "/start") {
      await setCommands();

      const goalRows = await sql`
        SELECT monthly_goal
        FROM delivery_goals
        WHERE telegram_user_id = ${telegramUserId}
      `;

      /*
      ------------------------------------------------------------
      JST基準の今月集計
      ------------------------------------------------------------
      */

      const resultRows = await sql`
        SELECT
          COALESCE(SUM(sale_amount), 0) AS sales,
          COALESCE(SUM(delivery_count), 0) AS count,
          COALESCE(SUM(work_hours), 0) AS hours
        FROM delivery_results
        WHERE telegram_user_id = ${telegramUserId}
          AND created_at >= (
            date_trunc(
              'month',
              CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Tokyo'
            ) AT TIME ZONE 'Asia/Tokyo'
          )
          AND created_at < (
            (
              date_trunc(
                'month',
                CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Tokyo'
              ) + INTERVAL '1 month'
            ) AT TIME ZONE 'Asia/Tokyo'
          )
      `;

      const goal =
        goalRows[0]?.monthly_goal ?? 0;

      const sales =
        Number(resultRows[0]?.sales ?? 0);

      const count =
        Number(resultRows[0]?.count ?? 0);

      const hours =
        Number(resultRows[0]?.hours ?? 0);

      await reply(
        `📋 配達リザルト\n\n` +
        `今月の売上：${sales.toLocaleString()}円\n` +
        `件数：${count}件\n` +
        `稼働時間：${hours}時間\n` +
        `月間目標：${Number(
          goal
        ).toLocaleString()}円\n\n` +
        `実績追加：/add 売上 件数 時間\n` +
        `目標設定：/goal 金額\n` +
        `取り消し：/cancel\n` +
        `全実績リセット：/reset\n` +
        `ヘルプ：/help`
      );

      return res.status(200).send("OK");
    }

    /*
    ============================================================
    /help
    ============================================================
    */

    if (text === "/help") {
      await reply(
        `📋 配達リザルト コマンド\n\n` +

        `/start\n` +
        `スタート画面\n\n` +

        `/add 売上 件数 時間\n` +
        `当日の実績を追加\n` +
        `例：/add 15000 25 8\n\n` +

        `/cancel\n` +
        `最後の入力を取り消し\n\n` +

        `/reset\n` +
        `自分の実績をすべてリセット\n` +
        `※ 月間目標は残ります\n\n` +

        `/goal 金額\n` +
        `月間目標を設定・変更\n` +
        `例：/goal 300000\n` +
        `目標なしにする場合：/goal 0\n\n` +

        `/help\n` +
        `コマンド一覧`
      );

      return res.status(200).send("OK");
    }

    /*
    ============================================================
    /add 売上 件数 時間
    ============================================================
    */

    if (text.startsWith("/add")) {
      const parts =
        text.split(/\s+/);

      if (parts.length !== 4) {
        await reply(
          "使い方：/add 売上 件数 時間\n" +
          "例：/add 15000 25 8"
        );

        return res.status(200).send("OK");
      }

      const sale =
        Number(parts[1]);

      const count =
        Number(parts[2]);

      const hours =
        Number(parts[3]);

      // 異常値対策
      if (
        !Number.isInteger(sale) ||
        sale < 0 ||
        sale > 1000000 ||

        !Number.isInteger(count) ||
        count < 0 ||
        count > 500 ||

        !Number.isFinite(hours) ||
        hours < 0 ||
        hours > 24
      ) {
        await reply(
          "入力値を確認してください。\n\n" +
          "売上：0〜1,000,000円\n" +
          "件数：0〜500件\n" +
          "時間：0〜24時間\n\n" +
          "例：/add 15000 25 8"
        );

        return res.status(200).send("OK");
      }

      await sql`
        INSERT INTO delivery_results
          (
            telegram_user_id,
            sale_amount,
            delivery_count,
            work_hours
          )
        VALUES
          (
            ${telegramUserId},
            ${sale},
            ${count},
            ${hours}
          )
      `;

      await reply(
        `✅ 実績を追加しました。\n\n` +
        `売上：${sale.toLocaleString()}円\n` +
        `件数：${count}件\n` +
        `時間：${hours}時間`
      );

      return res.status(200).send("OK");
    }

    /*
    ============================================================
    /cancel
    ============================================================
    */

    if (text === "/cancel") {
      const rows = await sql`
        SELECT
          id,
          sale_amount,
          delivery_count,
          work_hours
        FROM delivery_results
        WHERE telegram_user_id = ${telegramUserId}
        ORDER BY created_at DESC, id DESC
        LIMIT 1
      `;

      if (rows.length === 0) {
        await reply(
          "取り消せる実績がありません。"
        );

        return res.status(200).send("OK");
      }

      const last =
        rows[0];

      /*
      ------------------------------------------------------------
      すぐには削除しない。
      確認ボタンを表示する。
      ------------------------------------------------------------
      */

      await reply(
        `↩️ 最後の記録\n\n` +
        `売上：${Number(
          last.sale_amount
        ).toLocaleString()}円\n` +
        `件数：${last.delivery_count}件\n` +
        `時間：${last.work_hours}時間\n\n` +
        `この記録を取り消しますか？`,
        {
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "❌ 取り消さない",
                  callback_data:
                    `cancel_abort:${telegramUserId}`
                },
                {
                  text: "↩️ 取り消す",
                  callback_data:
                    `cancel_confirm:${last.id}:${telegramUserId}`
                }
              ]
            ]
          }
        }
      );

      return res.status(200).send("OK");
    }

    /*
    ============================================================
    /reset
    ============================================================
    */

    if (text === "/reset") {
      const countRows = await sql`
        SELECT COUNT(*) AS count
        FROM delivery_results
        WHERE telegram_user_id = ${telegramUserId}
      `;

      const recordCount =
        Number(
          countRows[0]?.count ?? 0
        );

      if (recordCount === 0) {
        await reply(
          "📭 リセットする実績がありません。"
        );

        return res.status(200).send("OK");
      }

      /*
      ------------------------------------------------------------
      すぐには削除しない。
      必ず確認ボタンを表示する。
      ------------------------------------------------------------
      */

      await reply(
        `⚠️ 実績リセット\n\n` +
        `現在 ${recordCount}件の実績があります。\n\n` +
        `このユーザーの実績をすべて削除します。\n` +
        `この操作は取り消せません。\n\n` +
        `※ 月間目標は削除されません。\n\n` +
        `本当にリセットしますか？`,
        {
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "❌ キャンセル",
                  callback_data:
                    `reset_abort:${telegramUserId}`
                },
                {
                  text: "🗑️ 全実績を削除",
                  callback_data:
                    `reset_confirm:${telegramUserId}`
                }
              ]
            ]
          }
        }
      );

      return res.status(200).send("OK");
    }

    /*
    ============================================================
    /goal 金額
    ============================================================
    */

    if (text.startsWith("/goal")) {
      const parts =
        text.split(/\s+/);

      if (parts.length !== 2) {
        await reply(
          "使い方：/goal 金額\n" +
          "例：/goal 300000\n" +
          "目標なしにする場合：/goal 0"
        );

        return res.status(200).send("OK");
      }

      const goal =
        Number(parts[1]);

      // 0円以上を許可
      if (
        !Number.isInteger(goal) ||
        goal < 0
      ) {
        await reply(
          "目標金額は0円以上の整数で入力してください。"
        );

        return res.status(200).send("OK");
      }

      await sql`
        INSERT INTO delivery_goals
          (
            telegram_user_id,
            monthly_goal
          )
        VALUES
          (
            ${telegramUserId},
            ${goal}
          )
        ON CONFLICT (telegram_user_id)
        DO UPDATE SET
          monthly_goal = EXCLUDED.monthly_goal,
          updated_at = NOW()
      `;

      if (goal === 0) {
        await reply(
          `🎯 月間目標を0円にしました。\n` +
          `目標なしの状態です。`
        );
      } else {
        await reply(
          `🎯 月間目標を${goal.toLocaleString()}円に設定しました。`
        );
      }

      return res.status(200).send("OK");
    }

    /*
    ============================================================
    未知のコマンド
    ============================================================
    */

    await reply(
      "認識できないコマンドです。\n" +
      "/help でコマンド一覧を確認できます。"
    );

    return res.status(200).send("OK");

  } catch (error) {
    console.error(
      "Telegram Bot error:",
      error
    );

    return res
      .status(500)
      .send("Internal Server Error");
  }
}


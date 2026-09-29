import { neon } from "@neondatabase/serverless";

const sql = neon(process.env.POSTGRES_URL);

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(200).send("Telegram Bot is running");
  }

  try {
    const update = req.body;
    const message = update?.message;

    if (!message?.text || !message?.chat?.id) {
      return res.status(200).send("OK");
    }

    const chatId = String(message.chat.id);
    const text = message.text.trim();

    const telegramUrl = `https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendMessage`;

    async function reply(text) {
      await fetch(telegramUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          chat_id: chatId,
          text
        })
      });
    }

    // /start
    if (text === "/start") {
      const goalRows = await sql`
        SELECT monthly_goal
        FROM delivery_goals
        WHERE telegram_user_id = ${chatId}
      `;

      const resultRows = await sql`
        SELECT
          COALESCE(SUM(sale_amount), 0) AS sales,
          COALESCE(SUM(delivery_count), 0) AS count,
          COALESCE(SUM(work_hours), 0) AS hours
        FROM delivery_results
        WHERE telegram_user_id = ${chatId}
          AND created_at >= date_trunc('month', CURRENT_DATE)
          AND created_at < date_trunc('month', CURRENT_DATE) + INTERVAL '1 month'
      `;

      const goal = goalRows[0]?.monthly_goal ?? 0;
      const sales = Number(resultRows[0]?.sales ?? 0);
      const count = Number(resultRows[0]?.count ?? 0);
      const hours = Number(resultRows[0]?.hours ?? 0);

      await reply(
        `📋 配達リザルト\n\n` +
        `今月の売上：${sales.toLocaleString()}円\n` +
        `件数：${count}件\n` +
        `稼働時間：${hours}時間\n` +
        `月間目標：${goal.toLocaleString()}円\n\n` +
        `実績追加：/add 売上 件数 時間\n` +
        `目標設定：/goal 金額\n` +
        `取り消し：/cancel\n` +
        `ヘルプ：/help`
      );

      return res.status(200).send("OK");
    }

    // /help
    if (text === "/help") {
      await reply(
        `📋 配達リザルト コマンド\n\n` +
        `/start\nスタート画面\n\n` +
        `/add 売上 件数 時間\n当日の実績を追加\n例：/add 15000 25 8\n\n` +
        `/cancel\n最後の入力を取り消し\n\n` +
        `/goal 金額\n月間目標を設定・変更\n例：/goal 300000\n\n` +
        `/help\nコマンド一覧`
      );

      return res.status(200).send("OK");
    }

    // /add 売上 件数 時間
    if (text.startsWith("/add")) {
      const parts = text.split(/\s+/);

      if (parts.length !== 4) {
        await reply("使い方：/add 売上 件数 時間\n例：/add 15000 25 8");
        return res.status(200).send("OK");
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
        await reply("入力値を確認してください。\n例：/add 15000 25 8");
        return res.status(200).send("OK");
      }

      await sql`
        INSERT INTO delivery_results
          (telegram_user_id, sale_amount, delivery_count, work_hours)
        VALUES
          (${chatId}, ${sale}, ${count}, ${hours})
      `;

      await reply(
        `✅ 実績を追加しました。\n\n` +
        `売上：${sale.toLocaleString()}円\n` +
        `件数：${count}件\n` +
        `時間：${hours}時間`
      );

      return res.status(200).send("OK");
    }

    // /cancel
    if (text === "/cancel") {
      const rows = await sql`
        SELECT id, sale_amount, delivery_count, work_hours
        FROM delivery_results
        WHERE telegram_user_id = ${chatId}
        ORDER BY created_at DESC, id DESC
        LIMIT 1
      `;

      if (rows.length === 0) {
        await reply("取り消せる実績がありません。");
        return res.status(200).send("OK");
      }

      const last = rows[0];

      await sql`
        DELETE FROM delivery_results
        WHERE id = ${last.id}
          AND telegram_user_id = ${chatId}
      `;

      await reply(
        `↩️ 最後の入力を取り消しました。\n\n` +
        `売上：${Number(last.sale_amount).toLocaleString()}円\n` +
        `件数：${last.delivery_count}件\n` +
        `時間：${last.work_hours}時間`
      );

      return res.status(200).send("OK");
    }

    // /goal 金額
    if (text.startsWith("/goal")) {
      const parts = text.split(/\s+/);

      if (parts.length !== 2) {
        await reply("使い方：/goal 金額\n例：/goal 300000");
        return res.status(200).send("OK");
      }

      const goal = Number(parts[1]);

      if (!Number.isInteger(goal) || goal <= 0) {
        await reply("目標金額は1円以上の整数で入力してください。");
        return res.status(200).send("OK");
      }

      await sql`
        INSERT INTO delivery_goals (telegram_user_id, monthly_goal)
        VALUES (${chatId}, ${goal})
        ON CONFLICT (telegram_user_id)
        DO UPDATE SET
          monthly_goal = EXCLUDED.monthly_goal,
          updated_at = NOW()
      `;

      await reply(`🎯 月間目標を${goal.toLocaleString()}円に設定しました。`);

      return res.status(200).send("OK");
    }

    await reply("認識できないコマンドです。\n/help でコマンド一覧を確認できます。");

    return res.status(200).send("OK");
  } catch (error) {
    console.error("Telegram Bot error:", error);
    return res.status(500).send("Internal Server Error");
  }
}

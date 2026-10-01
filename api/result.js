const { neon } = require("@neondatabase/serverless");

const sql = neon(process.env.DATABASE_URL);

// =========================================================
// Telegram initData 検証
// =========================================================

const BOT_TOKEN = process.env.BOT_TOKEN;

function parseInitData(initData) {
  const params = new URLSearchParams(
    String(initData || "")
  );

  const userRaw = params.get("user");

  if (!userRaw) {
    return null;
  }

  try {
    return JSON.parse(userRaw);
  } catch {
    return null;
  }
}

function getTelegramUserId(req) {
  const initData =
    req.headers["x-telegram-init-data"] ||
    "";

  const user =
    parseInitData(initData);

  if (!user?.id) {
    return null;
  }

  return String(user.id);
}

// =========================================================
// 表示用
// =========================================================

function formatNumber(value) {
  return Number(value || 0)
    .toLocaleString("ja-JP");
}

function formatHours(value) {
  return Number(value || 0)
    .toFixed(1);
}

function formatYen(value) {
  return `¥${formatNumber(
    Math.round(Number(value || 0))
  )}`;
}

// =========================================================
// 期間
// =========================================================

function getPeriodRange(period) {
  const now = new Date();

  const formatter =
    new Intl.DateTimeFormat(
      "ja-JP",
      {
        timeZone: "Asia/Tokyo",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }
    );

  const parts =
    formatter.formatToParts(now);

  const year =
    Number(
      parts.find(
        item => item.type === "year"
      )?.value
    );

  const month =
    Number(
      parts.find(
        item => item.type === "month"
      )?.value
    );

  const day =
    Number(
      parts.find(
        item => item.type === "day"
      )?.value
    );

  const today =
    new Date(
      Date.UTC(
        year,
        month - 1,
        day
      )
    );

  let start;
  let end;

  switch (period) {
    case "today": {
      start =
        new Date(today);

      end =
        new Date(today);

      end.setUTCDate(
        end.getUTCDate() + 1
      );

      break;
    }

    case "week": {
      start =
        new Date(today);

      const dayOfWeek =
        start.getUTCDay();

      const mondayOffset =
        dayOfWeek === 0
          ? -6
          : 1 - dayOfWeek;

      start.setUTCDate(
        start.getUTCDate() +
        mondayOffset
      );

      end =
        new Date(start);

      end.setUTCDate(
        end.getUTCDate() + 7
      );

      break;
    }

    case "month": {
      start =
        new Date(
          Date.UTC(
            year,
            month - 1,
            1
          )
        );

      end =
        new Date(
          Date.UTC(
            year,
            month,
            1
          )
        );

      break;
    }

    case "year": {
      start =
        new Date(
          Date.UTC(
            year,
            0,
            1
          )
        );

      end =
        new Date(
          Date.UTC(
            year + 1,
            0,
            1
          )
        );

      break;
    }

    default:
      return null;
  }

  return {
    start:
      start.toISOString(),
    end:
      end.toISOString(),
  };
}

// =========================================================
// 集計
// =========================================================

async function getStats(
  userId,
  start,
  end
) {
  const rows = await sql`
    SELECT
      COUNT(*) AS records,

      COALESCE(
        SUM(sale_amount),
        0
      ) AS sales,

      COALESCE(
        SUM(delivery_count),
        0
      ) AS delivery_count,

      COALESCE(
        SUM(work_hours),
        0
      ) AS work_hours

    FROM delivery_results

    WHERE telegram_user_id =
      ${userId}

      AND created_at >=
        ${start}

      AND created_at <
        ${end}
  `;

  const row =
    rows[0] || {};

  const records =
    Number(row.records || 0);

  const sales =
    Number(row.sales || 0);

  const deliveryCount =
    Number(
      row.delivery_count || 0
    );

  const workHours =
    Number(
      row.work_hours || 0
    );

  return {
    records,

    sales,

    deliveryCount,

    workHours,

    unitPrice:
      deliveryCount > 0
        ? sales / deliveryCount
        : 0,

    hourlySales:
      workHours > 0
        ? sales / workHours
        : 0,
  };
}

// =========================================================
// 最新履歴
// =========================================================

async function getRecentResults(
  userId
) {
  const rows = await sql`
    SELECT
      id,
      sale_amount,
      delivery_count,
      work_hours,
      created_at

    FROM delivery_results

    WHERE telegram_user_id =
      ${userId}

    ORDER BY
      created_at DESC,
      id DESC

    LIMIT 20
  `;

  return rows.map(row => {
    const sales =
      Number(
        row.sale_amount || 0
      );

    const deliveryCount =
      Number(
        row.delivery_count || 0
      );

    const workHours =
      Number(
        row.work_hours || 0
      );

    return {
      id:
        Number(row.id),

      saleAmount:
        sales,

      deliveryCount,

      workHours,

      unitPrice:
        deliveryCount > 0
          ? sales / deliveryCount
          : 0,

      hourlySales:
        workHours > 0
          ? sales / workHours
          : 0,

      createdAt:
        row.created_at,
    };
  });
}

// =========================================================
// 日別集計
// =========================================================

async function getDailyResults(
  userId,
  start,
  end
) {
  const rows = await sql`
    SELECT
      (
        created_at
        AT TIME ZONE
        'Asia/Tokyo'
      )::date AS result_date,

      COALESCE(
        SUM(sale_amount),
        0
      ) AS sales,

      COALESCE(
        SUM(delivery_count),
        0
      ) AS delivery_count,

      COALESCE(
        SUM(work_hours),
        0
      ) AS work_hours

    FROM delivery_results

    WHERE telegram_user_id =
      ${userId}

      AND created_at >=
        ${start}

      AND created_at <
        ${end}

    GROUP BY
      result_date

    ORDER BY
      result_date ASC
  `;

  return rows.map(row => {
    const sales =
      Number(row.sales || 0);

    const deliveryCount =
      Number(
        row.delivery_count || 0
      );

    const workHours =
      Number(
        row.work_hours || 0
      );

    return {
      date:
        String(row.result_date),

      sales,

      deliveryCount,

      workHours,

      unitPrice:
        deliveryCount > 0
          ? sales / deliveryCount
          : 0,

      hourlySales:
        workHours > 0
          ? sales / workHours
          : 0,
    };
  });
}

// =========================================================
// API
// =========================================================

module.exports =
  async function handler(
    req,
    res
  ) {
    if (req.method !== "GET") {
      return res.status(405).json({
        ok: false,
        error:
          "Method Not Allowed",
      });
    }

    try {
      // -----------------------------------------------------
      // Telegramユーザー認証
      // -----------------------------------------------------

      const userId =
        getTelegramUserId(req);

      if (!userId) {
        return res.status(401).json({
          ok: false,
          error:
            "Telegram認証が必要です。",
        });
      }

      // -----------------------------------------------------
      // 期間
      // -----------------------------------------------------

      const period =
        String(
          req.query?.period ||
          "today"
        ).toLowerCase();

      const range =
        getPeriodRange(period);

      if (!range) {
        return res.status(400).json({
          ok: false,
          error:
            "期間指定が正しくありません。",
        });
      }

      // -----------------------------------------------------
      // 集計
      // -----------------------------------------------------

      const stats =
        await getStats(
          userId,
          range.start,
          range.end
        );

      // -----------------------------------------------------
      // 履歴
      // -----------------------------------------------------

      const recentResults =
        await getRecentResults(
          userId
        );

      // -----------------------------------------------------
      // 日別
      // -----------------------------------------------------

      const daily =
        await getDailyResults(
          userId,
          range.start,
          range.end
        );

      // -----------------------------------------------------
      // レスポンス
      // -----------------------------------------------------

      return res.status(200).json({
        ok: true,

        period,

        range: {
          start:
            range.start,

          end:
            range.end,
        },

        stats: {
          records:
            stats.records,

          sales:
            stats.sales,

          deliveryCount:
            stats.deliveryCount,

          workHours:
            stats.workHours,

          unitPrice:
            stats.unitPrice,

          hourlySales:
            stats.hourlySales,
        },

        recentResults,

        daily,
      });

    } catch (error) {
      console.error(
        "[RESULT] API error:",
        {
          name:
            error?.name,

          message:
            error?.message,

          stack:
            error?.stack,
        }
      );

      return res.status(500).json({
        ok: false,
        error:
          "実績データの取得に失敗しました。",
      });
    }
  };

const { neon } = require("@neondatabase/serverless");

const sql = neon(process.env.DATABASE_URL);

// =========================================================
// Telegram認証
// =========================================================

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
// 期間計算
// =========================================================

function getJstTodayParts() {
  const now = new Date();

  const parts =
    new Intl.DateTimeFormat(
      "en-CA",
      {
        timeZone: "Asia/Tokyo",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }
    ).formatToParts(now);

  return {
    year: Number(
      parts.find(
        item => item.type === "year"
      )?.value
    ),

    month: Number(
      parts.find(
        item => item.type === "month"
      )?.value
    ),

    day: Number(
      parts.find(
        item => item.type === "day"
      )?.value
    ),
  };
}

function pad2(value) {
  return String(value).padStart(
    2,
    "0"
  );
}

function toJstDateString(
  year,
  month,
  day
) {
  return (
    `${year}-${pad2(month)}-${pad2(day)}`
  );
}

function jstDateToUtc(
  year,
  month,
  day
) {
  return new Date(
    `${toJstDateString(
      year,
      month,
      day
    )}T00:00:00+09:00`
  );
}

function getPeriodRange(
  period,
  requestedMonth,
  requestedYear
) {
  const today =
    getJstTodayParts();

  let year =
    today.year;

  let month =
    today.month;

  // -------------------------------------------------------
  // 指定月
  // -------------------------------------------------------

  if (
    period === "month" &&
    requestedMonth
  ) {
    const match =
      /^(\d{4})-(\d{1,2})$/.exec(
        String(requestedMonth)
      );

    if (!match) {
      return {
        error:
          "月の指定はYYYY-MM形式で指定してください。",
      };
    }

    year =
      Number(match[1]);

    month =
      Number(match[2]);

    if (
      month < 1 ||
      month > 12
    ) {
      return {
        error:
          "月の指定が正しくありません。",
      };
    }
  }

  // -------------------------------------------------------
  // 指定年
  // -------------------------------------------------------

  if (
    period === "year" &&
    requestedYear
  ) {
    const match =
      /^(\d{4})$/.exec(
        String(requestedYear)
      );

    if (!match) {
      return {
        error:
          "年の指定はYYYY形式で指定してください。",
      };
    }

    year =
      Number(match[1]);

    if (
      year < 2000 ||
      year > 2100
    ) {
      return {
        error:
          "年の指定が正しくありません。",
      };
    }
  }

  // -------------------------------------------------------
  // 今日
  // -------------------------------------------------------

  if (period === "today") {
    const start =
      jstDateToUtc(
        today.year,
        today.month,
        today.day
      );

    const end =
      new Date(start);

    end.setUTCDate(
      end.getUTCDate() + 1
    );

    return {
      start:
        start.toISOString(),

      end:
        end.toISOString(),

      label:
        toJstDateString(
          today.year,
          today.month,
          today.day
        ),
    };
  }

  // -------------------------------------------------------
  // 今週 / 指定週なし
  // 月曜始まり
  // -------------------------------------------------------

  if (
    period === "week"
  ) {
    const current =
      jstDateToUtc(
        today.year,
        today.month,
        today.day
      );

    const weekday =
      current.getUTCDay();

    const mondayOffset =
      weekday === 0
        ? -6
        : 1 - weekday;

    const start =
      new Date(current);

    start.setUTCDate(
      start.getUTCDate() +
      mondayOffset
    );

    const end =
      new Date(start);

    end.setUTCDate(
      end.getUTCDate() + 7
    );

    return {
      start:
        start.toISOString(),

      end:
        end.toISOString(),

      label:
        "今週",
    };
  }

  // -------------------------------------------------------
  // 月
  // -------------------------------------------------------

  if (
    period === "month"
  ) {
    const start =
      jstDateToUtc(
        year,
        month,
        1
      );

    const end =
      month === 12
        ? jstDateToUtc(
            year + 1,
            1,
            1
          )
        : jstDateToUtc(
            year,
            month + 1,
            1
          );

    return {
      start:
        start.toISOString(),

      end:
        end.toISOString(),

      label:
        `${year}-${pad2(month)}`,
    };
  }

  // -------------------------------------------------------
  // 年
  // -------------------------------------------------------

  if (
    period === "year"
  ) {
    const start =
      jstDateToUtc(
        year,
        1,
        1
      );

    const end =
      jstDateToUtc(
        year + 1,
        1,
        1
      );

    return {
      start:
        start.toISOString(),

      end:
        end.toISOString(),

      label:
        `${year}年`,
    };
  }

  return null;
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
    Number(
      row.records || 0
    );

  const sales =
    Number(
      row.sales || 0
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
  userId,
  start,
  end
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

      AND created_at >=
        ${start}

      AND created_at <
        ${end}

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
      Number(
        row.sales || 0
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
      // パラメータ
      // -----------------------------------------------------

      const period =
        String(
          req.query?.period ||
          "today"
        ).toLowerCase();

      const requestedMonth =
        req.query?.month
          ? String(
              req.query.month
            )
          : "";

      const requestedYear =
        req.query?.year
          ? String(
              req.query.year
            )
          : "";

      // -----------------------------------------------------
      // 期間
      // -----------------------------------------------------

      const range =
        getPeriodRange(
          period,
          requestedMonth,
          requestedYear
        );

      if (!range) {
        return res.status(400).json({
          ok: false,
          error:
            "期間指定が正しくありません。",
        });
      }

      if (range.error) {
        return res.status(400).json({
          ok: false,
          error:
            range.error,
        });
      }

      // -----------------------------------------------------
      // 個人集計
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
          userId,
          range.start,
          range.end
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
      // Response
      // -----------------------------------------------------

      return res.status(200).json({

        ok: true,

        period,

        requestedMonth:
          requestedMonth ||
          null,

        requestedYear:
          requestedYear ||
          null,

        label:
          range.label,

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

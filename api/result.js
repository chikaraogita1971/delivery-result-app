const { neon } = require("@neondatabase/serverless");
const crypto = require("crypto");

const sql = neon(process.env.DATABASE_URL);
const BOT_TOKEN = process.env.BOT_TOKEN;

// =========================================================
// Telegram認証
// =========================================================

function parseInitData(initData) {
  const raw = String(initData || "");

  if (!raw) {
    return null;
  }

  const params = new URLSearchParams(raw);
  const hash = params.get("hash");

  if (!hash) {
    return null;
  }

  const dataCheckString = [...params.entries()]
    .filter(([key]) => key !== "hash")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

  if (!BOT_TOKEN) {
    console.error(
      "[RESULT] BOT_TOKEN is not configured"
    );
    return null;
  }

  try {
    const secretKey = crypto
      .createHmac(
        "sha256",
        "WebAppData"
      )
      .update(BOT_TOKEN)
      .digest();

    const calculatedHash = crypto
      .createHmac(
        "sha256",
        secretKey
      )
      .update(dataCheckString)
      .digest("hex");

    const hashBuffer =
      Buffer.from(hash, "hex");

    const calculatedBuffer =
      Buffer.from(
        calculatedHash,
        "hex"
      );

    if (
      hashBuffer.length !==
      calculatedBuffer.length
    ) {
      return null;
    }

    if (
      !crypto.timingSafeEqual(
        hashBuffer,
        calculatedBuffer
      )
    ) {
      return null;
    }

    const authDate =
      Number(
        params.get("auth_date") || 0
      );

    if (!authDate) {
      return null;
    }

    const now =
      Math.floor(Date.now() / 1000);

    // 24時間以上古いinitDataは拒否
    if (
      now - authDate > 86400 ||
      authDate - now > 60
    ) {
      return null;
    }

    const userRaw =
      params.get("user");

    if (!userRaw) {
      return null;
    }

    const user =
      JSON.parse(userRaw);

    if (!user?.id) {
      return null;
    }

    return user;
  } catch (error) {
    console.error(
      "[RESULT] Telegram auth error:",
      error?.message
    );

    return null;
  }
}

function getTelegramUserId(req) {
  const initData =
    req.headers[
      "x-telegram-init-data"
    ] || "";

  const user =
    parseInitData(initData);

  if (!user?.id) {
    return null;
  }

  return String(user.id);
}

// =========================================================
// 数値・入力チェック
// =========================================================

function parseInteger(value) {
  const number =
    Number(value);

  if (
    !Number.isInteger(number)
  ) {
    return null;
  }

  return number;
}

function parseWorkHours(value) {
  const number =
    Number(value);

  if (
    !Number.isFinite(number)
  ) {
    return null;
  }

  return Math.round(
    number * 100
  ) / 100;
}

function validateResultInput(body) {
  const saleAmount =
    parseInteger(
      body?.saleAmount
    );

  const deliveryCount =
    parseInteger(
      body?.deliveryCount
    );

  const workHours =
    parseWorkHours(
      body?.workHours
    );

  if (
    saleAmount === null ||
    deliveryCount === null ||
    workHours === null
  ) {
    return {
      error:
        "売上・配達数・稼働時間を正しく入力してください。",
    };
  }

  if (saleAmount < 0) {
    return {
      error:
        "売上は0円以上で入力してください。",
    };
  }

  if (deliveryCount < 0) {
    return {
      error:
        "配達数は0件以上で入力してください。",
    };
  }

  if (
    workHours <= 0
  ) {
    return {
      error:
        "稼働時間は0より大きい値を入力してください。",
    };
  }

  if (
    workHours > 999.99
  ) {
    return {
      error:
        "稼働時間が大きすぎます。",
    };
  }

  return {
    saleAmount,
    deliveryCount,
    workHours,
  };
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
        timeZone:
          "Asia/Tokyo",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }
    ).formatToParts(now);

  return {
    year: Number(
      parts.find(
        item =>
          item.type === "year"
      )?.value
    ),

    month: Number(
      parts.find(
        item =>
          item.type === "month"
      )?.value
    ),

    day: Number(
      parts.find(
        item =>
          item.type === "day"
      )?.value
    ),
  };
}

function pad2(value) {
  return String(value)
    .padStart(2, "0");
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

  if (
    period === "today"
  ) {
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
  // 今週
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
        ? sales /
          deliveryCount
        : 0,

    hourlySales:
      workHours > 0
        ? sales /
          workHours
        : 0,
  };
}

// =========================================================
// 実績履歴
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

    LIMIT 50
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
          ? sales /
            deliveryCount
          : 0,

      hourlySales:
        workHours > 0
          ? sales /
            workHours
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
        created_at AT TIME ZONE 'Asia/Tokyo'
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
      ) AS work_hours,

      COUNT(*) AS records

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

      records:
        Number(
          row.records || 0
        ),

      unitPrice:
        deliveryCount > 0
          ? sales /
            deliveryCount
          : 0,

      hourlySales:
        workHours > 0
          ? sales /
            workHours
          : 0,
    };
  });
}

// =========================================================
// 月次レポート
// =========================================================

function buildMonthlyReport(
  stats,
  daily
) {
  const workingDays =
    daily.filter(
      day =>
        Number(day.records) > 0
    ).length;

  let bestSalesDay = null;
  let bestDeliveryDay = null;
  let bestHourlyDay = null;

  for (const day of daily) {
    if (
      !bestSalesDay ||
      Number(day.sales) >
        Number(bestSalesDay.sales)
    ) {
      bestSalesDay = day;
    }

    if (
      !bestDeliveryDay ||
      Number(day.deliveryCount) >
        Number(
          bestDeliveryDay.deliveryCount
        )
    ) {
      bestDeliveryDay = day;
    }

    if (
      Number(day.hourlySales) >
        Number(
          bestHourlyDay?.hourlySales || 0
        )
    ) {
      bestHourlyDay = day;
    }
  }

  return {
    sales:
      stats.sales,

    deliveryCount:
      stats.deliveryCount,

    workHours:
      stats.workHours,

    records:
      stats.records,

    workingDays,

    averageDailySales:
      workingDays > 0
        ? stats.sales /
          workingDays
        : 0,

    averageDailyDeliveryCount:
      workingDays > 0
        ? stats.deliveryCount /
          workingDays
        : 0,

    averageDailyWorkHours:
      workingDays > 0
        ? stats.workHours /
          workingDays
        : 0,

    unitPrice:
      stats.unitPrice,

    hourlySales:
      stats.hourlySales,

    bestSalesDay,

    bestDeliveryDay,

    bestHourlyDay,
  };
}

// =========================================================
// 実績編集
// =========================================================

async function updateResult(
  userId,
  resultId,
  body
) {
  const id =
    parseInteger(resultId);

  if (
    id === null ||
    id <= 0
  ) {
    return {
      ok: false,
      status: 400,
      error:
        "実績IDが正しくありません。",
    };
  }

  const validation =
    validateResultInput(body);

  if (
    validation.error
  ) {
    return {
      ok: false,
      status: 400,
      error:
        validation.error,
    };
  }

  const {
    saleAmount,
    deliveryCount,
    workHours,
  } = validation;

  const rows = await sql`
    UPDATE delivery_results

    SET
      sale_amount =
        ${saleAmount},

      delivery_count =
        ${deliveryCount},

      work_hours =
        ${workHours}

    WHERE id =
      ${id}

      AND telegram_user_id =
        ${userId}

    RETURNING
      id,
      sale_amount,
      delivery_count,
      work_hours,
      created_at
  `;

  if (
    rows.length === 0
  ) {
    return {
      ok: false,
      status: 404,
      error:
        "実績が見つかりません。",
    };
  }

  const row =
    rows[0];

  // 監査ログ
  try {
    await sql`
      INSERT INTO audit_logs (
        telegram_user_id,
        action,
        details
      )
      VALUES (
        ${userId},
        ${"result_update"},
        ${JSON.stringify({
          resultId: id,
          saleAmount,
          deliveryCount,
          workHours,
        })}
      )
    `;
  } catch (error) {
    console.error(
      "[RESULT] audit log error:",
      error?.message
    );
  }

  return {
    ok: true,
    status: 200,

    result: {
      id:
        Number(row.id),

      saleAmount:
        Number(
          row.sale_amount
        ),

      deliveryCount:
        Number(
          row.delivery_count
        ),

      workHours:
        Number(
          row.work_hours
        ),

      createdAt:
        row.created_at,
    },
  };
}

// =========================================================
// 実績削除
// =========================================================

async function deleteResult(
  userId,
  resultId
) {
  const id =
    parseInteger(resultId);

  if (
    id === null ||
    id <= 0
  ) {
    return {
      ok: false,
      status: 400,
      error:
        "実績IDが正しくありません。",
    };
  }

  const rows = await sql`
    DELETE FROM delivery_results

    WHERE id =
      ${id}

      AND telegram_user_id =
        ${userId}

    RETURNING
      id,
      sale_amount,
      delivery_count,
      work_hours,
      created_at
  `;

  if (
    rows.length === 0
  ) {
    return {
      ok: false,
      status: 404,
      error:
        "実績が見つかりません。",
    };
  }

  const row =
    rows[0];

  // 監査ログ
  try {
    await sql`
      INSERT INTO audit_logs (
        telegram_user_id,
        action,
        details
      )
      VALUES (
        ${userId},
        ${"result_delete"},
        ${JSON.stringify({
          resultId: id,
          saleAmount:
            Number(
              row.sale_amount
            ),
          deliveryCount:
            Number(
              row.delivery_count
            ),
          workHours:
            Number(
              row.work_hours
            ),
          createdAt:
            row.created_at,
        })}
      )
    `;
  } catch (error) {
    console.error(
      "[RESULT] audit log error:",
      error?.message
    );
  }

  return {
    ok: true,
    status: 200,

    deleted: {
      id:
        Number(row.id),

      saleAmount:
        Number(
          row.sale_amount
        ),

      deliveryCount:
        Number(
          row.delivery_count
        ),

      workHours:
        Number(
          row.work_hours
        ),

      createdAt:
        row.created_at,
    },
  };
}

// =========================================================
// メソッド別処理
// =========================================================

async function handleGet(
  req,
  userId
) {
  const query =
    req.query || {};

  const period =
    String(
      query.period || "month"
    ).toLowerCase();

  if (
    ![
      "today",
      "week",
      "month",
      "year",
    ].includes(period)
  ) {
    return {
      status: 400,
      body: {
        ok: false,
        error:
          "periodが正しくありません。",
      },
    };
  }

  const requestedMonth =
    query.month
      ? String(query.month)
      : null;

  const requestedYear =
    query.year
      ? String(query.year)
      : null;

  const range =
    getPeriodRange(
      period,
      requestedMonth,
      requestedYear
    );

  if (
    range?.error
  ) {
    return {
      status: 400,
      body: {
        ok: false,
        error:
          range.error,
      },
    };
  }

  if (!range) {
    return {
      status: 400,
      body: {
        ok: false,
        error:
          "期間指定が正しくありません。",
      },
    };
  }

  const [
    stats,
    recentResults,
    daily,
  ] = await Promise.all([
    getStats(
      userId,
      range.start,
      range.end
    ),

    getRecentResults(
      userId,
      range.start,
      range.end
    ),

    getDailyResults(
      userId,
      range.start,
      range.end
    ),
  ]);

  const monthlyReport =
    period === "month"
      ? buildMonthlyReport(
          stats,
          daily
        )
      : null;

  return {
    status: 200,

    body: {
      ok: true,

      period,

      requestedMonth,

      requestedYear,

      label:
        range.label,

      range: {
        start:
          range.start,

        end:
          range.end,
      },

      stats,

      monthlyReport,

      recentResults,

      daily,
    },
  };
}

async function handlePut(
  req,
  userId
) {
  const body =
    req.body || {};

  const resultId =
    body.id ??
    req.query?.id;

  return await updateResult(
    userId,
    resultId,
    body
  );
}

async function handleDelete(
  req,
  userId
) {
  const resultId =
    req.query?.id ??
    req.body?.id;

  return await deleteResult(
    userId,
    resultId
  );
}

// =========================================================
// Vercel API
// =========================================================

module.exports =
  async function handler(
    req,
    res
  ) {
    try {
      console.log(
        "[RESULT] request:",
        {
          method:
            req.method,

          url:
            req.url,
        }
      );

      // ---------------------------------------------------
      // Telegramユーザー認証
      // ---------------------------------------------------

      const userId =
        getTelegramUserId(req);

      if (!userId) {
        return res
          .status(401)
          .json({
            ok: false,
            error:
              "Telegram認証が確認できません。",
          });
      }

      // ---------------------------------------------------
      // GET
      // ---------------------------------------------------

      if (
        req.method === "GET"
      ) {
        const result =
          await handleGet(
            req,
            userId
          );

        return res
          .status(result.status)
          .json(result.body);
      }

      // ---------------------------------------------------
      // PUT
      // ---------------------------------------------------

      if (
        req.method === "PUT"
      ) {
        const result =
          await handlePut(
            req,
            userId
          );

        return res
          .status(result.status)
          .json(result);
      }

      // ---------------------------------------------------
      // PATCHもPUTと同じ扱い
      // ---------------------------------------------------

      if (
        req.method === "PATCH"
      ) {
        const result =
          await handlePut(
            req,
            userId
          );

        return res
          .status(result.status)
          .json(result);
      }

      // ---------------------------------------------------
      // DELETE
      // ---------------------------------------------------

      if (
        req.method === "DELETE"
      ) {
        const result =
          await handleDelete(
            req,
            userId
          );

        return res
          .status(result.status)
          .json(result);
      }

      // ---------------------------------------------------
      // その他
      // ---------------------------------------------------

      return res
        .status(405)
        .json({
          ok: false,
          error:
            "Method Not Allowed",
        });

    } catch (error) {
      console.error(
        "[RESULT] API error:",
        error
      );

      return res
        .status(500)
        .json({
          ok: false,
          error:
            "サーバーエラーが発生しました。",
        });
    }
  };

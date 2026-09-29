import { neon } from "@neondatabase/serverless";

const sql = neon(process.env.POSTGRES_URL);

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  try {
    const userId = req.query.user_id;
    const period = req.query.period || "month";

    if (!userId) {
      return res.status(400).json({ error: "user_id is required" });
    }

    const allowedPeriods = ["day", "week", "month", "year"];

    if (!allowedPeriods.includes(period)) {
      return res.status(400).json({ error: "invalid period" });
    }

    let condition;

    if (period === "day") {
      condition = sql`
        created_at >= CURRENT_DATE
        AND created_at < CURRENT_DATE + INTERVAL '1 day'
      `;
    } else if (period === "week") {
      condition = sql`
        created_at >= date_trunc('week', CURRENT_DATE)
        AND created_at < date_trunc('week', CURRENT_DATE) + INTERVAL '1 week'
      `;
    } else if (period === "year") {
      condition = sql`
        created_at >= date_trunc('year', CURRENT_DATE)
        AND created_at < date_trunc('year', CURRENT_DATE) + INTERVAL '1 year'
      `;
    } else {
      condition = sql`
        created_at >= date_trunc('month', CURRENT_DATE)
        AND created_at < date_trunc('month', CURRENT_DATE) + INTERVAL '1 month'
      `;
    }

    const rows = await sql`
      SELECT
        COALESCE(SUM(sale_amount), 0) AS sales,
        COALESCE(SUM(delivery_count), 0) AS count,
        COALESCE(SUM(work_hours), 0) AS hours,
        COUNT(DISTINCT DATE(created_at)) AS work_days
      FROM delivery_results
      WHERE telegram_user_id = ${String(userId)}
        AND ${condition}
    `;

    const dailyRows = await sql`
      SELECT
        DATE(created_at) AS work_date,
        SUM(sale_amount) AS daily_sales,
        SUM(delivery_count) AS daily_count
      FROM delivery_results
      WHERE telegram_user_id = ${String(userId)}
        AND ${condition}
      GROUP BY DATE(created_at)
      ORDER BY DATE(created_at)
    `;

    const goalRows = await sql`
      SELECT monthly_goal
      FROM delivery_goals
      WHERE telegram_user_id = ${String(userId)}
    `;

    const totalRows = await sql`
      SELECT
        COALESCE(SUM(delivery_count), 0) AS total_count
      FROM delivery_results
      WHERE telegram_user_id = ${String(userId)}
    `;

    const recordRows = await sql`
      SELECT
        id,
        sale_amount,
        delivery_count,
        work_hours,
        created_at
      FROM delivery_results
      WHERE telegram_user_id = ${String(userId)}
      ORDER BY created_at DESC, id DESC
      LIMIT 20
    `;

    const sales = Number(rows[0]?.sales ?? 0);
    const count = Number(rows[0]?.count ?? 0);
    const hours = Number(rows[0]?.hours ?? 0);
    const workDays = Number(rows[0]?.work_days ?? 0);

    const goal = Number(goalRows[0]?.monthly_goal ?? 0);
    const totalCount = Number(totalRows[0]?.total_count ?? 0);

    const maxSales = dailyRows.length
      ? Math.max(...dailyRows.map(row => Number(row.daily_sales || 0)))
      : 0;

    const maxCount = dailyRows.length
      ? Math.max(...dailyRows.map(row => Number(row.daily_count || 0)))
      : 0;

    const average = count > 0
      ? Math.round(sales / count)
      : 0;

    const rate = goal > 0
      ? Math.round((sales / goal) * 100)
      : 0;

    const records = recordRows.map(row => ({
      id: Number(row.id),
      sale: Number(row.sale_amount),
      count: Number(row.delivery_count),
      hours: Number(row.work_hours),
      createdAt: row.created_at
    }));

    return res.status(200).json({
      period,
      sales,
      count,
      hours,
      workDays,
      maxSales,
      maxCount,
      average,
      goal,
      rate,
      totalCount,
      records
    });

  } catch (error) {
    console.error("Result API error:", error);

    return res.status(500).json({
      error: "Internal Server Error"
    });
  }
}

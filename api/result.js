import { neon } from "@neondatabase/serverless";

const sql = neon(process.env.POSTGRES_URL);

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  try {
    const userId = req.query.user_id;

    if (!userId) {
      return res.status(400).json({ error: "user_id is required" });
    }

    const rows = await sql`
      SELECT
        COALESCE(SUM(sale_amount), 0) AS sales,
        COALESCE(SUM(delivery_count), 0) AS count,
        COALESCE(SUM(work_hours), 0) AS hours
      FROM delivery_results
      WHERE telegram_user_id = ${String(userId)}
        AND created_at >= date_trunc('month', CURRENT_DATE)
        AND created_at < date_trunc('month', CURRENT_DATE) + INTERVAL '1 month'
    `;

    const goalRows = await sql`
      SELECT monthly_goal
      FROM delivery_goals
      WHERE telegram_user_id = ${String(userId)}
    `;

    const sales = Number(rows[0]?.sales ?? 0);
    const count = Number(rows[0]?.count ?? 0);
    const hours = Number(rows[0]?.hours ?? 0);
    const goal = Number(goalRows[0]?.monthly_goal ?? 0);

    return res.status(200).json({
      sales,
      count,
      hours,
      goal
    });
  } catch (error) {
    console.error("Result API error:", error);
    return res.status(500).json({
      error: "Internal Server Error"
    });
  }
}

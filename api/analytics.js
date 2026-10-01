async function getStreak(userId) {
  const rows = await sql`
    SELECT DISTINCT
      (
        created_at AT TIME ZONE ${JST}
      )::date AS day
    FROM delivery_results
    WHERE telegram_user_id = ${userId}
    ORDER BY day DESC
  `;

  if (!rows.length) {
    return {
      current: 0,
      best: 0
    };
  }

  // PostgreSQLの日付を必ず YYYY-MM-DD に統一
  const dates = rows
    .map(row => {
      const value = row.day;

      if (!value) {
        return null;
      }

      const text = String(value);

      if (/^\d{4}-\d{2}-\d{2}/.test(text)) {
        return text.slice(0, 10);
      }

      const date = new Date(value);

      if (Number.isNaN(date.getTime())) {
        return null;
      }

      return date.toISOString().slice(0, 10);
    })
    .filter(Boolean)
    .sort((a, b) => b.localeCompare(a));

  if (!dates.length) {
    return {
      current: 0,
      best: 0
    };
  }

  const today = getJSTDateString();
  const yesterday = addDays(today, -1);

  /* =======================================================
     現在の連続稼働
  ======================================================= */

  let current = 0;

  if (
    dates.includes(today) ||
    dates.includes(yesterday)
  ) {
    let expected =
      dates.includes(today)
        ? today
        : yesterday;

    for (const date of dates) {
      if (date !== expected) {
        break;
      }

      current++;

      expected =
        addDays(expected, -1);
    }
  }

  /* =======================================================
     自己最高連続
  ======================================================= */

  const ascendingDates =
    [...new Set(dates)].sort(
      (a, b) => a.localeCompare(b)
    );

  let best = 0;
  let streak = 0;
  let previous = null;

  for (const date of ascendingDates) {
    if (previous === null) {
      streak = 1;
    } else {
      const expected =
        addDays(previous, 1);

      if (date === expected) {
        streak++;
      } else {
        streak = 1;
      }
    }

    if (streak > best) {
      best = streak;
    }

    previous = date;
  }

  return {
    current,
    best
  };
}

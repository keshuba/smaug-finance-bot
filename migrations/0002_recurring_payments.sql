CREATE TABLE recurring_payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL CHECK(length(trim(title)) BETWEEN 2 AND 80),
  day_of_month INTEGER NOT NULL CHECK(day_of_month BETWEEN 1 AND 31),
  amount_minor INTEGER NOT NULL CHECK(amount_minor > 0),
  currency TEXT NOT NULL DEFAULT 'RUB',
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled')),
  source_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX recurring_active_title_day_idx
  ON recurring_payments(lower(title),day_of_month) WHERE status='active';

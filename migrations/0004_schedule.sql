-- Wave 4 基础：应用设置与定时解析切换任务。
CREATE TABLE app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE dns_schedule_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  domain_id INTEGER NOT NULL REFERENCES dns_domains(id) ON DELETE CASCADE,
  record_id TEXT,
  record_name TEXT NOT NULL,
  record_type TEXT NOT NULL,
  switch_type INTEGER NOT NULL CHECK (switch_type IN (0, 1, 2, 3)),
  mode TEXT NOT NULL CHECK (mode IN ('once', 'daily', 'weekly', 'monthly')),
  run_date TEXT,
  weekday INTEGER CHECK (weekday IS NULL OR (weekday BETWEEN 0 AND 6)),
  month_day INTEGER CHECK (month_day IS NULL OR (month_day BETWEEN 1 AND 31)),
  run_time TEXT NOT NULL,
  value TEXT,
  line TEXT,
  ttl INTEGER,
  mx INTEGER,
  remark TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  next_run_at INTEGER NOT NULL DEFAULT 0,
  last_run_at INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX dns_schedule_due ON dns_schedule_tasks(active, next_run_at);
CREATE INDEX dns_schedule_domain ON dns_schedule_tasks(domain_id);

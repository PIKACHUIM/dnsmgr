CREATE TABLE cert_deploy_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 64),
  type TEXT NOT NULL CHECK (type IN ('webhook','executor')),
  config_cipher TEXT NOT NULL,
  remark TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX cert_deploy_accounts_name ON cert_deploy_accounts(name);

CREATE TABLE cert_deploy_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 64),
  account_id INTEGER NOT NULL REFERENCES cert_deploy_accounts(id) ON DELETE CASCADE,
  certificate_order_id INTEGER NOT NULL REFERENCES cert_orders(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  auto_deploy INTEGER NOT NULL DEFAULT 1 CHECK (auto_deploy IN (0,1)),
  target TEXT,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_run_at INTEGER,
  last_status TEXT,
  last_error TEXT
);
CREATE INDEX cert_deploy_tasks_account ON cert_deploy_tasks(account_id, enabled, id);
CREATE INDEX cert_deploy_tasks_order ON cert_deploy_tasks(certificate_order_id, id);

CREATE TABLE cert_deploy_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES cert_deploy_tasks(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('pending','running','succeeded','failed')),
  detail TEXT,
  claimed_by TEXT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX cert_deploy_runs_task ON cert_deploy_runs(task_id, started_at);
CREATE INDEX cert_deploy_runs_queue ON cert_deploy_runs(status, id);

-- 部署账户类型扩展为原生驱动（宝塔、腾讯云等），并为部署任务增加驱动配置与运行状态。
-- SQLite 不能直接删除 CHECK 约束，这里按“先建副本、再删旧表、最后改名”的顺序重建，
-- 先建好子表副本再删父表，避免 ON DELETE CASCADE 在切换过程中清空任务与运行记录。
CREATE TABLE cert_deploy_accounts_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 64),
  type TEXT NOT NULL CHECK (length(type) BETWEEN 1 AND 32),
  config_cipher TEXT NOT NULL,
  remark TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
INSERT INTO cert_deploy_accounts_new (id,name,type,config_cipher,remark,created_at,updated_at)
  SELECT id,name,type,config_cipher,remark,created_at,updated_at FROM cert_deploy_accounts;

CREATE TABLE cert_deploy_tasks_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 64),
  account_id INTEGER NOT NULL REFERENCES cert_deploy_accounts_new(id) ON DELETE CASCADE,
  certificate_order_id INTEGER NOT NULL REFERENCES cert_orders(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  auto_deploy INTEGER NOT NULL DEFAULT 1 CHECK (auto_deploy IN (0,1)),
  target TEXT,
  config_json TEXT NOT NULL DEFAULT '{}',
  info_json TEXT NOT NULL DEFAULT '{}',
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_run_at INTEGER,
  last_status TEXT,
  last_error TEXT
);
INSERT INTO cert_deploy_tasks_new
  (id,name,account_id,certificate_order_id,enabled,auto_deploy,target,config_json,info_json,created_by,created_at,updated_at,last_run_at,last_status,last_error)
  SELECT id,name,account_id,certificate_order_id,enabled,auto_deploy,target,'{}','{}',created_by,created_at,updated_at,last_run_at,last_status,last_error
  FROM cert_deploy_tasks;

CREATE TABLE cert_deploy_runs_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES cert_deploy_tasks_new(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('pending','running','succeeded','failed')),
  detail TEXT,
  claimed_by TEXT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER
);
INSERT INTO cert_deploy_runs_new (id,task_id,status,detail,claimed_by,started_at,finished_at)
  SELECT id,task_id,status,detail,claimed_by,started_at,finished_at FROM cert_deploy_runs;

DROP TABLE cert_deploy_runs;
DROP TABLE cert_deploy_tasks;
DROP TABLE cert_deploy_accounts;
ALTER TABLE cert_deploy_accounts_new RENAME TO cert_deploy_accounts;
ALTER TABLE cert_deploy_tasks_new RENAME TO cert_deploy_tasks;
ALTER TABLE cert_deploy_runs_new RENAME TO cert_deploy_runs;

CREATE UNIQUE INDEX cert_deploy_accounts_name ON cert_deploy_accounts(name);
CREATE INDEX cert_deploy_tasks_account ON cert_deploy_tasks(account_id, enabled, id);
CREATE INDEX cert_deploy_tasks_order ON cert_deploy_tasks(certificate_order_id, id);
CREATE INDEX cert_deploy_runs_task ON cert_deploy_runs(task_id, started_at);
CREATE INDEX cert_deploy_runs_queue ON cert_deploy_runs(status, id);

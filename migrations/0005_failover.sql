-- HTTP health checks with threshold-based DNS failover and bounded per-task history.
CREATE TABLE dns_failover_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  domain_id INTEGER NOT NULL REFERENCES dns_domains(id) ON DELETE CASCADE,
  record_id TEXT NOT NULL,
  record_name TEXT NOT NULL,
  record_type TEXT NOT NULL CHECK (record_type IN ('A', 'AAAA', 'CNAME')),
  main_value TEXT NOT NULL,
  backup_value TEXT NOT NULL,
  check_url_cipher TEXT NOT NULL,
  interval_seconds INTEGER NOT NULL CHECK (interval_seconds BETWEEN 30 AND 86400),
  timeout_seconds INTEGER NOT NULL CHECK (timeout_seconds BETWEEN 1 AND 30),
  failure_threshold INTEGER NOT NULL CHECK (failure_threshold BETWEEN 1 AND 10),
  consecutive_count INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_count >= 0),
  current_backup INTEGER NOT NULL DEFAULT 0 CHECK (current_backup IN (0, 1)),
  line TEXT NOT NULL,
  ttl INTEGER NOT NULL,
  mx INTEGER,
  weight INTEGER,
  remark TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  lease_until INTEGER NOT NULL DEFAULT 0,
  next_check_at INTEGER NOT NULL DEFAULT 0,
  last_check_at INTEGER,
  last_http_status INTEGER,
  last_latency_ms INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(domain_id, record_id)
);
CREATE INDEX dns_failover_due ON dns_failover_tasks(active, next_check_at, lease_until);
CREATE INDEX dns_failover_domain ON dns_failover_tasks(domain_id);

CREATE TABLE dns_failover_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES dns_failover_tasks(id) ON DELETE CASCADE,
  event TEXT NOT NULL CHECK (event IN ('healthy', 'unhealthy', 'switch_backup', 'recover_main', 'dns_update_failed', 'runtime_error')),
  probe_ok INTEGER CHECK (probe_ok IS NULL OR probe_ok IN (0, 1)),
  http_status INTEGER,
  latency_ms INTEGER,
  message TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX dns_failover_logs_task ON dns_failover_logs(task_id, id DESC);

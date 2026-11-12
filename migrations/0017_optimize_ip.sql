CREATE TABLE optimize_ip_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  domain_id INTEGER NOT NULL REFERENCES dns_domains(id) ON DELETE CASCADE,
  rr TEXT NOT NULL CHECK (length(rr) BETWEEN 1 AND 63),
  record_type TEXT NOT NULL CHECK (record_type IN ('A','AAAA')),
  ip_group TEXT NOT NULL DEFAULT 'CT' CHECK (ip_group IN ('DEF','CT','CU','CM')),
  cdn_type INTEGER NOT NULL DEFAULT 1 CHECK (cdn_type BETWEEN 1 AND 4),
  record_count INTEGER NOT NULL DEFAULT 2 CHECK (record_count BETWEEN 1 AND 50),
  ttl INTEGER NOT NULL DEFAULT 600 CHECK (ttl BETWEEN 1 AND 86400),
  line TEXT NOT NULL DEFAULT '0',
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  remark TEXT,
  last_run_at INTEGER,
  last_status TEXT,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(domain_id, rr, record_type, ip_group, line)
);
CREATE INDEX optimize_ip_tasks_due ON optimize_ip_tasks(enabled, last_run_at, id);
CREATE INDEX optimize_ip_tasks_domain ON optimize_ip_tasks(domain_id, id);

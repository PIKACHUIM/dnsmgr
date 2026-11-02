-- Wave 3: DNS 账户、域名与审计日志。
-- 解析记录本身仍由各平台实时持有，本地只保存账户凭据与域名归属。
PRAGMA foreign_keys = ON;

CREATE TABLE dns_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL CHECK (length(type) BETWEEN 1 AND 20),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 64),
  config_cipher TEXT NOT NULL,
  remark TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX dns_accounts_name ON dns_accounts(name);

CREATE TABLE dns_domains (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES dns_accounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  third_id TEXT,
  category_id INTEGER,
  hidden INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0, 1)),
  notice INTEGER NOT NULL DEFAULT 0 CHECK (notice IN (0, 1)),
  remark TEXT,
  record_count INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER,
  checked_at INTEGER,
  check_status INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX dns_domains_name ON dns_domains(name);
CREATE INDEX dns_domains_account ON dns_domains(account_id);

CREATE TABLE dns_domain_categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 50),
  sort INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX dns_categories_name ON dns_domain_categories(name);

CREATE TABLE audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  action TEXT NOT NULL CHECK (length(action) BETWEEN 1 AND 40),
  target TEXT,
  detail TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX audit_logs_user ON audit_logs(user_id, created_at);

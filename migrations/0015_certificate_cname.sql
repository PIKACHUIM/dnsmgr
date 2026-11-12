CREATE TABLE cert_cname_proxies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  domain TEXT NOT NULL UNIQUE CHECK (length(domain) BETWEEN 1 AND 253),
  target TEXT NOT NULL CHECK (length(target) BETWEEN 1 AND 253),
  dns_domain_id INTEGER NOT NULL REFERENCES dns_domains(id),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  remark TEXT,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX cert_cname_proxies_zone ON cert_cname_proxies(dns_domain_id, enabled, id);
ALTER TABLE cert_acme_orders ADD COLUMN challenge_map_json TEXT NOT NULL DEFAULT '{}';

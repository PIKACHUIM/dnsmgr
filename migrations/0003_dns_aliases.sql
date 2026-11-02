-- Wave 3 补充：DNSPod 域名别名本地镜像。
CREATE TABLE dns_domain_aliases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  domain_id INTEGER NOT NULL REFERENCES dns_domains(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  remote_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX dns_domain_aliases_name ON dns_domain_aliases(domain_id, name);
CREATE UNIQUE INDEX dns_domain_aliases_remote ON dns_domain_aliases(domain_id, remote_id);

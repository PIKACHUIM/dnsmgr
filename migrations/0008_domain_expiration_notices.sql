ALTER TABLE dns_domains ADD COLUMN notice_attempted_at INTEGER;
CREATE INDEX dns_domains_expiration_notice ON dns_domains(notice, expires_at, notice_attempted_at, id);

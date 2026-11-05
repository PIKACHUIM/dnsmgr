CREATE INDEX dns_domains_periodic_expiration_queue ON dns_domains(check_status, expires_at, checked_at, id);

CREATE INDEX dns_domains_expiration_queue ON dns_domains(check_status, checked_at, id);

ALTER TABLE cert_acme_accounts ADD COLUMN ca TEXT NOT NULL DEFAULT 'letsencrypt';
ALTER TABLE cert_acme_accounts ADD COLUMN eab_kid TEXT;
ALTER TABLE cert_acme_accounts ADD COLUMN eab_hmac_cipher TEXT;
ALTER TABLE cert_acme_orders ADD COLUMN ca TEXT NOT NULL DEFAULT 'letsencrypt';
CREATE INDEX cert_acme_accounts_ca ON cert_acme_accounts(ca, status, id);

ALTER TABLE cert_orders ADD COLUMN is_auto INTEGER NOT NULL DEFAULT 0 CHECK (is_auto IN (0,1));
ALTER TABLE cert_orders ADD COLUMN revoked_at INTEGER;
ALTER TABLE cert_orders ADD COLUMN renewed_from INTEGER REFERENCES cert_orders(id);
ALTER TABLE cert_acme_orders ADD COLUMN renewal_of INTEGER REFERENCES cert_orders(id);
CREATE INDEX cert_orders_auto_renewal ON cert_orders(is_auto, expires_at, id);
CREATE INDEX cert_orders_renewed_from ON cert_orders(renewed_from, id);
CREATE INDEX cert_acme_orders_renewal ON cert_acme_orders(renewal_of, status, id);

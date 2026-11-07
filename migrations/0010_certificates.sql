CREATE TABLE cert_orders (
  id INTEGER PRIMARY KEY CHECK (id > 0),
  source TEXT NOT NULL CHECK (source IN ('manual')),
  status TEXT NOT NULL CHECK (status IN ('issued')),
  issuer TEXT NOT NULL,
  key_type TEXT NOT NULL CHECK (key_type IN ('RSA')),
  key_size INTEGER NOT NULL CHECK (key_size >= 2048),
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  fullchain_cipher TEXT NOT NULL,
  private_key_cipher TEXT NOT NULL,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX cert_orders_expiration ON cert_orders(status, expires_at, id);
CREATE INDEX cert_orders_creator ON cert_orders(created_by, created_at);

CREATE TABLE cert_order_domains (
  order_id INTEGER NOT NULL REFERENCES cert_orders(id) ON DELETE CASCADE,
  domain TEXT NOT NULL CHECK (length(domain) BETWEEN 1 AND 253),
  sort INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(order_id, domain),
  UNIQUE(order_id, sort)
);
CREATE INDEX cert_order_domains_domain ON cert_order_domains(domain, order_id);

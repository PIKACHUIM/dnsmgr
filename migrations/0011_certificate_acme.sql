CREATE TABLE cert_orders_v2 (
  id INTEGER PRIMARY KEY CHECK (id > 0),
  source TEXT NOT NULL CHECK (source IN ('manual','acme')),
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
INSERT INTO cert_orders_v2 SELECT * FROM cert_orders;

CREATE TABLE cert_order_domains_v2 (
  order_id INTEGER NOT NULL REFERENCES cert_orders_v2(id) ON DELETE CASCADE,
  domain TEXT NOT NULL CHECK (length(domain) BETWEEN 1 AND 253),
  sort INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(order_id, domain),
  UNIQUE(order_id, sort)
);
INSERT INTO cert_order_domains_v2 SELECT * FROM cert_order_domains;

DROP TABLE cert_order_domains;
DROP TABLE cert_orders;
ALTER TABLE cert_orders_v2 RENAME TO cert_orders;
ALTER TABLE cert_order_domains_v2 RENAME TO cert_order_domains;
CREATE INDEX cert_orders_expiration ON cert_orders(status, expires_at, id);
CREATE INDEX cert_orders_creator ON cert_orders(created_by, created_at);
CREATE INDEX cert_order_domains_domain ON cert_order_domains(domain, order_id);

CREATE TABLE cert_acme_accounts (
  id INTEGER PRIMARY KEY CHECK (id > 0),
  directory TEXT NOT NULL CHECK (directory IN ('staging','production')),
  directory_url TEXT NOT NULL,
  directory_json TEXT,
  email TEXT NOT NULL CHECK (length(email) BETWEEN 3 AND 254),
  kid TEXT,
  replay_nonce TEXT,
  claimed_nonce TEXT,
  claimed_at INTEGER,
  account_key_cipher TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending_directory','pending_registration','registration_unknown','ready','disabled')),
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX cert_acme_accounts_owner ON cert_acme_accounts(created_by, created_at);

CREATE TABLE cert_acme_orders (
  id INTEGER PRIMARY KEY CHECK (id > 0),
  account_id INTEGER NOT NULL REFERENCES cert_acme_accounts(id),
  dns_domain_id INTEGER NOT NULL REFERENCES dns_domains(id),
  dns_account_id INTEGER NOT NULL REFERENCES dns_accounts(id),
  dns_config_cipher TEXT NOT NULL,
  dns_zone_name TEXT NOT NULL,
  dns_zone_remote_id TEXT NOT NULL,
  created_by INTEGER NOT NULL REFERENCES users(id),
  directory TEXT NOT NULL CHECK (directory IN ('staging','production')),
  directory_json TEXT NOT NULL,
  account_kid TEXT NOT NULL,
  account_key_cipher TEXT NOT NULL,
  replay_nonce TEXT,
  claimed_nonce TEXT,
  claimed_at INTEGER,
  domains_json TEXT NOT NULL,
  authorization_state_json TEXT NOT NULL DEFAULT '[]',
  authorization_index INTEGER NOT NULL DEFAULT 0 CHECK (authorization_index >= 0),
  status TEXT NOT NULL CHECK (status IN (
    'draft','placing','authorizing','challenge_ready','dns_adding','dns_present','dns_outcome_unknown','dns_cleaning',
    'triggering','trigger_unknown','submitted','authorization_valid','ready_to_finalize','finalizing','processing',
    'certificate_ready','issued','failed','outcome_unknown','cancelled'
  )),
  remote_order_url TEXT,
  finalize_url TEXT,
  certificate_url TEXT,
  csr_der TEXT NOT NULL,
  private_key_cipher TEXT NOT NULL,
  cert_order_id INTEGER REFERENCES cert_orders(id),
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX cert_acme_orders_owner ON cert_acme_orders(created_by, created_at);
CREATE INDEX cert_acme_orders_account ON cert_acme_orders(account_id, status, updated_at);
CREATE INDEX cert_acme_orders_dns_domain ON cert_acme_orders(dns_domain_id, status, created_at);



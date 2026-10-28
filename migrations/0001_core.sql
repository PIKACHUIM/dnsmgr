PRAGMA foreign_keys = ON;

CREATE TABLE system_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  initialized INTEGER NOT NULL DEFAULT 0 CHECK (initialized IN (0, 1)),
  storage_identity TEXT
);
INSERT INTO system_state (id, initialized) VALUES (1, 0);

CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  level INTEGER NOT NULL DEFAULT 1,
  status INTEGER NOT NULL DEFAULT 1,
  is_api INTEGER NOT NULL DEFAULT 0 CHECK (is_api IN (0, 1)),
  apikey_cipher TEXT,
  totp_cipher TEXT,
  permission_version INTEGER NOT NULL DEFAULT 1,
  expires_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permission_version INTEGER NOT NULL,
  csrf_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id);
CREATE INDEX sessions_expiry ON sessions(expires_at);
CREATE TABLE security_challenges (
  token_hash TEXT PRIMARY KEY,
  purpose TEXT NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  secret_cipher TEXT,
  permission_version INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX security_challenges_expiry ON security_challenges(expires_at);
CREATE TABLE totp_counters (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  counter INTEGER NOT NULL
);
CREATE TABLE permissions (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  domain_id TEXT NOT NULL,
  PRIMARY KEY (user_id, domain_id)
);
CREATE TABLE rate_limits (
  key TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL CHECK (count >= 0)
);
CREATE TABLE quick_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  domain_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX quick_tokens_expiry ON quick_tokens(expires_at);
CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  next_run_at INTEGER NOT NULL,
  lease_owner TEXT,
  lease_until INTEGER,
  fence INTEGER NOT NULL DEFAULT 0,
  result TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX jobs_claim ON jobs(state, next_run_at, lease_until);

CREATE TABLE coordinator_leases (
  name TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  lease_until INTEGER NOT NULL,
  fence INTEGER NOT NULL CHECK (fence > 0)
);
CREATE TABLE storage_versions (
  namespace TEXT NOT NULL,
  version TEXT NOT NULL,
  format TEXT NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  sha256 TEXT NOT NULL,
  manifest TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (namespace, version)
);
CREATE TABLE storage_active (
  namespace TEXT PRIMARY KEY,
  version TEXT NOT NULL,
  fence INTEGER NOT NULL,
  FOREIGN KEY (namespace, version) REFERENCES storage_versions(namespace, version)
);
CREATE TABLE storage_objects (
  object_key TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE storage_entities (
  namespace TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (namespace, entity_id)
);

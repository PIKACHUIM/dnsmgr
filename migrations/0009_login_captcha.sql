INSERT INTO app_settings (key, value, updated_at)
VALUES ('vcode', '1', CAST(strftime('%s', 'now') AS INTEGER))
ON CONFLICT(key) DO NOTHING;

CREATE TABLE login_captcha_challenges (
  token_hash TEXT PRIMARY KEY,
  answer_hash TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 4),
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX login_captcha_expiry ON login_captcha_challenges(expires_at);
CREATE INDEX rate_limits_window ON rate_limits(window_start, key);

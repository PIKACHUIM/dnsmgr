CREATE TABLE notification_outbox (
  id INTEGER PRIMARY KEY,
  topic TEXT NOT NULL DEFAULT 'certificate' CHECK (topic IN ('certificate','deploy','system')),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  content TEXT NOT NULL CHECK (length(content) BETWEEN 1 AND 4000),
  created_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  sent_at INTEGER,
  last_error TEXT
);
CREATE INDEX notification_outbox_pending ON notification_outbox(sent_at, id);

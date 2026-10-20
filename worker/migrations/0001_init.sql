-- The catalog: one row per key per scope. scope is 'global' or a project name; a project row
-- overrides the global row of the same name. Values are AES-GCM ciphertext under the master key.
CREATE TABLE keys (
  scope       TEXT NOT NULL,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'static',
  description TEXT NOT NULL DEFAULT '',
  owner       TEXT NOT NULL DEFAULT '',
  iv          BLOB NOT NULL,
  ciphertext  BLOB NOT NULL,
  key_version INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL,
  rotated_at  TEXT NOT NULL,
  expires_at  TEXT,
  PRIMARY KEY (scope, name)
);

-- Caller tokens, stored as SHA-256 hashes. projects is a JSON array (the pin) or NULL for a
-- token that reads global keys only.
CREATE TABLE tokens (
  name       TEXT PRIMARY KEY,
  hash       TEXT NOT NULL UNIQUE,
  projects   TEXT,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);

-- Who read or changed what. Never a value.
CREATE TABLE audit (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  at      TEXT NOT NULL,
  actor   TEXT NOT NULL,
  action  TEXT NOT NULL,
  project TEXT,
  names   TEXT NOT NULL DEFAULT ''
);
CREATE INDEX audit_at ON audit (at);

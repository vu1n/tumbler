-- Minted keys. A key whose kind is 'mint:<provider>' holds a parent credential (sealed, like any
-- value) and a non-secret config: which scopes exist and what each maps to at the provider.
ALTER TABLE keys ADD COLUMN config TEXT NOT NULL DEFAULT '{}';
-- A random revision, new on every write. Grants record it, so a child minted from an old parent or
-- config is never stored or reused after a rotation (a timestamp can repeat; this can't).
ALTER TABLE keys ADD COLUMN rev TEXT NOT NULL DEFAULT '';

-- A mint key's previous revisions, kept (sealed, as they were) until every child they could have
-- minted has expired, so a grant from an old revision can still be revoked at the provider.
CREATE TABLE retired_keys (
  scope        TEXT NOT NULL,
  name         TEXT NOT NULL,
  rev          TEXT NOT NULL,
  kind         TEXT NOT NULL,
  config       TEXT NOT NULL,
  iv           BLOB NOT NULL,
  ciphertext   BLOB NOT NULL,
  retire_until TEXT NOT NULL,
  PRIMARY KEY (scope, name, rev)
);

-- One grant per (caller, project, key): the scopes a caller holds on a minted key and the child
-- credential minted for them. state: pending | active | denied | expired | revoked. A non-null
-- `requested` on an active grant is a step-up waiting for approval; the old child keeps working.
CREATE TABLE grants (
  id          TEXT PRIMARY KEY,
  caller      TEXT NOT NULL,
  project     TEXT,
  key_scope   TEXT NOT NULL,
  key_rev     TEXT NOT NULL, -- the key row's rev when the grant opened; a rotation ends it
  name        TEXT NOT NULL,
  state       TEXT NOT NULL,
  scopes      TEXT NOT NULL DEFAULT '[]',
  requested   TEXT,
  requested_at TEXT,
  child_id    TEXT,
  iv          BLOB,
  ciphertext  BLOB,
  expires_at  TEXT,
  decided_by  TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
-- At most one live grant per caller, project and key, so concurrent first requests can't mint twice.
-- COALESCE because NULL projects never conflict in a unique index.
CREATE UNIQUE INDEX grants_one_live ON grants (caller, COALESCE(project, ''), name) WHERE state IN ('pending', 'active');

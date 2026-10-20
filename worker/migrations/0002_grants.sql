-- Minted keys. A key whose kind is 'mint:<provider>' holds a parent credential (sealed, like any
-- value) and a non-secret config: which scopes exist and what each maps to at the provider.
ALTER TABLE keys ADD COLUMN config TEXT NOT NULL DEFAULT '{}';

-- One grant per (caller, project, key): the scopes a caller holds on a minted key and the child
-- credential minted for them. state: pending | active | denied | expired | revoked. A non-null
-- `requested` on an active grant is a step-up waiting for approval; the old child keeps working.
CREATE TABLE grants (
  id          TEXT PRIMARY KEY,
  caller      TEXT NOT NULL,
  project     TEXT,
  key_scope   TEXT NOT NULL,
  key_rev     TEXT NOT NULL, -- the key row's rotated_at when the grant opened; a rotation ends it
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

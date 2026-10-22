-- Standing approvals: an admin's "yes" to a caller holding some scopes on a mint key, for a while.
-- While one is live, a grant on that key opens or steps up to those scopes without asking again,
-- and children are still minted short-lived. Bound to the key's revision, so a rotation ends it.
-- Not per project: the caller's pin still decides which projects a child can be minted for.
CREATE TABLE approvals (
  id          TEXT PRIMARY KEY,
  caller      TEXT NOT NULL,
  key_scope   TEXT NOT NULL,
  name        TEXT NOT NULL,
  key_rev     TEXT NOT NULL,
  scopes      TEXT NOT NULL, -- JSON array, sorted
  approved_by TEXT NOT NULL,
  grant_id    TEXT,          -- the grant whose approval started it
  created_at  TEXT NOT NULL,
  until       TEXT NOT NULL,
  ended_at    TEXT,
  ended_by    TEXT
);
CREATE INDEX approvals_by_caller ON approvals (caller, key_scope, name);

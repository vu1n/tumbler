-- Every grant state change, as the event that caused it (machine.ts). Written in the same
-- transaction as the change, and append-only: the triggers refuse edits and deletes.
-- Never a credential: scopes and who, not the child or its provider id.
CREATE TABLE grant_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  grant_id   TEXT NOT NULL,
  at         TEXT NOT NULL,
  type       TEXT NOT NULL,
  actor      TEXT NOT NULL,
  from_state TEXT,
  to_state   TEXT NOT NULL,
  scopes     TEXT -- the scopes the event carried (open, step_up, mint), as JSON
);
CREATE INDEX grant_events_by_grant ON grant_events (grant_id, id);
CREATE TRIGGER grant_events_no_update BEFORE UPDATE ON grant_events BEGIN SELECT RAISE(ABORT, 'grant_events is append-only'); END;
CREATE TRIGGER grant_events_no_delete BEFORE DELETE ON grant_events BEGIN SELECT RAISE(ABORT, 'grant_events is append-only'); END;

-- 1 when the key's current value passed its check (a provider's verify, or the static key's
-- config.check) as it was saved. `tumbler run --watch` restarts a command only for these.
ALTER TABLE keys ADD COLUMN checked INTEGER NOT NULL DEFAULT 0;

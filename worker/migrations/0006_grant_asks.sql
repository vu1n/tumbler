-- Approvals asked in Huddles: each row is one ask posted to a member's Needs you for a grant's
-- request, and what came of it. Also the record of what was asked and how it was answered, so a
-- later triage step (Clef) has labelled examples. Never a value: names, scopes and choices only.
CREATE TABLE grant_asks (
  ask_id      TEXT PRIMARY KEY,
  grant_id    TEXT NOT NULL,
  room_id     TEXT NOT NULL,
  requested   TEXT NOT NULL, -- the grant's request when asked, sorted JSON; approval mints only this
  request     TEXT NOT NULL, -- what the person was shown, as JSON (caller, project, key, scopes, held)
  asked_at    TEXT NOT NULL,
  state       TEXT NOT NULL DEFAULT 'open', -- open | applied | refused | expired | withdrawn
  choice      TEXT,          -- the option picked, or decline / cancel
  answered_by TEXT,          -- the Huddles actor that answered, as kind:id
  answered_at TEXT
);
CREATE INDEX grant_asks_open ON grant_asks (state, grant_id);

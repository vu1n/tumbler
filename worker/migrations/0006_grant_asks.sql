-- Approvals asked in Huddles: each row is one ask posted to a member's Needs you for a grant's
-- request, and what came of it. Also the record of what was asked and how it was answered, so a
-- later triage step (Clef) has labelled examples. Never a value: names, scopes and choices only.
CREATE TABLE grant_asks (
  ask_id      TEXT PRIMARY KEY,
  grant_id    TEXT NOT NULL,
  room_id     TEXT NOT NULL,
  requested   TEXT NOT NULL, -- the grant's request when asked, sorted JSON; approval mints only this
  request_at  TEXT,          -- the grant's requested_at when asked: which request this is, so an
                             -- answer to one denied since can't decide the same scopes asked again
  request     TEXT NOT NULL, -- what the person was shown, as JSON (caller, project, key, scopes, held)
  asked_at    TEXT NOT NULL,
  state       TEXT NOT NULL DEFAULT 'open', -- what came of it: open | applied | refused | expired | withdrawn
  choice      TEXT,          -- what the person picked (or decline / cancel), apart from what came of it
  answered_by TEXT,          -- the Huddles actor that answered, as kind:id
  read_at     TEXT,          -- when tumbler read the answer (Huddles doesn't return when it was given)
  decision_event INTEGER     -- the grant_events row the answer made, when it was applied
);
CREATE INDEX grant_asks_open ON grant_asks (state, grant_id);
-- One open ask per grant. A run claims it (ask_id claim_…) before posting, so overlapping runs
-- can't post two asks for one request.
CREATE UNIQUE INDEX grant_asks_one_open ON grant_asks (grant_id) WHERE state = 'open';

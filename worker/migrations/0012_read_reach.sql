-- The distinct keys each caller token read in the alert window (alerts.ts bulk-read), one row per
-- (actor, scope/name): bounded by the keys a token reaches, however many reads it makes.
CREATE TABLE read_reach (
  actor    TEXT NOT NULL,
  key      TEXT NOT NULL,
  first_at TEXT NOT NULL,
  PRIMARY KEY (actor, key)
);

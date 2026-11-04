-- The distinct keys each caller token read in the alert window (alerts.ts bulk-read), one row per
-- (token, scope/name): bounded by the keys a token reaches, however many reads it makes. `token` is
-- the token's hash, not its name, so a replacement under the same name starts at zero.
CREATE TABLE read_reach (
  token    TEXT NOT NULL,
  key      TEXT NOT NULL,
  last_at TEXT NOT NULL,
  PRIMARY KEY (token, key)
);
CREATE INDEX read_reach_last_at ON read_reach (last_at);

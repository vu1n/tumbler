-- A grant belongs to the token that opened it, by that token's hash, not by its name: a name can be
-- reused once its token has ended (the old row moves to an archived name), and a grant must never
-- pass to the token that took the name. `caller` stays as the name it had, for lists and the audit.
ALTER TABLE grants ADD COLUMN token_hash TEXT;
-- Every live grant's name is held by the token that opened it (a name is reused only after its
-- grants end), so the name's current row is the right one. Ended grants take the same, which no
-- query reads: every grant query is on live grants.
UPDATE grants SET token_hash = (SELECT hash FROM tokens t WHERE t.name = grants.caller);
DROP INDEX grants_one_live;
CREATE UNIQUE INDEX grants_one_live ON grants (token_hash, COALESCE(project, ''), name) WHERE state IN ('pending', 'active');
-- The old Worker keeps serving between this migration and the deploy, and it inserts grants with no
-- token_hash; every grant must carry its token's hash or revoking that token misses it.
CREATE TRIGGER grants_token_hash AFTER INSERT ON grants WHEN NEW.token_hash IS NULL
BEGIN
  UPDATE grants SET token_hash = (SELECT hash FROM tokens t WHERE t.name = NEW.caller) WHERE id = NEW.id;
END;

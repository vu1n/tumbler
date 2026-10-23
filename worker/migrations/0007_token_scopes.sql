-- A token carries its ceiling: the minted scopes it may hold beyond reads (JSON array, `*` = any;
-- NULL = reads only). Inside it a child is minted at once; outside it the request is refused. It
-- replaces per-request approval. The approvals and grant_asks tables stay for now: deploy migrates
-- before the new Worker is live, and the old one still reads them. A later migration drops them.
ALTER TABLE tokens ADD COLUMN scopes TEXT;

-- Carry over what was already allowed, so nothing that worked yesterday is refused today: a token
-- keeps every write scope a live standing approval or an active grant gave it, on a key revision
-- that still exists (a rotation or delete had already ended its use). Reads are matched
-- case-sensitively, as autoApproved() does, and a key scope literally named `*` is not carried over:
-- in a ceiling `*` means every scope.
WITH carried (caller, v) AS (
  SELECT a.caller, j.value FROM approvals a
    JOIN keys k ON k.scope = a.key_scope AND k.name = a.name AND k.rev = a.key_rev, json_each(a.scopes) j
    WHERE a.ended_at IS NULL AND a.until > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  UNION
  SELECT g.caller, j.value FROM grants g
    JOIN keys k ON k.scope = g.key_scope AND k.name = g.name AND k.rev = g.key_rev, json_each(g.scopes) j
    WHERE g.state = 'active' AND g.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
), writes AS (SELECT DISTINCT caller, v FROM carried WHERE substr(v, -5) != ':read' AND v != '*')
UPDATE tokens SET scopes = (SELECT json_group_array(v) FROM (SELECT v FROM writes WHERE caller = tokens.name ORDER BY v))
WHERE revoked_at IS NULL AND EXISTS (SELECT 1 FROM writes WHERE caller = tokens.name);

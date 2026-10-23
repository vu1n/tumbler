-- A token carries its ceiling: the minted scopes it may hold beyond reads (JSON array, `*` = any;
-- NULL = reads only). Inside it a child is minted at once; outside it the request is refused. It
-- replaces per-request approval. The approvals and grant_asks tables stay for now: deploy migrates
-- before the new Worker is live, and the old one still reads them. A later migration drops them.
ALTER TABLE tokens ADD COLUMN scopes TEXT;

-- Carry over what was already allowed, so nothing that worked yesterday is refused today: a token
-- keeps every write scope a live standing approval or an active grant gave it. Reads are matched
-- case-sensitively, as autoApproved() does, and a key scope literally named `*` is not carried over:
-- in a ceiling `*` means every scope.
UPDATE tokens SET scopes = (
  SELECT json_group_array(v) FROM (
    SELECT DISTINCT j.value AS v FROM approvals a, json_each(a.scopes) j
      WHERE a.caller = tokens.name AND a.ended_at IS NULL AND a.until > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    UNION
    SELECT j.value FROM grants g, json_each(g.scopes) j
      WHERE g.caller = tokens.name AND g.state = 'active' AND g.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    ORDER BY 1
  ) WHERE substr(v, -5) != ':read' AND v != '*'
)
WHERE revoked_at IS NULL AND (
  EXISTS (SELECT 1 FROM approvals a, json_each(a.scopes) j WHERE a.caller = tokens.name AND a.ended_at IS NULL
            AND a.until > strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AND substr(j.value, -5) != ':read' AND j.value != '*')
  OR EXISTS (SELECT 1 FROM grants g, json_each(g.scopes) j WHERE g.caller = tokens.name AND g.state = 'active'
            AND g.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AND substr(j.value, -5) != ':read' AND j.value != '*'));

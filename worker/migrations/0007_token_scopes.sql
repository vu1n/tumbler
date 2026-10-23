-- A token carries its ceiling: the minted scopes it may hold beyond reads (JSON array, `*` = any;
-- NULL = reads only). Inside it a child is minted at once; outside it the request is refused. It
-- replaces per-request approval. The approvals and grant_asks tables stay for now: deploy migrates
-- before the new Worker is live, and the old one still reads them. A later migration drops them.
ALTER TABLE tokens ADD COLUMN scopes TEXT;

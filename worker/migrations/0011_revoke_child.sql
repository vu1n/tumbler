-- A queued delete keeps the child it deletes, sealed as the grant held it (AAD `grant:<id>`), for a
-- provider that revokes a child only with the child itself (GitHub installation tokens). The row
-- goes once the delete succeeds or the child expires.
ALTER TABLE pending_revokes ADD COLUMN grant_id TEXT;
ALTER TABLE pending_revokes ADD COLUMN iv BLOB;
ALTER TABLE pending_revokes ADD COLUMN ciphertext BLOB;

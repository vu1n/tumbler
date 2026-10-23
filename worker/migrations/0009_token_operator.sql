-- An operator token may add or remove permission groups on a minted key's scopes from the CLI
-- (`tumbler scope`), so an agent can make that change on a person's word in chat. It never creates
-- tokens, changes ceilings, pins or writes, or touches a parent: those stay with /admin. Off for
-- every token made before this.
ALTER TABLE tokens ADD COLUMN operator INTEGER NOT NULL DEFAULT 0;

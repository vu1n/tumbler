-- A delegate token may create caller tokens from the CLI (`tumbler token create`), so an agent can hand
-- a new deployment its own token without a person's sign-in. Each one it makes records it as parent,
-- is never wider than it (pin, scopes, writes, expiry), is never an operator or delegate itself, and
-- stops working when the parent does. Off for every token made before this.
ALTER TABLE tokens ADD COLUMN delegate INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tokens ADD COLUMN parent TEXT;

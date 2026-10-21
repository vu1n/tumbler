-- An optional end of life for a caller token. NULL keeps it until revoked. Checked on every
-- request (Catalog.caller), so an expired token stops working without waiting for the sweep.
ALTER TABLE tokens ADD COLUMN expires_at TEXT;

-- A caller token row can be bound to an OIDC issuer and subject (oidc.ts): then a token that issuer
-- signed for that subject (exact, or a `prefix*`) acts as the row, and the row's own secret stops
-- working. NULL for every token made before this, which keep working as they are.
ALTER TABLE tokens ADD COLUMN oidc_issuer TEXT;
ALTER TABLE tokens ADD COLUMN oidc_subject TEXT;
CREATE INDEX tokens_oidc ON tokens (oidc_issuer) WHERE oidc_issuer IS NOT NULL;
-- The OIDC subject a federated caller proved, beside its token's name in `actor`.
ALTER TABLE audit ADD COLUMN via TEXT;

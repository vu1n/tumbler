-- A mint:cloudflare key saved with no config had DEFAULT_SCOPES frozen into it as ids, so a later
-- change to the defaults (Containers on workers:write) never reached it. Mark such keys
-- `"defaults": true`: mint() then looks DEFAULT_SCOPES up by name each time. A key is taken as
-- saved with defaults when its scopes are exactly workers:read and workers:write with the four
-- groups each that the defaults had before; any other config is left as it is.
UPDATE keys SET config = json_set(config, '$.defaults', json('true'))
  WHERE kind = 'mint:cloudflare' AND json_valid(config)
    AND (SELECT count(*) FROM json_each(config, '$.scopes')) = 2
    AND json_array_length(config, '$.scopes."workers:read"') = 4
    AND json_array_length(config, '$.scopes."workers:write"') = 4;

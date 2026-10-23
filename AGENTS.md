# Agent notes

- This repo holds secrets infrastructure. Never print, log or test with a real key value; tests use
  fixed fake keys and strip same-named vars from the environment.
- Values are write-only outside `/v1/env`: no admin route, log line or audit row may contain one.
- A `mint:*` key's value is a parent credential: it only ever reaches a `Provider`, never a caller.
  Only an `active` grant yields a child, and no failure may fall back to a wider one.
- A caller token's scopes are its approval: a mint carries reads and what the token allows, and
  machine.ts refuses anything beyond that. Nothing waits for a person; a scope outside the token's
  scopes is refused. store() rechecks the token's scopes when the child lands, so narrowing wins.
- A grant's state changes only through `Grants.apply()`, which runs `transition()` (machine.ts) and
  appends the event in the same batch. Don't write `UPDATE grants` anywhere else.
- A key check's result is a status and an HTTP code; never a response body or error text, which can
  quote the value. `--watch` pushes only values that passed their check on save.
- The project a caller reads comes from its token's pin, never from the request. Keep it that way.
- A caller token writes (`PUT /v1/keys/NAME`) only static keys, only in a scope its `writes` reach, and
  `global` only when named. It never sets or rotates a minted key's parent.
- `cli/tumbler` is bundled into the Worker as text (wrangler `rules`) and served at `/cli`; it must
  stay a single dependency-free file.
- Run `cd worker && npm test && npm run typecheck` before committing.

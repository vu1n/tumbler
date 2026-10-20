# Agent notes

- This repo holds secrets infrastructure. Never print, log or test with a real key value; tests use
  fixed fake keys and strip same-named vars from the environment.
- Values are write-only outside `/v1/env`: no admin route, log line or audit row may contain one.
- A `mint:*` key's value is a parent credential: it only ever reaches a `Provider`, never a caller.
  Only an `active` grant yields a child, and no failure may fall back to a wider one.
- The project a caller reads comes from its token's pin, never from the request. Keep it that way.
- `cli/tumbler` is bundled into the Worker as text (wrangler `rules`) and served at `/cli`; it must
  stay a single dependency-free file.
- Run `cd worker && npm test && npm run typecheck` before committing.

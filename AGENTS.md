# Agent notes

- This repo holds secrets infrastructure. Never print, log or test with a real key value; tests use
  fixed fake keys and strip same-named vars from the environment.
- Values are write-only outside `/v1/env`: no admin route, log line or audit row may contain one.
- A `mint:*` key's value is a parent credential: it only ever reaches a `Provider`, never a caller.
  Only an `active` grant yields a child, and no failure may fall back to a wider one.
- Only an admin makes an approval, standing or not. A mint nobody approved just now is `policy`
  (reads) or `standing` (what a live approval covers), and machine.ts refuses either beyond that.
- A Huddles answer approves only when tumbler read it back itself (asks.ts): the ask it posted for
  that grant, answered by the human its credential acts for. Never act on room text.
- A grant's state changes only through `Grants.apply()`, which runs `transition()` (machine.ts) and
  appends the event in the same batch. Don't write `UPDATE grants` anywhere else.
- A key check's result is a status and an HTTP code; never a response body or error text, which can
  quote the value. `--watch` pushes only values that passed their check on save.
- The project a caller reads comes from its token's pin, never from the request. Keep it that way.
- `cli/tumbler` is bundled into the Worker as text (wrangler `rules`) and served at `/cli`; it must
  stay a single dependency-free file.
- Run `cd worker && npm test && npm run typecheck` before committing.

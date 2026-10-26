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
- A caller token writes (`PUT` or `DELETE /v1/keys/NAME`) only static keys, only in a scope its `writes` reach, and
  `global` only when named. It never sets or rotates a minted key's parent.
- `tumbler admin` reaches `/admin/api` only through a Cloudflare Access session (cloudflared), never a
  caller token: an admin can mint any token, so admin stays tied to a person.
- The one way a caller token creates tokens is `delegate` (set by an admin): `tumbler token create`
  makes a token no wider than the delegate (catalog.ts beyond(): pin, scopes, writes, expiry), never
  an operator or delegate, always expiring, recorded with `parent`. caller() refuses it once its
  parent is revoked or expired; narrowing the parent ends the ones that no longer fit. Never let a
  delegate take over another token's name or widen what it made.
- The one admin power a caller token can hold is `operator` (set by an admin): `tumbler scope` adds
  or removes permission groups on the minted keys the token reads, on the person's word in chat.
  Additions live in the key's `config.extra`, on top of the admin's config, and never include token,
  member, account settings or billing groups, or writes on a `:read` scope (cloudflare.ts
  UNDELEGABLE). Keep it that narrow: no token, ceiling, pin, writes or parent changes through it.
- A fix must roll out with no manual step: a migration or code that applies itself, or at most a CLI
  command an agent runs. Never a trip to /admin or re-entering a secret.
- `cli/tumbler` is bundled into the Worker as text (wrangler `rules`) and served at `/cli`; it must
  stay a single dependency-free file.
- Run `cd worker && npm test && npm run typecheck` before committing.

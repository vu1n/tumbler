# tumbler

One store for env vars and API keys, for agent sessions and anywhere else you run code.

- **Broker:** a Cloudflare Worker. Values are AES-GCM sealed under one master key held in
  Cloudflare Secrets Store, and stored in D1. A project row overrides the global row of the same name.
- **Tokens:** each caller token is pinned to the projects it may read, or reads global keys only.
  The project comes from the token, never from the request.
- **CLI:** `tumbler run -- <cmd>` fetches what the command needs, injects it into that process only,
  and keeps a short in-memory cache. Nothing is written to disk. Rotating a key in the broker
  reaches every session within the cache TTL (5 minutes by default) or on `tumbler reload`.
- **Admin page:** `/admin`, behind Cloudflare Access. Values are write-only there. To load many
  static keys at once, paste a `.env` file: it previews which keys it creates, overwrites or skips
  (minted keys are never overwritten) before anything is saved.

The design and the reasons behind it: why not setup scripts, why not an encrypted `.env`, how network
secrets fit. See [docs/design.md](docs/design.md).

## Deploy

```sh
cd worker && npm install
# 1. Set up and deploy, from your own machine. The first run creates the master key in the
#    account's Secrets Store and saves a backup to ~/tumbler-master-key.txt: move that into your
#    password manager and delete the file. It also creates the D1 database and applies migrations.
#    Run the same command again for every later deploy.
npm run deploy
# 2. Protect /admin with Cloudflare Access (Zero Trust > Access > Applications > Self-hosted,
#    path /admin*, allow your email), then set the Worker's vars:
#    ACCESS_TEAM_DOMAIN=<team>.cloudflareaccess.com  ACCESS_AUD=<the application's AUD tag>
#    TUMBLER_ADMINS=<your email>
```

Nothing account-specific lives in the repo: the store id is looked up at deploy time
(`TUMBLER_STORE_ID` overrides it) and the vars above stay on the Worker across deploys.

The admin API checks the Access JWT itself, so a gap in the Access policy (or a request straight to
`*.workers.dev`) still can't reach it. Losing the master key loses every value: keep a copy offline.

## Use it from a Claude cloud environment

1. In `/admin`, create a token pinned to the project (or with no pin, for global keys only). It's
   shown once.
2. On the environment, add the token as a **network secret** for the broker's host (`Authorization`,
   prefix `Bearer`). The session never sees the token: the agent proxy adds it on the way out.
3. Make the environment's setup script one line: `curl -fsSL https://tumbler.example.com/setup | bash`.
   The broker serves [scripts/setup.sh](scripts/setup.sh) with its own URL filled in. It installs the
   CLI, installs `wrangler` if it's missing, shims `wrangler` (and `aws` and `tailscale` when installed), sets `TUMBLER_URL` for sessions, and tells agents
   to use `tumbler run`. If anything fails, it skips and the session still starts.
4. Remove the old secrets from the environment's variables.

A different project gets its own environment with its own pinned token.

A token can carry an expiry (set "expires in hours" when you create it; `tumbler whoami` shows it),
for a pilot or anything else time-bound. From that moment the broker refuses it, and the next sweep
(every five minutes) ends the grants it holds and deletes their children at the provider. Expiry
can't take back what was already handed out: a static value a command received stays valid until you
rotate it, and a CLI's cache can hold values it fetched before the expiry for up to its TTL. Tokens
without an expiry live until revoked.

Elsewhere (your laptop, CI), set `TUMBLER_URL` and `TUMBLER_TOKEN` instead of the network secret.

## CLI

```
tumbler run [-p project] [-k A,B] [--scope a,b] [--retry] [--watch] [--clean [--pass A,B]] -- <cmd> [args...]
tumbler keys [-p project]     names you can read, never values
tumbler whoami                the token's name and pin
tumbler auto [--dry-run]      work out which keys this repo needs; write .tumbler
tumbler reload                drop the cache
tumbler shim <tool>...        wrappers so <tool> always runs under tumbler
```

A `.tumbler` file in a repo lists the key names it needs (one per line) and optionally
`project = <name>`. Without one, `run` calls `tumbler auto` first and writes it, so the command gets
only the keys the repo needs. Auto writes a `project =` line only when you name one (`-p`,
`TUMBLER_PROJECT`), never the pin of the token that ran it: a token pinned to one project reads it
without the line, and a line naming another project would make the broker refuse every other token. Commit the file so the set is reviewed like code. A failure never widens
the set: if auto can't reach the broker the command doesn't start, and if `.tumbler` can't be written
(a read-only checkout) the command runs with just the picked keys. `TUMBLER_AUTO=off` skips auto and
fetches every key the token can read.

The picked keys are added to the environment `run` was started in, so a credential already exported in
that shell still reaches the command. `--clean` starts the command from a runtime allowlist instead
(`PATH`, `HOME`, locale, temp dirs, `XDG_*`, proxy and CA-bundle settings, `TUMBLER_URL`) plus its keys,
and `--pass A,B` lets named variables through as well. `TUMBLER_TOKEN` isn't on the list, so a shimmed
tool inside a clean command needs the network secret or `--pass TUMBLER_TOKEN`. It filters the
environment only: the command can still read a dotenv file or a credentials directory such as
`~/.aws`.

### When keys change

Keys are pulled: `run` fetches them as the command starts (through the 5-minute cache), and nothing
changes inside a running command unless you ask for it.

- **Checks on save.** A key can carry a check, and then a new value is tested against its service
  before it replaces the old one. If the test fails, or can't reach the service, nothing is saved and
  the old value keeps working. Minted keys are checked by their provider (Cloudflare's
  `tokens/verify`). A static key names one in its config: a preset (`{"check": "openai"}`, also
  `anthropic`, `github`, `stripe`, `cloudflare`), or `{"check": {"url": "https://…", "header":
  "authorization", "prefix": "Bearer "}}`. Only https URLs are allowed, and redirects aren't
  followed, because the value is sent there. If the service can't be reached, `/admin` offers to
  save anyway (`skip_check: true`), so a leaked key can still be replaced during an outage. A value
  saved that way is marked unchecked. A value the service rejects (401) is never saved. A 403 counts
  as inconclusive, since it can mean a scoped key without access to the check endpoint.
- **When a command fails**, `run` refetches its keys, skipping the cache, and runs each key's check on
  the current value. It then reports which keys changed since the command started, and which pass or
  fail their check. When every checked key passes and none changed, it says the failure is probably
  not a key problem. A minted key is checked through its parent, and the report says so. Names and
  statuses only, never values. `TUMBLER_DIAGNOSE=off` turns this off. A command you stopped (Ctrl-C,
  or a SIGTERM to tumbler) gets no report and is never rerun or restarted.
- **`--retry`** reruns the command once with the new values, and only when a key changed. If nothing
  changed, rerunning would fail the same way.
- **`--watch`** is for long-running commands. It polls the keys' revisions every `TUMBLER_WATCH`
  seconds (30), and when a key changes whose new value passed its check on save, it restarts the
  command with that value. A key saved without a check is reported and never pushed. If the restarted
  command exits non-zero within `TUMBLER_WATCH_GRACE` seconds (10), it goes back to the previous
  values. A restart stops only the command itself, so a process it started (`sh -c`, `npm`) can
  outlive it. `--watch` follows saved values. It does not follow a minted child's expiry, so a command
  that outlives the child still needs restarting.

### How `auto` picks keys

The CLI sends the broker the repo's file paths (three levels deep) and dependency names from
`package.json`, `requirements*.txt`, `pyproject.toml` (with its optional extras, dependency groups and
Poetry tables), `go.mod` and `Cargo.toml`. It never sends file
contents or values. The broker then:

1. **Rules:** known signals map to key prefixes. For example, `wrangler.jsonc` maps to `CLOUDFLARE_*`
   and `@aws-sdk/*` or `boto3` maps to `AWS_*` (see `worker/src/auto.ts`).
2. **Clef:** for the caller's keys the rules didn't pick, it asks Clef (System One on Workers AI)
   one yes/no question per key, using the key's catalog description. It keeps a key at 0.7 or above.
   Good descriptions are what Clef matches on. Errors and timeouts add nothing.

Picks can only name keys the token can already read, so a wrong guess means a missing or extra key,
never wider access. Without the `AI` binding, auto uses the rules only.

`TUMBLER_TTL` (seconds, default 300, `0` disables the cache). The cache is a helper process on a
private unix socket (`$XDG_RUNTIME_DIR/tumbler` or `~/.cache/tumbler`, mode 0700) that exits after
30 minutes unused. It is keyed by broker and token, so one token never gets another's values. The
socket's name carries a hash of the CLI, so after an upgrade the new CLI starts its own helper and
never reads from one an older version started; the old one exits once idle. An
env holding a minted key is cached at most 5 minutes whatever `TUMBLER_TTL` says, so a cached child
is never handed out past its expiry.

## Minted keys (`mint:cloudflare`)

A key of kind `mint:cloudflare` doesn't hand out its value. The value is a **parent** Cloudflare
token, and every caller gets its own short-lived **child** token with only the scopes it was granted.
The parent never leaves the broker.

Set one up in `/admin`:
1. Save your account id as a static key, `CLOUDFLARE_ACCOUNT_ID`. Wrangler reads it too.
2. Create an **account-owned** Cloudflare token (Manage Account > Account API Tokens, not My
   Profile) with **Account API Tokens: Edit**: it can create other tokens and nothing else.
3. Save it as `CLOUDFLARE_API_TOKEN` with kind `mint:cloudflare`. Just the token: with no config,
   callers get `workers:read` (Workers Scripts, D1, KV and R2 read; granted on request) and
   `workers:write` (the same four, write; waits for your approval), children last 30 minutes, and
   the token is used to look up each permission's id on your account as it's saved.

To choose other scopes, give a config. Scope names are yours; each lists Cloudflare account
permissions, by name (as the dashboard shows them) or by id:

```json
{ "ttl_minutes": 30, "start": ["workers:read"],
  "scopes": { "workers:read": ["Workers Scripts Read"], "pages:write": ["Pages Write"] },
  "ip": ["203.0.113.0/24"] }
```

`account_id` is optional when `CLOUDFLARE_ACCOUNT_ID` is saved. A name Cloudflare doesn't list for
the account refuses the save, and names are stored as ids, which don't change.

Each caller holds one **grant** per minted key, and its state decides what the env var holds:

| State | `CLOUDFLARE_API_TOKEN` in the command |
|---|---|
| pending (waiting for you in `/admin`) | not set: the command doesn't start |
| active | a child with exactly the grant's scopes |
| active, with a step-up waiting | the old, narrower child |
| denied, expired, revoked | not set: the next run starts a new grant |

- A scope named `<thing>:read` is granted on request. Any other scope waits for approval in `/admin`
  (Grants), and an unanswered request lapses to denied after a day.
- `tumbler run --scope workers:write -- wrangler deploy` asks for more. Until you approve, the
  command doesn't start. After you approve, the same command runs with a wider child, and the narrower
  child is deleted at Cloudflare.
- Children expire after `ttl_minutes` (15 to 1440, default 30). A child is handed out again only
  while it has more than 6 minutes left, which keeps the CLI's 5-minute cache from holding an
  expired one. So approval lasts `ttl_minutes` minus 6, and after that a write scope needs approving
  again. A cron every five minutes expires grants and deletes their children at Cloudflare.
- Approve mints exactly the request shown on the page. If the caller asked for more since then,
  approval is refused until you reload.
- Revoke deletes the child at once (a delete Cloudflare rejects is queued, retried every five minutes
  until the child expires, and shown on the Grants tab). For a day after that, that caller's next grant on the key waits
  for approval, even for reads. Revoking a caller token ends all of its grants. Deleting a minted key,
  or saving a new parent or config, ends its grants. Old parents are kept sealed for a day, so a
  child they minted can always be revoked.
- Failures never widen anything. A Cloudflare error, a pending or denied grant, or a broker that
  can't be reached all mean the command gets no token. No failure falls back to the parent or to a
  broader child.
- Rotating the parent keeps the key's kind. A minted key can't be turned static, because that would
  hand its parent out; delete it and add it again instead.

Other providers plug in as a `Provider` (`mint`, `revoke`, `validate` and optionally `verify` in
`worker/src/grants.ts`). The state machine is the same for each. It lives in `worker/src/machine.ts`
as one pure function, `transition(grant, event)`. Every change is written along with its event in
`grant_events`, an append-only log (`GET /admin/api/grants/:id/events` shows a grant's history).

## API

| Route | Auth | |
|---|---|---|
| `GET /v1/env?project=&keys=A,B` | caller token | `{"env": {...}}`, project over global; unknown names are a 404 |
| `GET /v1/whoami` | caller token | `{"name", "projects"}` |
| `POST /v1/auto?project=` | caller token | body `{"signals": ["file:…", "dep:…"]}`; returns `{"project", "keys": [{"name", "why"}]}` |
| `GET /v1/keys?project=` | caller token | `{"project", "keys": [names]}`; never values, never mints |
| `POST /v1/step-up?project=` | caller token | body `{"keys": [...], "scopes": [...]}`; returns each minted key's grant state |
| `POST /v1/check?project=` | caller token | body `{"keys": [...]}`; runs each key's check on its current value: `{"checks": {"A": {"status": "ok"\|"invalid"\|"error"\|"none"}}}` |
| `GET /v1/revs?project=&keys=A,B` | caller token | `{"keys": {"A": {"rev", "checked"}}}`; a new rev on every save; never values, never mints |
| `GET /cli` | none | the CLI script (no secrets in it) |
| `/admin`, `/admin/api/{keys,tokens,grants,audit}` | Cloudflare Access | writes also need `x-tumbler-admin: 1`; `POST grants/:id/approve` or `/deny`, `DELETE grants/:id` revokes, `GET grants/:id/events` |

Every read and change is audited by key name, never by value.

## Not in this slice

Providers beyond Cloudflare (AWS STS, GitHub App tokens, OpenRouter, Tailscale), and moving static
keys and a repo's `.tumbler` set onto grants, so a new key in the set waits for approval too.

## Develop

```sh
cd worker && npm test && npm run typecheck
```

Tests run in plain node over a sqlite stand-in for D1, including the CLI end to end against the real
routes.

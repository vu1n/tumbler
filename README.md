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
#    Run the same command again for every later deploy. From an agent session, run it on a
#    workers:write child: tumbler run --scope workers:write -- npm run deploy
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

1. In `/admin`, create a token pinned to the project (or with no pin, for global keys only), and
   pick what it may mint (Read + deploy for an agent that runs `wrangler deploy`). It's shown once.
2. On the environment, add the token as a **network secret** for the broker's host (`Authorization`,
   prefix `Bearer`). The session never sees the token: the agent proxy adds it on the way out.
3. Make the environment's setup script one line: `curl -fsSL https://tumbler.example.com/setup | bash`.
   The broker serves [scripts/setup.sh](scripts/setup.sh) with its own URL filled in. It installs the
   CLI, installs `wrangler` if it's missing, shims `wrangler` (and `aws` and `tailscale` when installed), sets `TUMBLER_URL` for sessions, and tells agents
   to use `tumbler run`. If anything fails, it skips and the session still starts.
4. Remove the old secrets from the environment's variables.

A different project gets its own environment with its own pinned token.

A token's pin is edited in place: click it in `/admin`'s token list and name the projects it reads
(empty = global keys only). The same token, still held as the same network secret, reaches a project
the moment it's added, and the children it holds for a project that's removed are ended at once. A
token pinned to one project reads it by default; one pinned to several reads global keys only until a
command names one of them (`-p`, `TUMBLER_PROJECT`, or a repo's `.tumbler`), so one agent token can
serve many repos and each repo's `.tumbler` picks its project.

A scope is `global`, a project (`huddles`), or one of its environments. Environments follow
Infisical's model, a fixed set: `huddles/dev`, `huddles/staging`, `huddles/prod`. An environment reads
its own keys first, then its project's shared keys, then global ones, so shared keys go on the project
and only what differs goes on each environment.

A token's pin lists what it reads beyond global keys: a project (its shared keys), `project/env` (one
environment of it), `*` (every project's shared keys, including projects added later) or `*/env` (that
environment of every project). An environment is always granted by name, so a token without `prod` in
its pin never reaches a prod key. `/admin` shows a pin in words and offers presets:

| preset | pin | reads |
|---|---|---|
| Everything | `*, */dev, */staging, */prod` | all projects (shared, dev, staging, prod) |
| All projects, dev (an agent like Claude dev) | `*, */dev` | all projects (shared, dev) |
| Global only | empty | global keys |

Per project works too, as with an Infisical project role: `huddles/prod, kypp/dev`. A token whose pin is
one project or one environment reads it by default; any other reads global keys until a command names a
scope (`-p`, `TUMBLER_PROJECT`, or a repo's `.tumbler`).

To turn a flat project into an environment (`huddles-dev` into `huddles/dev`), use Move in `/admin`
(`POST /admin/api/scopes/move {"from", "to"}`). It reseals every key under the new scope without
re-entering values, moves each token that read the old scope to the new one (a `*` token gets the
environment named, so its reach doesn't change), and ends the minted children on the moved keys (the
next read mints fresh ones). The old name stops resolving, so change `project =` in any `.tumbler`
that names it. Until you move it, a flat project such as `huddles-dev` keeps working as before.

A token can carry an expiry (set "expires in hours" when you create it; `tumbler whoami` shows it),
for a pilot or anything else time-bound. From that moment the broker refuses it, and the next sweep
(every five minutes) ends the grants it holds and deletes their children at the provider. Expiry
can't take back what was already handed out: a static value a command received stays valid until you
rotate it, and a CLI's cache can hold values it fetched before the expiry for up to its TTL. Tokens
without an expiry live until revoked.

Elsewhere (your laptop, CI), set `TUMBLER_TOKEN` instead of the network secret. The CLI asks for the
broker's URL the first time it needs one and saves it (`~/.config/tumbler/url`); `tumbler url <URL>`
sets it outright, and an exported `TUMBLER_URL` wins over both. When the broker serves a different
CLI than the one you're running, the CLI says so once; `tumbler update` replaces it in place
(`TUMBLER_UPDATE_CHECK=off` quiets the notice).

## CLI

```
tumbler run [-p project] [-k A,B] [--scope a,b] [--retry] [--watch] [--clean [--pass A,B]] -- <cmd> [args...]
tumbler keys [-p project]     names you can read, never values
tumbler whoami                the token's name and pin
tumbler auto [--dry-run]      work out which keys this repo needs; write .tumbler
tumbler reload                drop the cache
tumbler shim <tool>...        wrappers so <tool> always runs under tumbler
tumbler put NAME [-p project | --global] [--from-file F | --clipboard] [-d desc]
                              save a static key (hidden prompt, pipe, file or clipboard)
tumbler rm NAME [-p project | --global]
                              delete a static key
tumbler admin <command>       what /admin does, signed in through Cloudflare Access
tumbler ssh-keygen NAME [-p project | --global] [-C comment]
                              make an ed25519 keypair, save the private key, print the public one
tumbler url [URL]             print or save the broker's URL
tumbler update                replace this CLI with the broker's current one
```

### Admin from the CLI

Everything `/admin` does is also `tumbler admin <command>`, signed in as you through Cloudflare Access,
never with a caller token: an admin can mint any token, so admin stays tied to an email in
`TUMBLER_ADMINS`. `tumbler admin login` runs `cloudflared access login` against `/admin` once; later
commands ask cloudflared for the session and pass it to curl on stdin, and Access checks it at the edge
as it does for the page.

```
tumbler admin keys | tokens | grants | audit [--json]
tumbler admin token create NAME [--pin a,b] [--scopes a,b] [--writes a,b] [--expires-hours N] [--store KEY --scope S]
tumbler admin token edit NAME [--pin a,b] [--scopes a,b] [--writes a,b]
tumbler admin token revoke NAME
tumbler admin put NAME --scope S [--kind mint:cloudflare] [--config JSON] [--from-file F | --clipboard] [--skip-check]
tumbler admin rm NAME --scope S
tumbler admin import FILE --scope S [--save]
tumbler admin move FROM TO
tumbler admin grant revoke ID
```

`token create` prints the token once on stdout, so `tumbler admin token create ci --pin kypp | gh secret
set TUMBLER_TOKEN` never shows it. To hand a token to a machine that reads tumbler (a VPS service),
`--store KEY --scope S` puts it straight into that static key instead of stdout; if the store fails the
token is revoked, so a broken pipe never leaves a working token nobody holds. `admin put` takes its value the way `put` does, and is the CLI's way
to set a minted key's parent.

### Tokens an agent makes (delegate)

An admin can mark a token as a **delegate** (`tumbler admin token edit NAME --delegate on`). From a
session holding it, `tumbler token create vps --pin pr-review --store VPS_TUMBLER_TOKEN -p pr-review`
makes a token for a new deployment without anyone's laptop. It can never be wider than the delegate
(its pin, scopes and writes, and its expiry), is never an operator or delegate itself, expires (30
days by default, at most 90), and stops working when the delegate is revoked or expires. Narrowing
the delegate ends the tokens it made that no longer fit. `tumbler token list` and
`tumbler token revoke NAME` cover only the delegate's own tokens.

### Writing keys from the CLI

A token writes nothing until an admin gives it **writes** in `/admin` (the token list's "May write"
column, or `writes` on `POST`/`PATCH /admin/api/tokens`): `global`, a project, `project/env`, `*` or
`*/env`, as in a pin. `global` is never implied by `*`, since a global key reaches every token, and an
environment is named, as in a pin. Writes are separate from the pin: a laptop token can write `global`
while reading nothing beyond it.

`tumbler put NAME` saves a static key within them, like `wrangler secret put`. The value comes from
`--from-file`, `--clipboard` (pbpaste, wl-paste, xclip or xsel), piped stdin (`op read ... | tumbler put
NAME`), or a hidden prompt at a terminal, where a multi-line paste such as a private key comes through
whole. It is never an argument, and it travels to curl on stdin, so it never shows in `ps`. A
single-line value loses its trailing newline; a multi-line one is kept exactly. The scope is `-p`, then
`TUMBLER_PROJECT` or `.tumbler`'s project, then the token's one project; `--global` names global. A key
that has a check keeps it, so a value that fails saves nothing, and a minted key's parent is changed in
`/admin` only. `tumbler rm NAME` deletes a static key under the same writes and default scope.

`tumbler ssh-keygen NETCUP_VPS_SSH_KEY --global` makes an ed25519 keypair in memory, saves the private
key in OpenSSH format and prints the public key, so nothing private touches disk:
`tumbler ssh-keygen NAME --global > key.pub && ssh-copy-id -f -i key.pub root@host`.

A `.tumbler` file in a repo lists the key names it needs (one per line) and optionally
`project = <name>`. Without one, `run` calls `tumbler auto` first and writes it, so the command gets
only the keys the repo needs. Auto writes a `project =` line only when you name one (`-p`,
`TUMBLER_PROJECT`), never the pin of the token that ran it: a token pinned to one project reads it
without the line, and a line naming another project would make the broker refuse every other token. The file auto
writes is listed in the repo's `.git/info/exclude`, so it never shows up in a change and nobody has to
review or commit it, and a fresh checkout picks again on its first `run`. Commit one only when you
want a repo to pin its set. A failure never widens
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
   callers get `workers:read` (Workers Scripts, D1, KV, R2, Containers, Queues, Pages, Hyperdrive and Vectorize read, and account analytics) and `workers:write`
   (the same, write, plus Workers Tail and Secrets Store, so `wrangler deploy` can push a Worker's
   container image, wire a queue or bind a Secrets Store secret; for tokens whose scopes allow it; a group the account doesn't list is left out), children last 30 minutes, and the token is used to look up each permission's id
   on your account as it's saved. A key saved this way follows the defaults: each mint looks them up
   by name again, so a later change to them reaches it with nothing to re-save.

To choose other scopes, give a config. Scope names are yours; each lists Cloudflare account
permissions, by name (as the dashboard shows them) or by id:

```json
{ "ttl_minutes": 30, "start": ["workers:read"],
  "scopes": { "workers:read": ["Workers Scripts Read"], "pages:write": ["Pages Write"] },
  "ip": ["203.0.113.0/24"] }
```

`account_id` is optional when `CLOUDFLARE_ACCOUNT_ID` is saved. A name Cloudflare doesn't list for
the account refuses the save, and names are stored as ids, which don't change.

**A token's scopes are its approval.** When you create a token in `/admin`, besides its pin you
say what it may mint beyond reads: nothing (Read only), `workers:write` (Read + deploy: Workers, D1, KV, R2, Containers, Queues, Pages, Hyperdrive, Vectorize and Secrets Store writes, and Workers Tail), or `*` (any
scope a key has, including ones added to a key later). You decide once, there. After that nothing waits for you:

- Reads are minted on request, for every token.
- A scope the token's scopes allow is minted at once. `tumbler run --scope workers:write -- wrangler
  deploy` gets a wider child, and the narrower one is deleted at Cloudflare. Under the `wrangler`
  shim a plain `wrangler deploy` (or `secret put`, `d1 migrations apply`, `containers push`...) asks
  for `workers:write` itself; a token that can't hold it runs the command on its read child and says
  so, instead of stopping it. `--local` and `--dry-run` stay on the read child.
- A scope outside them is refused, and the command doesn't start: `CLOUDFLARE_API_TOKEN: token dev
  may not hold workers:write. Refused; retrying won't help: ask a human to add it to this token's
  scopes in /admin`. An agent stops and asks you; you click the token's scopes in `/admin`. Narrowing them ends the children holding what they no longer allow.
- Every mint is in the audit log (token, key, scopes, time), and Grants lists the live children.

Each caller holds one **grant** per minted key, and its state decides what the env var holds:

| State | `CLOUDFLARE_API_TOKEN` in the command |
|---|---|
| pending (its first child is being minted) | not set: run again |
| active | a child with exactly the grant's scopes |
| expired, revoked | not set: the next run starts a new grant |

- Children expire after `ttl_minutes` (15 to 1440, default 30). A child is handed out again only
  while it has more than 6 minutes left, which keeps the CLI's 5-minute cache from holding an
  expired one. A cron every five minutes expires grants and deletes their children at Cloudflare.
- Revoke on a grant deletes its child at once (a delete Cloudflare rejects is queued, retried every
  five minutes until the child expires, and shown on the Grants tab). The caller's next run mints a
  new one within its token's scopes, so to cut a caller off, revoke its token or narrow its scopes.
  Revoking a caller token ends all of its grants. Deleting a minted key, or saving a new parent or
  config, ends its grants. Old parents are kept sealed for a day, so a child they minted can always
  be revoked.
- Failures never widen anything. A Cloudflare error, a refused scope, or a broker that can't be
  reached all mean the command gets no token. No failure falls back to the parent or to a broader
  child.
- Rotating the parent keeps the key's kind. A minted key can't be turned static, because that would
  hand its parent out; delete it and add it again instead.

### Changing a key's permissions from the CLI (operator tokens)

When a scope is missing a permission (a container Worker's deploy needs Containers Write), an agent
fixes it from the CLI on your word in chat, instead of you going to `/admin` or Cloudflare:

```sh
tumbler scope CLOUDFLARE_API_TOKEN                                   # its scopes and groups
tumbler scope groups CLOUDFLARE_API_TOKEN containers                 # the names Cloudflare lists
tumbler scope add CLOUDFLARE_API_TOKEN workers:write "Containers Write"
tumbler scope rm  CLOUDFLARE_API_TOKEN workers:write "Containers Write"
```

Take group names from `tumbler scope groups`, which asks Cloudflare with the key's parent, not from
Cloudflare's docs: the docs have listed names (`Containers Read`) that an account doesn't. A name
Cloudflare doesn't list is refused with the listed names nearest to it.

That needs an **operator** token, which you turn on once per token (`/admin`, or
`tumbler admin token edit NAME --operator on`). An operator only adds or removes permission groups
on the minted keys its token reads. Additions sit on top of the key's config, so your config stays
the base and only additions can be removed this way. It can't add API token, member, account
settings or billing groups (a child holding one could make its own tokens), can't add a write to a
`:read` scope (every token gets reads), and never creates tokens or changes a token's scopes, pin,
writes or a key's parent. A change ends the children holding the old groups, so the next run mints
with the new ones, and it's audited (`mint-scope`). A new scope name makes a new scope, which a
token can hold only if its own scopes allow it.

## Minted keys (`mint:github`)

A key of kind `mint:github` holds a **GitHub App's private key**, and every caller gets an
installation token: only the permissions its scopes name, only the repos the App is installed on
(or the ones `repositories` names), for an hour at most. GitHub can't mint fine-grained PATs by API;
an App can mint these.

Set one up once:
1. Create a GitHub App with the read permissions you want to hand out (at least Contents: read) and
   install it on the repos it may reach. Download its private key.
2. `tumbler admin put GITHUB_APP_ID --scope global` with the App's id.
3. `tumbler admin put GH_TOKEN --scope global --kind mint:github --from-file app.private-key.pem`.
   Just the key: the broker finds the installation (`"owner": "LOGIN"` picks one when there are
   several) and callers get `repo:read` (contents and metadata, plus pull requests, issues, Actions,
   checks and statuses read where the App has them).

To choose, give a config. Permissions are `<name>:read` or `<name>:write`, GitHub's names:

```json
{ "start": ["repo:read"], "repositories": ["pillbox", "kypp"],
  "scopes": { "repo:read": ["contents:read", "metadata:read"], "pr:write": ["pull_requests:write"] } }
```

A `:read` scope holds reads only, since every token gets it. `ttl_minutes` is at most 60. An operator
token adds permissions the installation has with `tumbler scope add`, only repository content, PR,
issue, CI, deployment, package and pages ones; secrets, variables, secret scanning, workflows,
administration and the rest stay with an admin's config. Revoking a grant stops handing
its token out at once, but GitHub revokes an installation token only when called with that token,
so it keeps working until its own expiry, within the hour.

Other providers plug in as a `Provider` (`mint`, `revoke`, `validate` and optionally `verify` in
`worker/src/grants.ts`). The state machine is the same for each. It lives in `worker/src/machine.ts`
as one pure function, `transition(grant, event)`. Every change is written along with its event in
`grant_events`, an append-only log (`GET /admin/api/grants/:id/events` shows a grant's history).

## API

| Route | Auth | |
|---|---|---|
| `GET /v1/env?project=&keys=A,B` | caller token | `{"env": {...}}`, project over global; unknown names are a 404 |
| `GET /v1/whoami` | caller token | `{"name", "projects", "scopes"}` |
| `POST /v1/auto?project=` | caller token | body `{"signals": ["file:…", "dep:…"]}`; returns `{"project", "keys": [{"name", "why"}]}` |
| `GET /v1/keys?project=` | caller token | `{"project", "keys": [names]}`; never values, never mints |
| `POST /v1/step-up?project=` | caller token | body `{"keys": [...], "scopes": [...]}`; mints within the token's scopes and returns each minted key's grant, or 403 for a scope outside them |
| `POST /v1/check?project=` | caller token | body `{"keys": [...]}`; runs each key's check on its current value: `{"checks": {"A": {"status": "ok"\|"invalid"\|"error"\|"none"}}}` |
| `GET /v1/revs?project=&keys=A,B` | caller token | `{"keys": {"A": {"rev", "checked"}}}`; a new rev on every save; never values, never mints |
| `GET`, `PATCH /v1/mint/NAME?project=` | operator token | the key the token reads: `{"scope", "name", "scopes": {"s": {"base", "extra"}}}`; `PATCH` body `{"scope", "add": [...]}` or `{"scope", "remove": [...]}` |
| `GET /cli` | none | the CLI script (no secrets in it) |
| `/admin`, `/admin/api/{keys,tokens,grants,audit}` | Cloudflare Access | writes also need `x-tumbler-admin: 1`; `POST tokens` and `PATCH tokens/:name` take `projects`, `scopes`, `writes` and `operator`; `DELETE grants/:id` revokes, `GET grants/:id/events` |

Every read and change is audited by key name, never by value.

## Not in this slice

Providers beyond Cloudflare and GitHub (AWS STS, OpenRouter, Tailscale).

## Develop

```sh
cd worker && npm test && npm run typecheck
```

Tests run in plain node over a sqlite stand-in for D1, including the CLI end to end against the real
routes.

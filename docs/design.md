# One store for env vars and keys

Design note for Vu's idea: a single store (or sidecar) that projects pull from at load time,
reload dynamically, global keys first with project overrides later, and eventually mint
right-sized API keys with partners that support it.

Short version: the idea is sound, but **startup scripts are the wrong hook**. The store should be
a small remote broker, the session should reach it through a **network secret** (so the session
never holds the broker credential), and anything that can travel as a request header should never
enter the session at all.

## What the platform gives us today

Checked against the cloud-environments docs (code.claude.com/docs/en/cloud-environments) and this
project's own environment (`dev`, personal, unrestricted network).

| Mechanism | When it runs / applies | Can it carry secrets well? |
|---|---|---|
| **Environment variables** (`.env` text on the environment) | Read at session creation and again whenever the VM is restored after idle or rebuilt. Edits reach running sessions on their next restore. | Plaintext, readable by every command and anyone who uses the environment. The docs say not to put secrets here. |
| **Network secrets** | The agent proxy adds the key as a header on requests to hosts you list, after the request leaves the VM. | Best option: key never inside the VM. But: entered by hand in the UI, can't be edited (delete and re-add), no API to set values, header auth only, never applied to GitHub, the Anthropic API, package registries, or setup-script requests. |
| **Setup script** | Before Claude Code launches, **only when the environment cache is built**. The filesystem is snapshotted and reused for roughly 7 days; restored VMs skip it. | Bad fit. It can't use network secrets (proxy isn't up yet), and anything it fetches is baked into a disk snapshot that outlives the key's freshness. |
| **SessionStart hook** (repo `.claude/settings.json`) | Every session start and resume. | Would be the natural "on load" hook, but **doesn't run in sessions with several repositories**, which is every session in this project (4 repos). User-level hooks written into `~/.claude/settings.json` aren't run in hosted environments either. |

Two consequences:

1. There is **no reliable "on load" moment** in a Project thread that can fetch fresh secrets. So
   "load once into memory" has to become "fetch on demand, cache briefly".
2. A sidecar **can't write network secrets** for us. It can only serve values to the session
   or proxy requests itself.

## Where the current environment stands

The `dev` environment carries 18 variables, and most are secrets in plaintext env vars
(names only; I didn't read values): `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`,
`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_AI_TOKEN`, `CLOUDFLARE_SECRET_ACCESS_KEY`,
`DEPLOYER_PRIVATE_KEY`, `GITHUB_PAT`, `OPENROUTER_API_KEY`, `POSTHOG_API_KEY`, `PYTH_API_KEY`,
`TS_AUTHKEY`, `TYPESAFE_API_KEY`.

They fall into two groups, and the split decides the whole design:

- **Header keys** (bearer or `X-Api-Key` style): OpenRouter, Cloudflare API and AI tokens, PostHog,
  Pyth, Typesafe (assuming header auth; to confirm per API). These can move to **network secrets
  today** and stop existing inside the VM.
- **Keys the process itself must hold**: AWS and R2 keys (SigV4 signs each request in-process),
  `DEPLOYER_PRIVATE_KEY` (signing), `TS_AUTHKEY` (consumed by `tailscale up`), and `GITHUB_PAT`
  for anything the GitHub proxy doesn't cover. Network secrets can't help these. **This is the
  broker's real job**, and also where short-lived minted credentials pay off most.

## The design

```
 cloud session VM                         agent proxy                 broker (your Worker)
 ┌───────────────────────────┐            ┌───────────┐               ┌──────────────────────┐
 │ tumbler run -- wrangler ...  │──HTTPS────▶│ + Bearer  │──────────────▶│ auth: token → pins   │
 │  (fetch, cache ≤ TTL,     │            │  <broker  │               │ resolve: project >   │
 │   exec with env injected) │◀───────────│   token>  │◀──────────────│          global      │
 └───────────────────────────┘            └───────────┘               │ mint: STS / CF / ... │
                                                                      │ audit log            │
                                                                      └──────────────────────┘
```

### 1. The broker (the "single store")

A small Cloudflare Worker, since that's already your stack (kypp runs there):

- **Storage**: secret values encrypted at rest (D1 or KV with an envelope key held as a Worker
  secret; Cloudflare's Secrets Store is worth a look for the global tier).
- **Resolution**: `GET /v1/env?keys=A,B` returns, for each key, the project value if set, else the
  global value. This is the same override order pillbox already uses (global pillbox, then project
  pillbox), so the two stay consistent and pillbox's vault can later read from the same broker.
- **Identity comes from the credential, never the request.** Each caller token is pinned to the
  projects it may read, exactly the `name@projA|projB:token` rule from kypp PR #41. A token asking
  for a project outside its pin gets an error, not a fallback. This is what "permissions around
  project level" should mean.
- **Audit**: every read and mint logged with token name, key name, project and time (never the value).

### 2. Bootstrap: the broker token is a network secret

Add one network secret on the environment for the broker's host. The session calls the broker with
no credential, the agent proxy attaches the token, and the session can never print or leak the
broker token itself. One secret to rotate by hand, and everything behind it rotates in the broker.

For project-level overrides, create one environment per project (or per trust level), each with its
own pinned broker token as its network secret. The environment is the only per-project handle a
Claude Project has today, so the pin rides on it.

### 3. The client: `tumbler`, fetch on demand

A single script in `vu1n/dev/scripts/`, installed by the setup script (installing a tool is what
setup scripts are good at, and it survives the cache):

- `tumbler run -- <cmd>`: fetch the keys the command needs, export them into that one process,
  exec. Nothing written to disk.
- Short in-memory cache (say 5 minutes) via a lazily started local helper, so repeated commands
  don't each hit the broker. It starts on first use, so VM pause/restore doesn't matter.
- "Reload" is just TTL expiry or `tumbler reload`. Rotate in the broker and every session picks the
  new value up on its next fetch, with no environment edit and no restart. That's the fix for
  "keeping env vars up to date".
- The setup script also writes a line into `~/.claude/CLAUDE.md` telling agents to run
  tools that need these keys under `tumbler run`.

### 4. Optional: proxy mode for header keys

For HTTP APIs whose client lets you set a base URL, the broker can forward the request and attach
the current key itself (`https://broker/openrouter/...`). Then rotation is central *and* the key
never enters the VM, without hand-editing network secrets. Worth it only if the hand-entered
network secrets become a chore.

### 5. Later: minting right-sized keys

The broker stores a **parent** credential per partner and hands sessions **children** that are
scoped and expire. From what I know of these APIs (not re-checked against their docs today):

- **AWS**: STS `AssumeRole` gives credentials that expire (15 min to hours) with a session policy
  narrower than the role. This replaces the long-lived `AWS_*` pair and is the biggest win.
- **Cloudflare**: the API can create API tokens with specific permissions, resources and an
  expiry, given a parent token allowed to create tokens.
- **OpenRouter**: provisioning keys can create and delete API keys with credit limits.
- **Tailscale**: the API creates auth keys with expiry, ephemeral and tagged.
- **GitHub**: fine-grained PATs can't be minted by API, but a GitHub App's installation tokens
  (1 hour, per repo, per permission) can. Most GitHub work here already goes through the GitHub proxy.

Each mint is logged, carries the requesting project in its name or tags, and the broker revokes
children it can when their TTL passes.

## Where the proposal fits, and where it doesn't

Fits:
- A single store with global then project override, central rotation, and dynamic reload all work,
  as long as "reload" means fetch-on-demand rather than a load-time hook.
- Dynamic provisioning fits well, and it's where a broker earns its keep over the platform.
- Bootstrapping through a network secret is a clean fit and keeps the master credential out of every session.

Doesn't fit:
- **Startup scripts can't be the loader.** They run once per cache build, before the proxy, and
  their output is snapshotted for days.
- **SessionStart hooks can't either**, in this project, because sessions here span several repos.
- **The sidecar can't manage network secrets.** Those stay hand-entered in the environment settings.
- **"In memory instead of .env" is partial.** Once a value is exported into a process, that
  process (and the agent running it) can read it. Only proxy-side injection (network secrets or
  the broker's proxy mode) truly keeps a key out of reach. Short TTLs from minting are the
  mitigation for the rest.
- **Project-level keys ride on environments, not on Claude Projects.** A Project has no identity
  a session can prove to the broker except the environment's network secret.

## Build or buy

Doppler and Infisical already do global plus project overrides, a `run --` CLI and audit logs, and
Infisical has dynamic secrets for AWS and databases. Either would replace steps 1 and 3; the
bootstrap (step 2) stays the same, with their service token as the network secret. Building our own
makes sense if you want it to also be pillbox's vault backend and to share kypp's pinning, which is
the reason I'd lean toward the Worker. The minting logic is per-partner glue either way.

## Storage choice (decided in thread): Cloudflare Secrets Store

Values live in Cloudflare, not in our own crypto. Two caveats shape the Worker:

- Secrets Store values are readable only through a Worker binding, not the REST API
  (per a third-party provider's docs, not yet confirmed in Cloudflare's reference). Writes go
  through the REST API with a token allowed to edit the store.
- As far as I know, each binding names one secret in the wrangler config, so adding a key means
  redeploying the Worker. Two ways around it:
  - **Redeploy on add:** the UI's "add key" writes the secret and then redeploys the Worker with
    the new binding through the API. Pure Secrets Store, but every new key is a deploy.
  - **Envelope (recommended):** one Secrets Store binding holds a master key, and values are
    AES-GCM encrypted with WebCrypto and stored in D1. Adding a key is a row insert. That's the only
    crypto we'd write (about 20 lines of a standard primitive); the master key never leaves Cloudflare.

## Catalog

A D1 table that describes every key. Values are never in it.

| field | purpose |
|---|---|
| `name` | env var name, such as `AWS_ACCESS_KEY_ID` |
| `scope` | `global`, or a project name for an override |
| `kind` | `static`, or a minting provider such as `aws-sts`, `cloudflare-token`, `openrouter`, `tailscale`, `oauth:<provider>` |
| `policy` | for minted keys: permissions or role, max TTL, spend limit |
| `ref` | where the value lives (D1 ciphertext id or Secrets Store name) |
| `description`, `owner` | what it's for and who to ask |
| `rotated_at`, `expires_at` | drives "stale key" warnings |

`tumbler` asks the catalog which keys a project gets, so a project's `.tumbler` file only lists names.

## UI

A small page served by the same Worker, behind **Cloudflare Access** (sign-in with your email), so
there's no login code to write. Screens:

1. **Catalog:** every key, its scope, kind, last rotation and expiry, and stale ones flagged.
2. **Edit / rotate:** values are write-only. The UI can set or replace a value but never shows it.
3. **Projects and tokens:** create a pinned broker token per project. The UI shows it once, for you
   to paste as that environment's network secret.
4. **Providers:** connect a partner once. For OAuth partners this runs the OAuth flow and stores the
   refresh token as the parent credential. For API-key partners you paste a parent key allowed to
   create keys. Each provider gets a policy template (scopes, max TTL) that catalog rows pick from.
5. **Audit:** who read or minted what, when, with values never logged.

## Recommended first step

1. **No code:** move the header keys (OpenRouter, Cloudflare API and AI tokens, PostHog, Pyth,
   Typesafe) from environment variables to network secrets on `dev`, and delete the env vars.
   That alone takes most keys out of every session, today.
2. **Then a thin slice:** a broker Worker with a global tier only, one pinned token held as a
   network secret, and `tumbler run` in `vu1n/dev`, serving just the AWS keys. Then swap the stored
   AWS pair for STS minting, so the first key the broker serves is also the first short-lived one.

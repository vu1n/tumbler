# Product
<!-- impeccable:product-schema 1 -->

Recorded from the README, AGENTS.md and the project's standing rules; nothing here was invented for
the design work. Facts marked *(inferred)* come from the code, not from a statement by the owner.

## Platform
web

## Users
One owner (Vu), the only admin, signed in through Cloudflare Access. Day to day the users are coding
agents in cloud sessions, which reach tumbler through the `tumbler` CLI with a pinned caller token;
they never see the admin page. The owner opens `/admin` rarely: to look at what is stored, to see
which tokens and grants exist, or to do the few things only a person may do (create a token, set a
parent credential). *(inferred)* Mostly at a desk, sometimes from a phone.

## Product Purpose
One store for env vars and API keys, for agent sessions and anywhere else code runs. Values are
sealed at rest, handed only to the process that needs them, and minted short-lived where a provider
allows it. Success is security seamless enough that the owner never reaches for a super-admin token.

## Positioning
The CLI is the first-class, agent-first interface; the admin page is the fallback a person uses when
the CLI can't do something, and every such gap is meant to move into the CLI. The page must never
become the place work routinely happens.

## Operating Context
- `/admin` is one server-rendered page behind Cloudflare Access, served by the Worker with a strict
  CSP (`default-src 'none'`, inline style and script only, `connect-src 'self'`). No external fonts,
  images or scripts can load.
- The page is a single template literal in `worker/src/admin.ts`, with its script inline. Its forms
  are `method="post"` so a value never lands in a URL if the script fails.
- Sections: Keys (with the save form, `.env` import and scope move), Grants, Tokens (with the
  create form), Audit.

## Capabilities and Constraints
- Values are write-only on the page: it can set or rotate one, never read it back.
- A new caller token is shown exactly once.
- A grant shows state and scopes only, never a minted child.
- Destructive actions (delete a key, revoke a grant or token, move a scope) take effect at once.
- No build step and no dependencies for the page.

## Brand Commitments
Name: Tumbler. Voice: plain sentences that say what happens and why, as in the README and the
page's own help text.

## Evidence on Hand
No real data may appear in captures, demos or tests: values are secrets. UI captures use fake keys
and tokens only.

## Product Principles
- The CLI comes first; the page shows state and holds the few person-only actions.
- Never show a value after it is saved.
- Say what an action will do before it does it, and what happened after.
- Nothing waits on a person: grants mint within a token's scopes.

## Accessibility & Inclusion
*(inferred)* WCAG AA contrast in light and dark, keyboard-reachable controls, readable on a phone.

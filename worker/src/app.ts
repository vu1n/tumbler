// app.ts — routes, apart from index.ts so tests can drive them without Worker bindings.
import { type Caller, Catalog, checkName, checkScope, GLOBAL, isKeyName, Refused, writeReaches } from "./catalog.ts";
import { ADMIN_HTML } from "./admin.ts";
import { autoKeys, cleanSignals, type S1Client } from "./auto.ts";
import { parseDotenv } from "./dotenv.ts";
import { errorClass, MINTED_MAX_AGE_S, scopeNames, type GrantRow, type Grants } from "./grants.ts";
import { sha256hex } from "./crypto.ts";
import { checkKey, type Verifiers } from "./verify.ts";

export interface Deps {
  catalog: Catalog; admin: (request: Request) => Promise<string | null>; cli?: string; setup?: string; s1?: S1Client | null; grants?: Grants;
  fetcher?: typeof fetch; // what static key checks call; global fetch unless a test swaps it
}

const verifiers = ({ grants, fetcher }: Deps): Verifiers => ({ providers: grants?.providers ?? {}, fetcher });
const MAX_CHECKS = 20, MAX_IMPORT = 100, MAX_VALUE = 64 * 1024;
const list = (v: unknown) => Array.isArray(v) ? v.map(String) : null;

// What a caller learns about its grant: never the child credential or its provider id.
const grantView = (g: GrantRow) => ({ id: g.id, name: g.name, state: g.state, scopes: g.scopes, requested: g.requested, expires_at: g.expires_at });

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json", "cache-control": "no-store" },
});
const bearer = (r: Request) => /^Bearer\s+(\S+)$/i.exec(r.headers.get("authorization") ?? "")?.[1] ?? null;

let served: { cli: string; version: string } | null = null;
async function cliVersion(cli: string) {
  if (served?.cli !== cli) served = { cli, version: (await sha256hex(cli)).slice(0, 12) };
  return served.version;
}

export async function handle(request: Request, deps: Deps): Promise<Response> {
  const r = await route(request, deps);
  // The CLI this broker serves, as the CLI names its own version (the first 12 of its sha256), on
  // every /v1 answer, errors included: a stale local copy then says `tumbler update` itself.
  if (deps.cli && new URL(request.url).pathname.startsWith("/v1/")) r.headers.set("x-tumbler-cli", await cliVersion(deps.cli));
  return r;
}

async function route(request: Request, deps: Deps): Promise<Response> {
  try {
    const url = new URL(request.url), path = url.pathname;
    // The CLI itself is public (it holds no secrets), so a setup script can fetch it before the
    // agent proxy is up: curl -fsSL "$TUMBLER_URL/cli" -o /usr/local/bin/tumbler
    if (path === "/cli" && deps.cli) return new Response(deps.cli, { headers: { "content-type": "text/plain; charset=utf-8" } });
    // The setup script, with this broker's own URL as the default, so an environment's whole setup
    // script is one line: curl -fsSL https://<broker>/setup | bash
    if (path === "/setup" && deps.setup) return new Response(deps.setup.replace(/^#!\/bin\/bash\n/, `#!/bin/bash\nTUMBLER_URL="\${TUMBLER_URL:-${url.origin}}"\n`),
      { headers: { "content-type": "text/plain; charset=utf-8" } });
    if (path.startsWith("/v1/")) return await agentRoute(request, url, deps);
    if (path === "/admin" || path.startsWith("/admin/")) return await adminRoute(request, url, deps);
    return new Response("not found", { status: 404 });
  } catch (e) {
    if (e instanceof Refused) return json({ error: e.message }, e.status);
    // A fixed event, the route and the error's class: never its message, stack or cause, nor the
    // request body. A provider or library error can quote what it was sent, and that may be a value.
    console.error("tumbler: request failed", new URL(request.url).pathname, errorClass(e));
    return json({ error: "internal error" }, 500);
  }
}

async function agentRoute(request: Request, url: URL, deps: Deps) {
  const { catalog, s1, grants } = deps;
  const token = bearer(request), caller = token ? await catalog.caller(token) : null;
  if (!caller) return json({ error: "unauthorized" }, 401);
  // Which of the caller's keys this repo needs, from its file and dependency names. Names out, never values.
  if (url.pathname === "/v1/auto" && request.method === "POST") {
    if (Number(request.headers.get("content-length") ?? 0) > 256 * 1024) return json({ error: "too many signals" }, 413);
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const { project, keys } = await catalog.visible(caller, url.searchParams.get("project"));
    const picks = await autoKeys(s1 ?? null, cleanSignals(body.signals), keys);
    await catalog.audit(caller.name, "auto", project, picks.map((p) => p.name));
    return json({ project, keys: picks });
  }
  // Ask for more scopes on the minted keys in a set: {"keys": [...], "scopes": ["workers:write"]}.
  // Minted at once when the token's scopes allow them; refused (403) otherwise.
  if (url.pathname === "/v1/step-up" && request.method === "POST") {
    if (!grants) return json({ error: "minting is off" }, 501);
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const scopes = Array.isArray(body.scopes) ? body.scopes.map(String) : [], names = Array.isArray(body.keys) ? body.keys.map(String) : [];
    if (!scopes.length) return json({ error: "no scopes asked for" }, 400);
    // Every key is checked before any mints, so a refused one never leaves another widened.
    const asks = [];
    for (const name of names) {
      const { project, row } = await catalog.rowFor(caller, url.searchParams.get("project"), name);
      if (row.kind === "static") continue;
      const known = scopeNames(grants.config(row)), mine = scopes.filter((s) => known.includes(s));
      if (!mine.length) continue;
      grants.checkStepUp(caller, row, mine);
      asks.push({ project, row, mine });
    }
    if (!asks.length) return json({ error: `no minted key in this set has scope ${scopes.join(", ")}` }, 400);
    const out = [];
    for (const { project, row, mine } of asks) out.push(grantView(await grants.stepUp(caller, project, row, mine)));
    return json({ grants: out });
  }
  // Run each key's check on its current value: {"keys": [...]} (empty: every key the caller reads).
  // Statuses only, never a value; `tumbler run` calls this when a command fails.
  if (url.pathname === "/v1/check" && request.method === "POST") {
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    let names = Array.isArray(body.keys) ? body.keys.map(String) : [];
    if (!names.length) names = (await catalog.visible(caller, url.searchParams.get("project"))).keys.map((k) => k.name);
    if (names.length > MAX_CHECKS) return json({ error: `at most ${MAX_CHECKS} keys per check` }, 400);
    const checks: Record<string, unknown> = {};
    let project: string | null = null;
    for (const name of names) {
      const found = await catalog.rowFor(caller, url.searchParams.get("project"), name);
      project = found.project;
      const outcome = await checkKey(found.row.kind, JSON.parse(found.row.config || "{}"), await catalog.value(found.row), verifiers(deps));
      // A minted key is checked through its parent, not the child the caller holds; say so.
      checks[name] = found.row.kind === "static" || outcome.status === "none" ? outcome : { ...outcome, of: "parent" };
    }
    await catalog.audit(caller.name, "check", project, names);
    return json({ project, checks });
  }
  // Save a static key: PUT /v1/keys/NAME {"scope", "value", "description"?}, what `tumbler put` sends.
  // Only within the token's writes. A key with a check keeps it, and a value that fails it saves nothing.
  if (url.pathname.startsWith("/v1/keys/") && request.method === "PUT") {
    const name = decodeURIComponent(url.pathname.slice("/v1/keys/".length));
    checkName(name);
    // Loose: JSON can spell one byte of value in up to six (\u0000); the exact limit is on the value below.
    if (Number(request.headers.get("content-length") ?? 0) > MAX_VALUE * 6 + 4096) return json({ error: "value too large" }, 413);
    const b = await request.json().catch(() => ({})) as Record<string, unknown>;
    const scope = writeScope(catalog, caller, b.scope ? String(b.scope) : null);
    const value = typeof b.value === "string" ? b.value : "";
    if (!value) return json({ error: "empty value" }, 400);
    if (new TextEncoder().encode(value).length > MAX_VALUE) return json({ error: `a value is at most ${MAX_VALUE} bytes` }, 413);
    const prev = await catalog.keyRow(scope, name);
    // Why: a mint key's value is a parent credential; a caller token never sets or rotates one.
    if (prev && prev.kind !== "static") return json({ error: `${scope}/${name} is a ${prev.kind} key; change it in /admin` }, 409);
    const cfg = JSON.parse(prev?.config || "{}"), check = await checkKey("static", cfg, value, verifiers(deps));
    if (check.status === "invalid" || check.status === "error") {
      return json({ error: `${name}: the new value failed its check, ${check.detail}; nothing was saved and the old value stays` }, check.status === "invalid" ? 400 : 502);
    }
    // Again after the check, which can take seconds: a revoke or a narrowed writes in the meantime wins.
    const now = await catalog.caller(token!);
    if (!now || !writeReaches(now.writes, scope)) return json({ error: `this token may no longer write ${scope}; nothing was saved` }, 403);
    await catalog.put(scope, name, value, { kind: "static", config: cfg, checked: check.status === "ok", ...(typeof b.description === "string" ? { description: b.description } : {}) });
    await catalog.audit(caller.name, "put", scope === GLOBAL ? null : scope, [name]);
    return json({ scope, name, action: prev ? "rotated" : "created", checked: check.status === "ok" });
  }
  // Delete a static key: DELETE /v1/keys/NAME?scope=..., what `tumbler rm` sends. Within the token's writes.
  if (url.pathname.startsWith("/v1/keys/") && request.method === "DELETE") {
    const name = decodeURIComponent(url.pathname.slice("/v1/keys/".length));
    checkName(name);
    const scope = writeScope(catalog, caller, url.searchParams.get("scope"));
    const prev = await catalog.keyRow(scope, name);
    if (!prev) return json({ error: `no key ${scope}/${name}` }, 404);
    // Why: deleting a parent ends every child it minted; that stays an admin's call.
    if (prev.kind !== "static") return json({ error: `${scope}/${name} is a ${prev.kind} key; delete it in /admin` }, 409);
    if (!await catalog.removeStatic(scope, name)) return json({ error: `${scope}/${name} changed while it was being deleted; nothing was deleted` }, 409);
    await catalog.audit(caller.name, "delete", scope === GLOBAL ? null : scope, [name]);
    return json({ scope, name, action: "deleted" });
  }
  // A minted key's scopes, and an operator's changes to them: what `tumbler scope` sends. Only for an
  // operator token, only on the key it reads, and only the groups the admin's config doesn't set.
  if (url.pathname.startsWith("/v1/mint/") && (request.method === "GET" || request.method === "PATCH")) {
    if (!caller.operator) return json({ error: `token ${caller.name} is not an operator; an admin turns that on for it in /admin or with \`tumbler admin token edit ${caller.name} --operator on\`` }, 403);
    if (!grants) return json({ error: "minting is off" }, 501);
    // GET /v1/mint/NAME/groups: every group the key's parent lists, names only, for `tumbler scope groups`.
    const [keyName, sub] = url.pathname.slice("/v1/mint/".length).split("/");
    if (sub !== undefined && (sub !== "groups" || request.method !== "GET")) return json({ error: "not found" }, 404);
    const { row } = await catalog.rowFor(caller, url.searchParams.get("project"), decodeURIComponent(keyName));
    if (row.kind === "static") return json({ error: `${row.scope}/${row.name} is a static key; it has no scopes` }, 400);
    let cfg = grants.config(row);
    if (sub === "groups") return json({ scope: row.scope, name: row.name, groups: await grants.listGroups(row.kind, await catalog.value(row), cfg) });
    if (request.method === "PATCH") {
      const b = await request.json().catch(() => ({})) as Record<string, unknown>;
      const scope = String(b.scope ?? ""), add = list(b.add) ?? [], remove = list(b.remove) ?? [];
      if (!scope || (!add.length && !remove.length)) return json({ error: "name a scope and the groups to add or remove" }, 400);
      const extra = { ...(cfg.extra ?? {}) };
      const added = add.length ? await grants.groups(row.kind, await catalog.value(row), cfg, add) : [];
      const gone = new Set(remove.map((g) => g.toLowerCase()));
      const absent = remove.filter((g) => !(extra[scope] ?? []).some((e) => e.toLowerCase() === g.toLowerCase()));
      if (absent.length) return json({ error: `${absent.join(", ")} isn't an addition on ${row.name} ${scope}; only groups added with tumbler scope can be removed there, the rest is the key's config in /admin` }, 400);
      const next = [...new Set([...(extra[scope] ?? []), ...added])].filter((g) => !gone.has(g.toLowerCase()));
      if (next.length) extra[scope] = next; else delete extra[scope];
      cfg = { ...cfg, extra };
      if (!Object.keys(extra).length) delete cfg.extra;
      grants.validate(row.kind, cfg);
      if (!await catalog.setConfig(row.scope, row.name, row.rev, cfg)) return json({ error: `${row.name} changed meanwhile; nothing was saved, run again` }, 409);
      // Its children carry the old groups: end them, so the next run mints with the new ones.
      await grants.closeStale(row.scope, row.name);
      await catalog.audit(caller.name, "mint-scope", row.scope === GLOBAL ? null : row.scope, [row.name, scope, ...added.map((g) => `+${g}`), ...remove.map((g) => `-${g}`)]);
    }
    const base = (cfg.scopes ?? {}) as Record<string, unknown[]>, extra = cfg.extra ?? {};
    return json({ scope: row.scope, name: row.name, kind: row.kind, defaults: cfg.defaults === true,
      scopes: Object.fromEntries(scopeNames(cfg).sort().map((s) => [s, { base: (base[s] ?? []).map(String), extra: extra[s] ?? [] }])) });
  }
  if (request.method !== "GET") return json({ error: "method not allowed" }, 405);
  if (url.pathname === "/v1/whoami") return json({ name: caller.name, projects: caller.projects, scopes: caller.scopes ?? null, writes: caller.writes ?? null, operator: caller.operator ?? false, expires_at: caller.expires_at ?? null });
  // Names only: listing must not mint a child for every minted key.
  if (url.pathname === "/v1/keys") {
    const { project, keys } = await catalog.visible(caller, url.searchParams.get("project"));
    return json({ project, keys: keys.map((k) => k.name) });
  }
  // Revisions only (a new one on every save) and whether each passed its check: what --watch polls.
  if (url.pathname === "/v1/revs") {
    const names = (url.searchParams.get("keys") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    return json(await catalog.revisions(caller, url.searchParams.get("project"), names));
  }
  if (url.pathname === "/v1/env") {
    const names = (url.searchParams.get("keys") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    let minted = false;
    const env = await catalog.resolve(caller, url.searchParams.get("project"), names, grants && ((c, p, r) => { minted = true; return grants.issue(c, p, r); }));
    // Values go out only if the credential that asked still works now: a revoke (or its name reused
    // by a new token, whose grants share the name) while this ran wins over the request.
    if ((await catalog.caller(token!))?.hash !== caller.hash) return json({ error: "unauthorized" }, 401);
    return json(minted ? { env, max_age: MINTED_MAX_AGE_S } : { env });
  }
  return json({ error: "not found" }, 404);
}

// {"store": {"scope": "pr-review", "name": "PR_REVIEW_TUMBLER_TOKEN"}} on a token create: the new
// token goes straight into that static key instead of the response, so no pipe can drop it.
type StoreTarget = { scope: string; name: string; description?: string };
function storeTarget(v: unknown): StoreTarget | null {
  if (v === undefined || v === null) return null;
  const o = v as Record<string, unknown>;
  if (typeof v !== "object" || typeof o.scope !== "string" || typeof o.name !== "string") throw new Refused(400, 'store takes {"scope": ..., "name": ...}');
  return { scope: o.scope, name: o.name, ...(typeof o.description === "string" ? { description: o.description } : {}) };
}
// Checked before the token exists, so a bad target never leaves a token behind. Only a static key: a
// minted key's value is a parent credential, never a token handed to a caller. Never a key with a
// check either: that key holds some service's credential, which a tumbler token would replace.
async function checkStoreTarget(catalog: Catalog, into: StoreTarget) {
  checkScope(into.scope); checkName(into.name);
  const prev = await catalog.keyRow(into.scope, into.name);
  if (prev && prev.kind !== "static") throw new Refused(409, `${into.scope}/${into.name} is ${prev.kind}; store the token under another name`);
  if (prev && JSON.parse(prev.config || "{}").check) throw new Refused(409, `${into.scope}/${into.name} has a key check, so it holds another service's credential; store the token under another name`);
}
// The scope a caller token writes: the one it names, else the one it reads by default (never global by
// accident), refused unless the token's writes reach it.
function writeScope(catalog: Catalog, caller: Caller, requested: string | null) {
  const scope = requested ?? (caller.projects ? catalog.scopeFor(caller, null) : null);
  if (!scope) throw new Refused(400, "name a scope to write: global, a project or project/env");
  checkScope(scope);
  if (!writeReaches(caller.writes, scope)) {
    throw new Refused(403, `this token may not write ${scope}${caller.writes ? ` (it writes ${caller.writes.join(", ")})` : " (it writes nothing)"}; an admin adds it under the token's writes in /admin`);
  }
  return scope;
}

async function adminRoute(request: Request, url: URL, deps: Deps) {
  const { catalog, admin, grants } = deps;
  const who = await admin(request);
  if (!who) return new Response("forbidden", { status: 403 });
  const path = url.pathname, m = request.method;
  if (path === "/admin" || path === "/admin/") {
    // A form posted here means the page's script never ran; the value it carried is not kept.
    if (m !== "GET") return new Response("the admin page's script didn't run, so nothing was saved", { status: 405 });
    return new Response(ADMIN_HTML, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'" } });
  }
  // Why: Access authenticates by cookie, so a cross-site form could ride it. A custom header can't
  // be sent cross-origin without a preflight this Worker never answers.
  if (m !== "GET" && request.headers.get("x-tumbler-admin") !== "1") return json({ error: "missing x-tumbler-admin header" }, 400);
  const parts = path.split("/").filter(Boolean).slice(2).map(decodeURIComponent); // after /admin/api
  if (!path.startsWith("/admin/api/")) return json({ error: "not found" }, 404);
  const body = async () => (m === "GET" || m === "DELETE" ? {} : await request.json().catch(() => ({}))) as Record<string, any>;

  // Paste a .env: {"scope", "text", "save"}. Without save it is a preview of what each line would do.
  // Every line becomes a static key, checked like a single save; names and line numbers out, never values.
  if (parts[0] === "import" && parts.length === 1 && m === "POST") {
    const b = await body(), scope = String(b.scope ?? GLOBAL), save = b.save === true;
    checkScope(scope);
    const { entries, errors } = parseDotenv(String(b.text ?? ""));
    for (const e of entries) if (!isKeyName(e.name)) errors.push({ line: e.line, error: `invalid key name ${e.name}; names are UPPER_SNAKE_CASE` });
    const valid = entries.filter((e) => isKeyName(e.name));
    if (valid.length > MAX_IMPORT) return json({ error: `at most ${MAX_IMPORT} keys per paste; nothing was saved` }, 400);
    errors.sort((x, y) => x.line - y.line);
    const last = new Map(valid.map((e) => [e.name, e.line]));
    // What each line would do; `value` and `config` stay here, `view` is what goes back.
    type Step = { name: string; line: number; action: string; reason?: string; checked?: boolean };
    const plan = await Promise.all(valid.map(async (e): Promise<{ step: Step; value?: string; config?: string }> => {
      const prev = await catalog.keyRow(scope, e.name), step = { name: e.name, line: e.line };
      if (last.get(e.name) !== e.line) return { step: { ...step, action: "skip", reason: `set again on line ${last.get(e.name)}` } };
      if (!e.value) return { step: { ...step, action: "skip", reason: "empty value" } };
      // Why: a mint key's value is a parent credential; overwriting it as static would hand it out.
      if (prev && prev.kind !== "static") return { step: { ...step, action: "skip", reason: `${prev.kind} key; change it with the form above` } };
      return { step: { ...step, action: prev ? "overwrite" : "create", checked: !!JSON.parse(prev?.config || "{}").check }, value: e.value, config: prev?.config };
    }));
    const view = plan.map((p) => p.step);
    if (!save) return json({ scope, keys: view, errors });
    if (errors.length) return json({ error: "fix the lines the preview flags first; nothing was saved", errors }, 400);
    const saved: string[] = [];
    for (const [i, { value, config }] of plan.entries()) {
      if (value === undefined) continue;
      const cfg = JSON.parse(config || "{}");
      // A key with a check keeps it, and a value that fails it is not saved, as in a single save.
      const check = await checkKey("static", cfg, value, verifiers(deps));
      if (check.status === "invalid" || check.status === "error") {
        view[i] = { ...view[i], action: "failed", reason: `failed its check, ${check.detail}; the old value stays` };
        continue;
      }
      await catalog.put(scope, view[i].name, value, { kind: "static", config: cfg, checked: check.status === "ok" });
      view[i] = { ...view[i], action: view[i].action === "create" ? "created" : "overwritten" };
      saved.push(view[i].name);
    }
    if (saved.length) await catalog.audit(who, "put", scope === GLOBAL ? null : scope, saved);
    return json({ scope, keys: view, errors, saved });
  }
  if (parts[0] === "keys") {
    if (m === "GET" && parts.length === 1) return json({ keys: await catalog.list() });
    if (parts.length === 3) {
      const [, scope, name] = parts;
      if (m === "PUT") {
        const b = await body();
        const kind = b.kind ? String(b.kind) : undefined, config = b.config && typeof b.config === "object" ? b.config : undefined;
        const prev = await catalog.keyRow(scope, name), effective = kind ?? prev?.kind ?? "static";
        let cfg = config ?? JSON.parse(prev?.config || "{}");
        const value = String(b.value ?? "");
        if (effective !== "static") {
          if (!grants) return json({ error: "minting is off" }, 501);
          // A static key the admin saved, read here and never returned: the nearest of the scope's chain.
          const setting = async (n: string) => {
            const row = await catalog.nearest(scope === GLOBAL ? null : scope, n);
            return row && row.kind === "static" ? await catalog.value(row) : undefined;
          };
          if (value) cfg = await grants.prepare(effective, value, cfg, setting);
          grants.validate(effective, cfg);
        }
        // Test the new value before it replaces the old one: a key that fails saves nothing.
        const check = value ? await checkKey(effective, cfg, value, verifiers(deps)) : { status: "none" as const };
        // Why an override only for "error": when the service is down a leaked key must still be
        // replaceable. It saves unchecked, so --watch never pushes it. A rejected value never saves.
        const skipped = check.status === "error" && b.skip_check === true;
        if (check.status === "invalid" || (check.status === "error" && !skipped)) {
          return json({ error: `${name}: the new value failed its check, ${check.detail}; nothing was saved and the old value stays`,
            ...(check.status === "error" ? { can_skip: true } : {}) }, check.status === "invalid" ? 400 : 502);
        }
        if (skipped) await catalog.audit(who, "put-unchecked", scope === GLOBAL ? null : scope, [name]);
        await catalog.put(scope, name, value, { description: b.description, owner: b.owner, expires_at: b.expires_at ?? null,
          kind: effective, config: cfg, checked: check.status === "ok" }); // exactly what was checked, not a re-read
        // End the old revision's grants now, so their children stop working at once. If this is
        // missed (a crash, a concurrent save), current() ends each one on its next request, revoking
        // with the retired revision. "system": a rotation must not block the next grant like a revoke.
        if (prev && prev.kind !== "static" && grants) await grants.closeStale(scope, name);
        await catalog.audit(who, "put", scope === GLOBAL ? null : scope, [name]);
        return json({ ok: true });
      }
      if (m === "DELETE") {
        const prev = await catalog.keyRow(scope, name);
        await catalog.remove(scope, name);
        if (prev && prev.kind !== "static" && grants) await grants.closeStale(scope, name);
        await catalog.audit(who, "delete", scope === GLOBAL ? null : scope, [name]);
        return json({ ok: true });
      }
    }
  }
  // Move a scope's keys and pins: {"from": "huddles-dev", "to": "huddles/dev"}. Names out, never values.
  if (parts[0] === "scopes" && parts[1] === "move" && parts.length === 2 && m === "POST") {
    const b = await body(), from = String(b.from ?? ""), to = String(b.to ?? "");
    const { moved, repinned } = await catalog.moveScope(from, to);
    // The moved mint keys' children and every grant read as `from` stop now. A rerun after a crash
    // repeats both; the sweep's closeStale() also catches moved keys a crash left behind.
    for (const k of moved) if (k.kind !== "static") await grants?.closeStale(from, k.name);
    await grants?.closeProject(from, "system");
    await catalog.audit(who, "scope-move", to, [from, ...moved.map((k) => k.name)]);
    return json({ from, to, moved: moved.map((k) => k.name), repinned: repinned.map((t) => t.name) });
  }
  if (parts[0] === "tokens") {
    if (m === "GET" && parts.length === 1) return json({ tokens: await catalog.tokens() });
    if (m === "POST" && parts.length === 1) {
      const b = await body();
      const projects = Array.isArray(b.projects) && b.projects.length ? b.projects.map(String) : null;
      // Reusing an ended token's name: its children end first, and only that token's (closeCaller's
      // gen), so the create finds nothing live under the name it hands over.
      const name = String(b.name ?? ""), ended = await catalog.endedToken(name);
      if (ended) await grants?.closeCaller(name, who, ended);
      const into = storeTarget(b.store);
      const args = [name, projects, b.expires_at == null || b.expires_at === "" ? null : String(b.expires_at), list(b.scopes), list(b.writes), b.operator === true] as const;
      if (into) {
        await checkStoreTarget(catalog, into);
        await catalog.createTokenInto(who, into, ...args, ended);
        return json({ name: b.name, stored: into }); // never shown: it went straight into the key
      }
      const token = await catalog.createToken(...args, ended);
      await catalog.audit(who, "token-create", null, [String(b.name)]);
      return json({ name: b.name, token }); // shown once
    }
    // {"projects": [...]} edits the pin, {"scopes": [...]} the ceiling, {"writes": [...]} what it may
    // write; any of them.
    if (m === "PATCH" && parts.length === 2) {
      const b = await body();
      const pin = "projects" in b || !("scopes" in b || "writes" in b || "operator" in b), projects = Array.isArray(b.projects) && b.projects.length ? b.projects.map((p: unknown) => String(p).trim()).filter(Boolean) : null;
      // One checked write for both, so a bad pin never lands a wider ceiling (or the reverse).
      const done = await catalog.updateToken(parts[1], { ...("scopes" in b ? { scopes: list(b.scopes) } : {}), ...("writes" in b ? { writes: list(b.writes) } : {}), ...("operator" in b ? { operator: b.operator === true } : {}), ...(pin ? { projects: projects?.length ? projects : null } : {}) });
      // Both cleanups run before either audit; a cleanup cut short is finished by the sweep.
      // Only the edited token's grants (its hash), never those of a token that took the name meanwhile.
      if ("projects" in done) await grants?.closeOutsidePin(parts[1], done.projects!, who, done.hash);
      if ("scopes" in done) await grants?.closeOutsideCeiling(parts[1], done.scopes!, who, done.hash);
      if ("projects" in done) await catalog.audit(who, "token-pin", null, [parts[1], ...(done.projects ?? ["global-only"])]);
      if ("scopes" in done) await catalog.audit(who, "token-scopes", null, [parts[1], ...(done.scopes ?? ["reads-only"])]);
      if ("writes" in done) await catalog.audit(who, "token-writes", null, [parts[1], ...(done.writes ?? ["writes-nothing"])]);
      if ("operator" in done) await catalog.audit(who, "token-operator", null, [parts[1], done.operator ? "on" : "off"]);
      return json({ ok: true });
    }
    if (m === "DELETE" && parts.length === 2) {
      const { fresh, hash } = await catalog.revokeTokenGen(parts[1]);
      await grants?.closeCaller(parts[1], who, hash); // its children stop working now, not at expiry; never a reused name's
      if (fresh) await catalog.audit(who, "token-revoke", null, [parts[1]]);
      return json({ ok: true });
    }
  }
  if (parts[0] === "grants" && grants) {
    if (m === "GET" && parts.length === 1) return json({ revoke_pending: await grants.pendingRevokes(), grants: (await grants.list()).map((g) => ({ ...grantView(g), caller: g.caller, project: g.project, decided_by: g.decided_by, updated_at: g.updated_at })) });
    if (m === "DELETE" && parts.length === 2) { await grants.revoke(parts[1], who); return json({ ok: true }); }
    if (m === "GET" && parts.length === 3 && parts[2] === "events") return json({ events: await grants.events(parts[1]) });
  }
  if (parts[0] === "audit" && m === "GET") return json({ audit: await catalog.recentAudit() });
  return json({ error: "not found" }, 404);
}

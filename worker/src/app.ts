// app.ts — routes, apart from index.ts so tests can drive them without Worker bindings.
import { Catalog, checkScope, GLOBAL, isKeyName, Refused } from "./catalog.ts";
import { ADMIN_HTML } from "./admin.ts";
import { autoKeys, cleanSignals, type S1Client } from "./auto.ts";
import { parseDotenv } from "./dotenv.ts";
import { errorClass, MINTED_MAX_AGE_S, type GrantRow, type Grants } from "./grants.ts";
import { checkKey, type Verifiers } from "./verify.ts";

export interface Deps {
  catalog: Catalog; admin: (request: Request) => Promise<string | null>; cli?: string; setup?: string; s1?: S1Client | null; grants?: Grants;
  fetcher?: typeof fetch; // what static key checks call; global fetch unless a test swaps it
}

const verifiers = ({ grants, fetcher }: Deps): Verifiers => ({ providers: grants?.providers ?? {}, fetcher });
const MAX_CHECKS = 20, MAX_IMPORT = 100;
const list = (v: unknown) => Array.isArray(v) ? v.map(String) : null;

// What a caller learns about its grant: never the child credential or its provider id.
const grantView = (g: GrantRow) => ({ id: g.id, name: g.name, state: g.state, scopes: g.scopes, requested: g.requested, expires_at: g.expires_at });

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json", "cache-control": "no-store" },
});
const bearer = (r: Request) => /^Bearer\s+(\S+)$/i.exec(r.headers.get("authorization") ?? "")?.[1] ?? null;

export async function handle(request: Request, deps: Deps): Promise<Response> {
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
    const out = [];
    for (const name of names) {
      const { project, row } = await catalog.rowFor(caller, url.searchParams.get("project"), name);
      if (row.kind === "static") continue;
      const known = Object.keys(grants.config(row).scopes ?? {}), mine = scopes.filter((s) => known.includes(s));
      if (!mine.length) continue;
      out.push(grantView(await grants.stepUp(caller, project, row, mine)));
    }
    if (!out.length) return json({ error: `no minted key in this set has scope ${scopes.join(", ")}` }, 400);
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
  if (request.method !== "GET") return json({ error: "method not allowed" }, 405);
  if (url.pathname === "/v1/whoami") return json({ name: caller.name, projects: caller.projects, scopes: caller.scopes ?? null, expires_at: caller.expires_at ?? null });
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
    return json(minted ? { env, max_age: MINTED_MAX_AGE_S } : { env });
  }
  return json({ error: "not found" }, 404);
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
      const token = await catalog.createToken(String(b.name ?? ""), projects, b.expires_at == null || b.expires_at === "" ? null : String(b.expires_at), list(b.scopes));
      await catalog.audit(who, "token-create", null, [String(b.name)]);
      return json({ name: b.name, token }); // shown once
    }
    // {"projects": [...]} edits the pin, {"scopes": [...]} the ceiling; either or both.
    if (m === "PATCH" && parts.length === 2) {
      const b = await body();
      const pin = "projects" in b || !("scopes" in b), projects = Array.isArray(b.projects) && b.projects.length ? b.projects.map((p: unknown) => String(p).trim()).filter(Boolean) : null;
      // One checked write for both, so a bad pin never lands a wider ceiling (or the reverse).
      const done = await catalog.updateToken(parts[1], { ...("scopes" in b ? { scopes: list(b.scopes) } : {}), ...(pin ? { projects: projects?.length ? projects : null } : {}) });
      if ("scopes" in done) {
        await grants?.closeOutsideCeiling(parts[1], done.scopes!, who);
        await catalog.audit(who, "token-scopes", null, [parts[1], ...(done.scopes ?? ["reads-only"])]);
      }
      if ("projects" in done) {
        await grants?.closeOutsidePin(parts[1], done.projects!, who);
        await catalog.audit(who, "token-pin", null, [parts[1], ...(done.projects ?? ["global-only"])]);
      }
      return json({ ok: true });
    }
    if (m === "DELETE" && parts.length === 2) {
      const fresh = await catalog.revokeToken(parts[1]);
      await grants?.closeCaller(parts[1], who); // its children stop working now, not at expiry
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

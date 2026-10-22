// catalog.ts — keys, tokens and audit in D1. Values go in sealed and come out only through resolve().
import { open, randomToken, seal, sha256hex } from "./crypto.ts";
import { staticCheck } from "./verify.ts";

export const GLOBAL = "global";
const NAME = /^[A-Z_][A-Z0-9_]{0,127}$/;
// A project, or one of its environments: `huddles`, `huddles/prod`. Environments are a fixed set (as
// in Infisical), so access to one is granted by name, never by matching a naming habit.
export const ENVIRONMENTS = ["dev", "staging", "prod"];
const PART = "[a-z0-9][a-z0-9._-]{0,63}", ENV = `(${ENVIRONMENTS.join("|")})`;
const PROJECT = new RegExp(`^${PART}(/${ENV})?$`);
// Any project/deployment name a broker may hold from before environments were fixed: still a valid
// scope to move keys out of, so a `huddles/qa` can become `huddles/staging` without re-entering values.
const LEGACY = new RegExp(`^${PART}(/${PART})?$`);
// A pin entry: a project or one environment of it, where `*` stands for every project, present and
// future. `huddles/prod` reads huddles' prod; `*/dev` reads every project's dev.
const PIN = new RegExp(`^(${PART}|\\*)(/${ENV})?$`);

export class Refused extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

export const isKeyName = (name: string) => NAME.test(name);
export function checkName(name: string) { if (!NAME.test(name)) throw new Refused(400, `invalid key name: ${name}`); }
export function checkScope(scope: string) {
  if (scope !== GLOBAL && !PROJECT.test(scope)) throw new Refused(400, `invalid scope: ${scope}`);
}

function checkPin(projects: string[] | null) {
  for (const p of projects ?? []) {
    if (p === GLOBAL) throw new Refused(400, "pin projects, not global");
    if (!PIN.test(p)) throw new Refused(400, `invalid pin: ${p}; pin a project, project/env or */env (env: ${ENVIRONMENTS.join(", ")})`);
  }
}

// The scopes a read as `project` draws on, least specific first. A deployment reads its own keys,
// then its project's, then global ones: huddles/prod over huddles over global.
export function chain(project: string | null): string[] {
  if (!project) return [GLOBAL];
  const slash = project.indexOf("/");
  return slash < 0 ? [GLOBAL, project] : [GLOBAL, project.slice(0, slash), project];
}

// One row per name, the most specific scope in `scopes` winning (rows from other scopes are ignored).
function winners<T extends { scope: string; name: string }>(rows: T[], scopes: string[], names: string[] = []) {
  const want = new Set(names), win = new Map<string, T>(), rank = (r: T) => scopes.indexOf(r.scope);
  for (const r of rows) {
    if ((want.size && !want.has(r.name)) || rank(r) < 0) continue;
    const prev = win.get(r.name);
    if (!prev || rank(r) > rank(prev)) win.set(r.name, r);
  }
  return win;
}

// Whether a pin reaches a scope: the project (or all of them), or that environment of the project (or
// of all of them). A grant on a scope it no longer reaches is ended.
export function pinReaches(projects: string[] | null, scope: string | null) {
  if (scope === null) return true;
  const env = scope.split("/")[1];
  return !!projects && (projects.includes(scope) || projects.includes(env ? `*/${env}` : "*"));
}

export interface Caller { name: string; projects: string[] | null; expires_at?: string | null }
export interface KeyRow {
  scope: string; name: string; kind: string; config: string; description: string; owner: string;
  created_at: string; rotated_at: string; expires_at: string | null; checked: number;
}
export interface MintRow { scope: string; name: string; kind: string; config: string; rev: string; iv: ArrayBuffer; ciphertext: ArrayBuffer }
export interface TokenRow { name: string; projects: string[] | null; created_at: string; revoked_at: string | null; expires_at: string | null }

const now = () => new Date().toISOString();
// Children live at most 24h (MAX_TTL_MIN in grants.ts); a retired parent is kept a little longer.
export const RETIRE_MS = 25 * 60 * 60 * 1000;
const bytes = (v: unknown) => v instanceof Uint8Array ? v : new Uint8Array(v as ArrayBuffer);

export class Catalog {
  db: D1Database; key: CryptoKey;
  clock: () => Date = () => new Date(); // what token expiry is checked against; tests move it
  constructor(db: D1Database, key: CryptoKey) { this.db = db; this.key = key; }

  async audit(actor: string, action: string, project: string | null, names: string[] = []) {
    await this.db.prepare("INSERT INTO audit (at, actor, action, project, names) VALUES (?, ?, ?, ?, ?)")
      .bind(now(), actor, action, project, names.join(",")).run();
  }

  // --- caller tokens ---

  async caller(token: string): Promise<Caller | null> {
    // Why here and not only in the sweep: an expired token must stop at its expiry, not up to one
    // sweep later. The sweep then ends the grants it still holds.
    const row = await this.db.prepare("SELECT name, projects, expires_at FROM tokens WHERE hash = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)")
      .bind(await sha256hex(token), this.clock().toISOString()).first<{ name: string; projects: string | null; expires_at: string | null }>();
    return row ? { name: row.name, projects: row.projects === null ? null : JSON.parse(row.projects), expires_at: row.expires_at } : null;
  }

  // Returns the token once; only its hash is stored. expiresAt (ISO time) is optional: without it the
  // token lives until revoked, as every token made before expiry existed does.
  async createToken(name: string, projects: string[] | null, expiresAt: string | null = null): Promise<string> {
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(name)) throw new Refused(400, `invalid token name: ${name}`);
    checkPin(projects);
    let expires: string | null = null;
    if (expiresAt !== null) {
      const t = Date.parse(expiresAt);
      if (Number.isNaN(t)) throw new Refused(400, `invalid expiry: ${expiresAt}`);
      if (t <= this.clock().getTime()) throw new Refused(400, "expiry must be in the future");
      expires = new Date(t).toISOString(); // one format, so the SQL string comparison is a time comparison
    }
    const token = randomToken();
    await this.db.prepare("INSERT INTO tokens (name, hash, projects, created_at, expires_at) VALUES (?, ?, ?, ?, ?)")
      .bind(name, await sha256hex(token), projects === null ? null : JSON.stringify(projects), now(), expires).run()
      .catch((e: Error) => { throw /UNIQUE/.test(e.message) ? new Refused(409, `token ${name} exists`) : e; });
    return token;
  }

  // Changes which projects a live token reads, so widening one never means minting a new token and
  // re-entering the network secret that carries it. null = global keys only.
  async setPin(name: string, projects: string[] | null) {
    checkPin(projects);
    const r = await this.db.prepare("UPDATE tokens SET projects = ? WHERE name = ? AND revoked_at IS NULL")
      .bind(projects === null ? null : JSON.stringify(projects), name).run();
    if (!r.meta.changes) throw new Refused(404, `no live token ${name}`);
  }

  // True when this call revoked it; false when it was already revoked, so a retry still reaches the
  // grant cleanup that an interrupted first attempt left undone.
  async revokeToken(name: string): Promise<boolean> {
    const r = await this.db.prepare("UPDATE tokens SET revoked_at = ? WHERE name = ? AND revoked_at IS NULL").bind(now(), name).run();
    if (r.meta.changes) return true;
    if (await this.db.prepare("SELECT 1 FROM tokens WHERE name = ?").bind(name).first()) return false;
    throw new Refused(404, `no token ${name}`);
  }

  async tokens(): Promise<TokenRow[]> {
    const { results } = await this.db.prepare("SELECT name, projects, created_at, revoked_at, expires_at FROM tokens ORDER BY name").all<any>();
    return results.map((r) => ({ ...r, projects: r.projects === null ? null : JSON.parse(r.projects) }));
  }

  // --- keys ---

  // kind is 'static' (the value is handed out as is) or 'mint:<provider>' (the value is a parent
  // credential that never leaves the broker; config says what children it may mint).
  async put(scope: string, name: string, value: string,
    meta: { description?: string; owner?: string; expires_at?: string | null; kind?: string; config?: Record<string, unknown>; checked?: boolean } = {}) {
    checkScope(scope); checkName(name);
    if (!value) throw new Refused(400, "empty value");
    // Why: rotating a value without naming a kind keeps the old kind and config. Defaulting to
    // static there would turn a parent credential into a value handed to every caller.
    const prev = await this.keyRow(scope, name);
    const kind = meta.kind ?? prev?.kind ?? "static", config = meta.config ? JSON.stringify(meta.config) : prev?.config ?? "{}";
    if (kind !== "static" && !/^mint:[a-z0-9-]+$/.test(kind)) throw new Refused(400, `invalid kind: ${kind}`);
    if (prev && prev.kind !== "static" && kind === "static") {
      throw new Refused(409, `${scope}/${name} is ${prev.kind}; its value is a parent credential, so delete the key to make it static`);
    }
    // Why: a parent goes into an Authorization header, and a runtime that rejects a bad header value
    // may quote it in the error, which then reaches a log line.
    if (kind === "static") staticCheck(JSON.parse(config)); // a static key's config holds only its check
    if (kind !== "static" && !/^[\x21-\x7e]+$/.test(value)) throw new Refused(400, "a parent credential must be printable ASCII with no spaces");
    const { iv, ciphertext } = await seal(this.key, scope, name, value), t = now();
    // Why one batch: the old revision is retired in the same transaction that replaces it, so even
    // concurrent writes each keep the parent they displaced.
    await this.db.batch([this.retire(scope, name), this.db.prepare(
      `INSERT INTO keys (scope, name, kind, config, rev, checked, description, owner, iv, ciphertext, created_at, rotated_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (scope, name) DO UPDATE SET iv = excluded.iv, ciphertext = excluded.ciphertext,
         kind = excluded.kind, config = excluded.config, rev = excluded.rev, checked = excluded.checked,
         rotated_at = excluded.rotated_at, expires_at = excluded.expires_at,
         description = CASE WHEN excluded.description = '' THEN keys.description ELSE excluded.description END,
         owner = CASE WHEN excluded.owner = '' THEN keys.owner ELSE excluded.owner END`,
    ).bind(scope, name, kind, config, crypto.randomUUID(), meta.checked ? 1 : 0, meta.description ?? "", meta.owner ?? "", iv, ciphertext, t, t, meta.expires_at ?? null)]);
  }

  retire(scope: string, name: string) {
    return this.db.prepare(
      `INSERT OR IGNORE INTO retired_keys (scope, name, rev, kind, config, iv, ciphertext, retire_until)
       SELECT scope, name, rev, kind, config, iv, ciphertext, ? FROM keys WHERE scope = ? AND name = ? AND kind != 'static'`,
    ).bind(new Date(Date.now() + RETIRE_MS).toISOString(), scope, name);
  }

  // A mint key at a given revision, current or retired: what minted a grant's child, so it can be revoked.
  async revision(scope: string, name: string, rev: string) {
    return await this.db.prepare("SELECT scope, name, kind, config, rev, iv, ciphertext FROM keys WHERE scope = ? AND name = ? AND rev = ?")
      .bind(scope, name, rev).first<MintRow>()
      ?? await this.db.prepare("SELECT scope, name, kind, config, rev, iv, ciphertext FROM retired_keys WHERE scope = ? AND name = ? AND rev = ?")
        .bind(scope, name, rev).first<MintRow>();
  }

  // The sealed row for one key, as the grants module needs it to mint. Never leaves the broker.
  async keyRow(scope: string, name: string) {
    return this.db.prepare("SELECT scope, name, kind, config, rev, iv, ciphertext FROM keys WHERE scope = ? AND name = ?")
      .bind(scope, name).first<MintRow>();
  }

  // The row `caller` reads for `name`: the most specific of deployment, project and global.
  async rowFor(caller: Caller, requested: string | null, name: string) {
    const project = this.scopeFor(caller, requested);
    checkName(name);
    const row = await this.nearest(project, name);
    if (!row) throw new Refused(404, `unknown keys: ${name}`);
    return { project, row };
  }

  async nearest(project: string | null, name: string) {
    for (const scope of chain(project).reverse()) {
      const row = await this.keyRow(scope, name);
      if (row) return row;
    }
    return null;
  }

  async remove(scope: string, name: string) {
    const [, r] = await this.db.batch([this.retire(scope, name), this.db.prepare("DELETE FROM keys WHERE scope = ? AND name = ?").bind(scope, name)]);
    if (!r.meta.changes) throw new Refused(404, `no key ${scope}/${name}`);
  }

  // Moves every key in `from` to `to` (huddles-dev to huddles/dev), resealed under the new scope, and
  // repoints the live pins that name `from`. Values are write-only, so this is the only way to move a
  // scope without pasting each value again. Each key moves in one batch, so a move cut short is
  // finished by running it again. The caller ends the grants on what moved (app.ts).
  async moveScope(from: string, to: string) {
    if (!LEGACY.test(from)) throw new Refused(400, `invalid scope: ${from}`);
    checkScope(to);
    if (from === GLOBAL || to === GLOBAL) throw new Refused(400, "move a project or deployment, not global");
    if (from === to) throw new Refused(400, "from and to are the same scope");
    const { results } = await this.db.prepare("SELECT * FROM keys WHERE scope = ? ORDER BY name").bind(from).all<any>();
    const clash = [];
    for (const r of results) if (await this.keyRow(to, r.name)) clash.push(r.name);
    // Why refuse rather than overwrite: the row in `to` may be a different value someone relies on.
    if (clash.length) throw new Refused(409, `${to} already has ${clash.join(", ")}; nothing was moved`);
    for (const r of results) {
      const { iv, ciphertext } = await seal(this.key, to, r.name, await this.value(r));
      await this.db.batch([this.retire(from, r.name), this.db.prepare(
        `INSERT INTO keys (scope, name, kind, config, rev, checked, description, owner, iv, ciphertext, created_at, rotated_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(to, r.name, r.kind, r.config, crypto.randomUUID(), r.checked, r.description, r.owner, iv, ciphertext, r.created_at, r.rotated_at, r.expires_at),
      this.db.prepare("DELETE FROM keys WHERE scope = ? AND name = ?").bind(from, r.name)]);
    }
    const repinned: { name: string; projects: string[] }[] = [];
    for (const t of await this.tokens()) {
      // A token that read `from` reads `to` instead: `from` leaves its pin (so a later scope of that name
      // isn't reached by accident), and `to` is added unless the pin already reaches it.
      if (t.revoked_at || !pinReaches(t.projects, from)) continue;
      const projects = t.projects!.filter((p) => p !== from);
      if (!pinReaches(projects, to)) projects.push(to);
      if (projects.length === t.projects!.length && projects.every((p, i) => p === t.projects![i])) continue;
      await this.setPin(t.name, projects);
      repinned.push({ name: t.name, projects });
    }
    return { moved: results.map((r) => ({ name: r.name as string, kind: r.kind as string })), repinned };
  }

  async list(): Promise<KeyRow[]> {
    const { results } = await this.db.prepare(
      "SELECT scope, name, kind, config, description, owner, created_at, rotated_at, expires_at, checked FROM keys ORDER BY name, scope",
    ).all<KeyRow>();
    return results;
  }

  // The project the caller reads as. Identity comes from the token, never the request: a pinned
  // token may pick any scope its pin reaches (or defaults to its only entry, when that names one
  // project; otherwise to globals only). Any other scope is refused.
  scopeFor(caller: Caller, requested: string | null): string | null {
    if (caller.projects === null) {
      if (requested) throw new Refused(403, "this token reads global keys only");
      return null;
    }
    if (requested) {
      checkScope(requested);
      if (requested === GLOBAL || !pinReaches(caller.projects, requested)) throw new Refused(403, `project ${requested} is outside this token's pin`);
      return requested;
    }
    if (caller.projects.length === 1 && !caller.projects[0].startsWith("*")) return caller.projects[0];
    // Why not refuse: one agent token serves many repos, and a repo with no `.tumbler` project
    // still needs its global keys. Globals are what every token reads anyway.
    return null;
  }

  // Values for `names` (or every visible key when empty), project rows over global rows. A minted
  // key's value is whatever `mint` returns for it (a child credential); its parent is never output.
  async resolve(caller: Caller, requested: string | null, names: string[],
    mint?: (caller: Caller, project: string | null, row: MintRow) => Promise<string>): Promise<Record<string, string>> {
    const project = this.scopeFor(caller, requested);
    names.forEach(checkName);
    const scopes = chain(project);
    const { results } = await this.db.prepare(
      `SELECT scope, name, kind, config, rev, iv, ciphertext FROM keys WHERE scope IN (${scopes.map(() => "?").join(",")})`,
    ).bind(...scopes).all<MintRow>();
    const win = winners(results, scopes, names);
    const out: Record<string, string> = {};
    // Why: refuse before minting anything when there is no minter to hand a parent to.
    for (const r of win.values()) if (r.kind !== "static" && !mint) throw new Refused(501, `${r.name} is a minted key and minting is off`);
    for (const r of win.values()) {
      out[r.name] = r.kind === "static" ? await open(this.key, r.scope, r.name, bytes(r.iv), bytes(r.ciphertext)) : await mint!(caller, project, r);
    }
    const missing = names.filter((n) => !(n in out));
    if (missing.length) throw new Refused(404, `unknown keys: ${missing.join(", ")}`);
    await this.audit(caller.name, "read", project, Object.keys(out).sort());
    return out;
  }

  // A key's stored value. Only for a check run here; it is never returned (a mint key's is its parent).
  value(row: MintRow) { return open(this.key, row.scope, row.name, bytes(row.iv), bytes(row.ciphertext)); }

  // Each key's revision and whether that revision passed its check, the most specific row winning.
  // Never values and never a mint, so `tumbler run --watch` can poll it.
  async revisions(caller: Caller, requested: string | null, names: string[]) {
    const project = this.scopeFor(caller, requested), scopes = chain(project);
    names.forEach(checkName);
    const { results } = await this.db.prepare(
      `SELECT scope, name, rev, checked FROM keys WHERE scope IN (${scopes.map(() => "?").join(",")})`,
    ).bind(...scopes).all<{ scope: string; name: string; rev: string; checked: number }>();
    const out: Record<string, { rev: string; checked: boolean }> = {};
    for (const r of winners(results, scopes, names).values()) out[r.name] = { rev: r.rev, checked: !!r.checked };
    return { project, keys: out };
  }

  // Names and descriptions the caller could read, the most specific row winning; an empty description
  // falls back to a less specific row's. No values.
  async visible(caller: Caller, requested: string | null): Promise<{ project: string | null; keys: { name: string; description: string }[] }> {
    const project = this.scopeFor(caller, requested), scopes = chain(project);
    const { results } = await this.db.prepare(
      `SELECT scope, name, description FROM keys WHERE scope IN (${scopes.map(() => "?").join(",")}) ORDER BY name`,
    ).bind(...scopes).all<{ scope: string; name: string; description: string }>();
    const byName = new Map<string, string>();
    results.sort((a, b) => scopes.indexOf(a.scope) - scopes.indexOf(b.scope));
    for (const r of results) byName.set(r.name, r.description || byName.get(r.name) || "");
    return { project, keys: [...byName].sort(([a], [b]) => a < b ? -1 : 1).map(([name, description]) => ({ name, description })) };
  }

  async recentAudit(limit = 100) {
    const { results } = await this.db.prepare("SELECT at, actor, action, project, names FROM audit ORDER BY id DESC LIMIT ?").bind(limit).all();
    return results;
  }
}

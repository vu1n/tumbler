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

// What a token may write: pin entries, plus `global` (named, never implied: a global key reaches every
// token). Trimmed, sorted, deduped; empty is null (writes nothing).
function checkWrites(writes: string[] | null): string[] | null {
  const list = [...new Set((writes ?? []).map((w) => String(w).trim()).filter(Boolean))].sort();
  for (const w of list) {
    if (w !== GLOBAL && !PIN.test(w)) throw new Refused(400, `invalid write scope: ${w}; name global, a project, project/env, * or */env (env: ${ENVIRONMENTS.join(", ")})`);
  }
  return list.length ? list : null;
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
// A token's scopes: names as a mint key's config gives them (`workers:write`), or `*` for any.
// Reads need no listing. Empty means reads only, stored as null.
// A scope name a mint key may define and a token may be given: no whitespace, at most 128 chars.
// Grants.validate() holds key configs to it, so every scope a key has can be granted exactly.
export const scopeName = (s: string) => s.length > 0 && s.length <= 128 && !/[\s\x00-\x1f]/.test(s);

function checkCeiling(scopes: string[] | null): string[] | null {
  const list = [...new Set((scopes ?? []).map((s) => String(s).trim()).filter(Boolean))].sort();
  // Any name a mint key's config may give a scope (`deploy`, `release/candidate`), so a refused scope
  // can always be added exactly; `*` alone is the wildcard.
  for (const s of list) if (!scopeName(s)) throw new Refused(400, `invalid scope: ${s}`);
  return list.length ? list : null;
}
const asJson = (v: string[] | null) => v === null ? null : JSON.stringify(v);

export function pinReaches(projects: string[] | null, scope: string | null) {
  if (scope === null) return true;
  const env = scope.split("/")[1];
  return !!projects && (projects.includes(scope) || projects.includes(env ? `*/${env}` : "*"));
}

// Whether a token may write `scope`: global only when named, otherwise as a pin reaches it.
export function writeReaches(writes: string[] | null | undefined, scope: string) {
  if (!writes) return false;
  return scope === GLOBAL ? writes.includes(GLOBAL) : pinReaches(writes, scope);
}

// `scopes`: the minted scopes the token may hold beyond reads (`*`: any), its ceiling. Inside it a
// child is minted at once; outside it the request is refused. null: reads only.
// `writes`: the scopes `tumbler put` may save static keys in (checkWrites). null: writes nothing.
// `operator`: may add or remove permission groups on the minted keys it reads (`tumbler scope`).
// `hash`: which credential authenticated, so a mint that lands after the name was reused by a new
// token is refused (the name alone would pass).
export interface Caller { name: string; projects: string[] | null; scopes?: string[] | null; writes?: string[] | null; operator?: boolean; expires_at?: string | null; hash?: string }
export interface KeyRow {
  scope: string; name: string; kind: string; config: string; description: string; owner: string;
  created_at: string; rotated_at: string; expires_at: string | null; checked: number;
}
export interface MintRow { scope: string; name: string; kind: string; config: string; rev: string; iv: ArrayBuffer; ciphertext: ArrayBuffer }
export interface TokenRow { name: string; projects: string[] | null; scopes: string[] | null; writes: string[] | null; operator: boolean; created_at: string; revoked_at: string | null; expires_at: string | null }

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
    const hash = await sha256hex(token);
    const row = await this.db.prepare("SELECT name, projects, scopes, writes, operator, expires_at FROM tokens WHERE hash = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)")
      .bind(hash, this.clock().toISOString()).first<{ name: string; projects: string | null; scopes: string | null; writes: string | null; operator: number; expires_at: string | null }>();
    return row ? { name: row.name, projects: row.projects === null ? null : JSON.parse(row.projects),
      scopes: row.scopes === null ? null : JSON.parse(row.scopes), writes: row.writes === null ? null : JSON.parse(row.writes), operator: !!row.operator, expires_at: row.expires_at, hash } : null;
  }

  // Returns the token once; only its hash is stored. expiresAt (ISO time) is optional: without it the
  // token lives until revoked, as every token made before expiry existed does.
  async createToken(...a: Parameters<Catalog["newToken"]>): Promise<string> { return (await this.newToken(...a)).token; }

  // createToken, also naming the archived token when the name was free because its token had ended
  // (see below), so the caller can end that token's grants at once.
  async newToken(name: string, projects: string[] | null, expiresAt: string | null = null, scopes: string[] | null = null, writes: string[] | null = null, operator = false): Promise<{ token: string; archived: string | null }> {
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(name)) throw new Refused(400, `invalid token name: ${name}`);
    checkPin(projects);
    scopes = checkCeiling(scopes);
    writes = checkWrites(writes);
    let expires: string | null = null;
    if (expiresAt !== null) {
      const t = Date.parse(expiresAt);
      if (Number.isNaN(t)) throw new Refused(400, `invalid expiry: ${expiresAt}`);
      if (t <= this.clock().getTime()) throw new Refused(400, "expiry must be in the future");
      expires = new Date(t).toISOString(); // one format, so the SQL string comparison is a time comparison
    }
    const token = randomToken();
    const insert = this.db.prepare("INSERT INTO tokens (name, hash, projects, scopes, writes, operator, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(name, await sha256hex(token), projects === null ? null : JSON.stringify(projects), asJson(scopes), asJson(writes), operator ? 1 : 0, now(), expires);
    const ended = await this.db.prepare("SELECT hash FROM tokens WHERE name = ? AND (revoked_at IS NOT NULL OR expires_at <= ?)").bind(name, this.clock().toISOString()).first<{ hash: string }>();
    if (!ended) {
      await insert.run().catch((e: Error) => { throw /UNIQUE/.test(e.message) ? new Refused(409, `token ${name} is live; revoke it first (tumbler admin token revoke ${name}) or pick another name`) : e; });
      return { token, archived: null };
    }
    // An ended token's name is reused by moving that token, with every grant under its name, to an
    // archived name in the same transaction as the insert: the new token starts with no grants and
    // nothing of the old one, and the sweep still ends the old grants (their token reads ended).
    // If the name isn't that ended token's any more (a concurrent create, a revive), the insert
    // fails on the name and the whole batch, grant moves included, rolls back.
    const archived = `${name}~${ended.hash.slice(0, 8)}`;
    await this.db.batch([
      this.db.prepare("UPDATE tokens SET name = ? WHERE name = ? AND hash = ? AND (revoked_at IS NOT NULL OR expires_at <= ?)").bind(archived, name, ended.hash, this.clock().toISOString()),
      insert,
      this.db.prepare("UPDATE grants SET caller = ? WHERE caller = ?").bind(archived, name),
    ]).catch((e: Error) => { throw /UNIQUE/.test(e.message) ? new Refused(409, `token ${name} changed while this ran; run it again`) : e; });
    return { token, archived };
  }

  // Changes which projects a live token reads, so widening one never means minting a new token and
  // re-entering the network secret that carries it. null = global keys only.
  async setPin(name: string, projects: string[] | null) {
    await this.updateToken(name, { projects });
  }

  // Changes which minted scopes a live token may hold. Narrowing ends the children it holds beyond
  // the new scopes (Grants.closeOutsideCeiling, or the sweep if that is cut short); widening takes
  // effect on its next request. Returns the ceiling as stored (trimmed, sorted, deduped; empty is null).
  async setScopes(name: string, scopes: string[] | null) {
    return (await this.updateToken(name, { scopes })).scopes ?? null;
  }

  // A live token's pin, ceiling, writes and/or operator flag in one write, all checked first, so a
  // refused part never lands the others. Returns the fields as stored.
  async updateToken(name: string, edit: { projects?: string[] | null; scopes?: string[] | null; writes?: string[] | null; operator?: boolean }) {
    const done: { projects?: string[] | null; scopes?: string[] | null; writes?: string[] | null; operator?: boolean } = {}, sets: string[] = [], binds: (string | number | null)[] = [];
    if ("projects" in edit) { checkPin(done.projects = edit.projects ?? null); sets.push("projects = ?"); binds.push(asJson(done.projects)); }
    if ("scopes" in edit) { done.scopes = checkCeiling(edit.scopes ?? null); sets.push("scopes = ?"); binds.push(asJson(done.scopes)); }
    if ("writes" in edit) { done.writes = checkWrites(edit.writes ?? null); sets.push("writes = ?"); binds.push(asJson(done.writes)); }
    if ("operator" in edit) { done.operator = edit.operator === true; sets.push("operator = ?"); binds.push(done.operator ? 1 : 0); }
    if (!sets.length) return done;
    const r = await this.db.prepare(`UPDATE tokens SET ${sets.join(", ")} WHERE name = ? AND revoked_at IS NULL`).bind(...binds, name).run();
    if (!r.meta.changes) throw new Refused(404, `no live token ${name}`);
    return done;
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
    const { results } = await this.db.prepare("SELECT name, projects, scopes, writes, operator, created_at, revoked_at, expires_at FROM tokens ORDER BY name").all<any>();
    const parse = (v: string | null) => v === null ? null : JSON.parse(v);
    return results.map((r) => ({ ...r, projects: parse(r.projects), scopes: parse(r.scopes), writes: parse(r.writes), operator: !!r.operator }));
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

  // A mint key's new config under a new revision, only if it is still at `rev`: the old revision is
  // retired in the same batch (its parent revokes the children it minted), as a rotation does.
  async setConfig(scope: string, name: string, rev: string, config: Record<string, unknown>): Promise<boolean> {
    // Why retire by rev: a change that lost a race must not retire the winner's revision early.
    const [, r] = await this.db.batch([this.db.prepare(
      `INSERT OR IGNORE INTO retired_keys (scope, name, rev, kind, config, iv, ciphertext, retire_until)
       SELECT scope, name, rev, kind, config, iv, ciphertext, ? FROM keys WHERE scope = ? AND name = ? AND rev = ? AND kind != 'static'`,
    ).bind(new Date(Date.now() + RETIRE_MS).toISOString(), scope, name, rev), this.db.prepare(
      "UPDATE keys SET config = ?, rev = ?, rotated_at = ? WHERE scope = ? AND name = ? AND rev = ? AND kind != 'static'",
    ).bind(JSON.stringify(config), crypto.randomUUID(), now(), scope, name, rev)]);
    return !!r.meta.changes;
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

  // Deletes only while the row is still static, in the same statement: a caller token never deletes a
  // parent credential, even one an admin made of this name a moment ago. False when nothing was deleted.
  async removeStatic(scope: string, name: string) {
    const r = await this.db.prepare("DELETE FROM keys WHERE scope = ? AND name = ? AND kind = 'static'").bind(scope, name).run();
    return r.meta.changes > 0;
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
    // A list that reached `from` reaches `to` instead: `from` leaves it (so a later scope of that name
    // isn't reached by accident), and `to` is added unless the list already reaches it. null: unchanged.
    const repoint = (list: string[] | null) => {
      if (!pinReaches(list, from)) return null;
      const next = list!.filter((p) => p !== from);
      if (!pinReaches(next, to)) next.push(to);
      return next.length === list!.length && next.every((p, i) => p === list![i]) ? null : next;
    };
    for (const t of await this.tokens()) {
      if (t.revoked_at) continue;
      // A token that wrote `from` writes `to`, as it reads it.
      const projects = repoint(t.projects), writes = repoint(t.writes);
      if (writes) await this.db.prepare("UPDATE tokens SET writes = ? WHERE name = ? AND revoked_at IS NULL").bind(JSON.stringify(writes), t.name).run();
      if (!projects) continue;
      // Not setPin(): `to` is already checked, and other pre-environment entries a token still holds
      // must not block moving this one (they're moved by their own runs).
      await this.db.prepare("UPDATE tokens SET projects = ? WHERE name = ? AND revoked_at IS NULL").bind(JSON.stringify(projects), t.name).run();
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

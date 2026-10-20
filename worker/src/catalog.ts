// catalog.ts — keys, tokens and audit in D1. Values go in sealed and come out only through resolve().
import { open, randomToken, seal, sha256hex } from "./crypto.ts";

export const GLOBAL = "global";
const NAME = /^[A-Z_][A-Z0-9_]{0,127}$/;
const PROJECT = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export class Refused extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

export function checkName(name: string) { if (!NAME.test(name)) throw new Refused(400, `invalid key name: ${name}`); }
export function checkScope(scope: string) {
  if (scope !== GLOBAL && !PROJECT.test(scope)) throw new Refused(400, `invalid scope: ${scope}`);
}

export interface Caller { name: string; projects: string[] | null }
export interface KeyRow {
  scope: string; name: string; kind: string; config: string; description: string; owner: string;
  created_at: string; rotated_at: string; expires_at: string | null;
}
export interface MintRow { scope: string; name: string; kind: string; config: string; rev: string; iv: ArrayBuffer; ciphertext: ArrayBuffer }
export interface TokenRow { name: string; projects: string[] | null; created_at: string; revoked_at: string | null }

const now = () => new Date().toISOString();
// Children live at most 24h (MAX_TTL_MIN in grants.ts); a retired parent is kept a little longer.
export const RETIRE_MS = 25 * 60 * 60 * 1000;
const bytes = (v: unknown) => v instanceof Uint8Array ? v : new Uint8Array(v as ArrayBuffer);

export class Catalog {
  db: D1Database; key: CryptoKey;
  constructor(db: D1Database, key: CryptoKey) { this.db = db; this.key = key; }

  async audit(actor: string, action: string, project: string | null, names: string[] = []) {
    await this.db.prepare("INSERT INTO audit (at, actor, action, project, names) VALUES (?, ?, ?, ?, ?)")
      .bind(now(), actor, action, project, names.join(",")).run();
  }

  // --- caller tokens ---

  async caller(token: string): Promise<Caller | null> {
    const row = await this.db.prepare("SELECT name, projects FROM tokens WHERE hash = ? AND revoked_at IS NULL")
      .bind(await sha256hex(token)).first<{ name: string; projects: string | null }>();
    return row ? { name: row.name, projects: row.projects === null ? null : JSON.parse(row.projects) } : null;
  }

  // Returns the token once; only its hash is stored.
  async createToken(name: string, projects: string[] | null): Promise<string> {
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(name)) throw new Refused(400, `invalid token name: ${name}`);
    for (const p of projects ?? []) { checkScope(p); if (p === GLOBAL) throw new Refused(400, "pin projects, not global"); }
    const token = randomToken();
    await this.db.prepare("INSERT INTO tokens (name, hash, projects, created_at) VALUES (?, ?, ?, ?)")
      .bind(name, await sha256hex(token), projects === null ? null : JSON.stringify(projects), now()).run()
      .catch((e: Error) => { throw /UNIQUE/.test(e.message) ? new Refused(409, `token ${name} exists`) : e; });
    return token;
  }

  async revokeToken(name: string) {
    const r = await this.db.prepare("UPDATE tokens SET revoked_at = ? WHERE name = ? AND revoked_at IS NULL").bind(now(), name).run();
    if (!r.meta.changes) throw new Refused(404, `no live token ${name}`);
  }

  async tokens(): Promise<TokenRow[]> {
    const { results } = await this.db.prepare("SELECT name, projects, created_at, revoked_at FROM tokens ORDER BY name").all<any>();
    return results.map((r) => ({ ...r, projects: r.projects === null ? null : JSON.parse(r.projects) }));
  }

  // --- keys ---

  // kind is 'static' (the value is handed out as is) or 'mint:<provider>' (the value is a parent
  // credential that never leaves the broker; config says what children it may mint).
  async put(scope: string, name: string, value: string,
    meta: { description?: string; owner?: string; expires_at?: string | null; kind?: string; config?: Record<string, unknown> } = {}) {
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
    const { iv, ciphertext } = await seal(this.key, scope, name, value), t = now();
    // Why one batch: the old revision is retired in the same transaction that replaces it, so even
    // concurrent writes each keep the parent they displaced.
    await this.db.batch([this.retire(scope, name), this.db.prepare(
      `INSERT INTO keys (scope, name, kind, config, rev, description, owner, iv, ciphertext, created_at, rotated_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (scope, name) DO UPDATE SET iv = excluded.iv, ciphertext = excluded.ciphertext,
         kind = excluded.kind, config = excluded.config, rev = excluded.rev,
         rotated_at = excluded.rotated_at, expires_at = excluded.expires_at,
         description = CASE WHEN excluded.description = '' THEN keys.description ELSE excluded.description END,
         owner = CASE WHEN excluded.owner = '' THEN keys.owner ELSE excluded.owner END`,
    ).bind(scope, name, kind, kind === "static" ? "{}" : config, crypto.randomUUID(), meta.description ?? "", meta.owner ?? "", iv, ciphertext, t, t, meta.expires_at ?? null)]);
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

  // The row `caller` reads for `name`: the project's over the global one.
  async rowFor(caller: Caller, requested: string | null, name: string) {
    const project = this.scopeFor(caller, requested);
    checkName(name);
    const row = (project ? await this.keyRow(project, name) : null) ?? await this.keyRow(GLOBAL, name);
    if (!row) throw new Refused(404, `unknown keys: ${name}`);
    return { project, row };
  }

  async remove(scope: string, name: string) {
    const [, r] = await this.db.batch([this.retire(scope, name), this.db.prepare("DELETE FROM keys WHERE scope = ? AND name = ?").bind(scope, name)]);
    if (!r.meta.changes) throw new Refused(404, `no key ${scope}/${name}`);
  }

  async list(): Promise<KeyRow[]> {
    const { results } = await this.db.prepare(
      "SELECT scope, name, kind, config, description, owner, created_at, rotated_at, expires_at FROM keys ORDER BY name, scope",
    ).all<KeyRow>();
    return results;
  }

  // The project the caller reads as. Identity comes from the token, never the request: a pinned
  // token may pick among its pins (or defaults to its only one); anything else is refused.
  scopeFor(caller: Caller, requested: string | null): string | null {
    if (caller.projects === null) {
      if (requested) throw new Refused(403, "this token reads global keys only");
      return null;
    }
    if (requested) {
      if (!caller.projects.includes(requested)) throw new Refused(403, `project ${requested} is outside this token's pin`);
      return requested;
    }
    if (caller.projects.length === 1) return caller.projects[0];
    throw new Refused(400, "this token is pinned to several projects; pass ?project=");
  }

  // Values for `names` (or every visible key when empty), project rows over global rows. A minted
  // key's value is whatever `mint` returns for it (a child credential); its parent is never output.
  async resolve(caller: Caller, requested: string | null, names: string[],
    mint?: (caller: Caller, project: string | null, row: MintRow) => Promise<string>): Promise<Record<string, string>> {
    const project = this.scopeFor(caller, requested);
    names.forEach(checkName);
    const scopes = project ? [GLOBAL, project] : [GLOBAL];
    const { results } = await this.db.prepare(
      `SELECT scope, name, kind, config, rev, iv, ciphertext FROM keys WHERE scope IN (${scopes.map(() => "?").join(",")})`,
    ).bind(...scopes).all<MintRow>();
    const want = new Set(names), win = new Map<string, MintRow>();
    for (const r of results) {
      if (want.size && !want.has(r.name)) continue;
      if (win.get(r.name)?.scope === project) continue; // a project row already won
      win.set(r.name, r);
    }
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

  // Names and descriptions the caller could read, project rows over global ones. No values.
  async visible(caller: Caller, requested: string | null): Promise<{ project: string | null; keys: { name: string; description: string }[] }> {
    const project = this.scopeFor(caller, requested), scopes = project ? [GLOBAL, project] : [GLOBAL];
    const { results } = await this.db.prepare(
      `SELECT scope, name, description FROM keys WHERE scope IN (${scopes.map(() => "?").join(",")}) ORDER BY name`,
    ).bind(...scopes).all<{ scope: string; name: string; description: string }>();
    const byName = new Map<string, string>();
    for (const r of results) if (!byName.has(r.name) || r.scope === project) byName.set(r.name, r.description || byName.get(r.name) || "");
    return { project, keys: [...byName].map(([name, description]) => ({ name, description })) };
  }

  async recentAudit(limit = 100) {
    const { results } = await this.db.prepare("SELECT at, actor, action, project, names FROM audit ORDER BY id DESC LIMIT ?").bind(limit).all();
    return results;
  }
}

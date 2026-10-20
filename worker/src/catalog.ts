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
  scope: string; name: string; kind: string; description: string; owner: string;
  created_at: string; rotated_at: string; expires_at: string | null;
}
export interface TokenRow { name: string; projects: string[] | null; created_at: string; revoked_at: string | null }

const now = () => new Date().toISOString();
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

  async put(scope: string, name: string, value: string, meta: { description?: string; owner?: string; expires_at?: string | null } = {}) {
    checkScope(scope); checkName(name);
    if (!value) throw new Refused(400, "empty value");
    const { iv, ciphertext } = await seal(this.key, scope, name, value), t = now();
    await this.db.prepare(
      `INSERT INTO keys (scope, name, kind, description, owner, iv, ciphertext, created_at, rotated_at, expires_at)
       VALUES (?, ?, 'static', ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (scope, name) DO UPDATE SET iv = excluded.iv, ciphertext = excluded.ciphertext,
         rotated_at = excluded.rotated_at, expires_at = excluded.expires_at,
         description = CASE WHEN excluded.description = '' THEN keys.description ELSE excluded.description END,
         owner = CASE WHEN excluded.owner = '' THEN keys.owner ELSE excluded.owner END`,
    ).bind(scope, name, meta.description ?? "", meta.owner ?? "", iv, ciphertext, t, t, meta.expires_at ?? null).run();
  }

  async remove(scope: string, name: string) {
    const r = await this.db.prepare("DELETE FROM keys WHERE scope = ? AND name = ?").bind(scope, name).run();
    if (!r.meta.changes) throw new Refused(404, `no key ${scope}/${name}`);
  }

  async list(): Promise<KeyRow[]> {
    const { results } = await this.db.prepare(
      "SELECT scope, name, kind, description, owner, created_at, rotated_at, expires_at FROM keys ORDER BY name, scope",
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

  // Values for `names` (or every visible key when empty), project rows over global rows.
  async resolve(caller: Caller, requested: string | null, names: string[]): Promise<Record<string, string>> {
    const project = this.scopeFor(caller, requested);
    names.forEach(checkName);
    const scopes = project ? [GLOBAL, project] : [GLOBAL];
    const { results } = await this.db.prepare(
      `SELECT scope, name, iv, ciphertext FROM keys WHERE scope IN (${scopes.map(() => "?").join(",")})`,
    ).bind(...scopes).all<{ scope: string; name: string; iv: ArrayBuffer; ciphertext: ArrayBuffer }>();
    const want = new Set(names), out: Record<string, string> = {}, from: Record<string, string> = {};
    for (const r of results) {
      if (want.size && !want.has(r.name)) continue;
      if (from[r.name] === project) continue; // a project row already won
      out[r.name] = await open(this.key, r.scope, r.name, bytes(r.iv), bytes(r.ciphertext));
      from[r.name] = r.scope;
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

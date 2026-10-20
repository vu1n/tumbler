// grants.ts — minted keys. A key of kind `mint:<provider>` holds a parent credential; callers never
// see it. Each caller gets a grant on the key: a set of approved scopes and a short-lived child
// credential minted for exactly those scopes. The grant's state decides what the caller's env holds;
// machine.ts holds the states and what moves between them, and apply() is the only writer.
//
// Only `active` ever yields a credential. Every other state, and every failure, yields none.
import { type Caller, type Catalog, Refused } from "./catalog.ts";
import { open, seal } from "./crypto.ts";
import { autoApproved, type GrantEvent, type GrantState, isLive, transition } from "./machine.ts";
import type { Outcome } from "./verify.ts";

export { autoApproved };

export interface Minted { id: string; value: string }
export interface MintConfig { ttl_minutes?: number; start?: string[]; scopes?: Record<string, unknown>; [k: string]: unknown }
export interface Provider {
  validate(config: MintConfig): void;
  mint(parent: string, config: MintConfig, scopes: string[], expiresAt: Date, label: string): Promise<Minted>;
  revoke(parent: string, config: MintConfig, childId: string): Promise<void>;
  // Whether a parent works, before it is saved (verify.ts). Optional: without it a key saves unchecked.
  verify?(parent: string, config: MintConfig): Promise<Outcome>;
}

export const DEFAULT_TTL_MIN = 30, MIN_TTL_MIN = 15, MAX_TTL_MIN = 24 * 60;
// A child is handed out again only while it has this long left, so a CLI cache (5 minutes by
// default) can never hold one past its expiry.
// Approval therefore lasts ttl_minutes minus this margin.
export const REUSE_MARGIN_MS = 6 * 60 * 1000;
export const PENDING_TTL_MS = 24 * 60 * 60 * 1000; // an unanswered request lapses to denied
const ABANDONED_MS = 60 * 1000; // a read claim still unminted after this was left by a dead request

export interface KeyRow { scope: string; name: string; kind: string; config: string; rev: string; iv: ArrayBuffer | Uint8Array; ciphertext: ArrayBuffer | Uint8Array }
export interface GrantRow extends GrantState {
  id: string; caller: string; project: string | null; key_scope: string; key_rev: string; name: string; created_at: string; updated_at: string;
}

const bytes = (v: unknown) => v instanceof Uint8Array ? v : new Uint8Array(v as ArrayBuffer);
const union = (a: string[], b: string[]) => [...new Set([...a, ...b])].sort();
const grantScope = (id: string) => `grant:${id}`; // AAD for the sealed child, apart from every key row
const LIVE = "state IN ('pending', 'active')";

export class Grants {
  catalog: Catalog; providers: Record<string, Provider>; now: () => Date;
  constructor(catalog: Catalog, providers: Record<string, Provider>, now = () => new Date()) {
    this.catalog = catalog; this.providers = providers; this.now = now;
  }
  get db() { return this.catalog.db; }

  provider(kind: string): Provider {
    const p = kind.startsWith("mint:") ? this.providers[kind.slice(5)] : undefined;
    if (!p) throw new Refused(400, `unknown key kind: ${kind}`);
    return p;
  }

  // Checks a mint key's config before it is saved: known scopes, a sane TTL, start scopes that exist.
  validate(kind: string, config: MintConfig) {
    const p = this.provider(kind);
    const scopes = Object.keys(config.scopes ?? {});
    if (!scopes.length) throw new Refused(400, "config.scopes names no scopes");
    for (const s of config.start ?? []) if (!scopes.includes(s)) throw new Refused(400, `start scope ${s} is not in config.scopes`);
    const ttl = config.ttl_minutes ?? DEFAULT_TTL_MIN;
    if (!(ttl >= MIN_TTL_MIN && ttl <= MAX_TTL_MIN)) throw new Refused(400, `ttl_minutes must be ${MIN_TTL_MIN}..${MAX_TTL_MIN}`);
    p.validate(config);
  }

  // The child credential for `caller` on a mint key, as /v1/env returns it. Throws unless the grant
  // is active: a new grant needing approval, or one waiting on it, is a 409 and yields nothing.
  async issue(caller: Caller, project: string | null, row: KeyRow): Promise<string> {
    let g = await this.current(caller, project, row);
    if (!g) g = await this.open(caller, project, row, this.config(row).start ?? []);
    if (g.state !== "active") {
      // Another request's read grant, claimed but still minting: not a wait for approval.
      if ((g.requested ?? []).every(autoApproved) && !await this.blocked(caller, row)) throw new Refused(409, `${row.name} is being minted by another request; run again`);
      throw this.waiting(g);
    }
    return this.child(g);
  }

  // Ask for more scopes on a mint key. Read scopes are added at once (a wider child is minted);
  // anything else is recorded as `requested` and waits for an admin while the old child keeps working.
  async stepUp(caller: Caller, project: string | null, row: KeyRow, scopes: string[]): Promise<GrantRow> {
    const config = this.config(row), known = Object.keys(config.scopes ?? {});
    for (const s of scopes) if (!known.includes(s)) throw new Refused(400, `${row.name} has no scope ${s}`);
    const g = await this.current(caller, project, row);
    if (!g) return this.open(caller, project, row, union(config.start ?? [], scopes));
    const want = union(g.state === "pending" ? g.requested ?? [] : union(g.scopes, g.requested ?? []), scopes);
    if (g.state === "active" && want.every((s) => g.scopes.includes(s))) return g;
    if (g.state === "active" && !g.requested && want.every((s) => g.scopes.includes(s) || autoApproved(s))) return this.mintFor(g, row, want, "policy");
    const next = await this.apply(g, { type: "step_up", scopes, at: this.now().toISOString(), who: caller.name });
    if (!next) throw new Refused(409, `${row.name}: the grant changed meanwhile; run again`);
    if (g.state === "active") await this.catalog.audit(caller.name, "grant-step-up", project, [`${row.name}:${want.join("+")}`]);
    return next;
  }

  // `expected` is the request the admin saw; approving mints only that, so a caller can't add scopes
  // between the page loading and the click.
  async decide(id: string, approve: boolean, who: string, expected?: string[]): Promise<GrantRow> {
    const g = await this.get(id);
    if (!g || !isLive(g.state) || !g.requested) throw new Refused(404, `no grant ${id} waiting for a decision`);
    if (approve) {
      if (!expected || [...expected].sort().join("+") !== g.requested.join("+")) {
        throw new Refused(409, `grant ${id} now asks for ${g.requested.join(", ")}; reload and decide again`);
      }
      const row = await this.catalog.keyRow(g.key_scope, g.name);
      if (!row || row.rev !== g.key_rev) {
        // Minting would only fail store()'s check and burn a child; end the grant instead.
        await this.close(g, "revoked", "system");
        throw new Refused(409, `key ${g.name} was rotated or deleted since this was asked; the caller asks again`);
      }
      return this.mintFor(g, row, g.requested, who);
    }
    // A compare-and-set on the state read above, so a deny racing a revoke can't overwrite it (and
    // unstick it). An active grant keeps its old, narrower child.
    const done = await this.apply(g, { type: "deny", who });
    if (!done) throw new Refused(409, `grant ${id} changed meanwhile; reload and decide again`);
    await this.catalog.audit(who, "grant-deny", g.project, [`${g.name}:${g.requested.join("+")}`]);
    return done;
  }

  async revoke(id: string, who: string) {
    const g = await this.get(id);
    if (!g || !isLive(g.state)) throw new Refused(404, `no live grant ${id}`);
    await this.close(g, "revoked", who);
  }

  // A revoked caller token: end its grants so their children stop working now, not at expiry.
  async closeCaller(caller: string, who: string) {
    const { results } = await this.db.prepare(`SELECT * FROM grants WHERE caller = ? AND ${LIVE}`).bind(caller).all<any>();
    for (const r of results) await this.close(parse(r), "revoked", who);
  }

  // After a mint key is rotated or deleted: end every live grant on it from a revision that is no
  // longer current (any older one, not just the one this write replaced, so concurrent saves or a
  // retry after a failed close still catch them). close() revokes with the minting revision.
  async closeStale(scope: string | null = null, name: string | null = null) {
    const { results } = await this.db.prepare(
      `SELECT * FROM grants g WHERE ${LIVE} AND (? IS NULL OR (g.key_scope = ? AND g.name = ?))
         AND g.key_rev IS NOT (SELECT rev FROM keys k WHERE k.scope = g.key_scope AND k.name = g.name)`,
    ).bind(scope, scope, name).all<any>();
    for (const r of results) await this.close(parse(r), "revoked", "system");
    return results.length;
  }

  // Expire every active grant past its child's expiry and delete the child at the provider.
  async sweep() {
    const { results } = await this.db.prepare("SELECT * FROM grants WHERE state = 'active' AND expires_at <= ?")
      .bind(this.now().toISOString()).all<any>();
    for (const r of results) await this.close(parse(r), "expired", "system");
    await this.closeStale(); // grants a missed post-rotation cleanup left behind
    await this.retryRevokes();
    // Nobody answered: a pending grant lapses to denied, and a waiting step-up is dropped.
    const stale = new Date(this.now().getTime() - PENDING_TTL_MS).toISOString();
    const { results: unanswered } = await this.db.prepare(`SELECT * FROM grants WHERE ${LIVE} AND requested IS NOT NULL AND requested_at <= ?`)
      .bind(stale).all<any>();
    for (const r of unanswered) await this.apply(parse(r), { type: "lapse", who: "timeout" }); // a loser is retried next sweep
    await this.db.prepare("DELETE FROM retired_keys WHERE retire_until <= ?").bind(this.now().toISOString()).run();
    return results.length;
  }

  // A grant's history, oldest first: what happened, who did it, and the state it left.
  async events(id: string) {
    const { results } = await this.db.prepare("SELECT at, type, actor, from_state, to_state, scopes FROM grant_events WHERE grant_id = ? ORDER BY id")
      .bind(id).all<any>();
    return results.map((r) => ({ ...r, scopes: r.scopes ? JSON.parse(r.scopes) : null }));
  }

  async list(): Promise<GrantRow[]> {
    const { results } = await this.db.prepare(
      `SELECT * FROM grants ORDER BY CASE WHEN ${LIVE} THEN 0 ELSE 1 END, updated_at DESC LIMIT 200`).all<any>();
    return results.map(parse);
  }

  // --- internals ---

  config(row: KeyRow): MintConfig { return JSON.parse(row.config || "{}"); }
  fresh(g: GrantRow) { return !!g.expires_at && Date.parse(g.expires_at) - this.now().getTime() > REUSE_MARGIN_MS; }
  waiting(g: GrantRow) {
    return new Refused(409, `${g.name} needs approval for ${(g.requested ?? []).join(", ")} in /admin (grant ${g.id}); run again once approved`);
  }

  async get(id: string) {
    const r = await this.db.prepare("SELECT * FROM grants WHERE id = ?").bind(id).first<any>();
    return r ? parse(r) : null;
  }
  // The caller's live grant on this exact key row. A grant minted from another row (a project key
  // now overriding a global one) or one too close to expiry is ended, so the caller starts fresh.
  async current(caller: Caller, project: string | null, row: KeyRow) {
    const g = await this.live(caller, project, row.name);
    if (!g) return null;
    if (g.state === "active" && !this.fresh(g)) { await this.close(g, "expired", "system"); return null; }
    // A read claim whose minting request died (evicted, crashed) before storing: drop it and retry.
    if (g.state === "pending" && !g.child_id && (g.requested ?? []).every(autoApproved)
      && Date.parse(g.created_at) < this.now().getTime() - ABANDONED_MS && !await this.blocked(caller, row)) {
      await this.apply(g, { type: "abandon", who: "system" });
      return null;
    }
    // Another key row (a project key now overriding a global one) or an older revision of this one:
    // end it (close() finds the revision that minted it, retired or not) and start fresh.
    if (g.key_scope !== row.scope || g.key_rev !== row.rev) { await this.close(g, "revoked", "system"); return null; }
    return g;
  }

  // Revoked by an admin within the last day: the next grant waits for approval, even for reads, so
  // Revoke actually cuts the caller off instead of handing it a fresh read child.
  // Any project: a token pinned to several can't sidestep a revoke by switching ?project=.
  async blocked(caller: Caller, row: KeyRow) {
    const since = new Date(this.now().getTime() - PENDING_TTL_MS).toISOString();
    return !!await this.db.prepare(
      "SELECT 1 FROM grants WHERE caller = ? AND key_scope = ? AND name = ? AND state = 'revoked' AND decided_by NOT IN ('system', 'policy', 'timeout') AND updated_at > ? LIMIT 1",
    ).bind(caller.name, row.scope, row.name, since).first();
  }

  async live(caller: Caller, project: string | null, name: string) {
    const r = await this.db.prepare(`SELECT * FROM grants WHERE caller = ? AND project IS ? AND name = ? AND ${LIVE} ORDER BY created_at DESC LIMIT 1`)
      .bind(caller.name, project, name).first<any>();
    return r ? parse(r) : null;
  }

  // A new grant: active at once when every scope is a read, otherwise pending with nothing minted.
  async open(caller: Caller, project: string | null, row: KeyRow, scopes: string[]): Promise<GrantRow> {
    if (!scopes.length) throw new Refused(400, `${row.name} has no start scopes; ask for one with --scope`);
    const t = this.now().toISOString(), id = "g_" + crypto.randomUUID().replace(/-/g, "").slice(0, 16);
    const e: GrantEvent = { type: "open", scopes, at: t, who: caller.name };
    const g: GrantRow = { id, caller: caller.name, project, key_scope: row.scope, key_rev: row.rev, name: row.name,
      ...transition(null, e)!, created_at: t, updated_at: t };
    scopes = g.requested!; // sorted, as decide() compares them
    // Why: the pending row claims the one live slot before anything is minted, so a concurrent
    // request finds it instead of minting a second child.
    if (!await this.insert(g, e)) {
      const other = await this.live(caller, project, row.name);
      if (other) return other;
      throw new Refused(409, `${row.name}: a grant changed meanwhile; run again`);
    }
    if (scopes.every(autoApproved) && !await this.blocked(caller, row)) {
      let minted;
      try { minted = await this.mint(row, g, scopes); } catch (err) {
        // A provider failure leaves no live grant behind. Only the untouched claim ends: a revoke
        // that landed meanwhile stays, so blocked() still sees it.
        await this.apply(g, { type: "abandon", who: "system" });
        throw err;
      }
      await this.store(g, row, minted, scopes, "policy");
      await this.catalog.audit(caller.name, "grant-mint", project, [`${row.name}:${scopes.join("+")}`]);
      return (await this.get(id))!;
    }
    await this.catalog.audit(caller.name, "grant-pending", project, [`${row.name}:${scopes.join("+")}`]);
    return g;
  }

  async mintFor(g: GrantRow, row: KeyRow, scopes: string[], who: string): Promise<GrantRow> {
    const minted = await this.mint(row, g, scopes), old = g.child_id;
    await this.store(g, row, minted, scopes, who);
    if (old) await this.revokeChild(row, old, g.expires_at);
    await this.catalog.audit(who, "grant-mint", g.project, [`${row.name}:${scopes.join("+")}`]);
    return (await this.get(g.id))!;
  }

  async mint(row: KeyRow, g: GrantRow, scopes: string[]) {
    const config = this.config(row), ttl = config.ttl_minutes ?? DEFAULT_TTL_MIN;
    const expires = new Date(this.now().getTime() + ttl * 60_000);
    const parent = await this.parent(row);
    const minted = await this.provider(row.kind).mint(parent, config, scopes, expires, `tumbler ${g.id} ${g.caller}`);
    return { ...minted, expires_at: expires.toISOString() };
  }

  // The new child lands only if the grant is still in the state `g` was read in: still live, holding
  // the child it held when minting began, with the request this mint answers still the one pending
  // (a deny or lapse clears it). Also the key is still at the revision that minted it, and the
  // caller's token is still unrevoked (a revoke can land between authenticating and storing).
  // Otherwise the new child is deleted at the provider and nothing is handed out.
  async store(g: GrantRow, row: KeyRow, m: Minted & { expires_at: string }, scopes: string[], who: string) {
    const { iv, ciphertext } = await seal(this.catalog.key, grantScope(g.id), row.name, m.value);
    const done = await this.apply(g, { type: "mint", scopes, child_id: m.id, expires_at: m.expires_at, who }, {
      guard: `key_rev = ? AND EXISTS (SELECT 1 FROM keys WHERE scope = ? AND name = ? AND rev = ?)
        AND EXISTS (SELECT 1 FROM tokens t WHERE t.name = grants.caller AND t.revoked_at IS NULL)`,
      binds: [row.rev, row.scope, row.name, row.rev], store: { iv, ciphertext },
    }).catch(async (e: Error) => { await this.revokeChild(row, m.id, m.expires_at); throw e; });
    if (!done) {
      await this.revokeChild(row, m.id, m.expires_at);
      throw new Refused(409, `grant ${g.id} changed while minting; run again`);
    }
  }

  async child(g: GrantRow): Promise<string> {
    const r = await this.db.prepare("SELECT iv, ciphertext FROM grants WHERE id = ?").bind(g.id).first<any>();
    if (!r?.iv) throw new Refused(409, `${g.name} has no live credential; run again`);
    return open(this.catalog.key, grantScope(g.id), g.name, bytes(r.iv), bytes(r.ciphertext));
  }

  // End a grant: forget its child here first, then delete it at the provider (best effort: it
  // expires there on its own if the provider can't be reached).
  // `row` is the key row that minted the child, when the caller has it.
  async close(g: GrantRow | null, state: "expired" | "revoked", who: string, row?: KeyRow | null) {
    // Why the loop: the compare-and-set fails when a child was minted (or a request changed) since
    // `g` was read; re-read and end what is there now, so a concurrent child is never left alive.
    let ended: GrantRow | null = null;
    for (let tries = 0; g && isLive(g.state) && !ended && tries < 5; tries++) {
      ended = await this.apply(g, { type: state === "expired" ? "expire" : "revoke", who }, { store: { iv: null, ciphertext: null } });
      if (!ended) g = await this.get(g.id);
    }
    if (!ended || !g) return; // already ended by someone else
    if (ended.child_id) {
      // Only the revision that minted the child can delete it; a newer one may hold another parent.
      const from = row?.rev === g.key_rev ? row : await this.catalog.revision(g.key_scope, g.name, g.key_rev);
      if (from) await this.revokeChild(from, ended.child_id, ended.expires_at);
      else console.error("tumbler: no revision left to revoke a child of", g.name, "; it expires on its own");
    }
    await this.catalog.audit(who, state === "expired" ? "grant-expire" : "grant-revoke", g.project, [g.name]);
  }

  // A failed delete is queued, never swallowed: sweep() retries it, and /admin shows the backlog.
  async revokeChild(row: KeyRow, childId: string, expiresAt: string | null = null) {
    try {
      await this.provider(row.kind).revoke(await this.parent(row), this.config(row), childId);
      await this.db.prepare("DELETE FROM pending_revokes WHERE child_id = ?").bind(childId).run();
      return true;
    } catch (e) {
      console.error("tumbler: revoke failed, queued for retry", row.name, (e as Error).message);
      await this.db.prepare(
        `INSERT INTO pending_revokes (child_id, key_scope, name, key_rev, expires_at, last_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (child_id) DO UPDATE SET attempts = attempts + 1, last_at = excluded.last_at`,
      ).bind(childId, row.scope, row.name, row.rev, expiresAt, this.now().toISOString()).run();
      return false;
    }
  }

  // Retry queued deletes. A child past its expiry is dead at the provider anyway, so it leaves the queue.
  async retryRevokes() {
    const t = this.now().toISOString();
    await this.db.prepare("DELETE FROM pending_revokes WHERE expires_at IS NOT NULL AND expires_at <= ?").bind(t).run();
    const { results } = await this.db.prepare("SELECT * FROM pending_revokes ORDER BY last_at LIMIT 50").all<any>();
    for (const p of results) {
      const row = await this.catalog.revision(p.key_scope, p.name, p.key_rev);
      if (row) await this.revokeChild(row, p.child_id, p.expires_at);
    }
  }

  async pendingRevokes(): Promise<number> {
    return (await this.db.prepare("SELECT COUNT(*) AS n FROM pending_revokes").first<{ n: number }>())?.n ?? 0;
  }

  parent(row: KeyRow) { return open(this.catalog.key, row.scope, row.name, bytes(row.iv), bytes(row.ciphertext)); }

  // A new grant and its `open` event. False when another live grant already holds the slot (the
  // unique index), and then neither is written.
  async insert(g: GrantRow, e: GrantEvent): Promise<boolean> {
    try {
      await this.db.batch([this.db.prepare(
        `INSERT INTO grants (id, caller, project, key_scope, key_rev, name, state, scopes, requested, requested_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(g.id, g.caller, g.project, g.key_scope, g.key_rev, g.name, g.state, JSON.stringify(g.scopes),
        asJson(g.requested), g.requested_at, g.created_at, g.updated_at), this.event(g.id, g.created_at, e, null, g.state)]);
      return true;
    } catch (err) {
      if (/UNIQUE/i.test((err as Error).message)) return false;
      throw err;
    }
  }

  // The only writer of a grant's state. transition() decides what `e` makes of `g` (or refuses it);
  // the update is a compare-and-set on the state `g` was read in, and the event is appended in the
  // same transaction only if the update landed. Null when refused or when the grant moved on.
  // `guard` adds conditions on the grants row; `store` sets columns that hold no state (the sealed child).
  async apply(g: GrantRow, e: GrantEvent, extra: { guard?: string; binds?: unknown[]; store?: Record<string, unknown> } = {}): Promise<GrantRow | null> {
    const next = transition(g, e);
    if (!next) return null;
    const t = this.now().toISOString();
    const set: Record<string, unknown> = { state: next.state, scopes: JSON.stringify(next.scopes), requested: asJson(next.requested),
      requested_at: next.requested_at, child_id: next.child_id, expires_at: next.expires_at, decided_by: next.decided_by, ...extra.store, updated_at: t };
    const cols = Object.keys(set);
    const [r] = await this.db.batch([
      this.db.prepare(`UPDATE grants SET ${cols.map((c) => `${c} = ?`).join(", ")}
        WHERE id = ? AND state = ? AND requested IS ? AND child_id IS ?${extra.guard ? ` AND ${extra.guard}` : ""}`)
        .bind(...cols.map((c) => set[c]), g.id, g.state, asJson(g.requested), g.child_id, ...(extra.binds ?? [])),
      this.event(g.id, t, e, g.state, next.state, true),
    ]);
    return r.meta.changes ? { ...g, ...next, updated_at: t } : null;
  }

  // Never the child or its provider id: the event's kind, who, the states and the scopes it carried.
  event(id: string, at: string, e: GrantEvent, from: string | null, to: string, ifChanged = false) {
    return this.db.prepare(`INSERT INTO grant_events (grant_id, at, type, actor, from_state, to_state, scopes)
      SELECT ?, ?, ?, ?, ?, ?, ?${ifChanged ? " WHERE changes() > 0" : ""}`)
      .bind(id, at, e.type, e.who, from, to, "scopes" in e ? JSON.stringify([...e.scopes].sort()) : null);
  }
}

const asJson = (v: string[] | null) => v ? JSON.stringify(v) : null;

// Never the sealed child: iv and ciphertext stay in D1.
function parse(r: any): GrantRow {
  return { id: r.id, caller: r.caller, project: r.project, key_scope: r.key_scope, key_rev: r.key_rev, name: r.name, state: r.state,
    scopes: JSON.parse(r.scopes || "[]"), requested: r.requested ? JSON.parse(r.requested) : null, requested_at: r.requested_at, child_id: r.child_id,
    expires_at: r.expires_at, decided_by: r.decided_by, created_at: r.created_at, updated_at: r.updated_at };
}

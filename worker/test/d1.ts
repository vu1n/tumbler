// A minimal D1 stand-in over node:sqlite, so the catalog's SQL runs in plain node tests.
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

class Stmt {
  db: DatabaseSync; sql: string; args: unknown[];
  constructor(db: DatabaseSync, sql: string, args: unknown[] = []) { this.db = db; this.sql = sql; this.args = args; }
  bind(...args: unknown[]) { return new Stmt(this.db, this.sql, args); }
  async all() { return { results: this.db.prepare(this.sql).all(...(this.args as any[])) as Record<string, unknown>[] }; }
  async first() { return (await this.all()).results[0] ?? null; }
  async run() { const r = this.db.prepare(this.sql).run(...(this.args as any[])); return { success: true, meta: { changes: Number(r.changes) } }; }
  // What a batch gets back: rows for a SELECT or a statement with RETURNING, as D1 gives them.
  async exec() {
    if (!/^\s*SELECT\b|\bRETURNING\b/i.test(this.sql)) return { ...(await this.run()), results: [] };
    const results = (await this.all()).results;
    return { success: true, results, meta: { changes: results.length } };
  }
}

export function memoryD1(): D1Database & { raw: DatabaseSync } {
  const db = new DatabaseSync(":memory:");
  for (const f of readdirSync(new URL("../migrations", import.meta.url)).sort()) {
    db.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), "utf8"));
  }
  // Like D1's batch: every statement in one transaction, all or none.
  const batch = async (stmts: Stmt[]) => {
    db.exec("BEGIN");
    try { const out = []; for (const s of stmts) out.push(await s.exec()); db.exec("COMMIT"); return out; }
    catch (e) { db.exec("ROLLBACK"); throw e; }
  };
  return { raw: db, prepare: (sql: string) => new Stmt(db, sql), batch } as unknown as D1Database & { raw: DatabaseSync };
}

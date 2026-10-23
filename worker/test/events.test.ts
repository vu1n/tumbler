// The grant state machine: transition() as a pure function, and the append-only event log that
// records every change grants.ts makes with it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { handle } from "../src/app.ts";
import { Catalog } from "../src/catalog.ts";
import { masterKey } from "../src/crypto.ts";
import { Grants, type Provider } from "../src/grants.ts";
import { type GrantState, transition } from "../src/machine.ts";
import { memoryD1 } from "./d1.ts";

const AT = "2026-10-20T12:00:00.000Z";
const pending = transition(null, { type: "open", scopes: ["w:write", "w:read"], at: AT, who: "dev" })!;
const active: GrantState = { ...transition(null, { type: "open", scopes: ["w:read"], at: AT, who: "dev" })!, state: "active", scopes: ["w:read"], requested: null, requested_at: null, child_id: "c1", expires_at: AT };

test("open makes a pending grant asking for the sorted scopes; nothing else starts from nothing", () => {
  assert.deepEqual(pending, { state: "pending", scopes: [], requested: ["w:read", "w:write"], requested_at: AT, child_id: null, expires_at: null, decided_by: null });
  assert.equal(transition(null, { type: "mint", scopes: ["w:read"], child_id: "c", expires_at: AT, who: "policy" }), null);
  assert.equal(transition(null, { type: "open", scopes: [], at: AT, who: "dev" }), null);
  assert.equal(transition(pending, { type: "open", scopes: ["w:read"], at: AT, who: "dev" }), null);
});

test("a mint answers exactly the opened request, and never carries a write the token didn't allow", () => {
  const mint = (scopes: string[], approved?: string[]) => ({ type: "mint" as const, scopes, child_id: "c2", expires_at: AT, who: "policy", approved });
  assert.equal(transition(pending, mint(["w:read", "w:write"])), null);              // a write the token didn't allow
  assert.equal(transition(pending, mint(["w:read"], ["w:write"])), null);            // not what was opened
  const ok = transition(pending, mint(["w:write", "w:read"], ["w:write"]))!;
  assert.deepEqual([ok.state, ok.scopes, ok.requested, ok.child_id, ok.decided_by], ["active", ["w:read", "w:write"], null, "c2", "policy"]);
  // An active grant widens by reads, and by a write only when the token allows it.
  assert.deepEqual(transition(active, mint(["w:read", "z:read"]))!.scopes, ["w:read", "z:read"]);
  assert.equal(transition(active, mint(["w:read", "w:write"])), null);
  assert.equal(transition(active, mint(["w:read", "w:write"], ["d:edit"])), null);
  assert.deepEqual(transition(active, mint(["w:read", "w:write"], ["w:write"]))!.scopes, ["w:read", "w:write"]);
  // A write it already holds counts for nothing: a narrowed token re-mints without it.
  const wrote = { ...active, scopes: ["w:read", "w:write"] };
  assert.equal(transition(wrote, mint(["w:read", "w:write"])), null);
});

test("step-up keeps the first request time; deny and lapse keep an active grant's child", () => {
  const up = transition(active, { type: "step_up", scopes: ["w:write"], at: AT, who: "dev" })!;
  assert.deepEqual([up.state, up.requested, up.requested_at, up.child_id], ["active", ["w:read", "w:write"], AT, "c1"]);
  const again = transition(up, { type: "step_up", scopes: ["d:edit"], at: "2026-10-21T00:00:00.000Z", who: "dev" })!;
  assert.equal(again.requested_at, AT);
  assert.equal(transition(active, { type: "step_up", scopes: ["w:read"], at: AT, who: "dev" }), null); // nothing new
  const denied = transition(up, { type: "deny", who: "vu@example.com" })!;
  assert.deepEqual([denied.state, denied.requested, denied.child_id], ["active", null, "c1"]);
  assert.equal(transition(active, { type: "deny", who: "vu@example.com" }), null); // nothing to deny
  assert.deepEqual(transition(pending, { type: "lapse", who: "timeout" })!.state, "denied");
});

test("ended grants are final, and abandon only drops an unminted claim", () => {
  for (const type of ["expire", "revoke"] as const) {
    const g = transition(active, { type, who: "system" })!;
    assert.equal(g.state, type === "expire" ? "expired" : "revoked");
    for (const e of [{ type: "revoke", who: "x" }, { type: "step_up", scopes: ["w:write"], at: AT, who: "x" },
      { type: "mint", scopes: ["w:read"], child_id: "c", expires_at: AT, who: "x" }] as const) assert.equal(transition(g, e as any), null);
  }
  assert.equal(transition(pending, { type: "abandon", who: "system" })!.state, "expired");
  assert.equal(transition(active, { type: "abandon", who: "system" }), null);
});

test("every grant change is logged in the same write, never with a credential, and the log is append-only", async () => {
  const db = memoryD1(), catalog = new Catalog(db, await masterKey(Buffer.alloc(32, 7).toString("base64")));
  let n = 0;
  const provider: Provider = { validate() {}, async mint() { n++; return { id: `prov-id-${n}`, value: `child-secret-${n}` }; }, async revoke() {} };
  const grants = new Grants(catalog, { cloudflare: provider });
  const config = { account_id: "a".repeat(32), start: ["w:read"], scopes: { "w:read": ["1".repeat(32)], "w:write": ["2".repeat(32)] } };
  await catalog.put("dev", "CF", "parent-secret", { kind: "mint:cloudflare", config });
  const dev = await catalog.createToken("dev", ["dev"], null, ["w:write"]);
  const deps = { catalog, grants, admin: async () => "vu@example.com" };
  const call = (method: string, path: string, token?: string, body?: unknown) => handle(new Request(`https://t.example${path}`, {
    method, body: body === undefined ? undefined : JSON.stringify(body),
    headers: { ...(token ? { authorization: `Bearer ${token}` } : { "x-tumbler-admin": "1" }) } }), deps);

  await call("GET", "/v1/env?keys=CF", dev);
  const up = (await (await call("POST", "/v1/step-up", dev, { keys: ["CF"], scopes: ["w:write"] })).json()).grants[0];
  await call("DELETE", `/admin/api/grants/${up.id}`);

  const events = (await (await call("GET", `/admin/api/grants/${up.id}/events`)).json()).events;
  assert.deepEqual(events.map((e: any) => [e.type, e.actor, e.from_state, e.to_state]), [
    ["open", "dev", null, "pending"], ["mint", "policy", "pending", "active"],
    ["mint", "policy", "active", "active"], ["revoke", "vu@example.com", "active", "revoked"],
  ]);
  assert.deepEqual(events[2].scopes, ["w:read", "w:write"]);
  const log = JSON.stringify(db.raw.prepare("SELECT * FROM grant_events").all());
  assert.ok(!/secret|prov-id/.test(log), log);
  // The table and the log agree: each grant's state is its last event's.
  for (const g of db.raw.prepare("SELECT id, state FROM grants").all() as any[]) {
    const last = db.raw.prepare("SELECT to_state FROM grant_events WHERE grant_id = ? ORDER BY id DESC LIMIT 1").get(g.id) as any;
    assert.equal(last.to_state, g.state);
  }
  assert.throws(() => db.raw.prepare("UPDATE grant_events SET actor = 'x'").run(), /append-only/);
  assert.throws(() => db.raw.prepare("DELETE FROM grant_events").run(), /append-only/);
  // A refused or lost compare-and-set writes no event.
  const before = events.length;
  assert.equal((await call("DELETE", `/admin/api/grants/${up.id}`)).status, 404);
  assert.equal((await (await call("GET", `/admin/api/grants/${up.id}/events`)).json()).events.length, before);
});

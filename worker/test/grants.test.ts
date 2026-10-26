// Minted keys: the grant state machine, the Cloudflare provider, and `tumbler run --scope` end to end.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { promisify } from "node:util";
import { handle } from "../src/app.ts";
import { Catalog, Refused } from "../src/catalog.ts";
import { cloudflare } from "../src/cloudflare.ts";
import { masterKey } from "../src/crypto.ts";
import { Grants, type Provider } from "../src/grants.ts";
import { memoryD1 } from "./d1.ts";

const PARENT = "parent-token-never-leaves";
const ACCT = "a".repeat(32), READ = "1".repeat(32), WRITE = "2".repeat(32);
const CONFIG = { account_id: ACCT, ttl_minutes: 30, start: ["workers:read"], scopes: { "workers:read": [READ], "workers:write": [READ, WRITE] } };

// A provider that mints "child-N" and remembers what it was asked; `fail` makes the next mint throw.
function fakeProvider() {
  const p = { minted: [] as { scopes: string[]; parent: string }[], configs: [] as any[], revoked: [] as string[], fail: false, n: 0 } as any;
  const provider: Provider = {
    validate() {},
    async mint(parent, c, scopes) {
      if (p.fail) throw new Error("provider down");
      p.minted.push({ parent, scopes }); p.configs.push(c); p.n++;
      return { id: `id-${p.n}`, value: `child-${p.n}` };
    },
    async revoke(_parent, _c, id) { p.revoked.push(id); },
    async groups(parent, _c, names) {
      if (parent !== PARENT) throw new Error("groups got the wrong parent");
      const known: Record<string, string> = { "containers write": "Containers Write", "pages write": "Pages Write" };
      return names.map((n) => known[n.toLowerCase()] ?? (() => { throw new Refused(400, `no group ${n}`); })());
    },
    async listGroups(parent) {
      if (parent !== PARENT) throw new Error("listGroups got the wrong parent");
      return [{ name: "Containers Write", scopes: ["com.cloudflare.api.account"], delegable: true },
        { name: "Workers Containers Write", scopes: ["com.cloudflare.api.account"], delegable: true },
        { name: "Account API Tokens Write", scopes: ["com.cloudflare.api.account"], delegable: false }];
    },
  };
  return Object.assign(p, { provider });
}

async function setup() {
  const db = memoryD1(), catalog = new Catalog(db, await masterKey(Buffer.alloc(32, 3).toString("base64")));
  const fake = fakeProvider();
  let clock = Date.parse("2026-10-20T12:00:00Z");
  const grants = new Grants(catalog, { cloudflare: fake.provider }, () => new Date(clock));
  catalog.clock = () => new Date(clock);
  await catalog.put("global", "AWS_REGION", "us-east-1");
  await catalog.put("dev", "CLOUDFLARE_API_TOKEN", PARENT, { kind: "mint:cloudflare", config: CONFIG });
  // dev may hold workers:write (its ceiling); other reads only.
  const dev = await catalog.createToken("dev", ["dev"], null, ["workers:write"]), other = await catalog.createToken("other", ["dev"]);
  const deps = { catalog, grants, admin: async (r: Request) => r.headers.get("x-test-admin") };
  const call = (method: string, path: string, token?: string, body?: unknown, admin?: string) => handle(new Request(`https://t.example${path}`, {
    method, body: body === undefined ? undefined : JSON.stringify(body),
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(admin ? { "x-test-admin": admin, "x-tumbler-admin": "1" } : {}) },
  }), deps);
  const env = (token = dev, keys = "CLOUDFLARE_API_TOKEN") => call("GET", `/v1/env?keys=${keys}`, token);
  const tick = (min: number) => { clock += min * 60_000; };
  return { db, catalog, grants, fake, dev, other, call, env, tick };
}

const adminGrants = async (s: Awaited<ReturnType<typeof setup>>) => (await (await s.call("GET", "/admin/api/grants", undefined, undefined, "vu@example.com")).json()).grants;

test("a read-scoped mint key goes active at once and hands out a child, never the parent", async () => {
  const s = await setup();
  const r = await s.env();
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.deepEqual(body.env, { CLOUDFLARE_API_TOKEN: "child-1" });
  assert.deepEqual(s.fake.minted, [{ parent: PARENT, scopes: ["workers:read"] }]);
  const [g] = await adminGrants(s);
  assert.equal(g.state, "active");
  assert.deepEqual(g.scopes, ["workers:read"]);
  // The same child comes back while it has time left; nothing new is minted.
  assert.equal((await (await s.env()).json()).env.CLOUDFLARE_API_TOKEN, "child-1");
  assert.equal(s.fake.minted.length, 1);
});

test("the parent never appears in a response, listing or audit row", async () => {
  const s = await setup();
  await s.env();
  await s.call("POST", "/v1/step-up", s.dev, { keys: ["CLOUDFLARE_API_TOKEN"], scopes: ["workers:write"] });
  const texts = await Promise.all([
    s.call("GET", "/admin/api/keys", undefined, undefined, "vu@example.com"), s.call("GET", "/admin/api/grants", undefined, undefined, "vu@example.com"),
    s.call("GET", "/admin/api/audit", undefined, undefined, "vu@example.com"), s.call("GET", "/v1/keys", s.dev),
  ].map(async (p) => (await p).text()));
  for (const t of texts) { assert.ok(!t.includes(PARENT)); assert.ok(!t.includes("child-")); }
  const audit = JSON.stringify(s.db.raw.prepare("SELECT * FROM audit").all());
  assert.ok(!audit.includes(PARENT) && !audit.includes("child-"));
});

test("a token's scopes are its approval: a write inside them mints at once, outside them is refused", async () => {
  const s = await setup();
  await s.catalog.put("dev", "CLOUDFLARE_API_TOKEN", PARENT, { kind: "mint:cloudflare", config: { ...CONFIG, start: ["workers:write"] } });
  assert.equal((await (await s.env()).json()).env.CLOUDFLARE_API_TOKEN, "child-1");
  assert.deepEqual(s.fake.minted[0].scopes, ["workers:write"]);
  // other reads only: a write start scope leaves it nothing to start with, and nothing is minted.
  const r = await s.env(s.other);
  assert.equal(r.status, 403);
  assert.match((await r.json()).error, /may hold none of its start scopes\. Refused; retrying won't help: ask a human to add one to this token's scopes in \/admin/);
  assert.equal(s.fake.minted.length, 1);
  assert.equal((await adminGrants(s)).length, 1); // and no grant waits anywhere
});

test("step-up inside the token's scopes mints a wider child at once and deletes the narrow one", async () => {
  const s = await setup();
  await s.env();
  const up = await (await s.call("POST", "/v1/step-up", s.dev, { keys: ["CLOUDFLARE_API_TOKEN", "AWS_REGION"], scopes: ["workers:write"] })).json();
  assert.equal(up.grants.length, 1);
  assert.deepEqual([up.grants[0].state, up.grants[0].scopes, up.grants[0].requested], ["active", ["workers:read", "workers:write"], null]);
  assert.equal((await (await s.env()).json()).env.CLOUDFLARE_API_TOKEN, "child-2");
  assert.deepEqual(s.fake.revoked, ["id-1"]);
  // Again: nothing new to mint.
  await s.call("POST", "/v1/step-up", s.dev, { keys: ["CLOUDFLARE_API_TOKEN"], scopes: ["workers:write"] });
  assert.equal(s.fake.minted.length, 2);
});

test("step-up outside the token's scopes is refused and keeps the narrow child; unknown scopes are a 400", async () => {
  const s = await setup();
  await s.env(s.other);
  const r = await s.call("POST", "/v1/step-up", s.other, { keys: ["CLOUDFLARE_API_TOKEN"], scopes: ["workers:write"] });
  assert.equal(r.status, 403);
  assert.match((await r.json()).error, /token other may not hold workers:write/);
  assert.equal((await (await s.env(s.other)).json()).env.CLOUDFLARE_API_TOKEN, "child-1");
  assert.deepEqual(s.fake.revoked, []);
  assert.equal((await s.call("POST", "/v1/step-up", s.dev, { keys: ["CLOUDFLARE_API_TOKEN"], scopes: ["zones:write"] })).status, 400);
  // `*` allows any scope the key has.
  const any = await s.catalog.createToken("any", ["dev"], null, ["*"]);
  assert.equal((await s.call("POST", "/v1/step-up", any, { keys: ["CLOUDFLARE_API_TOKEN"], scopes: ["workers:write"] })).status, 200);
});

test("a write grant that expires comes back with the start scopes; asking for the write again mints it", async () => {
  const s = await setup();
  await s.env();
  await s.call("POST", "/v1/step-up", s.dev, { keys: ["CLOUDFLARE_API_TOKEN"], scopes: ["workers:write"] });
  s.tick(40);
  await s.grants.sweep();
  assert.equal((await (await s.env()).json()).env.CLOUDFLARE_API_TOKEN, "child-3");
  assert.deepEqual(s.fake.minted.at(-1)!.scopes, ["workers:read"]);
  await s.call("POST", "/v1/step-up", s.dev, { keys: ["CLOUDFLARE_API_TOKEN"], scopes: ["workers:write"] });
  assert.deepEqual(s.fake.minted.at(-1)!.scopes, ["workers:read", "workers:write"]);
});

test("revoking a grant deletes its child now; the caller's next request mints a fresh one", async () => {
  const s = await setup();
  await s.env();
  const [g] = await adminGrants(s);
  assert.equal((await s.call("DELETE", `/admin/api/grants/${g.id}`, undefined, undefined, "vu@example.com")).status, 200);
  assert.deepEqual(s.fake.revoked, ["id-1"]);
  assert.equal((await (await s.env()).json()).env.CLOUDFLARE_API_TOKEN, "child-2");
});

test("narrowing a token's scopes ends the children holding what it no longer allows", async () => {
  const s = await setup();
  await s.env(s.other);                                   // a read child: kept
  await s.call("POST", "/v1/step-up", s.dev, { keys: ["CLOUDFLARE_API_TOKEN"], scopes: ["workers:write"] });
  // The same ceiling, spelled loosely, keeps the write child.
  assert.equal((await s.call("PATCH", "/admin/api/tokens/dev", undefined, { scopes: [" workers:write "] }, "vu@example.com")).status, 200);
  assert.deepEqual(s.fake.revoked, []);
  const r = await s.call("PATCH", "/admin/api/tokens/dev", undefined, { scopes: [] }, "vu@example.com");
  assert.equal(r.status, 200);
  assert.deepEqual(s.fake.revoked, ["id-2"]); // dev's write child; other's read child stays
  assert.equal((await s.call("POST", "/v1/step-up", s.dev, { keys: ["CLOUDFLARE_API_TOKEN"], scopes: ["workers:write"] })).status, 403);
  assert.equal((await (await s.env()).json()).env.CLOUDFLARE_API_TOKEN, "child-3");
  assert.deepEqual(s.fake.minted.at(-1)!.scopes, ["workers:read"]);
  const tokens = (await (await s.call("GET", "/admin/api/tokens", undefined, undefined, "vu@example.com")).json()).tokens;
  assert.deepEqual(tokens.map((t: any) => [t.name, t.scopes]), [["dev", null], ["other", null]]);
  assert.equal((await s.call("PATCH", "/admin/api/tokens/dev", undefined, { scopes: ["not a scope"] }, "vu@example.com")).status, 400);
  // A key's scope names follow the same rule, so every scope a key has can be given exactly.
  for (const bad of ["has space", "", "*", "x".repeat(129)])
    assert.throws(() => s.grants.validate("mint:cloudflare", { ...CONFIG, scopes: { ...CONFIG.scopes, [bad]: [WRITE] } }), /invalid scope name/);
  // A key may name a scope without a namespace; the token can still be given exactly that one.
  assert.equal((await s.call("PATCH", "/admin/api/tokens/other", undefined, { scopes: ["deploy", "release/candidate"] }, "vu@example.com")).status, 200);
});

test("a live child wider than the token's scopes ends on the next request, even when the narrowing's cleanup never ran", async () => {
  const s = await setup();
  await s.call("POST", "/v1/step-up", s.dev, { keys: ["CLOUDFLARE_API_TOKEN"], scopes: ["workers:write"] });
  await s.catalog.setScopes("dev", null); // as after migration 0007, or a PATCH cut short before closeOutsideCeiling
  assert.equal((await (await s.env()).json()).env.CLOUDFLARE_API_TOKEN, "child-2");
  assert.deepEqual(s.fake.revoked, ["id-1"]); // the write child
  assert.deepEqual(s.fake.minted.at(-1)!.scopes, ["workers:read"]);
});

test("a narrowing whose cleanup was cut short is finished by the sweep, for children nobody asks for again", async () => {
  const s = await setup();
  await s.call("POST", "/v1/step-up", s.dev, { keys: ["CLOUDFLARE_API_TOKEN"], scopes: ["workers:write"] });
  await s.env(s.other);
  await s.catalog.setScopes("dev", null); // closeOutsideCeiling never ran
  await s.grants.sweep();
  assert.deepEqual(s.fake.revoked, ["id-1"]); // dev's write child; other's read child stays
});

test("a PATCH of scopes and pin together is one write: a bad pin lands neither", async () => {
  const s = await setup();
  const r = await s.call("PATCH", "/admin/api/tokens/other", undefined, { scopes: ["workers:write"], projects: ["global"] }, "vu@example.com");
  assert.equal(r.status, 400);
  const tokens = (await (await s.call("GET", "/admin/api/tokens", undefined, undefined, "vu@example.com")).json()).tokens;
  assert.deepEqual(tokens.find((t: any) => t.name === "other").scopes, null);
  assert.equal((await s.call("PATCH", "/admin/api/tokens/other", undefined, { scopes: ["workers:write"], projects: ["dev"] }, "vu@example.com")).status, 200);
  assert.equal((await s.call("POST", "/v1/step-up", s.other, { keys: ["CLOUDFLARE_API_TOKEN"], scopes: ["workers:write"] })).status, 200);
});

test("scopes narrowed while a write mints: the child is deleted, never handed out", async () => {
  const s = await setup();
  await s.env();
  const mint = s.fake.provider.mint;
  s.fake.provider.mint = async (...a: Parameters<typeof mint>) => {
    // Straight to the catalog, so only store()'s own check stands between the request and the child.
    await s.catalog.setScopes("dev", null);
    return mint(...a);
  };
  const r = await s.call("POST", "/v1/step-up", s.dev, { keys: ["CLOUDFLARE_API_TOKEN"], scopes: ["workers:write"] });
  s.fake.provider.mint = mint;
  assert.equal(r.status, 409);
  assert.deepEqual(s.fake.revoked, ["id-2"]);
  assert.equal((await (await s.env()).json()).env.CLOUDFLARE_API_TOKEN, "child-1");
});

test("a step-up over several keys is checked whole: one key outside the token's scopes widens none", async () => {
  const s = await setup();
  await s.catalog.put("dev", "D1_TOKEN", PARENT, { kind: "mint:cloudflare", config: { ...CONFIG, scopes: { ...CONFIG.scopes, "d1:write": [WRITE] } } });
  await s.env(s.dev, "CLOUDFLARE_API_TOKEN,D1_TOKEN");
  const minted = s.fake.minted.length;
  const r = await s.call("POST", "/v1/step-up", s.dev, { keys: ["CLOUDFLARE_API_TOKEN", "D1_TOKEN"], scopes: ["workers:write", "d1:write"] });
  assert.equal(r.status, 403);
  assert.match((await r.json()).error, /D1_TOKEN: token dev may not hold d1:write/);
  assert.equal(s.fake.minted.length, minted);
  assert.deepEqual(s.fake.revoked, []);
});

test("a step-up that loses the first-grant race to a narrower request still widens it", async () => {
  const s = await setup();
  await s.env(); // the other request's read grant, already active
  const current = s.grants.current.bind(s.grants);
  let once = true;
  s.grants.current = async (...a: Parameters<typeof current>) => once ? (once = false, null) : current(...a); // read before it landed
  const r = await s.call("POST", "/v1/step-up", s.dev, { keys: ["CLOUDFLARE_API_TOKEN"], scopes: ["workers:write"] });
  assert.equal(r.status, 200);
  assert.deepEqual((await r.json()).grants[0].scopes, ["workers:read", "workers:write"]);
});

test("a request left waiting from before ceilings lapses in the sweep, or is dropped by the next step-up", async () => {
  const s = await setup();
  await s.env(); await s.env(s.other);
  for (const { id } of await adminGrants(s)) await s.grants.apply((await s.grants.get(id))!, { type: "step_up", scopes: ["workers:write"], at: "2026-10-20T12:00:00.000Z", who: "legacy" });
  // dev may hold the write: its next step-up drops the old request and mints what it asks now.
  const up = await (await s.call("POST", "/v1/step-up", s.dev, { keys: ["CLOUDFLARE_API_TOKEN"], scopes: ["workers:write"] })).json();
  assert.deepEqual([up.grants[0].scopes, up.grants[0].requested], [["workers:read", "workers:write"], null]);
  s.tick(25 * 60);
  await s.grants.sweep();
  const other = (await adminGrants(s)).find((g: any) => g.caller === "other");
  assert.equal(other.requested, null);
});

test("a provider failure yields no token and leaves no live grant", async () => {
  const s = await setup();
  s.fake.fail = true;
  const r = await s.env();
  assert.equal(r.status, 500);
  assert.equal((await s.env("x")).status, 401);
  assert.deepEqual((await adminGrants(s)).map((g: any) => [g.state, g.decided_by]), [["expired", "system"]]); // the claim was abandoned
  // A static key requested with it does not come back alone either: the whole response fails.
  assert.equal((await s.env(s.dev, "AWS_REGION,CLOUDFLARE_API_TOKEN")).status, 500);
});

test("expired grants are swept and deleted at the provider; the next request mints fresh", async () => {
  const s = await setup();
  await s.env();
  s.tick(25); // under 10 minutes left: not handed out again
  assert.equal((await (await s.env()).json()).env.CLOUDFLARE_API_TOKEN, "child-2");
  assert.ok(s.fake.revoked.includes("id-1"));
  s.tick(31);
  assert.equal(await s.grants.sweep(), 1);
  const states = (await adminGrants(s)).map((g: any) => g.state).sort();
  assert.deepEqual(states, ["expired", "expired"]);
  assert.ok(s.fake.revoked.includes("id-2"));
});

test("concurrent first requests share one grant and one child", async () => {
  const s = await setup();
  const rs = await Promise.all([s.env(), s.env(), s.env()]);
  const vals = await Promise.all(rs.map(async (r) => r.status === 200 ? (await r.json()).env.CLOUDFLARE_API_TOKEN : r.status));
  assert.equal((await adminGrants(s)).filter((g: any) => g.state === "active").length, 1);
  assert.ok(vals.every((v) => v === "child-1" || v === 409), String(vals));
  assert.equal(s.fake.minted.length, 1);
});

test("revoking a caller token, deleting a key or rotating its parent ends live grants with the old parent", async () => {
  const s = await setup();
  await s.env(); await s.env(s.other);
  await s.call("DELETE", "/admin/api/tokens/dev", undefined, undefined, "vu@example.com");
  assert.deepEqual(s.fake.revoked, ["id-1"]);
  await s.call("PUT", "/admin/api/keys/dev/CLOUDFLARE_API_TOKEN", undefined, { value: "parent-2" }, "vu@example.com");
  assert.deepEqual(s.fake.revoked, ["id-1", "id-2"]);
  assert.equal((await (await s.env(s.other)).json()).env.CLOUDFLARE_API_TOKEN, "child-3");
  assert.equal(s.fake.minted.at(-1)!.parent, "parent-2");
  await s.call("DELETE", "/admin/api/keys/dev/CLOUDFLARE_API_TOKEN", undefined, undefined, "vu@example.com");
  assert.deepEqual(s.fake.revoked, ["id-1", "id-2", "id-3"]);
});

test("narrowing a token's pin ends the children it holds for projects it no longer reaches", async () => {
  const s = await setup();
  await s.env();
  await s.call("PATCH", "/admin/api/tokens/dev", undefined, { projects: ["dev", "kypp"] }, "vu@example.com");
  assert.deepEqual(s.fake.revoked, []); // still reaches dev: its child keeps working
  await s.call("PATCH", "/admin/api/tokens/dev", undefined, { projects: ["kypp"] }, "vu@example.com");
  assert.deepEqual(s.fake.revoked, ["id-1"]);
  assert.equal((await s.call("GET", "/v1/env?project=dev&keys=CLOUDFLARE_API_TOKEN", s.dev)).status, 403);
});

test("a repin whose cleanup was cut short is finished by the sweep", async () => {
  const s = await setup();
  await s.env();
  await s.catalog.setPin("dev", ["kypp"]); // closeOutsidePin never ran
  await s.grants.sweep();
  assert.deepEqual(s.fake.revoked, ["id-1"]);
});

test("a pin narrowed while a first mint runs: the child is deleted, never handed out", async () => {
  const s = await setup();
  const mint = s.fake.provider.mint;
  s.fake.provider.mint = async (...a: Parameters<typeof mint>) => {
    // The pin changes after this request's grant was opened but where the cleanup's scan missed it:
    // only store()'s own check stands between it and the child.
    await s.catalog.setPin("dev", ["kypp"]);
    return mint(...a);
  };
  const r = await s.env();
  s.fake.provider.mint = mint;
  assert.equal(r.status, 409);
  assert.doesNotMatch(await r.text(), /child-/);
  assert.deepEqual(s.fake.revoked, ["id-1"]);
});

test("a rotation during a mint wins: the old row's child is deleted, never stored or reused", async () => {
  const s = await setup();
  const mint = s.fake.provider.mint;
  s.fake.provider.mint = async (...a: Parameters<typeof mint>) => {
    s.tick(0.001); // a later rotated_at
    await s.call("PUT", "/admin/api/keys/dev/CLOUDFLARE_API_TOKEN", undefined,
      { value: "parent-2", kind: "mint:cloudflare", config: { ...CONFIG, scopes: { "workers:read": [READ] } } }, "vu@example.com");
    return mint(...a);
  };
  assert.equal((await s.env()).status, 409);
  s.fake.provider.mint = mint;
  assert.deepEqual(s.fake.revoked, ["id-1"]);
  assert.equal((await (await s.env()).json()).env.CLOUDFLARE_API_TOKEN, "child-2");
  assert.equal(s.fake.minted.at(-1)!.parent, "parent-2");
});

test("a same-millisecond rotation during a mint still wins: revisions are random, not timestamps", async () => {
  const s = await setup();
  const mint = s.fake.provider.mint;
  s.fake.provider.mint = async (...a: Parameters<typeof mint>) => {
    await s.catalog.put("dev", "CLOUDFLARE_API_TOKEN", "parent-2", { kind: "mint:cloudflare", config: { ...CONFIG, scopes: { "workers:read": [READ] } } });
    return mint(...a);
  };
  assert.equal((await s.env()).status, 409);
  s.fake.provider.mint = mint;
  assert.deepEqual(s.fake.revoked, ["id-1"]);
});

test("a rotation whose cleanup never ran: the next request ends the old grant with the retired parent", async () => {
  const s = await setup();
  const revokedWith: string[] = [];
  const revoke = s.fake.provider.revoke;
  s.fake.provider.revoke = async (parent: string, c: any, id: string) => { revokedWith.push(parent); return revoke(parent, c, id); };
  await s.env();
  await s.catalog.put("dev", "CLOUDFLARE_API_TOKEN", "parent-2"); // straight to the catalog: no closeKey
  assert.equal((await (await s.env()).json()).env.CLOUDFLARE_API_TOKEN, "child-2");
  assert.deepEqual(revokedWith, [PARENT]);
  assert.equal(s.fake.minted.at(-1)!.parent, "parent-2");
  await s.catalog.remove("dev", "CLOUDFLARE_API_TOKEN");
  const [g] = (await adminGrants(s)).filter((x: any) => x.state === "active");
  await s.call("DELETE", `/admin/api/grants/${g.id}`, undefined, undefined, "vu@example.com");
  assert.deepEqual(revokedWith, [PARENT, "parent-2"]); // still revocable after the key is gone
});

test("a revoke lands even when the grant changes between reading it and ending it", async () => {
  const s = await setup();
  await s.env();
  const [g] = await adminGrants(s);
  const get = s.grants.get.bind(s.grants);
  s.grants.get = async (id: string) => { s.grants.get = get; const r = await get(id);
    await s.call("POST", "/v1/step-up", s.dev, { keys: ["CLOUDFLARE_API_TOKEN"], scopes: ["workers:write"] }); return r; };
  assert.equal((await s.call("DELETE", `/admin/api/grants/${g.id}`, undefined, undefined, "vu@example.com")).status, 200);
  const [after] = await adminGrants(s);
  assert.deepEqual([after.state, after.requested], ["revoked", null]);
  assert.deepEqual(s.fake.revoked, ["id-1", "id-2"]); // the step-up's wider child goes with the revoke
  const events = await s.grants.events(g.id);
  assert.deepEqual(events.at(-1), { ...events.at(-1), type: "revoke", from_state: "active", to_state: "revoked" });
});

test("after a rotation every older revision's grant is ended, not just the one the save replaced", async () => {
  const s = await setup();
  await s.env();                                                  // dev: a grant on revision 1
  await s.catalog.put("dev", "CLOUDFLARE_API_TOKEN", "parent-2"); // a save whose cleanup never ran
  await s.env(s.other);                                           // other: a grant on revision 2
  await s.call("PUT", "/admin/api/keys/dev/CLOUDFLARE_API_TOKEN", undefined, { value: "parent-3" }, "vu@example.com");
  assert.equal((await adminGrants(s)).filter((g: any) => g.state === "active").length, 0);
  assert.deepEqual(s.fake.revoked.sort(), ["id-1", "id-2"]);
});

test("a read claim left by a dead request is dropped after a minute instead of blocking for a day", async () => {
  const s = await setup();
  const t = new Date(Date.parse("2026-10-20T12:00:00Z")).toISOString();
  s.db.raw.prepare(`INSERT INTO grants (id, caller, project, key_scope, key_rev, name, state, scopes, requested, requested_at, created_at, updated_at)
    VALUES ('g_dead', 'dev', 'dev', 'dev', ?, 'CLOUDFLARE_API_TOKEN', 'pending', '[]', '["workers:read"]', ?, ?, ?)`)
    .run((await s.catalog.keyRow("dev", "CLOUDFLARE_API_TOKEN"))!.rev, t, t, t);
  assert.match((await (await s.env()).json()).error, /being minted by another request/);
  s.tick(2);
  assert.equal((await (await s.env()).json()).env.CLOUDFLARE_API_TOKEN, "child-1");
});

test("a parent that can't be a header value is refused; fetch errors never quote it", async () => {
  const s = await setup();
  await assert.rejects(s.catalog.put("dev", "CF_BAD", "sec\nret", { kind: "mint:cloudflare", config: CONFIG }), /printable ASCII/);
  const cf = cloudflare((async () => { throw new TypeError(`invalid header value Bearer ${PARENT}`); }) as any);
  await assert.rejects(cf.mint(PARENT, CONFIG, ["workers:read"], new Date(), "x"), (e: any) => e.status === 502 && !e.message.includes(PARENT));
});

test("an ended token's name is reused: the new token starts clean and the old one stays dead", async () => {
  const s = await setup();
  await s.env();
  // Revoked in the token row only, as an interrupted revoke leaves it: its child is still live.
  await s.catalog.revokeToken("dev");
  const live = await s.call("POST", "/admin/api/tokens", undefined, { name: "other", projects: ["dev"] }, "vu@example.com");
  assert.equal(live.status, 409);
  assert.match((await live.json()).error, /token other is live; revoke it first/);
  const r = await s.call("POST", "/admin/api/tokens", undefined, { name: "dev", projects: ["dev"] }, "vu@example.com");
  assert.equal(r.status, 200);
  const { token } = await r.json();
  // The old child ended before the name was handed over; the new token mints its own.
  assert.deepEqual(s.fake.revoked, ["id-1"]);
  assert.equal((await s.env(s.dev)).status, 401);
  assert.equal((await (await s.env(token)).json()).env.CLOUDFLARE_API_TOKEN, "child-2");
  // Nothing of the old token carries over: it held workers:write, the new one reads only.
  assert.equal((await s.call("POST", "/v1/step-up", token, { keys: ["CLOUDFLARE_API_TOKEN"], scopes: ["workers:write"] })).status, 403);
  // An expired token's name is free too.
  await s.catalog.createToken("brief", ["dev"], new Date(Date.parse("2026-10-20T12:30:00Z")).toISOString());
  s.tick(60);
  assert.equal((await s.call("POST", "/admin/api/tokens", undefined, { name: "brief" }, "vu@example.com")).status, 200);
  // And a reused name can go straight into a key.
  await s.call("DELETE", "/admin/api/tokens/brief", undefined, undefined, "vu@example.com");
  assert.equal((await s.call("POST", "/admin/api/tokens", undefined, { name: "brief", store: { scope: "global", name: "BRIEF_TOKEN" } }, "vu@example.com")).status, 200);
  assert.equal((await s.call("GET", "/v1/whoami", await s.catalog.value((await s.catalog.keyRow("global", "BRIEF_TOKEN"))!))).status, 200);
});

test("a request by a token whose name is reused mid-mint gets nothing, and a token that ends after the check isn't replaced", async () => {
  const s = await setup();
  // The old token authenticated, then pauses before its grant exists, so the revoke has nothing to close.
  const open = s.grants.open.bind(s.grants);
  let fresh = "";
  s.grants.open = async (...a: Parameters<typeof open>) => {
    s.grants.open = open;
    await s.call("DELETE", "/admin/api/tokens/dev", undefined, undefined, "vu@example.com");
    fresh = (await (await s.call("POST", "/admin/api/tokens", undefined, { name: "dev", projects: ["dev"], scopes: ["workers:write"] }, "vu@example.com")).json()).token;
    return open(...a);
  };
  // It can't even open a grant under the name now: nothing is minted for it.
  assert.equal((await s.env()).status, 401);
  assert.deepEqual([s.fake.minted.length, s.fake.revoked], [0, []]);
  assert.equal((await (await s.env(fresh)).json()).env.CLOUDFLARE_API_TOKEN, "child-1");
  // Two creates of one ended name: the second finds the name taken by the first's new token, and
  // that token's grants stay its own.
  await s.call("DELETE", "/admin/api/tokens/dev", undefined, undefined, "vu@example.com");
  const batch = s.db.batch.bind(s.db);
  let second: Response | null = null;
  (s.db as any).batch = async (stmts: any) => {
    (s.db as any).batch = batch;
    second = await s.call("POST", "/admin/api/tokens", undefined, { name: "dev", projects: ["dev"] }, "vu@example.com");
    return batch(stmts);
  };
  const first = await s.call("POST", "/admin/api/tokens", undefined, { name: "dev", projects: ["dev"] }, "vu@example.com");
  assert.deepEqual([second!.status, first.status], [200, 409]);
  const winner = (await second!.json()).token;
  assert.equal((await (await s.env(winner)).json()).env.CLOUDFLARE_API_TOKEN, "child-2");
  assert.equal((await adminGrants(s)).filter((g: any) => g.caller === "dev" && g.state === "active").length, 1);
});

test("a request by a token whose name is reused never gets the new token's child", async () => {
  const s = await setup();
  // The old token authenticated, then reaches its grant only after the name went to a new token
  // that already holds a child.
  const current = s.grants.current.bind(s.grants);
  let fresh = "";
  s.grants.current = async (...a: Parameters<typeof current>) => {
    s.grants.current = current;
    await s.call("DELETE", "/admin/api/tokens/dev", undefined, undefined, "vu@example.com");
    fresh = (await (await s.call("POST", "/admin/api/tokens", undefined, { name: "dev", projects: ["dev"] }, "vu@example.com")).json()).token;
    assert.equal((await (await s.env(fresh)).json()).env.CLOUDFLARE_API_TOKEN, "child-1");
    return current(...a);
  };
  const r = await s.env();
  assert.equal(r.status, 401);
  assert.doesNotMatch(await r.text(), /child-1/);
});

test("an old token's late request or late revoke cleanup never ends a reused name's grants", async () => {
  const s = await setup();
  await s.catalog.setScopes("dev", null); // reads only, so a workers:write child is beyond it
  const admin = (m: string, path: string, b?: unknown) => s.call(m, `/admin/api/${path}`, undefined, b, "vu@example.com");
  let fresh = "";
  const reuse = async () => {
    fresh = (await (await admin("POST", "tokens", { name: "dev", projects: ["dev"], scopes: ["workers:write"] })).json()).token;
    assert.equal((await s.call("POST", "/v1/step-up", fresh, { keys: ["CLOUDFLARE_API_TOKEN"], scopes: ["workers:write"] })).status, 200);
  };
  const activeChild = async () => (await adminGrants(s)).filter((g: any) => g.caller === "dev" && g.state === "active").length;
  // The old token's request reaches current() after the name went to a token holding a wider child.
  const current = s.grants.current.bind(s.grants);
  s.grants.current = async (...a: Parameters<typeof current>) => {
    s.grants.current = current;
    await admin("DELETE", "tokens/dev");
    await reuse();
    return current(...a);
  };
  assert.equal((await s.env()).status, 401);
  assert.equal(await activeChild(), 1);
  assert.deepEqual(s.fake.revoked, []);
  // A revoke whose cleanup runs only after the name was reused and the new token minted.
  const close = s.grants.closeCaller.bind(s.grants);
  s.grants.closeCaller = async (...a: Parameters<typeof close>) => {
    s.grants.closeCaller = close;
    await reuse();
    return close(...a);
  };
  await admin("DELETE", "tokens/dev");
  assert.equal(await activeChild(), 1);
  assert.equal((await s.env(fresh)).status, 200);
  // A narrowing whose cleanup runs only after the name was reused and the new token minted.
  await admin("PATCH", "tokens/dev", { scopes: ["workers:write"] }); // the current token, then narrowed below
  const ceiling = s.grants.closeOutsideCeiling.bind(s.grants);
  s.grants.closeOutsideCeiling = async (...a: Parameters<typeof ceiling>) => {
    s.grants.closeOutsideCeiling = ceiling;
    await admin("DELETE", "tokens/dev");
    await reuse();
    return ceiling(...a);
  };
  await admin("PATCH", "tokens/dev", { scopes: [] });
  assert.equal(await activeChild(), 1);
  assert.equal((await s.env(fresh)).status, 200);
  // A retry of a revoke that already landed reports that token's hash, read in the same transaction.
  const before = await s.catalog.revokeTokenGen("dev");
  assert.equal((await s.catalog.revokeTokenGen("dev")).fresh, false);
  assert.equal((await s.catalog.revokeTokenGen("dev")).hash, before.hash);
});

test("a token create with store never shows the token, and a store that fails leaves nothing behind", async () => {
  const s = await setup();
  const admin = (b: unknown) => s.call("POST", "/admin/api/tokens", undefined, b, "vu@example.com");
  const r = await admin({ name: "vps", projects: ["dev"], store: { scope: "global", name: "VPS_TOKEN" } });
  assert.equal(r.status, 200);
  const out = await r.json();
  assert.deepEqual(out, { name: "vps", stored: { scope: "global", name: "VPS_TOKEN" } });
  const token = await s.catalog.value((await s.catalog.keyRow("global", "VPS_TOKEN"))!);
  assert.equal((await s.env(token, "AWS_REGION")).status, 200);
  // A minted key is never a target, and a bad target is refused before any token exists.
  assert.equal((await admin({ name: "vps2", store: { scope: "dev", name: "CLOUDFLARE_API_TOKEN" } })).status, 409);
  assert.equal((await admin({ name: "vps2", store: { scope: "dev", name: "lower" } })).status, 400);
  assert.ok(!(await s.catalog.tokens()).some((t) => t.name === "vps2"));
  // A key with a check holds another service's credential: never overwritten with a token.
  await s.catalog.put("global", "OPENAI_API_KEY", "sk-fake", { config: { check: "openai" } });
  assert.equal((await admin({ name: "vps2", store: { scope: "global", name: "OPENAI_API_KEY" } })).status, 409);
  assert.equal(await s.catalog.value((await s.catalog.keyRow("global", "OPENAI_API_KEY"))!), "sk-fake");
  assert.ok(!(await s.catalog.tokens()).some((t) => t.name === "vps2"));
  // A check added to the target after it was checked, but before the write: refused in the transaction.
  await s.catalog.put("global", "RACED_KEY", "sk-old");
  const check = s.catalog.keyRow.bind(s.catalog);
  s.catalog.keyRow = async (...a: Parameters<typeof check>) => {
    const r = await check(...a);
    s.catalog.keyRow = check;
    (s.catalog as any).db.raw.prepare(`UPDATE keys SET config = '{"check":"openai"}' WHERE name = 'RACED_KEY'`).run();
    return r;
  };
  assert.equal((await admin({ name: "vps2", store: { scope: "global", name: "RACED_KEY" } })).status, 409);
  assert.equal(await s.catalog.value((await check("global", "RACED_KEY"))!), "sk-old");
  assert.ok(!(await s.catalog.tokens()).some((t) => t.name === "vps2"));
  // Any part failing, the last audit row included, leaves nothing: no token, and the key it targeted untouched.
  await s.catalog.put("global", "VPS3_TOKEN", "old-value");
  const auditRow = s.catalog.auditRow.bind(s.catalog), db = (s.catalog as any).db;
  for (const fail of ["token-create", "put"]) {
    s.catalog.auditRow = (...a: Parameters<typeof auditRow>) => a[1] === fail ? db.prepare("INSERT INTO no_such_table VALUES (1)") : auditRow(...a);
    const r = await admin({ name: "vps3", store: { scope: "global", name: "VPS3_TOKEN" } });
    assert.equal(r.status, 500);
    assert.match((await r.json()).error, /nothing was created and VPS3_TOKEN is unchanged/);
    s.catalog.auditRow = auditRow;
    assert.ok(!(await s.catalog.tokens()).some((t) => t.name === "vps3"));
    assert.equal(await s.catalog.value((await s.catalog.keyRow("global", "VPS3_TOKEN"))!), "old-value");
  }
});

test("a caller token revoked while its first request mints gets nothing", async () => {
  const s = await setup();
  const fresh = await s.catalog.createToken("fresh", ["dev"]);
  const mint = s.fake.provider.mint;
  s.fake.provider.mint = async (...a: Parameters<typeof mint>) => {
    s.fake.provider.mint = mint;
    await s.call("DELETE", "/admin/api/tokens/fresh", undefined, undefined, "vu@example.com");
    return mint(...a);
  };
  assert.equal((await s.env(fresh)).status, 409);
  assert.deepEqual(s.fake.revoked, ["id-1"]);
  assert.equal((await adminGrants(s)).filter((g: any) => g.state === "active").length, 0);
});

test("an interrupted caller-token revoke is finished by a retry or by the sweep", async () => {
  const s = await setup();
  await s.catalog.put("dev", "CF2", "parent-b", { kind: "mint:cloudflare", config: CONFIG });
  await s.env(s.dev, "CLOUDFLARE_API_TOKEN,CF2");
  assert.equal((await adminGrants(s)).length, 2);
  const close = s.grants.close.bind(s.grants);
  let left = 1; // the worker dies after closing one grant
  s.grants.close = async (...a: Parameters<typeof close>) => { if (left-- <= 0) throw new Error("worker died"); return close(...a); };
  assert.equal((await s.call("DELETE", "/admin/api/tokens/dev", undefined, undefined, "vu@example.com")).status, 500);
  assert.deepEqual(s.fake.revoked, ["id-1"]);
  assert.equal((await s.env()).status, 401); // the token itself is already dead
  s.grants.close = close;
  assert.equal((await s.call("DELETE", "/admin/api/tokens/dev", undefined, undefined, "vu@example.com")).status, 200);
  assert.deepEqual(s.fake.revoked.sort(), ["id-1", "id-2"]);
  assert.equal((await s.call("DELETE", "/admin/api/tokens/nope", undefined, undefined, "vu@example.com")).status, 404);
});

test("a crash between ending a grant and the provider delete is retried by the sweep", async () => {
  const s = await setup();
  await s.env();
  const [g] = await adminGrants(s);
  const revokeChild = s.grants.revokeChild.bind(s.grants);
  s.grants.revokeChild = async () => { throw new Error("worker died"); };
  assert.equal((await s.call("DELETE", `/admin/api/grants/${g.id}`, undefined, undefined, "vu@example.com")).status, 500);
  assert.equal((await adminGrants(s))[0].state, "revoked");
  assert.deepEqual(s.fake.revoked, []);
  assert.equal(await s.grants.pendingRevokes(), 1); // recorded with the end, before the provider call
  s.grants.revokeChild = revokeChild;
  await s.grants.sweep();
  assert.deepEqual(s.fake.revoked, ["id-1"]);
  assert.equal(await s.grants.pendingRevokes(), 0);
});

test("the sweep ends live grants of a revoked caller nobody retried", async () => {
  const s = await setup();
  await s.env();
  s.grants.closeCaller = async () => { throw new Error("worker died"); };
  await s.call("DELETE", "/admin/api/tokens/dev", undefined, undefined, "vu@example.com");
  assert.deepEqual(s.fake.revoked, []);
  await s.grants.sweep();
  assert.deepEqual(s.fake.revoked, ["id-1"]);
  assert.equal((await adminGrants(s))[0].state, "revoked");
});

test("an expiring caller token works until its expiry, then stops at once; the sweep ends its grants", async () => {
  const s = await setup(), admin = "vu@example.com";
  const r = await (await s.call("POST", "/admin/api/tokens", undefined, { name: "pilot", projects: ["dev"], expires_at: "2026-10-20T13:00:00Z" }, admin)).json();
  const listed = (await (await s.call("GET", "/admin/api/tokens", undefined, undefined, admin)).json()).tokens;
  assert.equal(listed.find((t: any) => t.name === "pilot").expires_at, "2026-10-20T13:00:00.000Z");
  assert.equal(listed.find((t: any) => t.name === "dev").expires_at, null);
  assert.equal((await (await s.call("GET", "/v1/whoami", r.token)).json()).expires_at, "2026-10-20T13:00:00.000Z");
  s.tick(59);
  assert.equal((await s.env(r.token)).status, 200); // a minute before expiry: still works, and holds a grant
  s.tick(1);
  assert.equal((await s.env(r.token)).status, 401); // at expiry: refused before any sweep runs
  assert.equal((await s.env()).status, 200);        // a token without expiry is untouched
  assert.equal((await adminGrants(s)).filter((g: any) => g.caller === "pilot" && g.state === "active").length, 1);
  // The first sweep dies mid-cleanup; the next one finishes it.
  const close = s.grants.close.bind(s.grants);
  s.grants.close = async () => { throw new Error("worker died"); };
  await assert.rejects(s.grants.sweep());
  s.grants.close = close;
  await s.grants.sweep();
  const mine = (await adminGrants(s)).filter((g: any) => g.caller === "pilot");
  assert.deepEqual(mine.map((g: any) => [g.state, g.decided_by]), [["revoked", "token-expiry"]]);
  assert.ok(s.fake.revoked.includes("id-1")); // its child is deleted at the provider
  assert.equal((await adminGrants(s)).filter((g: any) => g.caller === "dev" && g.state === "active").length, 1);
});

test("a token that expires while its child is being minted gets nothing, and the child is deleted", async () => {
  const s = await setup();
  const r = await (await s.call("POST", "/admin/api/tokens", undefined, { name: "pilot", projects: ["dev"], expires_at: "2026-10-20T12:30:00Z" }, "vu@example.com")).json();
  s.tick(29);
  const mint = s.fake.provider.mint;
  s.fake.provider.mint = async (...a: Parameters<typeof mint>) => { s.tick(2); return mint(...a); }; // the mint outlives the expiry
  const res = await s.env(r.token);
  s.fake.provider.mint = mint;
  assert.equal(res.status, 409);
  assert.doesNotMatch(await res.text(), /child-1/);
  assert.deepEqual(s.fake.revoked, ["id-1"]);
});

test("an expiry must be a valid time in the future", async () => {
  const s = await setup(), admin = "vu@example.com";
  const create = (expires_at: unknown) => s.call("POST", "/admin/api/tokens", undefined, { name: "t" + String(expires_at).length, expires_at }, admin);
  assert.equal((await create("not a time")).status, 400);
  assert.equal((await create("2026-10-20T11:00:00Z")).status, 400); // the past
  assert.equal((await create("")).status, 200);                     // empty means never
});

test("a failed delete at the provider is queued, shown in /admin, and retried by the sweep", async () => {
  const s = await setup();
  await s.env();
  const revoke = s.fake.provider.revoke;
  s.fake.provider.revoke = async () => { throw new Error("provider down"); };
  const [g] = await adminGrants(s);
  await s.call("DELETE", `/admin/api/grants/${g.id}`, undefined, undefined, "vu@example.com");
  const view = await (await s.call("GET", "/admin/api/grants", undefined, undefined, "vu@example.com")).json();
  assert.equal(view.revoke_pending, 1);
  await s.grants.sweep(); // still down: stays queued
  assert.equal(await s.grants.pendingRevokes(), 1);
  s.fake.provider.revoke = revoke;
  await s.grants.sweep();
  assert.deepEqual(s.fake.revoked, ["id-1"]);
  assert.equal(await s.grants.pendingRevokes(), 0);
});

test("an unexpected mint or revoke error never reaches the logs or the response by its message", async () => {
  const s = await setup(), SENTINEL = "sk-sentinel-must-not-log", logged: unknown[] = [];
  const error = console.error;
  console.error = (...a: unknown[]) => { logged.push(...a); };
  try {
    const mint = s.fake.provider.mint;
    s.fake.provider.mint = async () => { throw new Error(`mint refused for ${SENTINEL}`); };
    let r = await s.env();
    assert.equal(r.status, 500);
    assert.doesNotMatch(await r.text(), new RegExp(SENTINEL));
    // `name` is writable, so a thrower can put anything there too: only a known class name is logged.
    s.fake.provider.mint = async () => { throw Object.assign(new Error("x"), { name: `ProviderError ${SENTINEL}` }); };
    r = await s.env();
    assert.equal(r.status, 500);
    s.fake.provider.mint = mint;
    await s.env();
    const revoke = s.fake.provider.revoke;
    s.fake.provider.revoke = async () => { throw new TypeError(`revoke refused for ${SENTINEL}`); };
    const live = (await adminGrants(s)).find((g: any) => g.state === "active");
    await s.call("DELETE", `/admin/api/grants/${live.id}`, undefined, undefined, "vu@example.com");
    assert.equal(await s.grants.pendingRevokes(), 1); // still queued for retry
    s.fake.provider.revoke = revoke;
    await s.grants.sweep();
    assert.equal(await s.grants.pendingRevokes(), 0);
  } finally { console.error = error; }
  assert.ok(logged.length >= 3);
  assert.doesNotMatch(logged.map(String).join(" "), new RegExp(SENTINEL));
  assert.ok(["Error", "other", "TypeError"].every((c) => logged.includes(c))); // a known class is kept for debugging
});

test("a project key overriding a global one starts a new grant instead of reusing the old key's child", async () => {
  const s = await setup();
  await s.catalog.put("global", "CF_G", PARENT, { kind: "mint:cloudflare", config: CONFIG });
  assert.equal((await (await s.env(s.dev, "CF_G")).json()).env.CF_G, "child-1");
  await s.catalog.put("dev", "CF_G", "project-parent", { kind: "mint:cloudflare", config: CONFIG });
  assert.equal((await (await s.env(s.dev, "CF_G")).json()).env.CF_G, "child-2");
  assert.equal(s.fake.minted.at(-1)!.parent, "project-parent");
  assert.deepEqual(s.fake.revoked, ["id-1"]);
});

test("rotating a mint key keeps its kind; it can't be turned static, and listing doesn't mint", async () => {
  const s = await setup();
  await s.catalog.put("dev", "CLOUDFLARE_API_TOKEN", "new-parent");
  assert.equal((await s.catalog.keyRow("dev", "CLOUDFLARE_API_TOKEN"))!.kind, "mint:cloudflare");
  await assert.rejects(s.catalog.put("dev", "CLOUDFLARE_API_TOKEN", "x", { kind: "static" }), /delete the key/);
  const r = await (await s.call("GET", "/v1/keys", s.dev)).json();
  assert.deepEqual(r.keys, ["AWS_REGION", "CLOUDFLARE_API_TOKEN"]);
  assert.equal(s.fake.minted.length, 0);
  // Admin config is validated: a start scope must exist.
  const bad = await s.call("PUT", "/admin/api/keys/dev/CF_X", undefined, { value: "p", kind: "mint:cloudflare", config: { ...CONFIG, start: ["nope"] } }, "vu@example.com");
  assert.equal(bad.status, 400);
});

test("without the grants module a mint key is refused, never handed out raw", async () => {
  const s = await setup();
  const r = await handle(new Request("https://t.example/v1/env?keys=CLOUDFLARE_API_TOKEN", { headers: { authorization: `Bearer ${s.dev}` } }),
    { catalog: s.catalog, admin: async () => null });
  assert.equal(r.status, 501);
  assert.ok(!(await r.text()).includes(PARENT));
});

test("cloudflare provider: mints an account token with the scopes' groups, expiry and IP lock, and revokes it", async () => {
  const calls: { method: string; url: string; auth: string; body: any }[] = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    calls.push({ method: init.method!, url, auth: (init.headers as any).authorization, body: init.body ? JSON.parse(String(init.body)) : null });
    if (init.method === "DELETE") return new Response(JSON.stringify({ success: false, errors: [{ code: 1003 }] }), { status: 404 });
    return new Response(JSON.stringify({ success: true, result: { id: "tok1", value: "cf-child" } }));
  }) as unknown as typeof fetch;
  const cf = cloudflare(fetcher), config = { ...CONFIG, ip: ["203.0.113.0/24"] };
  cf.validate(config);
  const m = await cf.mint(PARENT, config, ["workers:write"], new Date("2026-10-20T12:30:00.123Z"), "tumbler g_1 dev");
  assert.deepEqual(m, { id: "tok1", value: "cf-child" });
  const c = calls[0];
  assert.equal(c.url, `https://api.cloudflare.com/client/v4/accounts/${ACCT}/tokens`);
  assert.equal(c.auth, `Bearer ${PARENT}`);
  assert.equal(c.body.expires_on, "2026-10-20T12:30:00Z");
  assert.deepEqual(c.body.policies[0].permission_groups, [{ id: READ }, { id: WRITE }]);
  assert.deepEqual(c.body.policies[0].resources, { [`com.cloudflare.api.account.${ACCT}`]: "*" });
  assert.deepEqual(c.body.condition, { "request.ip": { in: ["203.0.113.0/24"] } });
  await cf.revoke(PARENT, config, "tok1"); // a 404 means already gone
  assert.equal(calls[1].url, `https://api.cloudflare.com/client/v4/accounts/${ACCT}/tokens/tok1`);
  assert.throws(() => cf.validate({ ...CONFIG, account_id: "nope" }), /account_id/);
});

test("cloudflare provider: an API error surfaces as a status and codes only", async () => {
  const cf = cloudflare((async () => new Response(JSON.stringify({ success: false, errors: [{ code: 9109, message: "detail" }] }), { status: 403 })) as any);
  await assert.rejects(cf.mint(PARENT, CONFIG, ["workers:read"], new Date(), "x"), (e: any) => e.status === 502 && /403 \(9109\)/.test(e.message) && !e.message.includes(PARENT));
});

// --- the CLI end to end ---

const exec = promisify(execFile);
const CLI = new URL("../../cli/tumbler", import.meta.url).pathname;
const s = await setup();
const server = createServer(async (req, res) => {
  let body = ""; for await (const c of req) body += c;
  const r = await handle(new Request(`http://127.0.0.1${req.url}`, { method: req.method, headers: req.headers as any, body: body || undefined }),
    { catalog: s.catalog, grants: s.grants, admin: async () => "vu@example.com" });
  let text = await r.text();
  // Shrinks the broker's max_age so a test can outlive it in real time.
  if (maxAge !== null && /"max_age"/.test(text)) text = JSON.stringify({ ...JSON.parse(text), max_age: maxAge });
  res.writeHead(r.status, { "content-type": r.headers.get("content-type") ?? "application/json" }); res.end(text);
});
let maxAge: number | null = null;
await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
after(() => server.close());
const home = mkdtempSync(join(tmpdir(), "tumbler-grants-"));
writeFileSync(join(home, ".tumbler"), "CLOUDFLARE_API_TOKEN\n");
const { CLOUDFLARE_API_TOKEN: _c, TUMBLER_URL: _u, TUMBLER_TOKEN: _t, TUMBLER_PROJECT: _j, ...baseEnv } = process.env;
const cli = (args: string[]) => exec(CLI, args, { cwd: home, env: { ...baseEnv, HOME: home, XDG_RUNTIME_DIR: join(home, "run"),
  TUMBLER_URL: `http://127.0.0.1:${(server.address() as any).port}`, TUMBLER_TOKEN: s.dev, TUMBLER_TTL: "0", TUMBLER_AUTO: "off" } });
const printToken = ["node", "-e", "process.stdout.write(String(process.env.CLOUDFLARE_API_TOKEN))"];

test("cli: run gets a read child; --scope for a write the token can't hold stops, and runs once the token allows it", async () => {
  assert.equal((await cli(["run", "--", ...printToken])).stdout, "child-1");
  await s.catalog.setScopes("dev", null);
  const err = await cli(["run", "--scope", "workers:write", "--", ...printToken]).then(() => null, (e) => e);
  assert.ok(err, "the command must not start without the scope");
  assert.match(err.stderr, /may not hold workers:write\. Refused; retrying won't help: ask a human to add it to this token's scopes in \/admin/);
  assert.equal(err.stdout, "");
  await s.catalog.setScopes("dev", ["workers:write"]);
  assert.equal((await cli(["run", "--scope", "workers:write", "--", ...printToken])).stdout, "child-2");
  assert.equal((await cli(["keys"])).stdout, "CLOUDFLARE_API_TOKEN\n".replace(/^/, "AWS_REGION\n"));
});

test("cli: a long TUMBLER_TTL can't hand out a cached child past the broker's max_age", async () => {
  const ttl = (args: string[]) => exec(CLI, args, { cwd: home, env: { ...baseEnv, HOME: home, XDG_RUNTIME_DIR: join(home, "run-ttl"),
    TUMBLER_URL: `http://127.0.0.1:${(server.address() as any).port}`, TUMBLER_TOKEN: s.dev, TUMBLER_TTL: "3600", TUMBLER_AUTO: "off", TUMBLER_IDLE: "5" } });
  maxAge = 1;
  try {
    const first = (await ttl(["run", "--", ...printToken])).stdout;
    assert.equal((await ttl(["run", "--", ...printToken])).stdout, first); // within max_age: cached
    s.tick(60); // the child expires at the broker
    await new Promise((r) => setTimeout(r, 1100));
    assert.notEqual((await ttl(["run", "--", ...printToken])).stdout, first);
  } finally { maxAge = null; }
});

test("/v1/env tells the client how long it may cache a minted child, and nothing for static keys", async () => {
  const t = await setup();
  assert.equal((await (await t.env()).json()).max_age, 300);
  assert.equal("max_age" in (await (await t.env(t.dev, "AWS_REGION")).json()), false);
});

test("moving a scope ends the children minted from its keys; the next read mints from the moved key", async () => {
  const s = await setup();
  assert.equal((await (await s.env()).json()).env.CLOUDFLARE_API_TOKEN, "child-1");
  const r = await s.call("POST", "/admin/api/scopes/move", undefined, { from: "dev", to: "dev/staging" }, "vu@example.com");
  assert.equal(r.status, 200);
  assert.deepEqual(s.fake.revoked, ["id-1"]);
  assert.equal((await s.call("GET", "/v1/env?keys=CLOUDFLARE_API_TOKEN", s.dev)).status, 200);
  assert.deepEqual(s.fake.minted.map((m) => m.parent), [PARENT, PARENT]);
});

test("a move ends grants read as the old scope on keys that didn't move, even when a first attempt already repinned", async () => {
  const s = await setup();
  await s.catalog.remove("dev", "CLOUDFLARE_API_TOKEN");
  await s.catalog.put("global", "CLOUDFLARE_API_TOKEN", PARENT, { kind: "mint:cloudflare", config: CONFIG });
  await s.env(); // id-1, on the global key, read as dev
  await s.catalog.setPin("dev", ["dev/staging"]); // an earlier move that crashed after repinning
  const r = await s.call("POST", "/admin/api/scopes/move", undefined, { from: "dev", to: "dev/staging" }, "vu@example.com");
  assert.deepEqual((await r.json()).repinned, ["other"]); // "dev" was repinned by the first attempt
  assert.deepEqual(s.fake.revoked, ["id-1"]);
  // A migration isn't a revoke: the moved token's next read mints at once instead of waiting.
  assert.equal((await (await s.env()).json()).env.CLOUDFLARE_API_TOKEN, "child-2");
});

test("a token minting through */dev keeps its child while it holds dev, and loses it when dev goes", async () => {
  const s = await setup();
  await s.catalog.remove("dev", "CLOUDFLARE_API_TOKEN");
  await s.catalog.put("huddles/dev", "CLOUDFLARE_API_TOKEN", PARENT, { kind: "mint:cloudflare", config: CONFIG });
  const pin = (projects: string[]) => s.call("PATCH", "/admin/api/tokens/dev", undefined, { projects }, "vu@example.com");
  await pin(["*", "*/dev"]);
  assert.equal((await (await s.call("GET", "/v1/env?project=huddles/dev&keys=CLOUDFLARE_API_TOKEN", s.dev)).json()).env.CLOUDFLARE_API_TOKEN, "child-1");
  await pin(["huddles/dev"]);
  assert.deepEqual(s.fake.revoked, []); // still reaches huddles/dev
  await pin(["*", "*/prod"]);
  assert.deepEqual(s.fake.revoked, ["id-1"]);
});

test("*/env dropped while a first mint runs: the child is deleted, never handed out", async () => {
  const s = await setup();
  await s.catalog.remove("dev", "CLOUDFLARE_API_TOKEN");
  await s.catalog.put("huddles/prod", "CLOUDFLARE_API_TOKEN", PARENT, { kind: "mint:cloudflare", config: CONFIG });
  await s.catalog.setPin("dev", ["*/prod"]);
  const mint = s.fake.provider.mint;
  s.fake.provider.mint = async (...a: Parameters<typeof mint>) => { await s.catalog.setPin("dev", ["*", "*/dev"]); return mint(...a); };
  const r = await s.call("GET", "/v1/env?project=huddles/prod&keys=CLOUDFLARE_API_TOKEN", s.dev);
  assert.equal(r.status, 409);
  assert.deepEqual(s.fake.revoked, ["id-1"]);
});

test("an operator token adds and removes groups on the minted key it reads; the old children end, the next run mints with them", async () => {
  const s = await setup();
  const scope = (token: string, method = "GET", body?: unknown, q = "") => s.call(method, `/v1/mint/CLOUDFLARE_API_TOKEN${q}`, token, body);
  const off = await scope(s.dev);
  assert.equal(off.status, 403);
  assert.match((await off.json()).error, /not an operator.*tumbler admin token edit dev --operator on/);

  assert.equal((await s.call("PATCH", "/admin/api/tokens/dev", undefined, { operator: true }, "vu@example.com")).status, 200);
  const toks = await (await s.call("GET", "/admin/api/tokens", undefined, undefined, "vu@example.com")).json();
  assert.deepEqual(toks.tokens.map((t: any) => [t.name, t.operator, t.projects]), [["dev", true, ["dev"]], ["other", false, ["dev"]]]); // the pin stays
  assert.equal((await (await s.call("GET", "/v1/whoami", s.dev)).json()).operator, true);

  await s.call("POST", "/v1/step-up", s.dev, { keys: ["CLOUDFLARE_API_TOKEN"], scopes: ["workers:write"] });
  const before = (await adminGrants(s))[0];
  const added = await scope(s.dev, "PATCH", { scope: "workers:write", add: ["containers write"] });
  assert.equal(added.status, 200);
  assert.deepEqual((await added.json()).scopes["workers:write"], { base: [READ, WRITE], extra: ["Containers Write"] });
  assert.equal((await s.grants.get(before.id))!.state, "revoked"); // its child held the old groups
  await s.call("POST", "/v1/step-up", s.dev, { keys: ["CLOUDFLARE_API_TOKEN"], scopes: ["workers:write"] });
  assert.deepEqual(s.fake.configs.at(-1).extra, { "workers:write": ["Containers Write"] });
  const audit = await (await s.call("GET", "/admin/api/audit", undefined, undefined, "vu@example.com")).json();
  assert.ok(audit.audit.some((a: any) => a.actor === "dev" && a.action === "mint-scope" && a.names === "CLOUDFLARE_API_TOKEN,workers:write,+Containers Write"));

  // A change that lost a race to another saves nothing and retires nothing of the winner's.
  const stale = (await s.catalog.keyRow("dev", "CLOUDFLARE_API_TOKEN"))!.rev;
  assert.equal(await s.catalog.setConfig("dev", "CLOUDFLARE_API_TOKEN", stale, { ...CONFIG }), true);
  const now = (await s.catalog.keyRow("dev", "CLOUDFLARE_API_TOKEN"))!.rev;
  assert.equal(await s.catalog.setConfig("dev", "CLOUDFLARE_API_TOKEN", stale, { ...CONFIG }), false);
  assert.equal(await s.db.prepare("SELECT 1 FROM retired_keys WHERE rev = ?").bind(now).first(), null);
  await scope(s.dev, "PATCH", { scope: "workers:write", add: ["containers write"] });
  // Only additions come off; the admin's config isn't the CLI's to change, and unknown groups save nothing.
  assert.equal((await scope(s.dev, "PATCH", { scope: "workers:write", remove: [WRITE] })).status, 400);
  assert.equal((await scope(s.dev, "PATCH", { scope: "workers:write", add: ["Nope Write"] })).status, 400);
  assert.equal((await scope(s.dev, "PATCH", { scope: "workers:write", remove: ["containers write"] })).status, 200);
  assert.equal(JSON.parse((await s.catalog.keyRow("dev", "CLOUDFLARE_API_TOKEN"))!.config).extra, undefined);
  // The parent is untouched by a scope change, and never in a response.
  const row = (await s.catalog.keyRow("dev", "CLOUDFLARE_API_TOKEN"))!;
  assert.equal(await s.catalog.value(row), PARENT);
  assert.ok(!JSON.stringify(await (await scope(s.dev)).json()).includes(PARENT));
  // Another project's key is out of reach: the token reads only its pin.
  assert.equal((await scope(s.dev, "GET", undefined, "?project=kypp")).status, 403);
  // The live list of groups, under the same gate; nothing else hangs off the path.
  const listed = await (await s.call("GET", "/v1/mint/CLOUDFLARE_API_TOKEN/groups", s.dev)).json();
  assert.deepEqual(listed.groups.map((g: any) => g.name), ["Containers Write", "Workers Containers Write", "Account API Tokens Write"]);
  assert.ok(!JSON.stringify(listed).includes(PARENT));
  assert.equal((await s.call("GET", "/v1/mint/CLOUDFLARE_API_TOKEN/other", s.dev)).status, 404);
  assert.equal((await s.call("PATCH", "/v1/mint/CLOUDFLARE_API_TOKEN/groups", s.dev, {})).status, 404);
  assert.equal((await s.call("GET", "/v1/mint/CLOUDFLARE_API_TOKEN/groups", s.other)).status, 403);
});

test("cli: scope add/rm change a minted key's groups for an operator token; others are told who turns it on", async () => {
  const err = await cli(["scope", "add", "CLOUDFLARE_API_TOKEN", "workers:write", "Containers Write"]).then(() => null, (e) => e);
  assert.match(err.stderr, /not an operator; an admin turns that on for it in \/admin or with `tumbler admin token edit dev --operator on`/);
  await s.catalog.updateToken("dev", { operator: true });
  const add = await cli(["scope", "add", "CLOUDFLARE_API_TOKEN", "workers:write", "Containers Write"]);
  assert.match(add.stderr, /added Containers Write to CLOUDFLARE_API_TOKEN workers:write \(dev\)/);
  assert.match(add.stdout, /workers:write\t.*\+Containers Write/);
  assert.deepEqual(JSON.parse((await cli(["scope", "CLOUDFLARE_API_TOKEN", "--json"])).stdout).scopes["workers:write"].extra, ["Containers Write"]);
  const groups = await cli(["scope", "groups", "CLOUDFLARE_API_TOKEN", "containers"]);
  assert.equal(groups.stdout, "Containers Write\taccount\nWorkers Containers Write\taccount\n");
  assert.match((await cli(["scope", "groups", "CLOUDFLARE_API_TOKEN", "tokens"])).stdout, /Account API Tokens Write\taccount\t\(not addable with scope add\)/);
  assert.equal(JSON.parse((await cli(["scope", "groups", "CLOUDFLARE_API_TOKEN", "workers", "--json"])).stdout).groups.length, 1);
  assert.match((await cli(["scope", "groups", "CLOUDFLARE_API_TOKEN", "pages"])).stderr, /no group with pages/);
  await cli(["scope", "rm", "CLOUDFLARE_API_TOKEN", "workers:write", "Containers Write"]);
  assert.deepEqual(JSON.parse((await cli(["scope", "CLOUDFLARE_API_TOKEN", "--json"])).stdout).scopes["workers:write"].extra, []);
  await s.catalog.updateToken("dev", { operator: false });
});

test("cli: under the wrangler shim a deploy asks for workers:write itself; reads and --local stay on the read child", async () => {
  const bin = mkdtempSync(join(home, "bin-"));
  writeFileSync(join(bin, "wrangler"), "#!/bin/sh\nprintf %s \"$CLOUDFLARE_API_TOKEN\"\n", { mode: 0o755 });
  await cli(["shim", "wrangler"]);
  const shims = join(home, ".local/share/tumbler/bin");
  const wrangler = (args: string[]) => exec(join(shims, "wrangler"), args, { cwd: home, env: { ...baseEnv, HOME: home, XDG_RUNTIME_DIR: join(home, "run"),
    PATH: `${shims}:${bin}:${process.env.PATH}`, TUMBLER_URL: `http://127.0.0.1:${(server.address() as any).port}`, TUMBLER_TOKEN: s.dev, TUMBLER_TTL: "0", TUMBLER_AUTO: "off" } });
  const lastScopes = () => s.fake.minted.at(-1).scopes;
  await s.catalog.setScopes("dev", ["workers:write"]);
  await wrangler(["deploy"]);
  assert.deepEqual(lastScopes(), ["workers:read", "workers:write"]);
  const n = s.fake.minted.length;
  await wrangler(["d1", "migrations", "apply", "DB", "--local"]);
  await wrangler(["whoami"]);
  assert.equal(s.fake.minted.length, n, "no new child for a read or a local write");
  // A token that can't hold workers:write still runs the deploy, on its read child, and says why.
  await s.catalog.setScopes("dev", null);
  const r = await wrangler(["secret", "put", "X"]);
  assert.match(r.stdout, /^child-\d+$/);
  assert.match(r.stderr, /workers:write not granted .*running on the read token/);
  await s.catalog.setScopes("dev", ["workers:write"]);
});

test("a delegate creates tokens no wider than itself, which end when it narrows or is revoked", async () => {
  const s = await setup();
  const admin = (m: string, path: string, b?: unknown) => s.call(m, `/admin/api/${path}`, undefined, b, "vu@example.com");
  const make = (b: unknown, token = s.dev) => s.call("POST", "/v1/tokens", token, b);
  assert.match((await (await make({ name: "vps", projects: ["dev"] })).json()).error, /not a delegate.*--delegate on/);
  assert.equal((await admin("PATCH", "tokens/dev", { delegate: true, writes: ["dev"] })).status, 200);
  // Anything beyond the delegate is refused whole, padded or not, and nothing is created.
  for (const b of [{ projects: ["kypp"] }, { projects: ["*"] }, { scopes: ["*"] }, { scopes: ["pages:write"] }, { writes: ["global"] }, { writes: [" global "] }, { scopes: [" pages:write"] }, { projects: [" kypp "] }, { operator: true, projects: ["kypp"] }]) {
    const r = await make({ name: "wide", ...b });
    assert.equal(r.status, 403, JSON.stringify(b));
    assert.match((await r.json()).error, /beyond dev, so nothing was created/);
  }
  assert.equal((await make({ name: "wide", expires_hours: 24 * 91 })).status, 400);
  assert.equal((await make({ name: "wide", projects: ["dev"], store: { scope: "global", name: "WIDE" } })).status, 403);
  assert.equal(await s.catalog.tokenRow("wide"), null);
  // Within it: shown once, expiring in 30 days, never an operator or delegate.
  const r = await make({ name: "vps", projects: ["dev"], scopes: ["workers:write"], writes: ["dev"] });
  assert.equal(r.status, 200);
  const made = await r.json();
  assert.equal(made.expires_at, "2026-11-19T12:00:00.000Z");
  const who = await (await s.call("GET", "/v1/whoami", made.token)).json();
  assert.deepEqual([who.parent, who.operator, who.delegate, who.writes], ["dev", false, false, ["dev"]]);
  assert.equal((await (await s.env(made.token)).json()).env.CLOUDFLARE_API_TOKEN, "child-1");
  // Stored straight into a key the delegate writes, never shown.
  const stored = await (await make({ name: "vps2", projects: ["dev"], store: { scope: "dev", name: "VPS2_TOKEN" } })).json();
  assert.deepEqual([stored.token, stored.stored], [undefined, { scope: "dev", name: "VPS2_TOKEN" }]);
  assert.equal((await s.call("GET", "/v1/whoami", await s.catalog.value((await s.catalog.keyRow("dev", "VPS2_TOKEN"))!))).status, 200);
  // A name another token holds is never taken over, and a delegate revokes only its own.
  assert.equal((await make({ name: "other" })).status, 409);
  assert.equal((await s.call("DELETE", "/v1/tokens/other", s.dev)).status, 404);
  assert.deepEqual((await (await s.call("GET", "/v1/tokens", s.dev)).json()).tokens.map((t: any) => t.name), ["vps", "vps2"]);
  // A token a delegate made never becomes a delegate or an operator, so chains stay one level deep.
  for (const b of [{ delegate: true }, { operator: true }]) {
    const r = await admin("PATCH", "tokens/vps", b);
    assert.equal(r.status, 409, JSON.stringify(b));
    assert.match((await r.json()).error, /was made by dev, so it can't be a delegate or an operator/);
  }
  assert.equal((await admin("PATCH", "tokens/vps", { delegate: false })).status, 200);
  // Narrowing the delegate ends what no longer fits: vps held workers:write, vps2 reads only.
  const narrowed = await (await admin("PATCH", "tokens/dev", { scopes: [] })).json();
  assert.deepEqual(narrowed.ended, ["vps"]);
  assert.equal((await s.call("GET", "/v1/whoami", made.token)).status, 401);
  assert.deepEqual(s.fake.revoked, ["id-1"]);
  // Revoking the delegate ends the rest; and a parent revoked in its row alone already stops them.
  const vps3 = (await (await make({ name: "vps3", projects: ["dev"] })).json()).token;
  s.db.raw.prepare("UPDATE tokens SET revoked_at = '2026-10-20T12:00:00Z' WHERE name = 'dev'").run();
  assert.equal((await s.call("GET", "/v1/whoami", vps3)).status, 401);
  s.db.raw.prepare("UPDATE tokens SET revoked_at = NULL WHERE name = 'dev'").run();
  assert.equal((await admin("DELETE", "tokens/dev")).status, 200);
  assert.ok((await s.catalog.tokens("dev")).every((t) => t.revoked_at));
});

test("a delegate's revoke cut short is finished by a retry, children included", async () => {
  const s = await setup();
  const admin = (m: string, path: string, b?: unknown) => s.call(m, `/admin/api/${path}`, undefined, b, "vu@example.com");
  await admin("PATCH", "tokens/dev", { delegate: true });
  const vps = (await (await s.call("POST", "/v1/tokens", s.dev, { name: "vps", projects: ["dev"] })).json()).token;
  assert.equal((await s.env(vps)).status, 200);
  // The worker dies after the revoke's batch, before any grant is closed.
  const close = s.grants.closeCaller.bind(s.grants);
  s.grants.closeCaller = async () => { s.grants.closeCaller = close; throw new Error("worker died"); };
  assert.equal((await admin("DELETE", "tokens/dev")).status, 500);
  assert.deepEqual(s.fake.revoked, []);
  assert.equal((await admin("DELETE", "tokens/dev")).status, 200);
  assert.deepEqual(s.fake.revoked, ["id-1"]);
});

test("a delegate narrowed while its child's mint runs: the child is never stored", async () => {
  const s = await setup();
  await s.call("PATCH", "/admin/api/tokens/dev", undefined, { delegate: true }, "vu@example.com");
  const vps = (await (await s.call("POST", "/v1/tokens", s.dev, { name: "vps", projects: ["dev"], scopes: ["workers:write"] })).json()).token;
  // Narrowed in its row alone, as a PATCH cut short leaves it, while the provider mints.
  const mint = s.fake.provider.mint;
  s.fake.provider.mint = async (...a: Parameters<typeof mint>) => {
    s.fake.provider.mint = mint;
    s.db.raw.prepare("UPDATE tokens SET scopes = NULL WHERE name = 'dev'").run();
    return mint(...a);
  };
  assert.equal((await s.call("POST", "/v1/step-up", vps, { keys: ["CLOUDFLARE_API_TOKEN"], scopes: ["workers:write"] })).status, 409);
  assert.equal((await adminGrants(s)).filter((g: any) => g.caller === "vps" && g.state === "active" && g.scopes.includes("workers:write")).length, 0);
  assert.ok(s.fake.revoked.length >= 1, "the child minted for it is deleted at the provider");
});

test("a delegate's reused name inherits none of the old delegate's tokens", async () => {
  const s = await setup();
  const admin = (m: string, path: string, b?: unknown) => s.call(m, `/admin/api/${path}`, undefined, b, "vu@example.com");
  await admin("PATCH", "tokens/dev", { delegate: true });
  const vps = (await (await s.call("POST", "/v1/tokens", s.dev, { name: "vps", projects: ["dev"] })).json()).token;
  await admin("DELETE", "tokens/dev");
  const fresh = (await (await admin("POST", "tokens", { name: "dev", projects: ["dev"], delegate: true })).json()).token;
  assert.deepEqual((await (await s.call("GET", "/v1/tokens", fresh)).json()).tokens, []);
  assert.equal((await s.call("GET", "/v1/whoami", vps)).status, 401);
});

test("a delegate's request racing a revoke and reuse of its name, or of its child's, touches nothing new", async () => {
  const s = await setup();
  const admin = (m: string, path: string, b?: unknown) => s.call(m, `/admin/api/${path}`, undefined, b, "vu@example.com");
  await admin("PATCH", "tokens/dev", { delegate: true, projects: ["dev"] });
  // The old delegate authenticated, then its name goes to a new delegate with the same bounds.
  const create = s.catalog.createToken.bind(s.catalog);
  s.catalog.createToken = async (...a: Parameters<typeof create>) => {
    s.catalog.createToken = create;
    await admin("DELETE", "tokens/dev");
    await admin("POST", "tokens", { name: "dev", projects: ["dev"], scopes: ["workers:write"], delegate: true });
    return create(...a);
  };
  assert.equal((await s.call("POST", "/v1/tokens", s.dev, { name: "vps", projects: ["dev"] })).status, 409);
  assert.equal(await s.catalog.tokenRow("vps"), null);
  // A delegate revoking its child after an admin revoked and reused the child's name.
  const fresh = (await (await admin("POST", "tokens", { name: "boss", projects: ["dev"], delegate: true })).json()).token;
  assert.equal((await s.call("POST", "/v1/tokens", fresh, { name: "kid", projects: ["dev"], expires: "1d" })).status, 200);
  // The admin revokes and reuses "kid" just after the delegate's ownership check has read it.
  let other = "";
  const race = async () => {
    if (other) return;
    other = "pending";
    await admin("DELETE", "tokens/kid");
    other = (await (await admin("POST", "tokens", { name: "kid", projects: ["dev"] })).json()).token;
  };
  const { tokenRow, revokeChildOf } = s.catalog;
  s.catalog.tokenRow = async (n: string) => { const r = await tokenRow.call(s.catalog, n); if (n === "kid") await race(); return r; };
  s.catalog.revokeChildOf = async (...a: Parameters<typeof revokeChildOf>) => { await race(); return revokeChildOf.apply(s.catalog, a); };
  assert.equal((await s.call("DELETE", "/v1/tokens/kid", fresh)).status, 404);
  assert.equal((await s.env(other)).status, 200);
});

test("ending a delegate's outgrown tokens never revokes a token that took the name meanwhile", async () => {
  const s = await setup();
  const admin = (m: string, path: string, b?: unknown) => s.call(m, `/admin/api/${path}`, undefined, b, "vu@example.com");
  await admin("PATCH", "tokens/dev", { delegate: true });
  // Each cleanup lists the outgrown child, then an admin revokes it and gives its name to a new token.
  const race = async (name: string) => {
    const { revokeGen, revokeToken } = s.catalog;
    let other = "";
    const reuse = async () => {
      if (other) return;
      other = "pending";
      await admin("DELETE", `tokens/${name}`);
      other = (await (await admin("POST", "tokens", { name, projects: ["dev"] })).json()).token;
    };
    s.catalog.revokeGen = async (t) => { await reuse(); return revokeGen.call(s.catalog, t); };
    s.catalog.revokeToken = async (n) => { await reuse(); return revokeToken.call(s.catalog, n); };
    return () => { Object.assign(s.catalog, { revokeGen, revokeToken }); return other; };
  };
  // The narrowing PATCH's own cleanup.
  await s.call("POST", "/v1/tokens", s.dev, { name: "vps", projects: ["dev"], scopes: ["workers:write"] });
  let done = await race("vps");
  await admin("PATCH", "tokens/dev", { scopes: [] });
  assert.equal((await s.call("GET", "/v1/whoami", done())).status, 200);
  // The sweep, for a narrowing whose cleanup never ran.
  await admin("PATCH", "tokens/dev", { scopes: ["workers:write"] });
  await s.call("POST", "/v1/tokens", s.dev, { name: "vps2", projects: ["dev"], scopes: ["workers:write"] });
  s.db.raw.prepare("UPDATE tokens SET scopes = NULL WHERE name = 'dev'").run();
  done = await race("vps2");
  await s.grants.sweep();
  assert.equal((await s.call("GET", "/v1/whoami", done())).status, 200);
});

test("a delegate's token never outlives it", async () => {
  const s = await setup();
  const until = "2026-10-21T12:00:00.000Z";
  const brief = await s.catalog.createToken("brief", ["dev"], until, null, null, false, { delegate: true });
  const made = await (await s.call("POST", "/v1/tokens", brief, { name: "short", projects: ["dev"] })).json();
  assert.equal(made.expires_at, until);
});

test("a delegate's token stops at its parent's current bounds even when cleanup is cut short or a create races a narrowing", async () => {
  const s = await setup();
  await s.call("PATCH", "/admin/api/tokens/dev", undefined, { delegate: true }, "vu@example.com");
  const vps = (await (await s.call("POST", "/v1/tokens", s.dev, { name: "vps", projects: ["dev"], scopes: ["workers:write"] })).json()).token;
  await s.call("POST", "/v1/step-up", vps, { keys: ["CLOUDFLARE_API_TOKEN"], scopes: ["workers:write"] });
  // Narrowed with no cleanup at all, as a PATCH cut short after its write leaves it.
  s.db.raw.prepare("UPDATE tokens SET scopes = NULL WHERE name = 'dev'").run();
  assert.equal((await s.call("GET", "/v1/whoami", vps)).status, 401);
  await s.grants.sweep();
  assert.ok((await s.catalog.tokenRow("vps"))!.revoked_at);
  assert.equal((await adminGrants(s)).filter((g: any) => g.caller === "vps" && ["active", "pending"].includes(g.state)).length, 0);
  // A create authorized before a narrowing that lands while it runs.
  s.db.raw.prepare("UPDATE tokens SET projects = '[\"dev\"]' WHERE name = 'dev'").run();
  const create = s.catalog.createToken.bind(s.catalog);
  s.catalog.createToken = async (...a: Parameters<typeof create>) => {
    s.catalog.createToken = create;
    s.db.raw.prepare("UPDATE tokens SET projects = NULL WHERE name = 'dev'").run();
    return create(...a);
  };
  const raced = await s.call("POST", "/v1/tokens", s.dev, { name: "vps2", projects: ["dev"] });
  assert.equal(raced.status, 409);
  assert.match((await raced.json()).error, /dev changed while token vps2 was being made, so nothing was created/);
  assert.equal(await s.catalog.tokenRow("vps2"), null);
  // Its writes taken away while a create stores into them: nothing is created, and the key is untouched.
  s.db.raw.prepare("UPDATE tokens SET projects = '[\"dev\"]', writes = '[\"dev\"]' WHERE name = 'dev'").run();
  await s.catalog.put("dev", "VPS_TOKEN", "old-value");
  const into = s.catalog.createTokenInto.bind(s.catalog);
  s.catalog.createTokenInto = async (...a: Parameters<typeof into>) => {
    s.catalog.createTokenInto = into;
    s.db.raw.prepare("UPDATE tokens SET writes = NULL WHERE name = 'dev'").run();
    return into(...a);
  };
  assert.equal((await s.call("POST", "/v1/tokens", s.dev, { name: "vps3", projects: ["dev"], store: { scope: "dev", name: "VPS_TOKEN" } })).status, 409);
  assert.equal(await s.catalog.tokenRow("vps3"), null);
  assert.equal(await s.catalog.value((await s.catalog.keyRow("dev", "VPS_TOKEN"))!), "old-value");
});

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
import { Catalog } from "../src/catalog.ts";
import { cloudflare } from "../src/cloudflare.ts";
import { masterKey } from "../src/crypto.ts";
import { Grants, type Provider } from "../src/grants.ts";
import { memoryD1 } from "./d1.ts";

const PARENT = "parent-token-never-leaves";
const ACCT = "a".repeat(32), READ = "1".repeat(32), WRITE = "2".repeat(32);
const CONFIG = { account_id: ACCT, ttl_minutes: 30, start: ["workers:read"], scopes: { "workers:read": [READ], "workers:write": [READ, WRITE] } };

// A provider that mints "child-N" and remembers what it was asked; `fail` makes the next mint throw.
function fakeProvider() {
  const p = { minted: [] as { scopes: string[]; parent: string }[], revoked: [] as string[], fail: false, n: 0 } as any;
  const provider: Provider = {
    validate() {},
    async mint(parent, _c, scopes) {
      if (p.fail) throw new Error("provider down");
      p.minted.push({ parent, scopes }); p.n++;
      return { id: `id-${p.n}`, value: `child-${p.n}` };
    },
    async revoke(_parent, _c, id) { p.revoked.push(id); },
  };
  return Object.assign(p, { provider });
}

async function setup() {
  const db = memoryD1(), catalog = new Catalog(db, await masterKey(Buffer.alloc(32, 3).toString("base64")));
  const fake = fakeProvider();
  let clock = Date.parse("2026-10-20T12:00:00Z");
  const grants = new Grants(catalog, { cloudflare: fake.provider }, () => new Date(clock));
  await catalog.put("global", "AWS_REGION", "us-east-1");
  await catalog.put("dev", "CLOUDFLARE_API_TOKEN", PARENT, { kind: "mint:cloudflare", config: CONFIG });
  const dev = await catalog.createToken("dev", ["dev"]), other = await catalog.createToken("other", ["dev"]);
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

test("a write start scope is pending: no token until an admin approves", async () => {
  const s = await setup();
  await s.catalog.put("dev", "CLOUDFLARE_API_TOKEN", PARENT, { kind: "mint:cloudflare", config: { ...CONFIG, start: ["workers:write"] } });
  const r = await s.env();
  assert.equal(r.status, 409);
  assert.match((await r.json()).error, /needs approval for workers:write/);
  assert.equal(s.fake.minted.length, 0);
  assert.equal((await s.env()).status, 409); // still waiting, still nothing
  const [g] = await adminGrants(s);
  assert.equal(g.state, "pending");
  const ok = await s.call("POST", `/admin/api/grants/${g.id}/approve`, undefined, { requested: g.requested }, "vu@example.com");
  assert.equal((await ok.json()).grant.state, "active");
  assert.deepEqual(s.fake.minted[0].scopes, ["workers:write"]);
  assert.equal((await (await s.env()).json()).env.CLOUDFLARE_API_TOKEN, "child-1");
});

test("a denied grant yields nothing, and the next request starts a new pending grant", async () => {
  const s = await setup();
  await s.catalog.put("dev", "CLOUDFLARE_API_TOKEN", PARENT, { kind: "mint:cloudflare", config: { ...CONFIG, start: ["workers:write"] } });
  await s.env();
  const [g] = await adminGrants(s);
  await s.call("POST", `/admin/api/grants/${g.id}/deny`, undefined, {}, "vu@example.com");
  assert.equal((await adminGrants(s)).find((x: any) => x.id === g.id).state, "denied");
  assert.equal((await s.env()).status, 409);
  assert.equal(s.fake.minted.length, 0);
});

test("step-up: a write scope waits while the old child keeps working, then approval mints a wider one", async () => {
  const s = await setup();
  await s.env();
  const up = await (await s.call("POST", "/v1/step-up", s.dev, { keys: ["CLOUDFLARE_API_TOKEN", "AWS_REGION"], scopes: ["workers:write"] })).json();
  assert.equal(up.grants.length, 1);
  assert.deepEqual(up.grants[0].requested, ["workers:read", "workers:write"]);
  assert.equal(up.grants[0].state, "active");
  assert.equal((await (await s.env()).json()).env.CLOUDFLARE_API_TOKEN, "child-1"); // narrower child, unchanged
  await s.call("POST", `/admin/api/grants/${up.grants[0].id}/approve`, undefined, { requested: up.grants[0].requested }, "vu@example.com");
  assert.equal((await (await s.env()).json()).env.CLOUDFLARE_API_TOKEN, "child-2");
  assert.deepEqual(s.fake.minted[1].scopes, ["workers:read", "workers:write"]);
  assert.deepEqual(s.fake.revoked, ["id-1"]); // the narrower child is deleted at the provider
});

test("step-up deny keeps the narrower child; unknown scopes are refused", async () => {
  const s = await setup();
  await s.env();
  const up = await (await s.call("POST", "/v1/step-up", s.dev, { keys: ["CLOUDFLARE_API_TOKEN"], scopes: ["workers:write"] })).json();
  await s.call("POST", `/admin/api/grants/${up.grants[0].id}/deny`, undefined, {}, "vu@example.com");
  const [g] = await adminGrants(s);
  assert.equal(g.state, "active"); assert.equal(g.requested, null); assert.deepEqual(g.scopes, ["workers:read"]);
  assert.equal((await (await s.env()).json()).env.CLOUDFLARE_API_TOKEN, "child-1");
  assert.equal((await s.call("POST", "/v1/step-up", s.dev, { keys: ["CLOUDFLARE_API_TOKEN"], scopes: ["zones:write"] })).status, 400);
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

test("an approved write grant needs approval again once it expires", async () => {
  const s = await setup();
  await s.env();
  const up = await (await s.call("POST", "/v1/step-up", s.dev, { keys: ["CLOUDFLARE_API_TOKEN"], scopes: ["workers:write"] })).json();
  await s.call("POST", `/admin/api/grants/${up.grants[0].id}/approve`, undefined, { requested: up.grants[0].requested }, "vu@example.com");
  s.tick(40);
  await s.grants.sweep();
  assert.equal((await (await s.env()).json()).env.CLOUDFLARE_API_TOKEN, "child-3");
  assert.deepEqual(s.fake.minted.at(-1)!.scopes, ["workers:read"]); // back to the start scopes
});

test("revoking a grant deletes the child, and the next request waits for approval even for reads", async () => {
  const s = await setup();
  await s.env();
  const [g] = await adminGrants(s);
  assert.equal((await s.call("DELETE", `/admin/api/grants/${g.id}`, undefined, undefined, "vu@example.com")).status, 200);
  assert.deepEqual(s.fake.revoked, ["id-1"]);
  assert.equal((await s.env()).status, 409);
  assert.equal(s.fake.minted.length, 1);
  s.tick(25 * 60); // a day later reads are granted on request again
  await s.grants.sweep();
  assert.equal((await (await s.env()).json()).env.CLOUDFLARE_API_TOKEN, "child-2");
});

test("approve mints only what the admin saw; scopes added since then need a fresh look", async () => {
  const s = await setup();
  await s.catalog.put("dev", "CLOUDFLARE_API_TOKEN", PARENT, { kind: "mint:cloudflare", config: { ...CONFIG, scopes: { ...CONFIG.scopes, "dns:edit": [WRITE] } } });
  await s.env();
  const up = await (await s.call("POST", "/v1/step-up", s.dev, { keys: ["CLOUDFLARE_API_TOKEN"], scopes: ["workers:write"] })).json();
  const seen = up.grants[0].requested;
  await s.call("POST", "/v1/step-up", s.dev, { keys: ["CLOUDFLARE_API_TOKEN"], scopes: ["dns:edit"] });
  const r = await s.call("POST", `/admin/api/grants/${up.grants[0].id}/approve`, undefined, { requested: seen }, "vu@example.com");
  assert.equal(r.status, 409);
  assert.equal((await s.call("POST", `/admin/api/grants/${up.grants[0].id}/approve`, undefined, {}, "vu@example.com")).status, 409);
  assert.equal(s.fake.minted.length, 1);
});

test("a revoke while an approval is minting wins: the new child is deleted and nothing is handed out", async () => {
  const s = await setup();
  await s.env();
  const up = await (await s.call("POST", "/v1/step-up", s.dev, { keys: ["CLOUDFLARE_API_TOKEN"], scopes: ["workers:write"] })).json();
  const mint = s.fake.provider.mint;
  s.fake.provider.mint = async (...a: Parameters<typeof mint>) => {
    await s.call("DELETE", `/admin/api/grants/${up.grants[0].id}`, undefined, undefined, "vu@example.com"); // lands mid-mint
    return mint(...a);
  };
  const r = await s.call("POST", `/admin/api/grants/${up.grants[0].id}/approve`, undefined, { requested: up.grants[0].requested }, "vu@example.com");
  assert.equal(r.status, 409);
  assert.deepEqual(s.fake.revoked.sort(), ["id-1", "id-2"]);
  assert.equal((await adminGrants(s))[0].state, "revoked");
  assert.equal((await s.env()).status, 409); // revoked: the next request waits for approval
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

test("a revoke during a first mint sticks: the claim is not deleted, so the next read still waits", async () => {
  const s = await setup();
  const mint = s.fake.provider.mint;
  s.fake.provider.mint = async (...a: Parameters<typeof mint>) => {
    const [g] = await adminGrants(s);
    await s.call("DELETE", `/admin/api/grants/${g.id}`, undefined, undefined, "vu@example.com");
    return mint(...a);
  };
  assert.equal((await s.env()).status, 409);
  s.fake.provider.mint = mint;
  assert.deepEqual(s.fake.revoked, ["id-1"]); // the child minted after the revoke is deleted
  assert.equal((await s.env()).status, 409);  // and the revoke still blocks the next read
  assert.equal(s.fake.minted.length, 1);
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

test("a revoke can't be sidestepped through another pinned project, and unsorted start scopes can be approved", async () => {
  const s = await setup();
  await s.catalog.put("global", "CF_G", PARENT, { kind: "mint:cloudflare", config: { ...CONFIG, start: ["workers:write", "workers:read"] } });
  const both = await s.catalog.createToken("both", ["dev", "prod"]);
  await s.call("GET", "/v1/env?project=dev&keys=CF_G", both);
  const [g] = await adminGrants(s);
  assert.deepEqual(g.requested, ["workers:read", "workers:write"]);
  assert.equal((await s.call("POST", `/admin/api/grants/${g.id}/approve`, undefined, { requested: g.requested }, "vu@example.com")).status, 200);
  await s.call("DELETE", `/admin/api/grants/${g.id}`, undefined, undefined, "vu@example.com");
  await s.catalog.put("global", "CF_G", PARENT, { kind: "mint:cloudflare", config: CONFIG });
  assert.equal((await s.call("GET", "/v1/env?project=prod&keys=CF_G", both)).status, 409);
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

test("a deny racing a revoke can't overwrite it", async () => {
  const s = await setup();
  await s.catalog.put("dev", "CLOUDFLARE_API_TOKEN", PARENT, { kind: "mint:cloudflare", config: { ...CONFIG, start: ["workers:write"] } });
  await s.env();
  const [g] = await adminGrants(s);
  const get = s.grants.get.bind(s.grants);
  s.grants.get = async (id: string) => { s.grants.get = get; const r = await get(id); await s.grants.revoke(id, "vu@example.com"); return r; };
  assert.equal((await s.call("POST", `/admin/api/grants/${g.id}/deny`, undefined, {}, "vu@example.com")).status, 409);
  assert.equal((await adminGrants(s))[0].state, "revoked");
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
  assert.deepEqual(s.fake.revoked, ["id-1"]);
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

test("approving after a rotation ends the grant instead of minting under the new parent", async () => {
  const s = await setup();
  await s.env();
  const up = await (await s.call("POST", "/v1/step-up", s.dev, { keys: ["CLOUDFLARE_API_TOKEN"], scopes: ["workers:write"] })).json();
  await s.catalog.put("dev", "CLOUDFLARE_API_TOKEN", "parent-2");
  const r = await s.call("POST", `/admin/api/grants/${up.grants[0].id}/approve`, undefined, { requested: up.grants[0].requested }, "vu@example.com");
  assert.equal(r.status, 409);
  assert.equal(s.fake.minted.length, 1);
  assert.equal((await adminGrants(s))[0].state, "revoked");
});

test("a parent that can't be a header value is refused; fetch errors never quote it", async () => {
  const s = await setup();
  await assert.rejects(s.catalog.put("dev", "CF_BAD", "sec\nret", { kind: "mint:cloudflare", config: CONFIG }), /printable ASCII/);
  const cf = cloudflare((async () => { throw new TypeError(`invalid header value Bearer ${PARENT}`); }) as any);
  await assert.rejects(cf.mint(PARENT, CONFIG, ["workers:read"], new Date(), "x"), (e: any) => e.status === 502 && !e.message.includes(PARENT));
});

test("a deny landing while an approval mints wins: the wider child is deleted, the narrow one stays", async () => {
  const s = await setup();
  await s.env();
  const up = await (await s.call("POST", "/v1/step-up", s.dev, { keys: ["CLOUDFLARE_API_TOKEN"], scopes: ["workers:write"] })).json();
  const mint = s.fake.provider.mint;
  s.fake.provider.mint = async (...a: Parameters<typeof mint>) => {
    s.fake.provider.mint = mint;
    await s.call("POST", `/admin/api/grants/${up.grants[0].id}/deny`, undefined, {}, "vu@example.com");
    return mint(...a);
  };
  const r = await s.call("POST", `/admin/api/grants/${up.grants[0].id}/approve`, undefined, { requested: up.grants[0].requested }, "vu@example.com");
  assert.equal(r.status, 409);
  assert.deepEqual(s.fake.revoked, ["id-2"]);
  const [g] = await adminGrants(s);
  assert.deepEqual(g.scopes, ["workers:read"]);
  assert.equal((await (await s.env()).json()).env.CLOUDFLARE_API_TOKEN, "child-1");
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
    const r = await s.env();
    assert.equal(r.status, 500);
    assert.doesNotMatch(await r.text(), new RegExp(SENTINEL));
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
  assert.ok(logged.length >= 2);
  assert.doesNotMatch(logged.map(String).join(" "), new RegExp(SENTINEL));
  assert.ok(logged.includes("Error") && logged.includes("TypeError")); // the class is kept for debugging
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

test("an unanswered request lapses to denied, even if the caller keeps asking", async () => {
  const s = await setup();
  await s.catalog.put("dev", "CLOUDFLARE_API_TOKEN", PARENT, { kind: "mint:cloudflare", config: { ...CONFIG, start: ["workers:write"] } });
  await s.env();
  s.tick(20 * 60);
  await s.call("POST", "/v1/step-up", s.dev, { keys: ["CLOUDFLARE_API_TOKEN"], scopes: ["workers:write"] });
  s.tick(5 * 60);
  await s.grants.sweep();
  const [g] = await adminGrants(s);
  assert.equal(g.state, "denied"); assert.equal(g.decided_by, "timeout");
});

test("grants are per caller: one token's approval is not another's", async () => {
  const s = await setup();
  await s.env();
  const up = await (await s.call("POST", "/v1/step-up", s.dev, { keys: ["CLOUDFLARE_API_TOKEN"], scopes: ["workers:write"] })).json();
  await s.call("POST", `/admin/api/grants/${up.grants[0].id}/approve`, undefined, { requested: up.grants[0].requested }, "vu@example.com");
  await s.env(s.other);
  assert.deepEqual(s.fake.minted.at(-1)!.scopes, ["workers:read"]);
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

test("cli: run gets a read child; --scope for a write stops until approved, then runs with the wider child", async () => {
  assert.equal((await cli(["run", "--", ...printToken])).stdout, "child-1");
  const err = await cli(["run", "--scope", "workers:write", "--", ...printToken]).then(() => null, (e) => e);
  assert.ok(err, "the command must not start while approval is pending");
  assert.match(err.stderr, /needs approval for workers:read, workers:write in \/admin/);
  assert.equal(err.stdout, "");
  const [g] = await (await s.call("GET", "/admin/api/grants", undefined, undefined, "vu@example.com")).json().then((b) => b.grants);
  await s.call("POST", `/admin/api/grants/${g.id}/approve`, undefined, { requested: g.requested }, "vu@example.com");
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

// Key checks: a new value is tested against its service before it is saved, and a failure saves
// nothing. /v1/check and /v1/revs report on keys without ever returning a value.
import assert from "node:assert/strict";
import { test } from "node:test";
import { handle } from "../src/app.ts";
import { Catalog } from "../src/catalog.ts";
import { cloudflare, DEFAULT_SCOPES, OPTIONAL_DEFAULTS } from "../src/cloudflare.ts";
import { masterKey } from "../src/crypto.ts";
import { Grants } from "../src/grants.ts";
import { PRESETS, runCheck, staticCheck } from "../src/verify.ts";
import { memoryD1 } from "./d1.ts";

const ACCT = "a".repeat(32), READ = "1".repeat(32);
const CF = { account_id: ACCT, start: ["workers:read"], scopes: { "workers:read": [READ] } };
// The account's permission groups, as Cloudflare lists them: every default name, the Containers
// groups under each name, plus a zone group.
const GROUPS = [...[...Object.values(DEFAULT_SCOPES).flat(), ...Object.values(OPTIONAL_DEFAULTS).flat(2)].map((name, i) => ({ id: i.toString(16).padStart(32, "0"), name, scopes: ["com.cloudflare.api.account"] })),
  { id: "f".repeat(32), name: "DNS Read", scopes: ["com.cloudflare.api.account.zone"] }];

// A fake internet: `good-*` values pass, `bad-*` get a 401, `down-*` can't be reached.
function fakeNet() {
  const seen: { url: string; headers: Record<string, string> }[] = [];
  const fetcher = (async (url: string, init: RequestInit = {}) => {
    const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
    seen.push({ url, headers });
    const value = Object.values(headers).join(" ");
    if (/down-/.test(value)) throw new TypeError(`connect failed with ${value}`);
    if (/redir-/.test(value)) { assert.equal(init.redirect, "manual"); return new Response("", { status: 302, headers: { location: "http://evil.example/" } }); }
    const ok = /good-/.test(value);
    if (url.includes("/tokens/permission_groups")) {
      return new Response(JSON.stringify(ok ? { success: true, result: GROUPS } : { success: false, errors: [{ code: 9109 }] }), { status: ok ? 200 : 403 });
    }
    if (url.includes("/tokens/verify")) {
      return new Response(JSON.stringify(ok ? { success: true, result: { status: /disabled/.test(value) ? "disabled" : "active" } } : { success: false, errors: [{ code: 1000 }] }), { status: ok ? 200 : 401 });
    }
    return new Response(ok ? "{}" : "nope", { status: ok ? 200 : 401 });
  }) as unknown as typeof fetch;
  return { seen, fetcher };
}

async function setup() {
  const db = memoryD1(), catalog = new Catalog(db, await masterKey(Buffer.alloc(32, 5).toString("base64")));
  const net = fakeNet();
  const grants = new Grants(catalog, { cloudflare: cloudflare(net.fetcher) });
  const dev = await catalog.createToken("dev", ["dev"]);
  const deps = { catalog, grants, fetcher: net.fetcher, admin: async () => "vu@example.com" };
  const call = (method: string, path: string, body?: unknown, token?: string) => handle(new Request(`https://t.example${path}`, {
    method, body: body === undefined ? undefined : JSON.stringify(body),
    headers: token ? { authorization: `Bearer ${token}` } : { "x-tumbler-admin": "1" } }), deps);
  const save = (name: string, body: Record<string, unknown>) => call("PUT", `/admin/api/keys/global/${name}`, body);
  const read = async (name: string) => (await (await call("GET", `/v1/env?keys=${name}`, undefined, dev)).json()).env?.[name];
  return { db, catalog, net, dev, call, save, read };
}

test("a static key with a preset check is tested before saving; a rejected value saves nothing", async () => {
  const s = await setup();
  assert.equal((await s.save("OPENAI_API_KEY", { value: "good-1", config: { check: "openai" } })).status, 200);
  assert.deepEqual(s.net.seen[0], { url: PRESETS.openai.url, headers: { authorization: "Bearer good-1" } });
  const bad = await s.save("OPENAI_API_KEY", { value: "bad-2" });       // a rotation keeps the check
  assert.equal(bad.status, 400);
  const msg = (await bad.json()).error;
  assert.match(msg, /failed its check, rejected \(401\); nothing was saved and the old value stays/);
  assert.ok(!msg.includes("bad-2"));
  assert.equal(await s.read("OPENAI_API_KEY"), "good-1");
  const down = await s.save("OPENAI_API_KEY", { value: "down-3" });     // couldn't tell: still refused
  assert.equal(down.status, 502);
  assert.ok(!(await down.text()).includes("down-3"));
  assert.equal(await s.read("OPENAI_API_KEY"), "good-1");
  assert.equal((await s.save("OPENAI_API_KEY", { value: "good-4" })).status, 200);
  assert.equal(await s.read("OPENAI_API_KEY"), "good-4");
  const audit = JSON.stringify(s.db.raw.prepare("SELECT * FROM audit").all());
  assert.ok(!/bad-2|down-3/.test(audit));
});

test("a custom check sends the value only to an https endpoint, in the named header", async () => {
  const s = await setup();
  const check = { url: "https://api.example.com/v1/me", header: "x-api-key", prefix: "", headers: { "x-version": "2" } };
  assert.equal((await s.save("EXAMPLE_KEY", { value: "good-x", config: { check } })).status, 200);
  assert.deepEqual(s.net.seen[0], { url: check.url, headers: { "x-version": "2", "x-api-key": "good-x" } });
  for (const [config, why] of [
    [{ check: { ...check, url: "http://api.example.com/" } }, /https/], [{ check: { ...check, header: "bad header" } }, /header name/],
    [{ check: "nope" }, /unknown check nope/], [{ check: "openai", other: 1 }, /only "check"/],
  ] as const) {
    const r = await s.save("EXAMPLE_KEY", { value: "good-y", config });
    assert.equal(r.status, 400); assert.match((await r.json()).error, why);
  }
  assert.equal(await s.read("EXAMPLE_KEY"), "good-x");
  assert.throws(() => staticCheck({ check: { url: "https://x.example", header: "a", prefix: "\n" } }), /prefix/);
});

test("a key without a check saves unchecked; --watch's revisions say which keys were checked", async () => {
  const s = await setup();
  await s.save("PLAIN", { value: "anything" });
  await s.save("CHECKED", { value: "good-1", config: { check: "stripe" } });
  assert.equal(s.net.seen.length, 1);
  const r = await (await s.call("GET", "/v1/revs?keys=PLAIN,CHECKED", undefined, s.dev)).json();
  assert.equal(r.keys.PLAIN.checked, false); assert.equal(r.keys.CHECKED.checked, true);
  const rev = r.keys.CHECKED.rev;
  await s.save("CHECKED", { value: "good-2" });
  const after = await (await s.call("GET", "/v1/revs?keys=CHECKED", undefined, s.dev)).json();
  assert.notEqual(after.keys.CHECKED.rev, rev);
  assert.ok(!JSON.stringify(after).includes("good-"));
  // A value written around the admin check (straight to the catalog) is never marked checked.
  await s.catalog.put("global", "CHECKED", "good-3");
  assert.equal((await (await s.call("GET", "/v1/revs?keys=CHECKED", undefined, s.dev)).json()).keys.CHECKED.checked, false);
});

test("a mint parent is verified with Cloudflare before saving; a rejected or disabled parent saves nothing", async () => {
  const s = await setup();
  assert.equal((await s.save("CF_TOKEN", { value: "good-parent", kind: "mint:cloudflare", config: CF })).status, 200);
  assert.deepEqual(s.net.seen[0], { url: `https://api.cloudflare.com/client/v4/accounts/${ACCT}/tokens/verify`, headers: { authorization: "Bearer good-parent" } });
  const rev = (await s.catalog.keyRow("global", "CF_TOKEN"))!.rev;
  for (const value of ["bad-parent", "good-disabled-parent"]) {
    const r = await s.save("CF_TOKEN", { value });
    assert.equal(r.status, 400);
    assert.ok(!(await r.text()).includes(value));
  }
  assert.equal((await s.catalog.keyRow("global", "CF_TOKEN"))!.rev, rev); // the old parent stays
});

test("pasting only a Cloudflare parent fills the account from CLOUDFLARE_ACCOUNT_ID and marks the key as on the defaults", async () => {
  const s = await setup();
  const none = await s.save("CLOUDFLARE_API_TOKEN", { value: "good-parent", kind: "mint:cloudflare" });
  assert.equal(none.status, 400);
  assert.match((await none.json()).error, /save CLOUDFLARE_ACCOUNT_ID as a static key/);
  assert.equal(await s.catalog.keyRow("global", "CLOUDFLARE_API_TOKEN"), null);

  await s.save("CLOUDFLARE_ACCOUNT_ID", { value: ACCT });
  assert.equal((await s.save("CLOUDFLARE_API_TOKEN", { value: "good-parent", kind: "mint:cloudflare" })).status, 200);
  const cfg = JSON.parse((await s.catalog.keyRow("global", "CLOUDFLARE_API_TOKEN"))!.config);
  assert.equal(cfg.account_id, ACCT);
  assert.deepEqual(cfg.start, ["workers:read"]);
  assert.equal(cfg.defaults, true);
  assert.deepEqual(cfg.scopes, DEFAULT_SCOPES); // names: mint() looks them up again each time
  const lookup = s.net.seen.find((r) => r.url.endsWith("/tokens/permission_groups"))!;
  assert.deepEqual(lookup, { url: `https://api.cloudflare.com/client/v4/accounts/${ACCT}/tokens/permission_groups`, headers: { authorization: "Bearer good-parent", "content-type": "application/json" } });
});

test("a defaults key mints from DEFAULT_SCOPES as they are now, so workers:write carries Workers Containers Write", async () => {
  // Why: `wrangler deploy` of a Worker with a container pushes its image under /containers, a 403 without it.
  assert.deepEqual(OPTIONAL_DEFAULTS["workers:write"][0][0], "Workers Containers Write");
  const posted: any[] = [];
  let listed = GROUPS;
  const fetcher = (async (url: string, init: RequestInit = {}) => {
    if (url.endsWith("/tokens/permission_groups")) return new Response(JSON.stringify({ success: true, result: listed }));
    posted.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({ success: true, result: { id: "c1", value: "child" } }));
  }) as unknown as typeof fetch;
  const id = (name: string) => GROUPS.find((g) => g.name === name)!.id;
  // Stored ids from an older default set are ignored on a defaults key; a named config keeps its own.
  const stale = { "workers:read": [id("Workers Scripts Read")], "workers:write": [id("Workers Scripts Write")] };
  const cf = cloudflare(fetcher), at = new Date("2026-10-23T12:00:00Z");
  // Each optional group comes in under the first name the account lists.
  const firsts = (s: string) => OPTIONAL_DEFAULTS[s].map((names) => names[0]);
  const write = [...DEFAULT_SCOPES["workers:write"], ...firsts("workers:write")].map((n) => ({ id: id(n) }));
  await cf.mint("good-parent", { account_id: ACCT, defaults: true, scopes: stale }, ["workers:write"], at, "t");
  assert.deepEqual(posted[0].policies[0].permission_groups, write);
  await cf.mint("good-parent", { account_id: ACCT, scopes: stale }, ["workers:write"], at, "t");
  assert.deepEqual(posted[1].policies[0].permission_groups, [{ id: id("Workers Scripts Write") }]);
  // A key saved on the old defaults holds their ids and no marker: it follows the live defaults too.
  const old = (names: string[]) => names.map(id), legacy = { "workers:read": old(["Workers Scripts Read", "D1 Read", "Workers KV Storage Read", "Workers R2 Storage Read"]),
    "workers:write": old(["Workers R2 Storage Write", "Workers Scripts Write", "D1 Write", "Workers KV Storage Write"]) };
  await cf.mint("good-parent", { account_id: ACCT, scopes: legacy }, ["workers:write"], at, "t");
  assert.deepEqual(posted[2].policies[0].permission_groups, write);
  // The same scope names with other ids are a custom config: its ids are kept exactly.
  const custom = { ...legacy, "workers:write": legacy["workers:write"].slice(1).concat(id("Workers Scripts Read")) };
  await cf.mint("good-parent", { account_id: ACCT, scopes: custom }, ["workers:write"], at, "t");
  assert.deepEqual(posted[3].policies[0].permission_groups, custom["workers:write"].map((i) => ({ id: i })));
  // A rotation passes the stored config back in: it stays on the defaults. A named config gets ids and no marker.
  const kept = await cf.prepare!("good-parent", { account_id: ACCT, defaults: true, scopes: DEFAULT_SCOPES }, async () => undefined);
  assert.deepEqual([kept.defaults, kept.scopes], [true, DEFAULT_SCOPES]);
  const named = await cf.prepare!("good-parent", { account_id: ACCT, scopes: { "x:write": ["Containers Write"] } }, async () => undefined);
  assert.deepEqual([named.defaults, named.scopes], [undefined, { "x:write": [id("Containers Write")] }]);
  // An account that lists neither name still mints the rest: an optional group never blocks a mint.
  listed = GROUPS.filter((g) => g.name !== "Workers Containers Write");
  await cf.mint("good-parent", { account_id: ACCT, defaults: true, scopes: DEFAULT_SCOPES }, ["workers:write"], at, "t");
  assert.ok(posted.at(-1).policies[0].permission_groups.some((g: any) => g.id === id("Cloudchamber Write"))); // the next name listed
  // An older spelling counts too: "Queues Edit" where the account has no "Queues Write".
  listed = GROUPS.filter((g) => g.name !== "Queues Write");
  await cf.mint("good-parent", { account_id: ACCT, defaults: true, scopes: DEFAULT_SCOPES }, ["workers:write"], at, "t");
  assert.ok(posted.at(-1).policies[0].permission_groups.some((g: any) => g.id === id("Queues Edit")));
  // An account that lists none of the optional names still mints the required ones.
  const optional = new Set(Object.values(OPTIONAL_DEFAULTS).flat(2));
  listed = GROUPS.filter((g) => !optional.has(g.name));
  await cf.mint("good-parent", { account_id: ACCT, defaults: true, scopes: DEFAULT_SCOPES }, ["workers:read", "workers:write"], at, "t");
  assert.deepEqual(posted.at(-1).policies[0].permission_groups, Object.values(DEFAULT_SCOPES).flat().map((n) => ({ id: id(n) })));
  // workers:read, which every token gets, carries reads only.
  assert.ok(OPTIONAL_DEFAULTS["workers:read"].flat().every((n) => / read$/i.test(n)));
  assert.ok(!Object.values(OPTIONAL_DEFAULTS).flat(2).some((n) => /secrets store/i.test(n)));
});

test("permission names Cloudflare doesn't list, or zone ones, are refused; so is a parent it won't list them for", async () => {
  const s = await setup();
  const save = (value: string, scopes: Record<string, string[]>) =>
    s.save("CLOUDFLARE_API_TOKEN", { value, kind: "mint:cloudflare", config: { account_id: ACCT, start: [], scopes } });
  const bad = await save("good-parent", { "dns:read": ["DNS Read"], "x:write": ["Workers Scripts Write", "Nope Write"] });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error, 'Cloudflare has no account permission named "DNS Read", "Nope Write"; `tumbler scope groups KEY` lists them');
  const refused = await save("bad-parent", { "workers:read": ["Workers Scripts Read"] });
  assert.equal(refused.status, 400);
  const msg = (await refused.json()).error;
  assert.match(msg, /Cloudflare refused this token \(403\)/);
  assert.ok(!msg.includes("bad-parent"));
  assert.equal(await s.catalog.keyRow("global", "CLOUDFLARE_API_TOKEN"), null);
});

test("a user-owned Cloudflare token is refused as a parent with a message that says so", async () => {
  const seen: string[] = [];
  const fetcher = (async (url: string) => {
    seen.push(url);
    return url.includes("/user/tokens/verify")
      ? new Response(JSON.stringify({ success: true, result: { status: "active" } }))
      : new Response(JSON.stringify({ success: false, errors: [{ code: 1000 }] }), { status: 401 });
  }) as unknown as typeof fetch;
  const o = await cloudflare(fetcher).verify!("user-token", CF);
  assert.deepEqual(o, { status: "invalid", detail: "this is a user token; create an account-owned one under Manage Account > Account API Tokens" });
  assert.equal(seen.length, 2);
});

test("/v1/check reports each key's check on its current value, never the value", async () => {
  const s = await setup();
  await s.save("GOOD", { value: "good-1", config: { check: "github" } });
  await s.save("PLAIN", { value: "x" });
  await s.save("CF_TOKEN", { value: "good-parent", kind: "mint:cloudflare", config: CF });
  await s.catalog.put("global", "GOOD", "bad-revoked-upstream"); // went bad after it was saved
  const r = await s.call("POST", "/v1/check", { keys: ["GOOD", "PLAIN", "CF_TOKEN"] }, s.dev);
  const text = await r.text();
  assert.deepEqual(JSON.parse(text).checks, {
    GOOD: { status: "invalid", detail: "rejected (401)" }, PLAIN: { status: "none" }, CF_TOKEN: { status: "ok", of: "parent" },
  });
  assert.ok(!/bad-revoked|good-parent/.test(text));
  assert.equal((await s.call("POST", "/v1/check", { keys: ["NOPE"] }, s.dev)).status, 404);
  assert.equal((await s.call("POST", "/v1/check", { keys: ["GOOD"] })).status, 401);
});

test("when a check can't run, the admin may save unchecked; a rejected value never saves, and redirects aren't followed", async () => {
  const s = await setup();
  await s.save("OPENAI_API_KEY", { value: "good-1", config: { check: "openai" } });
  const down = await s.save("OPENAI_API_KEY", { value: "down-2" });
  assert.equal((await down.json()).can_skip, true);
  assert.equal((await s.save("OPENAI_API_KEY", { value: "down-2", skip_check: true })).status, 200);
  assert.equal(await s.read("OPENAI_API_KEY"), "down-2");
  const revs = await (await s.call("GET", "/v1/revs?keys=OPENAI_API_KEY", undefined, s.dev)).json();
  assert.equal(revs.keys.OPENAI_API_KEY.checked, false); // so --watch never pushes it
  assert.ok(JSON.stringify(s.db.raw.prepare("SELECT action FROM audit").all()).includes("put-unchecked"));
  const bad = await s.save("OPENAI_API_KEY", { value: "bad-3", skip_check: true });
  assert.equal(bad.status, 400); assert.equal((await bad.json()).can_skip, undefined);
  assert.equal(await s.read("OPENAI_API_KEY"), "down-2");
  assert.deepEqual(await runCheck(PRESETS.openai, "redir-4", s.net.fetcher), { status: "error", detail: "could not check (redirected, 302)" });
  // A 403 is a key scoped away from the check endpoint, not a bad key: inconclusive, so it can be saved.
  const scoped = (async () => new Response("", { status: 403 })) as unknown as typeof fetch;
  assert.equal((await runCheck(PRESETS.stripe, "rk-scoped", scoped)).status, "error");
});

test("cloudflare: an operator can't add token, member or billing groups, nor writes to a read scope; added names resolve at mint", async () => {
  const posted: any[] = [];
  const fetcher = (async (url: string, init: RequestInit = {}) => {
    if (url.endsWith("/tokens/permission_groups")) return new Response(JSON.stringify({ success: true, result: [...GROUPS, { id: "e".repeat(32), name: "Account API Tokens Write", scopes: ["com.cloudflare.api.account"] }] }));
    posted.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({ success: true, result: { id: "c1", value: "child" } }));
  }) as unknown as typeof fetch;
  const cf = cloudflare(fetcher), cfg = { account_id: ACCT, scopes: { "workers:read": [READ], "workers:write": [READ] } };
  await assert.rejects(cf.groups!("good-parent", cfg, ["account api tokens write"]), (e: any) => e.status === 403);
  await assert.rejects(cf.groups!("good-parent", cfg, ["Nope Write"]), /no account permission named "Nope Write"/);
  assert.deepEqual(await cf.groups!("good-parent", cfg, ["containers write"]), ["Containers Write"]);
  assert.throws(() => cf.validate({ ...cfg, extra: { "workers:read": ["Containers Write"] } }), /isn't a read/);
  assert.throws(() => cf.validate({ ...cfg, extra: { "x:write": ["Billing Write"] } }), /can't be added from the CLI/);
  cf.validate({ ...cfg, extra: { "workers:read": ["Containers Read"], "pages:write": ["Containers Write"] } });
  const id = (name: string) => GROUPS.find((g) => g.name === name)!.id;
  await cf.mint("good-parent", { ...cfg, extra: { "workers:write": ["Containers Write"] } }, ["workers:write"], new Date("2026-10-23T12:00:00Z"), "t");
  assert.deepEqual(posted[0].policies[0].permission_groups, [{ id: READ }, { id: id("Containers Write") }]);
});

test("cloudflare: an unknown permission name is refused with the listed names it is near, and every group can be listed", async () => {
  const fetcher = (async () => new Response(JSON.stringify({ success: true, result: GROUPS }))) as unknown as typeof fetch;
  const cf = cloudflare(fetcher), cfg = { account_id: ACCT, scopes: { "workers:read": [READ] } };
  // Why: #36 copied "Containers Read" from the docs, which the account didn't list; the refusal names the real one.
  await assert.rejects(cf.prepare!("good-parent", { account_id: ACCT, scopes: { "x:read": ["Containers Reed"] } }, async () => undefined),
    /no account permission named "Containers Reed" \(for "Containers Reed" it lists "Containers Read", "Containers Write", "Workers Containers Read"\); `tumbler scope groups KEY` lists them/);
  await assert.rejects(cf.groups!("good-parent", cfg, ["Nope Write"]), (e: any) => !/it lists/.test(e.message));
  const all = await cf.listGroups!("good-parent", cfg);
  assert.equal(all.length, GROUPS.length);
  assert.deepEqual(all.map((g) => g.name), [...all.map((g) => g.name)].sort((a, b) => a.localeCompare(b)));
  assert.deepEqual(all.find((g) => g.name === "DNS Read"), { name: "DNS Read", scopes: ["com.cloudflare.api.account.zone"], delegable: false });
  assert.equal(all.find((g) => g.name === "Workers Containers Write")!.delegable, true);
  assert.ok(!JSON.stringify(all).includes("0".repeat(32)), "ids stay inside the broker");
});

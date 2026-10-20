// Key checks: a new value is tested against its service before it is saved, and a failure saves
// nothing. /v1/check and /v1/revs report on keys without ever returning a value.
import assert from "node:assert/strict";
import { test } from "node:test";
import { handle } from "../src/app.ts";
import { Catalog } from "../src/catalog.ts";
import { cloudflare } from "../src/cloudflare.ts";
import { masterKey } from "../src/crypto.ts";
import { Grants } from "../src/grants.ts";
import { PRESETS, runCheck, staticCheck } from "../src/verify.ts";
import { memoryD1 } from "./d1.ts";

const ACCT = "a".repeat(32), READ = "1".repeat(32);
const CF = { account_id: ACCT, start: ["workers:read"], scopes: { "workers:read": [READ] } };

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
});

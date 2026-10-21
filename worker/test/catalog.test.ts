import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { handle } from "../src/app.ts";
import { Catalog } from "../src/catalog.ts";
import { masterKey, open, seal } from "../src/crypto.ts";
import { memoryD1 } from "./d1.ts";

const KEY = Buffer.alloc(32, 7).toString("base64");

async function setup() {
  const db = memoryD1(), catalog = new Catalog(db, await masterKey(KEY));
  await catalog.put("global", "OPENROUTER_API_KEY", "global-or");
  await catalog.put("global", "AWS_REGION", "us-east-1");
  await catalog.put("dev", "OPENROUTER_API_KEY", "dev-or");
  await catalog.put("kypp", "OPENROUTER_API_KEY", "kypp-or");
  const tokens = {
    global: await catalog.createToken("global-only", null),
    dev: await catalog.createToken("dev", ["dev"]),
    both: await catalog.createToken("both", ["dev", "kypp"]),
  };
  const deps = { catalog, admin: async (r: Request) => r.headers.get("x-test-admin") };
  const get = (path: string, token?: string) => handle(new Request(`https://t.example${path}`,
    { headers: token ? { authorization: `Bearer ${token}` } : {} }), deps);
  return { db, catalog, tokens, deps, get };
}

test("seal binds a value to its scope and name", async () => {
  const k = await masterKey(KEY), s = await seal(k, "global", "A", "secret");
  assert.equal(await open(k, "global", "A", s.iv, s.ciphertext), "secret");
  await assert.rejects(open(k, "dev", "A", s.iv, s.ciphertext));
  await assert.rejects(open(k, "global", "B", s.iv, s.ciphertext));
});

test("an unpinned token reads global keys only", async () => {
  const { get, tokens } = await setup();
  const r = await get("/v1/env", tokens.global);
  assert.deepEqual((await r.json()).env, { OPENROUTER_API_KEY: "global-or", AWS_REGION: "us-east-1" });
  assert.equal((await get("/v1/env?project=dev", tokens.global)).status, 403);
});

test("a project row overrides the global row; other keys fall through", async () => {
  const { get, tokens } = await setup();
  assert.deepEqual((await (await get("/v1/env", tokens.dev)).json()).env, { OPENROUTER_API_KEY: "dev-or", AWS_REGION: "us-east-1" });
  assert.deepEqual((await (await get("/v1/env?keys=OPENROUTER_API_KEY", tokens.dev)).json()).env, { OPENROUTER_API_KEY: "dev-or" });
});

test("a pinned token can't read outside its pin", async () => {
  const { get, tokens } = await setup();
  const r = await get("/v1/env?project=kypp", tokens.dev);
  assert.equal(r.status, 403);
  assert.doesNotMatch(await r.text(), /kypp-or/);
});

test("a token pinned to several projects must name one, and gets that one", async () => {
  const { get, tokens } = await setup();
  assert.equal((await get("/v1/env", tokens.both)).status, 400);
  assert.equal((await (await get("/v1/env?project=kypp", tokens.both)).json()).env.OPENROUTER_API_KEY, "kypp-or");
});

test("unknown keys, bad tokens and revoked tokens are refused", async () => {
  const { get, tokens, catalog } = await setup();
  assert.equal((await get("/v1/env?keys=NOPE", tokens.global)).status, 404);
  assert.equal((await get("/v1/env")).status, 401);
  assert.equal((await get("/v1/env", "tmb_wrong")).status, 401);
  await catalog.revokeToken("dev");
  assert.equal((await get("/v1/env", tokens.dev)).status, 401);
});

test("a ciphertext copied onto another project's row does not decrypt", async () => {
  const { db, get, tokens } = await setup();
  db.raw.exec("UPDATE keys SET iv = (SELECT iv FROM keys WHERE scope='kypp'), ciphertext = (SELECT ciphertext FROM keys WHERE scope='kypp') WHERE scope='dev'");
  const r = await get("/v1/env", tokens.dev);
  assert.equal(r.status, 500);
  assert.doesNotMatch(await r.text(), /kypp-or/);
});

test("reads are audited by name, never by value", async () => {
  const { db, get, tokens } = await setup();
  await get("/v1/env", tokens.dev);
  const rows = db.raw.prepare("SELECT * FROM audit").all() as any[];
  assert.deepEqual(rows.map((r) => [r.actor, r.action, r.project, r.names]), [["dev", "read", "dev", "AWS_REGION,OPENROUTER_API_KEY"]]);
  assert.doesNotMatch(JSON.stringify(rows), /dev-or|us-east-1/);
});

test("tokens are stored as hashes", async () => {
  const { db, tokens } = await setup();
  assert.doesNotMatch(JSON.stringify(db.raw.prepare("SELECT * FROM tokens").all()), new RegExp(tokens.dev));
});

const admin = (deps: any, path: string, init: RequestInit & { as?: string } = {}) =>
  handle(new Request(`https://t.example/admin/api/${path}`, { ...init,
    headers: { ...(init.as ? { "x-test-admin": init.as } : {}), "x-tumbler-admin": "1", "content-type": "application/json", ...(init.headers as any) } }), deps);

test("admin needs Access, and writes need the custom header", async () => {
  const { deps } = await setup();
  assert.equal((await admin(deps, "keys")).status, 403);
  const noHeader = await handle(new Request("https://t.example/admin/api/keys/global/X", { method: "PUT", body: '{"value":"v"}',
    headers: { "x-test-admin": "vu@example.com" } }), deps);
  assert.equal(noHeader.status, 400);
});

test("admin can set, list and rotate keys, but never read a value back", async () => {
  const { deps, get, tokens } = await setup();
  const put = await admin(deps, "keys/global/PYTH_API_KEY", { method: "PUT", as: "vu@example.com", body: JSON.stringify({ value: "p1", description: "pyth" }) });
  assert.equal(put.status, 200);
  await admin(deps, "keys/global/PYTH_API_KEY", { method: "PUT", as: "vu@example.com", body: JSON.stringify({ value: "p2" }) });
  const list = await (await admin(deps, "keys", { as: "vu@example.com" })).text();
  assert.doesNotMatch(list, /p1|p2|global-or|dev-or/);
  assert.match(list, /"description":"pyth"/); // a rotation without a description keeps the old one
  assert.equal((await (await get("/v1/env?keys=PYTH_API_KEY", tokens.global)).json()).env.PYTH_API_KEY, "p2");
});

test("admin creates a pinned token that works immediately", async () => {
  const { deps, get } = await setup();
  const r = await (await admin(deps, "tokens", { method: "POST", as: "vu@example.com", body: JSON.stringify({ name: "pillbox", projects: ["kypp"] }) })).json();
  assert.match(r.token, /^tmb_/);
  assert.equal((await (await get("/v1/env", r.token)).json()).env.OPENROUTER_API_KEY, "kypp-or");
  assert.equal((await admin(deps, "tokens", { method: "POST", as: "vu@example.com", body: JSON.stringify({ name: "x", projects: ["global"] }) })).status, 400);
});

test("the setup script is served with this broker's URL as its default", async () => {
  const { catalog } = await setup();
  const script = readFileSync(new URL("../../scripts/setup.sh", import.meta.url), "utf8");
  const r = await handle(new Request("https://t.example/setup"), { catalog, admin: async () => null, setup: script });
  const lines = (await r.text()).split("\n");
  assert.equal(lines[0], "#!/bin/bash");
  assert.equal(lines[1], 'TUMBLER_URL="${TUMBLER_URL:-https://t.example}"');
});

test("the CLI is served without a token, and nothing else is", async () => {
  const { catalog } = await setup();
  const deps = { catalog, admin: async () => null, cli: "#!/usr/bin/env node\n" };
  assert.equal(await (await handle(new Request("https://t.example/cli"), deps)).text(), "#!/usr/bin/env node\n");
  assert.equal((await handle(new Request("https://t.example/v1/whoami"), deps)).status, 401);
});

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

test("a token pinned to several projects reads globals until it names one, then gets that one", async () => {
  const { get, tokens } = await setup();
  assert.deepEqual((await (await get("/v1/env", tokens.both)).json()).env, { OPENROUTER_API_KEY: "global-or", AWS_REGION: "us-east-1" });
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

test("admin edits a live token's pin in place: it reaches the new project at once, and nothing else", async () => {
  const { deps, get, tokens } = await setup();
  const pin = (name: string, projects: unknown) =>
    admin(deps, `tokens/${name}`, { method: "PATCH", as: "vu@example.com", body: JSON.stringify({ projects }) });
  assert.equal((await get("/v1/env?project=dev", tokens.global)).status, 403);
  assert.equal((await pin("global-only", ["dev", "kypp"])).status, 200);
  // The same token, no new secret: globals by default, a pinned project when named, nothing beyond.
  assert.equal((await (await get("/v1/env", tokens.global)).json()).env.OPENROUTER_API_KEY, "global-or");
  assert.equal((await (await get("/v1/env?project=dev", tokens.global)).json()).env.OPENROUTER_API_KEY, "dev-or");
  assert.equal((await get("/v1/env?project=other", tokens.global)).status, 403);
  // Narrowed back to global only, the project is refused again.
  assert.equal((await pin("global-only", [])).status, 200);
  assert.equal((await get("/v1/env?project=dev", tokens.global)).status, 403);
  assert.equal((await pin("global-only", ["global"])).status, 400);
  assert.equal((await pin("nobody", ["dev"])).status, 404);
  const audit = await (await admin(deps, "audit", { as: "vu@example.com" })).text();
  assert.match(audit, /token-pin/);
});

test("a deployment reads its own keys, then its project's, then global ones", async () => {
  const { catalog, get } = await setup();
  await catalog.put("huddles", "OPENROUTER_API_KEY", "huddles-or");
  await catalog.put("huddles", "DATABASE_URL", "huddles-db");
  await catalog.put("huddles/prod", "DATABASE_URL", "prod-db");
  const prod = await catalog.createToken("huddles-prod", ["huddles/prod"]), base = await catalog.createToken("huddles", ["huddles"]);
  assert.deepEqual((await (await get("/v1/env", prod)).json()).env,
    { OPENROUTER_API_KEY: "huddles-or", AWS_REGION: "us-east-1", DATABASE_URL: "prod-db" });
  assert.deepEqual((await (await get("/v1/keys", prod)).json()).keys, ["AWS_REGION", "DATABASE_URL", "OPENROUTER_API_KEY"]);
  assert.deepEqual((await (await get("/v1/revs?keys=DATABASE_URL", prod)).json()).project, "huddles/prod");
  // A pin names exactly what it reads: the project's pin doesn't reach prod, nor prod's the bare project.
  assert.equal((await (await get("/v1/env", base)).json()).env.DATABASE_URL, "huddles-db");
  assert.equal((await get("/v1/env?project=huddles/prod", base)).status, 403);
  assert.equal((await get("/v1/env?project=huddles", prod)).status, 403);
  await assert.rejects(catalog.put("huddles/prod/eu", "A", "x"), /invalid scope/);
});

test("admin moves a scope's keys and pins, so huddles-dev becomes huddles/dev without re-entering values", async () => {
  const { catalog, deps, get } = await setup();
  await catalog.put("huddles-dev", "DATABASE_URL", "dev-db", { description: "neon" });
  await catalog.put("huddles", "OPENROUTER_API_KEY", "huddles-or");
  const t = await catalog.createToken("huddles-dev", ["huddles-dev", "kypp"]);
  const move = (body: unknown) => admin(deps, "scopes/move", { method: "POST", as: "vu@example.com", body: JSON.stringify(body) });
  // Before: a flat project, still working as one.
  assert.equal((await (await get("/v1/env?project=huddles-dev", t)).json()).env.DATABASE_URL, "dev-db");
  const r = await move({ from: "huddles-dev", to: "huddles/dev" });
  assert.deepEqual(await r.json(), { from: "huddles-dev", to: "huddles/dev", moved: ["DATABASE_URL"], repinned: ["huddles-dev"] });
  assert.deepEqual((await (await get("/v1/env?project=huddles/dev", t)).json()).env,
    { OPENROUTER_API_KEY: "huddles-or", AWS_REGION: "us-east-1", DATABASE_URL: "dev-db" });
  assert.equal((await get("/v1/env?project=huddles-dev", t)).status, 403);
  assert.equal((await get("/v1/env?project=kypp", t)).status, 200);
  assert.match(await (await admin(deps, "keys", { as: "vu@example.com" })).text(), /"scope":"huddles\/dev","name":"DATABASE_URL","kind":"static","config":"\{\}","description":"neon"/);
  // A clash moves nothing; global can't move.
  await catalog.put("a", "DATABASE_URL", "a-db");
  await catalog.put("b", "DATABASE_URL", "b-db");
  assert.equal((await move({ from: "a", to: "b" })).status, 409);
  assert.equal(await catalog.value((await catalog.keyRow("a", "DATABASE_URL"))!), "a-db");
  assert.equal((await move({ from: "global", to: "x" })).status, 400);
  assert.match(await (await admin(deps, "audit", { as: "vu@example.com" })).text(), /scope-move/);
});

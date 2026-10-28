// The GitHub App provider: key handling, the App JWT, installation tokens, and a save-to-mint run.
import assert from "node:assert/strict";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import { handle } from "../src/app.ts";
import { Catalog } from "../src/catalog.ts";
import { masterKey } from "../src/crypto.ts";
import { canonicalKey, github } from "../src/github.ts";
import { Grants } from "../src/grants.ts";
import { memoryD1 } from "./d1.ts";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PKCS1 = privateKey.export({ type: "pkcs1", format: "pem" }) as string;
const PKCS8 = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
const PARENT = canonicalKey(PKCS1);
const CHILD = "ghs_fake-installation-token";
const CONFIG = { app_id: "123456", installation_id: 77, ttl_minutes: 60, start: ["repo:read"], scopes: { "repo:read": ["contents:read", "metadata:read"], "repo:write": ["contents:write", "pull_requests:write"] } };

// A GitHub API stand-in: one installation with `perms`; records each call and checks the JWT it carries.
function fakeGitHub(perms: Record<string, string> = { contents: "read", metadata: "read", pull_requests: "read", issues: "write" }) {
  const calls: { method: string; path: string; body: any; iss: string }[] = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    const jwt = String((init.headers as any).authorization).replace(/^Bearer /, ""), [h, p, sig] = jwt.split(".");
    const ok = createVerify("RSA-SHA256").update(`${h}.${p}`).verify(publicKey, Buffer.from(sig, "base64url"));
    if (!ok) return new Response("{}", { status: 401 });
    const path = new URL(url).pathname + new URL(url).search, body = init.body ? JSON.parse(String(init.body)) : null;
    calls.push({ method: init.method ?? "GET", path, body, iss: JSON.parse(Buffer.from(p, "base64url").toString()).iss });
    if (path.startsWith("/app/installations?")) {
      // 150 installations: vu1n is on the second page.
      const all = [...Array.from({ length: 149 }, (_, i) => ({ id: 1000 + i, account: { login: `other${i}` } })), { id: 77, account: { login: "vu1n" } }];
      const page = Number(new URL(url).searchParams.get("page") ?? 1);
      return Response.json(all.slice((page - 1) * 100, page * 100));
    }
    if (path === "/app/installations/77") return Response.json({ id: 77, permissions: perms });
    if (path === "/app/installations/77/access_tokens") {
      if (Object.entries(body.permissions).some(([k]) => !(k in perms))) return new Response('{"message":"bad"}', { status: 422 });
      return Response.json({ token: CHILD, expires_at: "2026-10-28T09:00:00Z" }, { status: 201 });
    }
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
  return { calls, fetcher };
}

test("github key: a PKCS#1 or PKCS#8 PEM is stored as one printable line, the same either way", () => {
  assert.equal(canonicalKey(PKCS8), PARENT);
  assert.equal(canonicalKey(PARENT), PARENT);
  assert.match(PARENT, /^[A-Za-z0-9+/=]+$/);
  assert.throws(() => canonicalKey("-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----"), /RSA PRIVATE KEY/);
  assert.throws(() => canonicalKey("not a key at all"), (e: Error) => /GitHub App key/.test(e.message) && !e.message.includes("not a key"));
});

test("github provider: prepare finds the installation and takes the read defaults", async () => {
  const gh = fakeGitHub(), p = github(gh.fetcher);
  const c = await p.prepare!(PARENT, { owner: "vu1n" }, async (n) => n === "GITHUB_APP_ID" ? "123456" : undefined);
  assert.deepEqual(c, { owner: "vu1n", app_id: "123456", installation_id: 77, ttl_minutes: 60, defaults: true, start: ["repo:read"], scopes: { "repo:read": ["contents:read", "metadata:read"] } });
  assert.equal(gh.calls[0].iss, "123456");
  p.validate(c);
  await assert.rejects(p.prepare!(PARENT, {}, async () => "123456"), /several installations/);
  await assert.rejects(p.prepare!(PARENT, { owner: "someone-else" }, async () => "123456"), /no installation of the App for someone-else \(it is installed on: other0, .*vu1n\)/);
  // An App installed without contents can't hold the defaults, so the save fails loud.
  await assert.rejects(github(fakeGitHub({ metadata: "read" }).fetcher).prepare!(PARENT, { installation_id: 77 }, async () => "123456"), /lacks contents:read/);
});

test("github provider: mints an installation token with the scope's permissions and repos", async () => {
  const gh = fakeGitHub(), p = github(gh.fetcher);
  const m = await p.mint(PARENT, { ...CONFIG, repositories: ["pillbox"] }, ["repo:read", "repo:write"], new Date(), "tumbler g_1 dev");
  assert.equal(m.value, CHILD);
  assert.match(m.id, /^gh-[0-9a-f-]{36}$/);
  assert.deepEqual(gh.calls[0], { method: "POST", path: "/app/installations/77/access_tokens", iss: "123456",
    body: { permissions: { contents: "write", metadata: "read", pull_requests: "write" }, repositories: ["pillbox"] } });
});

test("github provider: the read defaults add only the optional reads the installation has", async () => {
  const gh = fakeGitHub(), p = github(gh.fetcher);
  await p.mint(PARENT, { ...CONFIG, defaults: true, scopes: { "repo:read": ["contents:read", "metadata:read"] } }, ["repo:read"], new Date(), "x");
  // issues is installed at write, so its read is added; actions, checks and statuses aren't installed.
  assert.deepEqual(gh.calls.at(-1)!.body.permissions, { contents: "read", metadata: "read", pull_requests: "read", issues: "read" });
});

test("github provider: errors carry a status only, never the key or GitHub's text", async () => {
  const p = github((async () => new Response('{"message":"secret detail"}', { status: 500 })) as any);
  await assert.rejects(p.mint(PARENT, CONFIG, ["repo:read"], new Date(), "x"), (e: any) => e.status === 502 && /: 500$/.test(e.message) && !e.message.includes("secret detail"));
  const t = github((async () => { throw new TypeError(`bad header Bearer ${PARENT}`); }) as any);
  await assert.rejects(t.mint(PARENT, CONFIG, ["repo:read"], new Date(), "x"), (e: any) => !e.message.includes(PARENT));
  // A permission the App lacks is a 422 at GitHub, refused with where to look.
  await assert.rejects(github(fakeGitHub({ metadata: "read" }).fetcher).mint(PARENT, CONFIG, ["repo:read"], new Date(), "x"), /422.*tumbler scope groups/);
});

test("github provider: validate keeps reads on :read scopes, an hour's TTL and real repo names", () => {
  const p = github(fakeGitHub().fetcher);
  p.validate(CONFIG);
  assert.throws(() => p.validate({ ...CONFIG, scopes: { "repo:read": ["contents:write"] } }), /isn't a read/);
  assert.throws(() => p.validate({ ...CONFIG, scopes: { "repo:write": ["contents"] } }), /name:read or name:write/);
  assert.throws(() => p.validate({ ...CONFIG, ttl_minutes: 120 }), /at most 60/);
  assert.throws(() => p.validate({ ...CONFIG, repositories: ["vu1n/pillbox"] }), /repository names/);
  assert.throws(() => p.validate({ ...CONFIG, installation_id: "x" }), /installation_id/);
  for (const g of ["secrets:write", "variables:write", "variables:read", "actions_variables:write", "organization_secrets:read", "workflows:write", "secret_scanning_alerts:read", "administration:read"]) {
    assert.throws(() => p.validate({ ...CONFIG, extra: { "repo:write": [g] } }), /can't be added from the CLI/, g);
  }
});

test("github provider: an operator adds only permissions the installation has and may delegate", async () => {
  const p = github(fakeGitHub({ metadata: "read", contents: "write", administration: "write" }).fetcher);
  assert.deepEqual(await p.groups!(PARENT, CONFIG, ["Contents:Write"]), ["contents:write"]);
  await assert.rejects(p.groups!(PARENT, CONFIG, ["administration:read"]), (e: any) => e.status === 403);
  await assert.rejects(p.groups!(PARENT, CONFIG, ["variables:write"]), (e: any) => e.status === 403);
  await assert.rejects(p.groups!(PARENT, CONFIG, ["issues:read"]), /lacks issues:read/);
  const listed = await p.listGroups!(PARENT, CONFIG);
  assert.deepEqual(listed.map((g) => `${g.name}${g.delegable ? "" : "!"}`), ["administration:read!", "administration:write!", "contents:read", "contents:write", "metadata:read"]);
});

test("github key end to end: an admin saves the PEM, a caller's run gets an installation token, never the key", async () => {
  const gh = fakeGitHub(), db = memoryD1(), catalog = new Catalog(db, await masterKey(Buffer.alloc(32, 5).toString("base64")));
  const grants = new Grants(catalog, { github: github(gh.fetcher) });
  const deps = { catalog, grants, admin: async (r: Request) => r.headers.get("x-test-admin") };
  const call = (method: string, path: string, token?: string, body?: unknown, admin = false) => handle(new Request(`https://t.example${path}`, {
    method, body: body === undefined ? undefined : JSON.stringify(body),
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(admin ? { "x-test-admin": "vu@example.com", "x-tumbler-admin": "1" } : {}) },
  }), deps);
  await catalog.put("global", "GITHUB_APP_ID", "123456");
  const saved = await call("PUT", "/admin/api/keys/global/GH_TOKEN", undefined, { value: PKCS1, kind: "mint:github", config: { owner: "vu1n" } }, true);
  assert.equal(saved.status, 200, await saved.text());
  const row = (await catalog.keyRow("global", "GH_TOKEN"))!;
  assert.equal(row.kind, "mint:github");
  assert.equal(JSON.parse(row.config).installation_id, 77);
  const dev = await catalog.createToken("dev", ["dev"]);
  const r = await call("GET", "/v1/env?project=dev&keys=GH_TOKEN", dev);
  assert.deepEqual((await r.json()).env, { GH_TOKEN: CHILD });
  const texts = await Promise.all(["/admin/api/keys", "/admin/api/grants", "/admin/api/audit"].map(async (p) => (await call("GET", p, undefined, undefined, true)).text()));
  for (const t of texts) { assert.ok(!t.includes(PARENT) && !t.includes(CHILD) && !t.includes("PRIVATE KEY")); }
});

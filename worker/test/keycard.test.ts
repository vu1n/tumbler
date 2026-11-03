// The Keycard provider: discovery, client credentials for one Resource, revocation, and a save-to-mint run.
import assert from "node:assert/strict";
import { test } from "node:test";
import { handle } from "../src/app.ts";
import { Catalog } from "../src/catalog.ts";
import { masterKey } from "../src/crypto.ts";
import { Grants } from "../src/grants.ts";
import { keycard } from "../src/keycard.ts";
import { memoryD1 } from "./d1.ts";

const ZONE = "https://zone123.keycard.cloud";
const SECRET = "kc_fake-client-secret";
const RESOURCE = "https://api.github.com";
const CONFIG = { zone_url: ZONE, client_id: "app-tumbler", resource: RESOURCE, start: ["resource:read"], scopes: { "resource:read": [], "repo:write": ["repo"] } };
const b64u = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const childFor = (n: number) => `${b64u({ alg: "RS256" })}.${b64u({ jti: `jti-${n}`, aud: RESOURCE })}.sig`;

// A Keycard zone stand-in: RFC 8414 metadata, a token endpoint that checks the Basic credential and
// the resource, and (when `revocation`) an RFC 7009 endpoint.
function fakeZone(opts: { revocation?: boolean; issuer?: string; deny?: boolean } = {}) {
  const issued: { resource: string; scope: string | null }[] = [], revoked: string[] = [];
  let n = 0;
  const fetcher = (async (url: string, init: RequestInit = {}) => {
    const u = new URL(url);
    if (u.pathname === "/.well-known/oauth-authorization-server") {
      return Response.json({ issuer: opts.issuer ?? ZONE, token_endpoint: `${ZONE}/oauth/token`, ...(opts.revocation ? { revocation_endpoint: `${ZONE}/oauth/revoke` } : {}) });
    }
    const auth = String((init.headers as any)?.authorization ?? "");
    if (auth !== `Basic ${btoa(`app-tumbler:${SECRET}`)}`) return Response.json({ error: "invalid_client", error_description: `bad secret ${auth}` }, { status: 401 });
    const body = new URLSearchParams(String(init.body));
    if (u.pathname === "/oauth/token") {
      assert.equal(body.get("grant_type"), "client_credentials");
      if (opts.deny || body.get("resource") !== RESOURCE) return Response.json({ error: "access_denied", error_description: "policy p1 denied app-tumbler" }, { status: 400 });
      issued.push({ resource: body.get("resource")!, scope: body.get("scope") });
      return Response.json({ access_token: childFor(++n), token_type: "Bearer", expires_in: 3600 });
    }
    if (u.pathname === "/oauth/revoke" && opts.revocation) { revoked.push(body.get("token")!); return new Response(null, { status: 200 }); }
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
  return { issued, revoked, fetcher };
}

test("keycard provider: prepare fills the zone and client from static keys and takes the read default", async () => {
  const p = keycard(fakeZone().fetcher);
  const c = await p.prepare!(SECRET, { resource: RESOURCE }, async (n) => ({ KEYCARD_ZONE_URL: ZONE, KEYCARD_CLIENT_ID: "app-tumbler" } as Record<string, string>)[n]);
  assert.deepEqual(c, { resource: RESOURCE, zone_url: ZONE, client_id: "app-tumbler", scopes: { "resource:read": [] }, start: ["resource:read"] });
  await assert.rejects(p.prepare!(SECRET, {}, async () => undefined), /KEYCARD_ZONE_URL/);
  await assert.rejects(p.prepare!(SECRET, { zone_url: ZONE, client_id: "a" }, async () => undefined), /config.resource/);
});

test("keycard provider: validate wants https, no TTL of tumbler's, reads that ask for the Resource alone", () => {
  const p = keycard(fakeZone().fetcher);
  p.validate(CONFIG);
  assert.throws(() => p.validate({ ...CONFIG, zone_url: "http://zone123.keycard.cloud" }), /must be https/);
  assert.throws(() => p.validate({ ...CONFIG, resource: "api.github.com" }), /must be a URL/);
  assert.throws(() => p.validate({ ...CONFIG, ttl_minutes: 30 }), /Keycard sets the lifetime/);
  assert.throws(() => p.validate({ ...CONFIG, scopes: { "resource:read": ["repo"] } }), /Resource alone/);
  assert.throws(() => p.validate({ ...CONFIG, scopes: { "repo:write": ["has space"] } }), /OAuth scope values/);
  assert.throws(() => p.validate({ ...CONFIG, extra: { "repo:write": ["admin"] } }), /no operator additions/);
});

test("keycard provider: mints for the key's Resource with the scope's OAuth scopes; a policy refusal is a 403", async () => {
  const z = fakeZone(), p = keycard(z.fetcher);
  const m = await p.mint(SECRET, CONFIG, ["resource:read", "repo:write"], new Date(), "dev");
  assert.equal(m.id, "kc-jti-1");
  assert.equal(m.value, childFor(1));
  assert.ok(m.expires_at && Date.parse(m.expires_at) > Date.now());
  assert.deepEqual(z.issued, [{ resource: RESOURCE, scope: "repo" }]);
  await p.mint(SECRET, CONFIG, ["resource:read"], new Date(), "dev");
  assert.deepEqual(z.issued[1], { resource: RESOURCE, scope: null });
  // The zone's description quotes the Authorization header here; it never reaches tumbler's message.
  await assert.rejects(p.mint("wrong", CONFIG, ["resource:read"], new Date(), "dev"), (e: any) => e.status === 502 && /invalid_client/.test(e.message) && !e.message.includes("Basic"));
  await assert.rejects(keycard(fakeZone({ deny: true }).fetcher).mint(SECRET, CONFIG, ["resource:read"], new Date(), "dev"),
    (e: any) => e.status === 403 && /access_denied/.test(e.message) && !e.message.includes("policy p1"));
  await assert.rejects(keycard(fakeZone({ issuer: "https://evil.example" }).fetcher).mint(SECRET, CONFIG, ["resource:read"], new Date(), "dev"), /another issuer/);
});

test("keycard provider: verify is a real issuance; a bad secret is invalid", async () => {
  const z = fakeZone(), p = keycard(z.fetcher);
  assert.deepEqual(await p.verify!(SECRET, CONFIG), { status: "ok" });
  assert.equal(z.issued.length, 1);
  assert.deepEqual(await p.verify!("wrong", CONFIG), { status: "invalid", detail: "rejected (401 invalid_client)" });
});

test("keycard provider: revokes with RFC 7009 when the zone has it, and stays queued when it doesn't", async () => {
  const z = fakeZone({ revocation: true });
  await keycard(z.fetcher).revoke(SECRET, CONFIG, "kc-jti-1", childFor(1));
  assert.deepEqual(z.revoked, [childFor(1)]);
  await assert.rejects(keycard(fakeZone().fetcher).revoke(SECRET, CONFIG, "kc-jti-1", childFor(1)), /no revocation endpoint/);
  await assert.rejects(keycard(z.fetcher).revoke(SECRET, CONFIG, "kc-jti-1"), /no child credential/);
});

test("keycard key end to end: an admin saves the secret, a caller's run gets a Keycard token, never the secret", async () => {
  const z = fakeZone({ revocation: true }), db = memoryD1(), catalog = new Catalog(db, await masterKey(Buffer.alloc(32, 6).toString("base64")));
  const grants = new Grants(catalog, { keycard: keycard(z.fetcher) });
  const deps = { catalog, grants, admin: async (r: Request) => r.headers.get("x-test-admin") };
  const call = (method: string, path: string, token?: string, body?: unknown, admin = false) => handle(new Request(`https://t.example${path}`, {
    method, body: body === undefined ? undefined : JSON.stringify(body),
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(admin ? { "x-test-admin": "vu@example.com", "x-tumbler-admin": "1" } : {}) },
  }), deps);
  await catalog.put("global", "KEYCARD_ZONE_URL", ZONE);
  await catalog.put("global", "KEYCARD_CLIENT_ID", "app-tumbler");
  const saved = await call("PUT", "/admin/api/keys/global/GH_TOKEN", undefined, { value: SECRET, kind: "mint:keycard", config: { resource: RESOURCE } }, true);
  assert.equal(saved.status, 200, await saved.text());
  assert.equal(z.issued.length, 1); // the save's check
  const dev = await catalog.createToken("dev", ["dev"]);
  const r = await call("GET", "/v1/env?project=dev&keys=GH_TOKEN", dev);
  assert.deepEqual((await r.json()).env, { GH_TOKEN: childFor(2) });
  const texts = await Promise.all(["/admin/api/keys", "/admin/api/grants", "/admin/api/audit"].map(async (p) => (await call("GET", p, undefined, undefined, true)).text()));
  for (const t of texts) assert.ok(!t.includes(SECRET) && !t.includes(childFor(2)));
  // A revoke reaches the zone with the child itself.
  const [g] = (await (await call("GET", "/admin/api/grants", undefined, undefined, true)).json()).grants;
  assert.equal((await call("DELETE", `/admin/api/grants/${g.id}`, undefined, undefined, true)).status, 200);
  assert.deepEqual(z.revoked, [childFor(2)]);
});

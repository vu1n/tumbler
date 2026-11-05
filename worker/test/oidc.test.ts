// OIDC callers: a platform-issued JWT acts as the token row bound to its issuer and subject.
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { test } from "node:test";
import { handle } from "../src/app.ts";
import { Catalog } from "../src/catalog.ts";
import { masterKey } from "../src/crypto.ts";
import { MAX_KEY_AGE_MS, MAX_LIFETIME_S, oidcVerifier } from "../src/oidc.ts";
import { memoryD1 } from "./d1.ts";

const ISS = "https://token.actions.example.com", AUD = "https://tumbler.example.com";
const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }), ec = generateKeyPairSync("ec", { namedCurve: "P-256" });
const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
const b64u = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const nowS = () => Math.floor(Date.now() / 1000);

function jwt(claims: Record<string, unknown>, opts: { alg?: string; kid?: string; key?: any } = {}) {
  const alg = opts.alg ?? "RS256", head = b64u({ alg, kid: opts.kid ?? (alg === "ES256" ? "ec1" : "rsa1"), typ: "JWT" });
  const body = b64u({ iss: ISS, aud: AUD, sub: "repo:vu1n/kypp:ref:refs/heads/main", iat: nowS(), exp: nowS() + 300, ...claims });
  const data = Buffer.from(`${head}.${body}`);
  const key = opts.key ?? (alg === "ES256" ? ec.privateKey : rsa.privateKey);
  const sig = alg === "none" ? Buffer.alloc(0) : alg === "ES256" ? sign("sha256", data, { key, dsaEncoding: "ieee-p1363" }) : sign("sha256", data, key);
  return `${head}.${body}.${sig.toString("base64url")}`;
}

// The issuer: an OpenID discovery document and a JWKS with one RSA and one EC key. Counts fetches.
function fakeIssuer() {
  const fetched: string[] = [], state = { down: false };
  const jwks = { keys: [{ ...rsa.publicKey.export({ format: "jwk" }), kid: "rsa1", alg: "RS256", use: "sig" }, { ...ec.publicKey.export({ format: "jwk" }), kid: "ec1" }] };
  const fetcher = (async (url: string) => {
    fetched.push(new URL(url).host + new URL(url).pathname);
    if (state.down) return new Response("down", { status: 503 });
    if (url === `${ISS}/.well-known/openid-configuration`) return Response.json({ issuer: ISS, jwks_uri: `${ISS}/.well-known/jwks` });
    if (url === `${ISS}/.well-known/jwks`) return Response.json(jwks);
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
  return { fetched, fetcher, jwks, state };
}

async function setup() {
  const iss = fakeIssuer(), catalog = new Catalog(memoryD1(), await masterKey(Buffer.alloc(32, 7).toString("base64")));
  catalog.oidc = oidcVerifier(AUD, iss.fetcher);
  const deps = { catalog, admin: async (r: Request) => r.headers.get("x-test-admin") };
  const call = (method: string, path: string, token?: string, body?: unknown, admin = false) => handle(new Request(`${AUD}${path}`, {
    method, body: body === undefined ? undefined : JSON.stringify(body),
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(admin ? { "x-test-admin": "vu@example.com", "x-tumbler-admin": "1" } : {}) },
  }), deps);
  await catalog.put("kypp", "KYPP_DB", "fake-kypp-db");
  await catalog.put("huddles", "HUDDLES_DB", "fake-huddles-db");
  return { iss, catalog, call };
}

test("oidc: an admin binds a token to an issuer and subject; the job's JWT reads its pin, and no secret is shown", async () => {
  const { catalog, call } = await setup();
  const r = await call("POST", "/admin/api/tokens", undefined, { name: "ci-kypp", projects: ["kypp"], oidc: { issuer: ISS + "/", subject: "repo:vu1n/kypp:*" } }, true);
  assert.equal(r.status, 200);
  const made = await r.json();
  assert.deepEqual(made, { name: "ci-kypp", oidc: { issuer: ISS, subject: "repo:vu1n/kypp:*" } });
  const env = await call("GET", "/v1/env?keys=KYPP_DB", jwt({}));
  assert.deepEqual((await env.json()).env, { KYPP_DB: "fake-kypp-db" });
  // The pin still decides: the JWT proves who, never what.
  assert.equal((await call("GET", "/v1/env?project=huddles&keys=HUDDLES_DB", jwt({}))).status, 403);
  const who = await (await call("GET", "/v1/whoami", jwt({ alg: "ES256" }))).json();
  assert.equal(who.name, "ci-kypp");
  assert.equal(who.oidc_subject, "repo:vu1n/kypp:ref:refs/heads/main");
  // The audit names the token and the subject it proved.
  const read = (await catalog.recentAudit()).find((a: any) => a.action === "read") as any;
  assert.deepEqual([read.actor, read.via], ["ci-kypp", "repo:vu1n/kypp:ref:refs/heads/main"]);
  const listed = (await (await call("GET", "/admin/api/tokens", undefined, undefined, true)).json()).tokens.find((t: any) => t.name === "ci-kypp");
  assert.deepEqual([listed.oidc_issuer, listed.oidc_subject], [ISS, "repo:vu1n/kypp:*"]);
});

test("oidc: a token that fails any check is refused", async () => {
  const { catalog, call } = await setup();
  await catalog.createToken("ci", ["kypp"]);
  await catalog.updateToken("ci", { oidc: { issuer: ISS, subject: "repo:vu1n/kypp:*" } });
  const refused = async (t: string, why: string) => assert.equal((await call("GET", "/v1/env?keys=KYPP_DB", t)).status, 401, why);
  await refused(jwt({ aud: "https://elsewhere.example.com" }), "another audience");
  await refused(jwt({ exp: nowS() - 5 }), "expired");
  await refused(jwt({ exp: nowS() + MAX_LIFETIME_S + 3600 }), "good for longer than a day");
  await refused(jwt({ nbf: nowS() + 600 }), "not yet valid");
  await refused(jwt({ sub: "repo:vu1n/other:ref:refs/heads/main" }), "a subject the row doesn't trust");
  await refused(jwt({}, { key: other.privateKey }), "signed by another key");
  await refused(jwt({}, { kid: "nope" }), "an unknown key id");
  await refused(jwt({}, { alg: "none" }), "alg none");
  await refused(jwt({}, { alg: "HS256" }), "a symmetric alg");
  const [h, p, s] = jwt({}).split(".");
  await refused(`${h}.${b64u({ ...JSON.parse(Buffer.from(p, "base64url").toString()), sub: "repo:vu1n/kypp:x" })}.${s}`, "a payload edited after signing");
});

test("oidc: a JWT from an issuer no row trusts costs no fetch, and unknown kids refetch at most once a minute", async () => {
  const { iss, catalog, call } = await setup();
  assert.equal((await call("GET", "/v1/env?keys=KYPP_DB", jwt({ iss: "https://evil.example.com" }))).status, 401);
  assert.deepEqual(iss.fetched, []);
  await catalog.createToken("ci", ["kypp"]);
  await catalog.updateToken("ci", { oidc: { issuer: ISS, subject: "repo:vu1n/kypp:*" } });
  assert.equal((await call("GET", "/v1/env?keys=KYPP_DB", jwt({}))).status, 200);
  const once = iss.fetched.length;
  for (let i = 0; i < 5; i++) await call("GET", "/v1/env?keys=KYPP_DB", jwt({}, { kid: `made-up-${i}` }));
  // The first unknown kid inside the minute after a fetch is refused from the cache, so none refetch.
  assert.equal(iss.fetched.length, once);
});

test("oidc: once bound, the row's own secret stops working; unbinding brings back nothing a JWT had", async () => {
  const { catalog, call } = await setup();
  const secret = await catalog.createToken("ci", ["kypp"]);
  assert.equal((await call("GET", "/v1/env?keys=KYPP_DB", secret)).status, 200);
  const r = await call("PATCH", "/admin/api/tokens/ci", undefined, { oidc: { issuer: ISS, subject: "repo:vu1n/kypp:*" } }, true);
  assert.equal(r.status, 200);
  assert.equal((await call("GET", "/v1/env?keys=KYPP_DB", secret)).status, 401);
  assert.equal((await call("GET", "/v1/env?keys=KYPP_DB", jwt({}))).status, 200);
  // Revoked: the JWT stops at once, whatever its exp.
  await call("DELETE", "/admin/api/tokens/ci", undefined, undefined, true);
  assert.equal((await call("GET", "/v1/env?keys=KYPP_DB", jwt({}))).status, 401);
});

test("oidc: an exact subject wins over a prefix; bindings are checked and never duplicated", async () => {
  const { catalog, call } = await setup();
  await catalog.createToken("ci-any", ["huddles"]);
  await catalog.updateToken("ci-any", { oidc: { issuer: ISS, subject: "repo:vu1n/*" } });
  await catalog.createToken("ci-kypp-main", ["kypp"]);
  await catalog.updateToken("ci-kypp-main", { oidc: { issuer: ISS, subject: "repo:vu1n/kypp:ref:refs/heads/main" } });
  assert.equal((await (await call("GET", "/v1/whoami", jwt({}))).json()).name, "ci-kypp-main");
  assert.equal((await (await call("GET", "/v1/whoami", jwt({ sub: "repo:vu1n/kypp:pull_request" }))).json()).name, "ci-any");
  await catalog.createToken("x", null);
  await assert.rejects(catalog.updateToken("x", { oidc: { issuer: ISS, subject: "*" } }), /at least 3 characters/);
  await assert.rejects(catalog.updateToken("x", { oidc: { issuer: ISS, subject: "repo:*:main" } }), /only at the end/);
  await assert.rejects(catalog.updateToken("x", { oidc: { issuer: "http://insecure.example.com", subject: "abc" } }), /https/);
  await assert.rejects(catalog.updateToken("x", { oidc: { issuer: ISS, subject: "repo:vu1n/*" } }), /already bound/);
  // A refused bind on create leaves no usable token behind.
  const bad = await call("POST", "/admin/api/tokens", undefined, { name: "bad", oidc: { issuer: ISS, subject: "*" } }, true);
  assert.equal(bad.status, 400);
  assert.ok((await catalog.tokenRow("bad"))?.revoked_at);
});

test("oidc: without an audience configured, no JWT is ever a caller", async () => {
  const { catalog, call } = await setup();
  await catalog.createToken("ci", ["kypp"]);
  await catalog.updateToken("ci", { oidc: { issuer: ISS, subject: "repo:vu1n/kypp:*" } });
  catalog.oidc = undefined;
  assert.equal((await call("GET", "/v1/env?keys=KYPP_DB", jwt({}))).status, 401);
});

test("oidc: revoking the most specific binding never falls back to a broader one", async () => {
  const { catalog, call } = await setup();
  await catalog.createToken("ci-main", ["kypp"]);
  await catalog.updateToken("ci-main", { oidc: { issuer: ISS, subject: "repo:vu1n/kypp:ref:refs/heads/main" } });
  await catalog.createToken("ci-any", ["kypp", "huddles"], null, ["*"]);
  await catalog.updateToken("ci-any", { oidc: { issuer: ISS, subject: "repo:vu1n/*" } });
  assert.equal((await (await call("GET", "/v1/whoami", jwt({}))).json()).name, "ci-main");
  await catalog.revokeToken("ci-main");
  assert.equal((await call("GET", "/v1/whoami", jwt({}))).status, 401);
  // Other subjects still reach the prefix row.
  assert.equal((await (await call("GET", "/v1/whoami", jwt({ sub: "repo:vu1n/kypp:pull_request" }))).json()).name, "ci-any");
});

test("oidc: an expired binding is replaced by recreating the token; concurrent binds can't both land", async () => {
  const { catalog, call } = await setup();
  const t0 = new Date();
  const first = await call("POST", "/admin/api/tokens", undefined, { name: "ci", projects: ["kypp"], expires_at: new Date(t0.getTime() + 3600_000).toISOString(), oidc: { issuer: ISS, subject: "repo:vu1n/kypp:*" } }, true);
  assert.equal(first.status, 200);
  catalog.clock = () => new Date(t0.getTime() + 2 * 3600_000);
  assert.equal((await call("GET", "/v1/whoami", jwt({}))).status, 401);
  const again = await call("POST", "/admin/api/tokens", undefined, { name: "ci", projects: ["kypp"], oidc: { issuer: ISS, subject: "repo:vu1n/kypp:*" } }, true);
  assert.equal(again.status, 200, await again.clone().text());
  assert.equal((await (await call("GET", "/v1/whoami", jwt({}))).json()).name, "ci");
  catalog.clock = () => new Date();
  await catalog.createToken("a", null);
  await catalog.createToken("b", null);
  const binds = await Promise.allSettled(["a", "b"].map((n) => catalog.updateToken(n, { oidc: { issuer: ISS, subject: "repo:vu1n/other:*" } })));
  assert.deepEqual(binds.map((r) => r.status).sort(), ["fulfilled", "rejected"]);
  assert.match(String((binds.find((r) => r.status === "rejected") as PromiseRejectedResult).reason), /already bound/);
});

test("oidc: key refreshes are shared, start at most once a minute, and a failed one counts", async () => {
  const iss = fakeIssuer(), base = Date.now();
  let at = base;
  const v = oidcVerifier(AUD, iss.fetcher, () => at), trusted = async () => true;
  assert.ok(await v.verify(jwt({}), trusted));
  assert.equal(iss.fetched.length, 2); // discovery + JWKS
  at = base + 61_000;
  await Promise.all(Array.from({ length: 5 }, (_, i) => v.verify(jwt({}, { kid: `new-${i}` }), trusted)));
  assert.equal(iss.fetched.length, 4, "five concurrent unknown kids share one refresh");
  at = base + 122_000;
  iss.state.down = true;
  assert.equal(await v.verify(jwt({}, { kid: "new-x" }), trusted), null);
  const failed = iss.fetched.length;
  assert.equal(await v.verify(jwt({}, { kid: "new-y" }), trusted), null);
  assert.equal(iss.fetched.length, failed, "a failed refresh still counts as this minute's");
  assert.ok(await v.verify(jwt({}), trusted), "the keys already held keep working while the issuer is down");
  // Held past MAX_KEY_AGE_MS with every refresh failing, they verify nothing: the issuer may have revoked them.
  at = base + 61_000 + MAX_KEY_AGE_MS + 1; // the last good refresh was at base + 61s
  const fresh = () => jwt({ iat: Math.floor(at / 1000), exp: Math.floor(at / 1000) + 300 });
  assert.equal(await v.verify(fresh(), trusted), null, "keys older than the max age are refused while the issuer is down");
  iss.state.down = false;
  at += 61_000;
  assert.ok(await v.verify(fresh(), trusted), "the issuer back up, a refresh restores them");
});

test("oidc: a key published for encryption, other operations or another alg never verifies", async () => {
  for (const restrict of [{ use: "enc" }, { key_ops: ["encrypt"] }, { alg: "RS384" }]) {
    const iss = fakeIssuer();
    iss.jwks.keys[0] = { ...iss.jwks.keys[0], use: undefined, alg: undefined, ...restrict } as any;
    const v = oidcVerifier(AUD, iss.fetcher);
    assert.equal(await v.verify(jwt({}), async () => true), null, JSON.stringify(restrict));
  }
  const ok = fakeIssuer();
  ok.jwks.keys[0] = { ...ok.jwks.keys[0], key_ops: ["verify"] } as any;
  assert.ok(await oidcVerifier(AUD, ok.fetcher).verify(jwt({}), async () => true));
});

test("oidc: a delegate's OIDC caller that stores a token is named in both audit rows", async () => {
  const { catalog, call } = await setup();
  await catalog.createToken("ci-dev", ["kypp"], null, null, ["kypp"]);
  await catalog.updateToken("ci-dev", { delegate: true, oidc: { issuer: ISS, subject: "repo:vu1n/kypp:*" } });
  const r = await call("POST", "/v1/tokens", jwt({}), { name: "vps", projects: ["kypp"], store: { scope: "kypp", name: "VPS_TOKEN" } });
  assert.equal(r.status, 200);
  const rows = (await catalog.recentAudit()).filter((a: any) => a.action === "token-create" || a.action === "put") as any[];
  assert.deepEqual(rows.filter((a) => a.actor === "ci-dev").map((a) => [a.action, a.via]).sort(),
    [["put", "repo:vu1n/kypp:ref:refs/heads/main"], ["token-create", "repo:vu1n/kypp:ref:refs/heads/main"]]);
});

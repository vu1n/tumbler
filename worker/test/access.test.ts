import assert from "node:assert/strict";
import { test } from "node:test";
import { accessAdmin } from "../src/access.ts";

const TEAM = "vu.cloudflareaccess.com", AUD = "aud-123", cfg = { teamDomain: TEAM, aud: AUD, admins: ["vu@example.com"] };
const b64url = (b: Uint8Array | string) => Buffer.from(b).toString("base64url");

const pair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
const other = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
const jwks = async () => ({ keys: [{ ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid: "k1" } as any] });

async function jwt(claims: Record<string, unknown>, key = pair.privateKey, kid = "k1") {
  const h = b64url(JSON.stringify({ alg: "RS256", kid })), now = Math.floor(Date.now() / 1000);
  const p = b64url(JSON.stringify({ aud: [AUD], iss: `https://${TEAM}`, exp: now + 300, email: "vu@example.com", ...claims }));
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${h}.${p}`)));
  return `${h}.${p}.${b64url(sig)}`;
}
const req = (token?: string) => new Request("https://t.example/admin", { headers: token ? { "cf-access-jwt-assertion": token } : {} });

test("a valid Access token for an admin passes", async () => {
  assert.equal(await accessAdmin(req(await jwt({ email: "VU@example.com" })), cfg, jwks), "vu@example.com");
});

test("missing, forged, expired, wrong-audience, wrong-issuer and non-admin tokens fail", async () => {
  const now = Math.floor(Date.now() / 1000);
  for (const token of [
    undefined,
    await jwt({}, other.privateKey),
    await jwt({ exp: now - 1 }),
    await jwt({ aud: ["other"] }),
    await jwt({ iss: "https://evil.cloudflareaccess.com" }),
    await jwt({ email: "someone@example.com" }),
    await jwt({}, pair.privateKey, "unknown-kid"),
    "not.a.jwt",
  ]) assert.equal(await accessAdmin(req(token), cfg, jwks), null);
});

test("an unconfigured install lets nobody in", async () => {
  assert.equal(await accessAdmin(req(await jwt({})), { ...cfg, admins: [] }, jwks), null);
  assert.equal(await accessAdmin(req(await jwt({})), { ...cfg, aud: "" }, jwks), null);
});

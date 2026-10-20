// crypto.ts — envelope encryption for catalog values. The master key lives in Cloudflare Secrets
// Store (one binding), values live in D1 as AES-GCM ciphertext. This is the only crypto tumbler does.
const enc = new TextEncoder(), dec = new TextDecoder();

// The master key is 32 random bytes, base64: `openssl rand -base64 32`.
export async function masterKey(b64: string): Promise<CryptoKey> {
  const raw = Uint8Array.from(atob(b64.trim()), (c) => c.charCodeAt(0));
  if (raw.length !== 32) throw new Error("master key must be 32 bytes (base64)");
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

// Why: the row's scope and name are the additional data, so a ciphertext copied onto another row
// (another key, or a project the attacker can read) fails to decrypt instead of leaking.
const aad = (scope: string, name: string) => enc.encode(`${scope}\0${name}`);

export async function seal(key: CryptoKey, scope: string, name: string, value: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad(scope, name) }, key, enc.encode(value));
  return { iv, ciphertext: new Uint8Array(ct) };
}

export async function open(key: CryptoKey, scope: string, name: string, iv: Uint8Array, ciphertext: Uint8Array): Promise<string> {
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: aad(scope, name) }, key, ciphertext);
  return dec.decode(pt);
}

export async function sha256hex(s: string): Promise<string> {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s)));
  return Array.from(h, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function randomToken(): string {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return "tmb_" + btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

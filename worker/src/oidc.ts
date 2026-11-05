// oidc.ts — caller tokens a platform issues. A caller can present a short-lived OIDC token instead of
// a tumbler token: a GitHub Actions job's, a Fly or Render service's, a Keycard-issued one. It is
// accepted only for a tumbler token row bound to its issuer and subject (catalog.ts federated()),
// and that row's pin, scopes and writes are what it gets: the JWT proves who, never what.
//
// Checks, all of them, or the token is refused: an issuer some live row trusts (so a JWT naming any
// other issuer costs no fetch), RS256 or ES256 only, a signature by a key in the issuer's JWKS (found
// through its OpenID discovery document), `aud` holding this broker's audience exactly, `exp` in the
// future and at most MAX_LIFETIME_S away, `nbf` and `iat` not ahead of the clock.
export type Verified = { iss: string; sub: string };
export interface OidcVerifier { audience: string; verify(jwt: string, trusts: (iss: string) => Promise<boolean>): Promise<Verified | null> }

const SKEW_S = 60;
// A federated caller is short-lived by definition: a token good for longer than a day is refused,
// whatever its issuer signed. Keycard's default credential lifetime is a day; CI tokens are minutes.
export const MAX_LIFETIME_S = 24 * 60 * 60;
const JWKS_TTL_MS = 10 * 60_000;
// An unknown kid refetches the JWKS at most this often per issuer, so tokens with made-up kids can't
// make the broker fetch on every request.
const REFETCH_MS = 60_000;
const FETCH_TIMEOUT_MS = 5_000;
const ALGS: Record<string, { import: Parameters<SubtleCrypto["importKey"]>[2]; verify: Parameters<SubtleCrypto["verify"]>[0]; kty: string }> = {
  RS256: { import: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, verify: "RSASSA-PKCS1-v1_5", kty: "RSA" },
  ES256: { import: { name: "ECDSA", namedCurve: "P-256" }, verify: { name: "ECDSA", hash: "SHA-256" }, kty: "EC" },
};

type Jwk = JsonWebKey & { kid?: string };
const b64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
const part = (s: string) => JSON.parse(new TextDecoder().decode(b64url(s)));
// A JWT's shape, so an opaque tumbler token (tmb_...) never goes down this path.
export const looksLikeJwt = (t: string) => /^eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(t);

// An issuer as an admin may bind one: https, no query or fragment, no trailing slash.
export function checkIssuer(iss: string): string {
  let u: URL;
  try { u = new URL(iss); } catch { throw new Error(`issuer must be a URL: ${iss}`); }
  if (u.protocol !== "https:" || u.search || u.hash || u.username || u.password) throw new Error(`issuer must be an https URL with no query: ${iss}`);
  return iss.replace(/\/+$/, "");
}

export function oidcVerifier(audience: string, fetcher: typeof fetch = fetch, now = () => Date.now()): OidcVerifier {
  type KeyCache = { at: number; tried: number; jwks: Jwk[]; inflight?: Promise<void> };
  const keys = new Map<string, KeyCache>();
  const get = async (url: string) => {
    const r = await fetcher(url, { redirect: "manual", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { accept: "application/json" } });
    if (!r.ok) { await r.body?.cancel().catch(() => {}); throw new Error(`oidc fetch ${r.status}`); }
    return r.json() as Promise<any>;
  };
  // The issuer's signing keys, through its discovery document. The document must name the issuer.
  const fetchKeys = async (iss: string): Promise<Jwk[]> => {
    const doc = await get(`${iss}/.well-known/openid-configuration`);
    if (String(doc?.issuer ?? "").replace(/\/+$/, "") !== iss) throw new Error("oidc discovery names another issuer");
    const jwksUri = new URL(String(doc.jwks_uri));
    if (jwksUri.protocol !== "https:") throw new Error("oidc jwks_uri must be https");
    const jwks = await get(jwksUri.toString());
    return Array.isArray(jwks?.keys) ? jwks.keys : [];
  };
  // One fetch at a time per issuer, and at most one start a minute, failed or not: the attempt is
  // recorded before it is awaited, and concurrent callers share it, so unauthenticated requests can
  // neither fan out fetches nor hammer an issuer that is down. A failure keeps the keys already held.
  const refresh = (iss: string, c: KeyCache) => {
    if (c.inflight) return c.inflight;
    c.tried = now();
    return c.inflight = fetchKeys(iss).then((jwks) => { c.jwks = jwks; c.at = now(); })
      .catch((e) => console.error("tumbler: oidc keys fetch failed", e instanceof Error ? e.name : "other"))
      .finally(() => { c.inflight = undefined; });
  };
  const keyFor = async (iss: string, kid: string | undefined, alg: string, kty: string): Promise<Jwk | undefined> => {
    // Only keys published for signing with this algorithm: a key marked for encryption, for other
    // operations or for another alg never verifies a caller.
    const usable = (k: Jwk & { use?: string }) => k.kty === kty && (k.use === undefined || k.use === "sig")
      && (k.key_ops === undefined || (Array.isArray(k.key_ops) && k.key_ops.includes("verify"))) && (k.alg === undefined || k.alg === alg);
    const pick = (list: Jwk[]) => { const ok = list.filter(usable); return kid === undefined ? (ok.length === 1 ? ok[0] : undefined) : ok.find((k) => k.kid === kid); };
    let c = keys.get(iss);
    if (!c) keys.set(iss, c = { at: 0, tried: -Infinity, jwks: [] });
    const due = () => now() - c!.tried > REFETCH_MS;
    if (now() - c.at > JWKS_TTL_MS && (c.inflight || due())) await refresh(iss, c);
    let k = pick(c.jwks);
    // A rotation the cache hasn't seen: one refetch, at most once a minute per issuer.
    if (!k && (c.inflight || due())) { await refresh(iss, c); k = pick(c.jwks); }
    return k;
  };

  return {
    audience,
    async verify(jwt, trusts) {
      if (!looksLikeJwt(jwt)) return null;
      const [h, p, s] = jwt.split(".");
      let header: any, payload: any;
      try { header = part(h); payload = part(p); } catch { return null; }
      const alg = ALGS[header?.alg];
      if (!alg || typeof payload?.iss !== "string" || typeof payload?.sub !== "string" || !payload.sub) return null;
      const iss = payload.iss.replace(/\/+$/, "");
      // Why first: only an issuer a live token row names is ever fetched from.
      if (!(await trusts(iss))) return null;
      const t = now() / 1000;
      const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
      if (!auds.includes(audience)) return null;
      if (typeof payload.exp !== "number" || payload.exp <= t || payload.exp > t + MAX_LIFETIME_S + SKEW_S) return null;
      if ((typeof payload.nbf === "number" && payload.nbf > t + SKEW_S) || (typeof payload.iat === "number" && payload.iat > t + SKEW_S)) return null;
      try {
        const jwk = await keyFor(iss, typeof header.kid === "string" ? header.kid : undefined, header.alg, alg.kty);
        if (!jwk) return null;
        const { kid: _kid, alg: _alg, use: _use, key_ops: _ops, ...bare } = jwk as Jwk & { use?: string };
        const key = await crypto.subtle.importKey("jwk", bare, alg.import, false, ["verify"]);
        const ok = await crypto.subtle.verify(alg.verify, key, b64url(s), new TextEncoder().encode(`${h}.${p}`));
        return ok ? { iss, sub: payload.sub } : null;
      } catch (e) {
        // An issuer we can't reach refuses the token; never its error text, which can quote a URL.
        console.error("tumbler: oidc verify failed", e instanceof Error ? e.name : "other");
        return null;
      }
    },
  };
}

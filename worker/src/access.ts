// access.ts — verify the Cloudflare Access JWT on admin requests. Access already blocks unauthenticated
// traffic at the edge; this check means a misconfigured Access policy or a direct *.workers.dev hit
// still can't reach the admin API.
export interface AccessConfig { teamDomain: string; aud: string; admins: string[] }
type Jwks = { keys: (JsonWebKey & { kid: string })[] };
export type JwksFetcher = (url: string) => Promise<Jwks>;

const b64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
const json = (s: string) => JSON.parse(new TextDecoder().decode(b64url(s)));

let cache: { url: string; at: number; jwks: Jwks } | null = null;
const defaultFetcher: JwksFetcher = async (url) => {
  if (cache && cache.url === url && Date.now() - cache.at < 10 * 60_000) return cache.jwks;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`jwks ${res.status}`);
  cache = { url, at: Date.now(), jwks: await res.json() };
  return cache.jwks;
};

// Returns the signed-in admin's email, or null.
export async function accessAdmin(request: Request, cfg: AccessConfig, fetchJwks: JwksFetcher = defaultFetcher): Promise<string | null> {
  const jwt = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!jwt || !cfg.teamDomain || !cfg.aud || !cfg.admins.length) return null;
  const [h, p, s] = jwt.split(".");
  if (!h || !p || !s) return null;
  try {
    const header = json(h), payload = json(p);
    if (header.alg !== "RS256") return null;
    const jwk = (await fetchJwks(`https://${cfg.teamDomain}/cdn-cgi/access/certs`)).keys.find((k) => k.kid === header.kid);
    if (!jwk) return null;
    const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64url(s), new TextEncoder().encode(`${h}.${p}`));
    if (!ok) return null;
    const t = Date.now() / 1000;
    const auds: string[] = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!auds.includes(cfg.aud) || payload.iss !== `https://${cfg.teamDomain}` || !(payload.exp > t) || (payload.nbf && payload.nbf > t + 60)) return null;
    const email = String(payload.email ?? "").toLowerCase();
    return cfg.admins.includes(email) ? email : null;
  } catch {
    return null;
  }
}

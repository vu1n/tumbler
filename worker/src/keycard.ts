// keycard.ts — the `mint:keycard` provider. The parent is a Keycard Application's client secret; each
// child is a token Keycard's STS issues for one Resource, by the OAuth client credentials grant
// (RFC 6749 §4.4) with the Resource named as an RFC 8707 `resource`. Keycard's Policies decide what the
// Application may reach; tumbler decides which callers get a child and for which scopes. Config:
//   { "zone_url": "https://<zone-id>.keycard.cloud", "client_id": "<application client id>",
//     "resource": "https://api.github.com",
//     "start": ["resource:read"],
//     "scopes": { "resource:read": [], "repo:write": ["repo"] } }
// One key is one Resource, as one `[[credentials.default]]` entry in a keycard.toml is one env var for
// one Resource. A scope lists OAuth scope values to ask for beyond the Resource itself; an empty list
// asks for the Resource alone. Pasting only the secret is enough when KEYCARD_ZONE_URL and
// KEYCARD_CLIENT_ID are saved as static keys, and config.resource is set.
//
// Keycard sets the child's lifetime (24 hours unless the Resource sets a shorter Credential Lifetime),
// so ttl_minutes is left out. Keycard has no per-token revocation unless the zone publishes an RFC 7009
// revocation endpoint: without one, a revoke stays queued (and shown on the Grants tab) until the
// child expires, which is the truth about it.
import { Refused } from "./catalog.ts";
import type { MintConfig, Provider } from "./grants.ts";
import { TIMEOUT_MS } from "./verify.ts";

// An RFC 6749 scope-token: printable ASCII except space, `"` and `\`.
const SCOPE_TOKEN = /^[\x21\x23-\x5b\x5d-\x7e]{1,128}$/;
const CLIENT_ID = /^[\x21-\x7e]{1,256}$/;
// The OAuth error codes a log line or an outcome may name. Never error_description: a zone writes it.
const OAUTH_ERRORS = new Set(["invalid_request", "invalid_client", "invalid_grant", "unauthorized_client", "unsupported_grant_type", "invalid_scope", "invalid_target", "access_denied", "insufficient_authorization"]);
export const DEFAULT_SCOPES: Record<string, string[]> = { "resource:read": [] };

const https = (v: unknown, what: string) => {
  let u: URL;
  try { u = new URL(String(v)); } catch { throw new Refused(400, `${what} must be a URL`); }
  // Why https only: the parent goes to the zone and the child is for this Resource.
  if (u.protocol !== "https:") throw new Refused(400, `${what} must be https`);
  return u;
};
const trimSlash = (s: string) => s.replace(/\/+$/, "");

interface Metadata { token_endpoint: string; revocation_endpoint?: string }

// The zone's OAuth error code, from a fixed list; "other" for anything else. Never its description.
async function oauthError(r: Response) {
  const j = await r.json().catch(() => null) as { error?: unknown } | null;
  return typeof j?.error === "string" && OAUTH_ERRORS.has(j.error) ? j.error : "other";
}

export function keycard(fetcher: typeof fetch = fetch): Provider {
  const send = (url: string, init: RequestInit, what: string) =>
    // Why the catch: a fetch error message can quote a header, and the Basic credential is one.
    fetcher(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) })
      .catch(() => { throw new Refused(502, `keycard ${what}: request failed`); });

  // RFC 8414 discovery. The metadata must name the zone as its issuer, and its endpoints must be https.
  const discover = async (config: MintConfig): Promise<Metadata> => {
    const zone = trimSlash(String(config.zone_url));
    const r = await send(`${zone}/.well-known/oauth-authorization-server`, { headers: { accept: "application/json" } }, "discovery");
    if (!r.ok) { await r.body?.cancel().catch(() => {}); throw new Refused(502, `keycard discovery: ${r.status}`); }
    const m = await r.json().catch(() => null) as Record<string, unknown> | null;
    if (!m || trimSlash(String(m.issuer ?? "")) !== zone) throw new Refused(502, "keycard discovery: the metadata names another issuer");
    const token = https(m.token_endpoint, "the zone's token_endpoint").toString();
    const revoke = typeof m.revocation_endpoint === "string" ? https(m.revocation_endpoint, "the zone's revocation_endpoint").toString() : undefined;
    return { token_endpoint: token, revocation_endpoint: revoke };
  };

  // As Keycard's own SDKs send it: client_secret_basic.
  const basic = (config: MintConfig, parent: string) => `Basic ${btoa(`${config.client_id}:${parent}`)}`;

  const token = async (parent: string, config: MintConfig, scope: string[]) => {
    const { token_endpoint } = await discover(config);
    const body = new URLSearchParams({ grant_type: "client_credentials", resource: String(config.resource) });
    if (scope.length) body.set("scope", scope.join(" "));
    return send(token_endpoint, {
      method: "POST", body: body.toString(),
      headers: { authorization: basic(config, parent), "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    }, "token");
  };

  return {
    async prepare(_parent, config, setting) {
      const c: MintConfig = { ...config };
      if (!c.zone_url) c.zone_url = (await setting("KEYCARD_ZONE_URL"))?.trim();
      if (!c.client_id) c.client_id = (await setting("KEYCARD_CLIENT_ID"))?.trim();
      if (!c.zone_url) throw new Refused(400, "no zone: save KEYCARD_ZONE_URL as a static key (Console > Settings > Connection, the Issuer URL), or set config.zone_url");
      if (!c.client_id) throw new Refused(400, "no client id: save KEYCARD_CLIENT_ID as a static key, or set config.client_id");
      if (!c.resource) throw new Refused(400, "config.resource must name the Keycard Resource this key's children are for (https://api.github.com)");
      if (!c.scopes || !Object.keys(c.scopes).length) return { ...c, scopes: DEFAULT_SCOPES, start: c.start ?? ["resource:read"] };
      return c;
    },
    validate(config) {
      const zone = https(config.zone_url, "config.zone_url");
      if (zone.search || zone.hash) throw new Refused(400, "config.zone_url is the zone's issuer URL, with no query");
      https(config.resource, "config.resource");
      if (!CLIENT_ID.test(String(config.client_id ?? ""))) throw new Refused(400, "config.client_id must be the Application's client id");
      // Keycard sets the child's lifetime; another TTL here would mislead.
      if (config.ttl_minutes !== undefined) throw new Refused(400, "ttl_minutes must be left out: Keycard sets the lifetime (the Resource's Credential Lifetime in Console)");
      const check = (where: string, s: string, groups: unknown) => {
        if (!Array.isArray(groups) || !groups.every((g) => typeof g === "string" && SCOPE_TOKEN.test(g))) {
          throw new Refused(400, `${where}.${s} must list OAuth scope values (an empty list asks for the Resource alone)`);
        }
        // Why: a `:read` scope is granted to every token on request (machine.ts autoApproved), and
        // tumbler can't tell which of a Resource's scopes only read, so it asks for the Resource alone.
        if (s.endsWith(":read") && groups.length) throw new Refused(400, `${where}.${s}: every token gets ${s}, so it asks for the Resource alone; put OAuth scopes in a write scope`);
      };
      for (const [s, groups] of Object.entries(config.scopes ?? {})) check("config.scopes", s, groups);
      // Operators add Cloudflare and GitHub permission groups; a Keycard Resource's reach is Keycard Policy's.
      if (config.extra !== undefined && Object.keys(config.extra).length) throw new Refused(400, "mint:keycard keys take no operator additions: change the Application's Policies in Keycard");
    },
    async mint(parent, config, scopes, _expiresAt, _label) {
      const stored = (config.scopes ?? {}) as Record<string, string[]>;
      const scope = [...new Set(scopes.flatMap((s) => stored[s] ?? []))].sort();
      const r = await token(parent, config, scope);
      if (!r.ok) {
        const code = await oauthError(r);
        // Why 403 for a policy answer: retrying gets the same one; a person changes the Policy.
        if (code === "access_denied" || code === "invalid_target" || code === "invalid_scope") {
          throw new Refused(403, `keycard refused ${config.resource} for this Application (${code}). Refused; retrying won't help: change the Application's dependencies or Policies in Keycard`);
        }
        throw new Refused(502, `keycard token: ${r.status} ${code}`);
      }
      const j = await r.json().catch(() => null) as Record<string, unknown> | null;
      if (typeof j?.access_token !== "string" || !j.access_token) throw new Refused(502, "keycard issued no token");
      const ttl = Number(j.expires_in);
      // The JWT's jti names the child in tumbler's rows when Keycard sets one; a random id otherwise.
      let jti: unknown;
      try { jti = JSON.parse(atob(j.access_token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))).jti; } catch { /* opaque token */ }
      return {
        id: `kc-${typeof jti === "string" && /^[\x21-\x7e]{1,128}$/.test(jti) ? jti : crypto.randomUUID()}`,
        value: j.access_token,
        ...(ttl > 0 ? { expires_at: new Date(Date.now() + ttl * 1000).toISOString() } : {}),
      };
    },
    // Before a secret is saved: the zone must issue a token for the Resource with it. This is a real
    // issuance, so it shows in Keycard's Audit Log, which is what a check of an STS can be.
    async verify(parent, config) {
      try {
        const r = await token(parent, config, []);
        if (r.ok) { await r.body?.cancel().catch(() => {}); return { status: "ok" }; }
        const code = await oauthError(r);
        if (code === "invalid_client" || r.status === 401) return { status: "invalid", detail: `rejected (${r.status} ${code})` };
        return { status: "error", detail: `could not check (${r.status} ${code})` };
      } catch (e) { return { status: "error", detail: e instanceof Refused ? e.message : "could not check (request failed)" }; }
    },
    // RFC 7009, with the child itself, when the zone publishes a revocation endpoint. Without one the
    // child can't be ended early: the throw keeps the revoke queued until the child expires.
    async revoke(parent, config, _childId, child) {
      if (!child) throw new Refused(502, "keycard: no child credential left to revoke with");
      const { revocation_endpoint } = await discover(config);
      if (!revocation_endpoint) throw new Refused(502, "keycard: the zone publishes no revocation endpoint; the child works until it expires");
      const r = await send(revocation_endpoint, {
        method: "POST", body: new URLSearchParams({ token: child, token_type_hint: "access_token" }).toString(),
        headers: { authorization: basic(config, parent), "content-type": "application/x-www-form-urlencoded" },
      }, "revoke");
      await r.body?.cancel().catch(() => {});
      // RFC 7009 §2.2: 200 for a revoked token and for one already invalid.
      if (!r.ok) throw new Refused(502, `keycard revoke: ${r.status}`);
    },
  };
}

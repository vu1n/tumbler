// github.ts — the `mint:github` provider. The parent is a GitHub App's private key; each child is an
// installation access token with only the grant's permissions, on the installation's repos (or the
// ones config.repositories names). Config:
//   { "app_id": "123456", "installation_id": 7890, "ttl_minutes": 60, "start": ["repo:read"],
//     "scopes": { "repo:read": ["contents:read", "metadata:read"], "repo:write": ["contents:write"] },
//     "repositories": ["pillbox"] }   // optional: children reach only these repos
// A group is `<permission>:<read|write>`, GitHub's permission names (contents, pull_requests, ...).
// Pasting only the parent is enough: prepare() takes app_id from the GITHUB_APP_ID key, finds the
// installation (config.owner picks one when the App has several) and marks the key `"defaults": true`,
// which mints from DEFAULT_SCOPES as the code has them now.
import { Refused } from "./catalog.ts";
import type { GroupInfo, MintConfig, Provider } from "./grants.ts";
import { byStatus, TIMEOUT_MS } from "./verify.ts";

const API = "https://api.github.com";
const APP = /^([1-9][0-9]{0,11}|Iv[0-9A-Za-z.]{8,40})$/, GROUP = /^[a-z_]{1,64}:(read|write)$/, REPO = /^[A-Za-z0-9._-]{1,100}$/;
const LEVEL: Record<string, number> = { read: 1, write: 2, admin: 3 };
// GitHub mints installation tokens for an hour, whatever tumbler asks.
export const GITHUB_TTL_MIN = 60;
const INSTALL_PAGES = 20;

// Read is granted on request (machine.ts autoApproved). Required: a save fails if the App lacks one.
export const DEFAULT_SCOPES: Record<string, string[]> = { "repo:read": ["contents:read", "metadata:read"] };
// Added when the installation has the permission, left out otherwise, so an App installed with
// fewer permissions still mints.
export const OPTIONAL_DEFAULTS: Record<string, string[]> = {
  "repo:read": ["pull_requests:read", "issues:read", "actions:read", "checks:read", "statuses:read"],
};

// The only permissions an operator may add (`tumbler scope add`); every other one stays with an
// admin. An allowlist because a denylist misses new or oddly named ones: secret_scanning_alerts
// returns the leaked credentials themselves, `variables` steers workflows.
const DELEGABLE = /^(actions|checks|contents|deployments|discussions|issues|metadata|packages|pages|pull_requests|repository_projects|statuses):/;

const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const der = (tag: number, body: Uint8Array) => {
  const n = body.length, len = n < 128 ? [n] : n < 256 ? [0x81, n] : n < 65536 ? [0x82, n >> 8, n & 255] : [0x83, n >> 16, (n >> 8) & 255, n & 255];
  return new Uint8Array([tag, ...len, ...body]);
};
// AlgorithmIdentifier { rsaEncryption, NULL }, which PKCS#8 puts around a PKCS#1 RSA key.
const RSA_ALG = new Uint8Array([0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00]);

// What an admin pasted (the PEM GitHub hands out, PKCS#1 or PKCS#8, or its base64 body) as the
// parent is stored: PKCS#8 DER in base64, one line, so it passes the parent's printable check.
// Never the value in an error.
export function canonicalKey(value: string): string {
  const armor = value.match(/-----BEGIN ([A-Z ]+)-----([\s\S]*?)-----END \1-----/);
  if (/-----BEGIN/.test(value) && !armor) throw new Refused(400, "the GitHub App key is not a whole PEM block");
  if (armor && !/^(RSA )?PRIVATE KEY$/.test(armor[1])) throw new Refused(400, "a GitHub App key is an RSA PRIVATE KEY or PRIVATE KEY PEM block");
  let bytes: Uint8Array;
  try { bytes = Uint8Array.from(atob((armor ? armor[2] : value).replace(/\s+/g, "")), (c) => c.charCodeAt(0)); }
  catch { throw new Refused(400, "the GitHub App key is not base64 PEM"); }
  // Both start SEQUENCE { INTEGER 0, ...}: PKCS#8 follows with the algorithm SEQUENCE, PKCS#1 with the modulus INTEGER.
  const at = bytes[1] & 0x80 ? 2 + (bytes[1] & 0x7f) : 2;
  if (bytes[0] !== 0x30 || bytes[at] !== 0x02 || bytes[at + 1] !== 0x01 || bytes[at + 2] !== 0x00) throw new Refused(400, "the GitHub App key is not an RSA private key");
  const next = bytes[at + 3];
  if (next === 0x02) bytes = der(0x30, new Uint8Array([0x02, 0x01, 0x00, ...RSA_ALG, ...der(0x04, bytes)]));
  else if (next !== 0x30) throw new Refused(400, "the GitHub App key is not an RSA private key");
  return btoa(String.fromCharCode(...bytes));
}

// A JWT for the App, signed with its key: what GitHub takes to list installations and mint tokens.
async function appJwt(parent: string, appId: unknown, now = Date.now()) {
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey("pkcs8", Uint8Array.from(atob(parent), (c) => c.charCodeAt(0)),
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  } catch { throw new Refused(400, "the GitHub App key could not be read as an RSA private key"); }
  const enc = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)));
  // Why iat a minute back: GitHub refuses a JWT issued "in the future" by a clock a little ahead.
  const t = Math.floor(now / 1000), body = `${enc({ alg: "RS256", typ: "JWT" })}.${enc({ iat: t - 60, exp: t + 540, iss: String(appId) })}`;
  return `${body}.${b64url(new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(body))))}`;
}

const rank = (perms: Record<string, string>, group: string) => {
  const [p, level] = group.split(":");
  return (LEVEL[perms[p]] ?? 0) >= LEVEL[level];
};

export function github(fetcher: typeof fetch = fetch): Provider {
  const call = async (method: string, path: string, jwt: string, body?: unknown) => {
    // Why the catch: a fetch error message can quote a header, and the JWT is one.
    const r = await fetcher(API + path, {
      method, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { authorization: `Bearer ${jwt}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "tumbler" },
    }).catch(() => { throw new Refused(502, `github ${method} ${path.split("/")[1]}: request failed`); });
    // Why: only the status reaches a caller, never GitHub's body.
    if (!r.ok) {
      await r.body?.cancel().catch(() => {});
      throw Object.assign(new Refused(502, `github ${method} ${path.replace(/\/\d+/g, "/:id")}: ${r.status}`), { ghStatus: r.status });
    }
    return r.json().catch(() => ({})) as Promise<any>;
  };
  const jwt = (parent: string, config: MintConfig) => appJwt(parent, config.app_id);
  // The installation's permissions, as GitHub grants them to the App there.
  const installed = async (parent: string, config: MintConfig): Promise<Record<string, string>> => {
    const j = await call("GET", `/app/installations/${config.installation_id}`, await jwt(parent, config));
    return j?.permissions && typeof j.permissions === "object" ? j.permissions : {};
  };
  const lacking = (perms: Record<string, string>, groups: string[]) => {
    const miss = groups.filter((g) => !rank(perms, g));
    if (miss.length) throw new Refused(400, `the GitHub App's installation lacks ${miss.join(", ")}; \`tumbler scope groups KEY\` lists what it has`);
  };
  return {
    canonical: canonicalKey,
    async prepare(parent, config, setting) {
      const c: MintConfig = { ...config };
      if (c.app_id === undefined || c.app_id === "") {
        c.app_id = (await setting("GITHUB_APP_ID"))?.trim();
        if (!c.app_id) throw new Refused(400, "no app id: save GITHUB_APP_ID as a static key, or set config.app_id");
      }
      if (!APP.test(String(c.app_id))) throw new Refused(400, "config.app_id must be the App's numeric id or client id");
      if (c.installation_id === undefined || c.installation_id === "") {
        const token = await jwt(parent, c), all: { id: number; account?: { login?: string } }[] = [];
        // Every page, so an owner past the first hundred installations is still found.
        for (let page = 1; page <= INSTALL_PAGES; page++) {
          const list = await call("GET", `/app/installations?per_page=100&page=${page}`, token).catch((e) => {
            if (e.ghStatus === 401) throw new Refused(400, "GitHub refused this App key (401); paste the private key of the App in config.app_id");
            throw e;
          });
          if (!Array.isArray(list)) break;
          all.push(...list);
          if (list.length < 100) break;
          if (page === INSTALL_PAGES) throw new Refused(400, `the App has over ${INSTALL_PAGES * 100} installations; set config.installation_id`);
        }
        const owner = typeof c.owner === "string" ? c.owner.toLowerCase() : null;
        const hits = owner ? all.filter((i) => i.account?.login?.toLowerCase() === owner) : all;
        if (hits.length !== 1) {
          const logins = all.map((i) => i.account?.login).filter(Boolean).join(", ") || "none";
          throw new Refused(400, `${hits.length ? "the App has several installations" : "no installation of the App"}${owner ? ` for ${c.owner}` : ""} (it is installed on: ${logins}); set config.owner or config.installation_id`);
        }
        c.installation_id = hits[0].id;
      }
      c.ttl_minutes ??= GITHUB_TTL_MIN;
      if (!c.scopes || !Object.keys(c.scopes).length || c.defaults === true) {
        // Checked here so a save fails loud; mint() reads DEFAULT_SCOPES again each time.
        lacking(await installed(parent, c), Object.values(DEFAULT_SCOPES).flat());
        return { ...c, defaults: true, scopes: DEFAULT_SCOPES, start: c.start ?? ["repo:read"] };
      }
      return c;
    },
    validate(config) {
      if (!APP.test(String(config.app_id ?? ""))) throw new Refused(400, "config.app_id must be the App's numeric id or client id");
      if (!/^[1-9][0-9]{0,15}$/.test(String(config.installation_id ?? ""))) throw new Refused(400, "config.installation_id must be the installation's numeric id");
      if (config.ttl_minutes !== undefined && Number(config.ttl_minutes) > GITHUB_TTL_MIN) {
        throw new Refused(400, `ttl_minutes can be at most ${GITHUB_TTL_MIN}: GitHub's tokens last an hour`);
      }
      if (config.owner !== undefined && !(typeof config.owner === "string" && /^[A-Za-z0-9-]{1,39}$/.test(config.owner))) {
        throw new Refused(400, "config.owner must be a GitHub account login");
      }
      const repos = config.repositories;
      if (repos !== undefined && !(Array.isArray(repos) && repos.length && repos.length <= 500 && repos.every((r) => typeof r === "string" && REPO.test(r)))) {
        throw new Refused(400, "config.repositories must list 1 to 500 repository names (no owner)");
      }
      const check = (where: string, s: string, groups: unknown) => {
        if (!Array.isArray(groups) || !groups.length || !groups.every((g) => typeof g === "string" && GROUP.test(g))) {
          throw new Refused(400, `${where}.${s} must list permissions as name:read or name:write (contents:read)`);
        }
        // Why: a `:read` scope is granted to every token on request (machine.ts autoApproved), so it carries reads only.
        const writes = s.endsWith(":read") ? groups.filter((g) => !g.endsWith(":read")) : [];
        if (writes.length) throw new Refused(400, `${where}.${s}: ${writes.join(", ")} isn't a read, and every token gets ${s}; put it in a write scope instead`);
      };
      for (const [s, groups] of Object.entries(config.defaults === true ? {} : config.scopes ?? {})) check("config.scopes", s, groups);
      for (const [s, groups] of Object.entries(config.extra ?? {})) {
        check("config.extra", s, groups);
        const bad = groups.filter((g) => !DELEGABLE.test(g));
        if (bad.length) throw new Refused(400, `config.extra.${s}: ${bad.join(", ")} can't be added from the CLI (only actions, checks, contents, deployments, discussions, issues, metadata, packages, pages, pull_requests, repository_projects and statuses can)`);
      }
    },
    async mint(parent, config, scopes, _expiresAt, _label) {
      const stored = (config.scopes ?? {}) as Record<string, string[]>, extra = config.extra ?? {};
      const onDefaults = config.defaults === true;
      let groups = scopes.flatMap((s) => [...((onDefaults ? DEFAULT_SCOPES : stored)[s] ?? []), ...(extra[s] ?? [])]);
      if (onDefaults) {
        const perms = await installed(parent, config);
        groups.push(...scopes.flatMap((s) => OPTIONAL_DEFAULTS[s] ?? []).filter((g) => rank(perms, g)));
      }
      groups = [...new Set(groups)];
      if (!groups.length) throw new Refused(400, "no permissions for these scopes");
      // Each permission at the highest level any group asks for.
      const permissions: Record<string, string> = {};
      for (const g of groups) { const [p, level] = g.split(":"); if (!permissions[p] || LEVEL[level] > LEVEL[permissions[p]]) permissions[p] = level; }
      const repos = Array.isArray(config.repositories) ? config.repositories : undefined;
      const j = await call("POST", `/app/installations/${config.installation_id}/access_tokens`, await jwt(parent, config),
        { permissions, ...(repos ? { repositories: repos } : {}) }).catch((e) => {
        if (e.ghStatus === 422) throw new Refused(400, "GitHub refused these permissions or repositories for the App's installation (422); `tumbler scope groups KEY` lists what it has");
        throw e;
      });
      if (typeof j?.token !== "string" || !j.token) throw new Refused(502, "github minted no token");
      // GitHub gives an installation token no id; this one only names the child in tumbler's rows.
      return { id: `gh-${crypto.randomUUID()}`, value: j.token };
    },
    async groups(parent, config, names) {
      const lower = names.map((n) => n.trim().toLowerCase());
      const bad = lower.filter((n) => !GROUP.test(n));
      if (bad.length) throw new Refused(400, `${bad.join(", ")}: name a permission as name:read or name:write (contents:read)`);
      const held = lower.filter((n) => !DELEGABLE.test(n));
      if (held.length) throw new Refused(403, `${held.join(", ")} can't be added from the CLI: only repository content, PR, issue and CI permissions can; an admin adds others to the key's config`);
      lacking(await installed(parent, config), lower);
      return lower;
    },
    // Each permission the installation has, at every level up to the one it has.
    async listGroups(parent, config): Promise<GroupInfo[]> {
      const perms = await installed(parent, config);
      return Object.entries(perms).flatMap(([p, level]) => ["read", "write"].filter((l) => LEVEL[l] <= (LEVEL[level] ?? 0)).map((l) => `${p}:${l}`))
        .map((name) => ({ name, scopes: ["installation"], delegable: DELEGABLE.test(name) })).sort((a, b) => a.name.localeCompare(b.name));
    },
    // Before a parent is saved: GitHub must accept the App's JWT for this installation.
    async verify(parent, config) {
      let token: string;
      try { token = await jwt(parent, config); } catch { return { status: "invalid", detail: "not an RSA private key" }; }
      try {
        const r = await fetcher(`${API}/app/installations/${config.installation_id}`, { redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS),
          headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "tumbler" } });
        await r.body?.cancel().catch(() => {});
        // Never GitHub's text in the detail: a fixed phrase only.
        if (r.status === 404) return { status: "invalid", detail: "the App has no such installation" };
        return byStatus(r.status);
      } catch { return { status: "error", detail: "could not check (request failed)" }; }
    },
    // GitHub revokes an installation token only when called with that token, never by an id, so
    // tumbler keeps the child sealed until this succeeds. Without it the delete stays queued.
    async revoke(_parent, _config, _childId, child) {
      if (!child) throw new Refused(502, "github: no child credential left to revoke with");
      const r = await fetcher(`${API}/installation/token`, { method: "DELETE", redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { authorization: `Bearer ${child}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "tumbler" } })
        .catch(() => { throw new Refused(502, "github DELETE /installation/token: request failed"); });
      await r.body?.cancel().catch(() => {});
      // 401: the token is already expired or revoked.
      if (r.status !== 204 && r.status !== 401 && !r.ok) throw new Refused(502, `github DELETE /installation/token: ${r.status}`);
    },
  };
}

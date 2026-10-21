// cloudflare.ts — the `mint:cloudflare` provider. The parent is an account-owned API token with
// Account API Tokens: Edit; each child is an account-owned token with only the grant's permission
// groups and an expiry. Config:
//   { "account_id": "…", "ttl_minutes": 30, "start": ["workers:read"],
//     "scopes": { "workers:read": ["<permission group id>"], "workers:write": ["<id>", "<id>"] },
//     "ip": ["203.0.113.0/24"] }   // optional: children only work from these CIDRs
// Permission group ids come from GET /accounts/{id}/tokens/permission_groups; names are cosmetic.
// Pasting only the parent is enough: prepare() takes account_id from the CLOUDFLARE_ACCOUNT_ID key,
// fills in DEFAULT_SCOPES, and turns any group named by name into its id using the parent itself.
import { Refused } from "./catalog.ts";
import type { MintConfig, Provider } from "./grants.ts";
import { byStatus, TIMEOUT_MS } from "./verify.ts";

const API = "https://api.cloudflare.com/client/v4";
const ACCOUNT = /^[0-9a-f]{32}$/, GROUP = /^[0-9a-f]{32}$/;

// Read is granted on request, write waits for an admin (machine.ts autoApproved).
export const DEFAULT_SCOPES: Record<string, string[]> = {
  "workers:read": ["Workers Scripts Read", "D1 Read", "Workers KV Storage Read", "Workers R2 Storage Read"],
  "workers:write": ["Workers Scripts Write", "D1 Write", "Workers KV Storage Write", "Workers R2 Storage Write"],
};

export function cloudflare(fetcher: typeof fetch = fetch): Provider {
  const call = async (method: string, path: string, parent: string, body?: unknown) => {
    // Why the catch: a fetch error message can quote a header, and the parent is one.
    const r = await fetcher(API + path, {
      method, body: body === undefined ? undefined : JSON.stringify(body),
      headers: { authorization: `Bearer ${parent}`, "content-type": "application/json" },
    }).catch(() => { throw new Refused(502, `cloudflare ${method} tokens: request failed`); });
    const j = await r.json().catch(() => ({})) as any;
    // Why: only the status and Cloudflare's error codes, never the body as a whole, reach a caller.
    if (!r.ok || j.success === false) {
      const codes = (j.errors ?? []).map((e: any) => e.code).filter(Boolean).join(",");
      throw Object.assign(new Refused(502, `cloudflare ${method} tokens: ${r.status}${codes ? ` (${codes})` : ""}`), { status404: r.status === 404, cfStatus: r.status });
    }
    return j.result;
  };
  // Whether `parent` is an active user-owned token, which account routes reject.
  const userToken = async (parent: string) => {
    const r = await fetcher(`${API}/user/tokens/verify`, { headers: { authorization: `Bearer ${parent}` }, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) })
      .catch(() => null);
    return !!r?.ok && (await r.json().catch(() => ({})) as any).result?.status === "active";
  };
  return {
    async prepare(parent, config, setting) {
      const c: MintConfig = { ...config };
      if (c.account_id === undefined || c.account_id === "") {
        c.account_id = (await setting("CLOUDFLARE_ACCOUNT_ID"))?.trim();
        if (!c.account_id) throw new Refused(400, "no account id: save CLOUDFLARE_ACCOUNT_ID as a static key, or set config.account_id");
      }
      if (!ACCOUNT.test(String(c.account_id))) throw new Refused(400, "config.account_id must be a 32-hex account id");
      if (!c.scopes || !Object.keys(c.scopes).length) { c.scopes = DEFAULT_SCOPES; c.start ??= ["workers:read"]; }
      const scopes = c.scopes as Record<string, unknown[]>;
      const named = Object.values(scopes).flat().some((g) => !GROUP.test(String(g)));
      if (!named) return c;
      // Why the parent: Account API Tokens Edit can list the account's permission groups, and an id
      // looked up here is one Cloudflare will accept when minting.
      const list = await call("GET", `/accounts/${c.account_id}/tokens/permission_groups`, parent).catch((e) => {
        if (e.cfStatus === 401 || e.cfStatus === 403) throw new Refused(400, `Cloudflare refused this token (${e.cfStatus}); paste an account-owned token with Account API Tokens: Edit on account ${c.account_id}`);
        throw e;
      }) as { id: string; name: string; scopes?: string[] }[];
      const byName = new Map((Array.isArray(list) ? list : [])
        .filter((g) => !g.scopes || g.scopes.includes("com.cloudflare.api.account"))
        .map((g) => [String(g.name).toLowerCase(), String(g.id)]));
      const unknown: string[] = [];
      c.scopes = Object.fromEntries(Object.entries(scopes).map(([s, groups]) => [s, (Array.isArray(groups) ? groups : []).map((g) => {
        if (GROUP.test(String(g))) return String(g);
        const id = byName.get(String(g).toLowerCase());
        if (!id) unknown.push(String(g));
        return id ?? "";
      })]));
      if (unknown.length) throw new Refused(400, `Cloudflare has no account permission named ${unknown.map((u) => JSON.stringify(u)).join(", ")}`);
      return c;
    },
    validate(config: MintConfig) {
      if (!ACCOUNT.test(String(config.account_id ?? ""))) throw new Refused(400, "config.account_id must be a 32-hex account id");
      for (const [s, ids] of Object.entries(config.scopes ?? {})) {
        if (!Array.isArray(ids) || !ids.length || !ids.every((i) => GROUP.test(String(i)))) {
          throw new Refused(400, `config.scopes.${s} must list permission group ids`);
        }
      }
      if (config.ip !== undefined && !(Array.isArray(config.ip) && config.ip.every((c) => typeof c === "string"))) {
        throw new Refused(400, "config.ip must be a list of CIDRs");
      }
    },
    async mint(parent, config, scopes, expiresAt, label) {
      const groups = [...new Set(scopes.flatMap((s) => (config.scopes as Record<string, string[]>)[s] ?? []))];
      if (!groups.length) throw new Refused(400, "no permission groups for these scopes");
      const result = await call("POST", `/accounts/${config.account_id}/tokens`, parent, {
        name: label.slice(0, 120),
        policies: [{
          effect: "allow",
          resources: { [`com.cloudflare.api.account.${config.account_id}`]: "*" },
          permission_groups: groups.map((id) => ({ id })),
        }],
        expires_on: expiresAt.toISOString().replace(/\.\d{3}Z$/, "Z"),
        ...(Array.isArray(config.ip) && config.ip.length ? { condition: { "request.ip": { in: config.ip } } } : {}),
      });
      if (!result?.id || !result?.value) throw new Refused(502, "cloudflare minted no token");
      return { id: String(result.id), value: String(result.value) };
    },
    // Before a parent is saved: Cloudflare must accept it as an active token on this account.
    async verify(parent, config) {
      if (!/^[\x21-\x7e]+$/.test(parent)) return { status: "invalid", detail: "not a printable token" };
      try {
        const r = await fetcher(`${API}/accounts/${config.account_id}/tokens/verify`,
          { headers: { authorization: `Bearer ${parent}` }, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
        const j = await r.json().catch(() => ({})) as any;
        const o = byStatus(r.status);
        // Why the second call: a user-owned token (My Profile > API Tokens) is rejected here even
        // when it works, and "rejected (401)" alone sends the admin looking for the wrong problem.
        if (r.status === 401 && await userToken(parent)) {
          return { status: "invalid", detail: "this is a user token; create an account-owned one under Manage Account > Account API Tokens" };
        }
        if (o.status !== "ok") return o;
        // Never Cloudflare's text in the detail: a fixed phrase only.
        return j.success !== false && j.result?.status === "active" ? o : { status: "invalid", detail: "token is not active" };
      } catch { return { status: "error", detail: "could not check (request failed)" }; }
    },
    async revoke(parent, config, childId) {
      try { await call("DELETE", `/accounts/${config.account_id}/tokens/${encodeURIComponent(childId)}`, parent); }
      catch (e) { if (!(e as any).status404) throw e; } // already gone
    },
  };
}

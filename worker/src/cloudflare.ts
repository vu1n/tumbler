// cloudflare.ts — the `mint:cloudflare` provider. The parent is an account-owned API token with
// Account API Tokens: Edit; each child is an account-owned token with only the grant's permission
// groups and an expiry. Config:
//   { "account_id": "…", "ttl_minutes": 30, "start": ["workers:read"],
//     "scopes": { "workers:read": ["<permission group id>"], "workers:write": ["<id>", "<id>"] },
//     "ip": ["203.0.113.0/24"] }   // optional: children only work from these CIDRs
// Permission group ids come from GET /accounts/{id}/tokens/permission_groups; names are cosmetic.
import { Refused } from "./catalog.ts";
import type { MintConfig, Provider } from "./grants.ts";

const API = "https://api.cloudflare.com/client/v4";
const ACCOUNT = /^[0-9a-f]{32}$/, GROUP = /^[0-9a-f]{32}$/;

export function cloudflare(fetcher: typeof fetch = fetch): Provider {
  const call = async (method: string, path: string, parent: string, body?: unknown) => {
    const r = await fetcher(API + path, {
      method, body: body === undefined ? undefined : JSON.stringify(body),
      headers: { authorization: `Bearer ${parent}`, "content-type": "application/json" },
    });
    const j = await r.json().catch(() => ({})) as any;
    // Why: only the status and Cloudflare's error codes, never the body as a whole, reach a caller.
    if (!r.ok || j.success === false) {
      const codes = (j.errors ?? []).map((e: any) => e.code).filter(Boolean).join(",");
      throw Object.assign(new Refused(502, `cloudflare ${method} tokens: ${r.status}${codes ? ` (${codes})` : ""}`), { status404: r.status === 404 });
    }
    return j.result;
  };
  return {
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
    async revoke(parent, config, childId) {
      try { await call("DELETE", `/accounts/${config.account_id}/tokens/${encodeURIComponent(childId)}`, parent); }
      catch (e) { if (!(e as any).status404) throw e; } // already gone
    },
  };
}

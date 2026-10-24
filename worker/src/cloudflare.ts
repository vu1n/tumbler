// cloudflare.ts — the `mint:cloudflare` provider. The parent is an account-owned API token with
// Account API Tokens: Edit; each child is an account-owned token with only the grant's permission
// groups and an expiry. Config:
//   { "account_id": "…", "ttl_minutes": 30, "start": ["workers:read"],
//     "scopes": { "workers:read": ["<permission group id>"], "workers:write": ["<id>", "<id>"] },
//     "ip": ["203.0.113.0/24"] }   // optional: children only work from these CIDRs
// Permission group ids come from GET /accounts/{id}/tokens/permission_groups; names are cosmetic.
// Pasting only the parent is enough: prepare() takes account_id from the CLOUDFLARE_ACCOUNT_ID key,
// marks the key `"defaults": true`, and turns any group named by name into its id using the parent.
// A defaults key mints from DEFAULT_SCOPES as the code has them now, looked up by name at each mint,
// so a change to them reaches saved keys with no re-save.
import { Refused } from "./catalog.ts";
import type { GroupInfo, MintConfig, Provider } from "./grants.ts";
import { byStatus, TIMEOUT_MS } from "./verify.ts";

const API = "https://api.cloudflare.com/client/v4";
const ACCOUNT = /^[0-9a-f]{32}$/, GROUP = /^[0-9a-f]{32}$/;

// Read is granted on request, write waits for an admin (machine.ts autoApproved).
export const DEFAULT_SCOPES: Record<string, string[]> = {
  "workers:read": ["Workers Scripts Read", "D1 Read", "Workers KV Storage Read", "Workers R2 Storage Read"],
  "workers:write": ["Workers Scripts Write", "D1 Write", "Workers KV Storage Write", "Workers R2 Storage Write"],
};
// Groups a defaults mint adds when the account lists one of the names (the first that matches), and
// leaves out otherwise: a name Cloudflare doesn't list here must never stop every mint, as a wrong
// "Containers Write" once did.
// Why Containers: `wrangler deploy` of a Worker with `containers` pushes its image through
// /accounts/{id}/containers/*, which Workers Scripts Write doesn't reach (403 on the push). The
// Containers API names "Workers Containers"; older accounts may list it under the other names.
// The rest are what wrangler commonly reaches beyond those, each under the names Cloudflare's docs
// give it ("Write" and older "Edit"). workers:read is granted to every token, so it takes metadata
// reads only; Workers Tail Read sits on workers:write because live logs can carry request data.
// Secrets Store Edit stays out: it can delete MASTER_KEY.
export const OPTIONAL_DEFAULTS: Record<string, string[][]> = {
  "workers:read": [["Workers Containers Read", "Cloudchamber Read", "Containers Read"],
    ["Queues Read"], ["Pages Read", "Cloudflare Pages Read"], ["Hyperdrive Read"], ["Vectorize Read"], ["Account Analytics Read"]],
  "workers:write": [["Workers Containers Write", "Cloudchamber Write", "Containers Write"],
    ["Queues Write", "Queues Edit"], ["Pages Write", "Cloudflare Pages Edit"], ["Hyperdrive Write", "Hyperdrive Edit"],
    ["Vectorize Write", "Vectorize Edit"], ["Workers Tail Read"]],
};

// DEFAULT_SCOPES before Containers, which keys saved then hold as ids: a key whose scopes resolve to
// exactly these follows the live defaults too, so it needs no re-save.
const LEGACY_DEFAULTS: Record<string, string[]> = {
  "workers:read": ["Workers Scripts Read", "D1 Read", "Workers KV Storage Read", "Workers R2 Storage Read"],
  "workers:write": ["Workers Scripts Write", "D1 Write", "Workers KV Storage Write", "Workers R2 Storage Write"],
};

// Groups an operator may never add (`tumbler scope add`): a child holding one could make tokens,
// members or billing changes, which would let an agent widen its own reach past this broker.
const UNDELEGABLE = /api tokens|memberships?|account settings|billing/i;
const ACCOUNT_SCOPE = "com.cloudflare.api.account";

// Up to three listed names that share a product word with `name`, so a refusal names the real group.
// Why: Cloudflare's docs list names an account may not (#36 took "Containers Read" from them).
const near = (name: string, listed: string[]) => {
  const words = (s: string) => s.toLowerCase().split(/\s+/).filter((w) => w && !/^(read|write|edit|run)$/.test(w));
  const want = new Set(words(name)), level = name.toLowerCase().split(/\s+/).at(-1);
  return listed.map((n) => ({ n, score: words(n).filter((w) => want.has(w)).length * 2 + (n.toLowerCase().endsWith(` ${level}`) ? 1 : 0) }))
    .filter((c) => c.score >= 2).sort((a, b) => b.score - a.score || a.n.localeCompare(b.n)).slice(0, 3).map((c) => c.n);
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
  // Every permission group the parent can list, with its scopes.
  const listed = async (parent: string, account: unknown) => {
    // Why the parent: Account API Tokens Edit can list the account's permission groups, and an id
    // looked up here is one Cloudflare will accept when minting.
    const list = await call("GET", `/accounts/${account}/tokens/permission_groups`, parent).catch((e) => {
      if (e.cfStatus === 401 || e.cfStatus === 403) throw new Refused(400, `Cloudflare refused this token (${e.cfStatus}); paste an account-owned token with Account API Tokens: Edit on account ${account}`);
      throw e;
    }) as { id: string; name: string; scopes?: string[] }[];
    return (Array.isArray(list) ? list : []).map((g) => ({ id: String(g.id), name: String(g.name), scopes: Array.isArray(g.scopes) ? g.scopes.map(String) : undefined }));
  };
  // The account-scoped groups' ids by lowercase name, and their names as Cloudflare spells them.
  const groupIds = async (parent: string, account: unknown) => {
    const groups = (await listed(parent, account)).filter((g) => !g.scopes || g.scopes.includes(ACCOUNT_SCOPE));
    return Object.assign(new Map(groups.map((g) => [g.name.toLowerCase(), g.id])), { spelled: groups.map((g) => g.name) });
  };
  const unknownNames = (byName: Map<string, string> & { spelled: string[] }, names: string[]) => {
    const unknown = names.filter((n) => !byName.has(n.toLowerCase()));
    if (!unknown.length) return;
    const hints = unknown.map((u) => [u, near(u, byName.spelled)] as const).filter(([, n]) => n.length)
      .map(([u, n]) => `for ${JSON.stringify(u)} it lists ${n.map((x) => JSON.stringify(x)).join(", ")}`);
    throw new Refused(400, `Cloudflare has no account permission named ${unknown.map((u) => JSON.stringify(u)).join(", ")}${hints.length ? ` (${hints.join("; ")})` : ""}; \`tumbler scope groups KEY\` lists them`);
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
      // A rotation passes the stored config back in, marker and all: it stays on the defaults.
      if (!c.scopes || !Object.keys(c.scopes).length || c.defaults === true) {
        // Names, not ids: mint() looks DEFAULT_SCOPES up again each time. Checked here so a save fails loud.
        unknownNames(await groupIds(parent, c.account_id), Object.values(DEFAULT_SCOPES).flat());
        return { ...c, defaults: true, scopes: DEFAULT_SCOPES, start: c.start ?? ["workers:read"] };
      }
      const scopes = c.scopes as Record<string, unknown[]>;
      const named = Object.values(scopes).flat().some((g) => !GROUP.test(String(g)));
      if (!named) return c;
      const byName = await groupIds(parent, c.account_id);
      unknownNames(byName, Object.values(scopes).flat().map(String).filter((g) => !GROUP.test(g)));
      c.scopes = Object.fromEntries(Object.entries(scopes).map(([s, groups]) => [s, (Array.isArray(groups) ? groups : [])
        .map((g) => GROUP.test(String(g)) ? String(g) : byName.get(String(g).toLowerCase())!)]));
      return c;
    },
    validate(config: MintConfig) {
      if (!ACCOUNT.test(String(config.account_id ?? ""))) throw new Refused(400, "config.account_id must be a 32-hex account id");
      for (const [s, ids] of Object.entries(config.defaults === true ? {} : config.scopes ?? {})) {
        if (!Array.isArray(ids) || !ids.length || !ids.every((i) => GROUP.test(String(i)))) {
          throw new Refused(400, `config.scopes.${s} must list permission group ids`);
        }
      }
      for (const [s, names] of Object.entries((config.extra ?? {}) as Record<string, string[]>)) {
        const bad = names.filter((n) => UNDELEGABLE.test(n) || GROUP.test(n));
        if (bad.length) throw new Refused(400, `config.extra.${s}: ${bad.join(", ")} can't be added from the CLI (use permission names; token, member, account settings and billing groups stay with /admin)`);
        // Why: a `:read` scope is granted to every token on request (machine.ts autoApproved), so it carries reads only.
        const writes = s.endsWith(":read") ? names.filter((n) => !/ read$/i.test(n)) : [];
        if (writes.length) throw new Refused(400, `config.extra.${s}: ${writes.join(", ")} isn't a read, and every token gets ${s}; add it to a write scope instead`);
      }
      if (config.ip !== undefined && !(Array.isArray(config.ip) && config.ip.every((c) => typeof c === "string"))) {
        throw new Refused(400, "config.ip must be a list of CIDRs");
      }
    },
    async mint(parent, config, scopes, expiresAt, label) {
      const stored = (config.scopes ?? {}) as Record<string, string[]>;
      let byName: Awaited<ReturnType<typeof groupIds>> | undefined;
      const lookup = async () => byName ??= await groupIds(parent, config.account_id);
      const legacy = async () => {
        const keys = Object.keys(stored).sort();
        if (keys.join() !== Object.keys(LEGACY_DEFAULTS).sort().join()) return false;
        if (!keys.every((k) => Array.isArray(stored[k]) && stored[k].length === LEGACY_DEFAULTS[k].length)) return false;
        // Why the catch: this only widens a key to the defaults; if the lookup fails it keeps its stored ids.
        const m = await lookup().catch(() => undefined);
        if (!m) return false;
        const same = (a: string[], b: string[]) => [...a].sort().join() === [...b].sort().join();
        return keys.every((k) => Array.isArray(stored[k]) && same(stored[k], LEGACY_DEFAULTS[k].map((n) => m.get(n.toLowerCase()) ?? "")));
      };
      const onDefaults = config.defaults === true || await legacy();
      const extra = (config.extra ?? {}) as Record<string, string[]>;
      let groups = [...new Set(scopes.flatMap((s) => [...((onDefaults ? DEFAULT_SCOPES : stored)[s] ?? []), ...(extra[s] ?? [])]))];
      if (onDefaults) {
        const m = await lookup();
        for (const choices of scopes.flatMap((s) => OPTIONAL_DEFAULTS[s] ?? [])) {
          const name = choices.find((n) => m.has(n.toLowerCase()));
          if (name) groups.push(name);
        }
        groups = [...new Set(groups)];
      }
      // Names (the defaults, an operator's additions) are looked up now; ids are used as stored.
      const names = groups.filter((g) => !GROUP.test(g));
      if (names.length) {
        const m = await lookup();
        unknownNames(m, names);
        groups = [...new Set(groups.map((g) => GROUP.test(g) ? g : m.get(g.toLowerCase())!))];
      }
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
    async groups(parent, config, names) {
      const bad = names.filter((n) => UNDELEGABLE.test(n));
      if (bad.length) throw new Refused(403, `${bad.join(", ")} can't be added from the CLI: a child with it could make tokens, members or billing changes. An admin adds it to the key's config in /admin`);
      const m = await groupIds(parent, config.account_id), spelled = new Map(m.spelled.map((n) => [n.toLowerCase(), n]));
      unknownNames(m, names);
      return names.map((n) => spelled.get(n.toLowerCase())!);
    },
    // All of them, zone and other scopes included: a group the mint can't use still explains a
    // name that "doesn't exist" (it may be listed under another scope).
    async listGroups(parent, config): Promise<GroupInfo[]> {
      return (await listed(parent, config.account_id)).map((g) => ({ name: g.name, scopes: g.scopes ?? [],
        delegable: !UNDELEGABLE.test(g.name) && (!g.scopes || g.scopes.includes(ACCOUNT_SCOPE)) }))
        .sort((a, b) => a.name.localeCompare(b.name));
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

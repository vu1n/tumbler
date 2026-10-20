// app.ts — routes, apart from index.ts so tests can drive them without Worker bindings.
import { Catalog, GLOBAL, Refused } from "./catalog.ts";
import { ADMIN_HTML } from "./admin.ts";

export interface Deps { catalog: Catalog; admin: (request: Request) => Promise<string | null>; cli?: string }

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json", "cache-control": "no-store" },
});
const bearer = (r: Request) => /^Bearer\s+(\S+)$/i.exec(r.headers.get("authorization") ?? "")?.[1] ?? null;

export async function handle(request: Request, deps: Deps): Promise<Response> {
  try {
    const url = new URL(request.url), path = url.pathname;
    // The CLI itself is public (it holds no secrets), so a setup script can fetch it before the
    // agent proxy is up: curl -fsSL "$TUMBLER_URL/cli" -o /usr/local/bin/tumbler
    if (path === "/cli" && deps.cli) return new Response(deps.cli, { headers: { "content-type": "text/plain; charset=utf-8" } });
    if (path.startsWith("/v1/")) return await agentRoute(request, url, deps);
    if (path === "/admin" || path.startsWith("/admin/")) return await adminRoute(request, url, deps);
    return new Response("not found", { status: 404 });
  } catch (e) {
    if (e instanceof Refused) return json({ error: e.message }, e.status);
    console.error("tumbler", (e as Error).message); // never the request body: it may carry a value
    return json({ error: "internal error" }, 500);
  }
}

async function agentRoute(request: Request, url: URL, { catalog }: Deps) {
  const token = bearer(request), caller = token ? await catalog.caller(token) : null;
  if (!caller) return json({ error: "unauthorized" }, 401);
  if (request.method !== "GET") return json({ error: "method not allowed" }, 405);
  if (url.pathname === "/v1/whoami") return json({ name: caller.name, projects: caller.projects });
  if (url.pathname === "/v1/env") {
    const names = (url.searchParams.get("keys") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    return json({ env: await catalog.resolve(caller, url.searchParams.get("project"), names) });
  }
  return json({ error: "not found" }, 404);
}

async function adminRoute(request: Request, url: URL, { catalog, admin }: Deps) {
  const who = await admin(request);
  if (!who) return new Response("forbidden", { status: 403 });
  const path = url.pathname, m = request.method;
  if (path === "/admin" || path === "/admin/") {
    return new Response(ADMIN_HTML, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'" } });
  }
  // Why: Access authenticates by cookie, so a cross-site form could ride it. A custom header can't
  // be sent cross-origin without a preflight this Worker never answers.
  if (m !== "GET" && request.headers.get("x-tumbler-admin") !== "1") return json({ error: "missing x-tumbler-admin header" }, 400);
  const parts = path.split("/").filter(Boolean).slice(2).map(decodeURIComponent); // after /admin/api
  if (!path.startsWith("/admin/api/")) return json({ error: "not found" }, 404);
  const body = async () => (m === "GET" || m === "DELETE" ? {} : await request.json().catch(() => ({}))) as Record<string, any>;

  if (parts[0] === "keys") {
    if (m === "GET" && parts.length === 1) return json({ keys: await catalog.list() });
    if (parts.length === 3) {
      const [, scope, name] = parts;
      if (m === "PUT") {
        const b = await body();
        await catalog.put(scope, name, String(b.value ?? ""), { description: b.description, owner: b.owner, expires_at: b.expires_at ?? null });
        await catalog.audit(who, "put", scope === GLOBAL ? null : scope, [name]);
        return json({ ok: true });
      }
      if (m === "DELETE") {
        await catalog.remove(scope, name);
        await catalog.audit(who, "delete", scope === GLOBAL ? null : scope, [name]);
        return json({ ok: true });
      }
    }
  }
  if (parts[0] === "tokens") {
    if (m === "GET" && parts.length === 1) return json({ tokens: await catalog.tokens() });
    if (m === "POST" && parts.length === 1) {
      const b = await body();
      const projects = Array.isArray(b.projects) && b.projects.length ? b.projects.map(String) : null;
      const token = await catalog.createToken(String(b.name ?? ""), projects);
      await catalog.audit(who, "token-create", null, [String(b.name)]);
      return json({ name: b.name, token }); // shown once
    }
    if (m === "DELETE" && parts.length === 2) {
      await catalog.revokeToken(parts[1]);
      await catalog.audit(who, "token-revoke", null, [parts[1]]);
      return json({ ok: true });
    }
  }
  if (parts[0] === "audit" && m === "GET") return json({ audit: await catalog.recentAudit() });
  return json({ error: "not found" }, 404);
}

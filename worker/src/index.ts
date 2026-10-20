// index.ts — the Worker entry: binds D1, the Secrets Store master key and the Access config.
import { accessAdmin } from "./access.ts";
import { handle } from "./app.ts";
import { Catalog } from "./catalog.ts";
import { masterKey } from "./crypto.ts";
// Bundled as text by the "rules" entry in wrangler.jsonc.
import CLI from "../../cli/tumbler";

export interface Env {
  DB: D1Database;
  // A Secrets Store binding in production; a plain string from .dev.vars works for `wrangler dev`.
  MASTER_KEY: { get(): Promise<string> } | string;
  ACCESS_TEAM_DOMAIN: string; // e.g. "vu1n.cloudflareaccess.com"
  ACCESS_AUD: string;         // the Access application's AUD tag
  TUMBLER_ADMINS: string;     // comma-separated emails allowed into /admin
}

let key: { raw: string; key: CryptoKey } | null = null;
async function loadKey(env: Env) {
  const raw = typeof env.MASTER_KEY === "string" ? env.MASTER_KEY : await env.MASTER_KEY.get();
  if (!key || key.raw !== raw) key = { raw, key: await masterKey(raw) };
  return key.key;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const catalog = new Catalog(env.DB, await loadKey(env));
    const admins = (env.TUMBLER_ADMINS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    return handle(request, {
      catalog,
      cli: CLI,
      admin: (r) => accessAdmin(r, { teamDomain: env.ACCESS_TEAM_DOMAIN, aud: env.ACCESS_AUD, admins }),
    });
  },
};

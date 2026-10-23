// index.ts — the Worker entry: binds D1, the Secrets Store master key and the Access config.
import { accessAdmin } from "./access.ts";
import { handle } from "./app.ts";
import { Catalog } from "./catalog.ts";
import { masterKey } from "./crypto.ts";
import { s1Client } from "./auto.ts";
import { cloudflare } from "./cloudflare.ts";
import { Grants } from "./grants.ts";
import { Asks, huddlesClient } from "./asks.ts";
// Bundled as text by the "rules" entry in wrangler.jsonc.
import CLI from "../../cli/tumbler";
import SETUP from "../../scripts/setup.sh";

export interface Env {
  DB: D1Database;
  // A Secrets Store binding in production; a plain string from .dev.vars works for `wrangler dev`.
  MASTER_KEY: { get(): Promise<string> } | string;
  ACCESS_TEAM_DOMAIN: string; // e.g. "vu1n.cloudflareaccess.com"
  ACCESS_AUD: string;         // the Access application's AUD tag
  TUMBLER_ADMINS: string;     // comma-separated emails allowed into /admin
  AI?: Ai;                    // Workers AI, for Clef in /v1/auto; without it auto uses rules only
  TUMBLER_AUTO_MODEL?: string; // "clef" (default) or "clef-flash"
  // Approvals in Huddles (asks.ts): a delegate credential of the member who approves, as a Worker
  // secret. Without it, approvals are in /admin only. HUDDLES_ROOM picks the room its asks go to;
  // without it, tumbler makes its own.
  HUDDLES_TOKEN?: string;
  HUDDLES_ROOM?: string;
  HUDDLES_URL?: string;       // default https://huddles.dev
  HUDDLES_APPROVER?: string;  // the approver's Huddles user id; asks stop if the credential acts for anyone else
}

function grantsFor(env: Env, catalog: Catalog) {
  const grants = new Grants(catalog, providers);
  if (env.HUDDLES_TOKEN) {
    new Asks(grants, huddlesClient({ url: env.HUDDLES_URL || "https://huddles.dev", token: env.HUDDLES_TOKEN }), env.HUDDLES_ROOM || undefined, env.HUDDLES_APPROVER || undefined);
  }
  return grants;
}

let key: { raw: string; key: CryptoKey } | null = null;
async function loadKey(env: Env) {
  const raw = typeof env.MASTER_KEY === "string" ? env.MASTER_KEY : await env.MASTER_KEY.get();
  if (!key || key.raw !== raw) key = { raw, key: await masterKey(raw) };
  return key.key;
}

const providers = { cloudflare: cloudflare() };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const catalog = new Catalog(env.DB, await loadKey(env));
    const grants = grantsFor(env, catalog);
    const admins = (env.TUMBLER_ADMINS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    return handle(request, {
      catalog,
      grants,
      cli: CLI,
      setup: SETUP,
      s1: s1Client(env.AI, env.TUMBLER_AUTO_MODEL || "clef"),
      admin: (r) => accessAdmin(r, { teamDomain: env.ACCESS_TEAM_DOMAIN, aud: env.ACCESS_AUD, admins }),
    });
  },
  // Expire grants whose children are past expiry (and delete those children at the provider),
  // and lapse requests nobody answered. The cron is in wrangler.jsonc.
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(grantsFor(env, new Catalog(env.DB, await loadKey(env))).sweep());
  },
};

// verify.ts — test a key's value against the service it is for: before a new value is saved (a failure
// saves nothing and the old value stays), and on demand for `tumbler run`'s failure report.
// A minted key is checked by its provider's verify(). A static key is checked only when its config
// names one: a built-in preset, or a custom https endpoint and the header the value goes in.
//   { "check": "openai" }
//   { "check": { "url": "https://api.example.com/v1/me", "header": "authorization", "prefix": "Bearer " } }
// An outcome is a status and an HTTP code, never a response body or the value.
import { Refused } from "./catalog.ts";

export type Outcome =
  | { status: "ok" }
  | { status: "invalid"; detail: string } // the service rejected the value (401/403)
  | { status: "error"; detail: string }   // the check couldn't tell: unreachable, 5xx, rate limited
  | { status: "none" };                   // no check for this key

export interface StaticCheck { url: string; header: string; prefix?: string; headers?: Record<string, string> }

// Endpoints that answer 2xx for any valid key and 401/403 for a bad one, and change nothing.
export const PRESETS: Record<string, StaticCheck> = {
  anthropic: { url: "https://api.anthropic.com/v1/models?limit=1", header: "x-api-key", headers: { "anthropic-version": "2023-06-01" } },
  openai: { url: "https://api.openai.com/v1/models", header: "authorization", prefix: "Bearer " },
  github: { url: "https://api.github.com/user", header: "authorization", prefix: "Bearer ", headers: { "user-agent": "tumbler" } },
  stripe: { url: "https://api.stripe.com/v1/balance", header: "authorization", prefix: "Bearer " },
  // User-owned tokens; an account-owned one needs a custom check on /accounts/{id}/tokens/verify.
  cloudflare: { url: "https://api.cloudflare.com/client/v4/user/tokens/verify", header: "authorization", prefix: "Bearer " },
};

const HEADER = /^[A-Za-z0-9-]{1,64}$/, PRINTABLE = /^[\x20-\x7e]*$/, TOKEN = /^[\x21-\x7e]+$/;
export const TIMEOUT_MS = 10_000;

// The check a static key's config names, validated; null when it names none.
export function staticCheck(config: Record<string, unknown>): StaticCheck | null {
  for (const k of Object.keys(config)) if (k !== "check") throw new Refused(400, `a static key's config takes only "check", not ${k}`);
  const c = config.check;
  if (c === undefined || c === null) return null;
  if (typeof c === "string") {
    if (!PRESETS[c]) throw new Refused(400, `unknown check ${c}; use one of ${Object.keys(PRESETS).join(", ")} or {url, header, prefix}`);
    return PRESETS[c];
  }
  if (typeof c !== "object" || Array.isArray(c)) throw new Refused(400, "config.check must be a preset name or {url, header, prefix}");
  const { url, header, prefix = "", headers = {} } = c as Record<string, any>;
  let u: URL;
  try { u = new URL(String(url)); } catch { throw new Refused(400, "config.check.url must be a URL"); }
  // Why https only: the check sends the value; it must not cross the network in the clear.
  if (u.protocol !== "https:") throw new Refused(400, "config.check.url must be https");
  if (!HEADER.test(String(header))) throw new Refused(400, "config.check.header must be a header name");
  if (typeof prefix !== "string" || !PRINTABLE.test(prefix) || prefix.length > 32) throw new Refused(400, "config.check.prefix must be short printable text");
  if (typeof headers !== "object" || !Object.entries(headers).every(([k, v]) => HEADER.test(k) && typeof v === "string" && PRINTABLE.test(v))) {
    throw new Refused(400, "config.check.headers must map header names to printable text");
  }
  return { url: u.toString(), header: String(header), prefix, headers };
}

// Classify an HTTP status the same way for every check.
export const byStatus = (status: number): Outcome =>
  status >= 200 && status < 300 ? { status: "ok" }
    : status === 401 || status === 403 ? { status: "invalid", detail: `rejected (${status})` }
    : status >= 300 && status < 400 ? { status: "error", detail: `could not check (redirected, ${status})` }
    : { status: "error", detail: `could not check (${status})` };

export async function runCheck(check: StaticCheck, value: string, fetcher: typeof fetch = fetch): Promise<Outcome> {
  // Why: the value goes in a header, and a runtime that rejects a header value may quote it.
  if (!TOKEN.test(value)) return { status: "invalid", detail: "not a printable token, so it can't go in a header" };
  try {
    const r = await fetcher(check.url, {
      headers: { ...check.headers, [check.header]: (check.prefix ?? "") + value }, signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: "manual", // a redirect would resend the value to wherever it points, https or not
    });
    await r.body?.cancel().catch(() => {});
    return byStatus(r.status);
  } catch { return { status: "error", detail: "could not check (request failed)" }; } // never the error: it can quote a header
}

export interface Verifiers { providers: Record<string, { verify?(value: string, config: Record<string, unknown>): Promise<Outcome> }>; fetcher?: typeof fetch }

// The check for a key of `kind` with `config`, run on `value`.
export async function checkKey(kind: string, config: Record<string, unknown>, value: string, v: Verifiers): Promise<Outcome> {
  if (kind === "static") {
    const c = staticCheck(config);
    return c ? runCheck(c, value, v.fetcher) : { status: "none" };
  }
  const p = kind.startsWith("mint:") ? v.providers[kind.slice(5)] : undefined;
  return p?.verify ? p.verify(value, config) : { status: "none" };
}

// alerts.ts — tell a person when a caller token does what a probing agent would: read many values in
// one call, make a token, or widen a minted key's permissions. Names out, never values.

export interface Alert { kind: "bulk-read" | "token-create" | "scope-change"; actor: string; project: string | null; names: string[]; at: string }

// One read of this many keys or more is an alert: `tumbler run` names what a repo needs (.tumbler), so a
// read of everything a token reaches is what a script dumping secrets looks like.
export const BULK_READ = 10;

// The audit row an alert answers, or null. An admin (an Access email, never a caller token) is the
// person the alert would go to, so their own actions never alert.
export function alarming(actor: string, action: string, project: string | null, names: string[], at: string): Alert | null {
  if (actor.includes("@")) return null;
  const kind = action === "read" && names.length >= BULK_READ ? "bulk-read"
    : action === "token-create" ? "token-create"
    : action === "mint-scope" ? "scope-change"
    : null;
  return kind ? { kind, actor, project, names, at } : null;
}

const SUMMARY: Record<Alert["kind"], string> = {
  "bulk-read": "read many keys in one call",
  "token-create": "created a token",
  "scope-change": "changed a minted key's permission groups",
};

// POSTs each alert as JSON to the webhook (a `text` line for Slack-style hooks, the fields for
// anything else), in the background: an alert never slows or fails the request that raised it.
export function webhookAlerts(url: string | undefined, wait: (p: Promise<unknown>) => void, fetcher: typeof fetch = fetch) {
  if (!url) return undefined;
  return (a: Alert) => wait(fetcher(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ source: "tumbler", text: `tumbler: token ${a.actor} ${SUMMARY[a.kind]}${a.project ? ` in ${a.project}` : ""}: ${a.names.join(", ")}`, ...a }),
  }).then((r) => { if (!r.ok) console.error("tumbler: alert webhook refused", r.status); },
    (e) => console.error("tumbler: alert webhook failed", e instanceof Error ? e.name : "error")));
}

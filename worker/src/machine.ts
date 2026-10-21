// machine.ts — the grant state machine as one pure function. Every change to a grant's state is an
// event; transition() decides what the event makes of the grant, or refuses it (null). grants.ts
// writes the result with a compare-and-set on the state it read and appends the event to
// grant_events in the same transaction, so the log and the table never disagree.
//
//   (none) ──open──▶ pending ──mint──▶ active ──expire/revoke──▶ expired | revoked
//                      │ └──deny/lapse──▶ denied      │ └─step_up─▶ active + requested
//                      └──abandon──▶ expired           └─mint (approve)─▶ active, wider child
//
// No I/O, no clock: the time an event happens is part of the event.

export interface GrantState {
  state: string; scopes: string[]; requested: string[] | null; requested_at: string | null;
  child_id: string | null; expires_at: string | null; decided_by: string | null;
}

export type GrantEvent =
  | { type: "open"; scopes: string[]; at: string; who: string }
  | { type: "mint"; scopes: string[]; child_id: string; expires_at: string; who: string }
  | { type: "step_up"; scopes: string[]; at: string; who: string }
  | { type: "deny"; who: string }
  | { type: "lapse"; who: string }       // nobody answered within PENDING_TTL
  | { type: "abandon"; who: string }     // a read claim whose mint died or failed; nothing was minted
  | { type: "expire"; who: string }
  | { type: "revoke"; who: string };

// Why here and not in grants.ts: the approval line is part of the machine, so a mint the policy
// makes on its own can never carry a scope an admin had to approve.
export const autoApproved = (scope: string) => scope.endsWith(":read");

export const isLive = (state: string) => state === "pending" || state === "active";
const sorted = (a: string[]) => [...new Set(a)].sort();
const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
const ended = (g: GrantState, state: string, who: string): GrantState =>
  ({ ...g, state, requested: null, requested_at: null, decided_by: who });

export function transition(g: GrantState | null, e: GrantEvent): GrantState | null {
  if (!g) {
    if (e.type !== "open" || !e.scopes.length) return null;
    return { state: "pending", scopes: [], requested: sorted(e.scopes), requested_at: e.at, child_id: null, expires_at: null, decided_by: null };
  }
  if (!isLive(g.state)) return null; // denied, expired and revoked are final
  switch (e.type) {
    case "open": return null;
    case "mint": {
      const scopes = sorted(e.scopes), held = new Set(g.scopes);
      if (!scopes.length) return null;
      // A mint answers the request when there is one, exactly as it stands (approve passes what the
      // admin saw; decide() refuses a mismatch first).
      if (g.requested) { if (!same(scopes, g.requested)) return null; }
      else if (g.state === "pending") return null;
      // Without an admin, nothing beyond held or read scopes.
      if (e.who === "policy" && !scopes.every((s) => held.has(s) || autoApproved(s))) return null;
      return { ...g, state: "active", scopes, requested: null, requested_at: null, child_id: e.child_id, expires_at: e.expires_at, decided_by: e.who };
    }
    case "step_up": {
      if (!e.scopes.length) return null;
      if (g.state === "pending") return { ...g, requested: sorted([...(g.requested ?? []), ...e.scopes]) };
      const want = sorted([...g.scopes, ...(g.requested ?? []), ...e.scopes]);
      if (same(want, g.scopes)) return null; // nothing new: callers check this first
      // Why requested_at is kept once set: asking again can't keep a request from lapsing.
      return { ...g, requested: want, requested_at: g.requested_at ?? e.at };
    }
    case "deny":
    case "lapse": {
      if (!g.requested) return null;
      // A pending grant ends; an active one keeps its narrower child and drops the request.
      return g.state === "pending" ? ended(g, "denied", e.who) : { ...g, requested: null, requested_at: null, decided_by: e.who };
    }
    case "abandon": return g.state === "pending" && !g.child_id ? ended(g, "expired", e.who) : null;
    case "expire": return ended(g, "expired", e.who);
    case "revoke": return ended(g, "revoked", e.who);
  }
}

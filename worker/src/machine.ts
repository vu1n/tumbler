// machine.ts — the grant state machine as one pure function. Every change to a grant's state is an
// event; transition() decides what the event makes of the grant, or refuses it (null). grants.ts
// writes the result with a compare-and-set on the state it read and appends the event to
// grant_events in the same transaction, so the log and the table never disagree.
//
//   (none) ──open──▶ pending ──mint──▶ active ──expire/revoke──▶ expired | revoked
//                      │ └──lapse──▶ denied           └─mint─▶ active, wider child
//                      └──abandon──▶ expired
//
// A grant is pending only while its first child is being minted. Nothing waits for a person: a
// token's scopes (its ceiling) are the approval, and a scope outside them is refused before any
// event. deny, step_up and lapse remain for grants written before that, which the sweep lapses.
//
// No I/O, no clock: the time an event happens is part of the event.

export interface GrantState {
  state: string; scopes: string[]; requested: string[] | null; requested_at: string | null;
  child_id: string | null; expires_at: string | null; decided_by: string | null;
}

export type GrantEvent =
  | { type: "open"; scopes: string[]; at: string; who: string }
  // `approved`: what the caller token's scopes (its ceiling) allow when the mint is made.
  | { type: "mint"; scopes: string[]; child_id: string; expires_at: string; who: string; approved?: string[] }
  | { type: "step_up"; scopes: string[]; at: string; who: string }
  | { type: "deny"; who: string }
  | { type: "lapse"; who: string }       // nobody answered within PENDING_TTL
  | { type: "abandon"; who: string }     // a read claim whose mint died or failed; nothing was minted
  | { type: "expire"; who: string }
  | { type: "revoke"; who: string };

// Why here and not in grants.ts: the line is part of the machine, so a mint can never carry a
// scope beyond reads and what the caller's token allows.
export const autoApproved = (scope: string) => scope.endsWith(":read");

// Whether a token's scopes allow `scope`: every read, and whatever the token names (`*`: any).
export const allowedBy = (ceiling: string[] | null, scope: string) =>
  autoApproved(scope) || !!ceiling && (ceiling.includes(scope) || ceiling.includes("*"));

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
      const scopes = sorted(e.scopes);
      if (!scopes.length) return null;
      // A pending grant's first mint is for exactly what it was opened with.
      if (g.requested) { if (!same(scopes, g.requested)) return null; }
      else if (g.state === "pending") return null;
      // Nothing beyond reads and what the caller's token allowed when this was minted.
      const approved = new Set(e.approved ?? []);
      if (!scopes.every((s) => autoApproved(s) || approved.has(s))) return null;
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

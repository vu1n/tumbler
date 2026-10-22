// asks.ts — approvals in Huddles. A grant waiting for approval is posted as an ask to the Needs you
// of the member tumbler's Huddles credential acts for, and their answer there decides it the way
// Approve or Deny in /admin does.
//
// The line: only that person approves. Huddles refuses an answer to a person's ask from anyone but
// that person (agents and delegates included), and tumbler checks it again on what it reads back
// with its own credential: the answer must be to the ask it posted for this grant, by that human,
// and approval mints only the request the ask showed (decide()'s `expected`). Text in the room
// approves nothing. Any failure here leaves the grant waiting, and /admin still decides it.
import { Refused } from "./catalog.ts";
import { errorClass, type Approver, type GrantRow, type Grants, PENDING_TTL_MS } from "./grants.ts";
import { isLive } from "./machine.ts";

export interface HuddlesConfig { url: string; token: string }
// One `/net/v1` route: POST the body, return the JSON. Throws on a non-2xx status.
export type HuddlesCall = (route: string, body: unknown) => Promise<any>;

// The answer chips in Needs you, and the standing approval each one makes (minutes; -1 denies).
export const CHOICES: Record<string, number> = {
  "Approve for 1 hour": 60, "Approve for 8 hours": 480, "Approve for 24 hours": 1440, "Approve this token only": 0, "Deny": -1,
};

export function huddlesClient(cfg: HuddlesConfig, fetcher: typeof fetch = fetch): HuddlesCall {
  const base = cfg.url.replace(/\/+$/, "");
  return async (route, body) => {
    const r = await fetcher(`${base}/net/v1/${route}`, {
      method: "POST", body: JSON.stringify(body),
      headers: { authorization: `Bearer ${cfg.token}`, "content-type": "application/json" },
    });
    if (!r.ok) throw new Error(`huddles ${route}: ${r.status}`); // the status only, never the body
    return r.json();
  };
}

// What the person is shown, as data. Kept apart from its wording so a triage step can read the
// same fields, and so grant_asks records exactly what was asked.
export interface AskRequest { grant: string; caller: string; project: string | null; key: string; scopes: string[]; held: string[] }
export const describe = (r: AskRequest) =>
  `tumbler: ${r.caller} asks for ${r.key} with ${r.scopes.join(", ")}` +
  `${r.project ? ` on project ${r.project}` : ""}${r.held.length ? ` (it holds ${r.held.join(", ")} now)` : ""}. ` +
  `An approval for a while lets ${r.caller} get these scopes on ${r.key} again without asking until then. Grant ${r.grant}.`;

interface AskRow { ask_id: string; grant_id: string; room_id: string; requested: string[] }
interface Me { actor: { kind: string; id: string }; on_behalf_of: { kind: "human"; id: string }; via: string }

export class Asks implements Approver {
  grants: Grants; call: HuddlesCall; room: string | undefined; me: Me | null = null;
  where = "Needs you in Huddles or /admin";
  // `room`: where asks go. Without one, tumbler's own room, created on first use: a delegate can
  // create a room for its member, who gets admin there.
  constructor(grants: Grants, call: HuddlesCall, room?: string) {
    this.grants = grants; this.call = call; this.room = room;
    grants.approver = this;
  }
  get db() { return this.grants.db; }
  now() { return this.grants.now().toISOString(); }

  // A waiting grant: apply an answer already given to its ask, or post the ask. The grant as the
  // answer left it (active, or denied), or null while it still waits.
  async settle(g: GrantRow): Promise<GrantRow | null> {
    if (!g.requested || !isLive(g.state)) return null;
    try {
      const open = await this.openAsk(g.id);
      if (open && same(open.requested, g.requested)) return await this.check(g, open);
      if (open) await this.withdraw(open, "the request changed; a new ask follows");
      await this.ask(g);
    } catch (e) {
      console.error("tumbler: huddles approval skipped", errorClass(e));
    }
    return null;
  }

  // From the cron: answers given since, and asks whose grant no longer waits on them.
  async sweep() {
    const { results } = await this.db.prepare("SELECT * FROM grant_asks WHERE state = 'open'").all<any>();
    for (const r of results) {
      try {
        const ask = toRow(r), g = await this.grants.get(ask.grant_id);
        if (!g || !isLive(g.state) || !g.requested || !same(ask.requested, g.requested)) await this.withdraw(ask, "the request was decided or changed");
        else await this.check(g, ask);
      } catch (e) {
        console.error("tumbler: huddles ask check failed", errorClass(e));
      }
    }
  }

  async whoami(): Promise<Me> { return this.me ??= await this.call("whoami", {}); }

  async ask(g: GrantRow) {
    const me = await this.whoami(), room = this.room ?? `tumbler-approvals-${me.actor.id}`;
    const request: AskRequest = { grant: g.id, caller: g.caller, project: g.project, key: g.name, scopes: g.requested!, held: g.scopes };
    const expires = new Date(Date.parse(g.requested_at ?? this.now()) + PENDING_TTL_MS).toISOString();
    const commit = () => this.call("rooms/commit", {
      room_id: room, base_seq: 0, origin: "auto", attribution: me,
      items: [{ verb: "ask", question: describe(request), resolver: me.on_behalf_of,
        response_schema: { type: "string", enum: Object.keys(CHOICES) }, expires_at: expires }],
    });
    const r = await commit().catch(async (e) => {
      if (this.room) throw e;
      await this.call("rooms/create", { room_id: room }).catch(() => {}); // already there: the retry says
      return commit();
    });
    const askId = r?.status === "committed" ? r.result.outcomes[0]?.minted?.ask_id : undefined;
    if (!askId) throw new Error("huddles ask not accepted");
    await this.db.prepare("INSERT INTO grant_asks (ask_id, grant_id, room_id, requested, request, asked_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(askId, g.id, room, JSON.stringify(g.requested), JSON.stringify(request), this.now()).run();
    await this.grants.catalog.audit("huddles", "grant-ask", g.project, [`${g.name}:${g.requested!.join("+")}`, g.id, askId]);
  }

  async check(g: GrantRow, ask: AskRow): Promise<GrantRow | null> {
    const r = await this.call("asks/await", { room_id: ask.room_id, ask_id: ask.ask_id, wait_seconds: 0 });
    if (r.state === "expired") { await this.mark(ask, "expired"); return null; }
    if (r.state !== "answered") return null;
    const me = await this.whoami(), by = r.answered_by?.actor, answer = r.answer ?? {};
    const answeredBy = by ? `${by.kind}:${by.id}` : null;
    // Huddles already refuses anyone else; this is the same check on what tumbler read itself.
    if (by?.kind !== "human" || by.id !== me.on_behalf_of.id) { await this.mark(ask, "refused", null, answeredBy); return null; }
    if (answer.outcome === "withdraw") { await this.mark(ask, "withdrawn"); return null; }
    const choice = answer.outcome === "accept" ? String(answer.response) : String(answer.outcome);
    const minutes = answer.outcome === "accept" ? CHOICES[choice] : -1; // decline or cancel denies
    if (minutes === undefined) { await this.mark(ask, "refused", choice, answeredBy); return null; }
    try {
      const done = await this.grants.decide(g.id, minutes >= 0, `huddles:${by.id}`, ask.requested, Math.max(minutes, 0));
      await this.mark(ask, "applied", choice, answeredBy);
      return done;
    } catch (e) {
      // The grant moved on (a rotation, a changed request, /admin got there first): nothing applied.
      if (!(e instanceof Refused)) throw e;
      await this.mark(ask, "refused", choice, answeredBy);
      return null;
    }
  }

  async withdraw(ask: AskRow, reason: string) {
    const me = await this.whoami();
    await this.call("rooms/commit", { room_id: ask.room_id, base_seq: 0, origin: "auto", attribution: me,
      items: [{ verb: "answer", ask_id: ask.ask_id, answer: { outcome: "withdraw", reason } }] }).catch((e) => {
      console.error("tumbler: huddles withdraw failed", errorClass(e)); // the ask expires on its own
    });
    await this.mark(ask, "withdrawn");
  }

  async openAsk(grantId: string): Promise<AskRow | null> {
    const r = await this.db.prepare("SELECT * FROM grant_asks WHERE grant_id = ? AND state = 'open' ORDER BY asked_at DESC LIMIT 1").bind(grantId).first<any>();
    return r ? toRow(r) : null;
  }

  async mark(ask: AskRow, state: string, choice: string | null = null, by: string | null = null) {
    await this.db.prepare("UPDATE grant_asks SET state = ?, choice = ?, answered_by = ?, answered_at = ? WHERE ask_id = ? AND state = 'open'")
      .bind(state, choice, by, state === "withdrawn" || state === "expired" ? null : this.now(), ask.ask_id).run();
  }
}

const toRow = (r: any): AskRow => ({ ask_id: r.ask_id, grant_id: r.grant_id, room_id: r.room_id, requested: JSON.parse(r.requested) });
const same = (a: string[], b: string[]) => [...a].sort().join("+") === [...b].sort().join("+");

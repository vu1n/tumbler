// Approvals in Huddles: a waiting grant becomes an ask in the member's Needs you, and only that
// member's answer, read back by tumbler itself, decides it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { handle } from "../src/app.ts";
import { Asks, CHOICES, type HuddlesCall } from "../src/asks.ts";
import { Catalog } from "../src/catalog.ts";
import { masterKey } from "../src/crypto.ts";
import { Grants, type Provider } from "../src/grants.ts";
import { memoryD1 } from "./d1.ts";

const PARENT = "parent-token-never-leaves";
const CONFIG = { account_id: "a".repeat(32), ttl_minutes: 30, start: ["workers:read"], scopes: { "workers:read": ["1"], "workers:write": ["1", "2"] } };
const VU = { kind: "human", id: "user_vu" }, ME = { actor: { kind: "delegate", id: "dlg_tumbler" }, on_behalf_of: VU, via: "tumbler" };

// A Huddles room that keeps asks, lets a test answer them as anyone, and can be taken down.
function fakeHuddles() {
  const h = { asks: new Map<string, any>(), rooms: new Set(["room_approvals"]), calls: [] as string[], down: false, n: 0 } as any;
  const call: HuddlesCall = async (route, body: any) => {
    h.calls.push(route);
    if (h.down) throw new Error("huddles rooms/commit: 503");
    if (route === "whoami") return ME;
    if (route === "rooms/create") { h.rooms.add(body.room_id); return { room_id: body.room_id, head_seq: 2 }; }
    if (route === "rooms/commit") {
      const item = body.items[0];
      assert.deepEqual(body.attribution, ME);
      if (!h.rooms.has(body.room_id)) throw new Error("huddles rooms/commit: 404");
      if (item.verb === "ask") {
        const ask_id = `ask_${++h.n}`;
        h.asks.set(ask_id, { ...item, ask_id, room: body.room_id, state: "open" });
        return { status: "committed", result: { outcomes: [{ index: 0, outcome: "accepted", minted: { ask_id } }] } };
      }
      if (item.verb === "answer") { h.asks.get(item.ask_id).state = "withdrawn"; return { status: "committed", result: { outcomes: [{ index: 0, outcome: "accepted" }] } }; }
    }
    if (route === "asks/await") {
      const a = h.asks.get(body.ask_id);
      if (a.answer) return { state: "answered", head_seq: 9, answer: a.answer, answered_by: { actor: a.by, on_behalf_of: VU, via: "web" } };
      return { state: a.state === "open" ? "open" : "expired", head_seq: 9 };
    }
    throw new Error("unexpected route " + route);
  };
  const answer = (response: unknown, by: unknown = VU, outcome = "accept") => {
    const a = [...h.asks.values()].filter((x: any) => x.state === "open" && !x.answer).at(-1);
    a.answer = outcome === "accept" ? { outcome, response } : { outcome }; a.by = by;
  };
  return Object.assign(h, { call, answer, open: () => [...h.asks.values()].filter((x: any) => x.state === "open" && !x.answer) });
}

async function setup(room: string | null = "room_approvals", approver?: string) {
  const db = memoryD1(), catalog = new Catalog(db, await masterKey(Buffer.alloc(32, 3).toString("base64")));
  const minted: string[][] = [];
  const provider: Provider = { validate() {}, async mint(_p, _c, scopes) { minted.push(scopes); return { id: `id-${minted.length}`, value: `child-${minted.length}` }; }, async revoke() {} };
  let clock = Date.parse("2026-10-22T12:00:00Z");
  const grants = new Grants(catalog, { cloudflare: provider }, () => new Date(clock));
  catalog.clock = () => new Date(clock);
  const huddles = fakeHuddles();
  new Asks(grants, huddles.call, room ?? undefined, approver);
  await catalog.put("dev", "CLOUDFLARE_API_TOKEN", PARENT, { kind: "mint:cloudflare", config: CONFIG });
  const dev = await catalog.createToken("dev", ["dev"]);
  const deps = { catalog, grants, admin: async (r: Request) => r.headers.get("x-test-admin") };
  const call = (method: string, path: string, token?: string, body?: unknown, admin?: string) => handle(new Request(`https://t.example${path}`, {
    method, body: body === undefined ? undefined : JSON.stringify(body),
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(admin ? { "x-test-admin": admin, "x-tumbler-admin": "1" } : {}) },
  }), deps);
  const stepUp = async (scopes = ["workers:write"]) => (await (await call("POST", "/v1/step-up", dev, { keys: ["CLOUDFLARE_API_TOKEN"], scopes })).json()).grants?.[0];
  const env = () => call("GET", "/v1/env?keys=CLOUDFLARE_API_TOKEN", dev);
  const asks = async () => (await db.prepare("SELECT * FROM grant_asks ORDER BY asked_at, ask_id").all<any>()).results;
  const admin = async () => (await (await call("GET", "/admin/api/grants", undefined, undefined, "vu@example.com")).json());
  return { db, grants, huddles, minted, call, stepUp, env, asks, admin, tick: (m: number) => { clock += m * 60_000; } };
}

test("a waiting write is asked in Needs you; the member's answer there approves it, for the hour picked", async () => {
  const s = await setup();
  await s.env();
  const g = await s.stepUp();
  assert.equal(g.state, "active"); assert.deepEqual(g.requested, ["workers:read", "workers:write"]);
  const [ask] = s.huddles.open();
  assert.deepEqual(ask.resolver, VU);
  assert.deepEqual(ask.response_schema.enum, Object.keys(CHOICES));
  assert.match(ask.question, /dev asks for CLOUDFLARE_API_TOKEN with workers:read, workers:write on project dev/);
  assert.ok(!ask.question.includes(PARENT) && !ask.question.includes("child-"));
  s.huddles.answer("Approve for 1 hour");
  const again = await s.stepUp();
  assert.equal(again.requested, null);
  assert.deepEqual(again.scopes, ["workers:read", "workers:write"]);
  const { grants, approvals } = await s.admin();
  assert.equal(grants[0].decided_by, "huddles:user_vu");
  assert.equal(approvals[0].approved_by, "huddles:user_vu");
  assert.equal(Date.parse(approvals[0].until) - Date.parse("2026-10-22T12:00:00Z"), 3600_000);
  const [row] = await s.asks();
  assert.deepEqual([row.state, row.choice, row.answered_by], ["applied", "Approve for 1 hour", "human:user_vu"]);
  assert.deepEqual(JSON.parse(row.request), { grant: g.id, caller: "dev", project: "dev", key: "CLOUDFLARE_API_TOKEN", scopes: ["workers:read", "workers:write"], held: ["workers:read"] });
});

test("only the member answers: an agent's, a delegate's or another person's answer approves nothing", async () => {
  for (const by of [{ kind: "delegate", id: "dlg_claude" }, { kind: "bot", id: "bot_x" }, { kind: "human", id: "user_other" }]) {
    const s = await setup();
    await s.env();
    await s.stepUp();
    s.huddles.answer("Approve for 24 hours", by);
    const g = await s.stepUp();
    assert.deepEqual(g.requested, ["workers:read", "workers:write"], by.kind);
    assert.deepEqual(s.minted, [["workers:read"]], by.kind);
    assert.equal((await s.asks())[0].state, "refused", by.kind);
    assert.deepEqual((await s.admin()).approvals, [], by.kind);
  }
});

test("a credential acting for someone other than HUDDLES_APPROVER posts no ask and applies no answer", async () => {
  const s = await setup("room_approvals", "user_someone_else");
  await s.env();
  const g = await s.stepUp();
  assert.deepEqual(g.requested, ["workers:read", "workers:write"]);
  assert.deepEqual(s.huddles.open(), []);
  assert.deepEqual(await s.asks(), []);
  const ok = await setup("room_approvals", "user_vu");
  await ok.env();
  await ok.stepUp();
  assert.equal(ok.huddles.open().length, 1);
});

test("Deny, decline or an unknown choice: nothing is minted", async () => {
  for (const [response, outcome, state] of [["Deny", "accept", "applied"], [null, "decline", "applied"], ["Approve forever", "accept", "refused"]] as const) {
    const s = await setup();
    await s.env();
    await s.stepUp();
    s.huddles.answer(response, VU, outcome);
    await s.grants.sweep();
    assert.equal((await s.asks())[0].state, state, String(response));
    assert.deepEqual(s.minted, [["workers:read"]]);
    const [g] = (await s.admin()).grants;
    assert.equal(g.requested === null, state === "applied", String(response)); // a deny drops the step-up
  }
});

test("a pending first grant: denied in Huddles, the command is refused, and the next run asks again", async () => {
  const s = await setup();
  await s.db.prepare("UPDATE keys SET config = ?").bind(JSON.stringify({ ...CONFIG, start: ["workers:write"] })).run();
  assert.equal((await s.env()).status, 409);
  assert.equal(s.huddles.open().length, 1);
  s.huddles.answer("Deny");
  assert.equal((await s.env()).status, 403);
  assert.equal((await s.env()).status, 409);
  assert.equal(s.huddles.open().length, 1); // a new grant, a new ask
  assert.equal(s.minted.length, 0);
});

test("a request that changes withdraws the old ask; an answer to it applies nothing", async () => {
  const s = await setup();
  await s.db.prepare("UPDATE keys SET config = ?").bind(JSON.stringify({ ...CONFIG, scopes: { ...CONFIG.scopes, "dns:edit": ["3"] } })).run();
  await s.env();
  await s.stepUp();
  const [first] = s.huddles.open();
  await s.stepUp(["dns:edit"]);
  assert.equal(first.state, "withdrawn");
  const [second] = s.huddles.open();
  assert.match(second.question, /dns:edit/);
  first.answer = { outcome: "accept", response: "Approve for 1 hour" }; first.by = VU;
  await s.grants.sweep();
  assert.deepEqual(s.minted, [["workers:read"]]);
});

test("the cron applies an answer without the caller running again, and withdraws asks /admin already decided", async () => {
  const s = await setup();
  await s.env();
  await s.stepUp();
  s.huddles.answer("Approve this token only");
  await s.grants.sweep();
  assert.deepEqual(s.minted.at(-1), ["workers:read", "workers:write"]);
  assert.deepEqual((await s.admin()).approvals, []); // this token only: nothing stands
  // Asked again, then approved in /admin: the ask is taken back from Needs you.
  s.tick(30); await s.grants.sweep();
  await s.env();
  const g = await s.stepUp();
  assert.equal(s.huddles.open().length, 1);
  await s.call("POST", `/admin/api/grants/${g.id}/approve`, undefined, { requested: g.requested }, "vu@example.com");
  await s.grants.sweep();
  assert.equal(s.huddles.open().length, 0);
});

test("with Huddles down the grant still waits and /admin still approves it", async () => {
  const s = await setup();
  await s.env();
  s.huddles.down = true;
  const g = await s.stepUp();
  assert.deepEqual(g.requested, ["workers:read", "workers:write"]);
  await s.grants.sweep();
  assert.equal((await s.asks()).length, 0);
  const r = await s.call("POST", `/admin/api/grants/${g.id}/approve`, undefined, { requested: g.requested }, "vu@example.com");
  assert.equal(r.status, 200);
  assert.deepEqual(s.minted.at(-1), ["workers:read", "workers:write"]);
});

test("without a room set, tumbler makes its own on the first ask and keeps using it", async () => {
  const s = await setup(null);
  await s.env();
  await s.stepUp();
  assert.ok(s.huddles.rooms.has("tumbler-approvals-dlg_tumbler"));
  assert.equal(s.huddles.open()[0].room, "tumbler-approvals-dlg_tumbler");
  s.huddles.answer("Approve for 8 hours");
  assert.equal((await s.stepUp()).requested, null);
  assert.equal(s.huddles.calls.filter((c: string) => c === "rooms/create").length, 1);
});

test("a first step-up with no grant yet is asked too, and a denied step-up is never reported as granted", async () => {
  const s = await setup();
  await s.db.prepare("UPDATE keys SET config = ?").bind(JSON.stringify({ ...CONFIG, scopes: { ...CONFIG.scopes, "dns:edit": ["3"] } })).run();
  const g = await s.stepUp(); // no grant before this one
  assert.equal(g.state, "pending");
  assert.equal(s.huddles.open().length, 1);
  s.huddles.answer("Approve this token only");
  assert.equal((await s.stepUp()).requested, null);
  // Wider again, denied in Huddles: the old child stays, but the step-up says denied.
  assert.deepEqual((await s.stepUp(["dns:edit"])).requested, ["dns:edit", "workers:read", "workers:write"]);
  s.huddles.answer("Deny");
  const after = await s.stepUp(["dns:edit"]);
  assert.equal(after.denied, true);
  assert.equal(after.state, "active");
});

// Alerts: a bulk read, a token made by a caller, or a widened minted key reaches the webhook, with
// names and never values; an ordinary read and an admin's own actions don't.
import assert from "node:assert/strict";
import { test } from "node:test";
import { alarming, BULK_READ, crossed, webhookAlerts, type Alert } from "../src/alerts.ts";
import { handle } from "../src/app.ts";
import { Catalog } from "../src/catalog.ts";
import { masterKey } from "../src/crypto.ts";
import { memoryD1 } from "./d1.ts";

const KEY = Buffer.alloc(32, 7).toString("base64");
const AT = "2026-11-03T12:00:00.000Z";

test("alarming() picks out bulk reads, token creation and scope changes, never an admin's", () => {
  const many = Array.from({ length: BULK_READ }, (_, i) => `K${i}`);
  assert.equal(alarming("dev", "read", "huddles", many, AT)?.kind, "bulk-read");
  assert.equal(alarming("dev", "read", "huddles", many.slice(1), AT), null);
  assert.ok(crossed(10, 3, 3));
  assert.ok(!crossed(13, 3, 3)); // already past the threshold before this read
  assert.ok(!crossed(10, 10, 10)); // a read this size alerted on its own
  assert.equal(alarming("dev", "token-create", null, ["child", "parent:dev"], AT)?.kind, "token-create");
  assert.equal(alarming("dev", "mint-scope", "huddles", ["CF", "workers:write"], AT)?.kind, "scope-change");
  assert.equal(alarming("vu@example.com", "token-create", null, ["t"], AT), null);
  assert.equal(alarming("dev", "put", "huddles", ["A"], AT), null);
});

test("a caller reading every key it reaches raises one alert with the names and no values", async () => {
  const catalog = new Catalog(memoryD1(), await masterKey(KEY));
  for (let i = 0; i < BULK_READ; i++) await catalog.put("global", `KEY_${i}`, `value-${i}`);
  const token = await catalog.createToken("dev", null);
  const raised: Alert[] = [];
  catalog.alert = (a) => raised.push(a);
  const get = (path: string) => handle(new Request(`https://t.example${path}`, { headers: { authorization: `Bearer ${token}` } }), { catalog, admin: async () => null });

  assert.equal((await get("/v1/env?keys=KEY_0,KEY_1")).status, 200);
  assert.equal(raised.length, 0);
  assert.equal((await get("/v1/env")).status, 200);
  assert.equal(raised.length, 1);
  assert.equal(raised[0].kind, "bulk-read");
  assert.equal(raised[0].actor, "dev");
  assert.equal(raised[0].names.length, BULK_READ);
  assert.ok(!JSON.stringify(raised).includes("value-"));
});

test("reading a few keys at a time still alerts once the token has read BULK_READ of them", async () => {
  const catalog = new Catalog(memoryD1(), await masterKey(KEY));
  for (let i = 0; i < BULK_READ + 3; i++) await catalog.put("global", `KEY_${i}`, `value-${i}`);
  const token = await catalog.createToken("dev", null);
  const raised: Alert[] = [];
  catalog.alert = (a) => raised.push(a);
  const get = (path: string) => handle(new Request(`https://t.example${path}`, { headers: { authorization: `Bearer ${token}` } }), { catalog, admin: async () => null });

  for (let i = 0; i < BULK_READ + 3; i += 3) {
    const keys = [i, i + 1, i + 2].filter((k) => k < BULK_READ + 3).map((k) => `KEY_${k}`).join(",");
    assert.equal((await get(`/v1/env?keys=${keys}`)).status, 200);
  }
  assert.equal(raised.length, 1);
  assert.equal(raised[0].kind, "bulk-read");
  assert.ok(raised[0].names.length >= BULK_READ);
  assert.ok(!JSON.stringify(raised).includes("value-"));
});

test("concurrent small reads still raise exactly one alert", async () => {
  const catalog = new Catalog(memoryD1(), await masterKey(KEY));
  for (let i = 0; i < 12; i++) await catalog.put("global", `KEY_${i}`, `value-${i}`);
  const token = await catalog.createToken("dev", null);
  const raised: Alert[] = [];
  catalog.alert = (a) => raised.push(a);
  const get = (path: string) => handle(new Request(`https://t.example${path}`, { headers: { authorization: `Bearer ${token}` } }), { catalog, admin: async () => null });

  const rs = await Promise.all([0, 3, 6, 9].map((i) => get(`/v1/env?keys=KEY_${i},KEY_${i + 1},KEY_${i + 2}`)));
  assert.ok(rs.every((r) => r.status === 200));
  assert.equal(raised.length, 1);
  assert.equal(raised[0].kind, "bulk-read");
});

test("the same names in two projects are different secrets; a global read through two is one", async () => {
  const catalog = new Catalog(memoryD1(), await masterKey(KEY));
  for (const proj of ["alpha", "beta"]) for (let i = 0; i < 6; i++) await catalog.put(proj, `KEY_${i}`, `${proj}-${i}`);
  await catalog.put("global", "SHARED", "shared");
  const token = await catalog.createToken("dev", ["alpha", "beta"]);
  const raised: Alert[] = [];
  catalog.alert = (a) => raised.push(a);
  const get = (path: string) => handle(new Request(`https://t.example${path}`, { headers: { authorization: `Bearer ${token}` } }), { catalog, admin: async () => null });
  const keys = "SHARED,KEY_0,KEY_1,KEY_2,KEY_3";

  assert.equal((await get(`/v1/env?project=alpha&keys=${keys}`)).status, 200);
  assert.equal((await get(`/v1/env?project=alpha&keys=${keys}`)).status, 200);
  assert.equal(raised.length, 0); // rereading the same keys adds nothing
  assert.equal((await get(`/v1/env?project=beta&keys=${keys}`)).status, 200);
  assert.equal(raised.length, 0); // 4 + 4 project keys and one global: 9
  assert.equal((await get("/v1/env?project=beta&keys=KEY_4")).status, 200);
  assert.equal(raised.length, 1);
  assert.equal(raised[0].names.length, BULK_READ);
});

test("rereading keys keeps them in the window, so a tenth read an hour after the first still alerts", async () => {
  const catalog = new Catalog(memoryD1(), await masterKey(KEY));
  for (let i = 0; i < BULK_READ; i++) await catalog.put("global", `KEY_${i}`, `value-${i}`);
  const token = await catalog.createToken("dev", null);
  const raised: Alert[] = [];
  catalog.alert = (a) => raised.push(a);
  const get = (path: string) => handle(new Request(`https://t.example${path}`, { headers: { authorization: `Bearer ${token}` } }), { catalog, admin: async () => null });
  const nine = Array.from({ length: BULK_READ - 1 }, (_, i) => `KEY_${i}`).join(",");

  assert.equal((await get(`/v1/env?keys=${nine}`)).status, 200);
  // The first read's rows are 59 minutes old by the time of the reread.
  await catalog.db.prepare("UPDATE read_reach SET last_at = ?").bind(new Date(Date.now() - 59 * 60_000).toISOString()).run();
  assert.equal((await get(`/v1/env?keys=${nine}`)).status, 200);
  assert.equal(raised.length, 0);
  const stale = await catalog.db.prepare("SELECT COUNT(*) AS n FROM read_reach WHERE last_at < ?").bind(new Date(Date.now() - 60_000).toISOString()).first<{ n: number }>();
  assert.equal(stale!.n, 0); // the reread moved every key's time up to now
  assert.equal((await get(`/v1/env?keys=KEY_${BULK_READ - 1}`)).status, 200);
  assert.equal(raised.length, 1);
});

test("a token replaced under the same name starts its count at zero", async () => {
  const catalog = new Catalog(memoryD1(), await masterKey(KEY));
  for (let i = 0; i < 12; i++) await catalog.put("global", `KEY_${i}`, `value-${i}`);
  const raised: Alert[] = [];
  catalog.alert = (a) => raised.push(a);
  const reads = async (token: string) => {
    for (let i = 0; i < 12; i += 3) {
      const r = await handle(new Request(`https://t.example/v1/env?keys=KEY_${i},KEY_${i + 1},KEY_${i + 2}`, { headers: { authorization: `Bearer ${token}` } }), { catalog, admin: async () => null });
      assert.equal(r.status, 200);
    }
  };
  await reads(await catalog.createToken("dev", null));
  await catalog.revokeToken("dev");
  await reads(await catalog.createToken("dev", null, null, null, null, false, { ended: await catalog.endedToken("dev") }));
  assert.equal(raised.length, 2);
});

test("the sweep clears reach rows past the window for tokens that never read again", async () => {
  const catalog = new Catalog(memoryD1(), await masterKey(KEY));
  await catalog.put("global", "KEY_0", "value-0");
  catalog.alert = () => {};
  const token = await catalog.createToken("dev", null);
  const get = (path: string) => handle(new Request(`https://t.example${path}`, { headers: { authorization: `Bearer ${token}` } }), { catalog, admin: async () => null });
  assert.equal((await get("/v1/env?keys=KEY_0")).status, 200);
  const rows = async () => (await catalog.db.prepare("SELECT COUNT(*) AS n FROM read_reach").first<{ n: number }>())!.n;
  await catalog.sweepReach();
  assert.equal(await rows(), 1); // still in the window
  await catalog.db.prepare("UPDATE read_reach SET last_at = ?").bind(new Date(Date.now() - 2 * 60 * 60_000).toISOString()).run();
  await catalog.revokeToken("dev");
  await catalog.sweepReach();
  assert.equal(await rows(), 0);
});

test("webhookAlerts POSTs JSON in the background, and sends nothing without a URL", async () => {
  assert.equal(webhookAlerts(undefined, () => {}), undefined);
  const sent: { url: string; body: string }[] = [], waited: Promise<unknown>[] = [];
  const fetcher = (async (url: string, init: RequestInit) => { sent.push({ url, body: String(init.body) }); return new Response(null, { status: 204 }); }) as unknown as typeof fetch;
  const send = webhookAlerts("https://hook.example/t", (p) => waited.push(p), fetcher)!;
  send({ kind: "token-create", actor: "dev", project: null, names: ["child", "parent:dev"], at: AT });
  await Promise.all(waited);
  assert.equal(sent[0].url, "https://hook.example/t");
  const body = JSON.parse(sent[0].body);
  assert.equal(body.kind, "token-create");
  assert.match(body.text, /token dev created a token: child, parent:dev/);
});

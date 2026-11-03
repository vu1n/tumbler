// Alerts: a bulk read, a token made by a caller, or a widened minted key reaches the webhook, with
// names and never values; an ordinary read and an admin's own actions don't.
import assert from "node:assert/strict";
import { test } from "node:test";
import { alarming, BULK_READ, webhookAlerts, type Alert } from "../src/alerts.ts";
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

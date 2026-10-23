// PUT /v1/keys/NAME: what `tumbler put` sends. A caller token saves static keys only within its writes.
import assert from "node:assert/strict";
import { test } from "node:test";
import { handle } from "../src/app.ts";
import { Catalog, writeReaches } from "../src/catalog.ts";
import { masterKey } from "../src/crypto.ts";
import { memoryD1 } from "./d1.ts";

async function setup() {
  const catalog = new Catalog(memoryD1(), await masterKey(Buffer.alloc(32, 3).toString("base64")));
  const tokens = {
    reader: await catalog.createToken("reader", ["huddles"]),
    dev: await catalog.createToken("dev", ["huddles", "huddles/dev"], null, null, ["huddles/dev"]),
    laptop: await catalog.createToken("laptop", null, null, null, ["global", "*"]),
  };
  const fetcher = (async () => new Response("", { status: 401 })) as typeof fetch; // every check fails
  const deps = { catalog, fetcher, admin: async (r: Request) => r.headers.get("x-test-admin") };
  const put = (name: string, token: string, body: unknown) => handle(new Request(`https://t.example/v1/keys/${name}`,
    { method: "PUT", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) }), deps);
  const admin = (path: string, init: RequestInit) => handle(new Request(`https://t.example/admin/api/${path}`,
    { ...init, headers: { "x-test-admin": "vu@example.com", "x-tumbler-admin": "1", "content-type": "application/json" } }), deps);
  return { catalog, tokens, deps, put, admin };
}

test("writes reach global only when named, and an environment only by name", () => {
  assert.equal(writeReaches(null, "global"), false);
  assert.equal(writeReaches(["*"], "global"), false);
  assert.equal(writeReaches(["global"], "global"), true);
  assert.equal(writeReaches(["*"], "huddles"), true);
  assert.equal(writeReaches(["*"], "huddles/prod"), false);
  assert.equal(writeReaches(["huddles"], "huddles/dev"), false);
  assert.equal(writeReaches(["*/dev"], "huddles/dev"), true);
});

test("a token saves a static key within its writes, and nothing comes back but names", async () => {
  const { catalog, tokens, put } = await setup();
  const r = await put("DATABASE_URL", tokens.dev, { scope: "huddles/dev", value: "postgres://fake", description: "dev db" });
  assert.equal(r.status, 200);
  const text = await r.text();
  assert.doesNotMatch(text, /postgres/);
  assert.deepEqual(JSON.parse(text), { scope: "huddles/dev", name: "DATABASE_URL", action: "created", checked: false });
  assert.equal(await catalog.value((await catalog.keyRow("huddles/dev", "DATABASE_URL"))!), "postgres://fake");
  assert.equal((await (await put("DATABASE_URL", tokens.dev, { scope: "huddles/dev", value: "postgres://fake2" })).json()).action, "rotated");
  const audit = JSON.stringify(await catalog.recentAudit());
  assert.match(audit, /"actor":"dev","action":"put","project":"huddles\/dev","names":"DATABASE_URL"/);
  assert.doesNotMatch(audit, /postgres/);
});

test("a token writes nothing outside its writes, and a reader writes nothing at all", async () => {
  const { catalog, tokens, put } = await setup();
  for (const scope of ["huddles", "huddles/prod", "global"]) assert.equal((await put("X", tokens.dev, { scope, value: "v" })).status, 403, scope);
  assert.match((await (await put("X", tokens.reader, { scope: "huddles", value: "v" })).json()).error, /writes nothing/);
  assert.equal((await put("X", tokens.laptop, { scope: "huddles/prod", value: "v" })).status, 403);
  assert.equal((await catalog.list()).length, 0);
});

test("with no scope named, a token writes its one project, and otherwise must name one", async () => {
  const { catalog, tokens, put } = await setup();
  const one = await catalog.createToken("one", ["huddles/dev"], null, null, ["huddles/dev"]);
  assert.equal((await (await put("A", one, { value: "v" })).json()).scope, "huddles/dev");
  assert.match((await (await put("A", tokens.laptop, { value: "v" })).json()).error, /name a scope/);
  assert.match((await (await put("A", tokens.dev, { value: "v" })).json()).error, /name a scope/);
});

test("a token never sets a minted key's parent, and a key with a check keeps it", async () => {
  const { catalog, tokens, put } = await setup();
  await catalog.put("global", "CLOUDFLARE_API_TOKEN", "parent-fake", { kind: "mint:cloudflare" });
  assert.equal((await put("CLOUDFLARE_API_TOKEN", tokens.laptop, { scope: "global", value: "v" })).status, 409);
  assert.equal(await catalog.value((await catalog.keyRow("global", "CLOUDFLARE_API_TOKEN"))!), "parent-fake");
  await catalog.put("global", "OPENAI_API_KEY", "old-fake", { config: { check: "openai" } });
  const r = await put("OPENAI_API_KEY", tokens.laptop, { scope: "global", value: "new-fake" });
  assert.equal(r.status, 400);
  assert.doesNotMatch(await r.text(), /new-fake/);
  assert.equal(await catalog.value((await catalog.keyRow("global", "OPENAI_API_KEY"))!), "old-fake");
});

test("writes narrowed or revoked while a value's check runs save nothing", async () => {
  const { catalog, tokens } = await setup();
  await catalog.put("global", "OPENAI_API_KEY", "old-fake", { config: { check: "openai" } });
  for (const cut of [() => catalog.updateToken("laptop", { writes: ["*"] }), () => catalog.revokeToken("laptop")]) {
    const fetcher = (async () => { await cut(); return new Response("{}", { status: 200 }); }) as typeof fetch;
    const r = await handle(new Request("https://t.example/v1/keys/OPENAI_API_KEY", { method: "PUT",
      headers: { authorization: `Bearer ${tokens.laptop}`, "content-type": "application/json" }, body: JSON.stringify({ scope: "global", value: "new-fake" }) }),
      { catalog, fetcher, admin: async () => null });
    assert.equal(r.status, 403);
    assert.equal(await catalog.value((await catalog.keyRow("global", "OPENAI_API_KEY"))!), "old-fake");
  }
});

test("a value JSON spells long still fits when the value itself is under the limit", async () => {
  const { tokens, deps } = await setup();
  const body = JSON.stringify({ scope: "global", value: "\n".repeat(40 * 1024) });
  const r = await handle(new Request("https://t.example/v1/keys/BIG", { method: "PUT", body,
    headers: { authorization: `Bearer ${tokens.laptop}`, "content-type": "application/json", "content-length": String(body.length) } }), deps);
  assert.equal(r.status, 200);
});

test("bad names, empty and oversized values are refused", async () => {
  const { tokens, put } = await setup();
  assert.equal((await put("lower", tokens.laptop, { scope: "global", value: "v" })).status, 400);
  assert.equal((await put("A", tokens.laptop, { scope: "global", value: "" })).status, 400);
  assert.equal((await put("A", tokens.laptop, { scope: "global", value: "x".repeat(64 * 1024 + 1) })).status, 413);
});

test("admin sets a token's writes at creation and edits them in place; whoami shows them", async () => {
  const { tokens, put, admin, deps } = await setup();
  const made = await (await admin("tokens", { method: "POST", body: JSON.stringify({ name: "ci", projects: ["kypp"], writes: ["kypp", "global"] }) })).json();
  const whoami = await (await handle(new Request("https://t.example/v1/whoami", { headers: { authorization: `Bearer ${made.token}` } }), deps)).json();
  assert.deepEqual(whoami.writes, ["global", "kypp"]);
  assert.equal((await admin("tokens/reader", { method: "PATCH", body: JSON.stringify({ writes: ["huddles"] }) })).status, 200);
  assert.equal((await put("A", tokens.reader, { scope: "huddles", value: "v" })).status, 200);
  assert.equal((await admin("tokens/reader", { method: "PATCH", body: JSON.stringify({ writes: [] }) })).status, 200);
  assert.equal((await put("A", tokens.reader, { scope: "huddles", value: "v" })).status, 403);
  // A writes edit leaves the pin alone.
  const t = (await (await admin("tokens", { method: "GET" })).json()).tokens.find((x: any) => x.name === "reader");
  assert.deepEqual(t.projects, ["huddles"]);
  for (const bad of [["hud*"], ["huddles/qa"], ["*/*"]]) {
    assert.equal((await admin("tokens/reader", { method: "PATCH", body: JSON.stringify({ writes: bad }) })).status, 400, bad[0]);
  }
});

test("a scope move repoints the writes that named it", async () => {
  const { catalog, admin } = await setup();
  await catalog.put("huddles-dev", "A", "v");
  await catalog.createToken("old", ["huddles-dev"], null, null, ["global", "huddles-dev"]);
  assert.equal((await admin("scopes/move", { method: "POST", body: JSON.stringify({ from: "huddles-dev", to: "huddles/dev" }) })).status, 200);
  const writes = Object.fromEntries((await catalog.tokens()).map((t) => [t.name, t.writes]));
  assert.deepEqual(writes.old, ["global", "huddles/dev"]);
  assert.deepEqual(writes.dev, ["huddles/dev"]);
  assert.deepEqual(writes.laptop, ["*", "global", "huddles/dev"]); // as a pin: * reached huddles-dev, so it keeps huddles/dev
});

test("a token deletes a static key within its writes, never a minted one or one outside them", async () => {
  const { catalog, tokens, deps } = await setup();
  const del = (name: string, token: string, scope?: string) => handle(new Request(`https://t.example/v1/keys/${name}${scope ? `?scope=${encodeURIComponent(scope)}` : ""}`,
    { method: "DELETE", headers: { authorization: `Bearer ${token}` } }), deps);
  await catalog.put("huddles/dev", "A", "v");
  await catalog.put("huddles", "A", "v");
  await catalog.put("global", "CLOUDFLARE_API_TOKEN", "parent-fake", { kind: "mint:cloudflare" });
  assert.equal((await del("A", tokens.dev, "huddles")).status, 403);
  assert.equal((await del("A", tokens.reader, "huddles")).status, 403);
  assert.equal((await del("CLOUDFLARE_API_TOKEN", tokens.laptop, "global")).status, 409);
  assert.equal((await del("MISSING", tokens.dev, "huddles/dev")).status, 404);
  assert.deepEqual(await (await del("A", tokens.dev, "huddles/dev")).json(), { scope: "huddles/dev", name: "A", action: "deleted" });
  assert.equal(await catalog.keyRow("huddles/dev", "A"), null);
  assert.ok(await catalog.keyRow("huddles", "A"));
  assert.match(JSON.stringify(await catalog.recentAudit()), /"actor":"dev","action":"delete","project":"huddles\/dev","names":"A"/);
});

test("a key made minted between the check and the delete is not deleted", async () => {
  const { catalog } = await setup();
  await catalog.put("global", "RACED", "parent-fake", { kind: "mint:cloudflare" });
  assert.equal(await catalog.removeStatic("global", "RACED"), false);
  assert.ok(await catalog.keyRow("global", "RACED"));
  await catalog.put("global", "PLAIN", "v");
  assert.equal(await catalog.removeStatic("global", "PLAIN"), true);
});

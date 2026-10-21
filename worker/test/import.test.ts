// Pasting a .env into /admin: a preview first, then each line saved as a static key, checked like a
// single save. Nothing a response or audit row carries may contain a value.
import assert from "node:assert/strict";
import { test } from "node:test";
import { handle } from "../src/app.ts";
import { Catalog } from "../src/catalog.ts";
import { masterKey } from "../src/crypto.ts";
import { parseDotenv } from "../src/dotenv.ts";
import { memoryD1 } from "./d1.ts";

test("parseDotenv handles comments, export, quotes, escapes and multi-line values", () => {
  const { entries, errors } = parseDotenv([
    "﻿# a comment", "", "export A=plain  # trailing", "B = 'single # kept'", 'C="line\\nbreak \\"q\\""',
    "D=a#b", 'E="multi', 'line"', "F=", "  G=spaced  ", "H='x' # ok", "\r",
  ].join("\r\n"));
  assert.deepEqual(errors, []);
  assert.deepEqual(Object.fromEntries(entries.map((e) => [e.name, e.value])),
    { A: "plain", B: "single # kept", C: 'line\nbreak "q"', D: "a#b", E: "multi\nline", F: "", G: "spaced", H: "x" });
  assert.equal(entries.find((e) => e.name === "E")!.line, 7);
});

test("parseDotenv reports bad lines by number, never their text", () => {
  const { errors } = parseDotenv(["secret-value-1", 'A="unclosed secret-value-2', "B=ok"].join("\n"));
  assert.deepEqual(errors.map((e) => e.line), [1, 2]);
  assert.doesNotMatch(JSON.stringify(errors), /secret-value/);
});

async function setup() {
  const db = memoryD1(), catalog = new Catalog(db, await masterKey(Buffer.alloc(32, 9).toString("base64")));
  const fetcher = (async (_url: string, init: RequestInit = {}) =>
    new Response("", { status: /good-/.test(JSON.stringify(init.headers)) ? 200 : 401 })) as unknown as typeof fetch;
  const deps = { catalog, fetcher, admin: async () => "vu@example.com" };
  const paste = async (text: string, save = false, scope = "dev") => {
    const r = await handle(new Request("https://t.example/admin/api/import", { method: "POST", headers: { "x-tumbler-admin": "1" },
      body: JSON.stringify({ scope, text, save }) }), deps);
    return { status: r.status, body: await r.json() as Record<string, any> };
  };
  const value = async (name: string) => { const row = await catalog.keyRow("dev", name); return row ? await catalog.value(row) : undefined; };
  return { db, catalog, paste, value };
}

test("a preview says what each line would do and saves nothing", async () => {
  const s = await setup();
  await s.catalog.put("dev", "OLD", "old-value");
  await s.catalog.put("dev", "CF", "parent-value", { kind: "mint:cloudflare", config: {} });
  const r = await s.paste("NEW=new-value\nOLD=replaced-value\nCF=static-value\nEMPTY=\nDUP=a-value\nDUP=b-value");
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.keys.map((k: any) => [k.name, k.action]),
    [["NEW", "create"], ["OLD", "overwrite"], ["CF", "skip"], ["EMPTY", "skip"], ["DUP", "skip"], ["DUP", "create"]]);
  assert.doesNotMatch(JSON.stringify(r.body), /-value/);
  assert.equal(await s.value("OLD"), "old-value");
  assert.equal(await s.value("NEW"), undefined);
});

test("saving writes static keys, skips minted ones, and audits names only", async () => {
  const s = await setup();
  await s.catalog.put("dev", "OLD", "old-value");
  await s.catalog.put("dev", "CF", "parent-value", { kind: "mint:cloudflare", config: {} });
  const r = await s.paste("export NEW='new-value'\nOLD=replaced-value\nCF=static-value", true);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.saved, ["NEW", "OLD"]);
  assert.deepEqual(r.body.keys.map((k: any) => k.action), ["created", "overwritten", "skip"]);
  assert.equal(await s.value("NEW"), "new-value");
  assert.equal(await s.value("OLD"), "replaced-value");
  assert.equal((await s.catalog.keyRow("dev", "CF"))!.kind, "mint:cloudflare");
  const audit = await s.catalog.recentAudit();
  assert.deepEqual({ ...audit[0] }, { at: audit[0].at, actor: "vu@example.com", action: "put", project: "dev", names: "NEW,OLD" });
  assert.doesNotMatch(JSON.stringify(s.db.raw.prepare("SELECT * FROM audit").all()), /-value/);
});

test("a key with a check keeps it, and a value that fails it is not saved", async () => {
  const s = await setup();
  await s.catalog.put("dev", "OPENAI_API_KEY", "good-old", { config: { check: "openai" }, checked: true });
  const preview = await s.paste("OPENAI_API_KEY=bad-new\nOTHER=x");
  assert.equal(preview.body.keys[0].checked, true);
  const r = await s.paste("OPENAI_API_KEY=bad-new\nOTHER=x", true);
  assert.equal(r.body.keys[0].action, "failed");
  assert.deepEqual(r.body.saved, ["OTHER"]);
  assert.equal(await s.value("OPENAI_API_KEY"), "good-old");
});

test("a paste with bad lines or names saves nothing", async () => {
  const s = await setup();
  const preview = await s.paste("GOOD=x\nlower_case=secret-value\nnot a line");
  assert.deepEqual(preview.body.errors.map((e: any) => e.line), [2, 3]);
  assert.doesNotMatch(JSON.stringify(preview.body), /secret-value/);
  const r = await s.paste("GOOD=x\nlower_case=secret-value\nnot a line", true);
  assert.equal(r.status, 400);
  assert.equal(await s.value("GOOD"), undefined);
  assert.equal((await s.paste("A=1", true, "Not A Scope")).status, 400);
});

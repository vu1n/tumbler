import assert from "node:assert/strict";
import { test } from "node:test";
import { autoKeys, byClef, byRules, cleanSignals, type S1Client } from "../src/auto.ts";

const keys = [
  { name: "AWS_ACCESS_KEY_ID", description: "" }, { name: "AWS_SECRET_ACCESS_KEY", description: "" },
  { name: "CLOUDFLARE_API_TOKEN", description: "" }, { name: "OPENROUTER_API_KEY", description: "LLM gateway" },
];
const fake = (answer: (q: any) => unknown): S1Client => ({ systemOne: async ({ questions }) =>
  ({ answers: Object.fromEntries(Object.entries(questions).map(([id, q]) => [id, answer(q)])) }) });

test("rules match files at any depth and dependency names", () => {
  assert.deepEqual(byRules(["file:infra/wrangler.jsonc"], keys).map((p) => p.name), ["CLOUDFLARE_API_TOKEN"]);
  assert.deepEqual(byRules(["dep:@aws-sdk/client-s3"], keys).map((p) => p.name), ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"]);
  assert.deepEqual(byRules(["file:notes/wrangler-ideas.md"], keys), []);
});

test("a Python TypeSafe dependency rules its keys in; a bare workflow file does not rule in a GitHub PAT", () => {
  const more = [...keys, { name: "TYPESAFE_API_KEY", description: "" }, { name: "GITHUB_PAT", description: "" }];
  assert.deepEqual(byRules(["dep:typesafe-sdk"], more).map((p) => p.name), ["TYPESAFE_API_KEY"]);
  assert.deepEqual(byRules(["file:.github/workflows/ci.yml"], more), []);
  assert.deepEqual(byRules(["dep:pygithub"], more).map((p) => p.name), ["GITHUB_PAT"]);
});

test("Clef only adds keys it is confident about, and only ones not already ruled in", async () => {
  const asked: string[] = [];
  const picks = await autoKeys(fake((q) => { asked.push(q.instructions); return { type: "noul", noul: /OPENROUTER/.test(q.instructions) ? 0.8 : 0.69 }; }),
    ["file:wrangler.jsonc", "dep:ai"], keys);
  assert.deepEqual(picks.map((p) => p.name), ["CLOUDFLARE_API_TOKEN", "OPENROUTER_API_KEY"]);
  assert.ok(!asked.some((q) => /CLOUDFLARE/.test(q)));
});

test("Clef errors, timeouts and junk answers add nothing", async () => {
  assert.deepEqual(await byClef({ systemOne: async () => { throw new Error("down"); } }, ["dep:x"], keys), []);
  assert.deepEqual(await byClef({ systemOne: () => new Promise(() => {}) }, ["dep:x"], keys, 20), []);
  assert.deepEqual(await byClef(fake(() => ({ type: "noul", noul: 7 })), ["dep:x"], keys), []);
  assert.deepEqual(await byClef(null, ["dep:x"], keys), []);
});

test("signals are filtered to names of bounded size", () => {
  assert.deepEqual(cleanSignals(["file:A.json", "dep:x", "secret=1", 5, "dep:" + "y".repeat(200)]), ["file:a.json", "dep:x"]);
  assert.deepEqual(cleanSignals("nope"), []);
});

test("every key past the first batch is still asked about", async () => {
  const many = Array.from({ length: 95 }, (_, i) => ({ name: `KEY_${String(i).padStart(3, "0")}`, description: "" }));
  let calls = 0;
  const picks = await byClef({ systemOne: async ({ questions }) => {
    calls++;
    return { answers: Object.fromEntries(Object.entries(questions).map(([id, q]: [string, any]) => [id, { type: "noul", noul: /KEY_09[0-4]/.test(q.instructions) ? 0.9 : 0.1 }])) };
  } }, ["dep:x"], many);
  assert.equal(calls, 3);
  assert.deepEqual(picks.map((p) => p.name), ["KEY_090", "KEY_091", "KEY_092", "KEY_093", "KEY_094"]);
});

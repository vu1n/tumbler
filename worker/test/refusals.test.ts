// Refusals name the CLI command that fixes them, never the web page: the CLI is how agents and Vu work.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

test("no refusal or CLI message sends anyone to /admin instead of a command", () => {
  const files = [...readdirSync("src").filter((f) => f.endsWith(".ts") && f !== "admin.ts").map((f) => `src/${f}`), "../cli/tumbler"];
  const offenders = files.flatMap((f) => readFileSync(f, "utf8").split("\n").map((line, i) => ({ f, i: i + 1, line }))
    // A string (not a comment) that points at /admin as the place to act.
    .filter(({ line }) => !/^\s*\/\//.test(line) && /(in|with) \/admin\b/.test(line)));
  assert.deepEqual(offenders.map(({ f, i, line }) => `${f}:${i}: ${line.trim()}`), []);
});

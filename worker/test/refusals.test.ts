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

test("a suggested command quotes what isn't plainly safe, so pasting it never runs part of a scope name", async () => {
  const { widenCommand } = await import("../src/catalog.ts");
  const { execFileSync } = await import("node:child_process");
  assert.equal(widenCommand("dev", "--scopes", ["workers:write"], ["d1:write"]), "tumbler admin token edit dev --scopes workers:write,d1:write");
  for (const hostile of ["$(touch /tmp/pwned)", "`id`", "a;b", "it's", "*", "x|y", "a'$(id)'b"]) {
    const cmd = widenCommand("dev", "--scopes", null, [hostile]);
    // What a shell passes as the argument is exactly the scope, with nothing run.
    const argv = execFileSync("sh", ["-c", `printf '%s\\n' ${cmd.split(" --scopes ")[1]}`], { encoding: "utf8" });
    assert.equal(argv, `${hostile}\n`, cmd);
  }
});

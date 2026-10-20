// End to end: the real CLI against the real routes, served over plain HTTP on localhost.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { promisify } from "node:util";
import { handle } from "../src/app.ts";
import { Catalog } from "../src/catalog.ts";
import { masterKey } from "../src/crypto.ts";
import { memoryD1 } from "./d1.ts";

const CLI = new URL("../../cli/tumbler", import.meta.url).pathname;
const catalog = new Catalog(memoryD1(), await masterKey(Buffer.alloc(32, 1).toString("base64")));
await catalog.put("global", "AWS_REGION", "us-east-1");
await catalog.put("global", "PYTH_API_KEY", "g-pyth");
await catalog.put("dev", "PYTH_API_KEY", "dev-pyth");
const devToken = await catalog.createToken("dev", ["dev"]);
let hits = 0;
const server = createServer(async (req, res) => {
  hits++;
  const r = await handle(new Request(`http://127.0.0.1${req.url}`, { headers: req.headers as any }), { catalog, admin: async () => null });
  res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(await r.text());
});
await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
const url = `http://127.0.0.1:${(server.address() as any).port}`;
const home = mkdtempSync(join(tmpdir(), "tumbler-"));
after(() => server.close());

const exec = promisify(execFile);
// The session running these tests may hold real values under the same names; never let them leak in.
const { PYTH_API_KEY: _p, AWS_REGION: _r, TUMBLER_URL: _u, TUMBLER_TOKEN: _t, TUMBLER_PROJECT: _j, ...baseEnv } = process.env;
const cli = (args: string[], env: Record<string, string> = {}, cwd = home) =>
  exec(CLI, args, { cwd, env: { ...baseEnv, HOME: home, XDG_RUNTIME_DIR: join(home, "run"), TUMBLER_URL: url, TUMBLER_TOKEN: devToken, TUMBLER_IDLE: "3", ...env } });
const printEnv = ["node", "-e", "process.stdout.write([process.env.PYTH_API_KEY, process.env.AWS_REGION].join(' '))"];

test("run injects the project's values into the child only", async () => {
  const { stdout } = await cli(["run", "--", ...printEnv], { TUMBLER_TTL: "0" });
  assert.equal(stdout, "dev-pyth us-east-1");
});

test("a .tumbler manifest limits which keys are fetched", async () => {
  const dir = mkdtempSync(join(home, "proj-"));
  writeFileSync(join(dir, ".tumbler"), "# keys this repo needs\nAWS_REGION\n");
  const { stdout } = await cli(["run", "--", ...printEnv], { TUMBLER_TTL: "0" }, dir);
  assert.equal(stdout, " us-east-1");
});

test("the cache serves repeat runs, and reload drops it", async () => {
  await cli(["reload"]);
  const before = hits;
  for (let i = 0; i < 3; i++) await cli(["run", "--", ...printEnv]);
  assert.equal(hits - before, 1);
  await catalog.put("dev", "PYTH_API_KEY", "rotated");
  assert.equal((await cli(["run", "--", ...printEnv])).stdout, "dev-pyth us-east-1");
  await cli(["reload"]);
  assert.equal((await cli(["run", "--", ...printEnv])).stdout, "rotated us-east-1");
});

test("the cache never hands one token's values to another token", async () => {
  const other = await catalog.createToken("global-only", null);
  await cli(["run", "--", ...printEnv]); // warm the cache with the dev token
  const { stdout } = await cli(["run", "--", ...printEnv], { TUMBLER_TOKEN: other });
  assert.equal(stdout, "g-pyth us-east-1");
});

test("broker refusals surface as errors and the command does not run", async () => {
  await assert.rejects(cli(["run", "-p", "kypp", "--", "touch", join(home, "ran")], { TUMBLER_TTL: "0" }), /outside this token's pin/);
  await assert.rejects(cli(["run", "--", "true"], { TUMBLER_TTL: "0", TUMBLER_TOKEN: "tmb_bad" }), /broker 401/);
});

test("the child's exit code passes through", async () => {
  await assert.rejects(cli(["run", "--", "sh", "-c", "exit 7"], { TUMBLER_TTL: "0" }), (e: any) => e.code === 7);
});

test("a shim runs the real tool under tumbler", async () => {
  const bin = mkdtempSync(join(home, "bin-"));
  writeFileSync(join(bin, "fake-tool"), "#!/bin/sh\necho \"$PYTH_API_KEY $1\"\n", { mode: 0o755 });
  await cli(["shim", "fake-tool"]);
  const shims = join(home, ".local/share/tumbler/bin");
  const { stdout } = await exec(join(shims, "fake-tool"), ["arg"], { env: { ...baseEnv, HOME: home, PATH: `${shims}:${bin}:${process.env.PATH}`,
    TUMBLER_URL: url, TUMBLER_TOKEN: devToken, TUMBLER_TTL: "0" } });
  assert.match(stdout, / arg\n$/);
});

test("the token never appears in the process's arguments", async () => {
  const { readFileSync } = await import("node:fs");
  assert.doesNotMatch(readFileSync(CLI, "utf8"), /"-H", `Authorization/);
});

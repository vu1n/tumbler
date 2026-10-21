// End to end: the real CLI against the real routes, served over plain HTTP on localhost.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { promisify } from "node:util";
import { handle } from "../src/app.ts";
import type { S1Client } from "../src/auto.ts";
import { Catalog } from "../src/catalog.ts";
import { masterKey } from "../src/crypto.ts";
import { memoryD1 } from "./d1.ts";

const CLI = new URL("../../cli/tumbler", import.meta.url).pathname;
const catalog = new Catalog(memoryD1(), await masterKey(Buffer.alloc(32, 1).toString("base64")));
await catalog.put("global", "AWS_REGION", "us-east-1");
await catalog.put("global", "PYTH_API_KEY", "g-pyth");
await catalog.put("dev", "PYTH_API_KEY", "dev-pyth");
await catalog.put("global", "CLOUDFLARE_API_TOKEN", "cf", { description: "Cloudflare API, Workers deploys" });
await catalog.put("global", "POSTHOG_API_KEY", "ph", { description: "PostHog product analytics" });
const devToken = await catalog.createToken("dev", ["dev"]);
let hits = 0, seen: unknown = null;
// A stand-in for Clef: says PostHog is needed when the repo depends on anything analytics-like.
const clef: S1Client = { systemOne: async ({ state, questions }) => {
  seen = state;
  const sig = (state as any).signals as string[];
  return { answers: Object.fromEntries(Object.entries(questions).map(([id, q]: [string, any]) =>
    [id, { type: "noul", noul: /POSTHOG/.test(q.instructions) && sig.includes("dep:mixpanel-lite") ? 0.9 : 0.1 }])) };
} };
const server = createServer(async (req, res) => {
  hits++;
  let body = ""; for await (const c of req) body += c;
  const r = await handle(new Request(`http://127.0.0.1${req.url}`, { method: req.method, headers: req.headers as any, body: body || undefined }),
    { catalog, admin: async () => null, s1: clef });
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
  exec(CLI, args, { cwd, env: { ...baseEnv, HOME: home, XDG_RUNTIME_DIR: join(home, "run"), TUMBLER_URL: url, TUMBLER_TOKEN: devToken, TUMBLER_IDLE: "3", TUMBLER_AUTO: "off", ...env } });
const printEnv = ["node", "-e", "process.stdout.write([process.env.PYTH_API_KEY, process.env.AWS_REGION].join(' '))"];

test("run injects the project's values into the child only", async () => {
  const { stdout } = await cli(["run", "--", ...printEnv], { TUMBLER_TTL: "0" });
  assert.equal(stdout, "dev-pyth us-east-1");
});

test("--clean starts the command from a runtime allowlist plus its keys", async () => {
  const probe = ["node", "-e", "process.stdout.write([process.env.AWS_REGION, process.env.AMBIENT_SECRET, process.env.KEEP_ME, !!process.env.PATH].join(' '))"];
  const env = { TUMBLER_TTL: "0", AMBIENT_SECRET: "leak", KEEP_ME: "kept" };
  assert.equal((await cli(["run", "-k", "AWS_REGION", "--", ...probe], env)).stdout, "us-east-1 leak kept true");
  assert.equal((await cli(["run", "-k", "AWS_REGION", "--clean", "--", ...probe], env)).stdout, "us-east-1   true");
  assert.equal((await cli(["run", "-k", "AWS_REGION", "--clean", "--pass", "KEEP_ME", "--", ...probe], env)).stdout, "us-east-1  kept true");
  await assert.rejects(cli(["run", "--pass", "KEEP_ME", "--", "true"], env), /--pass only applies with --clean/);
});

test("a helper left by another CLI version is never asked", async () => {
  // A stand-in for a pre-upgrade helper on the old socket name, serving a stale value.
  const dir = join(home, "run", "tumbler");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const legacy = createNetServer((sock) => sock.end(JSON.stringify({ env: { PYTH_API_KEY: "stale" } }) + "\n"));
  await new Promise<void>((ok) => legacy.listen(join(dir, `cache-${process.getuid?.() ?? 0}.sock`), ok));
  try {
    await cli(["reload"]);
    assert.notEqual((await cli(["run", "--", ...printEnv])).stdout.split(" ")[0], "stale");
  } finally { legacy.close(); }
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

test("a shorter TTL on a later run is honoured by a helper started with the default", async () => {
  await cli(["reload"]);
  await cli(["run", "--", ...printEnv]); // starts or reuses the helper at the default TTL
  await new Promise((r) => setTimeout(r, 1100));
  const before = hits;
  await cli(["run", "--", ...printEnv], { TUMBLER_TTL: "1" });
  assert.equal(hits - before, 1);
});

test("a child killed by a signal makes tumbler fail too", async () => {
  await assert.rejects(cli(["run", "--", "sh", "-c", "kill -TERM $$"], { TUMBLER_TTL: "0" }), (e: any) => e.signal === "SIGTERM" || e.code === 143);
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

const repo = (files: Record<string, string>) => {
  const dir = mkdtempSync(join(home, "repo-"));
  mkdirSync(join(dir, ".git"));
  for (const [f, body] of Object.entries(files)) { mkdirSync(join(dir, f, ".."), { recursive: true }); writeFileSync(join(dir, f), body); }
  return dir;
};

test("auto picks keys by rule and by Clef, sends names only, and writes .tumbler", async () => {
  const dir = repo({ "worker/wrangler.jsonc": "{}", "package.json": JSON.stringify({ dependencies: { "mixpanel-lite": "1" } }), "src/secret.ts": "const k = 'do-not-send'" });
  const { stdout } = await cli(["auto"], {}, join(dir, "worker"));
  assert.match(stdout, /CLOUDFLARE_API_TOKEN\trule: Cloudflare/);
  assert.match(stdout, /POSTHOG_API_KEY\tclef 0\.90/);
  assert.doesNotMatch(stdout, /AWS_REGION|PYTH_API_KEY/);
  assert.doesNotMatch(JSON.stringify(seen), /do-not-send/);
  // The token's pin is not written down: the committed file must not 403 for a token pinned elsewhere.
  assert.doesNotMatch(readFileSync(join(dir, ".tumbler"), "utf8"), /^project =/m);
  await assert.rejects(cli(["auto"], {}, dir), /exists; pass --force/);
  await cli(["auto", "--force", "-p", "dev"], {}, dir);
  assert.match(readFileSync(join(dir, ".tumbler"), "utf8"), /^project = dev$/m);
});

test("auto reads every dependency a pyproject.toml declares, extras included", async () => {
  const pyproject = [
    "[project]", 'name = "x"', 'description = "not-a-dep>=1"', "dependencies = [", '    "typer>=0.12",  # a comment', '    "pyyaml",', "]",
    "[project.optional-dependencies]", "# an extra", 's1 = ["typesafe-sdk>=0.7"]', 'git = ["brief[s1] @ git+https://example.com/b", "rich"]',
    "[dependency-groups]", 'dev = ["pytest>=8"]',
    "[tool.poetry.group.dev.dependencies]", 'python = "^3.12"', 'boto3 = "^1"',
    "[tool.hatch.build]", 'packages = ["src/x"]',
  ].join("\n");
  await cli(["auto", "--dry-run"], {}, repo({ "pyproject.toml": pyproject }));
  const deps = ((seen as any).signals as string[]).filter((s) => s.startsWith("dep:")).sort();
  assert.deepEqual(deps, ["dep:boto3", "dep:brief", "dep:pytest", "dep:pyyaml", "dep:rich", "dep:typer", "dep:typesafe-sdk"]);
});

test("run with no .tumbler runs auto first and gets only those keys", async () => {
  const dir = repo({ "wrangler.toml": "" });
  const printCf = ["node", "-e", "process.stdout.write([process.env.CLOUDFLARE_API_TOKEN, process.env.PYTH_API_KEY].join(' '))"];
  const { stdout, stderr } = await cli(["run", "--", ...printCf], { TUMBLER_AUTO: "", TUMBLER_TTL: "0" }, dir);
  assert.equal(stdout, "cf ");
  assert.match(stderr, /wrote .*\.tumbler with 1 key/);
  assert.ok(existsSync(join(dir, ".tumbler")));
});

test("an empty auto result runs the command with no keys, not all of them", async () => {
  const dir = repo({ "README.md": "" });
  const { stdout } = await cli(["run", "--", ...printEnv], { TUMBLER_AUTO: "", TUMBLER_TTL: "0" }, dir);
  assert.equal(stdout, " ");
});

test("key files deep in a big repo still reach the broker", async () => {
  const files: Record<string, string> = {};
  for (let i = 0; i < 400; i++) files[`aaa/f${String(i).padStart(3, "0")}.txt`] = "";
  files["zzz/infra/wrangler.toml"] = "";
  files["zzz/package.json"] = JSON.stringify({ dependencies: { "mixpanel-lite": "1" } });
  const { stdout } = await cli(["auto", "--dry-run"], {}, repo(files));
  assert.match(stdout, /CLOUDFLARE_API_TOKEN\trule/);
  assert.match(stdout, /POSTHOG_API_KEY\tclef/);
});

test("a .tumbler that can't be written still runs with only the picked keys", async () => {
  const dir = repo({ "wrangler.toml": "" });
  // Why a dangling symlink, not chmod: tests may run as root, which ignores file modes.
  symlinkSync(join(dir, "missing", "nowhere"), join(dir, ".tumbler"));
  {
    const printCf = ["node", "-e", "process.stdout.write([process.env.CLOUDFLARE_API_TOKEN, process.env.PYTH_API_KEY, process.env.AWS_REGION].join(' '))"];
    const { stdout, stderr } = await cli(["run", "--", ...printCf], { TUMBLER_AUTO: "", TUMBLER_TTL: "0" }, dir);
    assert.equal(stdout, "cf  ");
    assert.match(stderr, /could not write .*picked key\(s\) only/);
  }
});

test("if auto can't pick, the command doesn't start", async () => {
  const dir = repo({ "wrangler.toml": "" }), marker = join(dir, "ran");
  await assert.rejects(cli(["run", "--", "touch", marker], { TUMBLER_AUTO: "", TUMBLER_TTL: "0", TUMBLER_TOKEN: "tmb_bad" }, dir),
    /auto could not pick keys/);
  assert.ok(!existsSync(marker));
});

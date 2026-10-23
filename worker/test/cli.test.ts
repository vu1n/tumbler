// End to end: the real CLI against the real routes, served over plain HTTP on localhost.
import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
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
  execFileSync("git", ["init", "-q", dir]);
  for (const [f, body] of Object.entries(files)) { mkdirSync(join(dir, f, ".."), { recursive: true }); writeFileSync(join(dir, f), body); }
  return dir;
};

test("auto picks keys by rule and by Clef, sends names only, and writes .tumbler outside git", async () => {
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
  // Kept out of git, listed once however often it's rewritten.
  assert.match(readFileSync(join(dir, ".git", "info", "exclude"), "utf8"), /^\/\.tumbler$/m);
  assert.equal(readFileSync(join(dir, ".git", "info", "exclude"), "utf8").split("\n").filter((l) => l === "/.tumbler").length, 1);
});

test("auto in a linked worktree lists .tumbler in the repository's real exclude file", async () => {
  const dir = repo({ "wrangler.toml": "" }), wt = join(dir, "..", `${dir.split("/").at(-1)}-wt`);
  const git = (...a: string[]) => execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...a]);
  git("add", "."); git("commit", "-qm", "x"); git("worktree", "add", "-q", wt);
  await cli(["auto"], {}, wt);
  const exclude = execFileSync("git", ["-C", wt, "rev-parse", "--git-path", "info/exclude"], { encoding: "utf8" }).trim();
  assert.match(readFileSync(exclude.startsWith("/") ? exclude : join(wt, exclude), "utf8"), /^\/\.tumbler$/m);
  assert.equal(execFileSync("git", ["-C", wt, "status", "--porcelain"], { encoding: "utf8" }), "");
});

test("auto reads every dependency a pyproject.toml declares, extras included", async () => {
  const pyproject = [
    "[project]", 'name = "x"', 'description = "not-a-dep>=1"', "dependencies = [", '    "typer>=0.12",  # a comment', '    "pyyaml",', "]",
    "[project.optional-dependencies]", "# an extra", 's1 = ["typesafe-sdk>=0.7"]', 'git = ["brief[s1] @ git+https://example.com/b#egg=brief", "rich"]  # a ] in a comment',
    // Codex's case: a `#` and a `]` inside a string must neither end the line nor close the array.
    "llm = [", '    "brief[s1] @ git+https://example.com/b#egg=brief",', "    'openai>=1',", "]",
    "[dependency-groups]", 'dev = ["pytest>=8"]',
    "[tool.poetry.group.dev.dependencies]", 'python = "^3.12"', 'boto3 = "^1"',
    "[tool.hatch.build]", 'packages = ["src/x"]',
  ].join("\n");
  await cli(["auto", "--dry-run"], {}, repo({ "pyproject.toml": pyproject }));
  const deps = ((seen as any).signals as string[]).filter((s) => s.startsWith("dep:")).sort();
  assert.deepEqual(deps, ["dep:boto3", "dep:brief", "dep:openai", "dep:pytest", "dep:pyyaml", "dep:rich", "dep:typer", "dep:typesafe-sdk"]);
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

// --- put and ssh-keygen ---

const writer = await catalog.createToken("writer", ["dev"], null, null, ["dev", "global"]);
// The CLI with `input` on its stdin (a pipe, not a TTY), as an agent drives it.
const cliIn = (args: string[], input: string, env: Record<string, string> = {}) => new Promise<{ code: number | null; stdout: string; stderr: string }>((ok) => {
  const child = spawn(CLI, args, { cwd: home, env: { ...baseEnv, HOME: home, XDG_RUNTIME_DIR: join(home, "run"), TUMBLER_URL: url, TUMBLER_TOKEN: writer, TUMBLER_IDLE: "3", TUMBLER_TTL: "0", ...env } });
  let stdout = "", stderr = "";
  child.stdout.on("data", (d) => { stdout += d; }); child.stderr.on("data", (d) => { stderr += d; });
  child.on("close", (code) => ok({ code, stdout, stderr }));
  child.stdin.end(input);
});
const stored = async (scope: string, name: string) => catalog.value((await catalog.keyRow(scope, name))!);

test("put saves a piped value; a single line loses its trailing newline", async () => {
  const r = await cliIn(["put", "NEW_TOKEN", "-p", "dev"], "fake-123\n");
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /created NEW_TOKEN in dev/);
  assert.equal(await stored("dev", "NEW_TOKEN"), "fake-123");
  assert.doesNotMatch(r.stdout + r.stderr, /fake-123/);
  const { stdout } = await cli(["run", "-k", "NEW_TOKEN", "--", "node", "-e", "process.stdout.write(process.env.NEW_TOKEN)"], { TUMBLER_TTL: "0", TUMBLER_TOKEN: writer });
  assert.equal(stdout, "fake-123");
  assert.match((await cliIn(["put", "NEW_TOKEN", "-p", "dev"], "fake-456")).stderr, /rotated NEW_TOKEN in dev/);
});

test("put --from-file keeps a multi-line value exactly, and --clipboard reads the paste tool", async () => {
  const dir = mkdtempSync(join(home, "put-")), file = join(dir, "key");
  writeFileSync(file, "-----BEGIN FAKE-----\nabc\n-----END FAKE-----\n");
  assert.equal((await cliIn(["put", "FAKE_KEY", "--global", "--from-file", file], "")).code, 0);
  assert.equal(await stored("global", "FAKE_KEY"), "-----BEGIN FAKE-----\nabc\n-----END FAKE-----\n");
  writeFileSync(join(dir, "pbpaste"), "#!/bin/sh\nprintf 'from-clip\\n'\n", { mode: 0o755 });
  assert.equal((await cliIn(["put", "CLIP_KEY", "--global", "--clipboard"], "", { PATH: `${dir}:${process.env.PATH}` })).code, 0);
  assert.equal(await stored("global", "CLIP_KEY"), "from-clip");
});

test("put refuses outside the token's writes, an empty value, and -p with --global", async () => {
  const kypp = await cliIn(["put", "NOPE", "-p", "kypp"], "v");
  assert.equal(kypp.code, 1);
  assert.match(kypp.stderr, /may not write kypp/);
  assert.match((await cliIn(["put", "NOPE", "--global"], "v", { TUMBLER_TOKEN: devToken })).stderr, /writes nothing/);
  assert.match((await cliIn(["put", "NOPE", "--global"], "")).stderr, /empty value/);
  assert.equal((await cliIn(["put", "NOPE", "-p", "dev", "--global"], "v")).code, 2);
  assert.equal((await cliIn(["put", "lower"], "v")).code, 2);
  assert.equal(await catalog.keyRow("global", "NOPE"), null);
});

test("neither the token nor a put value appears in curl's arguments", async () => {
  const dir = mkdtempSync(join(home, "argv-")), log = join(dir, "argv");
  const real = execFileSync("sh", ["-c", "command -v curl"], { encoding: "utf8" }).trim();
  writeFileSync(join(dir, "curl"), `#!/bin/sh\necho "$@" >> ${log}\nexec ${real} "$@"\n`, { mode: 0o755 });
  assert.equal((await cliIn(["put", "ARGV_KEY", "--global"], "argv-secret-fake", { PATH: `${dir}:${process.env.PATH}` })).code, 0);
  const argv = readFileSync(log, "utf8");
  assert.match(argv, /\/v1\/keys\/ARGV_KEY/);
  assert.doesNotMatch(argv, /argv-secret-fake/);
  assert.ok(!argv.includes(writer));
});

test("ssh-keygen saves an ed25519 private key and prints only its public half", async () => {
  const r = await cliIn(["ssh-keygen", "DEPLOY_SSH_KEY", "--global", "-C", "deploy@test"], "");
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^ssh-ed25519 [A-Za-z0-9+/=]+ deploy@test\n$/);
  const priv = await stored("global", "DEPLOY_SSH_KEY");
  assert.match(priv, /^-----BEGIN OPENSSH PRIVATE KEY-----\n[\s\S]+\n-----END OPENSSH PRIVATE KEY-----\n$/);
  assert.doesNotMatch(r.stdout + r.stderr, /PRIVATE KEY/);
  // OpenSSH itself reads the stored key back to the printed public key.
  const dir = mkdtempSync(join(home, "ssh-")), file = join(dir, "id");
  writeFileSync(file, priv, { mode: 0o600 });
  assert.equal(execFileSync("ssh-keygen", ["-y", "-f", file], { encoding: "utf8" }).trim(), r.stdout.trim());
});

test("put at a terminal reads a hidden value; a bracketed paste keeps its newlines and Enter finishes", async () => {
  // util-linux `script` gives the CLI a real TTY; what's written to it is what the user would type.
  const typed = "\x1b[200~line-one\rline-two\r\x1b[201~" + "x\x7f" + "\r";
  const r = await new Promise<{ code: number | null; out: string }>((ok) => {
    const child = spawn("script", ["-qec", `${CLI} put TYPED_KEY --global`, "/dev/null"], { cwd: home,
      env: { ...baseEnv, HOME: home, XDG_RUNTIME_DIR: join(home, "run"), TUMBLER_URL: url, TUMBLER_TOKEN: writer, TUMBLER_TTL: "0", SHELL: "/bin/sh" } }); // no profile in between
    // Typed once the prompt is up, so the terminal is already in raw mode.
    let out = "", sent = false;
    child.stdout.on("data", (d) => { out += d; if (!sent && out.includes("\x1b[?2004h")) { sent = true; child.stdin.write(typed); } });
    child.on("close", (code) => ok({ code, out }));
  });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /value for TYPED_KEY \(hidden/);
  assert.doesNotMatch(r.out, /line-one/);
  assert.equal(await stored("global", "TYPED_KEY"), "line-one\nline-two\n");
});

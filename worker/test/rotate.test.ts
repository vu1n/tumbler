// `tumbler run` when keys change under it: the failure report, --retry, and --watch, end to end
// against the real routes. Fake values only; same-named env vars are stripped from the children.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
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

// The check's service: values starting `good-` pass, anything else is a 401.
const fetcher = (async (_url: string, init: RequestInit = {}) =>
  new Response("", { status: /Bearer good-/.test(String((init.headers as any).authorization)) ? 200 : 401 })) as unknown as typeof fetch;
const catalog = new Catalog(memoryD1(), await masterKey(Buffer.alloc(32, 9).toString("base64")));
const token = await catalog.createToken("dev", ["dev"]);
const deps = { catalog, fetcher, admin: async () => "vu@example.com" };
// Armed by a test: fail the first /v1/revs that follows a /v1/env, i.e. --watch's post-fetch check.
let failCheck: "armed" | "fetched" | null = null;
const server = createServer(async (req, res) => {
  let body = ""; for await (const c of req) body += c;
  if (failCheck === "armed" && req.url!.startsWith("/v1/env")) failCheck = "fetched";
  else if (failCheck === "fetched" && req.url!.startsWith("/v1/revs")) { failCheck = null; res.writeHead(503); res.end("{}"); return; }
  const r = await handle(new Request(`http://127.0.0.1${req.url}`, { method: req.method, headers: req.headers as any, body: body || undefined }), deps);
  res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(await r.text());
});
await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
after(() => server.close());

// Saved through /admin, so the check runs and a passing value is marked checked.
const save = async (name: string, value: string, config?: unknown) => {
  const r = await handle(new Request(`https://t.example/admin/api/keys/dev/${name}`, { method: "PUT", headers: { "x-tumbler-admin": "1" },
    body: JSON.stringify({ value, config }) }), deps);
  assert.equal(r.status, 200, await r.clone().text());
};

const CLI = new URL("../../cli/tumbler", import.meta.url).pathname;
const home = mkdtempSync(join(tmpdir(), "tumbler-rotate-"));
// Why: macOS caps a unix socket path at 104 bytes, and the cache socket under macOS's long tmpdir
// overshoots it. The helper then never starts, and the cache tests fail because nothing is cached.
const runDir = mkdtempSync("/tmp/tmb-");
const { ROT_KEY: _a, ROT_PLAIN: _b, TUMBLER_URL: _u, TUMBLER_TOKEN: _t, TUMBLER_PROJECT: _j, ...baseEnv } = process.env;
const env = (extra: Record<string, string> = {}) => ({ ...baseEnv, HOME: home, XDG_RUNTIME_DIR: runDir, TUMBLER_IDLE: "3", TUMBLER_AUTO: "off",
  TUMBLER_URL: `http://127.0.0.1:${(server.address() as any).port}`, TUMBLER_TOKEN: token, ...extra });
const exec = promisify(execFile);
const cli = (args: string[], extra?: Record<string, string>) => exec(CLI, args, { cwd: home, env: env(extra) }).then(
  (r) => ({ code: 0, ...r }), (e) => ({ code: e.code as number, stdout: e.stdout as string, stderr: e.stderr as string }));
// Exits 0 only when ROT_KEY holds the value it expects.
const expect = (v: string) => ["node", "-e", `process.exit(process.env.ROT_KEY === ${JSON.stringify(v)} ? 0 : 3)`];

test("a failed run reports a key that changed under a stale cache, and --retry reruns once with it", async () => {
  await save("ROT_KEY", "good-1", { check: "openai" });
  const cached = { TUMBLER_TTL: "300" };
  assert.equal((await cli(["run", "-k", "ROT_KEY", "--", ...expect("good-1")], cached)).code, 0); // caches good-1
  await save("ROT_KEY", "good-2");
  const failed = await cli(["run", "-k", "ROT_KEY", "--", ...expect("good-2")], cached);
  assert.equal(failed.code, 3);
  assert.match(failed.stderr, /the command exited 3; checking its keys/);
  assert.match(failed.stderr, /ROT_KEY changed since the command started; passes its check/);
  assert.match(failed.stderr, /pass --retry to rerun automatically/);
  assert.ok(!/good-/.test(failed.stderr), failed.stderr);
  // The report refreshed the cache, so this run already has the new value.
  assert.equal((await cli(["run", "-k", "ROT_KEY", "--", ...expect("good-2")], cached)).code, 0);
  await save("ROT_KEY", "good-3");
  const retried = await cli(["run", "--retry", "-k", "ROT_KEY", "--", ...expect("good-3")], cached);
  assert.equal(retried.code, 0, retried.stderr);
  assert.match(retried.stderr, /running once more with the new values/);
});

test("--retry doesn't rerun when nothing changed; the report names a key failing its check", async () => {
  await save("ROT_KEY", "good-4", { check: "openai" });
  const plain = await cli(["run", "--retry", "-k", "ROT_KEY", "--", "node", "-e", "process.exit(5)"], { TUMBLER_TTL: "0" });
  assert.equal(plain.code, 5);
  assert.match(plain.stderr, /no key changed and every checked key passes, so the failure is probably not a key problem/);
  assert.doesNotMatch(plain.stderr, /once more/);
  await catalog.put("dev", "ROT_KEY", "revoked-upstream"); // went bad without passing through a check
  const bad = await cli(["run", "-k", "ROT_KEY", "--", "node", "-e", "process.exit(1)"], { TUMBLER_TTL: "0" });
  assert.match(bad.stderr, /ROT_KEY fails its check: rejected \(401\)/);
  assert.match(bad.stderr, /fails its check; rotate it in \/admin/);
  assert.ok(!/revoked-upstream/.test(bad.stderr));
  const quiet = await cli(["run", "-k", "ROT_KEY", "--", "node", "-e", "process.exit(1)"], { TUMBLER_TTL: "0", TUMBLER_DIAGNOSE: "off" });
  assert.equal(quiet.stderr, "");
});

test("--watch restarts only for a checked new value, and goes back when the restart dies", async () => {
  await save("ROT_KEY", "good-a", { check: "openai" });
  await save("ROT_PLAIN", "plain-a");
  const script = "const v = process.env.ROT_KEY; console.log('start ' + v + ' ' + process.env.ROT_PLAIN); if (v === 'good-crash') process.exit(4); setInterval(() => {}, 1000);";
  const p = spawn(CLI, ["run", "--watch", "-k", "ROT_KEY,ROT_PLAIN", "--", "node", "-e", script], { cwd: home,
    env: env({ TUMBLER_TTL: "0", TUMBLER_WATCH: "0.2", TUMBLER_WATCH_GRACE: "1" }) });
  let out = "", err = "";
  p.stdout.on("data", (d) => { out += d; }); p.stderr.on("data", (d) => { err += d; });
  const until = async (re: RegExp, what: () => string) => {
    for (let i = 0; i < 100 && !re.test(what()); i++) await new Promise((r) => setTimeout(r, 50));
    assert.match(what(), re);
  };
  try {
    await until(/start good-a plain-a/, () => out);
    await save("ROT_KEY", "good-b");                        // checked: pushed
    await until(/start good-b plain-a/, () => out);
    await save("ROT_PLAIN", "plain-b");                     // no check: reported, not pushed
    await until(/ROT_PLAIN changed but its new value wasn't checked/, () => err);
    await save("ROT_KEY", "good-crash");                    // checked but breaks the command
    await until(/going back to the previous value of ROT_KEY/, () => err);
    await until(/start good-b plain-a\n[^]*start good-crash[^]*start good-b plain-a/, () => out);
    assert.ok(!/good-|plain-/.test(err), err);
  } finally { p.kill("SIGTERM"); }
  const [code, sig] = await new Promise<[number | null, string | null]>((ok) => p.on("exit", (c, s) => ok([c, s])));
  assert.ok(sig === "SIGTERM" || code === 143, `${code} ${sig}`);
});

test("--watch retries a rotation whose post-fetch check failed instead of dropping it", async () => {
  await save("ROT_W", "good-1", { check: "openai" });
  const p = spawn(CLI, ["run", "--watch", "-k", "ROT_W", "--", "node", "-e", "console.log('start ' + process.env.ROT_W); setInterval(() => {}, 1000);"],
    { cwd: home, env: env({ TUMBLER_TTL: "0", TUMBLER_WATCH: "0.2", TUMBLER_WATCH_GRACE: "1" }) });
  let out = "";
  p.stdout.on("data", (d) => { out += d; });
  const until = async (re: RegExp) => {
    for (let i = 0; i < 100 && !re.test(out); i++) await new Promise((r) => setTimeout(r, 50));
    assert.match(out, re);
  };
  try {
    await until(/start good-1/);
    failCheck = "armed";
    await save("ROT_W", "good-2"); // fetched, but the check after the fetch fails once
    await until(/start good-2/);   // a later poll picks it up without another rotation
    assert.equal(failCheck, null);
  } finally { p.kill("SIGTERM"); }
  await new Promise((ok) => p.on("exit", ok));
});

test("a stopped command is never rerun or reported on; a crashed one is reported", async () => {
  await save("ROT_KEY", "good-s1", { check: "openai" });
  const script = "console.log('started'); process.on('SIGTERM', () => process.exit(1)); setInterval(() => {}, 1000);";
  const p = spawn(CLI, ["run", "--retry", "-k", "ROT_KEY", "--", "node", "-e", script], { cwd: home, env: env({ TUMBLER_TTL: "0" }) });
  let out = "", err = "";
  p.stdout.on("data", (d) => { out += d; }); p.stderr.on("data", (d) => { err += d; });
  for (let i = 0; i < 100 && !out.includes("started"); i++) await new Promise((r) => setTimeout(r, 50));
  await save("ROT_KEY", "good-s2"); // a key changed, so only the stop keeps --retry from rerunning
  p.kill("SIGTERM");
  const code = await new Promise((ok) => p.on("exit", (c) => ok(c)));
  assert.equal(code, 1);
  assert.equal(out.match(/started/g)!.length, 1);
  assert.doesNotMatch(err, /checking its keys/);
  const crashed = await cli(["run", "-k", "ROT_KEY", "--", "node", "-e", "process.kill(process.pid, 'SIGSEGV')"], { TUMBLER_TTL: "0" });
  assert.match(crashed.stderr, /the command was killed by SIGSEGV; checking its keys/);
});

test("a failed run with more keys than one /v1/check takes still reports every key", async () => {
  const names = Array.from({ length: 25 }, (_, i) => `MANY_${i}`);
  for (const n of names) await catalog.put("dev", n, `v-${n}`);
  const r = await cli(["run", "-k", names.join(","), "--", "node", "-e", "process.exit(1)"], { TUMBLER_TTL: "0" });
  assert.doesNotMatch(r.stderr, /could not run their checks/);
  assert.equal(r.stderr.match(/has no check/g)!.length, 25);
});

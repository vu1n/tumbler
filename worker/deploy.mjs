// deploy.mjs — `npm run deploy`: the one command that sets up and deploys tumbler, run from your
// own machine. Nothing account-specific is committed:
//   - The Secrets Store id is looked up (account.mjs) and filled into a throwaway copy of
//     wrangler.jsonc.
//   - First run: the master key is created in that store (below) and backed up once to a file.
//   - The D1 database is created and linked by the first deploy (wrangler's automatic provisioning).
// Migrations run before the deploy, so new code never meets an old schema; on the very first
// deploy the database doesn't exist yet, so they run right after it instead.
import { randomBytes } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { fail, hasMasterKey, PLACEHOLDER, secretName, source, storeId, wrangler } from "./account.mjs";

const CONFIG = "wrangler.deploy.jsonc", args = process.argv.slice(2), dryRun = args.includes("--dry-run");
if (!source.includes(PLACEHOLDER)) fail(`wrangler.jsonc has no ${PLACEHOLDER} to fill in`);
const id = storeId();
if (!dryRun && !hasMasterKey(id)) createMasterKey(id);

// Every value tumbler stores is sealed under the master key, so losing it loses them all. It is
// generated here, handed to wrangler on stdin (never in argv or on screen) and written once to a
// backup file for you to move offline. Only called when the store has none: it never replaces one.
function createMasterKey(store) {
  // Why: in CI the backup file would vanish with the runner, leaving a key nobody holds.
  if (process.env.CI || process.env.WORKERS_CI) fail("the first deploy creates the master key; run it on your own machine, not in CI");
  const key = randomBytes(32).toString("base64"), backup = `${homedir()}/tumbler-master-key.txt`;
  // "wx": never overwrite an older backup, which may be the only copy of another key.
  try { writeFileSync(backup, key + "\n", { mode: 0o600, flag: "wx" }); }
  catch (e) { fail(`couldn't write ${backup} (${e.code}); move the old one away and run again`); }
  wrangler(["secrets-store", "secret", "create", store, "--name", secretName, "--scopes", "workers", "--remote",
    "--comment", "tumbler master key: seals every value in D1"], { input: key, stdio: ["pipe", "inherit", "inherit"] });
  if (!hasMasterKey(store)) fail(`${secretName} didn't appear in store ${store}; the backup in ${backup} is unused`);
  console.log(`\nCreated ${secretName} in store ${store}. A copy is in ${backup} (readable only by you).
Move it into your password manager, then delete the file. Losing it loses every value tumbler stores.\n`);
}

writeFileSync(CONFIG, source.replace(PLACEHOLDER, JSON.stringify(id)));
try {
  const { name } = /"database_name":\s*"(?<name>[^"]+)"/.exec(source).groups;
  // A dry run only bundles: no lookup of the database, no migrations.
  const exists = dryRun || JSON.parse(wrangler(["d1", "list", "--json"])).some((d) => d.name === name);
  const migrate = () => wrangler(["d1", "migrations", "apply", name, "--remote", "-c", CONFIG], { stdio: "inherit" });
  if (exists && !dryRun) migrate();
  wrangler(["deploy", "-c", CONFIG, ...args], { stdio: "inherit" });
  if (!exists) migrate();
} finally {
  rmSync(CONFIG, { force: true });
}

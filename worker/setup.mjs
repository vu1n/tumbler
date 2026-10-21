// setup.mjs — `npm run setup`, once, on your own machine: creates the master key in the account's
// Secrets Store. Every value tumbler stores is sealed under it, so losing it loses them all.
// The key is generated here, handed to wrangler on stdin (never in argv or on screen) and written
// once to a backup file for you to move offline. It never replaces an existing key.
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { fail, hasMasterKey, secretName, storeId, wrangler } from "./account.mjs";

// Why: in CI the backup file would vanish with the runner, leaving a key nobody holds.
if (process.env.CI || process.env.WORKERS_CI) fail("run `npm run setup` on your own machine, not in CI");
const store = storeId();
if (hasMasterKey(store)) { console.log(`${secretName} already exists in store ${store}; nothing to do.`); process.exit(0); }

const key = randomBytes(32).toString("base64"), backup = `${homedir()}/tumbler-master-key.txt`;
// "wx": never overwrite an older backup, which may be the only copy of another key.
try { writeFileSync(backup, key + "\n", { mode: 0o600, flag: "wx" }); }
catch (e) { fail(`couldn't write ${backup} (${e.code}); move the old one away and run again`); }
wrangler(["secrets-store", "secret", "create", store, "--name", secretName, "--scopes", "workers", "--remote",
  "--comment", "tumbler master key: seals every value in D1"], { input: key, stdio: ["pipe", "inherit", "inherit"] });
if (!hasMasterKey(store)) fail(`${secretName} didn't appear in store ${store}; the backup in ${backup} is unused`);
console.log(`\nCreated ${secretName} in store ${store}.
A copy is in ${backup} (readable only by you). Move it into your password manager, then delete the file.
Losing it loses every value tumbler stores.`);

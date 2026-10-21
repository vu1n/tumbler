// deploy.mjs — `npm run deploy`, locally or as the Workers Builds deploy command. Nothing
// account-specific is committed, so nothing has to be kept in sync outside Cloudflare:
//   - The Secrets Store id is looked up (an account has exactly one store) and filled into a
//     throwaway copy of wrangler.jsonc. TUMBLER_STORE_ID overrides the lookup.
//   - The D1 database is created and linked by the first deploy (wrangler's automatic provisioning).
// Migrations run before the deploy, so new code never meets an old schema; on the very first
// deploy the database doesn't exist yet, so they run right after it instead.
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";

const PLACEHOLDER = '"<your-secrets-store-id>"', CONFIG = "wrangler.deploy.jsonc";
const wrangler = (args, opts = {}) => execFileSync("npx", ["wrangler", ...args], { encoding: "utf8", ...opts });
const fail = (msg) => { console.error(`deploy: ${msg}`); process.exit(1); };

function storeId() {
  if (process.env.TUMBLER_STORE_ID) return process.env.TUMBLER_STORE_ID;
  // No --json for this command: read the table's rows, `│ name │ id │ account id │ …`.
  const out = wrangler(["secrets-store", "store", "list", "--remote"], { stdio: ["ignore", "pipe", "inherit"] });
  const ids = [...out.matchAll(/│[^│\n]*│\s*([0-9a-f]{32})\s*│\s*([0-9a-f]{32})\s*│/g)]
    .filter(([, , account]) => !process.env.CLOUDFLARE_ACCOUNT_ID || account === process.env.CLOUDFLARE_ACCOUNT_ID)
    .map(([, id]) => id);
  if (ids.length !== 1) fail(`expected one Secrets Store on the account, found ${ids.length}; set TUMBLER_STORE_ID`);
  return ids[0];
}

const source = readFileSync("wrangler.jsonc", "utf8");
if (!source.includes(PLACEHOLDER)) fail(`wrangler.jsonc has no ${PLACEHOLDER} to fill in`);
const id = storeId();
if (!/^[0-9a-f]{32}$/.test(id)) fail("the Secrets Store id must be 32 hex characters");
writeFileSync(CONFIG, source.replace(PLACEHOLDER, JSON.stringify(id)));

const args = process.argv.slice(2), dryRun = args.includes("--dry-run");
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

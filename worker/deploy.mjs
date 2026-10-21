// deploy.mjs — `npm run deploy`, locally or as the Workers Builds deploy command. Nothing
// account-specific is committed, so nothing has to be kept in sync outside Cloudflare:
//   - The Secrets Store id is looked up (account.mjs) and filled into a throwaway copy of
//     wrangler.jsonc. The master key must already be there (`npm run setup`).
//   - The D1 database is created and linked by the first deploy (wrangler's automatic provisioning).
// Migrations run before the deploy, so new code never meets an old schema; on the very first
// deploy the database doesn't exist yet, so they run right after it instead.
import { rmSync, writeFileSync } from "node:fs";
import { fail, hasMasterKey, PLACEHOLDER, secretName, source, storeId, wrangler } from "./account.mjs";

const CONFIG = "wrangler.deploy.jsonc", args = process.argv.slice(2), dryRun = args.includes("--dry-run");
if (!source.includes(PLACEHOLDER)) fail(`wrangler.jsonc has no ${PLACEHOLDER} to fill in`);
const id = storeId();
if (!dryRun && !hasMasterKey(id)) fail(`no ${secretName} in Secrets Store ${id}; run \`npm run setup\` on your own machine first`);
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

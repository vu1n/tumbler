// account.mjs — what deploy.mjs looks up in the Cloudflare account through wrangler.
// Nothing account-specific is committed: the store id and the master key's presence are read here.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

export const PLACEHOLDER = '"<your-secrets-store-id>"';
export const source = readFileSync(new URL("wrangler.jsonc", import.meta.url), "utf8");
export const secretName = /"secret_name":\s*"([^"]+)"/.exec(source)[1];
export const wrangler = (args, opts = {}) => execFileSync("npx", ["wrangler", ...args], { encoding: "utf8", ...opts });
export const fail = (msg) => { console.error(`tumbler: ${msg}`); process.exit(1); };

// The account's Secrets Store (an account has exactly one). TUMBLER_STORE_ID overrides the lookup.
export function storeId() {
  if (process.env.TUMBLER_STORE_ID) return process.env.TUMBLER_STORE_ID;
  // No --json for this command: read the table's rows, `│ name │ id │ account id │ …`.
  const out = wrangler(["secrets-store", "store", "list", "--remote"], { stdio: ["ignore", "pipe", "inherit"] });
  const ids = [...out.matchAll(/│[^│\n]*│\s*([0-9a-f]{32})\s*│\s*([0-9a-f]{32})\s*│/g)]
    .filter(([, , account]) => !process.env.CLOUDFLARE_ACCOUNT_ID || account === process.env.CLOUDFLARE_ACCOUNT_ID)
    .map(([, id]) => id);
  if (ids.length !== 1) fail(`expected one Secrets Store on the account, found ${ids.length}; set TUMBLER_STORE_ID`);
  if (!/^[0-9a-f]{32}$/.test(ids[0])) fail("the Secrets Store id must be 32 hex characters");
  return ids[0];
}

// Whether the store holds the master key. Names only: the list never shows a value.
export function hasMasterKey(store) {
  const out = wrangler(["secrets-store", "secret", "list", store, "--remote", "--per-page", "100"], { stdio: ["ignore", "pipe", "inherit"] });
  return out.split("\n").some((line) => line.split("│")[1]?.trim() === secretName);
}

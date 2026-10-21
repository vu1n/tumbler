#!/usr/bin/env node
// deploy.mjs — `npm run deploy`, locally and in CI. wrangler.jsonc holds no account's ids, so the same
// repo deploys to any account: the D1 database is found by name (created on the first deploy), and the
// Secrets Store is the account's only one (Secrets Store allows one per account). Then migrations,
// then the Worker. `--dry-run` resolves and prints the ids and stops before changing anything.
//
// Why migrations before deploy: the code being deployed may need the new schema. Migrations are
// additive, so the Worker still running keeps working against it.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const DIR = fileURLToPath(new URL("..", import.meta.url));
const PLACEHOLDER = "<your-secrets-store-id>";
const GENERATED = ".wrangler.deploy.jsonc"; // next to wrangler.jsonc so its relative paths still hold
const dry = process.argv.includes("--dry-run");

const wrangler = (args, capture = true) =>
  execFileSync("npx", ["wrangler", ...args], { cwd: DIR, encoding: "utf8", stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit" });

// The store ids in `wrangler secrets-store store list` output: one table row per store, the store id
// first and the account id after it, each 32 hex.
export function storeIds(table) {
  return table.split("\n").map((line) => line.match(/\b[0-9a-f]{32}\b/)?.[0]).filter(Boolean);
}

export function withStore(config, id) {
  if (!config.includes(PLACEHOLDER)) throw new Error(`wrangler.jsonc has no ${PLACEHOLDER} to fill in`);
  return config.replaceAll(PLACEHOLDER, id);
}

function database(name) {
  const found = JSON.parse(wrangler(["d1", "list", "--json"])).find((d) => d.name === name);
  if (found) return found.uuid;
  if (dry) return "(created on deploy)";
  console.log(`Creating D1 database ${name}`);
  wrangler(["d1", "create", name], false);
  return JSON.parse(wrangler(["d1", "list", "--json"])).find((d) => d.name === name).uuid;
}

function store(config) {
  if (!config.includes(PLACEHOLDER)) return null; // an install that committed its own store id
  const ids = storeIds(wrangler(["secrets-store", "store", "list", "--remote", "--per-page", "100"]));
  if (ids.length !== 1) throw new Error(`expected the account's one Secrets Store, found ${ids.length}; put the store id in wrangler.jsonc`);
  return ids[0];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const source = readFileSync(`${DIR}/wrangler.jsonc`, "utf8");
  const name = source.match(/"database_name":\s*"([^"]+)"/)[1];
  const db = database(name), id = store(source);
  console.log(`D1 ${name}: ${db}\nSecrets Store: ${id ?? "(from wrangler.jsonc)"}`);
  if (dry) process.exit(0);
  writeFileSync(`${DIR}/${GENERATED}`, id ? withStore(source, id) : source);
  try {
    wrangler(["d1", "migrations", "apply", "DB", "--remote", "--config", GENERATED], false);
    wrangler(["deploy", "--config", GENERATED], false);
  } finally { rmSync(`${DIR}/${GENERATED}`, { force: true }); }
}

import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-ignore: a plain .mjs script, no types
import { storeIds, withStore } from "../scripts/deploy.mjs";

test("storeIds takes the store id from each row, not the account id", () => {
  const table = [
    "┌───────────────────────┬──────────────────────────────────┬──────────────────────────────────┐",
    "│ Name                  │ ID                               │ AccountID                        │",
    "├───────────────────────┼──────────────────────────────────┼──────────────────────────────────┤",
    "│ default_secrets_store │ 0123456789abcdef0123456789abcdef │ fedcba9876543210fedcba9876543210 │",
    "└───────────────────────┴──────────────────────────────────┴──────────────────────────────────┘",
  ].join("\n");
  assert.deepEqual(storeIds(table), ["0123456789abcdef0123456789abcdef"]);
  assert.deepEqual(storeIds("🔐 Listing stores...\n"), []);
});

test("withStore fills the placeholder and refuses a config without one", () => {
  const cfg = `{ "store_id": "<your-secrets-store-id>" }`;
  assert.equal(withStore(cfg, "abc"), `{ "store_id": "abc" }`);
  assert.throws(() => withStore(`{ "store_id": "abc" }`, "def"));
});

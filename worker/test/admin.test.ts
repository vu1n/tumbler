import assert from "node:assert/strict";
import { test } from "node:test";
import { ADMIN_HTML } from "../src/admin.ts";

// Why: the page lives in a template literal, so a "\n" in its script becomes a raw newline and
// kills the whole script. The forms then submit natively, and a GET would put values in the URL.
test("admin page script parses", () => {
  const scripts = [...ADMIN_HTML.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.ok(scripts.length > 0);
  for (const s of scripts) assert.doesNotThrow(() => new Function(s));
});

test("admin forms never submit with GET", () => {
  const forms = [...ADMIN_HTML.matchAll(/<form\b[^>]*>/g)].map((m) => m[0]);
  assert.ok(forms.length > 0);
  for (const f of forms) assert.match(f, /method="post"/, f);
});

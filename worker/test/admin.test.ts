// The admin page's script, as served: a template-literal escape slip once broke all of it, and the
// browser then submitted the key form as a GET with the value in the URL.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ADMIN_HTML } from "../src/admin.ts";
import { staticCheck } from "../src/verify.ts";

test("the served admin script parses", () => {
  const script = ADMIN_HTML.split("<script>")[1].split("</script>")[0];
  assert.doesNotThrow(() => new Function(script));
});

test("every admin form posts, so a value never lands in a URL", () => {
  const forms = ADMIN_HTML.match(/<form[^>]*>/g) ?? [];
  assert.ok(forms.length > 0);
  for (const f of forms) assert.match(f, /method="post"/);
});

test("every field on the page has a visible label", () => {
  const markup = ADMIN_HTML.split("<script>")[0];
  const labelled = new Set([...markup.matchAll(/<label for="([^"]+)"/g)].map((m) => m[1]));
  const fields = [...markup.matchAll(/<(input|select|textarea)\b[^>]*>/g)].map((m) => m[0]);
  assert.ok(fields.length > 0);
  for (const f of fields) assert.ok(labelled.has(/\bid="([^"]+)"/.exec(f)?.[1] ?? ""), `no label for ${f}`);
});

test("each config example in the key form's hint is one the server accepts", () => {
  const hint = /<span data-for="static">(.*?)<\/span>/.exec(ADMIN_HTML)?.[1] ?? "";
  // Each {"check": …} object in the hint, braces balanced; "…" stands for the caller's own URL.
  const examples = [...hint.matchAll(/\{"check"/g)].map(({ index = 0 }) => {
    let depth = 0, end = index;
    for (; end < hint.length; end++) if (hint[end] === "{") depth++; else if (hint[end] === "}" && --depth === 0) break;
    return JSON.parse(hint.slice(index, end + 1).replace("https://…", "https://api.example.com/v1/me"));
  });
  assert.ok(examples.length >= 2);
  for (const c of examples) assert.doesNotThrow(() => staticCheck(c), JSON.stringify(c));
});

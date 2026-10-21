// The admin page's script, as served: a template-literal escape slip once broke all of it, and the
// browser then submitted the key form as a GET with the value in the URL.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ADMIN_HTML } from "../src/admin.ts";

test("the served admin script parses", () => {
  const script = ADMIN_HTML.split("<script>")[1].split("</script>")[0];
  assert.doesNotThrow(() => new Function(script));
});

test("every admin form posts, so a value never lands in a URL", () => {
  const forms = ADMIN_HTML.match(/<form[^>]*>/g) ?? [];
  assert.ok(forms.length > 0);
  for (const f of forms) assert.match(f, /method="post"/);
});

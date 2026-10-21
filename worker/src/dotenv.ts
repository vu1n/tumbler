// dotenv.ts — parse a pasted .env file for the admin import. Errors name a line number only, never
// its text: a malformed line may still hold a value.

export interface Parsed { entries: { name: string; value: string; line: number }[]; errors: { line: number; error: string }[] }

const ESCAPES: Record<string, string> = { n: "\n", r: "\r", t: "\t", '"': '"', "\\": "\\" };

export function parseDotenv(text: string): Parsed {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/), entries: Parsed["entries"] = [], errors: Parsed["errors"] = [];
  for (let i = 0; i < lines.length; i++) {
    const start = i + 1, line = lines[i].trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/.exec(line);
    if (!m) { errors.push({ line: start, error: "not NAME=value" }); continue; }
    const [, name] = m;
    const rest = m[2];
    let value: string;
    if (rest.startsWith('"') || rest.startsWith("'") || rest.startsWith("`")) {
      // A quoted value may span lines, as dotenv allows; the quote is closed by the first unescaped match.
      const q = rest[0];
      let body = rest.slice(1), end = closing(body, q);
      while (end < 0 && i + 1 < lines.length) { body += "\n" + lines[++i]; end = closing(body, q); }
      if (end < 0) { errors.push({ line: start, error: `unclosed ${q} quote` }); continue; }
      const after = body.slice(end + 1).trim();
      if (after && !after.startsWith("#")) { errors.push({ line: start, error: "text after the closing quote" }); continue; }
      value = body.slice(0, end);
      if (q === '"') value = value.replace(/\\(.)/gs, (s, c: string) => ESCAPES[c] ?? s);
    } else {
      value = rest.replace(/\s+#.*$/, "").trim(); // an unquoted value ends at a " #" comment
    }
    entries.push({ name, value, line: start });
  }
  return { entries, errors };
}

function closing(body: string, q: string) {
  for (let i = 0; i < body.length; i++) {
    if (body[i] === "\\" && q === '"') { i++; continue; }
    if (body[i] === q) return i;
  }
  return -1;
}

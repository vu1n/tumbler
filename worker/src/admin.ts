// admin.ts — the admin page. Values are write-only here: the page can set or rotate one, never read it.
// Grants show state and scopes only, never a minted child.
// ADMIN_HTML is a template literal: a backslash in the script must be doubled (\\n, \\'), or the
// served script stops parsing. test/admin.test.ts parses it. The forms are method="post" so that if
// the script ever fails, a value is never put in a URL.
export const ADMIN_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Tumbler</title>
<style>
:root{--bg:#fafaf9;--fg:#1c1917;--muted:#78716c;--line:#e7e5e4;--accent:#0f766e;--warn:#b45309}
@media (prefers-color-scheme:dark){:root{--bg:#1c1917;--fg:#f5f5f4;--muted:#a8a29e;--line:#44403c;--accent:#2dd4bf;--warn:#f59e0b}}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,sans-serif}
main{max-width:960px;margin:0 auto;padding:16px}
h1{font-size:20px}h2{font-size:16px;margin-top:32px}
table{width:100%;border-collapse:collapse}td,th{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--muted);font-weight:500}.muted{color:var(--muted)}.warn{color:var(--warn)}
textarea{font:12px/1.4 ui-monospace,monospace;padding:6px 8px;border:1px solid var(--line);border-radius:6px;background:transparent;color:inherit;width:100%;min-height:72px;display:none}
select{font:inherit;padding:6px 8px;border:1px solid var(--line);border-radius:6px;background:transparent;color:inherit}
form{display:flex;flex-wrap:wrap;gap:8px;margin:12px 0}input{font:inherit;padding:6px 8px;border:1px solid var(--line);border-radius:6px;background:transparent;color:inherit;min-width:0}
button{font:inherit;padding:6px 12px;border:1px solid var(--accent);border-radius:6px;background:transparent;color:var(--accent);cursor:pointer}
code{font-family:ui-monospace,monospace;word-break:break-all}.wrap{overflow-x:auto}
textarea.env{display:block;min-height:120px}
#once{padding:12px;border:1px solid var(--warn);border-radius:6px;display:none}
</style></head><body><main>
<h1>Tumbler</h1>
<p class="muted">One store for env vars and keys. Values are never shown after they're saved. A key with a check is tested before a new value is saved; if the test fails, nothing is saved.</p>

<h2>Keys</h2>
<div class="wrap"><table><thead><tr><th>Name</th><th>Scope</th><th>Kind</th><th>Checked</th><th>Description</th><th>Rotated</th><th>Expires</th><th></th></tr></thead><tbody id="keys"></tbody></table></div>
<form id="putKey" method="post">
  <input name="name" placeholder="NAME" required pattern="[A-Z_][A-Z0-9_]*">
  <input name="scope" placeholder="global or project" value="global" required>
  <select name="kind" title="static: the value is handed out. mint: the value is a parent token that mints short-lived children.">
    <option value="static">static</option><option value="mint:cloudflare">mint:cloudflare</option>
  </select>
  <input name="value" type="password" placeholder="value (parent token for mint)" required autocomplete="off">
  <input name="description" placeholder="what it's for">
  <input name="expires_at" type="date" title="expires">
  <button>Save</button>
  <textarea name="config" placeholder='Optional. Left empty: workers:read (Workers, D1, KV, R2 read; granted on request) and workers:write (the same, write; waits for you here), on the account in CLOUDFLARE_ACCOUNT_ID. To choose: {"scopes": {"pages:write": ["Pages Write"]}, "start": [], "ttl_minutes": 30}, with Cloudflare permission names or ids.'></textarea>
</form>

<form id="importEnv" method="post">
  <textarea class="env" name="text" required spellcheck="false" autocomplete="off" placeholder="Paste a .env to save many static keys at once:&#10;OPENAI_API_KEY=sk-...&#10;export AWS_REGION=&quot;us-east-1&quot;  # comments, quotes and export are fine"></textarea>
  <input name="scope" placeholder="global or project" value="global" required>
  <button>Preview</button>
</form>
<div id="importPlan"></div>

<h2>Grants</h2>
<p class="muted">Minted keys. Read scopes are granted on request; anything else waits here for you.</p>
<p id="revokePending" class="warn"></p>
<p>Approve for <select id="approveFor" title="After approving, the same caller gets these scopes on this key again without asking until then, on any project its pin reaches. Children stay short-lived.">
  <option value="0">this token only</option><option value="60" selected>1 hour</option><option value="480">8 hours</option><option value="1440">24 hours</option></select></p>
<div class="wrap"><table><thead><tr><th>Key</th><th>Caller</th><th>Project</th><th>State</th><th>Scopes</th><th>Wants</th><th>Expires</th><th></th></tr></thead><tbody id="grants"></tbody></table></div>
<h3>Standing approvals</h3>
<div class="wrap"><table><thead><tr><th>Key</th><th>Caller</th><th>Scopes</th><th>By</th><th>Until</th><th></th></tr></thead><tbody id="approvals"></tbody></table></div>

<h2>Tokens</h2>
<div id="once"></div>
<div class="wrap"><table><thead><tr><th>Name</th><th>Pinned to</th><th>Created</th><th>Expires</th><th></th></tr></thead><tbody id="tokens"></tbody></table></div>
<form id="newToken" method="post">
  <input name="name" placeholder="token name" required>
  <input name="projects" placeholder="projects, comma-separated (empty = global only)">
  <input name="hours" type="number" min="1" step="1" placeholder="expires in hours (empty = never)" title="The token stops working then; grants it holds are ended by the next sweep.">
  <button>Create</button>
</form>

<h2>Audit</h2>
<div class="wrap"><table><thead><tr><th>When</th><th>Who</th><th>Action</th><th>Project</th><th>Keys</th></tr></thead><tbody id="audit"></tbody></table></div>
</main><script>
const api = (p, o = {}) => fetch('/admin/api/' + p, { ...o, headers: { 'content-type': 'application/json', 'x-tumbler-admin': '1' } })
  .then(async r => { const b = await r.json(); if (!r.ok) throw Object.assign(new Error(b.error || r.status), { canSkip: !!b.can_skip }); return b; });
const td = (t, cls) => { const e = document.createElement('td'); e.textContent = t ?? ''; if (cls) e.className = cls; return e; };
const btn = (label, fn) => { const c = document.createElement('td'), b = document.createElement('button'); b.textContent = label; b.onclick = fn; c.append(b); return c; };
const day = s => s ? s.slice(0, 10) : '';
const stale = s => s && Date.parse(s) < Date.now() + 7 * 864e5;
async function load() {
  const [{ keys }, { tokens }, { audit }, { grants, approvals = [], revoke_pending }] = await Promise.all([api('keys'), api('tokens'), api('audit'), api('grants').catch(() => ({ grants: [], approvals: [] }))]);
  document.getElementById('revokePending').textContent = revoke_pending
    ? revoke_pending + ' revoked token(s) could not be deleted at the provider yet; retrying every five minutes until they expire.' : '';
  document.getElementById('keys').replaceChildren(...keys.map(k => { const tr = document.createElement('tr');
    tr.append(td(k.name), td(k.scope), td(k.kind), td(k.checked ? 'yes' : 'no', k.checked ? '' : 'muted'), td(k.description, 'muted'), td(day(k.rotated_at)), td(day(k.expires_at), stale(k.expires_at) ? 'warn' : ''),
      btn('Delete', async () => { if (confirm('Delete ' + k.scope + '/' + k.name + '?')) { await api('keys/' + encodeURIComponent(k.scope) + '/' + encodeURIComponent(k.name), { method: 'DELETE' }); load(); } }));
    return tr; }));
  const act = (label, path, method, body) => async () => { try { await api('grants/' + path, { method, body: body && JSON.stringify(body) }); } catch (err) { alert(err.message); } load(); };
  document.getElementById('grants').replaceChildren(...grants.map(g => { const tr = document.createElement('tr'), live = g.state === 'active' || g.state === 'pending', c = document.createElement('td');
    tr.append(td(g.name), td(g.caller), td(g.project ?? 'global'), td(g.state, g.requested ? 'warn' : ''), td(g.scopes.join(', ')),
      td((g.requested ?? []).join(', '), 'warn'), td((g.expires_at ?? '').replace('T', ' ').slice(0, 16)), c);
    const b = (label, fn) => { const e = document.createElement('button'); e.textContent = label; e.onclick = fn; c.append(e, ' '); };
    if (g.requested) { b('Approve', act('approve', g.id + '/approve', 'POST', { requested: g.requested, for_minutes: Number(document.getElementById('approveFor').value) })); b('Deny', act('deny', g.id + '/deny', 'POST')); }
    if (live) b('Revoke', async () => { if (confirm('Revoke ' + g.name + ' for ' + g.caller + '? Its token stops working now, and its next request waits for your approval for a day.')) act('', g.id, 'DELETE')(); });
    return tr; }));
  document.getElementById('approvals').replaceChildren(...approvals.map(a => { const tr = document.createElement('tr');
    tr.append(td(a.name), td(a.caller), td(a.scopes.join(', ')), td(a.approved_by, 'muted'), td(a.until.replace('T', ' ').slice(0, 16) + ' UTC'),
      btn('End', async () => { try { await api('approvals/' + a.id, { method: 'DELETE' }); } catch (err) { alert(err.message); } load(); }));
    return tr; }));
  document.getElementById('tokens').replaceChildren(...tokens.map(t => { const tr = document.createElement('tr');
    const expired = t.expires_at && Date.parse(t.expires_at) <= Date.now();
    // A pin is edited in place, so reaching one more project never means a new token.
    const pin = btn(t.projects ? t.projects.join(', ') : 'global only', async () => {
      const next = prompt('Projects ' + t.name + ' reads, comma-separated (empty = global only). With several, a command that names none reads globals only.', (t.projects ?? []).join(', '));
      if (next === null) return;
      try { await api('tokens/' + encodeURIComponent(t.name), { method: 'PATCH', body: JSON.stringify({ projects: next.split(',').map(s => s.trim()).filter(Boolean) }) }); } catch (err) { alert(err.message); }
      load(); });
    pin.firstChild.title = 'Edit pin';
    tr.append(td(t.name), t.revoked_at ? td(t.projects ? t.projects.join(', ') : 'global only') : pin, td(day(t.created_at)),
      td(t.expires_at ? (expired ? 'expired ' : '') + t.expires_at.slice(0, 16).replace('T', ' ') + ' UTC' : 'never', expired ? 'muted' : ''),
      t.revoked_at ? td('revoked ' + day(t.revoked_at), 'muted') : btn('Revoke', async () => { if (confirm('Revoke ' + t.name + '?')) { await api('tokens/' + encodeURIComponent(t.name), { method: 'DELETE' }); load(); } }));
    return tr; }));
  document.getElementById('audit').replaceChildren(...audit.map(a => { const tr = document.createElement('tr');
    tr.append(td(a.at.replace('T', ' ').slice(0, 19)), td(a.actor), td(a.action), td(a.project), td(a.names, 'muted')); return tr; }));
}
const putKey = document.getElementById('putKey');
const STATIC_HINT = '{"check": "openai"}  (optional: anthropic, openai, github, stripe, cloudflare, or {"url": "https://…", "header": "authorization", "prefix": "Bearer "})';
putKey.kind.onchange = () => { putKey.config.placeholder = putKey.kind.value === 'static' ? STATIC_HINT : MINT_HINT;
  if (putKey.kind.value === 'mint:cloudflare' && !putKey.name.value) putKey.name.value = 'CLOUDFLARE_API_TOKEN'; };
const MINT_HINT = putKey.config.placeholder; putKey.config.style.display = 'block'; putKey.kind.onchange();
putKey.onsubmit = async e => { e.preventDefault(); const f = new FormData(e.target), kind = f.get('kind');
  const put = skip_check => { const config = !String(f.get('config')).trim() ? undefined : JSON.parse(f.get('config'));
    return api('keys/' + encodeURIComponent(f.get('scope')) + '/' + encodeURIComponent(f.get('name')), { method: 'PUT',
    body: JSON.stringify({ value: f.get('value'), kind, config, skip_check, description: f.get('description'), expires_at: f.get('expires_at') || null }) }); };
  try { await put(false); e.target.reset(); load(); } catch (err) {
    // The check couldn't run (the service is down): offer to save unchecked, e.g. to replace a leaked key.
    if (!err.canSkip || !confirm(err.message + '\\n\\nSave it unchecked anyway? Running commands with --watch won\\'t get it pushed.')) return alert(err.message);
    try { await put(true); e.target.reset(); load(); } catch (err2) { alert(err2.message); } } };
// Paste a .env: preview what each line does, then save. The text goes in a POST body only.
const importEnv = document.getElementById('importEnv'), importPlan = document.getElementById('importPlan');
const showPlan = (r, onSave) => { const rows = [...r.errors.map(e => ['line ' + e.line, '', 'error', e.error]),
    ...r.keys.map(k => [String(k.line), k.name, k.action, k.reason || (k.checked ? 'tested before saving' : '')])];
  const table = document.createElement('table');
  table.replaceChildren(...rows.map(([line, name, action, note]) => { const tr = document.createElement('tr');
    tr.append(td(line, 'muted'), td(name), td(action, ['error', 'failed', 'overwrite'].includes(action) ? 'warn' : action === 'skip' ? 'muted' : ''), td(note, 'muted')); return tr; }));
  const parts = [table], n = r.keys.filter(k => k.action === 'create' || k.action === 'overwrite').length;
  if (r.saved) parts.push(Object.assign(document.createElement('p'), { textContent: 'Saved ' + r.saved.length + ' key(s) to ' + r.scope + '.' }));
  else if (r.errors.length) parts.push(Object.assign(document.createElement('p'), { className: 'warn', textContent: 'Fix the lines marked error, then preview again.' }));
  else if (n) { const b = document.createElement('button'); b.type = 'button'; b.textContent = 'Save ' + n + ' key(s) to ' + r.scope; b.onclick = onSave; parts.push(b); }
  importPlan.replaceChildren(...parts); };
const importCall = save => api('import', { method: 'POST', body: JSON.stringify({ scope: importEnv.scope.value, text: importEnv.text.value, save }) });
importEnv.text.oninput = importEnv.scope.oninput = () => importPlan.replaceChildren();
importEnv.onsubmit = async e => { e.preventDefault();
  try { showPlan(await importCall(false), async () => {
    try { const r = await importCall(true); showPlan(r); if (r.saved.length === r.keys.filter(k => k.action !== 'skip').length) importEnv.text.value = ''; load(); }
    catch (err) { alert(err.message); } }); } catch (err) { alert(err.message); } };
document.getElementById('newToken').onsubmit = async e => { e.preventDefault(); const f = new FormData(e.target);
  const projects = String(f.get('projects')).split(',').map(s => s.trim()).filter(Boolean);
  const hours = Number(f.get('hours')), expires_at = hours > 0 ? new Date(Date.now() + hours * 3600_000).toISOString() : null;
  try { const r = await api('tokens', { method: 'POST', body: JSON.stringify({ name: f.get('name'), projects, expires_at }) });
    const once = document.getElementById('once'); once.style.display = 'block';
    const copy = (label, text) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = label;
      b.onclick = () => navigator.clipboard.writeText(text).then(() => { b.textContent = 'Copied'; setTimeout(() => b.textContent = label, 1500); }, () => alert('Copy failed; select the token and copy it by hand.')); return b; };
    once.replaceChildren('Copy this token now; it will not be shown again. Add it as a network secret on the environment: ', Object.assign(document.createElement('code'), { textContent: r.token }),
      ' ', copy('Copy', r.token), ' ', copy('Copy as "Bearer …"', 'Bearer ' + r.token));
    e.target.reset(); load(); } catch (err) { alert(err.message); } };
load().catch(err => alert(err.message));
</script></body></html>`;

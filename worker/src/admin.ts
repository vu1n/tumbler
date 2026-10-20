// admin.ts — the admin page. Values are write-only here: the page can set or rotate one, never read it.
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
form{display:flex;flex-wrap:wrap;gap:8px;margin:12px 0}input{font:inherit;padding:6px 8px;border:1px solid var(--line);border-radius:6px;background:transparent;color:inherit;min-width:0}
button{font:inherit;padding:6px 12px;border:1px solid var(--accent);border-radius:6px;background:transparent;color:var(--accent);cursor:pointer}
code{font-family:ui-monospace,monospace;word-break:break-all}.wrap{overflow-x:auto}
#once{padding:12px;border:1px solid var(--warn);border-radius:6px;display:none}
</style></head><body><main>
<h1>Tumbler</h1>
<p class="muted">One store for env vars and keys. Values are never shown after they're saved.</p>

<h2>Keys</h2>
<div class="wrap"><table><thead><tr><th>Name</th><th>Scope</th><th>Description</th><th>Rotated</th><th>Expires</th><th></th></tr></thead><tbody id="keys"></tbody></table></div>
<form id="putKey">
  <input name="name" placeholder="NAME" required pattern="[A-Z_][A-Z0-9_]*">
  <input name="scope" placeholder="global or project" value="global" required>
  <input name="value" type="password" placeholder="value" required autocomplete="off">
  <input name="description" placeholder="what it's for">
  <input name="expires_at" type="date" title="expires">
  <button>Save</button>
</form>

<h2>Tokens</h2>
<div id="once"></div>
<div class="wrap"><table><thead><tr><th>Name</th><th>Pinned to</th><th>Created</th><th></th></tr></thead><tbody id="tokens"></tbody></table></div>
<form id="newToken">
  <input name="name" placeholder="token name" required>
  <input name="projects" placeholder="projects, comma-separated (empty = global only)">
  <button>Create</button>
</form>

<h2>Audit</h2>
<div class="wrap"><table><thead><tr><th>When</th><th>Who</th><th>Action</th><th>Project</th><th>Keys</th></tr></thead><tbody id="audit"></tbody></table></div>
</main><script>
const api = (p, o = {}) => fetch('/admin/api/' + p, { ...o, headers: { 'content-type': 'application/json', 'x-tumbler-admin': '1' } })
  .then(async r => { const b = await r.json(); if (!r.ok) throw new Error(b.error || r.status); return b; });
const td = (t, cls) => { const e = document.createElement('td'); e.textContent = t ?? ''; if (cls) e.className = cls; return e; };
const btn = (label, fn) => { const c = document.createElement('td'), b = document.createElement('button'); b.textContent = label; b.onclick = fn; c.append(b); return c; };
const day = s => s ? s.slice(0, 10) : '';
const stale = s => s && Date.parse(s) < Date.now() + 7 * 864e5;
async function load() {
  const [{ keys }, { tokens }, { audit }] = await Promise.all([api('keys'), api('tokens'), api('audit')]);
  document.getElementById('keys').replaceChildren(...keys.map(k => { const tr = document.createElement('tr');
    tr.append(td(k.name), td(k.scope), td(k.description, 'muted'), td(day(k.rotated_at)), td(day(k.expires_at), stale(k.expires_at) ? 'warn' : ''),
      btn('Delete', async () => { if (confirm('Delete ' + k.scope + '/' + k.name + '?')) { await api('keys/' + encodeURIComponent(k.scope) + '/' + encodeURIComponent(k.name), { method: 'DELETE' }); load(); } }));
    return tr; }));
  document.getElementById('tokens').replaceChildren(...tokens.map(t => { const tr = document.createElement('tr');
    tr.append(td(t.name), td(t.projects ? t.projects.join(', ') : 'global only'), td(day(t.created_at)),
      t.revoked_at ? td('revoked ' + day(t.revoked_at), 'muted') : btn('Revoke', async () => { if (confirm('Revoke ' + t.name + '?')) { await api('tokens/' + encodeURIComponent(t.name), { method: 'DELETE' }); load(); } }));
    return tr; }));
  document.getElementById('audit').replaceChildren(...audit.map(a => { const tr = document.createElement('tr');
    tr.append(td(a.at.replace('T', ' ').slice(0, 19)), td(a.actor), td(a.action), td(a.project), td(a.names, 'muted')); return tr; }));
}
document.getElementById('putKey').onsubmit = async e => { e.preventDefault(); const f = new FormData(e.target);
  try { await api('keys/' + encodeURIComponent(f.get('scope')) + '/' + encodeURIComponent(f.get('name')), { method: 'PUT',
    body: JSON.stringify({ value: f.get('value'), description: f.get('description'), expires_at: f.get('expires_at') || null }) });
    e.target.reset(); load(); } catch (err) { alert(err.message); } };
document.getElementById('newToken').onsubmit = async e => { e.preventDefault(); const f = new FormData(e.target);
  const projects = String(f.get('projects')).split(',').map(s => s.trim()).filter(Boolean);
  try { const r = await api('tokens', { method: 'POST', body: JSON.stringify({ name: f.get('name'), projects }) });
    const once = document.getElementById('once'); once.style.display = 'block';
    once.replaceChildren('Copy this token now; it will not be shown again. Add it as a network secret on the environment: ', Object.assign(document.createElement('code'), { textContent: r.token }));
    e.target.reset(); load(); } catch (err) { alert(err.message); } };
load().catch(err => alert(err.message));
</script></body></html>`;

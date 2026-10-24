// admin.ts — the admin page. Values are write-only here: the page can set or rotate one, never read it.
// Grants show state and scopes only, never a minted child.
// ADMIN_HTML is a template literal: a backslash in the script must be doubled (\\n, \\'), or the
// served script stops parsing, and the script must not use backticks or a dollar-brace. test/admin.test.ts
// parses it. The forms are method="post" so that if the script ever fails, a value is never put in a URL.
// The visual system (tokens, button roles, the phone layout) is recorded in DESIGN.md at the repo root.
export const ADMIN_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Tumbler</title>
<style>
:root{color-scheme:light dark;--bg:#fafaf9;--fg:#1c1917;--muted:#78716c;--line:#e7e5e4;--edge:#8f8984;--accent:#0f766e;--on-accent:#fafaf9;--warn:#b45309;--danger:#b91c1c}
@media (prefers-color-scheme:dark){:root{--bg:#1c1917;--fg:#f5f5f4;--muted:#a8a29e;--line:#44403c;--edge:#78716c;--accent:#2dd4bf;--on-accent:#1c1917;--warn:#f59e0b;--danger:#f87171}}
*{box-sizing:border-box}[hidden]{display:none!important}
html{accent-color:var(--accent);caret-color:var(--accent);scrollbar-color:var(--edge) transparent}
::selection{background:color-mix(in srgb,var(--accent) 28%,transparent)}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,sans-serif}
main{max-width:1120px;margin:0 auto;padding:16px 16px 96px}
h1{font-size:20px;margin:8px 0 4px}h2{font-size:16px;margin:40px 0 4px;scroll-margin-top:16px}
p{max-width:60ch;margin:4px 0 12px;text-wrap:pretty}
a{color:var(--accent);text-underline-offset:3px}
code,.mono{font-family:ui-monospace,monospace}code{font-size:13px}
.muted{color:var(--muted)}.warn{color:var(--warn)}.danger{color:var(--danger)}.nw{white-space:nowrap;font-variant-numeric:tabular-nums}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
nav{display:flex;flex-wrap:wrap;gap:4px 20px;margin:12px 0 0;padding:8px 0;border-block:1px solid var(--line)}
nav a{text-decoration:none}nav a:hover{text-decoration:underline}nav span{color:var(--muted)}
table{width:100%;border-collapse:collapse}
td,th{text-align:left;padding:8px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--muted);font-weight:500}
td.acts{white-space:nowrap;text-align:right;padding-block:1px}td.ended{white-space:nowrap;text-align:right;padding-right:17px}
tr.off td{color:var(--muted)}tr.empty td{color:var(--muted);padding:16px 8px}
.wrap{overflow-x:auto}
button{font:inherit;padding:6px 12px;border:1px solid var(--accent);border-radius:6px;background:transparent;color:var(--accent);cursor:pointer;transition:background-color .15s ease-out,color .15s ease-out}
button.primary{background:var(--accent);color:var(--on-accent)}
button.quiet{border-color:transparent;padding-inline:8px}
button.del{border-color:transparent;padding-inline:8px;color:var(--muted)}
button.del:focus-visible{color:var(--danger);background:color-mix(in srgb,var(--danger) 10%,transparent)}
@media (hover:hover){button:hover{background:color-mix(in srgb,var(--accent) 10%,transparent)}
  button.primary:hover{background:color-mix(in srgb,var(--accent) 85%,var(--fg))}
  button.del:hover{color:var(--danger);background:color-mix(in srgb,var(--danger) 10%,transparent)}}
button:disabled{opacity:.55;cursor:not-allowed}button[aria-busy=true]{cursor:progress;opacity:1}
form[inert] :is(.f,.note,button:not([aria-busy=true])){opacity:.55}
input,select,textarea{font:inherit;color:inherit;background:transparent;border:1px solid var(--edge);border-radius:6px;padding:6px 8px;min-width:0;width:100%}
input[readonly],textarea[readonly],select:disabled{border-style:dashed;color:inherit;opacity:1}
input[type=checkbox]{width:16px;height:16px;margin:0;flex:none}
textarea{font:12px/1.4 ui-monospace,monospace;min-height:96px;resize:vertical}
::placeholder{color:var(--muted);opacity:1}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
input:focus-visible,select:focus-visible,textarea:focus-visible{outline-offset:0;border-color:var(--accent)}
details.act{border-top:1px solid var(--line)}details.act:last-of-type{border-bottom:1px solid var(--line)}
details.act+details.act{margin-top:-1px}.acts-group>details.act:first-child{border-top:0}
summary{cursor:pointer;color:var(--accent);padding:10px 4px;width:fit-content}summary::marker{color:var(--accent)}
.fields{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:12px;margin:4px 0 16px;align-items:start}
.f{display:flex;flex-direction:column;gap:4px}.f>label{font-weight:500}.full{grid-column:1/-1}
.hint{color:var(--muted);font-size:13px;max-width:62ch}
.check{flex-direction:row;flex-wrap:wrap;align-items:center;gap:4px 8px;padding-top:24px}.check label{font-weight:500}.check .hint{flex-basis:100%}.check.full{padding-top:0}
.bar{grid-column:1/-1;display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.chips{display:flex;gap:6px;flex-wrap:wrap}
.chips button{padding:2px 10px;border-radius:999px;font-size:12px}
.chips button[aria-pressed=true]{background:var(--accent);color:var(--on-accent)}
.note{grid-column:1/-1;margin:0}
.notice{border:1px solid var(--warn);border-radius:6px;padding:8px 12px;color:var(--warn);max-width:none}
#once{border:1px solid var(--warn);border-radius:6px;padding:12px;margin:12px 0;scroll-margin-bottom:96px}
#once p{margin:0 0 8px}#once textarea{font-size:13px;min-height:0;resize:none;overflow:hidden;word-break:break-all;field-sizing:content;margin-bottom:8px}
#status{position:fixed;left:50%;bottom:16px;transform:translateX(-50%);width:min(600px,calc(100% - 32px));display:flex;gap:12px;align-items:center;justify-content:space-between;padding:8px 8px 8px 12px;background:var(--bg);border:1px solid var(--edge);border-radius:6px;outline:8px solid var(--bg)}
#status.error{border-color:var(--danger);color:var(--danger)}
@media (pointer:coarse){button,summary,input:not([type=checkbox]),select{min-height:44px}.chips button{min-height:40px}
  input[type=checkbox]{width:20px;height:20px}.check label{min-height:44px;display:flex;align-items:center}}
@media (min-width:720px){.w2{grid-column:span 2}}
@media (min-width:641px){th,table.rec td:first-child{white-space:nowrap}
  #newToken{grid-template-columns:minmax(0,1fr) minmax(0,1fr);max-width:62ch}#newToken .hint{max-width:none}}
@media (max-width:640px){
  table.rec thead{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}
  table.rec tr{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:6px 16px;padding:12px 0;border-bottom:1px solid var(--line)}
  table.rec td{display:block;padding:0;border:0;overflow-wrap:break-word}table.rec .at{white-space:normal}
  table.rec td::before{content:attr(data-label);display:block;color:var(--muted);font-size:12px}
  table.rec td:first-child,table.rec td.name,table.rec td.acts,table.rec td.ended,table.rec tr.empty td,table.rec tr.editor td{grid-column:1/-1}
  table.rec tr:not(.empty) td:first-child{font-weight:600}table.rec td:first-child::before,table.rec td.acts::before,table.rec td.ended::before,table.rec tr.empty td::before,table.rec tr.editor td::before{content:none}
  table.rec td:empty{display:none}
  table.rec td.acts{display:flex;gap:8px;text-align:left;margin-left:-8px}table.rec td.ended{text-align:left;padding:0}
  table.log tr{display:flex;flex-wrap:wrap;gap:0 10px;padding:10px 0;border-bottom:1px solid var(--line)}
  table.log tr::before{content:'';flex-basis:100%}table.log td:first-child{order:-1}
  table.log thead{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}
  table.log td{display:inline;padding:0;border:0;min-width:0;overflow-wrap:break-word}table.log td:nth-child(3){font-weight:600;order:-2}table.log td:nth-child(4):not(:empty)::before{content:'in ';color:var(--muted)}
  table.log td:last-child{flex-basis:100%}
}
</style></head><body><main>
<h1>Tumbler</h1>
<p class="muted">One store for env vars and keys. Values are never shown after they're saved. A key with a check is tested before a new value is saved; if the test fails, nothing is saved. Sessions work through the CLI (<code>tumbler run</code>, <code>tumbler put</code>); this page is for reviewing what's stored and for what only you may do.</p>
<nav aria-label="Sections"><a href="#s-keys">Keys <span id="nKeys"></span></a><a href="#s-grants">Grants <span id="nGrants"></span></a><a href="#s-tokens">Tokens <span id="nTokens"></span></a><a href="#s-audit">Audit</a></nav>

<section aria-labelledby="s-keys"><h2 id="s-keys">Keys</h2>
<div class="wrap"><table class="rec"><thead><tr><th>Name</th><th>Scope</th><th>Kind</th><th>Check</th><th>Description</th><th>Rotated</th><th>Expires</th><th><span class="sr">Actions</span></th></tr></thead><tbody id="keys"></tbody></table></div>
<div class="acts-group">
<details class="act" id="addKey"><summary>Add a key or replace a value</summary>
<form id="putKey" method="post" class="fields">
  <div class="f"><label for="kName">Name</label><input id="kName" name="name" required pattern="[A-Z_][A-Z0-9_]*" title="UPPER_SNAKE_CASE, like OPENAI_API_KEY" placeholder="OPENAI_API_KEY" autocomplete="off" spellcheck="false"></div>
  <div class="f"><label for="kScope">Scope</label><input id="kScope" name="scope" value="global" required autocomplete="off" spellcheck="false" aria-describedby="kScopeHint"><span class="hint" id="kScopeHint">global, a project, or project/dev, staging or prod</span></div>
  <div class="f"><label for="kKind">Kind</label><select id="kKind" name="kind" aria-describedby="kKindHint"><option value="static">static</option><option value="mint:cloudflare">mint:cloudflare</option></select><span class="hint" id="kKindHint">static: the value is handed out. mint: a parent that mints short-lived tokens.</span></div>
  <div class="f w2"><label for="kValue">Value</label><input id="kValue" name="value" type="password" required autocomplete="off" aria-describedby="kValueHint"><span class="hint" id="kValueHint">Write-only: it can't be shown again after saving.</span></div>
  <div class="f w2"><label for="kDesc">What it's for</label><input id="kDesc" name="description" autocomplete="off"></div>
  <div class="f"><label for="kExp">Expires</label><input id="kExp" name="expires_at" type="date" aria-describedby="kExpHint"><span class="hint" id="kExpHint">Optional. Turns amber a week before.</span></div>
  <div class="f full"><label for="kConfig">Config <span class="muted">(optional)</span></label><textarea id="kConfig" name="config" spellcheck="false" autocomplete="off" aria-describedby="kConfigHint"></textarea>
    <span class="hint" id="kConfigHint"><span data-for="static">A check that runs before a new value is saved, so a bad value saves nothing: <code>{"check": "openai"}</code> (or anthropic, github, stripe, cloudflare), or your own endpoint: <code>{"check": {"url": "https://…", "header": "authorization", "prefix": "Bearer "}}</code>. Left empty, an existing key keeps its check; <code>{}</code> removes it.</span><span data-for="mint">Left empty, an existing key keeps its config and a new one gets workers:read (Workers, D1, KV, R2, Containers, Queues, Pages, Hyperdrive, Vectorize read and analytics; granted on request) and workers:write (the same, write, plus Workers Tail; minted for tokens whose scopes allow it), on the account in CLOUDFLARE_ACCOUNT_ID. To choose: <code>{"scopes": {"pages:write": ["Pages Write"]}, "start": [], "ttl_minutes": 30}</code>, with Cloudflare permission names or ids.</span></span></div>
  <p class="note hint" id="putNote" aria-live="polite"></p>
  <div class="bar"><button class="primary" id="putSave">Save</button><button type="button" class="quiet" id="putCancel">Cancel</button></div>
</form></details>
<details class="act" id="importBox"><summary>Import a .env</summary>
<form id="importEnv" method="post" class="fields">
  <div class="f full"><label for="iText">.env text</label><textarea id="iText" name="text" required spellcheck="false" autocomplete="off" aria-describedby="iTextHint" placeholder="OPENAI_API_KEY=sk-...&#10;export AWS_REGION=&quot;us-east-1&quot;  # comments are fine"></textarea><span class="hint" id="iTextHint">Each line becomes a static key. You'll see what each line does before anything is saved; minted keys are never overwritten.</span></div>
  <div class="f"><label for="iScope">Into scope</label><input id="iScope" name="scope" value="global" required autocomplete="off" spellcheck="false"></div>
  <div class="bar"><button class="primary">Preview</button></div>
</form>
<div id="importPlan"></div></details>
<details class="act" id="moveBox"><summary>Move a scope</summary>
<form id="moveScope" method="post" class="fields">
  <p class="note hint">Moves every key in a scope and repoints the token pins that name it. Minted children on the moved keys stop working at once, and a repo whose .tumbler names the old scope needs its project line changed.</p>
  <div class="f"><label for="mFrom">From</label><input id="mFrom" name="from" placeholder="huddles-dev" required autocomplete="off" spellcheck="false"></div>
  <div class="f"><label for="mTo">To</label><input id="mTo" name="to" placeholder="huddles/dev" required autocomplete="off" spellcheck="false"></div>
  <div class="bar"><button class="primary">Move</button></div>
</form></details>
</div></section>

<section aria-labelledby="s-grants"><h2 id="s-grants">Grants</h2>
<p class="muted">Short-lived children of minted keys. Each is minted at once within its token's scopes; nothing waits for you here.</p>
<p id="grantsNote" class="notice" hidden></p>
<div class="wrap"><table class="rec"><thead><tr><th>Key</th><th>Caller</th><th>Project</th><th>State</th><th>Scopes</th><th>Expires</th><th><span class="sr">Actions</span></th></tr></thead><tbody id="grants"></tbody></table></div>
</section>

<section aria-labelledby="s-tokens"><h2 id="s-tokens">Tokens</h2>
<div class="wrap"><table class="rec"><thead><tr><th>Name</th><th>Reads</th><th>May mint</th><th>May write</th><th>Operator</th><th>Created</th><th>Expires</th><th><span class="sr">Actions</span></th></tr></thead><tbody id="tokens"></tbody></table></div>
<div class="acts-group">
<details class="act" id="createBox"><summary>Create a token</summary>
<form id="newToken" method="post" class="fields">
  <div class="f"><label for="tName">Name</label><input id="tName" name="name" required pattern="[a-z0-9][a-z0-9._\\-]{0,63}" title="lowercase letters, digits, dot, dash or underscore" placeholder="pillbox-agent" autocomplete="off" spellcheck="false"></div>
  <div class="f"><label for="tHours">Expires in hours</label><input id="tHours" name="hours" type="number" min="1" step="1" aria-describedby="tHoursHint"><span class="hint" id="tHoursHint">Empty: never. Its grants end at the next sweep after it expires.</span></div>
  <div class="f full"><label for="tProjects">Reads</label><input id="tProjects" name="projects" autocomplete="off" spellcheck="false" placeholder="huddles, huddles/prod, */dev" aria-describedby="tProjectsHint">
    <span class="chips" role="group" aria-label="Reads presets"><button type="button" data-pin="*, */dev, */staging, */prod">Everything</button><button type="button" data-pin="*, */dev">All projects, dev</button><button type="button" data-pin="">Global only</button></span>
    <span class="hint" id="tProjectsHint">A project reads its shared keys; project/env one environment (dev, staging, prod); * every project; */env that environment of every project. Empty: global keys only.</span></div>
  <div class="f full"><label for="tScopes">May mint</label><input id="tScopes" name="scopes" autocomplete="off" spellcheck="false" placeholder="workers:write" aria-describedby="tScopesHint">
    <span class="chips" role="group" aria-label="May mint presets"><button type="button" data-scopes="">Read only</button><button type="button" data-scopes="workers:write">Read + deploy</button><button type="button" data-scopes="*">Any scope</button></span>
    <span class="hint" id="tScopesHint">What its minted keys may carry beyond reads, with no one asked; anything else is refused. workers:write covers Workers, D1, KV, R2, Containers, Queues, Pages, Hyperdrive and Vectorize writes; * is every scope, including ones added later. Empty: reads only.</span></div>
  <div class="f full"><label for="tWrites">May write</label><input id="tWrites" name="writes" autocomplete="off" spellcheck="false" placeholder="*/dev" aria-describedby="tWritesHint"><span class="hint" id="tWritesHint">Where tumbler put may save static keys: a project, project/env, * or */env, and global only when named. Empty: nothing.</span></div>
  <div class="f full check"><input id="tOperator" name="operator" type="checkbox" aria-describedby="tOperatorHint"><label for="tOperator">Operator</label><span class="hint" id="tOperatorHint">May add or remove permission groups on the minted keys it reads (tumbler scope), on your word in chat. Never tokens, pins, ceilings, parents or token, member or billing groups.</span></div>
  <div class="bar"><button class="primary" id="tCreate">Create token</button></div>
</form></details>
<div id="once" tabindex="-1" hidden></div>
</div></section>

<section aria-labelledby="s-audit"><h2 id="s-audit">Audit</h2>
<div class="wrap"><table class="log"><thead><tr><th>When</th><th>Who</th><th>Action</th><th>Project</th><th>Names</th></tr></thead><tbody id="audit"></tbody></table></div>
</section>
</main>
<div id="status" hidden><span id="statusText"></span><button type="button" class="quiet" id="statusClose">Dismiss</button></div>
<div id="live" class="sr" aria-live="polite"></div>
<script>
const $ = id => document.getElementById(id);
// The name of a new token still shown once; until it is stored, leaving the page asks first.
let unstored = '';
addEventListener('beforeunload', e => { if (unstored) { e.preventDefault(); e.returnValue = ''; } });
// A form's own properties (form.name) shadow its fields, so fields are always looked up by name.
const F = (form, name) => form.elements.namedItem(name);
const api = (p, o = {}) => fetch('/admin/api/' + p, { ...o, headers: { 'content-type': 'application/json', 'x-tumbler-admin': '1' } })
  .then(async r => { const b = await r.json().catch(() => null);
    if (!r.ok) throw Object.assign(new Error(b?.error || 'request failed (' + r.status + ')'), { canSkip: !!b?.can_skip, status: r.status });
    if (!b) throw Object.assign(new Error('the reply was not JSON (' + r.status + ')'), { status: r.status }); return b; });
// One place every action reports what happened: a line at the bottom of the screen, read out too.
let statusTimer;
const say = (text, error) => { clearTimeout(statusTimer); const live = $('live');
  $('statusText').textContent = text; $('status').className = error ? 'error' : ''; $('status').hidden = false;
  live.setAttribute('aria-live', error ? 'assertive' : 'polite'); live.textContent = text;
  if (!error) statusTimer = setTimeout(() => { $('status').hidden = true; }, 6000); };
$('statusClose').onclick = () => { $('status').hidden = true; };
// A button stays disabled while its request runs, so nothing is sent twice. Once the request is on its way (after any
// confirm, which comes before the first await), the button says what is running and its form is inert until the reply.
const busy = async (b, fn, doing) => { const label = b.textContent, form = b.closest('form');
  b.disabled = true; b.setAttribute('aria-busy', 'true');
  let back = b;
  try { const run = fn(); if (doing) b.textContent = doing;
    if (form) { if (document.activeElement !== document.body) back = document.activeElement; form.inert = true; }
    return await run; }
  catch (err) { say(err.message + (err.changed ? await after(err) : ''), true); }
  finally { b.disabled = false; b.removeAttribute('aria-busy'); if (doing && b.textContent === doing) b.textContent = label;
    if (form) { form.inert = false; if (document.activeElement === document.body && back.isConnected) back.focus(); } } };
// Errors say which action failed, then what the server said. A failed change may have half-happened, so the tables
// reload and the status line says what is stored now, and to try again when the server, not the request, failed.
const fail = (what, change = true) => err => { throw Object.assign(new Error(what + ': ' + err.message), { canSkip: err.canSkip, status: err.status, changed: change }); };
const after = async err => (await refresh() ? '. The tables show what is stored now' : '. Reload to see what is stored')
  + (!err.status || err.status >= 500 ? '; try again.' : '.');
// Loads can overlap when two actions finish close together: only the newest draws or reports a failure,
// and every caller waits for it, so what runs after a refresh sees the page as drawn. True when it drew.
let loads = 0, newest;
const refresh = async () => { const mine = ++loads;
  newest = load(mine).then(() => true, err => { if (mine === loads) say('Could not load the page: ' + err.message + (unstored ? '. Copy the new token before you reload.' : '. Reload to try again.'), true); return false; });
  let seen, drawn; do { seen = newest; drawn = await seen; } while (seen !== newest); return drawn; };
const td = (t, cls) => { const e = document.createElement('td'); e.textContent = t ?? ''; if (cls) e.className = cls; return e; };
const button = (label, fn, cls, aria, doing) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = label;
  if (cls) b.className = cls; if (aria) b.setAttribute('aria-label', aria); b.onclick = () => busy(b, fn, doing); return b; };
const acts = (...bs) => { const c = document.createElement('td'); c.className = 'acts'; c.append(...bs); return c; };
// A date, then how far off it is; neither part breaks mid-value. On a phone a time may go under its date, and
// "expired" before it, so a record's column never clips a stamp.
const nw = t => Object.assign(document.createElement('span'), { className: 'nw', textContent: t });
const when = (main, rel, cls) => { const c = document.createElement('td'), v = document.createElement('span'), a = document.createElement('span'); a.className = 'nw at';
  (main + (rel ? ',' : '')).split(/ (?=\\d{4}-|\\d\\d:)/).forEach((part, i) => a.append(...(i ? [' ', nw(part)] : [nw(part)]))); v.append(a);
  if (rel) { const b = document.createElement('span'); b.className = 'nw'; b.textContent = rel; v.append(' ', b); } c.append(v); if (cls) c.className = cls; return c; };
const day = s => s ? s.slice(0, 10) : '';
const stamp = s => s ? s.slice(0, 16).replace('T', ' ') + ' UTC' : '';
const until = s => { const ms = Date.parse(s) - Date.now(), m = Math.max(1, Math.round(ms / 6e4)), h = Math.round(ms / 36e5);
  return m < 60 ? 'in ' + m + ' min' : h < 48 ? 'in ' + h + ' h' : 'in ' + Math.round(ms / 864e5) + ' days'; };
const soon = s => s && Date.parse(s) < Date.now() + 7 * 864e5;
const past = s => s && Date.parse(s) <= Date.now();
// A key's expiry is a calendar date, good through that day: counted in whole days from today, where the owner is.
const daysLeft = k => k.expires_at ? Math.round((Date.parse(k.expires_at.slice(0, 10)) - Date.parse(new Date().toLocaleDateString('en-CA'))) / 864e5) : Infinity;
const inDays = n => n === 0 ? 'today' : n === 1 ? 'tomorrow' : 'in ' + n + ' days';
// Rows carry their column names, so a phone shows each row as a labelled record.
const fill = (id, rows, empty) => { const body = $(id), heads = [...body.closest('table').querySelectorAll('thead th')].map(th => th.textContent);
  if (!rows.length) { const tr = document.createElement('tr'), c = td(); c.append(...[empty].flat()); tr.className = 'empty'; c.colSpan = heads.length; tr.append(c); body.replaceChildren(tr); return; }
  for (const tr of rows) [...tr.children].forEach((c, i) => { if (heads[i]) c.dataset.label = heads[i]; });
  body.replaceChildren(...rows); };
const code = t => Object.assign(document.createElement('code'), { textContent: t });
// An audit name like KEY:scope+scope may break after the key's colon, a plus or a comma, never inside a scope.
// The colon counts only after a key name, so a bare scope like workers:write stays whole.
// A piece never breaks inside a word (huddles-prod/dev stays whole); a group name of several words may wrap between them.
const words = t => t.split(' ').flatMap((w, i) => i ? [' ', nw(w)] : [nw(w)]);
const names = t => { const c = td('', 'muted'), wbr = () => document.createElement('wbr');
  t.split(', ').forEach((item, i) => { const at = item.indexOf(':'), key = at > 0 && /^[A-Z_][A-Z0-9_]*$/.test(item.slice(0, at));
    if (i) c.append(', ', wbr());
    if (key) c.append(nw(item.slice(0, at + 1)), wbr());
    (key ? item.slice(at + 1) : item).split('+').forEach((scope, j) => { if (j) c.append('+', wbr()); c.append(...words(scope)); }); });
  return c; };
const row = (cells, cls) => { const tr = document.createElement('tr'); if (cls) tr.className = cls; tr.append(...cells); return tr; };
// A pin in words: each project (or all of them) with what it reads, shared keys and environments.
const reach = t => { if (!t.projects) return 'global only'; const by = new Map();
  for (const p of t.projects) { const [proj, env] = p.split('/'), k = proj === '*' ? 'all projects' : proj; by.set(k, [...(by.get(k) ?? []), env ?? 'shared']); }
  return [...by].map(([k, v]) => k + ' (' + v.join(', ') + ')').join(', '); };
const cfgOf = k => { try { return { c: JSON.parse(k.config || '{}') }; } catch (err) { return { error: err.message }; } };
// What a save tests the value with first: a mint key's provider, or the check its static config names.
const checkOf = (kind, c) => kind !== 'static' ? kind.slice(5) : !c?.check ? '' : typeof c.check === 'string' ? c.check : 'your endpoint';
const checkText = k => { const { c, error } = cfgOf(k); if (error) return 'config unreadable (' + error + ')';
  if (k.kind !== 'static') return k.checked ? 'parent passed' : 'parent not checked';
  if (!c.check) return 'none';
  return (typeof c.check === 'string' ? c.check : 'custom') + (k.checked ? ', passed' : ', saved unchecked'); };
let KEYS = [];

async function load(mine) {
  const [{ keys }, { tokens }, { audit }, g] = await Promise.all([api('keys'), api('tokens'), api('audit'), api('grants').catch(err => ({ grants: [], failed: err.message }))]);
  if (mine !== loads) return; // a newer load is drawing the page
  KEYS = keys; note();
  const due = keys.filter(k => daysLeft(k) <= 7).length;
  $('nKeys').replaceChildren(String(keys.length), ...(due ? [', ', Object.assign(document.createElement('span'), { className: 'warn', textContent: due + ' need you' })] : []));
  fill('keys', keys.map(k => { const what = k.scope + '/' + k.name, check = checkText(k);
    const left = daysLeft(k), exp = !k.expires_at ? when('no date', '', 'muted') : left < 0 ? when('expired ' + day(k.expires_at), '', 'warn') : when(day(k.expires_at), left <= 7 ? inDays(left) : '', left <= 7 ? 'warn' : '');
    return row([td(k.name), td(k.scope), td(k.kind), td(check, check === 'none' ? 'muted' : ''), td(k.description || 'none', 'muted'), when(day(k.rotated_at)), exp,
      acts(button('Set value', () => rotate(k), 'quiet', 'Set a new value for ' + what), button('Delete', () => deleteKey(k), 'del', 'Delete ' + what, 'Deleting…'))]); }),
    ['No keys yet. Add one below, paste a .env, or run ', code('tumbler put NAME'), ' from a session.']);

  const live = g.grants.filter(x => x.state === 'active' || x.state === 'pending');
  $('nGrants').textContent = g.failed ? '' : live.length + ' active';
  const note2 = $('grantsNote');
  note2.textContent = g.failed ? 'Could not load grants (' + g.failed + '). Keys, tokens and audit below are current.'
    : g.revoke_pending ? g.revoke_pending + ' revoked token(s) could not be deleted at the provider yet; retrying every five minutes until they expire.' : '';
  note2.hidden = !note2.textContent;
  fill('grants', g.grants.map(x => { const on = x.state === 'active' || x.state === 'pending';
    return row([td(x.name), td(x.caller), td(x.project ?? 'global'), td(x.state), td(x.scopes.join(', ')), when(stamp(x.expires_at)),
      on ? acts(button('Revoke', () => revokeGrant(x), 'del', 'Revoke ' + x.name + ' for ' + x.caller, 'Revoking…')) : td('')], on ? '' : 'off'); }),
    g.failed ? 'Grants could not be loaded.' : 'No grants. One appears when a token reads a minted key, and ends on its own when it expires.');

  $('nTokens').textContent = tokens.filter(t => !t.revoked_at && !past(t.expires_at)).length + ' live';
  fill('tokens', tokens.map(t => { const gone = !!t.revoked_at, done = gone || past(t.expires_at);
    const exp = !t.expires_at ? when('never', '', 'muted') : past(t.expires_at) ? when('expired ' + stamp(t.expires_at)) : when(stamp(t.expires_at), soon(t.expires_at) ? until(t.expires_at) : '', soon(t.expires_at) ? 'warn' : '');
    const tr = row([td(t.name), td(reach(t)), td(t.scopes ? t.scopes.join(', ') : 'reads only'), td(t.writes ? t.writes.join(', ') : 'nothing'), td(t.operator ? 'yes' : 'no'), when(day(t.created_at)), exp], done ? 'off' : '');
    const ended = td('revoked ', 'ended'); ended.append(nw(day(t.revoked_at)));
    tr.append(gone ? ended : acts(button('Edit', () => editToken(t, tr), 'quiet', 'Edit ' + t.name), button('Revoke', () => revokeToken(t), 'del', 'Revoke token ' + t.name, 'Revoking…')));
    return tr; }),
    'No tokens yet. Create one below, then add it as a network secret on the environment that should read keys.');

  fill('audit', audit.map(a => row([when(stamp(a.at)), td(a.actor), td(a.action), td(a.project ?? ''), names(String(a.names ?? '').split(',').join(', '))])), 'Nothing has happened yet.');
}

// --- keys ---
const putKey = $('putKey'), addKey = $('addKey');
const syncKind = () => { const mint = F(putKey, 'kind').value !== 'static';
  for (const h of putKey.querySelectorAll('[data-for]')) h.hidden = h.dataset.for !== (mint ? 'mint' : 'static');
  F(putKey, 'config').placeholder = mint ? '{"scopes": {"pages:write": ["Pages Write"]}}' : '{"check": "openai"}';
  $('kValueHint').textContent = mint ? 'The parent token. It never leaves tumbler and cannot be shown again.' : 'Write-only: it cannot be shown again after saving.';
  if (mint && !F(putKey, 'name').value) F(putKey, 'name').value = 'CLOUDFLARE_API_TOKEN'; };
// Before saving, say whether this creates a key or replaces a value, and what else changes.
function note() { const n = F(putKey, 'name').value, s = F(putKey, 'scope').value, out = $('putNote');
  const k = KEYS.find(x => x.name === n && x.scope === s), kind = F(putKey, 'kind').value;
  if (!n || !s) { out.textContent = ''; return; }
  if (!k) { out.textContent = 'Creates ' + s + '/' + n + '.'; out.className = 'note hint'; return; }
  let t = 'Replaces the value of ' + s + '/' + n + '; the old value cannot be recovered.';
  if (k.kind !== 'static') t += ' Children minted from the old parent stop working.';
  if (k.kind !== kind) t += ' It is ' + k.kind + ': set Kind to match.';
  const exp = F(putKey, 'expires_at').value, left = daysLeft(k);
  if (k.expires_at && !exp) t += left < 0 ? ' It expired ' + day(k.expires_at) + ': set a new date, or save with none.' : ' Saving with no date clears its expiry (' + day(k.expires_at) + ').';
  else if (k.expires_at && exp === day(k.expires_at)) t += ' It keeps its expiry, ' + day(k.expires_at) + (left <= 7 ? ' (' + inDays(left) + ')' : '') + ': change the date if the new value lasts longer.';
  const check = k.kind === 'static' && !F(putKey, 'config').value.trim() && checkOf(k.kind, cfgOf(k).c);
  if (check) t += ' It keeps its check (' + check + '): the new value is tested before it is saved.';
  out.textContent = t; out.className = 'note warn'; }
const resetKey = () => { putKey.reset(); F(putKey, 'name').readOnly = F(putKey, 'scope').readOnly = false; F(putKey, 'kind').disabled = false;
  $('putSave').textContent = 'Save'; syncKind(); note(); };
// Set value on a row: the key's name, scope and kind are fixed, and its description and expiry carry over.
function rotate(k) { resetKey(); addKey.open = true;
  F(putKey, 'name').value = k.name; F(putKey, 'scope').value = k.scope; F(putKey, 'kind').value = k.kind;
  F(putKey, 'description').value = k.description || ''; F(putKey, 'expires_at').value = daysLeft(k) < 0 ? '' : day(k.expires_at);
  F(putKey, 'name').readOnly = F(putKey, 'scope').readOnly = true; F(putKey, 'kind').disabled = true;
  $('putSave').textContent = 'Save new value'; syncKind(); F(putKey, 'config').placeholder = ''; note();
  addKey.scrollIntoView({ block: 'start', behavior: 'smooth' }); F(putKey, 'value').focus({ preventScroll: true }); }
F(putKey, 'kind').onchange = () => { syncKind(); note(); };
// Closing the form any way ends a Set value, so the next open adds a key instead of replacing this one.
addKey.addEventListener('toggle', () => { if (!addKey.open && F(putKey, 'name').readOnly) resetKey(); });
for (const n of ['name', 'scope', 'expires_at', 'config']) F(putKey, n).addEventListener('input', note);
$('putCancel').onclick = () => { resetKey(); addKey.open = false; addKey.querySelector('summary').focus(); };
putKey.onsubmit = e => { e.preventDefault();
  const name = F(putKey, 'name').value, scope = F(putKey, 'scope').value, kind = F(putKey, 'kind').value, raw = F(putKey, 'config').value.trim(), what = scope + '/' + name;
  let config;
  if (raw) { try { config = JSON.parse(raw); } catch (err) { say('Config is not valid JSON (' + err.message + '); nothing was saved.', true); F(putKey, 'config').focus(); return; } }
  const prev = KEYS.find(x => x.name === name && x.scope === scope), existed = !!prev, check = checkOf(kind, config ?? (prev && cfgOf(prev).c));
  busy($('putSave'), async () => {
  // Read once: the form may change (another row's Set value) while the check runs, and a retry sends this.
  const sent = { value: F(putKey, 'value').value, kind, config, description: F(putKey, 'description').value, expires_at: F(putKey, 'expires_at').value || null };
  const put = skip_check => api('keys/' + encodeURIComponent(scope) + '/' + encodeURIComponent(name), { method: 'PUT', body: JSON.stringify({ ...sent, skip_check }) });
  try { await put(false); } catch (err) {
    // The check couldn't run (the service is down): offer to save unchecked, e.g. to replace a leaked key.
    if (!err.canSkip) { if (err.message.startsWith(name + ':')) throw err; fail('Could not save ' + what)(err); }
    if (!confirm(err.message + '\\n\\nSave it unchecked anyway? Commands running with --watch will not get it pushed.')) { say(existed ? 'Nothing was saved; ' + what + ' keeps its old value.' : 'Nothing was saved; ' + what + ' was not created.'); return; }
    await put(true).catch(fail('Could not save ' + what)); }
  resetKey(); addKey.open = false; addKey.querySelector('summary').focus();
  say((existed ? 'Saved a new value for ' : 'Created ') + what + '.'); await refresh(); }, check ? 'Checking with ' + check + '…' : 'Saving…'); };
async function deleteKey(k) { const what = k.scope + '/' + k.name;
  if (!confirm(k.kind === 'static'
    ? 'Delete ' + what + '?\\n\\nThe value is gone for good: tumbler never shows a saved value, so there is no copy here. Sessions that read it stop getting it on their next run.'
    : 'Delete ' + what + '?\\n\\nIts parent credential is gone for good, and every child it minted stops working now. Sessions can mint again only after a new parent is saved.')) return;
  await api('keys/' + encodeURIComponent(k.scope) + '/' + encodeURIComponent(k.name), { method: 'DELETE' }).catch(fail('Could not delete ' + what));
  say('Deleted ' + what + '.'); await refresh(); }

// Paste a .env: preview what each line does, then save. The text goes in a POST body only.
const importEnv = $('importEnv'), importPlan = $('importPlan');
const showPlan = (r, onSave) => { const table = document.createElement('table'), head = document.createElement('thead');
  head.append(row(['Line', 'Key', 'Action', 'Note'].map(h => { const th = document.createElement('th'); th.textContent = h; return th; })));
  const body = document.createElement('tbody'); table.className = 'rec'; table.append(head, body);
  const rows = [...r.errors.map(e => [e.line, '', 'error', e.error]), ...r.keys.map(k => [k.line, k.name, k.action, k.reason || (k.checked ? 'tested before saving' : '')])].sort((a, b) => a[0] - b[0]);
  body.replaceChildren(...rows.map(([line, name, action, why]) => { const tr = row([td(String(line), 'muted'), td(name, 'name'), td(action, ['error', 'failed', 'overwrite'].includes(action) ? 'warn' : action === 'skip' ? 'muted' : ''), td(why, 'muted')]);
    [...tr.children].forEach((c, i) => { c.dataset.label = ['Line', 'Key', 'Action', 'Note'][i]; }); return tr; }));
  const parts = [table], n = r.keys.filter(k => k.action === 'create' || k.action === 'overwrite').length;
  if (r.saved) parts.push(Object.assign(document.createElement('p'), { textContent: 'Saved ' + r.saved.length + ' key(s) to ' + r.scope + '.' }));
  else if (r.errors.length) parts.push(Object.assign(document.createElement('p'), { className: 'warn', textContent: 'Fix the lines marked error, then preview again.' }));
  else if (n) { const b = button('Save ' + n + ' key(s) to ' + r.scope, onSave, 'primary', '', 'Saving…'); const p = document.createElement('p'); p.append(b); parts.push(p); }
  importPlan.replaceChildren(...parts); };
const importCall = (sent, save) => api('import', { method: 'POST', body: JSON.stringify({ ...sent, save }) }).catch(fail(save ? 'Could not save the .env' : 'Could not preview the .env', save));
F(importEnv, 'text').oninput = F(importEnv, 'scope').oninput = () => importPlan.replaceChildren();
importEnv.onsubmit = e => { e.preventDefault(); const sent = { scope: F(importEnv, 'scope').value, text: F(importEnv, 'text').value };
  busy(importEnv.querySelector('button'), async () => { const plan = await importCall(sent, false);
  showPlan(plan, async () => {
    const r = await importCall(sent, true); showPlan(r);
    if (r.saved.length === r.keys.filter(k => k.action !== 'skip').length && F(importEnv, 'text').value === sent.text) F(importEnv, 'text').value = '';
    const failed = r.keys.filter(k => k.action === 'failed').length;
    say('Saved ' + r.saved.length + ' key(s) to ' + r.scope + (failed ? '; ' + failed + ' failed their check and were not saved (marked failed above).' : '.'), failed > 0); await refresh(); }); }, 'Previewing…'); };
$('moveScope').onsubmit = e => { e.preventDefault(); const f = e.target, from = F(f, 'from').value, to = F(f, 'to').value;
  if (!confirm('Move every key in ' + from + ' to ' + to + '?\\n\\nMinted children on the moved keys stop working now, and tokens pinned to ' + from + ' are repinned to ' + to + '. A repo whose .tumbler names ' + from + ' needs its project line changed.')) return;
  busy(f.querySelector('button'), async () => { const r = await api('scopes/move', { method: 'POST', body: JSON.stringify({ from, to }) }).catch(fail('Could not move ' + from));
    say('Moved ' + r.moved.length + ' key(s) from ' + from + ' to ' + to + '; repinned ' + (r.repinned.join(', ') || 'no tokens') + '.'); f.reset(); await refresh(); }, 'Moving…'); };

// --- grants and tokens ---
async function revokeGrant(g) {
  if (!confirm('Revoke ' + g.name + ' for ' + g.caller + '? This child stops working now; the next run by its caller mints a new one within the scopes of that token. To cut the caller off, revoke its token or narrow its scopes.')) return;
  await api('grants/' + g.id, { method: 'DELETE' }).catch(fail('Could not revoke ' + g.name + ' for ' + g.caller)); say('Revoked ' + g.name + ' for ' + g.caller + '.'); await refresh(); }
async function revokeToken(t) {
  if (!confirm('Revoke ' + t.name + '?\\n\\nEvery session using it loses access now, and the grants it holds end. A revoked token cannot be restored: to give access back, create a new token and replace the network secret that carries it.')) return;
  await api('tokens/' + encodeURIComponent(t.name), { method: 'DELETE' }).catch(fail('Could not revoke ' + t.name)); say('Revoked ' + t.name + '.'); await refresh(); }
const list = v => String(v).split(',').map(s => s.trim()).filter(Boolean);
const same = (a, b) => (a ?? []).join(',') === (b ?? []).join(',');
let edits = 0;
// Edit a token in place, so reaching one more project never means a new token. Only what changed is sent;
// narrowing its scopes or pin ends the children it holds beyond them.
function editToken(t, tr) {
  const open = tr.nextElementSibling; if (open && open.classList.contains('editor')) { open.remove(); return; }
  const id = 'ed' + (++edits), ed = document.createElement('tr'), c = document.createElement('td'), f = document.createElement('form');
  ed.className = 'editor'; c.colSpan = 8; f.method = 'post'; f.className = 'fields';
  f.innerHTML = '<div class="f full"><label for="' + id + 'p">Reads</label><input id="' + id + 'p" name="projects" autocomplete="off" spellcheck="false"><span class="hint">Comma-separated: a project, project/env, * or */env. Empty: global keys only.</span></div>'
    + '<div class="f"><label for="' + id + 's">May mint</label><input id="' + id + 's" name="scopes" autocomplete="off" spellcheck="false"><span class="hint">workers:write, or * for any. Empty: reads only.</span></div>'
    + '<div class="f"><label for="' + id + 'w">May write</label><input id="' + id + 'w" name="writes" autocomplete="off" spellcheck="false"><span class="hint">A project, project/env, * or */env; global only when named. Empty: nothing.</span></div>'
    + '<div class="f check"><input id="' + id + 'o" name="operator" type="checkbox"><label for="' + id + 'o">Operator</label></div>'
    + '<div class="bar"><button class="primary">Save changes</button><button type="button" class="quiet">Cancel</button></div>';
  F(f, 'projects').value = (t.projects ?? []).join(', '); F(f, 'scopes').value = (t.scopes ?? []).join(', '); F(f, 'writes').value = (t.writes ?? []).join(', '); F(f, 'operator').checked = !!t.operator;
  const [save, cancel] = f.querySelectorAll('.bar button');
  cancel.onclick = () => { ed.remove(); tr.querySelector('.acts button').focus(); };
  f.onsubmit = e => { e.preventDefault(); busy(save, async () => {
    const body = {}, projects = list(F(f, 'projects').value), scopes = list(F(f, 'scopes').value), writes = list(F(f, 'writes').value), operator = F(f, 'operator').checked;
    if (!same(projects, t.projects)) body.projects = projects;
    if (!same(scopes, t.scopes)) body.scopes = scopes;
    if (!same(writes, t.writes)) body.writes = writes;
    if (operator !== !!t.operator) body.operator = operator;
    if (!Object.keys(body).length) { say('Nothing changed for ' + t.name + '.'); ed.remove(); return; }
    if ('operator' in body && !confirm((operator ? 'Let ' + t.name + ' add and remove' : 'Stop ' + t.name + ' changing') + ' permission groups on the minted keys it reads (tumbler scope)?')) { say('Nothing was saved for ' + t.name + '.'); return; }
    await api('tokens/' + encodeURIComponent(t.name), { method: 'PATCH', body: JSON.stringify(body) }).catch(fail('Could not update ' + t.name));
    say('Updated ' + t.name + ': ' + Object.keys(body).map(k => ({ projects: 'reads', scopes: 'may mint', writes: 'may write', operator: 'operator' })[k]).join(', ') + '.'); await refresh(); }, 'Saving…'); };
  c.append(f); ed.append(c); tr.after(ed); F(f, 'projects').focus(); }

// Presets fill the field, which stays editable; the preset matching the field shows as pressed.
const newToken = $('newToken');
const presses = () => { for (const b of newToken.querySelectorAll('[data-pin]')) b.setAttribute('aria-pressed', String(F(newToken, 'projects').value === b.dataset.pin));
  for (const b of newToken.querySelectorAll('[data-scopes]')) b.setAttribute('aria-pressed', String(F(newToken, 'scopes').value === b.dataset.scopes)); };
for (const b of newToken.querySelectorAll('[data-pin]')) b.onclick = () => { F(newToken, 'projects').value = b.dataset.pin; presses(); };
for (const b of newToken.querySelectorAll('[data-scopes]')) b.onclick = () => { F(newToken, 'scopes').value = b.dataset.scopes; presses(); };
F(newToken, 'projects').oninput = F(newToken, 'scopes').oninput = presses;
newToken.onsubmit = e => { e.preventDefault();
  if (unstored) { say('Copy the token for ' + unstored + ' and press "I have stored it" first; it is shown only once.', true); $('once').focus(); return; }
  busy($('tCreate'), async () => {
  const name = F(newToken, 'name').value, hours = Number(F(newToken, 'hours').value), expires_at = hours > 0 ? new Date(Date.now() + hours * 3600_000).toISOString() : null;
  const r = await api('tokens', { method: 'POST', body: JSON.stringify({ name, projects: list(F(newToken, 'projects').value), scopes: list(F(newToken, 'scopes').value),
    writes: list(F(newToken, 'writes').value), operator: F(newToken, 'operator').checked, expires_at }) }).catch(fail('Could not create ' + name));
  newToken.reset(); presses(); $('createBox').open = false;
  // The box shows before the reload, so a failed reload can't hide the token; it scrolls once the table has grown.
  showOnce(name, r.token); await refresh(); if (unstored === name) $('once').scrollIntoView({ block: 'end', behavior: 'smooth' }); }, 'Creating…'); };
// The new token is shown once, right where it was created, and stays until the owner says it's stored.
function showOnce(name, token) { unstored = name; const once = $('once'), p = document.createElement('p'), field = document.createElement('textarea'), bar = document.createElement('div');
  const strong = document.createElement('strong'); strong.textContent = 'Copy the token for ' + name + ' now.';
  p.append(strong, ' It will not be shown again. Add it as a network secret on the environment: header Authorization, prefix Bearer.');
  field.readOnly = true; field.rows = 1; field.spellcheck = false; field.autocomplete = 'off'; field.value = token; field.setAttribute('aria-label', 'Token for ' + name); field.onfocus = () => field.select();
  const copy = (label, text) => button(label, () => navigator.clipboard.writeText(text).then(() => say('Copied the token for ' + name + '.'), () => say('Copy failed; select the token and copy it by hand.', true)), label === 'Copy' ? 'primary' : '');
  const done = button('I have stored it', () => { unstored = ''; once.replaceChildren(); once.hidden = true; $('createBox').querySelector('summary').focus(); }, 'quiet');
  bar.className = 'bar'; bar.append(copy('Copy', token), copy('Copy as "Bearer …"', 'Bearer ' + token), done);
  once.setAttribute('role', 'region'); once.setAttribute('aria-label', 'New token'); once.replaceChildren(p, field, bar); once.hidden = false;
  fitToken(); once.focus({ preventScroll: true }); say('Created ' + name + '. Copy it now; it will not be shown again.'); }
// Every line of the token shows: field-sizing does it where supported, otherwise the height follows the text.
const fitToken = () => { const f = $('once').querySelector('textarea'); if (!f || CSS.supports('field-sizing', 'content')) return;
  f.style.height = 'auto'; f.style.height = f.scrollHeight + 2 + 'px'; };
addEventListener('resize', fitToken);

syncKind(); presses(); refresh();
</script></body></html>`;

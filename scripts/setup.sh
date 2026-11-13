#!/bin/bash
# Installs the tumbler CLI from the broker, shims the tools that need keys, and tells agents to use it.
# The broker serves this script with its own URL filled in, so a Claude cloud environment's whole
# Setup script can be one line:
#   curl -fsSL https://tumbler.example.com/setup | bash
# It reads no secrets: the setup script runs before the agent proxy, and anything it fetched would be
# baked into the cached image. The environment also needs a network secret on the broker's host:
# Authorization: Bearer <the project's tumbler token>.
# A failure here must never block a session from starting, so every failure warns and exits 0.
set -uo pipefail
skip() { echo "tumbler: $1; skipping" >&2; exit 0; }
[ -n "${TUMBLER_URL:-}" ] || skip "TUMBLER_URL is not set"
case "$TUMBLER_URL" in *://*) ;; *) TUMBLER_URL="https://$TUMBLER_URL" ;; esac

curl -fsSL "$TUMBLER_URL/cli" -o /usr/local/bin/tumbler || skip "could not download the CLI from $TUMBLER_URL"
chmod +x /usr/local/bin/tumbler

# wrangler isn't in the cloud image; install it so a bare `wrangler` has something to run.
command -v wrangler >/dev/null || npm install -g wrangler >/dev/null 2>&1 || echo "tumbler: could not install wrangler" >&2
# Tools that always run with keys from tumbler, shimmed only when installed: a shim with no real
# tool behind it fails with "no <tool> on PATH outside the shims". Add or remove to taste.
TOOLS=""
for t in aws wrangler tailscale; do command -v "$t" >/dev/null && TOOLS="$TOOLS $t"; done
if [ -n "$TOOLS" ]; then
  tumbler shim $TOOLS || echo "tumbler: shims not installed" >&2
  # Agent shells don't read a profile, so link the shims into ~/.local/bin, which is on their PATH.
  mkdir -p "$HOME/.local/bin"
  for t in $TOOLS; do ln -sf "$HOME/.local/share/tumbler/bin/$t" "$HOME/.local/bin/$t"; done
fi
cat > /etc/profile.d/tumbler.sh <<SH
export TUMBLER_URL="\${TUMBLER_URL:-$TUMBLER_URL}"
export PATH="\$HOME/.local/share/tumbler/bin:\$PATH"
SH
grep -q tumbler "$HOME/.bashrc" 2>/dev/null || echo '. /etc/profile.d/tumbler.sh' >> "$HOME/.bashrc"

mkdir -p "$HOME/.claude"

# Opt-in Stop hook: with SESSION_LOG_HOOK=owner/repo/path/to/script.py, run that script after every
# turn as `python3 script.py hook`. The script stays wherever it lives (a private repo is fine): the hook
# fetches it through `tumbler run` with SESSION_LOG_HOOK_KEY (default GH_TOKEN) before each run, since
# this setup reads no secrets and the environment keeps its result across sessions. Unset, nothing here
# touches settings.json.
if [ -n "${SESSION_LOG_HOOK:-}" ]; then
  SESSION_LOG_HOOK="$SESSION_LOG_HOOK" SESSION_LOG_HOOK_KEY="${SESSION_LOG_HOOK_KEY:-GH_TOKEN}" python3 - <<'PY' \
    || echo "tumbler: session log hook not wired into settings.json" >&2
import json, os, pathlib, re, shlex
src, key = os.environ["SESSION_LOG_HOOK"], os.environ["SESSION_LOG_HOOK_KEY"]
m = re.fullmatch(r"([\w.-]+)/([\w.-]+)/([\w./-]+\.py)", src)
if not m or not re.fullmatch(r"[A-Z_][A-Z0-9_]*", key):
    raise SystemExit(f"tumbler: SESSION_LOG_HOOK must be owner/repo/path.py and SESSION_LOG_HOOK_KEY a key name; got {src!r}, {key!r}")
api = f"https://api.github.com/repos/{m[1]}/{m[2]}/contents/{m[3]}"
home = pathlib.Path.home()
hook = home / ".claude" / "hooks" / "session_log_sync.py"
hook.parent.mkdir(parents=True, exist_ok=True)
# The token reaches curl through its stdin config, never argv.
fetch = (f'printf \'header = "authorization: Bearer %s"\\n\' "${key}" | curl -fsS --max-time 10 -K - '
         f'-H "accept: application/vnd.github.raw" {shlex.quote(api)}')
# Quoted, so a home with a space stays one word. tumbler reads /dev/null, leaving the hook's JSON on stdin
# for the script; an empty or failed fetch keeps the copy from the last turn.
cmd = (f'h={shlex.quote(str(hook))}; t=$(mktemp "$h.XXXXXX") && tumbler run -k {key} -- sh -c {shlex.quote(fetch)} '
       f'</dev/null >"$t" 2>/dev/null && [ -s "$t" ] && mv "$t" "$h"; rm -f "$t"; [ -f "$h" ] && python3 "$h" hook')
p = home / ".claude" / "settings.json"
s = json.loads(p.read_text()) if p.exists() else {}
stop = s.setdefault("hooks", {}).setdefault("Stop", [])
# Once only: a rerun replaces its own command. Other commands in the same entry stay; an entry left empty goes.
for e in stop:
    if isinstance(e.get("hooks"), list):
        e["hooks"] = [c for c in e["hooks"] if "session_log_sync.py" not in str(c.get("command", ""))]
stop[:] = [e for e in stop if e.get("hooks") != []]
stop.append({"hooks": [{"type": "command", "command": cmd}]})
p.write_text(json.dumps(s, indent=2) + "\n")
PY
fi

grep -q "(tumbler)" "$HOME/.claude/CLAUDE.md" 2>/dev/null || cat >> "$HOME/.claude/CLAUDE.md" <<'MD'

## Keys and env vars (tumbler)
API keys come from tumbler, not from env vars or .env files. wrangler (and aws and tailscale, when
installed) already run through it. For anything else that needs a key, run it as `tumbler run -- <cmd>`. `tumbler keys`
lists the names you can use; never print a value. In a repo without a .tumbler file, the first
run writes one (`tumbler auto`) and keeps it out of git; no need to commit it. If a key looks stale, run `tumbler reload`.
To store a key, pipe it in (`<cmd that prints it> | tumbler put NAME -p <project>` or `--global`), never as an
argument; `tumbler ssh-keygen NAME` makes an SSH key and prints its public half.
MD
exit 0

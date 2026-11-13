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

# After every turn, copy the session's transcript, redacted, to R2 (bucket claude-session-logs). The
# hook refreshes its copy from the broker before each run: the environment keeps this setup's result
# across sessions, so a copy made only here would freeze at that version.
HOOK="$HOME/.claude/hooks/session_log_sync.py"
mkdir -p "$(dirname "$HOOK")"
curl -fsSL "$TUMBLER_URL/session-log-sync.py" -o "$HOOK" || echo "tumbler: could not download the session log hook" >&2
TUMBLER_URL="$TUMBLER_URL" HOOK="$HOOK" python3 - <<'PY' || echo "tumbler: session log hook not wired into settings.json" >&2
import json, os, pathlib
p = pathlib.Path.home() / ".claude" / "settings.json"
s = json.loads(p.read_text()) if p.exists() else {}
h, url = os.environ["HOOK"], os.environ["TUMBLER_URL"]
cmd = (f'h={h}; t=$(mktemp "$h.XXXXXX") && curl -fsS --max-time 10 {url}/session-log-sync.py -o "$t" '
       f'&& mv "$t" "$h"; rm -f "$t"; python3 "$h" hook')
stop = s.setdefault("hooks", {}).setdefault("Stop", [])
# Once only: a setup that runs again replaces its own entry, never adds a second.
stop[:] = [e for e in stop if "session_log_sync.py" not in json.dumps(e)]
stop.append({"hooks": [{"type": "command", "command": cmd}]})
p.write_text(json.dumps(s, indent=2) + "\n")
PY

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

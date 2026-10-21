#!/bin/bash
# Paste into a Claude cloud environment's Setup script. It installs the tumbler CLI from the broker,
# shims the tools that need keys, and tells agents to use it. It reads no secrets: the setup script
# runs before the agent proxy, and anything it fetched would be baked into the cached image.
#
# The environment also needs:
#   - Environment variable TUMBLER_URL=https://tumbler.example.com  (not a secret; a bare host means https)
#   - Network secret on that host: Authorization: Bearer <the project's tumbler token>
set -euo pipefail
# Environment variables may not reach the setup script: set TUMBLER_URL here if they don't.
# A failure here must never block the session from starting, so it warns and exits 0.
if [ -z "${TUMBLER_URL:-}" ]; then echo "tumbler: TUMBLER_URL is not set; skipping" >&2; exit 0; fi
case "$TUMBLER_URL" in *://*) ;; *) TUMBLER_URL="https://$TUMBLER_URL" ;; esac

curl -fsSL "$TUMBLER_URL/cli" -o /usr/local/bin/tumbler || { echo "tumbler: could not download the CLI from $TUMBLER_URL; skipping" >&2; exit 0; }
chmod +x /usr/local/bin/tumbler

# Tools that always run with keys from tumbler. Add or remove to taste.
tumbler shim aws wrangler tailscale
cat > /etc/profile.d/tumbler.sh <<'SH'
export PATH="$HOME/.local/share/tumbler/bin:$PATH"
SH
grep -q tumbler "$HOME/.bashrc" 2>/dev/null || echo '. /etc/profile.d/tumbler.sh' >> "$HOME/.bashrc"

mkdir -p "$HOME/.claude"
cat >> "$HOME/.claude/CLAUDE.md" <<'MD'

## Keys and env vars (tumbler)
API keys come from tumbler, not from env vars or .env files. aws, wrangler and tailscale already
run through it. For anything else that needs a key, run it as `tumbler run -- <cmd>`. `tumbler keys`
lists the names you can use; never print a value. In a repo without a .tumbler file, the first
run writes one (`tumbler auto`); review it and commit it with your change. If a key looks stale, run `tumbler reload`.
MD

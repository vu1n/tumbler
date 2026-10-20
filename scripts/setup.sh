#!/bin/bash
# Paste into a Claude cloud environment's Setup script. It installs the tumbler CLI from the broker,
# shims the tools that need keys, and tells agents to use it. It reads no secrets: the setup script
# runs before the agent proxy, and anything it fetched would be baked into the cached image.
#
# The environment also needs:
#   - Environment variable TUMBLER_URL=https://tumbler.<you>.workers.dev  (not a secret)
#   - Network secret on that host: Authorization: Bearer <the project's tumbler token>
set -euo pipefail
: "${TUMBLER_URL:?set TUMBLER_URL on the environment}"

curl -fsSL "$TUMBLER_URL/cli" -o /usr/local/bin/tumbler
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
lists the names you can use; never print a value. If a key looks stale, run `tumbler reload`.
MD

#!/usr/bin/env bash
# Sansheng + Pi Config Restore Script
# Bundle: migration/setup-2026-10-01 (commit by Main on 2026-10-01)
# Usage:  ./restore.sh [--pi-home DIR] [--project-dir DIR]
#
# What it does:
#   1. Extracts sansheng-snapshot.tar.gz into ./sansheng/
#   2. Copies pi-config-essentials/* into $PI_HOME (default ~/.pi/agent)
#   3. Runs `npm ci` in sansheng/ to rebuild node_modules
#   4. Reminds you to re-fill auth.json with your API keys
#
# Prerequisites:
#   - Node.js >= 22  (check: node --version)
#   - npm >= 10      (check: npm --version)
#   - git >= 2.30    (check: git --version)
#   - ~700MB free disk for node_modules + pi runtime

set -euo pipefail

PI_HOME="${PI_HOME:-$HOME/.pi/agent}"
PROJECT_DIR="${PROJECT_DIR:-$PWD/sansheng}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ---- preflight --------------------------------------------------------------
echo "==> Preflight"
for cmd in node npm git tar; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "ERROR: missing required command: $cmd" >&2
    exit 1
  fi
done

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "ERROR: Node >= 22 required (found $(node --version))" >&2
  exit 1
fi
echo "    node=$(node --version)  npm=$(npm --version)  git=$(git --version | awk '{print $3}')"

# ---- extract sansheng snapshot --------------------------------------------
echo "==> Extracting sansheng snapshot -> $PROJECT_DIR"
mkdir -p "$(dirname "$PROJECT_DIR")"
tar -xzf "$SCRIPT_DIR/sansheng-snapshot.tar.gz" -C "$(dirname "$PROJECT_DIR")"

# ---- restore pi config ------------------------------------------------------
echo "==> Restoring pi config -> $PI_HOME"
mkdir -p "$PI_HOME"
for item in memory extensions config settings.json models-store.json; do
  if [ -e "$SCRIPT_DIR/pi-config-essentials/$item" ]; then
    # Use rsync if available for safer copy; fall back to cp -r
    if command -v rsync >/dev/null 2>&1; then
      rsync -a "$SCRIPT_DIR/pi-config-essentials/$item" "$PI_HOME/"
    else
      cp -r "$SCRIPT_DIR/pi-config-essentials/$item" "$PI_HOME/"
    fi
    echo "    copied: $item"
  fi
done

# ---- auth.json placeholder --------------------------------------------------
AUTH_FILE="$PI_HOME/auth.json"
if [ ! -f "$AUTH_FILE" ]; then
  cat > "$AUTH_FILE" <<'AUTH_PLACEHOLDER'
{
  "_comment": "FILL IN YOUR API KEYS BEFORE STARTING PI. Format: {\"provider\": {\"apiKey\": \"...\"}}",
  "openai": { "apiKey": "sk-REPLACE-ME" },
  "anthropic": { "apiKey": "sk-ant-REPLACE-ME" }
}
AUTH_PLACEHOLDER
  chmod 600 "$AUTH_FILE"
  echo "==> Created placeholder $AUTH_FILE — EDIT IT before starting pi"
else
  echo "==> $AUTH_FILE already exists, leaving untouched"
fi

# ---- npm ci ----------------------------------------------------------------
echo "==> Running npm ci in $PROJECT_DIR (this may take 2-5 minutes)"
cd "$PROJECT_DIR"
npm ci --no-audit --no-fund

# ---- done -------------------------------------------------------------------
cat <<'DONE'

================================================================
 Restore complete!
================================================================
NEXT STEPS:
  1. Edit your API keys:
       $EDITOR ~/.pi/agent/auth.json   (chmod 600 already set)
  2. Verify pi sees your config:
       node --version                  # should be >= 22
       ls ~/.pi/agent/memory/MEMORY.md # should exist
  3. Start the sansheng server:
       cd sansheng && npm run dev
  4. (Optional) install global pi tooling:
       npm i -g @earendil-works/pi-coding-agent
DONE

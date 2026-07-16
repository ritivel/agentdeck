#!/bin/bash
# AgentDeck bridge installer (CLI path — the Mac app manages its own bridge).
#   curl -fsSL https://raw.githubusercontent.com/ritivel/agentdeck/main/install.sh | bash
set -euo pipefail

bold() { printf '\033[1m%s\033[0m\n' "$*"; }

if ! command -v node >/dev/null 2>&1; then
  echo "AgentDeck needs Node.js 22.5+ (for node:sqlite)."
  echo "Install it first:  brew install node   (or https://nodejs.org)"
  exit 1
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
NODE_MINOR="$(node -p 'process.versions.node.split(".")[1]')"
if [ "$NODE_MAJOR" -lt 22 ] || { [ "$NODE_MAJOR" -eq 22 ] && [ "$NODE_MINOR" -lt 5 ]; }; then
  echo "AgentDeck needs Node.js >= 22.5 (found $(node --version))."
  exit 1
fi

bold "Installing the AgentDeck bridge…"
if npm view @agentdeck/bridge version >/dev/null 2>&1; then
  npm install -g @agentdeck/bridge
else
  # Not on npm yet — build and install from source.
  TMP="$(mktemp -d)"
  git clone --depth 1 https://github.com/ritivel/agentdeck "$TMP/agentdeck"
  (cd "$TMP/agentdeck/bridge" && npm ci && npm run build && npm install -g .)
  rm -rf "$TMP"
fi

bold "Setting up the background service (starts at login)…"
agentdeck service install

echo
bold "Done! Next steps:"
echo "  1. Get the AgentDeck iOS app on your iPhone (see README)."
echo "  2. Run: agentdeck pair    — scan the QR with the app."
echo "  3. For terminal sessions you can type into from the phone: agentdeck claude"

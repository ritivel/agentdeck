#!/bin/bash
# Bundles the bridge daemon (compiled JS + production node_modules + a Node
# runtime) into the Mac app's Resources so the app is fully self-contained.
# Runs as an Xcode build phase; also usable standalone:
#   ./bundle-bridge.sh <output-dir>
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BRIDGE_DIR="$REPO_ROOT/bridge"
STAGING="$REPO_ROOT/macos/.bridge-staging"

if [ -n "${TARGET_BUILD_DIR:-}" ] && [ -n "${UNLOCALIZED_RESOURCES_FOLDER_PATH:-}" ]; then
  DEST="$TARGET_BUILD_DIR/$UNLOCALIZED_RESOURCES_FOLDER_PATH/bridge"
else
  DEST="${1:?usage: bundle-bridge.sh <output-dir>}/bridge"
fi

NODE_BIN="$(command -v node || true)"
# Xcode build phases run with a minimal PATH; look in the usual places.
for candidate in /opt/homebrew/bin/node /usr/local/bin/node "$HOME/.local/bin/node"; do
  [ -z "$NODE_BIN" ] && [ -x "$candidate" ] && NODE_BIN="$candidate"
done
if [ -z "$NODE_BIN" ]; then
  echo "error: node not found — needed to build and bundle the bridge" >&2
  exit 1
fi
NODE_BIN="$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$NODE_BIN")"
export PATH="$(dirname "$NODE_BIN"):$PATH"

# Rebuild the staging area only when bridge sources change.
FINGERPRINT="$( (cd "$BRIDGE_DIR" && cat package-lock.json; find src ../web -type f \( -name '*.ts' -o -name '*.js' -o -name '*.html' -o -name '*.css' \) -exec shasum {} \;) | shasum | cut -d' ' -f1 )"
STAMP="$STAGING/.fingerprint"

if [ ! -d "$STAGING" ] || [ "$(cat "$STAMP" 2>/dev/null)" != "$FINGERPRINT" ]; then
  echo "bundle-bridge: rebuilding staging (bridge changed)"
  rm -rf "$STAGING"
  mkdir -p "$STAGING"

  # Fresh clone / CI: install dev deps (tsc) before building.
  if [ ! -x "$BRIDGE_DIR/node_modules/.bin/tsc" ]; then
    (cd "$BRIDGE_DIR" && npm ci >/dev/null 2>&1)
  fi
  (cd "$BRIDGE_DIR" && npm run build >/dev/null)
  cp -R "$BRIDGE_DIR/dist" "$STAGING/dist"
  cp "$BRIDGE_DIR/package.json" "$BRIDGE_DIR/package-lock.json" "$STAGING/"

  (cd "$STAGING" && npm ci --omit=dev --ignore-scripts >/dev/null 2>&1)
  # node-pty needs its postinstall-less prebuilds to be executable.
  chmod +x "$STAGING"/node_modules/node-pty/prebuilds/*/spawn-helper 2>/dev/null || true

  cp "$NODE_BIN" "$STAGING/node"
  chmod +x "$STAGING/node"
  echo "$FINGERPRINT" > "$STAMP"
fi

mkdir -p "$DEST"
rsync -a --delete "$STAGING/" "$DEST/"
# The fingerprint stamp is a build cache detail, not app payload.
rm -f "$DEST/.fingerprint"
echo "bundle-bridge: bundled into $DEST"

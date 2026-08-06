#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROFILE_PATH="$ROOT_DIR/sandbox/macos-dev.sb"

if [[ ! -f "$PROFILE_PATH" ]]; then
  echo "sandbox profile not found: $PROFILE_PATH" >&2
  exit 1
fi

if [[ $# -eq 0 ]]; then
  cat >&2 <<'EOF'
Usage: scripts/macos-sandbox.sh <command> [args...]

Examples:
  scripts/macos-sandbox.sh npm run dev
  scripts/macos-sandbox.sh npm run test:unit
  scripts/macos-sandbox.sh npx vitest run
EOF
  exit 1
fi

if ! command -v sandbox-exec >/dev/null 2>&1; then
  echo "sandbox-exec is not available on this macOS install." >&2
  exit 1
fi

HOME_DIR="${HOME}"
ASDF_DIR="${ASDF_DATA_DIR:-$HOME_DIR/.asdf}"
NODE_BIN="$(command -v node)"
NODE_INSTALL_DIR="$(cd "$(dirname "$NODE_BIN")/.." && pwd)"
NPM_CACHE_DIR="$(npm config get cache | tr -d '\r')"
TMPDIR_VALUE="${TMPDIR:-$(python3 - <<'PY'
import tempfile
print(tempfile.gettempdir())
PY
)}"
TMPDIR_VALUE="${TMPDIR_VALUE%/}"
TMPDIR_REAL="$(python3 - "$TMPDIR_VALUE" <<'PY'
import os
import sys
print(os.path.realpath(sys.argv[1]))
PY
)"
PI_DIR="${PI_CODING_AGENT_DIR:-${LEITWERK_PI_DIR:-$HOME_DIR/.pi/leitwerk}}"

exec sandbox-exec \
  -D PROJECT_ROOT="$ROOT_DIR" \
  -D HOME_DIR="$HOME_DIR" \
  -D ASDF_DIR="$ASDF_DIR" \
  -D NODE_INSTALL_DIR="$NODE_INSTALL_DIR" \
  -D NPM_CACHE_DIR="$NPM_CACHE_DIR" \
  -D TMPDIR="$TMPDIR_VALUE" \
  -D TMPDIR_REAL="$TMPDIR_REAL" \
  -D PI_DIR="$PI_DIR" \
  -f "$PROFILE_PATH" \
  "$@"

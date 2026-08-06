#!/usr/bin/env bash
set -euo pipefail

cd /Users/jvandria/repos/secondary-leitwerk

export LEITWERK_CONFIG_PATH=/Users/jvandria/repos/secondary-leitwerk/leitwerk.yaml
export LEITWERK_UI_PORT=${LEITWERK_UI_PORT:-5174}
export PORT=${PORT:-8081}
export LEITWERK_BASE_URL=${LEITWERK_BASE_URL:-http://127.0.0.1:${PORT}}

if [[ -z "${SECONDARY_TELEGRAM_BOT_TOKEN:-}" ]]; then
  cat >&2 <<'EOF'
SECONDARY_TELEGRAM_BOT_TOKEN is not set.
Create/use a separate Telegram bot for the secondary leitwerk, then run for example:

  export SECONDARY_TELEGRAM_BOT_TOKEN='<secondary bot token from BotFather>'
  /Users/jvandria/repos/secondary-leitwerk/.leitwerk/start-secondary.sh

EOF
  exit 2
fi

export LEITWERK_API_PROTOCOL=${LEITWERK_API_PROTOCOL:-http}
export LEITWERK_API_HOST=${LEITWERK_API_HOST:-127.0.0.1}
export LEITWERK_API_PORT=${LEITWERK_API_PORT:-${PORT}}
export LEITWERK_RUNTIME_LANE=dist

backend_pid=""
ui_pid=""

cleanup() {
  local exit_code="${1:-0}"
  trap - INT TERM EXIT
  if [[ -n "${ui_pid}" ]]; then
    kill "${ui_pid}" 2>/dev/null || true
  fi
  if [[ -n "${backend_pid}" ]]; then
    kill "${backend_pid}" 2>/dev/null || true
  fi
  if [[ -n "${ui_pid}" ]]; then
    wait "${ui_pid}" 2>/dev/null || true
  fi
  if [[ -n "${backend_pid}" ]]; then
    wait "${backend_pid}" 2>/dev/null || true
  fi
  exit "${exit_code}"
}

trap 'cleanup 130' INT
trap 'cleanup 143' TERM
trap 'cleanup $?' EXIT

echo "[start-secondary] Building production artifacts..."
npm run parity:build

echo "[start-secondary] Starting dist backend without hot reload..."
npm run parity:start &
backend_pid="$!"

echo "[start-secondary] Waiting for backend health on http://127.0.0.1:${PORT}/api/health..."
backend_ready=0
for _ in $(seq 1 120); do
  if curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
    backend_ready=1
    break
  fi
  if ! kill -0 "${backend_pid}" 2>/dev/null; then
    echo "[start-secondary] Backend exited before becoming healthy." >&2
    wait "${backend_pid}" || true
    exit 1
  fi
  sleep 0.5
done

if [[ "${backend_ready}" != "1" ]]; then
  echo "[start-secondary] Timed out waiting for backend health." >&2
  exit 1
fi

echo "[start-secondary] Starting built UI preview without hot reload..."
npm run preview -w @leitwerk-dev/ui -- --host localhost --port "${LEITWERK_UI_PORT}" --strictPort &
ui_pid="$!"

echo "[start-secondary] Waiting for UI preview on http://localhost:${LEITWERK_UI_PORT}/api/health..."
ui_ready=0
for _ in $(seq 1 120); do
  if curl -fsS "http://localhost:${LEITWERK_UI_PORT}/api/health" >/dev/null 2>&1; then
    ui_ready=1
    break
  fi
  if ! kill -0 "${ui_pid}" 2>/dev/null; then
    echo "[start-secondary] UI preview exited before becoming reachable." >&2
    wait "${ui_pid}" || true
    exit 1
  fi
  sleep 0.5
done

if [[ "${ui_ready}" != "1" ]]; then
  echo "[start-secondary] Timed out waiting for UI preview." >&2
  exit 1
fi

cat <<EOF
[start-secondary] Secondary is running without hot reload:
  UI:      http://localhost:${LEITWERK_UI_PORT}/
  Backend: http://127.0.0.1:${PORT}/
EOF

while true; do
  if ! kill -0 "${backend_pid}" 2>/dev/null; then
    exit_code=0
    wait "${backend_pid}" || exit_code="$?"
    cleanup "${exit_code}"
  fi
  if ! kill -0 "${ui_pid}" 2>/dev/null; then
    exit_code=0
    wait "${ui_pid}" || exit_code="$?"
    cleanup "${exit_code}"
  fi
  sleep 1
done

#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
if [[ -f "${PORT_FORWARD_PID_FILE}" ]]; then
	pid="$(cat "${PORT_FORWARD_PID_FILE}")"
	kill "${pid}" >/dev/null 2>&1 || true
	rm -f "${PORT_FORWARD_PID_FILE}"
fi

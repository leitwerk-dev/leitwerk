#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
mkdir -p "${DEPLOY_ROOT}/logs"

if [[ -f "${PORT_FORWARD_PID_FILE}" ]]; then
	old_pid="$(cat "${PORT_FORWARD_PID_FILE}")"
	if kill -0 "${old_pid}" >/dev/null 2>&1; then
		kill "${old_pid}"
		wait "${old_pid}" 2>/dev/null || true
	fi
	rm -f "${PORT_FORWARD_PID_FILE}"
fi

if lsof -nP -iTCP:"${LEITWERK_PORT}" -sTCP:LISTEN >/dev/null 2>&1; then
	echo "Port ${LEITWERK_PORT} is already in use" >&2
	exit 1
fi

nohup kubectl --context "${KUBE_CONTEXT}" -n "${SERVER_NAMESPACE}" port-forward \
	--address 127.0.0.1 "service/${HELM_RELEASE}-gateway" "${LEITWERK_PORT}:8080" \
	>"${PORT_FORWARD_LOG}" 2>&1 &
pid=$!
printf '%s\n' "${pid}" > "${PORT_FORWARD_PID_FILE}"

for _ in $(seq 1 60); do
	if ! kill -0 "${pid}" >/dev/null 2>&1; then
		cat "${PORT_FORWARD_LOG}" >&2
		exit 1
	fi
	if curl -fsS "http://127.0.0.1:${LEITWERK_PORT}/api/health" >/dev/null \
		&& curl -fsS "http://127.0.0.1:${LEITWERK_PORT}/" | grep -q '<div id="app">'; then
		echo "Leitwerk UI: http://127.0.0.1:${LEITWERK_PORT}"
		exit 0
	fi
	sleep 1
done
cat "${PORT_FORWARD_LOG}" >&2
echo "Port-forward did not become ready" >&2
exit 1

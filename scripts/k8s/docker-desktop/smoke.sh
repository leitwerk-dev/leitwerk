#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
base_url="http://127.0.0.1:${LEITWERK_PORT}"

curl -fsS "${base_url}/api/health" >/dev/null
response="$(curl -fsS -X POST -H 'Content-Type: application/json' \
	-H "Idempotency-Key: docker-desktop-smoke-$(date +%s)-${RANDOM}" \
	-d '{"title":"Docker Desktop Kubernetes smoke","launcherInput":{"prompt":"docker desktop kubernetes smoke"},"schedule":{"mode":"now"}}' \
	"${base_url}/api/launchers/k8s_smoke_process.k8s_smoke_ui/launch-runs")"
launch_run_id="$(printf '%s' "${response}" | node -e '
const fs=require("node:fs"); const value=JSON.parse(fs.readFileSync(0,"utf8"));
if (!value.launchRunId) process.exit(1); process.stdout.write(value.launchRunId);')"
instance_id=""
for _ in $(seq 1 120); do
	response="$(curl -fsS "${base_url}/api/launch-runs/${launch_run_id}")"
	instance_id="$(printf '%s' "${response}" | node -e '
const fs=require("node:fs"); const value=JSON.parse(fs.readFileSync(0,"utf8"));
process.stdout.write(value.launchRun?.instanceId ?? "");')"
	[[ -n "${instance_id}" ]] && break
	sleep 1
done
[[ -n "${instance_id}" ]] || { echo "Launch run did not create a process" >&2; exit 1; }

ready=false
for _ in $(seq 1 120); do
	item="$(curl -fsS "${base_url}/api/processes" | node -e '
const fs=require("node:fs"); const id=process.argv[1]; const value=JSON.parse(fs.readFileSync(0,"utf8"));
const item=value.processes.find((entry)=>entry.process?.id===id); if (!item) process.exit(1);
process.stdout.write(JSON.stringify(item));' "${instance_id}")"
	if printf '%s' "${item}" | node -e '
const fs=require("node:fs"); const item=JSON.parse(fs.readFileSync(0,"utf8"));
process.exit(item.process?.selectedTurnId === "k8s_smoke_wait" ? 0 : 1);'; then
		ready=true
		break
	fi
	sleep 1
done
[[ "${ready}" == "true" ]] || { echo "Smoke process did not reach k8s_smoke_wait" >&2; printf '%s\n' "${item}" >&2; exit 1; }

namespace="$(kubectl --context "${KUBE_CONTEXT}" get namespace \
	-l "leitwerk.dev/instance-id=${instance_id},leitwerk.dev/component=process-namespace" \
	-o jsonpath='{.items[0].metadata.name}')"
[[ "${namespace}" == "${PROCESS_NAMESPACE_PREFIX}"* ]] || { echo "Unexpected process namespace: ${namespace}" >&2; exit 1; }
kubectl --context "${KUBE_CONTEXT}" -n "${namespace}" get pvc
actual_image="$(kubectl --context "${KUBE_CONTEXT}" -n "${namespace}" get pod \
	-l 'leitwerk.dev/component=worker' -o jsonpath='{.items[0].spec.containers[0].image}')"
[[ "${actual_image}" == "${WORKER_IMAGE}" ]] || { echo "Unexpected worker image: ${actual_image}" >&2; exit 1; }
printf 'Smoke process %s reached k8s_smoke_wait in %s with %s\n' "${instance_id}" "${namespace}" "${actual_image}"

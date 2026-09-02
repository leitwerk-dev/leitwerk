#!/usr/bin/env bash
set -euo pipefail

release="${HELM_RELEASE:-leitwerk}"
namespace="${K8S_NAMESPACE:-leitwerk-k8s-test}"
specialized_worker_image="${WORKER_SPECIALIZED_IMAGE:-leitwerk-worker-specialized-smoke:dev}"
local_port="${LEITWERK_LOCAL_PORT:-18080}"
process_namespace_prefix="${K8S_PROCESS_NAMESPACE_PREFIX:-leitwerk-k8s-test-process-}"
server_storage_mount="${K8S_SERVER_STORAGE_MOUNT:-/var/lib/leitwerk}"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

command -v kubectl >/dev/null 2>&1 || { echo "kubectl is required" >&2; exit 1; }
command -v curl >/dev/null 2>&1 || { echo "curl is required" >&2; exit 1; }
command -v node >/dev/null 2>&1 || { echo "node is required" >&2; exit 1; }

port_forward_pid=""
created_namespaces=()

cleanup() {
	if [[ -n "${port_forward_pid}" ]]; then
		kill "${port_forward_pid}" >/dev/null 2>&1 || true
	fi
	if (( ${#created_namespaces[@]} > 0 )); then
		kubectl delete namespace "${created_namespaces[@]}" --ignore-not-found --wait=false >/dev/null 2>&1 || true
	fi
}
trap cleanup EXIT

json_get() {
	local expr="$1"
	node -e '
const fs = require("node:fs");
const data = JSON.parse(fs.readFileSync(0, "utf8"));
let value = data;
for (const part of process.argv[1].split(".")) {
  if (!part) continue;
  value = value?.[part];
}
if (value === undefined || value === null) process.exit(1);
process.stdout.write(typeof value === "string" ? value : JSON.stringify(value));
' "${expr}"
}

api_get() {
	curl -fsS "http://127.0.0.1:${local_port}$1"
}

api_post() {
	local path="$1"
	local body="$2"
	curl -fsS -X POST -H "Content-Type: application/json" -d "${body}" \
		"http://127.0.0.1:${local_port}${path}"
}

server_deployment() {
	kubectl -n "${namespace}" get deployment \
		-l "app.kubernetes.io/instance=${release},app.kubernetes.io/component=server" \
		-o jsonpath='{.items[0].metadata.name}'
}

server_service() {
	kubectl -n "${namespace}" get service \
		-l "app.kubernetes.io/instance=${release},app.kubernetes.io/component=server" \
		-o jsonpath='{.items[0].metadata.name}'
}

server_pod() {
	kubectl -n "${namespace}" get pod \
		-l "app.kubernetes.io/instance=${release},app.kubernetes.io/component=server" \
		-o jsonpath='{.items[0].metadata.name}'
}

start_port_forward() {
	local service
	service="$(server_service)"
	if [[ -z "${service}" ]]; then
		echo "No leitwerk server service found for release '${release}' in namespace '${namespace}'" >&2
		exit 1
	fi
	kubectl -n "${namespace}" port-forward "service/${service}" "${local_port}:8080" >/tmp/leitwerk-k8s-port-forward.log 2>&1 &
	port_forward_pid=$!
	for _ in {1..30}; do
		if curl -fsS "http://127.0.0.1:${local_port}/api/health" >/dev/null; then
			return
		fi
		sleep 1
	done
	curl -fsS "http://127.0.0.1:${local_port}/api/health" >/dev/null
}

restart_port_forward() {
	if [[ -n "${port_forward_pid}" ]]; then
		kill "${port_forward_pid}" >/dev/null 2>&1 || true
	fi
	port_forward_pid=""
	start_port_forward
}

process_json() {
	local instance_id="$1"
	api_get "/api/processes" | node -e '
const fs = require("node:fs");
const id = process.argv[1];
const data = JSON.parse(fs.readFileSync(0, "utf8"));
const item = data.processes.find((entry) => entry.process?.id === id);
if (!item) process.exit(1);
process.stdout.write(JSON.stringify(item));
' "${instance_id}"
}

wait_for_process_state() {
	local instance_id="$1"
	local states_csv="$2"
	local timeout_seconds="${3:-90}"
	local deadline=$((SECONDS + timeout_seconds))
	while (( SECONDS < deadline )); do
		local item=""
		if item="$(process_json "${instance_id}" 2>/dev/null)"; then
			if printf '%s' "${item}" | node -e '
const fs = require("node:fs");
const states = new Set(process.argv[1].split(","));
const item = JSON.parse(fs.readFileSync(0, "utf8"));
const state = item.workerLease?.state ?? "absent";
process.exit(states.has(state) ? 0 : 1);
' "${states_csv}"; then
				return
			fi
		fi
		sleep 1
	done
	echo "Timed out waiting for process ${instance_id} worker state in [${states_csv}]" >&2
	process_json "${instance_id}" >&2 || true
	exit 1
}

launch_process() {
	local launcher_id="$1"
	local title="$2"
	local input_json="$3"
	local response launch_run_id instance_id=""
	response="$(curl -fsS -X POST -H "Content-Type: application/json" \
		-H "Idempotency-Key: k8s-smoke-$(date +%s)-${RANDOM}" \
		-d "{\"title\":\"${title}\",\"launcherInput\":${input_json},\"schedule\":{\"mode\":\"now\"}}" \
		"http://127.0.0.1:${local_port}/api/launchers/${launcher_id}/launch-runs")"
	launch_run_id="$(printf '%s' "${response}" | json_get "launchRunId")"
	for _ in $(seq 1 90); do
		response="$(api_get "/api/launch-runs/${launch_run_id}")"
		instance_id="$(printf '%s' "${response}" | node -e '
const fs=require("node:fs"); const value=JSON.parse(fs.readFileSync(0,"utf8"));
process.stdout.write(value.launchRun?.instanceId ?? "");')"
		[[ -n "${instance_id}" ]] && break
		sleep 1
	done
	[[ -n "${instance_id}" ]] || { echo "Launch run ${launch_run_id} did not create a process" >&2; exit 1; }
	printf '%s' "${instance_id}"
}

namespace_for_instance() {
	local instance_id="$1"
	kubectl get namespace \
		-l "leitwerk.dev/instance-id=${instance_id},leitwerk.dev/component=process-namespace" \
		-o jsonpath='{.items[0].metadata.name}'
}

wait_for_namespace() {
	local instance_id="$1"
	local timeout_seconds="${2:-60}"
	local deadline=$((SECONDS + timeout_seconds))
	while (( SECONDS < deadline )); do
		local ns
		ns="$(namespace_for_instance "${instance_id}" 2>/dev/null || true)"
		if [[ -n "${ns}" ]]; then
			created_namespaces+=("${ns}")
			printf '%s' "${ns}"
			return
		fi
		sleep 1
	done
	echo "Timed out waiting for process namespace for ${instance_id}" >&2
	exit 1
}

pod_for_instance() {
	local instance_id="$1"
	kubectl get pods -A \
		-l "leitwerk.dev/instance-id=${instance_id},leitwerk.dev/component=worker" \
		-o jsonpath='{.items[0].metadata.namespace} {.items[0].metadata.name}'
}

wait_for_pod() {
	local instance_id="$1"
	local timeout_seconds="${2:-90}"
	local deadline=$((SECONDS + timeout_seconds))
	while (( SECONDS < deadline )); do
		local pod_ref
		pod_ref="$(pod_for_instance "${instance_id}" 2>/dev/null || true)"
		if [[ "${pod_ref}" == *" "* && -n "${pod_ref// /}" ]]; then
			printf '%s' "${pod_ref}"
			return
		fi
		sleep 1
	done
	echo "Timed out waiting for worker pod for ${instance_id}" >&2
	exit 1
}

wait_for_no_pod() {
	local instance_id="$1"
	local timeout_seconds="${2:-45}"
	local deadline=$((SECONDS + timeout_seconds))
	while (( SECONDS < deadline )); do
		local pod_ref
		pod_ref="$(pod_for_instance "${instance_id}" 2>/dev/null || true)"
		if [[ -z "${pod_ref// /}" ]]; then
			return
		fi
		sleep 1
	done
	echo "Timed out waiting for worker pod deletion for ${instance_id}" >&2
	pod_for_instance "${instance_id}" >&2 || true
	exit 1
}

wait_for_snapshot() {
	local instance_id="$1"
	local timeout_seconds="${2:-60}"
	local deadline=$((SECONDS + timeout_seconds))
	while (( SECONDS < deadline )); do
		local pod
		pod="$(server_pod)"
		if [[ -n "${pod}" ]] && kubectl -n "${namespace}" exec "${pod}" -- test -s "${server_storage_mount}/trees/${instance_id}.metadata.json" >/dev/null 2>&1; then
			return
		fi
		sleep 1
	done
	echo "Timed out waiting for accepted session snapshot metadata for ${instance_id}" >&2
	exit 1
}

process_worker_heartbeat() {
	local instance_id="$1"
	process_json "${instance_id}" | node -e '
const fs = require("node:fs");
const item = JSON.parse(fs.readFileSync(0, "utf8"));
process.stdout.write(item.workerLease?.lastHeartbeatAt ?? "");
'
}

wait_for_lease_heartbeat_changed() {
	local instance_id="$1"
	local previous="$2"
	local timeout_seconds="${3:-60}"
	local deadline=$((SECONDS + timeout_seconds))
	while (( SECONDS < deadline )); do
		local current
		current="$(process_worker_heartbeat "${instance_id}" 2>/dev/null || true)"
		if [[ -n "${current}" && "${current}" != "${previous}" ]]; then
			printf '%s' "${current}"
			return
		fi
		sleep 1
	done
	echo "Timed out waiting for worker heartbeat for ${instance_id} to advance" >&2
	process_json "${instance_id}" >&2 || true
	exit 1
}

"${repo_root}/scripts/k8s/wait-ready.sh"
start_port_forward
curl -fsS "http://127.0.0.1:${local_port}/api/health" >/dev/null

echo "Server health check passed"

server_sa="$(kubectl -n "${namespace}" get serviceaccount \
	-l "app.kubernetes.io/instance=${release},app.kubernetes.io/component=server" \
	-o jsonpath='{.items[0].metadata.name}')"
if [[ -z "${server_sa}" ]]; then
	echo "No leitwerk server ServiceAccount found for release '${release}' in namespace '${namespace}'" >&2
	exit 1
fi

server_subject="system:serviceaccount:${namespace}:${server_sa}"
if ! kubectl auth can-i create namespaces --as="${server_subject}" >/dev/null 2>&1; then
	echo "Server ServiceAccount ${server_subject} cannot create namespaces." >&2
	echo "Re-deploy the current Helm chart/RBAC before running the Kubernetes smoke test:" >&2
	echo "  npm run k8s:helm:deploy:kind" >&2
	exit 1
fi

if [[ -n "${server_sa}" ]]; then
	set +e
	admission_output="$(cat <<YAML | kubectl --as="${server_subject}" create --dry-run=server -f - 2>&1
apiVersion: v1
kind: Namespace
metadata:
  name: invalid-leitwerk-process-admission-test
  labels:
    leitwerk.dev/managed-by: leitwerk
    leitwerk.dev/component: process-namespace
    leitwerk.dev/instance-id: admission-test
YAML
)"
	admission_status=$?
	set -e
	if [[ ${admission_status} -eq 0 ]] || [[ "${admission_output}" != *"leitwerk process namespaces must use the configured prefix"* ]]; then
		echo "Expected ValidatingAdmissionPolicy to reject an invalid server-created namespace" >&2
		echo "${admission_output}" >&2
		exit 1
	fi
	echo "Admission policy rejected invalid server-created namespace"
fi

smoke_id="$(launch_process "k8s_smoke_process.k8s_smoke_ui" "k8s smoke" '{"prompt":"kind smoke"}')"
smoke_ns="$(wait_for_namespace "${smoke_id}")"
smoke_pod_ref="$(wait_for_pod "${smoke_id}")"
smoke_pod_name="${smoke_pod_ref#* }"
kubectl -n "${smoke_ns}" wait --for=condition=Ready "pod/${smoke_pod_name}" --timeout=90s
kubectl -n "${smoke_ns}" get pvc -l "leitwerk.dev/instance-id=${smoke_id},leitwerk.dev/component=process-volume" >/dev/null
wait_for_process_state "${smoke_id}" "idle,busy" 90
wait_for_snapshot "${smoke_id}" 60

echo "Process launch created namespace/PVC/pod, connected over WebSocket, and uploaded a session snapshot"

if [[ -n "${server_sa}" ]]; then
	set +e
	bad_pod_output="$(cat <<YAML | kubectl --as="${server_subject}" create --dry-run=server -f - 2>&1
apiVersion: v1
kind: Pod
metadata:
  name: invalid-worker-service-account
  namespace: ${smoke_ns}
  labels:
    leitwerk.dev/managed-by: leitwerk
    leitwerk.dev/component: worker
    leitwerk.dev/instance-id: ${smoke_id}
    leitwerk.dev/worker-id: invalid-worker
    leitwerk.dev/server-epoch: invalid
spec:
  serviceAccountName: default
  restartPolicy: Never
  containers:
    - name: worker
      image: busybox
      command: ["true"]
YAML
)"
	bad_pod_status=$?
	set -e
	if [[ ${bad_pod_status} -eq 0 ]] || [[ "${bad_pod_output}" != *"leitwerk worker pods must use the configured worker ServiceAccount"* ]]; then
		echo "Expected ValidatingAdmissionPolicy to reject an invalid worker ServiceAccount" >&2
		echo "${bad_pod_output}" >&2
		exit 1
	fi
	echo "Admission policy rejected invalid worker ServiceAccount"
fi

pvc_uid="$(kubectl -n "${smoke_ns}" get pvc -l "leitwerk.dev/instance-id=${smoke_id},leitwerk.dev/component=process-volume" -o jsonpath='{.items[0].metadata.uid}')"
wait_for_process_state "${smoke_id}" "idle" 90
wait_for_no_pod "${smoke_id}" 60
kubectl -n "${smoke_ns}" get pvc -l "leitwerk.dev/instance-id=${smoke_id},leitwerk.dev/component=process-volume" >/dev/null

echo "Idle worker pod was deleted and process PVC remained"

api_post "/api/processes/${smoke_id}/actions/run_again" '{"input":{}}' >/dev/null
respawn_pod_ref="$(wait_for_pod "${smoke_id}" 90)"
respawn_pod_name="${respawn_pod_ref#* }"
kubectl -n "${smoke_ns}" wait --for=condition=Ready "pod/${respawn_pod_name}" --timeout=90s
respawn_pvc_uid="$(kubectl -n "${smoke_ns}" get pvc -l "leitwerk.dev/instance-id=${smoke_id},leitwerk.dev/component=process-volume" -o jsonpath='{.items[0].metadata.uid}')"
if [[ "${respawn_pvc_uid}" != "${pvc_uid}" ]]; then
	echo "Expected respawn to reuse retained PVC ${pvc_uid}, got ${respawn_pvc_uid}" >&2
	exit 1
fi
wait_for_snapshot "${smoke_id}" 60

echo "Worker respawned on the retained PVC"

long_id="$(launch_process "k8s_smoke_long_process.k8s_smoke_long_ui" "k8s long smoke" '{}')"
long_ns="$(wait_for_namespace "${long_id}")"
long_pod_ref="$(wait_for_pod "${long_id}" 90)"
long_pod_name="${long_pod_ref#* }"
kubectl -n "${long_ns}" wait --for=condition=Ready "pod/${long_pod_name}" --timeout=90s
wait_for_process_state "${long_id}" "busy" 90
old_heartbeat="$(wait_for_lease_heartbeat_changed "${long_id}" "" 45)"

deployment="$(server_deployment)"
kubectl -n "${namespace}" rollout restart "deployment/${deployment}"
if [[ -n "${port_forward_pid}" ]]; then
	kill "${port_forward_pid}" >/dev/null 2>&1 || true
	port_forward_pid=""
fi
"${repo_root}/scripts/k8s/wait-ready.sh"
restart_port_forward
kubectl -n "${long_ns}" get pod "${long_pod_name}" >/dev/null
wait_for_process_state "${long_id}" "busy,idle" 60
wait_for_lease_heartbeat_changed "${long_id}" "${old_heartbeat}" 90 >/dev/null

echo "Server restart adopted and reconnected a compatible old worker pod"

specialized_id="$(launch_process "k8s_smoke_specialized_process.k8s_smoke_specialized_ui" "k8s specialized smoke" '{}')"
specialized_ns="$(wait_for_namespace "${specialized_id}")"
specialized_pod_ref="$(wait_for_pod "${specialized_id}" 90)"
specialized_pod_name="${specialized_pod_ref#* }"
specialized_image_actual="$(kubectl -n "${specialized_ns}" get pod "${specialized_pod_name}" -o jsonpath='{.spec.containers[0].image}')"
if [[ "${specialized_image_actual}" != "${specialized_worker_image}" ]]; then
	echo "Expected specialized runtime profile image ${specialized_worker_image}, got ${specialized_image_actual}" >&2
	exit 1
fi
kubectl -n "${specialized_ns}" wait --for=condition=Ready "pod/${specialized_pod_name}" --timeout=90s
wait_for_process_state "${specialized_id}" "idle" 90
wait_for_snapshot "${specialized_id}" 60

echo "Specialized runtime profile selected the specialized worker image and completed its deterministic tool step"

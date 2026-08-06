#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

for command in docker kubectl helm curl openssl node; do
	command -v "${command}" >/dev/null || { echo "${command} is required" >&2; exit 1; }
done
[[ -f "${SOURCE_CONFIG}" ]] || { echo "Missing source config: ${SOURCE_CONFIG}" >&2; exit 1; }
[[ "$(docker context show)" == "desktop-linux" ]] || { echo "Docker context must be desktop-linux" >&2; exit 1; }
kubectl --context "${KUBE_CONTEXT}" cluster-info >/dev/null
kubectl --context "${KUBE_CONTEXT}" wait --for=condition=Ready node --all --timeout=60s >/dev/null
kubectl --context "${KUBE_CONTEXT}" get storageclass standard >/dev/null
kubectl --context "${KUBE_CONTEXT}" api-resources --api-group=admissionregistration.k8s.io \
	| grep validatingadmissionpolicies >/dev/null

if [[ ! -d "${DEPLOY_ROOT}" ]] && kubectl --context "${KUBE_CONTEXT}" get namespace "${SERVER_NAMESPACE}" >/dev/null 2>&1; then
	echo "Namespace ${SERVER_NAMESPACE} exists but deployment directory does not" >&2
	exit 1
fi

printf 'Context: %s\nNamespace: %s\nProcess prefix: %s\nEndpoint: http://127.0.0.1:%s\n' \
	"${KUBE_CONTEXT}" "${SERVER_NAMESPACE}" "${PROCESS_NAMESPACE_PREFIX}" "${LEITWERK_PORT}"

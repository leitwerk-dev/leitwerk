#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
mode="${1:-stop}"
[[ "${mode}" == "stop" || "${mode}" == "purge" ]] || { echo "Usage: $0 [stop|purge]" >&2; exit 2; }
"$(dirname "${BASH_SOURCE[0]}")/stop-port-forward.sh"

if [[ "${mode}" == "stop" ]]; then
	kubectl --context "${KUBE_CONTEXT}" -n "${SERVER_NAMESPACE}" scale \
		deployment -l "app.kubernetes.io/instance=${HELM_RELEASE}" --replicas=0
	echo "Stopped ${DEPLOY_ID}; PVCs, namespaces, Secrets, images, and backups are retained."
	exit 0
fi

read -r -p "Type ${DEPLOY_ID} to purge this Kubernetes deployment: " confirmation
[[ "${confirmation}" == "${DEPLOY_ID}" ]] || { echo "Cancelled"; exit 0; }
latest_backup="$(find "${DEPLOY_ROOT}/backups" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | sort | tail -1)"
[[ -n "${latest_backup}" && -f "${latest_backup}/SHA256SUMS" ]] || {
	echo "A checksummed backup is required before purge" >&2
	exit 1
}

while IFS= read -r namespace; do
	[[ -n "${namespace}" && "${namespace}" == "${PROCESS_NAMESPACE_PREFIX}"* ]] || continue
	kubectl --context "${KUBE_CONTEXT}" delete namespace "${namespace}" --wait=false
done < <(kubectl --context "${KUBE_CONTEXT}" get namespaces \
	-l 'leitwerk.dev/managed-by=leitwerk,leitwerk.dev/component=process-namespace' \
	-o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}')
helm uninstall "${HELM_RELEASE}" --kube-context "${KUBE_CONTEXT}" --namespace "${SERVER_NAMESPACE}" || true
kubectl --context "${KUBE_CONTEXT}" delete namespace "${SERVER_NAMESPACE}" --wait=false
echo "Purged cluster resources. Images and ${DEPLOY_ROOT} were retained."

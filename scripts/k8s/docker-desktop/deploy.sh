#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

"$(dirname "${BASH_SOURCE[0]}")/preflight.sh"
mkdir -p "${DEPLOY_ROOT}"/{config,secrets,backups,rendered,logs}
chmod 700 "${DEPLOY_ROOT}" "${DEPLOY_ROOT}/secrets" "${DEPLOY_ROOT}/backups"

if [[ "${LEITWERK_K8S_SKIP_BUILD:-false}" != "true" ]]; then
	"$(dirname "${BASH_SOURCE[0]}")/build-images.sh"
else
	docker image inspect "${SERVER_IMAGE}" "${WORKER_IMAGE}" >/dev/null
fi
"$(dirname "${BASH_SOURCE[0]}")/load-images.sh"

SOURCE_CONFIG="${SOURCE_CONFIG}" OUTPUT_CONFIG="${CONFIG_FILE}" OUTPUT_VALUES="${VALUES_FILE}" \
	SERVER_NAMESPACE="${SERVER_NAMESPACE}" PROCESS_NAMESPACE_PREFIX="${PROCESS_NAMESPACE_PREFIX}" \
	SERVER_IMAGE="${SERVER_IMAGE}" WORKER_IMAGE="${WORKER_IMAGE}" LEITWERK_PORT="${LEITWERK_PORT}" \
	CONFIG_SECRET="${CONFIG_SECRET}" CREDENTIAL_SECRET="${CREDENTIAL_SECRET}" \
	node "${repo_root}/scripts/k8s/docker-desktop/prepare-config.mjs"

if [[ ! -s "${KEY_FILE}" ]]; then
	openssl rand -base64 32 > "${KEY_FILE}"
fi
chmod 600 "${KEY_FILE}" "${CONFIG_FILE}" "${VALUES_FILE}"

docker run --rm --entrypoint node -v "${CONFIG_FILE}:/tmp/leitwerk.yaml:ro" "${SERVER_IMAGE}" \
	--input-type=module -e \
	'import {loadConfig} from "/app/packages/server/dist/index.js"; const result=loadConfig("/tmp/leitwerk.yaml"); if (!result.ok) { console.error(result.error); process.exit(1); }'

kubectl --context "${KUBE_CONTEXT}" create namespace "${SERVER_NAMESPACE}" \
	--dry-run=client -o yaml | kubectl --context "${KUBE_CONTEXT}" apply -f - >/dev/null
kubectl --context "${KUBE_CONTEXT}" label namespace "${SERVER_NAMESPACE}" \
	app.kubernetes.io/name=leitwerk app.kubernetes.io/instance="${HELM_RELEASE}" \
	app.kubernetes.io/managed-by=Helm --overwrite >/dev/null

probe_namespace="${SERVER_NAMESPACE}-image-check"
kubectl --context "${KUBE_CONTEXT}" delete namespace "${probe_namespace}" --ignore-not-found --wait=true >/dev/null
kubectl --context "${KUBE_CONTEXT}" create namespace "${probe_namespace}" >/dev/null
cleanup_probe() { kubectl --context "${KUBE_CONTEXT}" delete namespace "${probe_namespace}" --ignore-not-found --wait=false >/dev/null 2>&1 || true; }
trap cleanup_probe EXIT
for image in "${SERVER_IMAGE}" "${WORKER_IMAGE}"; do
	name="image-check-$(printf '%s' "${image}" | shasum -a 256 | cut -c1-8)"
	kubectl --context "${KUBE_CONTEXT}" -n "${probe_namespace}" run "${name}" \
		--image="${image}" --image-pull-policy=Never --restart=Never \
		--command -- node -e 'process.exit(0)' >/dev/null
	if ! kubectl --context "${KUBE_CONTEXT}" -n "${probe_namespace}" wait \
		--for=jsonpath='{.status.phase}'=Succeeded "pod/${name}" --timeout=90s >/dev/null 2>&1; then
		kubectl --context "${KUBE_CONTEXT}" -n "${probe_namespace}" describe pod "${name}" >&2
		echo "Image ${image} is unavailable to Docker Desktop Kubernetes" >&2
		exit 1
	fi
done
cleanup_probe
trap - EXIT

kubectl --context "${KUBE_CONTEXT}" -n "${SERVER_NAMESPACE}" create secret generic "${CONFIG_SECRET}" \
	--from-file="leitwerk.yaml=${CONFIG_FILE}" --dry-run=client -o yaml \
	| kubectl --context "${KUBE_CONTEXT}" apply -f - >/dev/null
kubectl --context "${KUBE_CONTEXT}" -n "${SERVER_NAMESPACE}" create secret generic "${CREDENTIAL_SECRET}" \
	--from-file="LEITWERK_CREDENTIAL_ENCRYPTION_KEY=${KEY_FILE}" --dry-run=client -o yaml \
	| kubectl --context "${KUBE_CONTEXT}" apply -f - >/dev/null

helm lint "${CHART_DIR}" -f "${VALUES_FILE}"
helm template "${HELM_RELEASE}" "${CHART_DIR}" --kube-context "${KUBE_CONTEXT}" \
	--namespace "${SERVER_NAMESPACE}" -f "${VALUES_FILE}" > "${DEPLOY_ROOT}/rendered/manifests.yaml"
chmod 600 "${DEPLOY_ROOT}/rendered/manifests.yaml"
if grep -Fq "$(cat "${KEY_FILE}")" "${DEPLOY_ROOT}/rendered/manifests.yaml"; then
	echo "Credential encryption key leaked into rendered manifests" >&2
	exit 1
fi

helm upgrade --install "${HELM_RELEASE}" "${CHART_DIR}" \
	--kube-context "${KUBE_CONTEXT}" --namespace "${SERVER_NAMESPACE}" \
	-f "${VALUES_FILE}" --atomic --wait --timeout 10m
kubectl --context "${KUBE_CONTEXT}" -n "${SERVER_NAMESPACE}" rollout restart \
	"deployment/${HELM_RELEASE}-server" >/dev/null
kubectl --context "${KUBE_CONTEXT}" -n "${SERVER_NAMESPACE}" rollout status \
	"deployment/${HELM_RELEASE}-server" --timeout=5m

{
	printf 'revision=%s\nserver_image=%s\nworker_image=%s\nnamespace=%s\nprocess_prefix=%s\n' \
		"${REVISION}" "${SERVER_IMAGE}" "${WORKER_IMAGE}" "${SERVER_NAMESPACE}" "${PROCESS_NAMESPACE_PREFIX}"
	kubectl --context "${KUBE_CONTEXT}" version
	helm version --short
} > "${DEPLOY_ROOT}/deployment-lock.txt"
chmod 600 "${DEPLOY_ROOT}/deployment-lock.txt"

"$(dirname "${BASH_SOURCE[0]}")/port-forward.sh"
kubectl --context "${KUBE_CONTEXT}" -n "${SERVER_NAMESPACE}" get pods,pvc,service

#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
release="${HELM_RELEASE:-leitwerk}"
namespace="${K8S_NAMESPACE:-leitwerk-k8s-test}"
server_image="${SERVER_IMAGE:-leitwerk-server:dev}"
worker_image="${WORKER_GENERIC_IMAGE:-leitwerk-worker-generic:dev}"
specialized_worker_image="${WORKER_SPECIALIZED_IMAGE:-leitwerk-worker-specialized-smoke:dev}"
chart_dir="${repo_root}/deploy/kubernetes/helm/leitwerk"
values_file="${chart_dir}/values-kind.yaml"

command -v helm >/dev/null 2>&1 || { echo "helm is required" >&2; exit 1; }
command -v kubectl >/dev/null 2>&1 || { echo "kubectl is required" >&2; exit 1; }

image_repo() { local image="$1"; echo "${image%:*}"; }
image_tag() { local image="$1"; local tag="${image##*:}"; [[ "${tag}" == "${image}" ]] && echo latest || echo "${tag}"; }

helm upgrade --install "${release}" "${chart_dir}" \
	-f "${values_file}" \
	--namespace "${namespace}" \
	--create-namespace \
	--set namespace.name="${namespace}" \
	--set server.image.repository="$(image_repo "${server_image}")" \
	--set server.image.tag="$(image_tag "${server_image}")" \
	--set workerRuntimeProfiles.generic.image="${worker_image}" \
	--set workerRuntimeProfiles.specialized-smoke.image="${specialized_worker_image}" \
	--wait \
	--timeout 5m

"${repo_root}/scripts/k8s/wait-ready.sh"

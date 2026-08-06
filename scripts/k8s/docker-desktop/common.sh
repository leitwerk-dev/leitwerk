#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
KUBE_CONTEXT="${KUBE_CONTEXT:-docker-desktop}"
[[ "${KUBE_CONTEXT}" == "docker-desktop" ]] || { echo "KUBE_CONTEXT must be docker-desktop" >&2; exit 1; }
REVISION="${LEITWERK_K8S_REVISION:-$(git -C "${repo_root}" rev-parse --short=7 HEAD)}"
[[ "${REVISION}" != "latest" && "${REVISION}" != "dev" ]] || { echo "Use a revision-pinned tag" >&2; exit 1; }
DEPLOY_ID="${LEITWERK_K8S_ID:-leitwerk-k8s-${REVISION}}"
SERVER_NAMESPACE="${LEITWERK_K8S_NAMESPACE:-${DEPLOY_ID}}"
PROCESS_NAMESPACE_PREFIX="${LEITWERK_K8S_PROCESS_PREFIX:-lwk8s-${REVISION}-p-}"
HELM_RELEASE="${LEITWERK_K8S_RELEASE:-leitwerk}"
DEPLOY_ROOT="${LEITWERK_K8S_ROOT:-${HOME}/.local/share/leitwerk/deployments/${DEPLOY_ID}}"
LEITWERK_PORT="${LEITWERK_K8S_PORT:-18081}"
SERVER_IMAGE="${SERVER_IMAGE:-leitwerk-server:${REVISION}}"
WORKER_IMAGE="${WORKER_GENERIC_IMAGE:-leitwerk-worker-generic:${REVISION}}"
CONFIG_SECRET="${LEITWERK_K8S_CONFIG_SECRET:-leitwerk-runtime-config}"
CREDENTIAL_SECRET="${LEITWERK_K8S_CREDENTIAL_SECRET:-leitwerk-credential-key}"
SOURCE_CONFIG="${LEITWERK_K8S_SOURCE_CONFIG:-${repo_root}/leitwerk.yaml}"
CHART_DIR="${repo_root}/deploy/kubernetes/helm/leitwerk"
CONFIG_FILE="${DEPLOY_ROOT}/config/leitwerk.yaml"
VALUES_FILE="${DEPLOY_ROOT}/config/values.yaml"
KEY_FILE="${DEPLOY_ROOT}/secrets/credential-encryption-key"
PORT_FORWARD_PID_FILE="${DEPLOY_ROOT}/port-forward.pid"
PORT_FORWARD_LOG="${DEPLOY_ROOT}/logs/port-forward.log"

export KUBE_CONTEXT REVISION DEPLOY_ID SERVER_NAMESPACE PROCESS_NAMESPACE_PREFIX HELM_RELEASE
export DEPLOY_ROOT LEITWERK_PORT SERVER_IMAGE WORKER_IMAGE CONFIG_SECRET CREDENTIAL_SECRET
export SOURCE_CONFIG CONFIG_FILE VALUES_FILE

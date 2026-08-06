#!/usr/bin/env bash
set -euo pipefail

release="${HELM_RELEASE:-leitwerk}"
namespace="${K8S_NAMESPACE:-leitwerk-k8s-test}"

command -v kubectl >/dev/null 2>&1 || { echo "kubectl is required" >&2; exit 1; }

deployment="$(kubectl -n "${namespace}" get deployment \
	-l "app.kubernetes.io/instance=${release},app.kubernetes.io/component=server" \
	-o jsonpath='{.items[0].metadata.name}')"

if [[ -z "${deployment}" ]]; then
	echo "No leitwerk server deployment found for release '${release}' in namespace '${namespace}'" >&2
	exit 1
fi

kubectl -n "${namespace}" rollout status deployment/"${deployment}" --timeout=5m
kubectl -n "${namespace}" wait --for=condition=Available deployment/"${deployment}" --timeout=5m

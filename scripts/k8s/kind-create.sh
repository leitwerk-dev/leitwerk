#!/usr/bin/env bash
set -euo pipefail

cluster_name="${KIND_CLUSTER_NAME:-leitwerk}"

command -v kind >/dev/null 2>&1 || { echo "kind is required" >&2; exit 1; }
command -v kubectl >/dev/null 2>&1 || { echo "kubectl is required" >&2; exit 1; }

if kind get clusters | grep -Fxq "${cluster_name}"; then
	echo "Kind cluster '${cluster_name}' already exists"
else
	kind create cluster --name "${cluster_name}"
fi

kubectl cluster-info --context "kind-${cluster_name}"

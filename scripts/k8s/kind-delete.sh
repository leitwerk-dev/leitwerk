#!/usr/bin/env bash
set -euo pipefail

cluster_name="${KIND_CLUSTER_NAME:-leitwerk}"

command -v kind >/dev/null 2>&1 || { echo "kind is required" >&2; exit 1; }

kind delete cluster --name "${cluster_name}"

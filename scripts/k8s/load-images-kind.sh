#!/usr/bin/env bash
set -euo pipefail

cluster_name="${KIND_CLUSTER_NAME:-leitwerk}"
server_image="${SERVER_IMAGE:-leitwerk-server:dev}"
worker_image="${WORKER_GENERIC_IMAGE:-leitwerk-worker-generic:dev}"
specialized_worker_image="${WORKER_SPECIALIZED_IMAGE:-leitwerk-worker-specialized-smoke:dev}"

command -v kind >/dev/null 2>&1 || { echo "kind is required" >&2; exit 1; }

kind load docker-image --name "${cluster_name}" "${server_image}" "${worker_image}" "${specialized_worker_image}"

echo "Loaded ${server_image}, ${worker_image}, and ${specialized_worker_image} into Kind cluster ${cluster_name}"

#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
server_image="${SERVER_IMAGE:-leitwerk-server:dev}"
worker_image="${WORKER_GENERIC_IMAGE:-leitwerk-worker-generic:dev}"
specialized_worker_image="${WORKER_SPECIALIZED_IMAGE:-leitwerk-worker-specialized-smoke:dev}"

command -v docker >/dev/null 2>&1 || { echo "docker is required" >&2; exit 1; }

cd "${repo_root}"

docker build -f deploy/images/Dockerfile.server -t "${server_image}" .
docker build -f deploy/images/Dockerfile.worker-generic -t "${worker_image}" .
docker build \
	-f deploy/kubernetes/Dockerfile.worker-specialized-smoke \
	--build-arg "WORKER_GENERIC_IMAGE=${worker_image}" \
	-t "${specialized_worker_image}" \
	.

echo "Built ${server_image}, ${worker_image}, and ${specialized_worker_image}"

#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

docker build -f "${repo_root}/deploy/images/Dockerfile.server" -t "${SERVER_IMAGE}" "${repo_root}"
docker build -f "${repo_root}/deploy/images/Dockerfile.worker-generic" -t "${WORKER_IMAGE}" "${repo_root}"

mkdir -p "${DEPLOY_ROOT}"
docker image inspect "${SERVER_IMAGE}" "${WORKER_IMAGE}" \
	--format '{{json .RepoTags}} {{.Id}}' > "${DEPLOY_ROOT}/image-lock.txt"
chmod 600 "${DEPLOY_ROOT}/image-lock.txt"

docker run --rm --entrypoint sh "${SERVER_IMAGE}" -c \
	'test -f /app/packages/ui/dist/index.html && test -d /app/extensions/showcase-processes'
docker run --rm --entrypoint sh "${WORKER_IMAGE}" -c 'test -d /app/extensions/showcase-processes'

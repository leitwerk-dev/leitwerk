#!/usr/bin/env bash
set -euo pipefail

REVISION="${LEITWERK_DOCKER_REVISION:-6f309e4}"
DEPLOY_ID="${LEITWERK_DOCKER_ID:-leitwerk-local-${REVISION}}"
DEPLOY_ROOT="${LEITWERK_DOCKER_ROOT:-${HOME}/.local/share/leitwerk/deployments/${DEPLOY_ID}}"
SERVER_IMAGE="leitwerk-server:${REVISION}"
WORKER_IMAGE="leitwerk-worker-generic:${REVISION}"
URL="${LEITWERK_DOCKER_URL:-http://127.0.0.1:18080}"

usage() {
	cat <<EOF
Usage: ./deploy-docker.sh

Starts the local Docker deployment at ${URL}.
Environment overrides:
  LEITWERK_DOCKER_REVISION  Image revision tag (default: ${REVISION})
  LEITWERK_DOCKER_ID        Compose/deployment id (default: ${DEPLOY_ID})
  LEITWERK_DOCKER_ROOT      Deployment directory (default: ${DEPLOY_ROOT})
  LEITWERK_DOCKER_URL       Health/UI URL (default: ${URL})
EOF
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
	usage
	exit 0
fi
if [[ $# -ne 0 ]]; then
	usage >&2
	exit 2
fi

command -v docker >/dev/null 2>&1 || { echo "docker is required" >&2; exit 1; }
command -v curl >/dev/null 2>&1 || { echo "curl is required" >&2; exit 1; }
docker compose version >/dev/null

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
compose_file="${DEPLOY_ROOT}/compose.yaml"
[[ -f "${compose_file}" ]] || {
	echo "Deployment configuration is missing: ${compose_file}" >&2
	echo "Create it using docs/docker-deployment-guide.md first." >&2
	exit 1
}

answer=""
read -r -p "Rebuild ${SERVER_IMAGE} and ${WORKER_IMAGE}? [y/N] " answer
case "${answer}" in
	y|Y|yes|YES)
		cd "${repo_root}"
		docker build -f deploy/images/Dockerfile.server -t "${SERVER_IMAGE}" .
		docker build -f deploy/images/Dockerfile.worker-generic -t "${WORKER_IMAGE}" .

		rm -rf "${DEPLOY_ROOT}/ui"
		mkdir -p "${DEPLOY_ROOT}/ui"
		ui_source="$(docker create "${SERVER_IMAGE}")"
		cleanup_ui_source() { docker rm -f "${ui_source}" >/dev/null 2>&1 || true; }
		trap cleanup_ui_source EXIT
		docker cp "${ui_source}:/app/packages/ui/dist/." "${DEPLOY_ROOT}/ui/"
		cleanup_ui_source
		trap - EXIT
		test -f "${DEPLOY_ROOT}/ui/index.html"

		docker image inspect "${SERVER_IMAGE}" "${WORKER_IMAGE}" \
			--format '{{json .RepoTags}} {{.Id}}' > "${DEPLOY_ROOT}/image-lock.txt"
		;;
	*)
		docker image inspect "${SERVER_IMAGE}" "${WORKER_IMAGE}" >/dev/null
		test -f "${DEPLOY_ROOT}/ui/index.html" || {
			echo "Built UI is missing under ${DEPLOY_ROOT}/ui; rerun and choose rebuild." >&2
			exit 1
		}
		;;
esac

cd "${DEPLOY_ROOT}"
docker compose config --quiet
docker compose up -d

for _ in $(seq 1 60); do
	if curl -fsS "${URL}/api/health" >/dev/null && curl -fsS "${URL}/" | grep -q '<div id="app">'; then
		docker compose ps
		echo
		echo "Leitwerk UI: ${URL}"
		exit 0
	fi
	sleep 1
done

echo "Deployment did not become ready" >&2
docker compose logs --tail=200 >&2
exit 1

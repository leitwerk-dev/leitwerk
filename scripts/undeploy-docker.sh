#!/usr/bin/env bash
set -euo pipefail

REVISION="${LEITWERK_DOCKER_REVISION:-6f309e4}"
DEPLOY_ID="${LEITWERK_DOCKER_ID:-leitwerk-local-${REVISION}}"
DEPLOY_ROOT="${LEITWERK_DOCKER_ROOT:-${HOME}/.local/share/leitwerk/deployments/${DEPLOY_ID}}"
SERVER_IMAGE="leitwerk-server:${REVISION}"
WORKER_IMAGE="leitwerk-worker-generic:${REVISION}"
SERVER_VOLUME="${DEPLOY_ID}-server-state"

usage() {
	cat <<EOF
Usage: ./undeploy-docker.sh

Stops and removes the local Compose containers, network, and disposable worker
containers. Durable volumes, images, configuration, secrets, and backups are
retained unless you explicitly confirm the purge prompt.
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
compose_file="${DEPLOY_ROOT}/compose.yaml"
[[ -f "${compose_file}" ]] || { echo "Deployment configuration is missing: ${compose_file}" >&2; exit 1; }

answer=""
read -r -p "Undeploy ${DEPLOY_ID}? [y/N] " answer
case "${answer}" in
	y|Y|yes|YES) ;;
	*) echo "Cancelled"; exit 0 ;;
esac

cd "${DEPLOY_ROOT}"
docker compose down --remove-orphans

# Worker labels are not installation-scoped. The supported local topology has
# only one Docker-backed Leitwerk server per daemon, so all managed workers are
# disposable units belonging to this deployment.
worker_ids="$(docker ps -aq --filter label=leitwerk.dev/managed-by=leitwerk --filter label=leitwerk.dev/component=worker)"
if [[ -n "${worker_ids}" ]]; then
	# shellcheck disable=SC2086
	docker rm -f ${worker_ids}
fi

echo "Runtime containers and network removed. Durable data is retained."

purge=""
read -r -p "Also delete server/process volumes and revision-tagged images? Type DELETE to confirm: " purge
if [[ "${purge}" == "DELETE" ]]; then
	docker volume rm "${SERVER_VOLUME}" >/dev/null 2>&1 || true
	process_volumes="$(docker volume ls -q --filter name='^leitwerk-process-')"
	if [[ -n "${process_volumes}" ]]; then
		# shellcheck disable=SC2086
		docker volume rm ${process_volumes}
	fi
	docker image rm "${SERVER_IMAGE}" "${WORKER_IMAGE}" >/dev/null 2>&1 || true
	echo "Durable Docker volumes and revision-tagged images removed."
	echo "Configuration, encryption key, and backups remain in ${DEPLOY_ROOT}."
else
	echo "Kept ${SERVER_VOLUME}, process volumes, images, configuration, key, and backups."
fi

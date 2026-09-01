#!/usr/bin/env bash
set -euo pipefail

: "${LEITWERK_WORKER_IMAGE:?Set LEITWERK_WORKER_IMAGE to the candidate worker image}"
isolation="${LEITWERK_DOCKER_ISOLATION:-privileged}"
case "$isolation" in
  privileged) isolation_args=(--privileged) ;;
  sysbox-runc) isolation_args=(--runtime sysbox-runc) ;;
  *) echo "LEITWERK_DOCKER_ISOLATION must be privileged or sysbox-runc" >&2; exit 1 ;;
esac

state_volume="${LEITWERK_DOCKER_STATE_VOLUME:-leitwerk-docker-canary-$$}"
container="leitwerk-docker-canary-$$"
server="leitwerk-docker-canary-server-$$"
network="leitwerk-docker-canary-$$"
tag="leitwerk-nested-canary:latest"
cleanup() {
  docker rm -f "$container" "$server" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
  if [[ -z "${LEITWERK_DOCKER_STATE_VOLUME:-}" ]]; then
    docker volume rm -f "$state_volume" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

docker network create "$network" >/dev/null
docker run -d --name "$server" --network "$network" \
  --entrypoint node "$LEITWERK_WORKER_IMAGE" --input-type=module -e \
  'import { WebSocketServer } from "ws"; const server = new WebSocketServer({ port: 8080 }); server.on("connection", socket => socket.on("message", () => {}));' \
  >/dev/null

start_outer() {
  docker run -d --name "$container" --network "$network" "${isolation_args[@]}" \
    -v "$state_volume:/state" \
    -e LEITWERK_PRIVATE_DOCKER=1 \
    -e LEITWERK_PROCESS_VOLUME_MOUNT_PATH=/state \
    -e LEITWERK_WORKER_STARTUP_TIMEOUT_MS=120000 \
    -e LEITWERK_INSTANCE_ID=docker-canary \
    -e LEITWERK_WORKER_ID=docker-canary-worker \
    -e LEITWERK_SERVER_URL="ws://$server:8080" \
    -e LEITWERK_WORKER_CONNECT_TOKEN=docker-canary-connect-token \
    -e LEITWERK_WORKER_RECONNECT=1 \
    -e LEITWERK_SERVER_EPOCH=docker-canary \
    "$LEITWERK_WORKER_IMAGE" >/dev/null
  for _ in $(seq 1 120); do
    docker exec "$container" docker info >/dev/null 2>&1 && return
    if ! docker inspect -f '{{.State.Running}}' "$container" 2>/dev/null | grep -qx true; then
      docker logs --tail 200 "$container" >&2 || true
      echo "Worker image exited before its private Docker daemon became ready" >&2
      exit 1
    fi
    sleep 1
  done
  docker logs --tail 200 "$container" >&2 || true
  echo "Inner Docker daemon did not become ready" >&2
  exit 1
}

start_outer
docker exec "$container" sh -ceu 'docker version; dockerd --version'
printf 'FROM alpine:3.21\nCMD ["sh", "-c", "test nested = nested"]\n' \
  | docker exec -i "$container" docker build -q -t "$tag" - >/dev/null
docker exec "$container" docker run --rm --pull=never "$tag"
docker rm -f "$container" >/dev/null
start_outer
docker exec "$container" docker run --rm --pull=never "$tag"
echo "Docker runner canary passed with $isolation isolation, the trusted image entrypoint, and retained state $state_volume"

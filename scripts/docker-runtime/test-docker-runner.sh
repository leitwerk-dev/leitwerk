#!/usr/bin/env bash
set -euo pipefail

: "${LEITWERK_WORKER_IMAGE:?Set LEITWERK_WORKER_IMAGE to the candidate worker image}"
isolation="${LEITWERK_DOCKER_ISOLATION:-privileged}"
case "$isolation" in
  privileged) isolation_args=(--privileged) ;;
  sysbox-runc) isolation_args=(--runtime sysbox-runc) ;;
  *) echo "LEITWERK_DOCKER_ISOLATION must be privileged or sysbox-runc" >&2; exit 1 ;;
esac

state_volume="${LEITWERK_DOCKER_STATE_VOLUME:-}"
container="leitwerk-docker-canary-$$"
server="leitwerk-docker-canary-server-$$"
network="leitwerk-docker-canary-$$"
tag="leitwerk-nested-canary:latest"
worker_container_id=""
server_container_id=""
network_id=""
owned_state_volume=""
cleanup() {
  if [[ -n "$worker_container_id" ]]; then
    docker rm -f "$worker_container_id" >/dev/null 2>&1 || true
  fi
  if [[ -n "$server_container_id" ]]; then
    docker rm -f "$server_container_id" >/dev/null 2>&1 || true
  fi
  if [[ -n "$network_id" ]]; then
    docker network rm "$network_id" >/dev/null 2>&1 || true
  fi
  if [[ -n "$owned_state_volume" ]]; then
    docker volume rm -f "$owned_state_volume" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

network_id="$(docker network create "$network")"
server_container_id="$(docker create --name "$server" --network "$network_id" \
  --entrypoint node "$LEITWERK_WORKER_IMAGE" --input-type=module -e \
  'import { WebSocketServer } from "ws"; const server = new WebSocketServer({ port: 8080 }); server.on("connection", socket => socket.on("message", () => {}));')"
docker start "$server_container_id" >/dev/null
if [[ -z "$state_volume" ]]; then
  owned_state_volume="$(docker volume create)"
  state_volume="$owned_state_volume"
fi

start_outer() {
  worker_container_id="$(docker create --name "$container" --network "$network_id" "${isolation_args[@]}" \
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
    "$LEITWERK_WORKER_IMAGE")"
  docker start "$worker_container_id" >/dev/null
  for _ in $(seq 1 120); do
    if docker exec "$worker_container_id" docker info >/dev/null 2>&1; then
      driver="$(docker exec "$worker_container_id" docker info --format '{{.Driver}}')"
      if [[ "$driver" != overlay2 ]]; then
        echo "Private Docker daemon must use overlay2; got $driver" >&2
        exit 1
      fi
      return
    fi
    if ! docker inspect -f '{{.State.Running}}' "$worker_container_id" 2>/dev/null | grep -qx true; then
      docker logs --tail 200 "$worker_container_id" >&2 || true
      echo "Worker image exited before its private Docker daemon became ready" >&2
      exit 1
    fi
    sleep 1
  done
  docker logs --tail 200 "$worker_container_id" >&2 || true
  echo "Inner Docker daemon did not become ready" >&2
  exit 1
}

start_outer
docker exec "$worker_container_id" sh -ceu 'docker version; dockerd --version'
printf 'FROM alpine:3.21\nCMD ["sh", "-c", "test nested = nested"]\n' \
  | docker exec -i "$worker_container_id" docker build -q -t "$tag" - >/dev/null
docker exec "$worker_container_id" docker run --rm --pull=never "$tag"
docker rm -f "$worker_container_id" >/dev/null
worker_container_id=""
start_outer
docker exec "$worker_container_id" docker run --rm --pull=never "$tag"
echo "Docker runner canary passed with $isolation isolation, the trusted image entrypoint, and retained state $state_volume"

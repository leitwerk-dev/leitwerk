#!/usr/bin/env bash
set -euo pipefail

: "${LEITWERK_WORKER_IMAGE:?Set LEITWERK_WORKER_IMAGE to the candidate worker image}"
: "${LEITWERK_RUNTIME_CLASS_NAME:?Set LEITWERK_RUNTIME_CLASS_NAME to the prepared runtime class}"
: "${LEITWERK_DOCKER_STORAGE_CLASS_NAME:?Set LEITWERK_DOCKER_STORAGE_CLASS_NAME to the Docker-compatible storage class}"
namespace="${LEITWERK_DOCKER_TEST_NAMESPACE:-leitwerk-docker-canary-$$}"
pod="docker-canary"
pvc="docker-state"
tag="leitwerk-nested-canary:latest"
cleanup() { kubectl delete namespace "$namespace" --wait=true --ignore-not-found >/dev/null 2>&1 || true; }
trap cleanup EXIT

kubectl create namespace "$namespace" >/dev/null
cat <<EOF | kubectl -n "$namespace" apply -f - >/dev/null
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: $pvc
spec:
  accessModes: [ReadWriteOnce]
  storageClassName: $LEITWERK_DOCKER_STORAGE_CLASS_NAME
  resources:
    requests:
      storage: 20Gi
EOF

start_pod() {
  cat <<EOF | kubectl -n "$namespace" apply -f - >/dev/null
apiVersion: v1
kind: Pod
metadata:
  name: $pod
spec:
  runtimeClassName: $LEITWERK_RUNTIME_CLASS_NAME
  hostUsers: false
  restartPolicy: Never
  containers:
    - name: worker
      image: $LEITWERK_WORKER_IMAGE
      imagePullPolicy: IfNotPresent
      env:
        - {name: LEITWERK_PRIVATE_DOCKER, value: "1"}
        - {name: DOCKER_HOST, value: "unix:///var/run/docker.sock"}
        - {name: LEITWERK_WORKER_STARTUP_TIMEOUT_MS, value: "120000"}
        - {name: LEITWERK_INSTANCE_ID, value: "kubernetes-canary"}
        - {name: LEITWERK_WORKER_ID, value: "kubernetes-canary-worker"}
        - {name: LEITWERK_SERVER_URL, value: "ws://127.0.0.1:8080"}
        - {name: LEITWERK_WORKER_CONNECT_TOKEN, value: "kubernetes-canary-connect-token"}
        - {name: LEITWERK_WORKER_RECONNECT, value: "1"}
        - {name: LEITWERK_SERVER_EPOCH, value: "kubernetes-canary"}
      volumeMounts:
        - name: process-state
          mountPath: /state
    - name: fake-server
      image: $LEITWERK_WORKER_IMAGE
      imagePullPolicy: IfNotPresent
      command: [node, --input-type=module, -e]
      args:
        - 'import { WebSocketServer } from "ws"; const server = new WebSocketServer({ port: 8080 }); server.on("connection", socket => socket.on("message", () => {}));'
  volumes:
    - name: process-state
      persistentVolumeClaim:
        claimName: $pvc
EOF
  kubectl -n "$namespace" wait --for=condition=Ready "pod/$pod" --timeout=5m >/dev/null
  for _ in $(seq 1 120); do
    kubectl -n "$namespace" exec "$pod" -c worker -- docker info >/dev/null 2>&1 && return
    worker_exit="$(kubectl -n "$namespace" get pod "$pod" -o jsonpath='{.status.containerStatuses[?(@.name=="worker")].state.terminated.reason}')"
    if [[ -n "$worker_exit" ]]; then
      kubectl -n "$namespace" logs --tail=200 "$pod" -c worker >&2 || true
      echo "Worker image exited before its private Docker daemon became ready: $worker_exit" >&2
      exit 1
    fi
    sleep 1
  done
  kubectl -n "$namespace" logs --tail=200 "$pod" -c worker >&2 || true
  echo "Inner Docker daemon did not become ready" >&2
  exit 1
}

start_pod
# The command expands inside the Pod.
# shellcheck disable=SC2016
kubectl -n "$namespace" exec "$pod" -c worker -- sh -ceu 'docker version; dockerd --version; test "$(docker info --format "{{.Driver}}")" = overlay2'
printf 'FROM alpine:3.21\nRUN apk add --no-cache bind-tools >/dev/null\nCMD ["sh", "-c", "nslookup example.com >/dev/null"]\n' \
  | kubectl -n "$namespace" exec -i "$pod" -c worker -- docker build -q -t "$tag" - >/dev/null
kubectl -n "$namespace" exec "$pod" -c worker -- docker run --rm --pull=never "$tag"
pod_json="$(kubectl -n "$namespace" get pod "$pod" -o json)"
printf '%s' "$pod_json" | jq -e --arg runtime "$LEITWERK_RUNTIME_CLASS_NAME" '
  .spec.runtimeClassName == $runtime and
  .spec.hostUsers == false and
  ([.spec.containers[] | .securityContext.privileged // false] | any) == false and
  ([.spec.volumes[] | has("hostPath")] | any) == false
' >/dev/null
kubectl -n "$namespace" delete pod "$pod" --wait=true >/dev/null
start_pod
kubectl -n "$namespace" exec "$pod" -c worker -- docker run --rm --pull=never "$tag"
echo "Kubernetes Docker runtime canary passed with the trusted image entrypoint in $namespace"

#!/usr/bin/env bash
set -euo pipefail
umask 077

script_dir="$(cd -- "${BASH_SOURCE[0]%/*}" && pwd)"

: "${LEITWERK_WORKER_IMAGE:?Set LEITWERK_WORKER_IMAGE to the candidate worker image}"
: "${LEITWERK_RUNTIME_CLASS_NAME:?Set LEITWERK_RUNTIME_CLASS_NAME to the prepared runtime class}"
: "${LEITWERK_DOCKER_STORAGE_CLASS_NAME:?Set LEITWERK_DOCKER_STORAGE_CLASS_NAME to the Docker-compatible storage class}"
namespace="${LEITWERK_DOCKER_TEST_NAMESPACE:-leitwerk-docker-canary-$$}"
pod="docker-canary"
pvc="docker-state"
tag="leitwerk-nested-canary:latest"
evidence_dir=""
temporary_evidence=false
cleanup() {
  kubectl delete namespace "$namespace" --wait=true --ignore-not-found >/dev/null 2>&1 || true
  if [[ "$temporary_evidence" == true && -n "$evidence_dir" ]]; then rm -rf -- "$evidence_dir"; fi
}

kubectl create namespace "$namespace" >/dev/null
trap cleanup EXIT
if [[ -n "${LEITWERK_DOCKER_EVIDENCE_DIR:-}" ]]; then
  evidence_dir="$LEITWERK_DOCKER_EVIDENCE_DIR"
  mkdir -- "$evidence_dir"
else
  evidence_dir="$(mktemp -d)"
  temporary_evidence=true
fi
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
    if kubectl -n "$namespace" exec "$pod" -c worker -- docker info >/dev/null 2>&1; then
      driver="$(kubectl -n "$namespace" exec "$pod" -c worker -- docker info --format '{{.Driver}}')"
      if [[ "$driver" != overlay2 ]]; then
        echo "Private Docker daemon must use overlay2; got $driver" >&2
        exit 1
      fi
      return
    fi
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

capture_worker() {
  local phase="$1"
  local snapshot="$evidence_dir/$phase"
  local pv_name
  mkdir -- "$snapshot"
  kubectl -n "$namespace" get pod "$pod" -o json > "$snapshot/pod.json"
  kubectl -n "$namespace" get pvc "$pvc" -o json > "$snapshot/pvc.json"
  pv_name="$(kubectl -n "$namespace" get pvc "$pvc" -o jsonpath='{.spec.volumeName}')"
  kubectl get pv "$pv_name" -o json > "$snapshot/pv.json"
  kubectl -n "$namespace" exec "$pod" -c worker -- docker info --format '{{json .}}' > "$snapshot/docker-info.json"
  kubectl -n "$namespace" exec "$pod" -c worker -- docker image inspect "$tag" --format '{{.Id}}' > "$snapshot/inner-image-id.txt"
  kubectl -n "$namespace" exec "$pod" -c worker -- cat /state/workspace/.docker-runtime-proof > "$snapshot/workspace-marker.txt"
  kubectl -n "$namespace" exec "$pod" -c worker -- node --input-type=module -e '
    import fs from "node:fs";
    const ports = []; let observed = false;
    for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
      if (!fs.existsSync(file)) continue;
      observed = true;
      for (const line of fs.readFileSync(file, "utf8").trim().split("\n").slice(1)) {
        const fields = line.trim().split(/\s+/);
        if (fields[3] === "0A") ports.push(parseInt(fields[1].split(":")[1], 16));
      }
    }
    if (!observed) throw new Error("TCP listener evidence is unavailable");
    console.log(JSON.stringify(ports));
  ' > "$snapshot/listeners.json"
}

start_pod
kubectl -n "$namespace" exec "$pod" -c worker -- sh -ceu 'docker version; dockerd --version'
printf 'FROM alpine:3.21\nRUN apk add --no-cache bind-tools >/dev/null\nCMD ["sh", "-c", "nslookup example.com >/dev/null"]\n' \
  | kubectl -n "$namespace" exec -i "$pod" -c worker -- docker build -q -t "$tag" - >/dev/null
kubectl -n "$namespace" exec "$pod" -c worker -- docker run --rm --pull=never "$tag"
kubectl -n "$namespace" exec "$pod" -c worker -- node --input-type=module -e 'import fs from "node:fs"; import { randomUUID } from "node:crypto"; fs.mkdirSync("/state/workspace", { recursive: true }); fs.writeFileSync("/state/workspace/.docker-runtime-proof", randomUUID());'
capture_worker before
node "$script_dir/verify-kubernetes.ts" "$evidence_dir/before"
kubectl -n "$namespace" delete pod "$pod" --wait=true --timeout=120s >/dev/null
kubectl -n "$namespace" wait --for=delete "pod/$pod" --timeout=60s >/dev/null
node -e 'console.log(new Date().toISOString())' > "$evidence_dir/previous-pod-deleted-at.txt"
start_pod
kubectl -n "$namespace" exec "$pod" -c worker -- docker run --rm --pull=never "$tag"
capture_worker after
node "$script_dir/verify-kubernetes.ts" "$evidence_dir/after" "$evidence_dir/before/evidence.json" "$evidence_dir/previous-pod-deleted-at.txt"
echo "Kubernetes Docker runtime canary passed with the trusted image entrypoint in $namespace"
if [[ "$temporary_evidence" == false ]]; then echo "Docker worker evidence: $evidence_dir"; fi

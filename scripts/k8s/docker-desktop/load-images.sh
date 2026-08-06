#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

node_count="$(kubectl --context "${KUBE_CONTEXT}" get nodes --no-headers | wc -l | tr -d ' ')"
[[ "${node_count}" == "1" ]] || { echo "Docker Desktop image loader requires exactly one local node" >&2; exit 1; }
loader_namespace="${SERVER_NAMESPACE}-image-loader"
loader_pod=image-loader
cleanup() {
	kubectl --context "${KUBE_CONTEXT}" delete namespace "${loader_namespace}" \
		--ignore-not-found --wait=false >/dev/null 2>&1 || true
}
trap cleanup EXIT
kubectl --context "${KUBE_CONTEXT}" delete namespace "${loader_namespace}" \
	--ignore-not-found --wait=true >/dev/null
kubectl --context "${KUBE_CONTEXT}" create namespace "${loader_namespace}" >/dev/null
cat <<EOF | kubectl --context "${KUBE_CONTEXT}" apply -f - >/dev/null
apiVersion: v1
kind: Pod
metadata:
  name: ${loader_pod}
  namespace: ${loader_namespace}
spec:
  restartPolicy: Never
  containers:
    - name: loader
      image: alpine:3.22
      command: ["sleep", "600"]
      securityContext:
        privileged: true
      volumeMounts:
        - name: host
          mountPath: /host
  volumes:
    - name: host
      hostPath:
        path: /
EOF
kubectl --context "${KUBE_CONTEXT}" -n "${loader_namespace}" wait \
	--for=condition=Ready "pod/${loader_pod}" --timeout=2m >/dev/null
for image in "${SERVER_IMAGE}" "${WORKER_IMAGE}"; do
	docker save "${image}" | kubectl --context "${KUBE_CONTEXT}" -n "${loader_namespace}" \
		exec -i "${loader_pod}" -- chroot /host ctr -n k8s.io images import -
done
cleanup
trap - EXIT

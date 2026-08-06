#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
command -v shasum >/dev/null || { echo "shasum is required" >&2; exit 1; }
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup_dir="${DEPLOY_ROOT}/backups/${timestamp}"
mkdir -p "${backup_dir}"
chmod 700 "${backup_dir}"
server_deployment="${HELM_RELEASE}-server"

cleanup_pod() {
	local namespace="$1"
	kubectl --context "${KUBE_CONTEXT}" -n "${namespace}" delete pod leitwerk-backup \
		--ignore-not-found --wait=false >/dev/null 2>&1 || true
}
archive_pvc() {
	local namespace="$1" pvc="$2" output="$3"
	cleanup_pod "${namespace}"
	cat <<EOF | kubectl --context "${KUBE_CONTEXT}" apply -f - >/dev/null
apiVersion: v1
kind: Pod
metadata:
  name: leitwerk-backup
  namespace: ${namespace}
spec:
  restartPolicy: Never
  containers:
    - name: backup
      image: alpine:3.22
      command: ["sleep", "600"]
      volumeMounts:
        - name: state
          mountPath: /state
          readOnly: true
  volumes:
    - name: state
      persistentVolumeClaim:
        claimName: ${pvc}
        readOnly: true
EOF
	kubectl --context "${KUBE_CONTEXT}" -n "${namespace}" wait \
		--for=condition=Ready pod/leitwerk-backup --timeout=2m >/dev/null
	kubectl --context "${KUBE_CONTEXT}" -n "${namespace}" exec leitwerk-backup -- \
		tar -czf - -C /state . > "${output}"
	cleanup_pod "${namespace}"
}

"$(dirname "${BASH_SOURCE[0]}")/stop-port-forward.sh"
kubectl --context "${KUBE_CONTEXT}" -n "${SERVER_NAMESPACE}" scale \
	"deployment/${server_deployment}" --replicas=0 >/dev/null
kubectl --context "${KUBE_CONTEXT}" -n "${SERVER_NAMESPACE}" wait --for=delete \
	pod -l app.kubernetes.io/component=server --timeout=2m >/dev/null

process_namespaces="$(kubectl --context "${KUBE_CONTEXT}" get namespaces \
	-l 'leitwerk.dev/managed-by=leitwerk,leitwerk.dev/component=process-namespace' \
	-o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}' | grep "^${PROCESS_NAMESPACE_PREFIX}" || true)"
while IFS= read -r namespace; do
	[[ -n "${namespace}" ]] || continue
	kubectl --context "${KUBE_CONTEXT}" -n "${namespace}" delete pod \
		-l leitwerk.dev/component=worker --ignore-not-found --wait=true >/dev/null
	pvc="$(kubectl --context "${KUBE_CONTEXT}" -n "${namespace}" get pvc \
		-l leitwerk.dev/component=process-volume -o jsonpath='{.items[0].metadata.name}')"
	[[ -n "${pvc}" ]] && archive_pvc "${namespace}" "${pvc}" "${backup_dir}/${namespace}.tar.gz"
done <<< "${process_namespaces}"
archive_pvc "${SERVER_NAMESPACE}" "${HELM_RELEASE}-server" "${backup_dir}/server-state.tar.gz"
cp "${CONFIG_FILE}" "${VALUES_FILE}" "${KEY_FILE}" "${DEPLOY_ROOT}/deployment-lock.txt" "${backup_dir}/"
chmod 600 "${backup_dir}"/*
(cd "${backup_dir}" && shasum -a 256 ./* > SHA256SUMS)

kubectl --context "${KUBE_CONTEXT}" -n "${SERVER_NAMESPACE}" scale \
	"deployment/${server_deployment}" --replicas=1 >/dev/null
kubectl --context "${KUBE_CONTEXT}" -n "${SERVER_NAMESPACE}" rollout status \
	"deployment/${server_deployment}" --timeout=5m
"$(dirname "${BASH_SOURCE[0]}")/port-forward.sh"
echo "Backup: ${backup_dir}"

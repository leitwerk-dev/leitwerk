# Kubernetes deployment

The Helm chart deploys a singleton server (`Recreate`), Service, RBAC, `ValidatingAdmissionPolicy`, and an optional Caddy gateway that extracts and serves the SPA from the server image. This deployment provisions the server PVC separately from the Helm release so the same claim is available to upgrade preflight. Each process receives its own namespace, worker Pod, and retained PVC created dynamically by the server.

Use a trusted cluster for this walkthrough. Port forwarding gives you a local browser address. With authentication disabled, other workloads that can reach the Service can also access Leitwerk. Configure HTTPS, `server.base_url`, and [Security](security.md) before exposing the service.

## Prerequisites

- A Kubernetes cluster supporting `admissionregistration.k8s.io/v1` `ValidatingAdmissionPolicy`, with permissions to install cluster-scoped RBAC and admission rules.
- Helm, `kubectl`, OpenSSL, and a dynamic filesystem StorageClass.
- Network access to container registries and model providers. Export the example provider's `OPENAI_API_KEY` before creating its Secret.

The server requires cluster-scoped permissions to manage process namespaces and worker resources. Pull-secret access is restricted to explicitly named Secrets in the server namespace; the server cannot list Secrets cluster-wide.

## Prepare configuration and Secrets

Copy the [server configuration](../examples/kubernetes/leitwerk.example.yaml), [Helm values](../examples/kubernetes/values.yaml), and [server PVC manifest](../examples/kubernetes/server-pvc.yaml) outside the checkout.

```sh
export DEPLOY_ROOT="$HOME/.local/share/leitwerk/deployments/leitwerk-kubernetes"
mkdir -p "$DEPLOY_ROOT"
cp docs/examples/kubernetes/leitwerk.example.yaml "$DEPLOY_ROOT/leitwerk.yaml"
cp docs/examples/kubernetes/values.yaml "$DEPLOY_ROOT/values.yaml"
cp docs/examples/kubernetes/server-pvc.yaml "$DEPLOY_ROOT/server-pvc.yaml"
chmod 600 "$DEPLOY_ROOT/leitwerk.yaml"
```

Replace `VERSION` in `$DEPLOY_ROOT/leitwerk.yaml` (`worker_runtime_profiles.generic.image`) with the release chart version or its published immutable digest. Release charts pin default images, but `server.existingConfigSecret` overrides chart-generated configuration; keep the Secret's worker images compatible with the server.

For a fresh install, create the namespace, server PVC, and Secrets. The PVC uses the cluster's default StorageClass. To select a different class, set `spec.storageClassName` in the PVC manifest and `kubernetes.process_volume.storage_class_name` in `leitwerk.yaml` before applying them.

```sh
kubectl create namespace leitwerk-system
kubectl apply -f "$DEPLOY_ROOT/server-pvc.yaml"
kubectl create secret generic leitwerk-encryption-key --namespace leitwerk-system \
  --from-literal=LEITWERK_CREDENTIAL_ENCRYPTION_KEY="$(openssl rand -base64 32)"
kubectl create secret generic leitwerk-provider --namespace leitwerk-system \
  --from-literal=OPENAI_API_KEY="$OPENAI_API_KEY"
kubectl create secret generic leitwerk-config --namespace leitwerk-system \
  --from-file=leitwerk.yaml="$DEPLOY_ROOT/leitwerk.yaml"
```

Keep the encryption key across restarts and upgrades. Use your secret provisioning workflow where CLI arguments may be exposed to other users. For an existing release, reuse its Secrets and [retain its server claim](#reuse-a-chart-managed-server-pvc).

## Install and verify

Replace `VERSION` with the chosen chart release (or replace the OCI URI and `--version` with `deploy/kubernetes/helm/leitwerk` for source-built images):

```sh
helm upgrade --install leitwerk oci://ghcr.io/leitwerk-dev/charts/leitwerk \
  --version VERSION --namespace leitwerk-system \
  -f "$DEPLOY_ROOT/values.yaml" --wait
kubectl rollout status deployment/leitwerk-server --namespace leitwerk-system
kubectl rollout status deployment/leitwerk-gateway --namespace leitwerk-system
kubectl port-forward --namespace leitwerk-system service/leitwerk-gateway 18080:8080
```

In another terminal, run `curl --fail http://127.0.0.1:18080/api/ready` and expect `{"status":"ready"}`. Open `http://127.0.0.1:18080`, run **Single Prompt**, and confirm that its Chronicle contains a model reply and the process reaches **Completed**.

Keep Helm values and `server.existingConfigSecret` aligned: Helm controls Kubernetes resources, RBAC, and admission policies, while the mounted Secret controls server runtime settings. Restart the server Deployment after changing `leitwerk-config`.

## Private worker images

Create a `kubernetes.io/dockerconfigjson` Secret in `server_namespace`. Set `kubernetes.image_pull_secret_copies` (`source_name` / `target_name`) and reference the target in `kubernetes.image_pull_secrets`. Repeat the pairs in Helm `kubernetes.imagePullSecretCopies` so RBAC grants `get` on the named source Secrets and admission restricts target copies to the process namespace prefix. Only `.dockerconfigjson` is copied.

## Safe singleton upgrades {#safe-singleton-upgrades}

Upgrade preflight requires `server.storage.existingClaim` and `server.existingConfigSecret`. The example values already point to the server PVC and configuration Secret from installation. Follow [Backup and upgrades](backup-and-upgrades.md) and confirm the server has a `Bound` claim. If the candidate needs updated runtime configuration, such as a new worker image, create a separate configuration Secret with those changes and point `server.existingConfigSecret` at it in the candidate Helm values. This also preserves the previous configuration for rollback.

```sh
helm upgrade leitwerk oci://ghcr.io/leitwerk-dev/charts/leitwerk \
  --version VERSION --namespace leitwerk-system \
  -f "$DEPLOY_ROOT/values.yaml" \
  --set server.preflight.enabled=true \
  --atomic --cleanup-on-fail --wait
```

The `pre-upgrade` Job runs the candidate server image on the current server's node:

1. Mounts the production PVC writable (required for SQLite WAL/SHM access), opens the database read-only, and takes an online SQLite backup into `emptyDir`.
2. Redirects all server writes to scratch storage, validates configuration and extensions, migrates only the copy, and checks `/api/health` on loopback.
3. Starts no workers, extension start hooks, or polling.

A failed Job is retained for log inspection and blocks cutover without replacing the running server. On cutover, `Recreate` stops the old Pod before starting the new one. `/api/health` checks liveness; `/api/ready` stays 503 until reconciliation and start hooks finish and flips to 503 before shutdown.

Repeat the readiness and process checks after upgrading. Reopen a process from before the upgrade to verify that its Chronicle is still available.

Preflight is not a backup, and Helm `--atomic` cannot reverse a migration committed during real startup. Follow [Backup and upgrades](backup-and-upgrades.md).

### Reuse a chart-managed server PVC

If your existing Helm release created its own server PVC, reuse that bound claim. Skip the fresh-install PVC and Secret commands.

1. Take a consistent backup. Run `helm get manifest leitwerk --namespace leitwerk-system` and find the server PVC. Confirm its manifest carries `helm.sh/resource-policy: keep`. If absent, first upgrade using your current chart version and values, with `server.storage.retain=true`, preflight disabled, and `server.storage.existingClaim` empty. Confirm the annotation in the resulting release manifest before proceeding.
2. Record the PVC's UID and bound volume with `kubectl get pvc leitwerk-server --namespace leitwerk-system -o yaml` (substitute your existing claim name if different). Set `server.storage.existingClaim` to that exact name in the upgrade values. Both the Job and the new server mount that claim, and Helm's keep policy preserves it when the chart stops rendering it.
3. After the upgrade, use the same command to verify that the claim's UID and `spec.volumeName` still match. Keep using that claim for later upgrades.

## Process volumes

Each process keeps one PVC across worker replacements; replacement waits for the previous Pod to disappear. Configure sizing and lifecycle in `leitwerk.yaml` (see [Configuration reference](configuration.md#kubernetes-runner)):

- **Per-process sizing**: New PVCs pick capacity in order: `process_configs.<processId>.storage_size` → extension `resolveStorageSize({ params, projects })` → `kubernetes.process_volume.size` (default `20Gi`). Existing PVCs are never resized. Invalid resolver output fails worker startup without fallback.
- **Reclaim on close**: `kubernetes.process_volume.reclaim_on_close: true` (Helm: `kubernetes.processVolume.reclaimOnClose=true`) discards completed, aborted, and explicitly deleted process workspaces via CSI by patching only the owned PV's reclaim policy to `Delete` before releasing the PVC. The shared StorageClass, error retention, and result-image retention are unchanged. Requires exact ownership, a bound dynamic CSI volume, no live Pod references, and PV `get`/`patch` permissions. Pending, static, or ambiguous volumes require manual review.
- **Pre-provisioned volume pool**: Set `kubernetes.process_volume.pre_provision: { count: 8 }` with an explicit `storage_class_name` and matching Helm `kubernetes.processVolume.preProvision.{enabled,count}` to maintain fresh volumes. The CSI driver must support dynamic filesystem provisioning via a copied StorageClass and rebinding retained PVs. Preparation uses worker node selectors/tolerations, has a 15-minute Pod deadline, and never recycles used volumes. Pool misses fall back to normal dynamic provisioning. Set `count: 0` to drain prepared volumes before removing the setting or changing StorageClass; inspect `leitwerk.dev/volume-pool` resources if stalled and delete only the owned preparation Pod after fixing a storage fault. Leave pre-provisioning disabled when varied per-process sizes need minimum allocation, because global-size pool volumes can satisfy smaller claims.

Leitwerk does not back up or restore process PVCs. Set CPU/memory `requests` and `limits` on every `worker_runtime_profiles` entry before using shared clusters with `ResourceQuota` or `LimitRange`.

## Preloaded worker images

Set `kubernetes.image_preload.enabled: true` (Helm: `kubernetes.imagePreload.enabled=true`) to pre-pull every configured worker profile image on Ready, schedulable nodes matching the union of `kubernetes.pod.node_selector` and the effective Docker node selector, with `kubernetes.pod.tolerations`.

- Every entry in `worker_runtime_profiles` must use a SHA-256 digest-qualified image (`@sha256:...`). Equivalent tagged/untagged digests share preparation.
- The server reconciles at startup and every 30 seconds, running one receipt Pod (`node -e 'process.exit(0)'`) per node UID and digest with direct pull Secrets and no worker credentials, ServiceAccount token, or PVC.
- Completed receipt Pods persist across server restarts; failed Pods are recreated after 30 seconds; obsolete Pods are cleaned up.
- Preloading is asynchronous and never gates `/api/ready` or process starts; normal worker pulls remain the fallback.

## Private Docker workers {#private-docker-workers}

Processes declaring `runtime.docker` run a private `overlay2` Docker daemon at `/state/tooling/docker`. Configure `kubernetes.docker` with `runtime_class_name` and `process_storage_class_name` (Leitwerk does not install either cluster resource) plus an isolation mode:

| Mode | Configuration | Behavior and capabilities |
| --- | --- | --- |
| `gvisor` | `isolation: gvisor` (omit `host_users`) | Uses the runsc Docker networking wrapper; adds only `SYS_ADMIN` and `NET_ADMIN` inside the sandbox. |
| `virtual-machine` | `isolation: virtual-machine` (omit `host_users`) | Uses ordinary Linux Docker networking, disables automatic ServiceAccount token mounting, adds only `SYS_ADMIN`, `NET_ADMIN`, and `SYS_PTRACE` (required for nonroot nested container network namespaces), and requires finite guest cgroup2 CPU/memory limits at startup. |
| Non-sandbox runtime | Omit `isolation`; set explicit `host_users` boolean | Retains the explicit `hostUsers` contract (e.g., Sysbox with `host_users: false`) and adds no capabilities. |

Rules and constraints:

- Both sandbox modes (`gvisor`, `virtual-machine`) apply the Pod Security `privileged` admission label only to those Docker-requiring process namespaces while keeping worker containers non-privileged. Ordinary workers and export helpers receive no extra capabilities.
- Leitwerk never adds privileged mode, host paths, host namespaces, a host runtime socket, or a TCP Docker listener.
- Legacy `gvisor: true` aliases `isolation: gvisor` only when `isolation` is omitted; conflicting values or combining `host_users` with sandbox isolation are rejected.
- `kubernetes.docker.worker_runtime_profile` (Helm: `kubernetes.docker.workerRuntimeProfile`) provides a Docker-specific fallback profile after process/component profiles; use it for dedicated Docker CPU/memory budgets.
- `kubernetes.docker.node_selector` (Helm: `kubernetes.docker.nodeSelector`) overrides matching keys in `kubernetes.pod.node_selector` for Docker worker Pods only; ordinary workers, export helpers, and volume-pool prep keep global placement.
- Optional `kubernetes.docker.network` sets `bridge_cidr`, `address_pools` (`base`, `size`), and `dns`.
- Isolation is a trusted operator assertion: never label a host-kernel runtime as a VM to obtain capabilities. Qualify the runtime, guest storage, limits, and `overlay2` reuse with `scripts/docker-runtime/README.md` before accepting workloads.

## Internal TLS and repository access

To secure worker-to-server IPC, enable `internal_tls` in `leitwerk.yaml`, set `kubernetes.server_url` to `https://...`, mount the chart's `internalTls` Secret, and point `kubernetes.server_ca_file` at the server-local CA path. The runner copies that CA into each process namespace and mounts it as `NODE_EXTRA_CA_CERTS`.

The bundled Caddy `gateway` requires `internalTls.enabled=false`. When `internalTls.enabled=true`, `server.ingress` alone routes only to `leitwerk-server` (which does not serve the UI SPA); deploy an external proxy that serves the extracted `/app/packages/ui/dist` SPA and proxies `/api/*`, `/auth/*`, `/ws`, and `/ext-ui/*` over HTTPS to `leitwerk-server`.

Repository SSH/HTTPS credentials are resolved by their owning extensions and delivered over authenticated worker IPC; ambient host SSH files and agents are never imported. See [Security](security.md#https-repository-authentication).

## Local clusters {#local-clusters}

### Kind

Use a disposable Kind cluster with the repository scripts in `scripts/k8s/`:

```sh
npm run build
npm run k8s:kind:create
npm run k8s:images:build
npm run k8s:images:load
npm run k8s:helm:deploy:kind
npm run test:k8s:local
npm run k8s:kind:delete
```

Override image tags with `SERVER_IMAGE`, `WORKER_GENERIC_IMAGE`, and `WORKER_SPECIALIZED_IMAGE`. If `test:k8s:local` reports missing namespace-creation RBAC, re-run `npm run k8s:helm:deploy:kind`. For manual Kind installs with the source chart, load `leitwerk-server:local` and `leitwerk-worker-generic:local` via `kind load docker-image`, point `leitwerk-config` at `leitwerk-worker-generic:local`, and pass `--set server.image.repository=leitwerk-server --set server.image.tag=local --set-string server.image.digest=`.

### Docker Desktop

Scripts under `scripts/k8s/docker-desktop/` target the `docker-desktop` context, store state outside the checkout, read local `leitwerk.yaml`, and expose the gateway on loopback port `18081`:

- `load-images.sh`: Imports revision-tagged images into Docker Desktop's single local node via a short-lived privileged pod. Never run on a shared or remote cluster.
- `backup.sh`: Stops the server, archives server and process PVCs with checksums, and restarts service.
- `undeploy.sh stop`: Retains durable resources; `undeploy.sh purge` requires a checksummed backup and the full deployment ID.

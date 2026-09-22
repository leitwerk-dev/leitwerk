# Kubernetes deployment

The Helm chart installs a singleton server, storage, Service, RBAC, and admission
policy. Each process gets its own namespace, worker Pod, and retained PVC. The
optional gateway serves the browser UI and proxies application requests.

This walkthrough uses port forwarding and disabled authentication for an initial
check. Configure HTTPS and [authentication](security.md) before exposing the service.

## Prerequisites

- A Kubernetes cluster supporting `admissionregistration.k8s.io/v1`
  ValidatingAdmissionPolicy and permission to install the chart's cluster-level rules.
- Helm, `kubectl`, and a default dynamic filesystem StorageClass, or explicit classes
  for the server and process PVCs.
- Network access to the selected images and model provider.
- A persistent credential encryption key. Keep it with protected recovery material.

The server requires cluster-level access to create process namespaces and runtime
resources. Registry pull-secret access is limited to explicitly named Secrets in
its own namespace; it does not list Secrets cluster-wide.

## Prepare configuration

Copy the maintained [server configuration](examples/kubernetes/leitwerk.example.yaml) and
[Helm values](examples/kubernetes/values.yaml) outside the checkout:

```sh
export DEPLOY_ROOT="$HOME/.local/share/leitwerk/deployments/leitwerk-kubernetes"
mkdir -p "$DEPLOY_ROOT"
cp docs/examples/kubernetes/leitwerk.example.yaml "$DEPLOY_ROOT/leitwerk.yaml"
cp docs/examples/kubernetes/values.yaml "$DEPLOY_ROOT/values.yaml"
chmod 600 "$DEPLOY_ROOT/leitwerk.yaml"
```

Select a released chart version and replace `VERSION` in the worker image with the
same release, or its published immutable worker digest. Release charts pin their
default images, but an existing configuration Secret overrides generated worker
configuration; you must keep that Secret's image selection compatible.

Choose a model ID available to your account. Set `OPENAI_API_KEY` through your secret
manager. Create the namespace and Secrets once; never regenerate the encryption
key for an existing database:

```sh
kubectl create namespace leitwerk-system
kubectl create secret generic leitwerk-encryption-key --namespace leitwerk-system \
  --from-literal=LEITWERK_CREDENTIAL_ENCRYPTION_KEY="$(openssl rand -base64 32)"
kubectl create secret generic leitwerk-provider --namespace leitwerk-system \
  --from-literal=OPENAI_API_KEY="$OPENAI_API_KEY"
kubectl create secret generic leitwerk-config --namespace leitwerk-system \
  --from-file=leitwerk.yaml="$DEPLOY_ROOT/leitwerk.yaml"
```

These commands illustrate Secret inputs. Use your deployment's secret provisioning
mechanism where command arguments may be visible to other users. Ensure the key is
recoverable before depending on the installation.

## Install and verify

Replace `VERSION` with the selected released version:

```sh
helm upgrade --install leitwerk oci://ghcr.io/leitwerk-dev/charts/leitwerk \
  --version VERSION --namespace leitwerk-system \
  -f "$DEPLOY_ROOT/values.yaml" --wait
kubectl rollout status deployment/leitwerk-server --namespace leitwerk-system
kubectl rollout status deployment/leitwerk-gateway --namespace leitwerk-system
kubectl port-forward --namespace leitwerk-system service/leitwerk-gateway 18080:8080
```

In another shell, check `curl --fail http://127.0.0.1:18080/api/ready`, then open that
origin in the browser and run **Single Prompt**. Readiness verifies server startup,
not worker allocation or provider access; inspect the process's startup history too.

For a source chart, replace the OCI reference and `--version VERSION` with
`deploy/kubernetes/helm/leitwerk`. Use matching source-built server and worker images.

Keep deployment values and application YAML distinct: Helm values control chart
resources; the existing Secret controls server runtime settings. When changing
namespace, Service naming, storage, or pull-secret permissions, update both sides.

### Private worker images

Create a `kubernetes.io/dockerconfigjson` Secret in the server namespace. In the
application YAML, configure `kubernetes.image_pull_secret_copies` and reference the
target in `kubernetes.image_pull_secrets`. Repeat the source/target names in Helm
`kubernetes.imagePullSecretCopies` so RBAC and admission permit those copies.
Only `.dockerconfigjson` is copied.

### Safe singleton upgrades {#23-safe-singleton-upgrades}

For production preflight, use an operator-managed server PVC from installation and
set `server.storage.existingClaim` to it. Keep the configuration and encryption-key
Secrets. With those values in the deployment's values file:

```sh
helm upgrade leitwerk oci://ghcr.io/leitwerk-dev/charts/leitwerk \
  --version VERSION --namespace leitwerk-system \
  -f "$DEPLOY_ROOT/values.yaml" \
  --set server.preflight.enabled=true \
  --atomic --cleanup-on-fail --wait
```

The candidate runs against an online SQLite backup in scratch storage, validates
configuration and migrations, loads extensions, and checks a loopback listener.
It mounts the production PVC writable for SQLite WAL/SHM access but migrates only
the copy. It does not start background hooks, workers, or polling. A failed Job is
retained and blocks cutover without replacing the old server.

The server Deployment uses `Recreate`, so the old Pod stops before the replacement
starts. `/api/health` reports liveness; `/api/ready` stays 503 until reconciliation
and start hooks succeed and becomes 503 before shutdown.

Preflight is not a backup. Helm rollback does not reverse a schema migration made
during the candidate's real startup. Follow [upgrade and rollback precautions](operations.md#upgrade-and-rollback).
The example retains its chart-managed server PVC on uninstall; process-volume
retention is a separate server policy.

## Worker infrastructure

Runtime profile selection is process override, component requirement, then runner
default. Conflicting component requirements fail before worker startup. Configure
images, pull policy, and CPU/memory in `worker_runtime_profiles`; see
[Configuration](configuration.md#worker-runtime-profiles).

A process retains one PVC across worker replacement. Replacement waits for the old
Pod to disappear before using it. Explicit process deletion removes its namespace
and PVC; retention may also release old process storage. Leitwerk does not back up
or restore process PVCs. See [storage protection](operations.md#what-to-protect).

Processes requiring private Docker need operator-installed RuntimeClass, node
runtime, and compatible storage. `kubernetes.docker` selects these resources; it
does not install or preflight them. Use the
[runtime canaries](https://github.com/leitwerk-dev/leitwerk/blob/main/scripts/docker-runtime/README.md)
before accepting work. See [isolation constraints](security.md#2-secrets-container-isolation).

## Internal TLS and repository access

Internal TLS requires a certificate/key on the server, a CA trusted by workers, and
HTTPS worker `server_url`. Set `internal_tls` in application configuration and mount
the chart's `internalTls` Secret. `kubernetes.server_ca_file` is a server-local CA
path copied into process namespaces.

The bundled gateway currently rejects `internalTls.enabled: true`. Use a compatible
external UI/proxy arrangement if internal TLS is required; do not enable both chart
options and expect the gateway to trust the backend automatically.

Repository credentials are resolved by their owning server extension and delivered
over authenticated worker IPC. Configure pinned SSH host keys or scoped HTTPS
credentials through that extension. Ambient host SSH files and agents are not imported.
See [Security](security.md#https-repository-authentication).

## Local checks with Kind

Use a disposable Kind cluster, not an existing operator environment. Build and load
both images, then override both image selections:

```sh
kind create cluster --name leitwerk-dev
docker build -f deploy/images/Dockerfile.server -t leitwerk-server:local .
docker build -f deploy/images/Dockerfile.worker-generic -t leitwerk-worker-generic:local .
kind load docker-image leitwerk-server:local --name leitwerk-dev
kind load docker-image leitwerk-worker-generic:local --name leitwerk-dev
```

Create the same Secrets in that cluster, but set the application Secret's worker
image to `leitwerk-worker-generic:local`. Install the source chart with the values
file and `--set server.image.repository=leitwerk-server --set server.image.tag=local
--set-string server.image.digest=`. The gateway's UI copy uses the server image.
Verify readiness, the UI, and one worker launch before removing the disposable cluster.

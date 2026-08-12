# Kubernetes Deployment Guide

This guide explains how to deploy Leitwerk on a Kubernetes cluster. Use this deployment mode when you want pod-isolated worker processes running in dedicated namespaces across your cluster.

---

## 1. Cluster Topology & Namespaces

Leitwerk deploys its components using dedicated Kubernetes namespaces:

- **Server Namespace:** The Leitwerk server runs as a singleton Deployment in a primary management namespace (e.g. `leitwerk-system`).
- **Process Namespaces:** Each active process runs inside a dedicated namespace (`leitwerk-proc-<instanceId>`) containing its worker pod and persistent volume claim (PVC).
- **RBAC & Permissions:** The server uses cluster-level RBAC to dynamically provision and tear down process namespaces, PVCs, and worker pods.
- **Private worker images:** The server can copy explicitly named registry pull Secrets from its namespace into each process namespace. It never lists Secrets or reads Secrets cluster-wide.

See [Server and Worker Lifecycle](server-worker-lifecycle.md#2-worker-runners-isolation-contracts) and [Process Workspace](process-workspace.md#1-workspace-layouts) for worker IPC and storage layout details.

---

## 2. Deploying with Helm

Leitwerk provides an official Helm chart under `deploy/kubernetes/helm/leitwerk` to deploy the server, RBAC roles, and ingress services. Release charts are available from GHCR and as GitHub Release assets. Their default server and generic-worker images are pinned by digest.

### 2.1. Create Required Secrets

Before installing the chart, create the management namespace and store your configuration and encryption secrets:

```bash
kubectl create namespace leitwerk-system

# 1. Create credential encryption key Secret (Base64 encoding of exactly 32 random bytes)
kubectl create secret generic leitwerk-encryption-key \
  --namespace leitwerk-system \
  --from-literal=LEITWERK_CREDENTIAL_ENCRYPTION_KEY="$(openssl rand -base64 32)"

# 2. Create configuration secret from your local leitwerk.yaml
kubectl create secret generic leitwerk-config \
  --namespace leitwerk-system \
  --from-file=leitwerk.yaml=./leitwerk.yaml
```

### 2.2. Deploy Helm Chart

Deploy the Leitwerk server referencing your pre-created secrets. Replace `VERSION` with a released version:

```bash
helm upgrade --install leitwerk oci://ghcr.io/leitwerk-dev/charts/leitwerk \
  --version VERSION \
  --namespace leitwerk-system \
  --set server.existingConfigSecret=leitwerk-config \
  --set server.credentialEncryption.existingSecret=leitwerk-encryption-key
```

For a source checkout, replace the OCI reference and `--version` with `deploy/kubernetes/helm/leitwerk`.

For a private worker registry, create a `kubernetes.io/dockerconfigjson` Secret in the server namespace. Configure the same source and target names under `kubernetes.image_pull_secret_copies`, reference the target under `kubernetes.image_pull_secrets`, and pass the non-secret copy names through `kubernetes.imagePullSecretCopies` Helm values so the chart can render least-privilege RBAC and admission rules.

### 2.3. Safe singleton upgrades

Production upgrades can opt into the candidate-image preflight:

```bash
helm upgrade leitwerk oci://ghcr.io/leitwerk-dev/charts/leitwerk \
  --version VERSION \
  --namespace leitwerk-system \
  --atomic --cleanup-on-fail --wait \
  --set server.existingConfigSecret=leitwerk-config \
  --set server.storage.existingClaim=leitwerk-server-data \
  --set server.preflight.enabled=true
```

Preflight requires an operator-managed configuration Secret and production
PVC. Before cutover, a `pre-upgrade` Job runs the candidate image on the old
server's node, mounts the PVC read-only, and creates a consistent online SQLite
backup in scratch `emptyDir`. The candidate loads the real configuration and
credential key, validates and migrates only the copy, loads extensions, starts
a loopback HTTP listener, and checks `/api/health`. Background hooks, workers,
and Telegram polling do not start. A failed Job is retained for logs and aborts
the upgrade without changing the old Deployment.

The server remains a singleton with `Recreate` strategy. A successful preflight
is followed by a brief cutover: Kubernetes stops the old pod before starting
the replacement. `/api/health` reports process liveness. `/api/ready` reports
503 until startup reconciliation and all extension start hooks succeed, and
reports 503 before shutdown begins. Atomic rollback stops a failed candidate
before restoring the previous release, so two Telegram pollers do not overlap.

---

## 3. Worker Pod Lifecycle & Runtime Profiles

### 3.1. Runtime Profile Selection
When a worker pod is launched, Leitwerk selects container images, pull policies, and resource limits using this order:
1. Process definition override
2. Component runtime profile
3. `kubernetes.default_worker_runtime_profile` configured in `leitwerk.yaml`

### 3.2. Pod Lifecycle & PVC Retention
- **Pod Provisioning:** `ProcessVolume.ensure(instanceId)` creates the process namespace and PVC mounted at `/state`. The server then spawns the worker pod.
- **Idle Pod Cleanup:** When a process becomes idle, the server may terminate the worker pod while keeping the PVC intact. Future turns spawn a replacement pod on the existing PVC.
- **Process Deletion:** Explicit process deletion (`DELETE /api/processes/:id`) removes the complete process namespace, including its PVC and ServiceAccount.

---

## 4. Internal TLS & Git SSH Credentials

### 4.1. Internal TLS
To encrypt server-worker WebSocket IPC traffic inside the cluster:
- Set `internal_tls.enabled: true` in `leitwerk.yaml`.
- Mount the cluster CA bundle and configure `kubernetes.server_ca_file`. Worker pods mount this CA via `NODE_EXTRA_CA_CERTS`.

### 4.2. Repository SSH Keys
For processes interacting with private Git repositories:
- Store SSH private keys in a Kubernetes secret in the server namespace.
- Server-side SSH profiles pass verified keys to workers over authenticated IPC; ambient SSH files and agents are ignored.

---

## 5. Local Validation with Kind

To test the Kubernetes deployment locally using Kind (Kubernetes in Docker):

```bash
# 1. Create a local Kind cluster
kind create cluster --name leitwerk-dev

# 2. Build and load container images into Kind
docker build -f deploy/images/Dockerfile.server -t leitwerk-server:local .
docker build -f deploy/images/Dockerfile.worker-generic -t leitwerk-worker-generic:local .
kind load docker-image leitwerk-server:local --name leitwerk-dev
kind load docker-image leitwerk-worker-generic:local --name leitwerk-dev

# 3. Install Helm chart
helm upgrade --install leitwerk deploy/kubernetes/helm/leitwerk \
  --namespace leitwerk-system \
  --create-namespace \
  --set server.image.repository=leitwerk-server \
  --set server.image.tag=local
```

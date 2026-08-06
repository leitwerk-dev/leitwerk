# Kubernetes deployment

This directory contains the Kubernetes packaging:

- `../images/Dockerfile.server` builds the singleton server image.
- `../images/Dockerfile.worker-generic` builds the generic worker runtime profile image.
- `Dockerfile.server` and `Dockerfile.worker-generic` are compatibility symlinks to the shared image definitions.
- `Dockerfile.worker-specialized-smoke` extends the generic image with a deterministic tool used by the optional Kind process-level suite to validate specialized runtime-profile images.
- `helm/leitwerk` is the Helm chart for the server Deployment, Service, PVC, RBAC, optional internal TLS Secret mount, and rendered leitwerk config.

Worker Pods, per-process worker ServiceAccounts, process PVCs, and per-process server-CA ConfigMaps are not Helm-managed. They are created dynamically by the server's Kubernetes runner and reconciled by the server lifecycle. For production internal TLS, set `internalTls.enabled=true`, provide a Secret containing the server cert/key and CA bundle, and let the chart render `kubernetes.server_ca_file`; the runner copies that CA into each process namespace for worker Pods.

The chart can mount an operator-managed configuration Secret by setting
`server.existingConfigSecret`. The Secret must contain a `leitwerk.yaml` key.
Use `server.credentialEncryption.existingSecret` and `.key` to provide the
stable `LEITWERK_CREDENTIAL_ENCRYPTION_KEY` without putting it in Helm values.
An external Secret change does not alter the Deployment template; restart the
server Deployment after applying it.

Set `gateway.enabled=true` to serve the revision-matched SPA through Caddy. An
init container copies the UI from the server image, and the gateway proxies API,
authentication, WebSocket, and extension-UI routes to Fastify. The gateway
currently requires `internalTls.enabled=false`.

Docker Desktop deployment scripts are under `scripts/k8s/docker-desktop`. They
always target the `docker-desktop` context, retain state outside the checkout,
and expose the gateway through a loopback-only port-forward on port `18081`.
Because Docker Desktop's Kind-backed containerd does not share the Docker image
store, `load-images.sh` uses a short-lived privileged pod to import the two
revision-tagged images into the single local node. Do not use that loader on a
shared or remote cluster. The scripts use the ignored local `leitwerk.yaml` as
configuration input, including
optional provider extensions such as Codex Nifto. `backup.sh` stops the server,
archives the server and process PVCs, checksums the protected result, and then
restores service. `undeploy.sh stop` retains all durable resources; its explicit
`purge` mode requires a checksummed backup and the full deployment id.

Local Kind loop:

```bash
npm run build
npm run k8s:kind:create
npm run k8s:images:build
npm run k8s:images:load
npm run k8s:helm:deploy:kind
npm run test:k8s:local
npm run k8s:kind:delete
```

Override image names with `SERVER_IMAGE`, `WORKER_GENERIC_IMAGE`, and `WORKER_SPECIALIZED_IMAGE` when running the scripts. If `npm run test:k8s:local` reports that the server ServiceAccount cannot create namespaces, the deployed RBAC is stale; rerun `npm run k8s:helm:deploy:kind` before rerunning the smoke test.

## Resource quotas

Set resource requests/limits on every `workerRuntimeProfiles.*.resources` entry before using a shared cluster. Kubernetes scheduling and namespace `ResourceQuota` admission use those requests/limits; omitting them can leave worker pods unschedulable or let a single process consume a disproportionate share of the namespace. A typical production namespace should define a `ResourceQuota` and `LimitRange` that cover CPU, memory, pod count, and persistent volume claim count/storage. Keep the singleton server resources separate from worker profile resources so operator/API availability is not tied to a large repository build.

## Retained process PVC cleanup

Stopping or idling a worker deletes only the worker Pod. The per-process PVC is retained for resume and is released only through explicit retention cleanup (`ProcessVolume.release`) after a terminal process exceeds the configured retention window. Use conservative retention in production and snapshot or back up PVCs before lowering it.

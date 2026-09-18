# Docker runtime opt-in tests

These tests mutate disposable Docker or Kubernetes resources. They do not run in normal CI.

```bash
# Explicit non-default local context.
LEITWERK_DOCKER_CONTEXT=leitwerk-disposable scripts/docker-runtime/test-local.sh

# Candidate worker image on a Docker host.
LEITWERK_WORKER_IMAGE=leitwerk-worker:canary \
LEITWERK_DOCKER_ISOLATION=privileged \
scripts/docker-runtime/test-docker-runner.sh

# Repeat with a prepared Sysbox Docker runtime.
LEITWERK_WORKER_IMAGE=leitwerk-worker:canary \
LEITWERK_DOCKER_ISOLATION=sysbox-runc \
scripts/docker-runtime/test-docker-runner.sh

# Prepared Kubernetes runtime-class cluster.
LEITWERK_WORKER_IMAGE=registry.example/leitwerk-worker@sha256:... \
LEITWERK_RUNTIME_CLASS_NAME=leitwerk-sysbox \
LEITWERK_DOCKER_STORAGE_CLASS_NAME=leitwerk-docker-process \
scripts/docker-runtime/test-kubernetes-runner.sh
```

The local check verifies the explicitly selected host context. The isolated checks run the candidate image's trusted entrypoint against a minimal disposable WebSocket endpoint, wait for its private daemon, verify `overlay2`, build and run a nested image, replace the outer container or Pod, verify `overlay2` again, and run the prior image with `--pull=never`.

## Kubernetes evidence

The Kubernetes canary requires Node 26, kubectl and the selected cluster context.
It creates a disposable namespace and process PVC. It checks the admitted Pod,
including init and ephemeral containers, for the selected runtime class,
`hostUsers: false`, host namespaces, hostPath volumes, privileged containers,
added capabilities and mounted runtime sockets. The Ready worker must use the
candidate image and mount exactly one complete writable process PVC at `/state`.
The selected storage class and PV/PVC claim identity must agree; storage backends
and node placement remain cluster choices.

The canary verifies nested DNS, `overlay2`, Docker data at `/state/tooling/docker`
and the absence of listeners on Docker TCP ports 2375 and 2376. It saves an inner
image and a unique workspace marker, observes the first worker, deletes its Pod
and waits for confirmed absence before starting the replacement. The replacement
must have a different Pod UID and retain the PVC/PV UIDs, running worker image ID,
inner image ID and workspace marker.

Set `LEITWERK_DOCKER_EVIDENCE_DIR` to a new directory to retain before/after raw
snapshots, the confirmed deletion timestamp and verified `evidence.json` files.
Files use mode `0600`; directories use `0700`. Retained evidence survives both
success and failure. Without this option, evidence uses a temporary directory
removed during cleanup. Namespace cleanup applies only after this run successfully
creates its namespace. Existing evidence directories are never overwritten.

A passing canary establishes compatibility for the tested worker image, kernel, container runtime, and process volume. Record those inputs with the result; do not infer support for other deployments from the backing filesystem name. For an upgrade, use a disposable copy of an existing `overlay2` store with the candidate image. Do not point a canary at an active process store or a store created by another driver.

The Docker canary removes only resource IDs created by that run. Its default state volume gets a fresh Docker-generated name. Set `LEITWERK_DOCKER_STATE_VOLUME` to reuse a retained volume; cleanup preserves that volume.

Live canaries verify deployment compatibility without requiring a durable
Leitwerk process. They are opt-in and do not replace `npm run test:full`.

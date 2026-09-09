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

The local check verifies the explicitly selected host context. The isolated checks run the candidate image's trusted entrypoint against a minimal disposable WebSocket endpoint, wait for its private daemon, verify `overlay2`, build and run a nested image, replace the outer container or Pod, verify `overlay2` again, and run the prior image with `--pull=never`. The Kubernetes check also verifies DNS, `hostUsers: false`, and the absence of privileged mode and host paths.

A passing canary establishes compatibility for the tested worker image, kernel, container runtime, and process volume. Record those inputs with the result; do not infer support for other deployments from the backing filesystem name. For an upgrade, use a disposable copy of an existing `overlay2` store with the candidate image. Do not point a canary at an active process store or a store created by another driver.

The Docker canary removes only resource IDs created by that run. Its default state volume gets a fresh Docker-generated name. Set `LEITWERK_DOCKER_STATE_VOLUME` to reuse a retained volume; cleanup preserves that volume.

Blocking tests cover runner-generated manifests and replacement handoff. The live canaries add runtime-handler, storage, entrypoint, and daemon compatibility without requiring a durable Leitwerk process.

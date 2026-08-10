# Local Docker Deployment

This guide covers running Leitwerk with Docker workers on a single machine. There are **two different topologies**—pick one and follow only that path.

| Path | When to use | Entry |
| --- | --- | --- |
| **A. In-repo Compose** | Dev / first bring-up from a checkout | [`deploy/docker/README.md`](../deploy/docker/README.md) |
| **B. Outside-checkout deployment root** | Revision-pinned install under `~/.local/share/leitwerk/deployments/` | This page §2–4 + [`scripts/deploy-docker.sh`](../scripts/deploy-docker.sh) |

Do not mix them: Path A’s `deploy/docker/docker-compose.yaml` mounts config from `deploy/docker/config/` and publishes **80/443** via Caddy. Path B expects **`$DEPLOY_ROOT/compose.yaml`** and typically serves **`http://127.0.0.1:18080`**.

> [!IMPORTANT]
> **Single daemon limit:** Run at most one Docker-backed Leitwerk server per Docker daemon. Multiple servers on the same daemon can interfere with container supervision and volume adoption.

---

## Prerequisites

- Docker Engine or Docker Desktop
- Docker Compose v2
- OpenSSL, `curl`, and `jq` (Path B)

---

## Path A — In-repo Compose (recommended first)

1. Copy and edit the sample config:

   ```bash
   cp deploy/docker/config/leitwerk.example.yaml \
      deploy/docker/config/leitwerk.yaml
   ```

2. Follow the quick start in [`deploy/docker/README.md`](../deploy/docker/README.md) (`docker compose -f deploy/docker/docker-compose.yaml up --build`).

3. Reach the UI/API through the reverse proxy ports documented there (Caddy on **80/443** by default), not `18080`.

Config shape notes (also in the sample):

- Worker images come from `worker_runtime_profiles` (for example `generic.image`), **not** `workers.docker.image`.
- Storage uses `storage.sqlite_path` (and related dirs), **not** `storage.database_path`.
- Runner wiring is top-level `docker:` / `kubernetes:` / `local_worker:`, not nested under `workers.docker`.

---

## Path B — Outside-checkout deployment root

Use this when you want durable deploy state outside the git checkout. [`scripts/deploy-docker.sh`](../scripts/deploy-docker.sh) **does not create** the Compose file; it only starts an existing `$DEPLOY_ROOT/compose.yaml`.

### 1. Create the deployment root

```bash
export REVISION="$(git rev-parse --short HEAD)"
export DEPLOY_ROOT="$HOME/.local/share/leitwerk/deployments/leitwerk-${REVISION}"
mkdir -p "$DEPLOY_ROOT/config" "$DEPLOY_ROOT/secrets" "$DEPLOY_ROOT/backups" "$DEPLOY_ROOT/ui"
```

Overrides used by the scripts: `LEITWERK_DOCKER_REVISION`, `LEITWERK_DOCKER_ID`, `LEITWERK_DOCKER_ROOT`, `LEITWERK_DOCKER_URL` (default health/UI URL `http://127.0.0.1:18080`).

### 2. Server config

```bash
cp deploy/docker/config/leitwerk.example.yaml "$DEPLOY_ROOT/config/leitwerk.yaml"
```

Edit at least `server.base_url`, storage paths, and `worker_runtime_profiles.generic.image` (for example `leitwerk-worker-generic:${REVISION}`). Abbreviated shape:

```yaml
server:
  host: 0.0.0.0
  port: 8080
  base_url: "http://127.0.0.1:18080"
storage:
  sqlite_path: /app/.leitwerk/leitwerk.sqlite
  process_workspaces_dir: /app/.leitwerk/workspaces
  tree_files_dir: /app/.leitwerk/trees
workers:
  runner: docker
  default_runtime_profile: generic
docker:
  socket: unix:///var/run/docker.sock
  network: leitwerk
  server_url: http://leitwerk-server:8080
  process_volume:
    mode: bind
    host_root: /var/lib/leitwerk/processes
    mount_path: /state
worker_runtime_profiles:
  generic:
    image: "leitwerk-worker-generic:${REVISION}"
```

### 3. Secrets and images

```bash
printf 'LEITWERK_CREDENTIAL_ENCRYPTION_KEY=%s\n' "$(openssl rand -hex 32)" \
  > "$DEPLOY_ROOT/secrets/credentials.env"
chmod 600 "$DEPLOY_ROOT/secrets/credentials.env"

docker build -f deploy/images/Dockerfile.server -t "leitwerk-server:${REVISION}" .
docker build -f deploy/images/Dockerfile.worker-generic -t "leitwerk-worker-generic:${REVISION}" .
```

Ensure the Compose service that runs the server **injects** `LEITWERK_CREDENTIAL_ENCRYPTION_KEY` (for example via `env_file` pointing at `$DEPLOY_ROOT/secrets/credentials.env`). Passing `--env-file` only to `docker compose` substitutes Compose variables; it does not automatically put the key inside the container unless the service declares it.

### 4. Author `$DEPLOY_ROOT/compose.yaml`

Create Compose config in the deployment root that:

- Uses images `leitwerk-server:${REVISION}` / worker profile images you built
- Mounts `$DEPLOY_ROOT/config/leitwerk.yaml` (or equivalent) as the server config
- Publishes the URL you set in `server.base_url` (scripts default to **18080**)
- Optionally serves static UI from `$DEPLOY_ROOT/ui` (the deploy script copies UI out of the server image on rebuild)

You can adapt `deploy/docker/docker-compose.yaml` as a starting point, but change bind mounts and published ports for the outside-checkout layout—do not point Path B at the in-repo compose file unchanged.

### 5. Start and verify

```bash
# From the repository root (interactive rebuild prompt)
./scripts/deploy-docker.sh
```

Or, once Compose and UI assets exist:

```bash
cd "$DEPLOY_ROOT"
docker compose up -d
curl -s "${LEITWERK_DOCKER_URL:-http://127.0.0.1:18080}/api/health" | jq .
```

Expect a JSON health object that includes `"status": "ok"` (additional fields such as protocol may be present).

Teardown: [`scripts/undeploy-docker.sh`](../scripts/undeploy-docker.sh) (also requires `$DEPLOY_ROOT/compose.yaml`).

---

## Operational notes (both paths)

- **Backup:** Copy the SQLite file at `storage.sqlite_path` while the server is stopped or after a consistent backup command you trust for your volume layout.
- **Upgrade:** Build new revision-tagged images, update the worker profile image tag in config, recreate containers.
- **Rollback:** Point images/tags back at the previous revision and recreate.

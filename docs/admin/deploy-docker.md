# Docker deployment

Run the server, Caddy web gateway, and isolated worker containers on one Docker host with the browser UI at `http://127.0.0.1:18080`. State, configuration, and secrets live outside the repository checkout.

Run at most one Docker-backed Leitwerk server per Docker daemon. Worker adoption and cleanup are not installation-isolated. The server mounts the host Docker socket; workers never receive that socket.

## Prerequisites

- macOS or Linux and a checkout of the revision to deploy.
- Docker Engine or Docker Desktop with BuildKit and Docker Compose v2.
- Git, OpenSSL, `curl`, and `tar`.
- A model provider account (`OPENAI_API_KEY` in the example below).

Named-volume session transfers require Docker Engine 26.0 or newer (API 1.45+).

## Compose topology

The canonical files are [compose.yaml](../examples/docker/compose.yaml), [leitwerk.example.yaml](../examples/docker/leitwerk.example.yaml), and [Caddyfile](../examples/docker/Caddyfile):

- `leitwerk-server` mounts `/var/run/docker.sock`, `./config/leitwerk.yaml`, and `./state`, and joins the user-defined `leitwerk` bridge network.
- `web` (Caddy) binds `127.0.0.1:18080:8080`, serves the extracted SPA from `./ui`, and proxies `/api/*`, `/auth/*`, `/ws`, and `/ext-ui/*` to `leitwerk-server:8080`. Merely reverse-proxying all paths to Fastify does not serve the UI.
- Worker containers attach to `leitwerk` and dial `http://leitwerk-server:8080` (never a host IP) using launcher-injected connect credentials.

For a public HTTPS deployment with automatic Let's Encrypt certificates, see `deploy/docker/README.md` and `deploy/docker/docker-compose.yaml` (which use the same Caddy SPA + backend routing split on ports `80`/`443`). For repeated local restarts against `$DEPLOY_ROOT`, you can use `scripts/deploy-docker.sh`.

## Prepare configuration

From the repository root, initialize a fresh deployment directory (do not overwrite an existing installation's key or state):

```sh
export REVISION="$(git rev-parse --short HEAD)"
export DEPLOY_ROOT="$HOME/.local/share/leitwerk/deployments/leitwerk-local"
mkdir -p "$DEPLOY_ROOT/config" "$DEPLOY_ROOT/secrets" "$DEPLOY_ROOT/state" "$DEPLOY_ROOT/ui"
cp docs/examples/docker/compose.yaml docs/examples/docker/Caddyfile "$DEPLOY_ROOT/"
cp docs/examples/docker/leitwerk.example.yaml "$DEPLOY_ROOT/config/leitwerk.yaml"
printf 'REVISION=%s\n' "$REVISION" > "$DEPLOY_ROOT/.env"
chmod 700 "$DEPLOY_ROOT/secrets" "$DEPLOY_ROOT/state"
chmod 600 "$DEPLOY_ROOT/config/leitwerk.yaml"
```

In `$DEPLOY_ROOT/config/leitwerk.yaml`, replace `REVISION` in `worker_runtime_profiles.generic.image` with `$REVISION`, and adjust `model_id` if needed.

Generate the encryption key once (`set -C` refuses to overwrite an existing file):

```sh
(set -C; umask 077; printf 'LEITWERK_CREDENTIAL_ENCRYPTION_KEY=%s\n' \
  "$(openssl rand -base64 32)" > "$DEPLOY_ROOT/secrets/credentials.env")
```

Export `OPENAI_API_KEY` in the launching shell. Compose forwards it to initialize an empty encrypted credential store; an existing stored credential wins on restart.

## Build images and extract the UI

Keep server, worker, and UI artifacts from the same revision:

```sh
docker build -f deploy/images/Dockerfile.server -t "leitwerk-server:$REVISION" .
docker build -f deploy/images/Dockerfile.worker-generic -t "leitwerk-worker-generic:$REVISION" .

ui_source="$(docker create "leitwerk-server:$REVISION")"
docker cp "$ui_source:/app/packages/ui/dist/." "$DEPLOY_ROOT/ui/"
docker rm "$ui_source"
test -f "$DEPLOY_ROOT/ui/index.html"

docker image inspect "leitwerk-server:$REVISION" "leitwerk-worker-generic:$REVISION" \
  --format '{{json .RepoTags}} {{.Id}}' > "$DEPLOY_ROOT/image-lock.txt"
```

Remove `$ui_source` manually if extraction fails partway.

## Start and verify

```sh
docker compose --project-directory "$DEPLOY_ROOT" -f "$DEPLOY_ROOT/compose.yaml" config --quiet
docker compose --project-directory "$DEPLOY_ROOT" -f "$DEPLOY_ROOT/compose.yaml" up -d
curl --fail --retry 30 --retry-delay 2 --retry-all-errors http://127.0.0.1:18080/api/ready
```

`/api/ready` returns 200 after reconciliation and extension startup; `/api/health` checks liveness only. Inspect logs with:

```sh
docker compose --project-directory "$DEPLOY_ROOT" -f "$DEPLOY_ROOT/compose.yaml" logs --tail=100
```

Open `http://127.0.0.1:18080`, run **Single Prompt**, and confirm the worker starts and records output.

Authentication is disabled in this loopback example. Before exposing the deployment beyond loopback, switch to HTTPS (see `deploy/docker/README.md`), update `server.base_url`, and enable [Security](security.md).

## Process volumes

Configure `docker.process_volume.mode` for per-process `/state` storage:

| Mode | Behavior |
| --- | --- |
| `bind` (default) | Mounts host subdirectories under `docker.process_volume.host_root` (default `/var/lib/leitwerk/processes`). Requires the host path to be reachable by the Docker daemon. |
| `named_volume` | Creates one Docker named volume per process outside Compose. Recommended for local Docker Desktop and portable setups; requires Engine 26.0+ for scoped session-transfer mounts. |

See [Configuration reference](configuration.md#docker-runner) for all `docker.*` keys.

## Private Docker inside workers

Process definitions that declare `runtime.docker` start a private Docker daemon inside the worker container. Configure `docker.private_daemon.isolation`:

- `privileged`: Runs the worker container privileged, granting broad host-kernel authority.
- `sysbox-runc`: Uses the `sysbox-runc` runtime installed on the Docker host without setting `privileged`.

Neither mode mounts the host Docker socket into workers. Private daemons use the `overlay2` storage driver under `/state/tooling/docker`, listen on a local Unix socket, and read registry credentials from an ephemeral `DOCKER_CONFIG` (and `HELM_REGISTRY_CONFIG`). The process volume, kernel, and runtime must support OverlayFS together; validate builds, nested containers, and image reuse with the canaries in `scripts/docker-runtime/README.md`. One early daemon-exit retry is allowed within the startup deadline without resetting retained data.

## Backup and stop {#backup}

Stop the server before archiving server state and configuration:

```sh
docker compose --project-directory "$DEPLOY_ROOT" -f "$DEPLOY_ROOT/compose.yaml" stop leitwerk-server
(umask 077; tar -czf "$DEPLOY_ROOT/../leitwerk-backup-$(date +%Y%m%d%H%M%S).tgz" \
  -C "$DEPLOY_ROOT" state config secrets compose.yaml Caddyfile .env image-lock.txt)
docker compose --project-directory "$DEPLOY_ROOT" -f "$DEPLOY_ROOT/compose.yaml" start leitwerk-server
```

On Linux, reading root-owned container files may require elevated permissions. Protect the archive: it contains the encryption key. Dynamically created named worker volumes are not included; quiesce and back them up separately if workspace recovery is required. See [Backup and upgrades](backup-and-upgrades.md) for restore, migrations, and rollback.

Stop the stack without deleting data:

```sh
docker compose --project-directory "$DEPLOY_ROOT" -f "$DEPLOY_ROOT/compose.yaml" stop
```

Running worker containers can outlive a stopped server; finish or stop active processes first when halting all work. Compose does not own dynamic worker volumes, so `docker compose down -v` is neither a backup nor a complete cleanup.

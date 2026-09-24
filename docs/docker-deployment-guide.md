# Local Docker deployment

Run the server and workers in containers with the browser UI at
`http://127.0.0.1:18080`. This walkthrough uses a source checkout, named process
volumes, and an outside-checkout directory for configuration and server state.
It does not expose the application to your network.

Run at most one Docker-backed Leitwerk server per Docker daemon. Worker adoption
and cleanup are not installation-isolated. The server controls the host Docker
socket; workers do not receive that socket.

## Prerequisites

- macOS or Linux and a checkout of the revision to deploy.
- Docker Engine or Docker Desktop with BuildKit, and Docker Compose v2.
- Git, OpenSSL, `curl`, and `tar`.
- A model provider account. This example uses `OPENAI_API_KEY`.

Named-volume session transfers require Docker Engine 26.0 or newer (API 1.45+).
Use a compatible filesystem/runtime if you later enable private Docker inside workers.

## Prepare configuration

Run from the repository root. Use a new deployment directory; do not overwrite an
existing installation's key or configuration:

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

In `$DEPLOY_ROOT/config/leitwerk.yaml`, replace the literal `REVISION` in
`worker_runtime_profiles.generic.image` with the printed value of `$REVISION`.
Choose a model ID available to your account if `gpt-4o` is not suitable.

Generate the encryption key once. The command refuses to overwrite an existing file:

```sh
(set -C; umask 077; printf 'LEITWERK_CREDENTIAL_ENCRYPTION_KEY=%s\n' \
  "$(openssl rand -base64 32)" > "$DEPLOY_ROOT/secrets/credentials.env")
```

Set `OPENAI_API_KEY` in the launching shell through your secret manager. Compose
passes it to the server for credential initialization; an existing stored revision
wins on restart. The server always needs the same encryption key for that database.

The maintained examples are [Compose](examples/docker/compose.yaml),
[server configuration](examples/docker/leitwerk.example.yaml), and
[Caddy routing](examples/docker/Caddyfile). The web container serves the built UI
and proxies API, authentication, WebSocket, and extension-asset requests. Merely
proxying all requests to the API server does not serve the SPA.

## Build matching images and extract the UI

From the repository root:

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

If extraction fails, remove the temporary container identified by `$ui_source`.
Keep the UI, server, and worker artifacts from the same revision.

## Start and verify

```sh
docker compose --project-directory "$DEPLOY_ROOT" -f "$DEPLOY_ROOT/compose.yaml" config --quiet
docker compose --project-directory "$DEPLOY_ROOT" -f "$DEPLOY_ROOT/compose.yaml" up -d
curl --fail --retry 30 --retry-delay 2 --retry-all-errors http://127.0.0.1:18080/api/ready
```

Readiness returns HTTP 200 after reconciliation and extension startup. `/api/health`
checks liveness only. Inspect failures with:

```sh
docker compose --project-directory "$DEPLOY_ROOT" -f "$DEPLOY_ROOT/compose.yaml" logs --tail=100
```

Open `http://127.0.0.1:18080`, launch **Single Prompt**, and confirm that its worker
starts and records a result. A healthy server alone does not verify model access
or worker startup.

Authentication is disabled for this loopback-only example. Before exposing it,
configure HTTPS, `server.base_url`, and [authentication](security.md). Do not simply
remove the loopback port binding.

## Backup

Prevent new work, stop the server, and archive its storage and configuration:

```sh
docker compose --project-directory "$DEPLOY_ROOT" -f "$DEPLOY_ROOT/compose.yaml" stop leitwerk-server
(umask 077; tar -czf "$DEPLOY_ROOT/../leitwerk-backup-$(date +%Y%m%d%H%M%S).tgz" \
  -C "$DEPLOY_ROOT" state config secrets compose.yaml Caddyfile .env image-lock.txt)
docker compose --project-directory "$DEPLOY_ROOT" -f "$DEPLOY_ROOT/compose.yaml" start leitwerk-server
```

Verify archive creation before restarting. On Linux, copying root-owned container
files may require elevated read access. Protect the archive: it includes the
credential encryption key. Named worker volumes are **not** included; independently
quiesce and back them up if workspace recovery is required.

See [Backup and upgrades](operations.md) for restore verification, migration safety,
and the limits of image rollback. Keep this deployment root when upgrading; changing
the image revision must not select an empty replacement database.

## Stop without deleting data

```sh
docker compose --project-directory "$DEPLOY_ROOT" -f "$DEPLOY_ROOT/compose.yaml" stop
```

Isolated workers can remain running while the server is stopped. Finish or stop
active processes first when stopping all work is required. Server state and named
process volumes remain retained. Compose does not own dynamically created worker
volumes; `down -v` is neither a backup nor a complete process-storage cleanup command.
Use explicit process deletion only after preserving required data.

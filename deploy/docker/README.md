# Docker run-mode deployment

Server-in-container topology for the Docker run mode. For a revision-pinned,
loopback-only installation that can run beside a source development server, see
the [local Docker deployment guide](../../docs/admin/deploy-docker.md). Run the server in a
container too, even on one machine: it is the easiest topology to secure and it
matches the Kubernetes model, so the secure choice and the k8s-ready choice
coincide.

## Topology

See [Compose topology](../../docs/admin/deploy-docker.md#compose-topology) for
shared networking and routing. In this variant Caddy is the public UI/API
entrypoint and terminates HTTPS with Let's Encrypt.

- **Worker address.** Set `docker.server_url` explicitly; it is never derived
  from host networking.
- **Internal TLS (optional).** `internal_tls` secures the worker → server
  IPC and session-snapshot endpoints over the private network. The cert carries
  a SAN for `leitwerk-server`; workers trust the signing CA via
  `docker.server_ca_file`, which is mounted read-only into each worker and
  exposed as `NODE_EXTRA_CA_CERTS`. Because Docker bind mounts are resolved by
  the Docker daemon, `docker.server_ca_file` must be a host-visible path, not
  merely `/etc/leitwerk/tls/...` inside the server container. Worker client
  certificates are not wired yet, so `internal_tls.client_ca_file` is rejected.
  This mirrors Kubernetes' stable Service DNS plus authenticated internal worker
  routes and public Ingress/reverse-proxy shape; Kubernetes NetworkPolicy can be
  layered later where clusters require network-level isolation.
- **Process volumes stay server-opaque.** Per-process bind volumes live under
  `docker.process_volume.host_root` on the host; the server container does not
  mount that path. The server only ever sees process state through the
  session-snapshot exchange.
## Files

- `../images/Dockerfile.server` — builds and runs the leitwerk server.
- `../images/Dockerfile.worker-generic` — the MVP `generic` worker runtime profile image. It includes Chromium, Playwright system dependencies, a pinned mise release, archive utilities, Python, make, and a C/C++ compiler. Repository tools remain process-local and are not baked into the image.
- `Dockerfile.server` and `Dockerfile.worker-generic` are compatibility symlinks to the shared image definitions.
- `docker-compose.yaml` — server + reverse proxy on the shared private network.
- `Caddyfile` — public HTTPS termination and reverse proxy to the server.
- `config/leitwerk.example.yaml` — sample server config for this topology.

Image builds require BuildKit and the `docker/dockerfile:1` frontend. `COPY --parents` keeps workspace manifests in the dependency layer. Runtime dependency copies come from the dependency stage, not the application build. Linked payload layers let source changes reuse dependencies when the parent image changes. Generated host caches are excluded from the context.

The generic worker installs common tools, Chromium, Docker and mise in separate layers. Docker and mise version arguments are declared after Chromium so changing those pins does not reinstall the browser. Specialized workers that supply another Docker distribution can build with `--build-arg INSTALL_DOCKER_IO=false`; the generic default remains `true`.

Named-volume session transfers require Docker Engine 26.0 or newer (API 1.45+).
Export helpers mount only the retained `workspace/` and `tree/` subdirectories read-only.
The server rejects unsupported APIs instead of mounting the complete process volume.

## Quick start

1. Copy the sample config and edit it for your install:

   ```bash
   cp deploy/docker/config/leitwerk.example.yaml \
      deploy/docker/config/leitwerk.yaml
   ```

   Set `server.base_url` to your public hostname and point
   `worker_runtime_profiles.generic.image` at a published worker image.

2. Set the public hostname in `Caddyfile` (use `localhost` for local testing).

3. (Optional) Enable internal TLS: place the cert/key/CA under `deploy/docker/tls/`,
   uncomment the `internal_tls` block, change `docker.server_url` to `https://...`,
   and set `docker.server_ca_file` to the absolute host path for the CA file.
   The cert must carry a SAN for `leitwerk-server`.

4. Build the server image, extract the built UI for Caddy, and start:

   ```bash
   docker compose -f deploy/docker/docker-compose.yaml build leitwerk-server
   rm -rf deploy/docker/ui && mkdir -p deploy/docker/ui
   ui_source="$(docker create "leitwerk-server:${LEITWERK_IMAGE_TAG:-local}")"
   docker cp "$ui_source:/app/packages/ui/dist/." deploy/docker/ui/
   docker rm "$ui_source"
   docker compose -f deploy/docker/docker-compose.yaml up -d
   ```

   Re-extract `deploy/docker/ui` whenever you rebuild `leitwerk-server` so the
   SPA matches the server revision.

The server mounts the Docker Engine socket so its Docker runner can manage
worker containers on the same private network. On restart the server lists
labelled worker containers, adopts compatible live workers, records the fresh
server epoch on the durable lease, and stops only incompatible/orphaned workers
while keeping their volumes. Adoption normalizes the durable lease epoch; live
container labels are not mutated.

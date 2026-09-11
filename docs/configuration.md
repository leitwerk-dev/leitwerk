# Configuration Reference

**Leitwerk** is configured through `leitwerk.yaml` (or custom paths set by `LEITWERK_CONFIG_PATH`), environment variables, and extension options. This guide provides a complete reference for server network options, OIDC authentication, internal TLS, storage retention, LLM model profiles, worker runners, and extension loading.

---

## 1. Loading & Environment Overrides

Leitwerk loads built-in defaults overlaid with settings from `leitwerk.yaml`.

### Environment Variables

| Variable | Purpose | Default |
|---|---|---|
| `LEITWERK_CONFIG_PATH` | Path to your `leitwerk.yaml` file. | `./leitwerk.yaml` |
| `LEITWERK_CREDENTIAL_ENCRYPTION_KEY` | Base64 encoding of exactly 32 bytes for SQLite credential encryption (generate with `openssl rand -base64 32`). | None (Required) |
| `HOST` | Bind IP address for the server. | `127.0.0.1` |
| `PORT` | HTTP port for the server. | `3000` |
| `LEITWERK_BASE_URL` | Public base URL for HTTP and WebSocket auth. | `http://localhost:3000` |

### Reload Classes
- **Immediate:** Takes effect immediately when `leitwerk.yaml` is saved (e.g., worker pool limits).
- **Future:** Applies to future process launches or LLM turns.
- **Restart:** Requires a server restart (e.g., bind host/port, database paths, runner type).

---

## 2. Server, Authentication & Transport

Configure network binding, OIDC authentication, and internal transport TLS:

```yaml
server:
  host: 0.0.0.0
  port: 3000
  base_url: https://leitwerk.example.com

auth:
  enabled: true
  providers:
    - id: github
      kind: oauth2
      client_id: leitwerk-client
      client_secret: replace-me
      organization: example-org

internal_tls:
  enabled: true
  server_ca_file: /etc/leitwerk/ca.crt
```

- `auth.enabled`: When true, protects `/api/*` and `/ws` behind configured authentication.
- OIDC providers authorize identities through `auth.allowlist`. The native GitHub OAuth provider instead requires active membership in its configured organization and requests `read:org` so private membership works.
- GitHub OAuth Apps must register `<server.base_url>/auth/callback` as their callback URL.
- `internal_tls.enabled`: Enforces encrypted HTTPS/WSS transport between server and worker pods.

---

## 3. Storage & Retention

Configure database paths and worker storage retention:

```yaml
storage:
  sqlite_path: ./data/leitwerk.sqlite
  process_workspaces_dir: ./data/workspaces
  tree_files_dir: ./data/trees

session_transfer:
  max_entries: 250000
  max_logical_bytes: 21474836480
  max_compressed_bytes: 10737418240

workers:
  cleanup:
    completed_process_retention: 24h
    error_process_retention: 168h
```

- `storage.sqlite_path`: Path to SQLite database holding durable process state. Existing ticket-destination history is retained. The `20260823_add_ticket_destination_recents` migration backs up databases that lack the history table before adding it.
- `session_transfer.max_entries`: Maximum manifest, workspace, and session entries accepted by one transfer.
- `session_transfer.max_logical_bytes`: Maximum expanded regular-file bytes, enforced during server preflight and local extraction.
- `session_transfer.max_compressed_bytes`: Maximum compressed bytes, enforced by the server relay and local importer.
- Worker diagnostic traces are appended verbatim to `<storage.tree_files_dir>/diagnostic-traces/<instance-id>.log`.
- `workers.cleanup.completed_process_retention`: Duration to retain completed process storage before automatic volume cleanup.
- `workers.cleanup.error_process_retention`: Duration to retain errored or aborted process storage for diagnostics.

Retention controls when process volumes are removed. Leitwerk does not back them up or restore them. Its managed disaster-recovery workflow covers server-owned durable state. Operators may independently protect process volumes and are responsible for retention and restore testing; without that protection, volume loss can discard unpushed workspace changes and process-local tooling state.

Transfer links use `server.base_url` as their fixed origin. Non-loopback deployments must configure an HTTPS URL; request `Host` and forwarding headers cannot change the generated link origin.

---

## 4. Worker Runners & Supervision

Configure worker execution runtimes and process concurrency limits:

```yaml
development_tools:
  install_timeout: 30m
  local:
    mise_command: mise

workers:
  runner: docker # docker | kubernetes | local
  max_parallel_processes: 5
  startup_timeout: 45s
  heartbeat_interval: 15s

local_worker:
  command: node
  args: ["@leitwerk-dev/worker/worker-entry"]
  allow_host_docker: false

docker:
  socket: unix:///var/run/docker.sock
  network: leitwerk
  server_url: http://leitwerk-server:8080
  private_daemon:
    isolation: privileged # privileged | sysbox-runc

kubernetes:
  server_namespace: leitwerk-system
  default_worker_runtime_profile: standard
  pod:
    host_aliases:
      - ip: 192.0.2.10
        hostnames: [model-api.example.test]
  image_pull_secrets: [private-registry-pull]
  image_pull_secret_copies:
    - source_name: private-registry-pull
      target_name: private-registry-pull
```

- `workers.runner`: Selects container runner adapter (`docker`, `kubernetes`, or `local`).
- `workers.max_parallel_processes`: Maximum concurrent worker processes running across the server.
- `workers.heartbeat_interval`: Heartbeat cadence supplied to every LLM and automatic worker.
- `workers.stale_heartbeat_timeout`: Server failure threshold. Set it comfortably above the heartbeat interval.
- `development_tools.install_timeout`: Hard deadline for each opted-in repository's mise preparation. Defaults to `30m`.
- `development_tools.local.mise_command`: Host mise command used by local workers. It is validated only when an opted-in process starts.
- `local_worker.allow_host_docker`: Acknowledges that Docker processes inherit the host Docker context and credentials. Launch admission and worker startup each run `docker info` within `workers.startup_timeout`; the worker check is also bounded by its remaining startup deadline. A timeout kills the probe and rejects the launch or worker start.
- `docker.private_daemon.isolation`: Selects exactly one private-daemon isolation. `privileged` grants broad host-kernel authority. `sysbox-runc` requires that runtime on the Docker host. Neither mode mounts the host runtime socket.
- `kubernetes.server_namespace`: Management namespace housing the server Deployment.
- `kubernetes.docker`: Trusted RuntimeClass, `hostUsers`, and process StorageClass wiring for process definitions that declare `runtime.docker`. All three fields are required for those definitions to be available. Ordinary processes ignore this block.
- `kubernetes.pod.host_aliases`: Optional validated IPv4/IPv6 address and DNS-hostname mappings rendered into every dynamic worker Pod's `spec.hostAliases`.
- `kubernetes.image_pull_secrets`: Secret names referenced by worker Pods.
- `kubernetes.image_pull_secret_copies`: Named `kubernetes.io/dockerconfigjson` Secrets copied from the server namespace into each process namespace. Only `.dockerconfigjson` is copied.
- `workers.default_runtime_profile` (or `kubernetes.default_worker_runtime_profile`): Selects the trusted image used by isolated session-export helpers as well as the default worker image. The image must contain Leitwerk's bundled helper entrypoint; production references should be digest-pinned.

Worker launch configuration is immutable for a physical worker. Changes affect only newly created workers. Recycle existing workers explicitly when a change must apply immediately. Docker process state lives at `/state/tooling/docker` in the process volume and survives worker replacement. Kubernetes Docker processes use the configured RuntimeClass and Docker process StorageClass; the runner does not preflight cluster runtime infrastructure.

Private Docker workers use `unix:///var/run/docker.sock`. The container entrypoint overrides `DOCKER_HOST` and removes `DOCKER_CONTEXT`, `DOCKER_TLS`, `DOCKER_TLS_VERIFY`, and `DOCKER_CERT_PATH` inherited from the image. It preserves `DOCKER_CONFIG` for registry credentials. Local workers retain their host Docker configuration.

Private worker Docker daemons use the `overlay2` storage driver. The process volume must support OverlayFS with the selected kernel and container runtime. Before activation, verify image builds, nested container execution, and retained image reuse after worker replacement using the [runtime canaries](https://github.com/leitwerk-dev/leitwerk/blob/main/scripts/docker-runtime/README.md). A backing filesystem name alone does not establish compatibility.

Before upgrading existing private Docker workers, check their active storage driver with `docker info --format '{{.Driver}}'`. Verify replacement with the candidate image for existing `overlay2` stores. Processes using another driver must finish under the previous image before switching; any data migration requires a separate operation. Retaining the data directory does not make another driver's images and containers usable by `overlay2`.

An early private-daemon exit permits one retry within the same startup deadline. Both attempts use the existing Docker data directory. Startup failure never deletes or resets retained Docker data.

---

## 5. Model Profiles, Pi Runtime & Extensions

Configure LLM model catalogs, Pi agent settings, and extension loading:

```yaml
pi:
  agent_dir: /var/lib/leitwerk/pi-agent
  model_profiles:
    - id: gpt_sol_high
      provider: openai
      model_id: gpt-5.6-sol
      thinking_level: high

extension_loading:
  sources:
    - ./extensions/models
    - ./extensions/showcase-processes

extensions:
  models:
    openai:
      api_key: env:OPENAI_API_KEY
    anthropic:
      api_key: env:ANTHROPIC_API_KEY
    azure-openai-responses:
      api_key: env:AZURE_OPENAI_API_KEY
      base_url: env:AZURE_OPENAI_ENDPOINT
```
- `pi.model_profiles`: Catalog of LLM models made available to process definitions.
- `extension_loading.sources`: Extension package paths loaded during server startup. Load `./extensions/models` for standard API-key providers and configuration-defined custom gateways.
- `extensions.models.<provider>.base_url`: Optional non-secret HTTP(S) endpoint for a standard provider. Literal URLs and `env:VARIABLE` references are accepted. The normalized endpoint is used by workers and server-side model calls such as process-title generation.

Development compositions may add extension sources from a separate npm workspace without changing production configuration. See [Development Compositions](development-composition.md).

Provider-backed watchers live under the target process configuration. See
[Process Watchers](watchers.md) for an extension-owned source example. Profile secrets remain
server-only; LLM turns access providers through declared integration tools.

## API token policy

```yaml
auth:
  api_tokens:
    enabled: true
    default_ttl: 7d
    max_ttl: 90d
    allow_no_expiry: true
```

These defaults apply independently of `auth.enabled`. Durations must be positive,
valid durations; the default cannot exceed the maximum. Creation without
`expiresAt` uses the default TTL. An explicit ISO date-time must be after creation
and within the maximum TTL. Expiry takes effect at that timestamp. Explicit
`expiresAt: null` requests no expiration and requires `allow_no_expiry: true`.

Setting `enabled: false` blocks creation and bearer authentication while retaining
browser metadata listing and revocation. It never removes records or suppresses
the permanent anonymous-token revocation on authentication-enabled startup.
See [security](security.md#personal-and-anonymous-api-tokens) for provider binding,
anonymous ownership, and rollback.

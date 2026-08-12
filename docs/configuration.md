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

workers:
  cleanup:
    completed_process_retention: 24h
    error_process_retention: 168h
```

- `storage.sqlite_path`: Path to SQLite database holding durable process state.
- `workers.cleanup.completed_process_retention`: Duration to retain completed process storage before automatic volume cleanup.
- `workers.cleanup.error_process_retention`: Duration to retain failed/aborted process storage for diagnostics.

---

## 4. Worker Runners & Supervision

Configure worker execution runtimes and process concurrency limits:

```yaml
workers:
  runner: docker # docker | kubernetes | local
  max_parallel_processes: 5
  startup_timeout: 45s
  heartbeat_interval: 15s
  docker:
    image: leitwerk-worker-generic:latest

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
- `kubernetes.server_namespace`: Management namespace housing the server Deployment.
- `kubernetes.pod.host_aliases`: Optional validated IPv4/IPv6 address and DNS-hostname mappings rendered into every dynamic worker Pod's `spec.hostAliases`.
- `kubernetes.image_pull_secrets`: Secret names referenced by worker Pods.
- `kubernetes.image_pull_secret_copies`: Named `kubernetes.io/dockerconfigjson` Secrets copied from the server namespace into each process namespace. Only `.dockerconfigjson` is copied.

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

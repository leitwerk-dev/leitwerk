# Configuration Reference

Leitwerk is configured through `leitwerk.yaml` (or a custom path via `LEITWERK_CONFIG_PATH`), a small set of environment overrides, and extension-owned options. The annotated file [`leitwerk.yaml.example`](../leitwerk.yaml.example) is the full reference; this page summarizes the live contract.

---

## 1. Loading & Environment Overrides

Leitwerk loads built-in defaults, then overlays `leitwerk.yaml`. Search order when `LEITWERK_CONFIG_PATH` is unset: `./leitwerk.yaml`, then `~/.leitwerk/leitwerk.yaml`.

### Environment Variables

| Variable | Purpose | Default |
|---|---|---|
| `LEITWERK_CONFIG_PATH` | Path to the config file. | Search paths above |
| `LEITWERK_CREDENTIAL_ENCRYPTION_KEY` | 32-byte hex key for encrypted credential storage. | None (required when encrypted credentials exist) |
| `HOST` | Bind address override. | Config `server.host` (`127.0.0.1`) |
| `PORT` | HTTP port override. | Config `server.port` (**8080**) |
| `LEITWERK_BASE_URL` | Public base URL override. | Config `server.base_url` (`http://127.0.0.1:8080`) |

### Reload behavior

Config changes require a **process restart**. There is no “immediate on save” reload of running server state.

`npm run dev` is different: the development supervisor preflights the active configuration and then **restarts the development session** when that config changes, so the backend and browser source sets stay aligned. See the root [README](../README.md).

---

## 2. Server, Authentication & Internal TLS

```yaml
server:
  host: 127.0.0.1
  port: 8080
  base_url: http://127.0.0.1:8080

# Optional SSO. Only enabled: true turns auth on.
auth:
  enabled: true
  session:
    cookie_name: leitwerk_session
    ttl: 7d
  providers:
    - id: forgejo
      kind: oidc
      issuer: https://git.example.com
      client_id: "..."
      client_secret: "..."
      redirect_uri: https://leitwerk.example.com/auth/callback
      scopes: [openid, profile, email]
      identity_claim: preferred_username
  allowlist: [alice, bob]
```

- `auth.providers[]`: Nested OIDC providers (`kind: oidc`). There is no flat `auth.provider: oidc` shape.
- `auth.allowlist`: Values of the configured identity claim (for example `preferred_username`), **not** email addresses unless that claim is email.
- When auth is enabled, `server.base_url` and OIDC URLs must use HTTPS, except for loopback localhost development URLs.

Top-level `internal_tls` (when enabled) holds the **server** cert/key for the worker → server IPC listener:

```yaml
internal_tls:
  enabled: true
  cert_file: /etc/leitwerk/internal-server.crt
  key_file: /etc/leitwerk/internal-server.key
```

The CA workers trust is **not** on `internal_tls`. Set `server_ca_file` on the active runner block (`docker` or `kubernetes`), and use `https://...` for that runner’s `server_url`. Worker client certificates are not wired yet; `internal_tls.client_ca_file` is rejected.

---

## 3. Storage & Retention

```yaml
storage:
  sqlite_path: ./.leitwerk/leitwerk.sqlite
  process_workspaces_dir: ./.leitwerk/workspaces
  tree_files_dir: ./.leitwerk/trees

workers:
  cleanup:
    transient_ttl: 1h
    completed_process_retention: 168h
    error_process_retention: 720h
```

Use `sqlite_path` (not `database_path`). Retention durations live under `workers.cleanup`.

---

## 4. Worker Runners & Runtime Profiles

```yaml
workers:
  runner: docker   # docker | kubernetes | local
  max_parallel_processes: 4
  default_runtime_profile: generic
  heartbeat_interval: 5s
  stale_heartbeat_timeout: 30s

# Top-level runner wiring (not nested under workers):
local_worker:
  command: node
  args: ["@leitwerk-dev/worker/worker-entry"]

docker:
  socket: unix:///var/run/docker.sock
  network: leitwerk
  server_url: http://leitwerk-server:8080
  # server_ca_file: /etc/leitwerk/internal-ca.pem
  process_volume:
    mode: bind
    host_root: /var/lib/leitwerk/processes
    mount_path: /state

worker_runtime_profiles:
  generic:
    image: ghcr.io/example/leitwerk-worker-generic:0.1.0
```

- `workers.runner` selects the adapter. Image selection is via `worker_runtime_profiles` (and runner defaults), **not** `workers.docker.image`.
- Kubernetes mode uses a top-level `kubernetes:` block (see the example file).
- `local` is best-effort developer/test mode only; Docker/Kubernetes define production behavior.

---

## 5. Models, Pi Runtime & Extensions

Model catalogs live under `pi.model_profiles`. Provider credentials and custom gateways are owned by loaded extensions (typically `./extensions/models` under `extension_loading.sources` and `extensions.models.*`).

Do not duplicate the full models contract here — see [Models](models.md). Development compositions can add external extension sources without changing production config — see [Development Compositions](development-composition.md).

```yaml
pi:
  agent_dir: ~/.pi/leitwerk
  # model_profiles: [...]

extension_loading:
  sources:
    - ./extensions/models
    - ./extensions/showcase-processes

extensions:
  # models:
  #   openai:
  #     api_key: env:OPENAI_API_KEY
```

Process-scoped runtime defaults (for example watcher enablement and launch defaults) live under `process_configs.<processId>`, not as config-defined process types.

---

## 6. Present but not behavioral

`notifications` and `sandbox` appear in the schema and example file. They are accepted and defaulted today but are **not** live product behavior yet. Prefer omitting them from operator-facing “how it works” setup unless you are mirroring the example file.

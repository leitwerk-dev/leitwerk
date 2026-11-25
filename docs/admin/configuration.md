# Configuration reference

Configure Leitwerk in `leitwerk.yaml`. Configuration supplies wiring, credentials, model catalogs, and runtime defaults; process types, turn graphs, transitions, and actions are defined in code.

Built-in defaults below may differ from `leitwerk.yaml.example`. Never use placeholder worker images or `:memory:` storage for durable deployments.

## Loading and environment overrides

The server overlays `leitwerk.yaml` onto built-in defaults. Arrays replace defaults rather than appending; an explicit `worker_runtime_profiles` map replaces the default map.

Without `LEITWERK_CONFIG_PATH`, the server searches `./leitwerk.yaml`, then `~/.leitwerk/leitwerk.yaml`. Relative `extension_loading.sources` paths resolve from the config file's directory. A configuration file with `pi.model_profiles` and an explicit `pi.default_model_profile` is required.

| Environment variable | Effect | Default |
| --- | --- | --- |
| `LEITWERK_CONFIG_PATH` | Path to `leitwerk.yaml`. | Search order above. |
| `LEITWERK_CREDENTIAL_ENCRYPTION_KEY` | Base64 encoding of 32 bytes; required to read or write encrypted provider credentials. Omitting it fails startup whenever `provider_credentials` is non-empty or configured providers seed credentials. | None. |
| `HOST` | Overrides `server.host`. | Configured host. |
| `PORT` | Overrides `server.port`. | Configured port. |
| `LEITWERK_BASE_URL` | Overrides `server.base_url`. | Configured URL. |
| `LEITWERK_LOCAL_WORKER_COMMAND` | Overrides `local_worker.command`. | Configured command (`node`). |
| `LEITWERK_LOCAL_WORKER_ARGS_JSON` | JSON string array overriding `local_worker.args`. | Configured args. |

Restart the production server after changing YAML (there is no live reload). Physical workers keep their captured settings until replacement, model changes affect only future LLM calls, and storage sizing/classes apply only to new claims.

## Server, authentication, and transport

| Key | Type / default | Contract |
| --- | --- | --- |
| `server.host` | String; `127.0.0.1` | Listen address (`0.0.0.0` in containers). |
| `server.port` | Number; `8080` | Listen port. |
| `server.base_url` | URL; `http://127.0.0.1:8080` | Public application origin for auth redirects, CSRF Origin checks, and generated links (never derived from request `Host` or forwarding headers). |
| `server.websocket.heartbeat_interval` | Duration; `10s` | Browser WebSocket heartbeat cadence. |
| `server.websocket.client_timeout` | Duration; `30s` | Browser WebSocket liveness timeout. |
| `server.websocket.toast_ttl` | Duration; `6s` | UI notification duration. |
| `auth.enabled` | Boolean; `false` | Enables the application-wide login boundary. |
| `auth.providers` | Provider list; none | Exactly one provider when enabled: OIDC (`kind: oidc`) or GitHub (`id: github`, `kind: oauth2`). |
| `auth.allowlist` | String list; none | Deprecated OIDC admission list; cannot be combined with provider `access`. |
| `auth.session.cookie_name` | String; `leitwerk_session` | Browser session cookie name. |
| `auth.session.ttl` | Duration; `7d` | Browser session lifetime. |
| `internal_tls.enabled` | Boolean; `false` | Enables TLS on the server listener used by workers. |
| `internal_tls.cert_file`, `internal_tls.key_file` | PEM paths; none | Required when `internal_tls.enabled` is `true`. `internal_tls.client_ca_file` is rejected. |

Non-loopback auth and session-transfer origins require HTTPS.

- **OIDC provider fields**: `id`, `kind: oidc`, `issuer`, `client_id`, `client_secret`, and optional `redirect_uri` (default `<server.base_url>/auth/callback`), `scopes` (default `[openid, profile, email]`), `identity_claim` (default `preferred_username`), and `access`. OIDC `client_secret` accepts `${ENV_VAR}` placeholders expanded once, non-recursively at startup (missing or empty variables fail startup). `${ENV_VAR}` expansion applies only to OIDC `client_secret`, not GitHub `client_secret` or other fields.
- **GitHub provider fields**: `id: github`, `kind: oauth2`, `client_id`, `client_secret` (literal value; `${ENV_VAR}` placeholders are not expanded), `organization`, optional `redirect_uri` (default `<server.base_url>/auth/callback`). Register `<server.base_url>/auth/callback` with `read:org`.

### OIDC `access` policy

Without `access`, OIDC uses `auth.allowlist` (omitted or empty admits nobody). Combining `access` and `auth.allowlist` fails validation.

| Key under `auth.providers[].access` | Type / default | Contract |
| --- | --- | --- |
| `mode` | `all` \| `restricted`; required | `all` admits any authenticated identity (rejects criteria, `match`, `groups_claim`). `restricted` requires at least one criterion. |
| `match` | `all` \| `any`; `all` | `all` requires every configured criterion; `any` requires one. |
| `users` | String list; none | Exact values of `identity_claim`. |
| `groups` | String list; none | Exact, case-sensitive entries from `groups_claim`. |
| `groups_claim` | String; `groups` | Claim holding a string array. |
| `email_domains` | Domain list; none | Exact, case-insensitive domains (no subdomains); requires `email_verified: true`. |

### API token policy

Applies independently of `auth.enabled`. See [Security](security.md#api-tokens) for ownership, CSRF, and revocation contracts.

| Key under `auth.api_tokens` | Type / default | Contract |
| --- | --- | --- |
| `enabled` | Boolean; `true` | Enables token issuance and Bearer authentication. |
| `default_ttl` | Positive duration; `7d` | Expiry when omitted from creation requests. |
| `max_ttl` | Positive duration; `90d` | Maximum dated expiry (`>= default_ttl`). |
| `allow_no_expiry` | Boolean; `true` | Allows explicit `expiresAt: null`. |

## Storage, retention, and session transfer

| Key | Type / default | Contract |
| --- | --- | --- |
| `storage.sqlite_path` | Path; `:memory:` | Durable SQLite path. Use an absolute file path in deployments. |
| `storage.process_workspaces_dir` | Path; `/tmp/leitwerk/workspaces` | Host workspaces for `local` runner. |
| `storage.tree_files_dir` | Path; `/tmp/leitwerk/trees` | Server-owned session snapshots and verbatim `diagnostic-traces/`. |
| `workers.cleanup.completed_process_retention` | Duration; `168h` | Retention for completed process volumes and result images. |
| `workers.cleanup.error_process_retention` | Duration; `720h` | Retention for errored/aborted process volumes and result images. |
| `workers.cleanup.transient_ttl` | Duration; `1h` | Retention for transient resources. |
| `session_transfer.max_entries` | Integer (`>= 3`); `250000` | Export/import entry limit. |
| `session_transfer.max_logical_bytes` | Positive integer; `21474836480` | Expanded regular-file byte limit (20 GiB). |
| `session_transfer.max_compressed_bytes` | Positive integer; `10737418240` | Compressed transfer byte limit (10 GiB). |

Retention controls deletion, not backups. See [Backup and upgrades](backup-and-upgrades.md) and [Process workspace](../maintainers/process-workspace.md).

## Workers and runtime profiles

| Key under `workers` | Type / default | Contract |
| --- | --- | --- |
| `runner` | `docker` \| `kubernetes` \| `local`; `docker` | Worker execution environment. |
| `default_runtime_profile` | Profile ID; `generic` | Fallback runtime profile. |
| `max_parallel_processes` | Number; `8` | Cap on allocated workers and in-flight allocations; excess starts queue FIFO. |
| `startup_timeout` | Duration; `30s` | Worker startup deadline after capacity admission. |
| `shutdown_grace_period` | Duration; `15s` | Graceful shutdown window. |
| `heartbeat_interval` | Duration; `5s` | Worker heartbeat cadence. |
| `stale_heartbeat_timeout` | Duration; `30s` | Heartbeat failure threshold. |
| `turn_max_duration` | Duration; `30m` | Maximum duration for one turn. |
| `turn_inactivity_timeout` | Duration; `5m` | Inactivity deadline for one turn. |
| `turn_abort_grace_period` | Duration; `5s` | Grace period after turn abort. |
| `resume_on_boot` | Boolean; `true` | Reconcile active starts on server boot. |
| `idle_worker_ttl` | Duration; `0s` | Retention of idle physical workers. |
| `session_snapshot_max_size_bytes` | Positive integer; `134217728` | Max session snapshot upload size (128 MiB). |
| `log_worker_events_to_stdout` | Boolean; `false` | Mirrors raw worker events to stdout (noisy; may contain sensitive data). |

### Worker runtime profiles

`worker_runtime_profiles.<id>` defines `image`, optional `image_pull_policy`, and optional `resources.requests` / `resources.limits` (each with string `cpu` and `memory`; top-level `resources.{cpu,memory}` alias limits).

Profile selection order:

1. `process_configs.<processId>.worker_runtime_profile`
2. `components.<key>.worker_runtime_profile` (conflicting component profiles are rejected)
3. `kubernetes.docker.worker_runtime_profile` (Kubernetes `runtime.docker` processes only)
4. Runner default (`kubernetes.default_worker_runtime_profile` in Kubernetes mode, otherwise `workers.default_runtime_profile`)

Repository content can never select an image. Local workers ignore image and resource profiles.

### Local runner

| Key | Default | Contract |
| --- | --- | --- |
| `local_worker.command` | `node` | Worker executable. |
| `local_worker.args` | `["@leitwerk-dev/worker/worker-entry"]` | Worker arguments. |
| `local_worker.allow_host_docker` | `false` | Explicit opt-in allowing Docker processes to use the host Docker CLI context and credentials. |
| `development_tools.install_timeout` | `30m` | Per-repository `mise` installation deadline for opted-in processes. |
| `development_tools.local.mise_command` | `mise` | Host `mise` executable. |

### Docker runner

See [Docker deployment](deploy-docker.md) for Compose topology, volume modes, and private Docker isolation.

| Key under `docker` | Default | Contract |
| --- | --- | --- |
| `socket` | `unix:///var/run/docker.sock` | Host Docker Engine socket mounted into the server. |
| `network` | `leitwerk` | Shared bridge network for server and workers. |
| `server_url` | `http://leitwerk-server:8080` | Internal server URL reached by workers (`https://` when `internal_tls.enabled`). |
| `server_ca_file` | None | Host-visible CA path mounted into workers when `internal_tls.enabled`. |
| `process_volume.mode` | `bind` | `bind` or `named_volume`. |
| `process_volume.host_root` | `/var/lib/leitwerk/processes` | Host root directory for `bind` mode. |
| `process_volume.mount_path` | `/state` | Mount path inside worker containers. |
| `private_daemon.isolation` | None | Required for `runtime.docker` processes: `privileged` or `sysbox-runc`. |

### Kubernetes runner

See [Kubernetes deployment](deploy-kubernetes.md) for Helm coordination, preflight upgrades, warm volume pools, image preloading, and private Docker isolation.

| Key under `kubernetes` | Default | Contract |
| --- | --- | --- |
| `server_namespace` | `leitwerk-system` | Dedicated server namespace (must not match `process_namespace_prefix`). |
| `process_namespace_prefix` | `leitwerk-process-` | Lowercase DNS prefix ending in `-` (max 40 chars). |
| `server_url` | `http://leitwerk-server.leitwerk-system.svc.cluster.local:8080` | Worker-reachable server URL (`https://` when `internal_tls.enabled`). |
| `server_ca_file` | None | Server-local CA file copied into process namespaces when `internal_tls.enabled`. |
| `api_server_url` | In-cluster API | Optional Kubernetes API server URL override. |
| `default_worker_runtime_profile` | `generic` | Runner default profile. |
| `worker_service_account` | `leitwerk-worker` | ServiceAccount name in process namespaces. |
| `image_preload.enabled` | `false` | Pre-pull digest-qualified worker images onto eligible nodes. |
| `process_volume.reclaim_on_close` | `false` | Delete completed/aborted/deleted process PVs via CSI. |
| `process_volume.storage_class_name` | Cluster default | Ordinary process PVC StorageClass (required for `pre_provision`). |
| `process_volume.pre_provision.count` | Omitted (disabled) | Non-negative integer warm volume count (`0` drains). |
| `process_volume.size` | `20Gi` | Fallback PVC capacity for new claims. |
| `process_volume.access_modes` | `[ReadWriteOnce]` | Non-empty PVC access modes. |
| `process_volume.mount_path` | `/state` | Mount path inside worker Pods. |
| `docker.*` | None | `runtime_class_name`, `process_storage_class_name`, `isolation` (`gvisor` \| `virtual-machine`) or `host_users`, optional `worker_runtime_profile`, `node_selector`, and `network` (`bridge_cidr`, `address_pools`, `dns`). |
| `pod.node_selector`, `pod.annotations` | `{}` | Worker Pod scheduling and metadata. |
| `pod.tolerations` | `[]` | Worker Pod tolerations. |
| `pod.host_aliases` | `[]` | Entries of valid IPv4/IPv6 `ip` and non-empty lowercase DNS `hostnames`. |
| `image_pull_secrets` | `[]` | Secret names attached to worker Pods. |
| `image_pull_secret_copies` | `[]` | `{ source_name, target_name }` pairs copied from `server_namespace` (`.dockerconfigjson` only). |

### Docker registry credentials

`docker_registries.profiles.<id>` sets `registry`, `username`, and `password`. `docker_registries.process_bindings.<processId>` lists profile IDs (duplicate registry hosts fail validation). Delivered only to code-defined `runtime.docker` processes via ephemeral `DOCKER_CONFIG` and `HELM_REGISTRY_CONFIG`. See [Security](security.md#docker-registry-credentials).

## Models, prompts, and extensions

| Key | Default | Contract |
| --- | --- | --- |
| `pi.agent_dir` | `~/.pi/leitwerk` | Managed resource/credential root; ambient `~/.pi/agent` is ignored. |
| `pi.default_model_profile` | Required; none | Profile ID in `pi.model_profiles`; missing, blank, or unknown fails startup. |
| `pi.model_profiles` | `[]` | Model profile catalog (`id`, `provider`, `model_id`, optional `thinking_level`, `provider_options`). See [Models](models.md). |
| `pi.system_prompt_template` | Built-in prompt | Global Mustache system-prompt template. |
| `pi.process_title_generation.model_profile` | `null` | Optional configured profile ID for server-side process titles. |
| `pi.process_title_generation.retry` | `max_attempts: 6`, `base_delay: 5s`, `max_delay: 5m` | Retry policy for title generation (`max_attempts >= 1`). |
| `pi.retry` | `enabled: true`, `max_retries: 3`, `base_delay: 2s` | Pi session retry settings for new sessions. |
| `pi.retry.provider` | `timeout: null`, `max_retries: null`, `max_retry_delay: 60s` | `null` defers to provider SDK defaults. |
| `extension_loading.sources` | `[]` | Extension paths (relative to config file) or package specifiers. |
| `extensions.<extensionId>` | `{}` | Owner-parsed extension configuration; see each extension's README. |

### Per-process overrides (`process_configs.<processId>`)

| Key under `process_configs.<processId>` | Contract |
| --- | --- |
| `default_model_profile` | Process-level default model profile ID. |
| `allowed_model_profiles` | Non-empty list of configured profile IDs, intersected with model requirements. |
| `model_requirements` | Process-level profile, capability, and label restrictions. |
| `turn_configs.<turnId>.model_profile` | Per-turn default model profile ID. |
| `turn_configs.<turnId>.model_requirements` | Turn-level restrictions that further narrow the process requirements. |
| `worker_runtime_profile` | Process-level worker runtime profile ID. |
| `storage_size` | Positive Kubernetes quantity (e.g., `128Mi`, `50Gi`) for new PVCs; ignored by local/Docker runners. |
| `default_skills` | Installed skill IDs replacing global `default_skills` (omit to inherit; `[]` opts out). |
| `pi.system_prompt_template` | Replaces the global system-prompt template for this process. |
| `pi.append_system_prompt_template` | Appends a Mustache fragment to the resolved system prompt. |
| `watchers.<watcherId>` | Extension-owned watcher settings. See [Watchers](../extensions/watchers.md). |

See [classification and requirements](models.md#classification-and-requirements) for the predicate syntax and how operator settings combine with code-defined restrictions.

## Repositories, skills, commit messages, and notifications

- **`components.<key>`**: Defines `repo`, `default_branch`, and optional `worker_runtime_profile`.
- **`skill_repositories`**: List of `{ id, url, ref, label?, path? }` (`path` defaults to `skills`). Registers Git sources for operator-installed skills; launches pin active revisions. Extension-bundled [skill packs](../extensions/skill-packs.md) install automatically.
- **`default_skills`**: Installed skill IDs automatically included in new launches (default `[]`). Combined with explicit selections and deduplicated; unavailable IDs block launch rather than auto-installing.
- **`commit_messages`**: Defines `templates.<id>.rules`, `default_template` (or `null`), and `repositories` mapping normalized repository locators to template IDs (repository match wins over fallback; pinned at launch).
- **`notifications`**: `all` and `debug` take `{ enabled, type, url }`; `squad` takes `{ enabled, type, routing_field, routes }`. All default to disabled with `type: teams_webhook`.
- **`sandbox`**: `{ enabled: false, profile: "" }`. For the source UI sandbox, see [Development compositions](../maintainers/development-compositions.md).

```yaml
default_skills: [shared-guidance]
process_configs:
  review_process:
    default_skills: [review-guidance]
  minimal_process:
    default_skills: []
```

Non-secret runtime defaults can also be edited without restart via [Settings](../users/settings.md) (see [Scoped settings](../extensions/scoped-settings.md) for extension contracts).

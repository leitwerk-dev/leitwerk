# Configuration

Configure Leitwerk in `leitwerk.yaml`. Configuration supplies wiring, credentials,
model catalogs, and runtime defaults. Process types, turns, transitions, actions,
and completion rules belong in code.

Start with [local setup](introduction.md), [Docker](docker-deployment-guide.md), or
[Kubernetes](kubernetes-deployment-guide.md). The tables below describe built-in
defaults, which may differ from
[`leitwerk.yaml.example`](https://github.com/leitwerk-dev/leitwerk/blob/main/leitwerk.yaml.example).
Do not use placeholder worker images or an in-memory database for a durable deployment.

## Loading and changes

The server overlays YAML on built-in defaults. Arrays replace their defaults;
they are not appended. An explicitly supplied `worker_runtime_profiles` map
replaces the default profile map.

`LEITWERK_CONFIG_PATH` selects the configuration file. Without it, the server looks
for `./leitwerk.yaml`, then `~/.leitwerk/leitwerk.yaml`. Relative extension source
paths resolve from that file's directory. Use absolute storage paths in deployments.

| Environment variable | Effect | Default |
| --- | --- | --- |
| `LEITWERK_CONFIG_PATH` | Configuration path. | Search paths above. |
| `LEITWERK_CREDENTIAL_ENCRYPTION_KEY` | Base64 encoding of exactly 32 bytes; required to read or write stored credentials. | None. |
| `HOST` | Overrides `server.host`. | Configured host. |
| `PORT` | Overrides `server.port`. | Configured port. |
| `LEITWERK_BASE_URL` | Overrides `server.base_url`. | Configured URL. |

Restart the production server after changing YAML. Source development preflights
configuration changes and restarts the development session. Saving a production
file is not a live-reload API.

Settings captured by a physical worker remain fixed until replacement. Model
selection changes affect future LLM calls, never the call in flight. Storage sizes
and StorageClasses apply only to new claims. Retention changes do not make backups.

## Server, authentication, and transport

| Key | Type / default | Contract |
| --- | --- | --- |
| `server.host` | String; `127.0.0.1` | Listener address. Use `0.0.0.0` inside a container. |
| `server.port` | Number; `8080` | Listener port. |
| `server.base_url` | URL; `http://127.0.0.1:8080` | Public application origin for authentication and generated links. |
| `server.websocket.heartbeat_interval` | Duration; `10s` | Browser heartbeat interval. |
| `server.websocket.client_timeout` | Duration; `30s` | Browser liveness timeout. |
| `server.websocket.toast_ttl` | Duration; `6s` | Notification display duration. |
| `auth.enabled` | Boolean; `false` | Enables the application-wide login boundary. |
| `auth.providers` | Provider list; none | Configure one OIDC or native GitHub provider. |
| `auth.allowlist` | String list; none | Allowed OIDC identity-claim values; GitHub uses organization membership. |
| `auth.session.cookie_name` | String; `leitwerk_session` | Browser session cookie name. |
| `auth.session.ttl` | Duration; `7d` | Browser session lifetime. |
| `internal_tls.enabled` | Boolean; `false` | Enables TLS for the server listener used by workers. |
| `internal_tls.cert_file`, `internal_tls.key_file` | PEM file paths; none | Required when internal TLS is enabled. |

Non-loopback authentication and session-transfer origins require HTTPS. Generated
links use `server.base_url`, not request `Host` or forwarding headers. Public
HTTPS termination and worker trust configuration are separate concerns.

OIDC provider fields are `id`, `kind: oidc`, `issuer`, `client_id`, `client_secret`,
and optional `redirect_uri`, `scopes`, and `identity_claim`. Native GitHub fields
are `id: github`, `kind: oauth2`, `client_id`, `client_secret`, `organization`, and
optional `redirect_uri`. Register `<server.base_url>/auth/callback` with GitHub;
its `read:org` scope permits private organization membership checks.

Worker CA trust belongs in `docker.server_ca_file` or
`kubernetes.server_ca_file`, not `internal_tls`. Worker client certificates are not
supported; `internal_tls.client_ca_file` is rejected. See [Security](security.md).

### API token policy

| Key under `auth.api_tokens` | Type / default | Contract |
| --- | --- | --- |
| `enabled` | Boolean; `true` | Enables issuance and bearer authentication. |
| `default_ttl` | Positive duration; `7d` | Expiry when the creation request omits it. |
| `max_ttl` | Positive duration; `90d` | Maximum dated expiry; must be at least the default TTL. |
| `allow_no_expiry` | Boolean; `true` | Allows explicit `expiresAt: null`. |

These settings apply independently of `auth.enabled`. A dated expiry must be after
creation and within the maximum TTL. Disabling tokens retains metadata listing and
revocation; it does not delete records. Authentication-enabled startup permanently
revokes anonymous tokens even when token support is disabled. See
[token ownership and rollback](security.md#personal-and-anonymous-api-tokens).

## Storage and retention

| Key | Type / default | Contract |
| --- | --- | --- |
| `storage.sqlite_path` | Path; `:memory:` | Durable state database. Set a file path for retained work. |
| `storage.process_workspaces_dir` | Path; `/tmp/leitwerk/workspaces` | Host workspaces for local execution. |
| `storage.tree_files_dir` | Path; `/tmp/leitwerk/trees` | Server-owned session snapshots and diagnostics. |
| `workers.cleanup.completed_process_retention` | Duration; `168h` | Retention before completed process-volume cleanup. |
| `workers.cleanup.error_process_retention` | Duration; `720h` | Retention for errored or aborted process volumes. |
| `workers.cleanup.transient_ttl` | Duration; `1h` | Retention for transient resources. |
| `session_transfer.max_entries` | Positive integer; `250000` | Manifest, workspace, and session entry limit. |
| `session_transfer.max_logical_bytes` | Positive integer; `21474836480` | Expanded regular-file byte limit. |
| `session_transfer.max_compressed_bytes` | Positive integer; `10737418240` | Compressed transfer byte limit. |

Session transfers enforce limits on both export and import. Worker diagnostic traces
are stored verbatim under `diagnostic-traces/` in the tree directory; treat them as
sensitive. Retention controls deletion, not protection from volume loss. See
[Backup and upgrades](operations.md) and [workspace layout](process-workspace.md).

### Per-process storage size

`process_configs.<processId>.storage_size` requests new Kubernetes PVC capacity.
Use a positive Kubernetes quantity such as `128Mi`, `1Gi`, or `50Gi`. Invalid
quantities fail validation.

Selection order:

1. Explicit process setting.
2. The process definition's server-side `resolveStorageSize({ params, projects })`.
3. `kubernetes.process_volume.size`, default `20Gi`.

Explicit settings bypass the resolver. Invalid resolver results fail worker startup;
they do not silently fall back. The size covers the whole process volume, including
repositories, trees, and tooling. It is not a repository download estimate or quota.

Existing PVCs keep their capacity across retries and replacement. Configuration
never expands, shrinks, or recreates them. Local and Docker runners ignore this
setting and never invoke the resolver. StorageClass selection is independent.

A PVC request is a minimum; a provider or available PV may supply more. Leave
pre-provisioning disabled when varied process sizes need minimum allocation:
pre-provisioned global-size volumes can satisfy smaller claims.

### Pre-provisioned Kubernetes volumes

Set `kubernetes.process_volume.pre_provision: { count: 8 }` to maintain fresh volumes
in `storage_class_name`. Omit it to disable. With Helm, also set
`kubernetes.processVolume.preProvision.enabled=true` and its `count` to grant the
required PV and StorageClass permissions. Existing config Secrets need the server
setting too.

The driver must support dynamic filesystem provisioning through a copied StorageClass
and rebinding retained PVs. Preparation uses worker node selection and tolerations;
topology-bound volumes may not serve other nodes. Docker's separate process
StorageClass is unaffected. Pool misses use normal dynamic provisioning.

Unused volumes consume normal storage and billing resources. Process volumes are
never recycled. Set `count: 0` to stop replenishment and let prepared volumes drain.
Reducing the count does not delete them. Before removing the setting or changing
class, wait for preparation PVCs in the server namespace to disappear. Inspect
`leitwerk.dev/volume-pool` resources and server warnings if preparation stalls;
do not clear process claim references to resolve ownership conflicts.

## Worker supervision

| Key under `workers` | Type / default | Contract |
| --- | --- | --- |
| `runner` | `docker`, `kubernetes`, or `local`; `docker` | Selects execution environment. Local is development/test only. |
| `default_runtime_profile` | Profile ID; `generic` | Fallback image profile. Configure a real image. |
| `max_parallel_processes` | Number; `8` | Counts allocated workers and in-flight allocations. Excess starts queue FIFO. |
| `startup_timeout` | Duration; `30s` | Startup deadline after capacity admission; excludes queue time. |
| `shutdown_grace_period` | Duration; `15s` | Grace period for shutdown. |
| `heartbeat_interval` | Duration; `5s` | Cadence supplied to LLM and automatic workers. |
| `stale_heartbeat_timeout` | Duration; `30s` | Failure threshold; keep comfortably above heartbeat cadence. |
| `turn_max_duration` | Duration; `30m` | Maximum turn duration. |
| `turn_inactivity_timeout` | Duration; `5m` | Turn inactivity deadline. |
| `turn_abort_grace_period` | Duration; `5s` | Grace period after turn interruption. |
| `resume_on_boot` | Boolean; `true` | Reconcile retained active starts at startup. |
| `idle_worker_ttl` | Duration; `0s` | Retention of idle physical workers. |
| `session_snapshot_max_size_bytes` | Positive integer; `134217728` | Maximum session snapshot HTTP upload. |
| `log_worker_events_to_stdout` | Boolean; `false` | Mirrors raw worker events for diagnostics; can be noisy and sensitive. |

See [lifecycle](server-worker-lifecycle.md) for acceptance, queueing, and recovery.

### Worker runtime profiles

`worker_runtime_profiles.<id>` defines `image`, optional `image_pull_policy`, and
optional `resources.requests` and `resources.limits`, each with string `cpu` and
`memory` quantities. Legacy `resources.cpu` and `resources.memory` mean limits.
Kubernetes forwards requests independently of limits.

Selection order is process `worker_runtime_profile`, component
`worker_runtime_profile`, then the runner default. Conflicting component profiles
are rejected. Kubernetes uses `kubernetes.default_worker_runtime_profile` before
`workers.default_runtime_profile`. Local execution ignores image/resource settings.

Default runner images also execute isolated session-export helpers and must contain
Leitwerk's bundled helper. Pin production images by digest and keep server/worker
versions compatible. Repository content must never select an image.

### Local runner

| Key | Default | Contract |
| --- | --- | --- |
| `local_worker.command` | `node` | Worker executable. Source development supplies its own source entry. |
| `local_worker.args` | `["@leitwerk-dev/worker/worker-entry"]` | Arguments passed to the executable. |
| `local_worker.allow_host_docker` | `false` | Acknowledges host Docker authority for Docker-requiring processes. |
| `development_tools.install_timeout` | `30m` | Per-repository mise preparation deadline for opted-in processes. |
| `development_tools.local.mise_command` | `mise` | Host mise executable; checked when an opted-in process starts. |

Docker-enabled local starts run `docker info` at launch and worker bootstrap, bounded
by the startup deadline. Local workers retain the host Docker context and credentials;
this is not container isolation.

### Docker runner

| Key under `docker` | Default | Contract |
| --- | --- | --- |
| `socket` | `unix:///var/run/docker.sock` | Server access to the host container engine. |
| `network` | `leitwerk` | Shared private server/worker network. |
| `server_url` | `http://leitwerk-server:8080` | Stable internal address reachable from workers. |
| `server_ca_file` | None | Host-visible CA path for internal TLS. |
| `process_volume.mode` | `bind` | `bind` or `named_volume`. |
| `process_volume.host_root` | `/var/lib/leitwerk/processes` | Host root for bind volumes. |
| `process_volume.mount_path` | `/state` | Worker mount. |
| `private_daemon.isolation` | None | Required for Docker-requiring processes: `privileged` or `sysbox-runc`. |

`privileged` grants broad host-kernel authority. `sysbox-runc` requires that runtime
on the Docker host. Neither mounts the host engine socket into the worker.

### Kubernetes runner

| Key under `kubernetes` | Default | Contract |
| --- | --- | --- |
| `server_namespace` | `leitwerk-system` | Server management namespace. |
| `process_namespace_prefix` | `leitwerk-process-` | Prefix for per-process namespaces. |
| `server_url` | `http://leitwerk-server.leitwerk-system.svc.cluster.local:8080` | Worker-reachable server URL; match your Service name. |
| `server_ca_file` | None | Server-local CA copied into process namespaces. |
| `api_server_url` | In-cluster API | Optional Kubernetes API override. |
| `default_worker_runtime_profile` | `generic` | Runner default profile. |
| `worker_service_account` | `leitwerk-worker` | ServiceAccount used by workers. |
| `process_volume.storage_class_name` | Cluster default | Ordinary process storage. |
| `process_volume.size` | `20Gi` | Fallback capacity for new claims. |
| `process_volume.access_modes` | `[ReadWriteOnce]` | PVC access modes. |
| `process_volume.mount_path` | `/state` | Worker mount. |
| `pod.node_selector`, `pod.annotations` | Empty maps | Worker scheduling and metadata. |
| `pod.tolerations` | Empty list | Worker tolerations. |
| `pod.host_aliases` | Empty list | Valid IPv4/IPv6 `ip` and nonempty DNS `hostnames`. |
| `image_pull_secrets` | Empty list | Secret names referenced by worker Pods. |
| `image_pull_secret_copies` | Empty list | Explicit `source_name` / `target_name` pairs copied from the server namespace. |

Pull-secret copies accept only `kubernetes.io/dockerconfigjson` and copy only
`.dockerconfigjson`. Match the copy names in Helm values to grant access.

For Docker-requiring processes, `kubernetes.docker` needs `runtime_class_name` and
`process_storage_class_name`. Set `gvisor: true` for the verified runsc wrapper and
omit `host_users`; other runtimes need an explicit `host_users` boolean. Operators
must install and select the runtime and compatible nodes. Ordinary processes ignore
this block. See [isolation boundaries](security.md#2-secrets-container-isolation).

Optional `kubernetes.docker.network` supplies trusted `bridge_cidr`, `address_pools`
(`base`, `size`), and `dns`. Unknown fields and pool sizes smaller than their base
prefix are rejected. Existing PVC StorageClasses are never migrated.

### Private Docker state

Private daemons use `overlay2` and retain data at `/state/tooling/docker`. The process
volume, kernel, and runtime must support OverlayFS together. Verify builds, nested
containers, and image reuse after replacement using the
[runtime canaries](https://github.com/leitwerk-dev/leitwerk/blob/main/scripts/docker-runtime/README.md).
A filesystem name alone does not establish compatibility.

Private workers use the local Unix socket, not inherited Docker endpoint settings.
Registry credentials use a private ephemeral `DOCKER_CONFIG`. One early daemon-exit
retry is allowed within the same deadline; failures never reset retained data.
See [upgrade precautions](operations.md#upgrade-and-rollback) for existing stores.

### Docker registry credentials

`docker_registries.profiles.<id>` supplies `registry`, `username`, and `password`.
`docker_registries.process_bindings.<processId>` lists profile IDs. Duplicate
registry hosts in a binding fail validation.

Only code-defined Docker-requiring processes receive credentials, resolved anew for
each physical start. Process parameters cannot select profiles. Bindings control
delivery, not registry-side permissions. See [credential security](security.md#docker-registry-credentials).

## Models, resources, and process defaults

| Key | Default | Contract |
| --- | --- | --- |
| `pi.agent_dir` | `~/.pi/leitwerk` | Managed resource/credential root; ambient Pi files are ignored. |
| `pi.model_profiles` | Empty list | Named model choices; see [Models](models.md). |
| `pi.system_prompt_template` | Built-in prompt | Global Mustache system-prompt template. |
| `pi.process_title_generation.model_profile` | `null` | Optional configured profile for server-side titles. |
| `pi.process_title_generation.retry` | `max_attempts: 6`, `base_delay: 5s`, `max_delay: 5m` | Title retry policy; attempts include the first call. |
| `pi.retry` | `enabled: true`, `max_retries: 3`, `base_delay: 2s` | Pi retry settings for newly created sessions. |
| `pi.retry.provider` | `timeout: null`, `max_retries: null`, `max_retry_delay: 60s` | Null defers to provider SDK defaults. |
| `extension_loading.sources` | Empty list | Extension package paths or names. |
| `extensions.<extensionId>` | Empty map | Owner-parsed extension configuration; see that extension's README. |

`process_configs.<processId>` may set `default_model_profile`, nonempty
`allowed_model_profiles`, per-turn `turn_configs.<turnId>.model_profile`,
`worker_runtime_profile`, `storage_size`, and extension-owned `watchers` blocks.
Its `pi` block may set `system_prompt_template` and `append_system_prompt_template`.
Profile references must exist, and restrictions apply to defaults and overrides.
See [selection order](models.md#profile-resolution) and [Watchers](watchers.md).

## Repository and skill catalogs

`components.<key>` defines `repo`, `default_branch`, and optional
`worker_runtime_profile`. Processes may target zero, one, or several components.

`skill_repositories` is a list of `id`, `url`, `ref`, optional `label`, and `path`
(default `skills`). Descendant skill directories are available for operator-managed
installation. Launches pin selected active revisions rather than importing mutable
repository resources into a running worker.

`commit_messages.templates.<id>.rules` defines formatting instructions.
`default_template` selects the fallback, or null uses built-in guidance.
`repositories` maps normalized locators to template IDs and takes precedence over
the fallback. The selected rules are pinned at launch.

`notifications.all` and `notifications.debug` accept `enabled`, `type`, and `url`.
`notifications.squad` accepts `enabled`, `type`, `routing_field`, and a `routes` map
whose values contain `url`. Defaults disable all channels and use `teams_webhook`
with empty URLs/routes. The consuming integration owns delivery behavior.

`sandbox.enabled` defaults to false and `sandbox.profile` to an empty string.
These legacy blocks do not define process behavior. The source UI sandbox uses its
own [development workflow](development-composition.md#source-sandbox-compositions).

Non-secret [scoped settings](scoped-settings.md) live in SQLite and can be edited
without restarting. They sit above YAML runtime defaults and below explicit
process choices. They do not replace credentials or deployment configuration.
